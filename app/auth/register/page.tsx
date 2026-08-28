'use client';

/**
 * /auth/register — email/password sign-up + Google (2026-08-28,
 * forge/free-signup-verification).
 *
 * Re-opened for the free-tier era. The page offers TWO paths:
 *   1. Email + password → POST /api/auth/register. The account is created
 *      `emailVerified:false` and NO session is issued; the user must click the
 *      emailed verification LINK before /auth/login will let them in. On success
 *      the form swaps to a "check your inbox" confirmation with a resend button
 *      (60s cooldown mirrored client-side; the server enforces the real limit).
 *   2. Continue with Google → pre-verified, no email step.
 *
 * The API returns ONE generic message whether or not the email already exists
 * (no user enumeration), so the confirmation copy is deliberately generic too.
 * Minimal + functional — Pixel owns the visual polish.
 */

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { AuthBackdrop } from '@/components/AuthBackdrop';
import { MIN_PASSWORD } from '@/lib/passwordPolicy';

function GoogleGlyph({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 3.18 29.93 1 24 1 15.4 1 7.96 5.93 4.34 13.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75z" />
    </svg>
  );
}

const RESEND_COOLDOWN_S = 60;

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false); // confirmation step
  const [cooldown, setCooldown] = useState(0);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_S);
    const iv = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(iv);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong. Please try again.');
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

  async function handleResend() {
    if (cooldown > 0) return;
    setError('');
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      startCooldown();
    } catch {
      // Silent — the generic server response makes retry safe.
    }
  }

  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center mb-10" aria-label="ComputerCaller — home">
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
          {sent ? (
            <>
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Check your email</h1>
              <p className="mt-2 text-slate-600 text-sm leading-relaxed">
                If that email can be registered, we&apos;ve sent a verification link to{' '}
                <span className="font-medium text-slate-900">{email}</span>. Click it to activate
                your account, then sign in.
              </p>
              <button
                type="button"
                onClick={handleResend}
                disabled={cooldown > 0}
                className="mt-6 w-full py-3 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 font-medium rounded-lg transition-colors text-sm"
              >
                {cooldown > 0 ? `Resend link in ${cooldown}s` : 'Resend verification link'}
              </button>
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
              <p className="mt-6 text-center text-sm text-slate-600">
                <Link href="/auth/login" className="font-medium text-blue-600 hover:text-blue-700">
                  Back to sign in
                </Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Create your account</h1>
              <p className="mt-1.5 text-slate-500 text-sm">Start free — no card required.</p>

              <a
                href="/api/auth/google/start"
                className="mt-6 w-full inline-flex items-center justify-center gap-2.5 py-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-colors text-sm shadow-sm"
              >
                <GoogleGlyph />
                Continue with Google
              </a>

              <div className="my-6 flex items-center gap-3">
                <span className="h-px flex-1 bg-slate-200" />
                <span className="text-xs text-slate-400">or</span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="mt-1 text-xs text-slate-400">{MIN_PASSWORD} characters or more.</p>
                </div>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
                >
                  {loading ? 'Creating account…' : 'Create account'}
                </button>
              </form>

              <p className="mt-6 text-center text-xs text-slate-500 leading-relaxed">
                By creating an account you agree to our terms of service.
              </p>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link href="/auth/login" className="font-medium text-blue-600 hover:text-blue-700 transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
