'use client';

/**
 * SignupModal — on-page account creation dialog opened by the landing page's
 * "Try for free" CTAs (dispatch 2026-07-04).
 *
 * Why this exists:
 *   Dennis wanted the landing "Try for free" CTAs to open a sign-up modal on
 *   the current page instead of navigating to /auth/register. The CTAs stay
 *   real anchors to /auth/register (progressive enhancement — middle/cmd-click
 *   and no-JS still navigate); JS intercepts a plain left-click and opens this.
 *
 * Behavior mirrors app/auth/register/page.tsx verbatim:
 *   - Email + Password (min 8) → POST /api/auth/register.
 *   - Success is NOT a redirect: the register endpoint returns no session and
 *     the standalone page shows a "Check your email" verification screen. This
 *     modal swaps its body to the same confirmation in-place.
 *   - Google button is a full-window redirect to /api/auth/google/start.
 *
 * A11y (all required, verified):
 *   - role="dialog" + aria-modal + aria-labelledby → the visible heading.
 *   - Focus trap (Tab/Shift+Tab cycle within the card only).
 *   - Initial focus into the modal (email field) on open.
 *   - Escape closes; backdrop click closes (card stops propagation).
 *   - Focus returns to the triggering CTA on close (triggerRef).
 *   - Body scroll lock while open (exact prior overflow restored on close).
 *   - Close button labelled; focus-visible rings preserved.
 *
 * Controlled by the parent: `open`, `onClose`, and `triggerRef` (the element
 * to restore focus to). No portal/provider — the landing page renders one
 * instance at its root.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { X, Check } from 'lucide-react';

/** Inline Google "G" — copied verbatim from /auth/register so the modal's
 *  Google button reads identically to the standalone page. */
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

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface SignupModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * The CTA element that opened the modal. Focus is restored to it on close so
   * keyboard/AT users land back where they were. May be null (e.g. opened
   * programmatically) — focus return is then skipped.
   */
  triggerRef: React.MutableRefObject<HTMLElement | null>;
}

export function SignupModal({ open, onClose, triggerRef }: SignupModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);

  const titleId = useId();

  // On each open: reset the form to a clean state so a re-open after success
  // (or after closing mid-submit) starts fresh. Runs only on the false→true
  // edge because `open` is the sole dependency.
  useEffect(() => {
    if (!open) return;
    setEmail('');
    setPassword('');
    setDone(false);
    setError('');
    setLoading(false);
  }, [open]);

  // Body scroll lock — capture the exact prior inline overflow and restore it
  // verbatim on close so we never clobber a value another surface set.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Focus management: move focus into the modal on open, restore it to the
  // triggering CTA on close. Cleanup captures triggerRef at close time.
  useEffect(() => {
    if (!open) return;
    // Defer to next frame so the card is mounted and painted before we focus.
    const raf = requestAnimationFrame(() => emailRef.current?.focus());
    const trigger = triggerRef.current;
    return () => {
      cancelAnimationFrame(raf);
      // Restore focus only if it's still safe (element in the document).
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open, triggerRef]);

  // Escape-to-close + focus trap. One keydown listener while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const nodes = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !card.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !card.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // When the body swaps to the success confirmation, move focus to the
  // confirmation heading so AT announces it and the trap has a valid anchor.
  useEffect(() => {
    if (done) doneHeadingRef.current?.focus();
  }, [done]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      setDone(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div
      // Full-viewport overlay. On mobile the card stretches to a full sheet
      // (items-stretch); on sm+ it's a centered dialog. z-[95] matches the
      // DtmfDialpadModal so we float above sticky headers (z-20).
      className="fixed inset-0 z-[95] flex items-stretch justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150 sm:items-center sm:px-4 sm:py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        className={
          'relative flex w-full flex-col bg-white shadow-2xl shadow-slate-900/20 ' +
          'p-6 sm:p-8 ' +
          // Mobile: full-height sheet. sm+: bounded, centered, rounded card.
          'min-h-full sm:min-h-0 sm:w-full sm:max-w-md sm:rounded-2xl sm:border sm:border-slate-200 ' +
          'animate-in fade-in slide-in-from-bottom-4 duration-200 sm:zoom-in-95 sm:slide-in-from-bottom-0'
        }
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        {done ? (
          /* Success confirmation — mirrors the register page's `done` block:
             no redirect, no session, just the "check your email" verification
             prompt in-place. */
          <div className="py-4 text-center sm:py-2">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50">
              <Check className="h-7 w-7 text-emerald-600" strokeWidth={3} />
            </div>
            <h2
              id={titleId}
              ref={doneHeadingRef}
              tabIndex={-1}
              className="mt-5 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
            >
              Check your email
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-600">
              We sent a verification link to{' '}
              <strong className="font-medium text-slate-900">{email}</strong>.
              Click it to activate your account.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Got it
            </button>
          </div>
        ) : (
          <>
            <h2
              id={titleId}
              className="pr-8 text-2xl font-semibold tracking-tight text-slate-900"
            >
              Create your account
            </h2>
            <p className="mt-1.5 text-sm text-slate-500">
              7-day free trial. Cancel anytime.
            </p>

            {/* Google sign-up — real <a>, full-window redirect (works fine from
                a modal: the window navigates out to Google and returns). */}
            <a
              href="/api/auth/google/start"
              className="mt-6 inline-flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white py-2.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              <GoogleGlyph />
              Sign up with Google
            </a>

            <div className="mt-6 flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="uppercase tracking-wider">or</span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
              <div>
                <label
                  htmlFor="signup-modal-email"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Email
                </label>
                <input
                  ref={emailRef}
                  id="signup-modal-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label
                  htmlFor="signup-modal-password"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Password
                  <span className="ml-1.5 font-normal text-slate-400">
                    (min 8 characters)
                  </span>
                </label>
                <input
                  id="signup-modal-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Creating account…' : 'Start free trial'}
              </button>
            </form>

            <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
              By creating an account you agree to our terms of service.
            </p>

            <p className="mt-6 text-center text-sm text-slate-600">
              Already have an account?{' '}
              <Link
                href="/auth/login"
                onClick={onClose}
                className="font-medium text-blue-600 transition-colors hover:text-blue-700"
              >
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
