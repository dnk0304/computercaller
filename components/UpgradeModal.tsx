'use client';

/**
 * UpgradeModal — the in-app upgrade / activate prompt ($5-promoted / $7-hidden +
 * limited trial, dispatch pricing-5-promoted-7-hidden, 2026-08-17).
 *
 * ⭐ THE PROMPT IS SELECTED BY THE SERVER, NEVER GUESSED HERE. The modal renders
 * whatever `getUpgradePrompt(upgrade)` returns for the server's machine-readable
 * `upgrade` signal (off /api/entitlement, or a template/quick-reply 409 body):
 *   • reason 'trial-limit-hit' → "Activate your $5/month subscription"  (→ $5)
 *   • reason 'plus-limit-hit'  → "Upgrade to $7/month"                  (→ $7)
 *   • null (top / grandfathered-top / privileged) → the calm "highest plan"
 *     state: no price, no checkout, no $7 named. A grandfathered user therefore
 *     never sees a prompt for a limit that doesn't apply to them.
 *
 * $7 is named in THIS component and nowhere else in the product — and only when
 * the server's signal put it there.
 *
 * The optional `context` names which limit the user just hit (a fact the caller
 * knows — it called the templates vs quick-replies route), for one honest
 * descriptive line. It does NOT choose the prompt (activate vs upgrade); the
 * server's `reason` does.
 *
 * A11y: role="dialog" + aria-modal + aria-labelledby, focus trap, initial focus,
 * Escape + backdrop close, body scroll lock, focus return to the opener,
 * aria-live on the async prompt region, visible focus rings, motion-safe gating.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, Check, ArrowRight, ArrowLeft, ShieldCheck, Crown } from 'lucide-react';
import { clsx } from 'clsx';
import { getUpgradePrompt } from '@/lib/pricing';
import type { UpgradePath } from '@/lib/tiers';
import { WhopEmbedCheckout } from './WhopEmbedCheckout';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Which limit the caller just hit — drives one descriptive line only. */
export type LimitContext = 'templates' | 'quickReplies' | 'syncRange' | 'contactSync' | undefined;

function contextLine(context: LimitContext): string | null {
  switch (context) {
    case 'templates':
      return 'You’ve reached the number of message templates your plan includes.';
    case 'quickReplies':
      return 'You’ve reached the number of quick replies your plan includes.';
    case 'syncRange':
      return 'You’ve reached how far back your plan syncs your history.';
    case 'contactSync':
      return 'Phone contacts aren’t included on your current plan.';
    default:
      return null;
  }
}

export interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * The server's machine-readable upgrade signal for the current user. The modal
   * renders the prompt from THIS — it never inspects the tier or guesses.
   */
  upgrade: UpgradePath | null;
  /** Which limit was hit (optional descriptive line only). */
  context?: LimitContext;
}

export function UpgradeModal({ open, onClose, upgrade, context }: UpgradeModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  // The prompt is derived purely from the server's signal.
  const prompt = useMemo(() => getUpgradePrompt(upgrade), [upgrade]);
  const [showCheckout, setShowCheckout] = useState(false);

  const handleClose = useCallback(() => {
    setShowCheckout(false);
    onClose();
  }, [onClose]);

  // Body scroll lock — capture + restore the exact prior inline overflow.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Move focus into the dialog (its heading) on open / phase change; restore it
  // to the opener on close.
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
  }, [open, showCheckout]);

  // Escape-to-close + focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
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
  }, [open, handleClose]);

  if (!open) return null;

  const intro = contextLine(context);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-stretch justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 sm:items-center sm:px-4 sm:py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={handleClose}
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
          onClick={handleClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        {/* aria-live so the async prompt is announced when it resolves. */}
        <div aria-live="polite" className="w-full">
          {!prompt ? (
            /* ---- No upgrade path: top / grandfathered-top user ---- */
            <div className="pr-8 text-center">
              <span
                className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600"
                aria-hidden="true"
              >
                <Crown className="h-6 w-6" />
              </span>
              <h2
                id={titleId}
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
              >
                You’re on the highest plan
              </h2>
              <p className="mx-auto mt-3 max-w-sm text-slate-600">
                {intro
                  ? `${intro} That’s the limit of your current plan — there’s nothing higher to move to.`
                  : 'You already have everything ComputerCaller offers on your plan.'}
              </p>
              <button
                type="button"
                onClick={handleClose}
                className="mt-6 inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
              >
                Got it
              </button>
            </div>
          ) : showCheckout ? (
            /* ---- Checkout for the selected offer ---- */
            <div className="mx-auto w-full max-w-md">
              <button
                type="button"
                onClick={() => setShowCheckout(false)}
                className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </button>
              <div className="mt-4 pr-8 text-center">
                <h2
                  id={titleId}
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
                >
                  {prompt.heading}
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  <span className="font-semibold text-slate-700">{prompt.price}</span> {PERIOD_LABEL} ·
                  cancel anytime
                </p>
              </div>
              <div className="mt-6 text-left">
                <WhopEmbedCheckout key={prompt.planId} planId={prompt.planId} accentColor="#3358d4" />
              </div>
            </div>
          ) : (
            /* ---- The offer (activate $5 OR upgrade $7) ---- */
            <div className="pr-8">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
                {prompt.reason === 'trial-limit-hit' ? 'Free trial' : 'Upgrade'}
              </p>
              <h2
                id={titleId}
                ref={headingRef}
                tabIndex={-1}
                className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
              >
                {prompt.heading}
              </h2>
              {intro && <p className="mt-3 text-sm text-slate-600">{intro}</p>}
              <p className="mt-2 text-slate-600">{prompt.subtext}</p>

              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-3xl font-semibold tracking-tight text-slate-900">{prompt.price}</span>
                <span className="text-sm text-slate-500">{PERIOD_LABEL}</span>
              </div>

              <ul className="mt-4 space-y-2.5" role="list">
                {prompt.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-slate-700">
                    <span
                      className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50"
                      aria-hidden="true"
                    >
                      <Check className="h-2.5 w-2.5 text-blue-600" strokeWidth={3} />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => setShowCheckout(true)}
                aria-label={`${prompt.ctaLabel} — cancel anytime`}
                className="mt-6 flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
              >
                {prompt.ctaLabel}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>

              <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-500">
                <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-500" aria-hidden="true" />
                Cancel anytime — no lock-in.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PERIOD_LABEL = 'per month';

export default UpgradeModal;
