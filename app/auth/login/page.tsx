'use client';

import { Suspense, useCallback, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check } from 'lucide-react';
import { AuthBackdrop } from '@/components/AuthBackdrop';
import { AuthSplash } from '@/components/AuthSplash';
import { sanitiseNext } from '@/lib/google';

// Inline Google "G" logo SVG — avoids a network round-trip + zero new deps.
// Coloured per Google's 2015 brand identity guidelines for the "G" mark.
function GoogleGlyph({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 3.18 29.93 1 24 1 15.4 1 7.96 5.93 4.34 13.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75z"
      />
    </svg>
  );
}

// useSearchParams() must be wrapped in <Suspense>; the page-level default export
// provides that boundary so static export and partial pre-rendering work.
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // `signedIn` flips true the moment the /api/auth/login POST resolves OK.
  // It triggers the AuthSplash overlay; the splash's onDone then performs
  // the router.push to `next`. Decoupling navigation from the POST gives
  // us a clean ~700ms launch animation that respects reduced-motion.
  const [signedIn, setSignedIn] = useState(false);

  const verified = params.get('verified') === '1';
  const next = sanitiseNext(params.get('next'));
  const oauthError = params.get('error');
  // Idle-timeout bounce (2026-07-27, forge/web-idle-timeout). proxy / the
  // client timer append ?reason=idle after a 4h-inactivity logout — surface a
  // quiet, non-alarming line so the user understands why they were signed out.
  const idleLogout = params.get('reason') === 'idle';

  // Map Google callback error codes to friendly copy. Anything we don't
  // recognise falls through to the generic message.
  const oauthErrorMessage = (() => {
    switch (oauthError) {
      case 'google_cancelled':
        return null; // silent — user clicked Cancel, no need to scold
      case 'google_email_unverified':
        return 'Your Google account does not have a verified email. Please verify it with Google and try again.';
      case 'google_state_mismatch':
      case 'google_state_invalid':
        return 'Your Google sign-in session expired. Please try again.';
      case 'google_missing_params':
      case 'google_error':
      case 'google_internal_error':
        return 'Google sign-in failed. Please try again or use email and password.';
      // Email-verification link failures (forge/free-signup-verification).
      case 'invalid_token':
        return 'That verification link is invalid or has already been used. You can request a new one below.';
      case 'expired_token':
        return 'That verification link has expired. You can request a new one below.';
      default:
        return null;
    }
  })();

  // Build the Google start URL with `next` preserved so deep-links survive.
  const googleHref = `/api/auth/google/start?next=${encodeURIComponent(next)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return;
      }
      // Cookie is set by the API; flip splash on. Keep `loading=true` so the
      // submit button stays disabled — preventing a double-fire if the user
      // somehow clicked twice between cookie-set and route change.
      setSignedIn(true);
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
    // Intentionally no `finally { setLoading(false) }` on success — we want
    // the form locked while the splash animates.
  }

  // useCallback so AuthSplash's effect dependency stays stable across the
  // single mount; without it, an identity-change of onDone could re-arm the
  // splash timer and queue a second router.push.
  const handleSplashDone = useCallback(() => {
    router.push(next);
  }, [router, next]);

  // Once `signedIn` flips, render the splash *instead of* the form. The
  // splash is position:fixed/z-50 so it would overlay anyway, but unmounting
  // the form prevents a flash of late repaint (e.g. a slow keystroke landing
  // in an input behind the white surface) and is friendlier to AT.
  if (signedIn) {
    return <AuthSplash onDone={handleSplashDone} subtitle="Welcome back" />;
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
          Welcome back
        </h1>
        <p className="mt-1.5 text-slate-500 text-sm">
          Sign in to your account to continue.
        </p>

        {verified && (
          <div
            role="status"
            className="mt-6 flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm"
          >
            <span className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
              <Check className="w-3 h-3 text-white" strokeWidth={3} />
            </span>
            Email verified. You can sign in now.
          </div>
        )}

        {oauthErrorMessage && (
          <div
            role="alert"
            className="mt-6 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
          >
            {oauthErrorMessage}
          </div>
        )}

        {idleLogout && (
          <div
            role="status"
            className="mt-6 p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 text-sm"
          >
            You were signed out after 4 hours of inactivity. Please sign in again.
          </div>
        )}

        {/* Google sign-in — primary affordance. Anchored as a real <a> so
            the request goes server-side without JS and the redirect chain
            is the browser's, not React's. */}
        <a
          href={googleHref}
          className="mt-6 w-full inline-flex items-center justify-center gap-2.5 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-colors text-sm shadow-sm"
        >
          <GoogleGlyph />
          Continue with Google
        </a>

        <div className="mt-6 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px bg-slate-200 flex-1" />
          <span className="uppercase tracking-wider">or</span>
          <span className="h-px bg-slate-200 flex-1" />
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <Link
            href="/auth/forgot-password"
            className="text-sm text-slate-500 hover:text-slate-900 transition-colors"
          >
            Forgot password?
          </Link>
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-slate-600">
        Don&apos;t have an account?{' '}
        <Link
          href="/auth/register"
          className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          Start free trial
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
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
        <LoginForm />
      </Suspense>
    </div>
  );
}
