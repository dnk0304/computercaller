'use client';

/**
 * PricingModal — on-page pricing dialog opened by the landing header's
 * "Pricing" nav link (dispatch 2026-07-04, Dennis: "If people click on pricing
 * in header it should just come a pop up with the price.").
 *
 * The standalone pricing SECTION was removed from the page body; its content —
 * the single $5/month plan, the risk-reversal band, and the feature list —
 * lives here instead. The pricing JSON-LD (Offer, 5.00 USD) stays in the page
 * head, so the price is still declared for SEO even though it renders in a
 * modal. ONE PLAN as of 2026-07-05 (Dennis): $5/month, 7-day trial — we
 * compete with free (Phone Link), so the pitch is "cheap enough for anyone".
 *
 * Hand-off (LOCKED): pricing modal → SIGNUP modal, in-page. Clicking a tier's
 * "Try for free" closes this modal and opens the existing SignupModal via the
 * parent's `onSelectTier` — the user never leaves the page. Each tier CTA stays
 * a REAL <a href="/auth/register?plan=<id>"> so middle/cmd/ctrl-click and the
 * no-JS fallback still navigate (preserving Forge's ?plan= URL contract); a
 * plain left-click is intercepted and handed to the signup modal instead.
 *
 * A11y — full parity with SignupModal (all required, verified):
 *   - role="dialog" + aria-modal + aria-labelledby → the visible heading.
 *   - Focus trap (Tab/Shift+Tab cycle within the card only).
 *   - Initial focus into the modal (the heading) on open.
 *   - Escape closes; backdrop click closes (card stops propagation).
 *   - Focus returns to the triggering nav link on close (triggerRef).
 *   - Body scroll lock while open (exact prior overflow restored on close).
 *   - Close button labelled; focus-visible rings preserved.
 *
 * Controlled by the parent: `open`, `onClose`, `triggerRef` (focus-return
 * target), and `onSelectTier` (hand-off to signup). No portal — the landing
 * page renders one instance at its root.
 */

import React, { useEffect, useId, useRef } from 'react';
import { X, Check, ArrowRight, ShieldCheck } from 'lucide-react';
import { PLAN_TIERS, type PlanTierId } from '@/lib/pricing';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Everything the one plan includes — listed once under the price card.
 *  Lifted verbatim from the removed pricing section. */
const PLAN_FEATURES = [
  'Call any phone number from your computer',
  'Full SMS and message dashboard',
  "See your phone's notifications on your computer",
  'Unlimited contacts & history',
  'Works from any device, anywhere',
  '7-day free trial',
] as const;

export interface PricingModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * The nav link that opened the modal. Focus is restored to it on close so
   * keyboard/AT users land back where they were. May be null (opened
   * programmatically) — focus return is then skipped.
   */
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  /**
   * Hand-off to the signup modal. Called on a plain left-click of any tier CTA;
   * the parent closes this modal and opens SignupModal. Modified/middle clicks
   * are NOT intercepted — they follow the anchor's real ?plan= href instead.
   */
  onSelectTier: (tierId: PlanTierId) => void;
}

export function PricingModal({ open, onClose, triggerRef, onSelectTier }: PricingModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
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

  // Focus management: move focus into the modal (the heading) on open, restore
  // it to the triggering nav link on close. Cleanup captures triggerRef at
  // close time. Focusing the heading (not a tier CTA) means AT announces the
  // dialog title first and no single plan is pre-highlighted.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => headingRef.current?.focus());
    const trigger = triggerRef.current;
    return () => {
      cancelAnimationFrame(raf);
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

  // Intercept a tier CTA click. Bail (let the browser navigate to
  // /auth/register?plan=<id>) on any modified click — new-tab/new-window intents
  // (cmd/ctrl/shift/alt) or non-primary mouse buttons (middle-click) — so the
  // anchor's ?plan= href fallback is preserved. A plain left-click hands off to
  // the signup modal.
  function handleTierClick(e: React.MouseEvent<HTMLAnchorElement>, tierId: PlanTierId) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onSelectTier(tierId);
  }

  if (!open) return null;

  return (
    <div
      // Full-viewport overlay. On mobile the card stretches to a full sheet
      // (items-stretch); on sm+ it's a centered dialog that scrolls the overlay
      // if the plans overflow the viewport. z-[95] matches SignupModal so we
      // float above the sticky header (z-20).
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
          // Mobile: full-height sheet. sm+: bounded, centered, rounded card —
          // one plan now, so a narrow single-column dialog reads best.
          'min-h-full sm:min-h-0 sm:w-full sm:max-w-lg sm:rounded-2xl sm:border sm:border-slate-200 ' +
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

        <div className="pr-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">
            Pricing
          </p>
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none sm:text-3xl"
          >
            Simple pricing.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-600">
            One plan, every feature. $5 a month after a 7-day free trial —
            cancel anytime.
          </p>
        </div>

        {/* The single plan card. The CTA carries ?plan=<id> so a middle-click /
            no-JS navigation — and Forge's server-side read on /auth/register —
            still works. A plain left-click hands off to the signup modal (the
            plan is ultimately charged at /subscribe). */}
        <div className="mt-8">
          {PLAN_TIERS.map((tier) => (
            <div
              key={tier.id}
              className="relative flex flex-col rounded-2xl border border-blue-600 ring-1 ring-blue-600/20 bg-white p-6 text-center shadow-sm shadow-blue-600/10"
            >
              <div className="flex items-baseline justify-center gap-1.5">
                <span className="text-5xl font-semibold tracking-tight text-slate-900">
                  {tier.price}
                </span>
                <span className="text-slate-500 text-sm">{tier.period}</span>
              </div>

              <p className="mt-2 text-sm text-slate-500">
                7-day free trial · cancel anytime
              </p>

              <a
                href={`/auth/register?plan=${tier.id}`}
                onClick={(e) => handleTierClick(e, tier.id)}
                aria-label={`Try for free — ${tier.a11yLabel}`}
                className="mt-6 flex items-center justify-center gap-1.5 w-full py-3 font-medium rounded-xl transition-colors text-center bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Try for free
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          ))}
        </div>

        {/* Risk-reversal band — answers the "what if I forget to cancel?"
            objection at the moment of price consideration. */}
        <div className="mt-8 flex justify-center">
          <p className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600 shadow-sm">
            <ShieldCheck
              className="w-4 h-4 text-emerald-500 flex-shrink-0"
              aria-hidden="true"
            />
            Cancel anytime before day 7 and you won&apos;t be charged — one click,
            no lock-in.
          </p>
        </div>

        {/* Feature list — everything the plan includes, listed once. */}
        <div className="mt-10 max-w-md mx-auto">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            Everything included
          </p>
          <ul className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
            {PLAN_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                  <Check className="w-2.5 h-2.5 text-blue-600" strokeWidth={3} />
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
