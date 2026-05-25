'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { Check, AlertCircle } from 'lucide-react';
import { AuthBackdrop } from '@/components/AuthBackdrop';

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
    <div className="w-full max-w-md">
      <Link
        href="/"
        className="flex items-center justify-center mb-10"
        aria-label="ComputerCaller — home"
      >
        <Image
          src="/brand/computercaller-icon-transparent.png"
          alt="ComputerCaller"
          width={396}
          height={317}
          priority
          className="h-14 w-auto"
        />
      </Link>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          {sent ? 'Check your email' : 'Verify your email'}
        </h1>
        <p className="mt-1.5 text-slate-500 text-sm leading-relaxed">
          {sent
            ? 'We sent a fresh verification link if your email is on file.'
            : hasStaleToken
              ? "Your verification link didn't work or has expired."
              : 'Need a new verification email?'}
        </p>

        {sent ? (
          <div className="mt-6 space-y-5">
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2.5 p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm"
            >
              <span className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Check className="w-3 h-3 text-white" strokeWidth={3} />
              </span>
              <span className="leading-relaxed">
                If that email is registered and not yet verified, we&apos;ve
                sent a new verification link. Check your inbox (and spam).
              </span>
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
                  className="font-medium text-blue-600 hover:text-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 rounded"
                >
                  Send another
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {hasStaleToken && (
              <div
                role="status"
                className="mt-6 flex items-start gap-2.5 p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span className="leading-relaxed">
                  Enter your email below to get a fresh verification link.
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
              <div>
                <label
                  htmlFor="verify-email"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
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
                  className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors"
                  placeholder="you@example.com"
                />
                {validationError && (
                  <p
                    id="verify-email-error"
                    role="alert"
                    className="mt-1.5 text-red-600 text-sm"
                  >
                    {validationError}
                  </p>
                )}
              </div>

              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 inline-flex items-center justify-center gap-2"
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
          </>
        )}
      </div>

      <p className="mt-6 text-center text-sm text-slate-600">
        <Link
          href="/auth/login"
          className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
      <Suspense
        fallback={
          <div className="w-full max-w-md text-center text-slate-500 text-sm">
            Loading…
          </div>
        }
      >
        <VerifyEmailForm />
      </Suspense>
    </div>
  );
}
