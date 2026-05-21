'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Phone } from 'lucide-react';

const COOLDOWN_SECONDS = 20;

// useSearchParams() must be wrapped in <Suspense>; the page-level default
// export provides that boundary so static export and partial pre-rendering
// continue to work the same way they do on /auth/login.
function VerifyEmailForm() {
  const params = useSearchParams();
  // A `?token=...` on THIS page means the user clicked an OLD/broken
  // verification link (old emails pointed straight at the page instead of
  // the API). New links go to /api/auth/verify-email which redirects to
  // /auth/login?verified=1. So any token here = stale link; we don't try
  // to consume it — we just explain and offer a resend.
  const hasStaleToken = (params.get('token') ?? '').length > 0;

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  function startCooldown() {
    setCooldownLeft(COOLDOWN_SECONDS);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCooldownLeft((prev) => {
        if (prev <= 1) {
          if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Block re-fire while cooldown is active (covers Enter key during
    // the success state too — the form is unmounted then, but the guard
    // is cheap insurance).
    if (loading || cooldownLeft > 0) return;

    const trimmed = email.trim();
    if (!trimmed) {
      setValidationError('Enter your email');
      return;
    }
    setValidationError('');
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      // The API is non-enumerating: 200 always means "we accepted the
      // request, show success." We deliberately don't branch on the body
      // message — UI truth lives on the status code.
      if (!res.ok) {
        setError('Something went wrong. Please try again.');
        return;
      }
      setSent(true);
      startCooldown();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleSendAnother() {
    if (cooldownLeft > 0) return;
    setSent(false);
    setError('');
    setValidationError('');
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center justify-center gap-3 mb-8">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-lg shadow-blue-600/30 flex items-center justify-center">
          <Phone className="w-5 h-5 text-white" />
        </div>
        <span className="text-lg font-semibold tracking-tight text-white">ComputerCaller</span>
      </div>
      <h1 className="text-2xl font-bold text-white text-center mb-2 tracking-tight">
        {sent ? 'Check your email' : 'Verify your email'}
      </h1>
      <p className="text-slate-400 text-center text-sm mb-8">
        {sent
          ? 'We sent a fresh verification link if your email is on file.'
          : hasStaleToken
            ? "Your verification link didn't work or has expired."
            : 'Need a new verification email?'}
      </p>

      {sent ? (
        <div className="space-y-6">
          <div
            role="status"
            aria-live="polite"
            className="p-4 bg-emerald-950 border border-emerald-800 rounded-xl text-emerald-300 text-sm text-center"
          >
            <span aria-hidden="true" className="mr-1.5">
              ✓
            </span>
            If that email is registered and not yet verified, we&apos;ve sent
            a new verification link. Check your inbox (and spam).
          </div>

          <div className="text-center text-sm text-slate-500">
            {cooldownLeft > 0 ? (
              <span aria-live="polite">
                You can request another in {cooldownLeft}s
              </span>
            ) : (
              <button
                type="button"
                onClick={handleSendAnother}
                className="text-blue-400 hover:text-blue-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
              >
                Send another
              </button>
            )}
          </div>

          <p className="text-center text-sm text-slate-500">
            <Link
              href="/auth/login"
              className="hover:text-slate-300 transition-colors"
            >
              Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <>
          {hasStaleToken && (
            <div
              role="status"
              className="mb-4 p-3 bg-slate-900 border border-slate-800 rounded-xl text-slate-300 text-sm"
            >
              Enter your email below to get a fresh verification link.
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label
                htmlFor="verify-email"
                className="block text-sm text-slate-400 mb-1.5"
              >
                Email
              </label>
              <input
                id="verify-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (validationError) setValidationError('');
                }}
                aria-invalid={validationError ? true : undefined}
                aria-describedby={
                  validationError ? 'verify-email-error' : undefined
                }
                className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 placeholder:text-slate-600"
                placeholder="you@example.com"
              />
              {validationError && (
                <p
                  id="verify-email-error"
                  role="alert"
                  className="mt-1.5 text-red-400 text-sm"
                >
                  {validationError}
                </p>
              )}
            </div>

            {error && (
              <p
                role="alert"
                aria-live="polite"
                className="text-red-400 text-sm"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 inline-flex items-center justify-center gap-2"
            >
              {loading && (
                <span
                  aria-hidden="true"
                  className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                />
              )}
              {loading ? 'Sending…' : 'Send verification email'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            <Link
              href="/auth/login"
              className="hover:text-slate-300 transition-colors"
            >
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="w-full max-w-sm text-center text-slate-400 text-sm">
            Loading…
          </div>
        }
      >
        <VerifyEmailForm />
      </Suspense>
    </div>
  );
}
