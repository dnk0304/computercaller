'use client';

/**
 * /auth/register — Google-only sign-up (2026-07-06).
 *
 * Email/password registration was retired (/api/auth/register returns 410).
 * This page stays mounted because the landing CTAs, the pricing modal, the
 * guides chrome, and the sitemap all anchor here (and it is the no-JS
 * fallback target for the SignupModal). It now offers a single action:
 * "Continue with Google" → /api/auth/google/start.
 *
 * Google accounts arrive pre-verified. Card-first paywall: no subscription
 * row is created at signup, so proxy.ts routes the fresh user from /app to
 * /subscribe (Whop embedded checkout) to start the card-attached trial.
 *
 * Email/password LOGIN is untouched — existing users sign in at /auth/login.
 */

import Link from 'next/link';
import Image from 'next/image';
import { AuthBackdrop } from '@/components/AuthBackdrop';

// Inline Google "G" logo SVG — mirrors the one in /auth/login. Kept inline
// per file rather than shared so the two auth pages have zero cross-import
// coupling (Pixel can re-skin either independently).
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

export default function RegisterPage() {
  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
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
            Create your account
          </h1>
          <p className="mt-1.5 text-slate-500 text-sm">
            7-day free trial. Cancel anytime.
          </p>

          {/* Google sign-up — the only registration path. Anchored as a real
              <a> so the request goes server-side without JS. Google users are
              pre-verified (Google verified their email already). */}
          <a
            href="/api/auth/google/start"
            className="mt-6 w-full inline-flex items-center justify-center gap-2.5 py-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-colors text-sm shadow-sm"
          >
            <GoogleGlyph />
            Continue with Google
          </a>

          <p className="mt-6 text-center text-xs text-slate-500 leading-relaxed">
            By creating an account you agree to our terms of service.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link
            href="/auth/login"
            className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
