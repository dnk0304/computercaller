'use client';

/**
 * SignupModal — on-page account creation dialog opened by the landing page's
 * "Try for free" CTAs (dispatch 2026-07-04; Google-only rework 2026-07-06).
 *
 * Why this exists:
 *   Dennis wanted the landing "Try for free" CTAs to open a sign-up modal on
 *   the current page instead of navigating to /auth/register. The CTAs stay
 *   real anchors to /auth/register (progressive enhancement — middle/cmd-click
 *   and no-JS still navigate); JS intercepts a plain left-click and opens this.
 *
 * Google-only (2026-07-06): email/password registration was retired
 * (/api/auth/register now returns 410). The modal offers a single
 * "Continue with Google" action — a full-window redirect to
 * /api/auth/google/start. Google accounts arrive pre-verified; the card-first
 * paywall then routes fresh users to /subscribe (Whop embed) via proxy.ts.
 *
 * A11y (all required, verified):
 *   - role="dialog" + aria-modal + aria-labelledby → the visible heading.
 *   - Focus trap (Tab/Shift+Tab cycle within the card only).
 *   - Initial focus into the modal (the Google CTA) on open.
 *   - Escape closes; backdrop click closes (card stops propagation).
 *   - Focus returns to the triggering CTA on close (triggerRef).
 *   - Body scroll lock while open (exact prior overflow restored on close).
 *   - Close button labelled; focus-visible rings preserved.
 *
 * Controlled by the parent: `open`, `onClose`, and `triggerRef` (the element
 * to restore focus to). No portal/provider — the landing page renders one
 * instance at its root.
 */

import type { PlanTierId } from '@/lib/pricing';
import React, { useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

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
  /**
   * The plan the visitor chose in the pricing modal.
   *
   * ⭐ This is the only thing carrying their choice across the Google OAuth
   * round trip. It is encoded into the `next` target, which the start route
   * signs into the state JWT — so it survives the bounce to Google and back and
   * lands on /subscribe with that plan preselected. The preselected plan is what
   * drives the Whop embed, i.e. what the customer is actually charged.
   *
   * Optional so a generic CTA (hero/header) can open the modal without one; the
   * parent supplies the recommended tier as its default rather than passing
   * nothing, because "no plan" silently falls back to /subscribe's own default.
   */
  planTier?: PlanTierId;
}

export function SignupModal({ open, onClose, triggerRef, planTier }: SignupModalProps) {
  /**
   * `/subscribe?plan=<tier>` as an encoded `next`. sanitiseNext() on the start
   * route accepts a leading-slash path WITH a query string, and signOAuthState
   * carries it through the Google bounce, so the choice cannot be lost in the
   * redirect the way it was lost in the click handler.
   */
  const googleStartHref = planTier
    ? `/api/auth/google/start?next=${encodeURIComponent(`/subscribe?plan=${planTier}`)}`
    : '/api/auth/google/start';

  const cardRef = useRef<HTMLDivElement>(null);
  const googleCtaRef = useRef<HTMLAnchorElement>(null);

  const titleId = useId();

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
    const raf = requestAnimationFrame(() => googleCtaRef.current?.focus());
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

        <h2
          id={titleId}
          className="pr-8 text-2xl font-semibold tracking-tight text-slate-900"
        >
          Create your account
        </h2>
        <p className="mt-1.5 text-sm text-slate-500">
          7-day free trial. Cancel anytime.
        </p>

        {/* Google sign-up — the ONLY registration path (2026-07-06). Real <a>,
            full-window redirect (works fine from a modal: the window navigates
            out to Google and returns). */}
        <a
          ref={googleCtaRef}
          href={googleStartHref}
          className="mt-6 inline-flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white py-3 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <GoogleGlyph />
          Continue with Google
        </a>

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
      </div>
    </div>
  );
}
