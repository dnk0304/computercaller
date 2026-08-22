'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Mail, Loader2, CheckCircle2 } from 'lucide-react';
import { AuthBackdrop } from '@/components/AuthBackdrop';

/**
 * Forgot-password REQUEST page (dispatch forge/set-password, 2026-08-22).
 *
 * Replaces the old "email support" dead stub with a working form that POSTs to
 * /api/auth/forgot-password. The API never reveals whether the address exists,
 * so this screen ALWAYS lands on the same generic "check your email" state on a
 * 200 — matching the endpoint's no-enumeration contract. Functional-only;
 * Pixel refines copy/states in a follow-up.
 *
 * Class strings mirror app/auth/login + the set-password card so the auth
 * screens stay visually consistent.
 */

const INPUT_CLASS =
  'w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors';
const LABEL_CLASS = 'block text-sm font-medium text-slate-700 mb-1.5 text-left';
const PRIMARY_BUTTON_CLASS =
  'w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20 inline-flex items-center justify-center gap-2';
const ALERT_CLASS = 'p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm';

function Shell({ children }: { children: React.ReactNode }) {
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
        {children}
        <p className="mt-6 text-center text-sm text-slate-600">
          <Link
            href="/auth/login"
            className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase('sending');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setPhase('sent');
        return;
      }
      // 429 (rate limited) or 403 (CSRF) — surface a real error and let them retry.
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? 'Something went wrong. Please try again.');
      setPhase('form');
    } catch {
      setError('Network error. Please try again.');
      setPhase('form');
    }
  }

  if (phase === 'sent') {
    return (
      <Shell>
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-green-50 border border-green-100 flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-slate-900 tracking-tight">
            Check your email
          </h1>
          <p className="mt-3 text-slate-600 text-sm leading-relaxed">
            If an account exists for that email, we&apos;ve sent a link to set your
            password. The link expires in one hour.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
          <Mail className="w-6 h-6 text-blue-600" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold text-slate-900 tracking-tight text-center">
          Reset password
        </h1>
        <p className="mt-3 text-slate-600 text-sm leading-relaxed text-center">
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className={LABEL_CLASS}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={INPUT_CLASS}
              placeholder="you@example.com"
            />
          </div>

          {error && <div className={ALERT_CLASS}>{error}</div>}

          <button type="submit" disabled={phase === 'sending'} className={PRIMARY_BUTTON_CLASS}>
            {phase === 'sending' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending…
              </>
            ) : (
              'Send reset link'
            )}
          </button>
        </form>
      </div>
    </Shell>
  );
}
