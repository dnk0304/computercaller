'use client';

/**
 * LimitReachedModal — the block dialog shown when a free-tier user's outbound
 * call or message was refused because they hit their daily cap (dispatch
 * forge/free-tier-p1, 2026-08-28).
 *
 * It is deliberately PLAIN and honest: it states the cap was reached, when it
 * resets (in the user's LOCAL time), and offers Subscribe (primary → the
 * existing Whop checkout, wired by the FreeTierProvider) or Dismiss (secondary).
 * It never implies the action went through.
 *
 * A11y mirrors UpgradeModal: role="dialog" + aria-modal + aria-labelledby,
 * focus trap, initial focus on the heading, Escape + backdrop close, body
 * scroll lock, focus return to the opener, visible focus rings, motion-safe
 * gating.
 */

import React, { useEffect, useId, useMemo, useRef } from 'react';
import { X, PhoneOff, MessageSquareOff, Clock, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface LimitReachedModalProps {
  open: boolean;
  kind: 'call' | 'message';
  /** Epoch-ms of the next reset (UTC midnight). Rendered in the user's LOCAL time. */
  resetAt: number;
  /** The daily cap that was hit — shown for context. null when unknown. */
  limit: number | null;
  onSubscribe: () => void;
  onClose: () => void;
}

/** "today at 2:00 AM" / "tomorrow at 1:00 AM" in the viewer's local timezone. */
function formatReset(resetAt: number): string {
  if (!resetAt || !Number.isFinite(resetAt)) return 'midnight';
  const reset = new Date(resetAt);
  const now = new Date();
  const time = reset.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = reset.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = reset.toDateString() === tomorrow.toDateString();
  if (sameDay) return `today at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${reset.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

export function LimitReachedModal({
  open,
  kind,
  resetAt,
  limit,
  onSubscribe,
  onClose,
}: LimitReachedModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const isCall = kind === 'call';
  const noun = isCall ? 'calls' : 'messages';
  const Icon = isCall ? PhoneOff : MessageSquareOff;

  const resetLabel = useMemo(() => formatReset(resetAt), [resetAt]);

  // Body scroll lock.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Initial focus on open; restore to opener on close.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => headingRef.current?.focus());
    const opener = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      cancelAnimationFrame(raf);
      if (opener && document.contains(opener) && typeof opener.focus === 'function') {
        opener.focus();
      }
    };
  }, [open]);

  // Escape-to-close + focus trap.
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
      const nodes = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
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
      className="fixed inset-0 z-[96] flex items-stretch justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 sm:items-center sm:px-4 sm:py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          'relative flex w-full flex-col bg-white shadow-2xl shadow-slate-900/20',
          'p-6 sm:p-8',
          'min-h-full sm:min-h-0 sm:w-full sm:max-w-md sm:rounded-2xl sm:border sm:border-slate-200',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200 sm:motion-safe:zoom-in-95 sm:motion-safe:slide-in-from-bottom-0',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <span
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600"
          aria-hidden="true"
        >
          <Icon className="h-6 w-6" />
        </span>

        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="pr-8 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
        >
          You’ve reached your daily free limit
        </h2>

        <div id={bodyId} className="mt-3 space-y-3 text-slate-600">
          <p>
            {isCall
              ? 'Your free plan includes a limited number of calls each day, and you’ve used them all.'
              : 'Your free plan includes a limited number of messages each day, and you’ve used them all.'}
            {typeof limit === 'number' && limit > 0 && (
              <>
                {' '}
                <span className="whitespace-nowrap font-medium text-slate-700">
                  ({limit} {noun}/day)
                </span>
              </>
            )}
          </p>
          <p className="flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700">
            <Clock className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
            <span>
              Your free {noun} reset <span className="font-medium text-slate-900">{resetLabel}</span>.
            </span>
          </p>
          <p className="text-sm">Subscribe for unlimited {noun} — no daily limit.</p>
        </div>

        <button
          type="button"
          onClick={onSubscribe}
          className="mt-6 flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
        >
          Subscribe
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-xl border border-slate-300 bg-white py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export default LimitReachedModal;
