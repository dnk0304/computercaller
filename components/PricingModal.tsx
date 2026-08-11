'use client';

/**
 * PricingModal — on-page pricing dialog opened by the landing header's
 * "Pricing" nav link (dispatch 2026-07-04, Dennis: "If people click on pricing
 * in header it should just come a pop up with the price.").
 *
 * The standalone pricing SECTION was removed from the page body; its content —
 * the plans, the risk-reversal band, and the feature list — lives here instead.
 * The pricing JSON-LD (AggregateOffer) stays in the page head, so the prices are
 * still declared for SEO even though they render in a modal.
 *
 * THREE TIERS as of 2026-08-11 (Dennis): Solo / Pro / Pro+, rendered as ONE
 * compact horizontal row of small cards, each listing its OWN benefits under its
 * own price, with Pro visibly marked as the recommended default. Every price,
 * name, tagline and limit on this surface is READ FROM `lib/pricing.ts` at
 * runtime — nothing about a plan is typed into this file. That is deliberate:
 * the previous version hardcoded "$5 a month" and kept saying it for a month
 * after the price changed.
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
import { X, Check, Minus, ArrowRight, ShieldCheck } from 'lucide-react';
import {
  PLAN_TIERS,
  PLAN_PRICE_RANGE,
  FEATURE_MATRIX,
  INCLUDED_ON_EVERY_PLAN,
  RECOMMENDED_TIER,
  type PlanTierId,
} from '@/lib/pricing';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * "6.00" → "$6". PLAN_PRICE_RANGE is schema.org-shaped (2dp strings) because
 * JSON-LD needs it that way; marketing copy wants the short form. Derived, never
 * typed — a literal price string in this file is exactly what shipped "$5 a
 * month" above three cards that cost $6/$7/$9.
 */
function shortPrice(value: string): string {
  return `$${value.replace(/\.00$/, '')}`;
}

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
          // wide enough that three compact plan cards sit in ONE row without the
          // dialog overflowing the viewport.
          'min-h-full sm:min-h-0 sm:w-full sm:max-w-3xl sm:rounded-2xl sm:border sm:border-slate-200 ' +
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
            {PLAN_TIERS.length} plans from {shortPrice(PLAN_PRICE_RANGE.low)} to{' '}
            {shortPrice(PLAN_PRICE_RANGE.high)} a month. 7-day free trial —
            cancel anytime.
          </p>
        </div>

        {/* THREE compact plan cards in ONE horizontal row from sm+ (stacked only
            on narrow mobile, which is a known-accepted surface here).

            Each card lists its OWN differentiating benefits, read out of
            FEATURE_MATRIX by tier key — so what the card promises and what the
            server enforces (TIER_LIMITS, reconciled by reconcileMatrixWithLimits)
            can never drift apart.

            Emphasis: ONLY the recommended tier gets the blue border/ring, the
            badge, the lift and the filled CTA. The other two are quiet — that is
            the whole mechanism; when all three shouted, none of them did.

            The CTA carries ?plan=<id> so a middle-click / no-JS navigation — and
            Forge's server-side read on /auth/register — still works. A plain
            left-click hands off to the signup modal. */}
        <div className="mt-8 grid gap-3 sm:grid-cols-3 sm:items-start">
          {PLAN_TIERS.map((tier) => {
            const isRecommended = tier.id === RECOMMENDED_TIER;
            return (
              <div
                key={tier.id}
                className={
                  'relative flex flex-col rounded-2xl bg-white p-4 text-center transition-shadow ' +
                  (isRecommended
                    ? 'border-2 border-blue-600 ring-2 ring-blue-600/15 shadow-md shadow-blue-600/15 sm:-mt-2 sm:pt-6 sm:pb-5'
                    : 'border border-slate-200 shadow-sm')
                }
              >
                {isRecommended && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-blue-600 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                    Recommended
                  </span>
                )}

                <h3
                  className={
                    'text-sm font-semibold ' +
                    (isRecommended ? 'text-blue-700' : 'text-slate-900')
                  }
                >
                  {tier.name}
                </h3>

                <div className="mt-1 flex items-baseline justify-center gap-1">
                  <span className="text-3xl font-semibold tracking-tight text-slate-900">
                    {tier.price}
                  </span>
                  <span className="text-xs text-slate-500">{tier.period}</span>
                </div>

                <p className="mt-1.5 min-h-[2.5rem] text-xs leading-snug text-slate-500">
                  {tier.tagline}
                </p>

                <a
                  href={`/auth/register?plan=${tier.id}`}
                  onClick={(e) => handleTierClick(e, tier.id)}
                  aria-label={`Try for free — ${tier.a11yLabel}`}
                  className={
                    'mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
                    (isRecommended
                      ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700'
                      : 'border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50')
                  }
                >
                  Try for free
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </a>

                {/* What THIS price buys. Values come from FEATURE_MATRIX at
                    runtime — never typed here. A `false` renders as a visible,
                    muted "not included" row rather than vanishing: a missing row
                    reads as an oversight, a struck one reads as a reason to
                    upgrade. */}
                <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 text-left text-xs">
                  {FEATURE_MATRIX.map((row) => {
                    const value = row.values[tier.id];
                    const included = value !== false;
                    return (
                      <li key={row.label} className="flex items-start gap-1.5">
                        {included ? (
                          <Check
                            className="mt-0.5 h-3 w-3 flex-shrink-0 text-blue-600"
                            strokeWidth={3}
                            aria-hidden="true"
                          />
                        ) : (
                          <Minus
                            className="mt-0.5 h-3 w-3 flex-shrink-0 text-slate-300"
                            strokeWidth={3}
                            aria-hidden="true"
                          />
                        )}
                        <span className={included ? 'text-slate-700' : 'text-slate-400'}>
                          {typeof value === 'string' && (
                            <span className="font-semibold text-slate-900">{value} </span>
                          )}
                          {row.label}
                          {!included && (
                            <span className="ml-1 text-slate-400">— not included</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
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

        {/* Genuinely shared across all three plans — kept as ONE strip below the
            cards rather than repeated in each column, because repeating a shared
            feature three times makes it look like a differentiator. */}
        <div className="mx-auto mt-8 max-w-2xl">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            Included on every plan
          </p>
          <ul className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-3">
            {INCLUDED_ON_EVERY_PLAN.map((f) => (
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
