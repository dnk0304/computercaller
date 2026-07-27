'use client';

/**
 * UpgradeModal — the in-app 3-tier pricing / upgrade dialog (dispatch
 * feature/tier-gating, 2026-07-27).
 *
 * Two phases in one dialog:
 *   1. COMPARE  — Solo $5 / Plus $7 (recommended) / Pro $10 side by side, each
 *                 showing that tier's REAL limits (3 / 10 / 30 templates,
 *                 30-day / 6-month / 1-year history, contact sync, screen
 *                 mirroring). The caller's current tier is marked and its CTA
 *                 disabled; higher tiers offer an "Upgrade" CTA.
 *   2. CHECKOUT — the chosen tier's in-page Whop embedded checkout (same
 *                 <WhopEmbedCheckout> the lock screen uses). A Back control
 *                 returns to COMPARE.
 *
 * Data source: getTierPlans() from lib/pricing (FORGE owns that display map;
 * this modal consumes it read-only). Runtime tier/limits come from
 * /api/entitlement via the provider — never re-derived here.
 *
 * Audience note: these users are already inside /app on a live plan, so the
 * framing is "upgrade", not "start a trial" — we don't promise a fresh 7-day
 * trial here (that copy belongs on the signup/lock surfaces). The reassurance
 * is the honest, always-true "cancel anytime".
 *
 * A11y (parity with PricingModal): role="dialog" + aria-modal + aria-labelledby,
 * focus trap, initial focus into the dialog, Escape + backdrop close, body
 * scroll lock, focus return to the opener, visible focus rings. Motion is
 * gated behind motion-safe: so prefers-reduced-motion users get no transforms.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, Check, ArrowRight, ArrowLeft, Star, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { getTierPlans, type TierPlanDisplay } from '@/lib/pricing';
import type { Tier } from '@/lib/tiers';
import { WhopEmbedCheckout } from './WhopEmbedCheckout';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Why the modal opened — drives a short contextual line above the plans. */
export type UpgradeReason = 'templates' | 'contactSync' | 'syncRange' | undefined;

/** Tier rank so we can tell "current" from "upgrade" from "already included". */
const TIER_RANK: Record<Tier, number> = { solo: 0, plus: 1, pro: 2 };

function reasonLine(reason: UpgradeReason): string | null {
  switch (reason) {
    case 'templates':
      return "You've reached your template limit on this plan.";
    case 'contactSync':
      return 'Contact sync is available on Plus and Pro.';
    case 'syncRange':
      return 'A longer sync history is available on higher plans.';
    default:
      return null;
  }
}

export interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  /** The caller's current tier, or null if not yet resolved. */
  currentTier: Tier | null;
  /** Why the modal opened (optional contextual line). */
  reason?: UpgradeReason;
}

export function UpgradeModal({ open, onClose, currentTier, reason }: UpgradeModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  // The tier whose checkout is showing, or null while comparing.
  const [checkoutTier, setCheckoutTier] = useState<TierPlanDisplay | null>(null);

  const plans = useMemo(() => getTierPlans(), []);
  const currentRank = currentTier ? TIER_RANK[currentTier] : -1;

  // Close AND reset to the compare phase, so the next open never reopens on a
  // stale checkout view. Done in the close handler (an event path) rather than
  // an effect — no set-state-in-effect. Every close route (X, backdrop, Escape)
  // funnels through here.
  const handleClose = useCallback(() => {
    setCheckoutTier(null);
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
      // Only restore if the opener is still in the document and focusable.
      if (opener && document.contains(opener) && typeof opener.focus === 'function') {
        opener.focus();
      }
    };
    // Re-run when the phase flips so focus lands on the new heading.
  }, [open, checkoutTier]);

  // Escape-to-close + focus trap. One keydown listener while open.
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

  const intro = reasonLine(reason);

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
          'min-h-full sm:min-h-0 sm:w-full sm:max-w-3xl sm:rounded-2xl sm:border sm:border-slate-200',
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

        {checkoutTier ? (
          /* ---- Phase 2: checkout for the chosen tier ---- */
          <div className="mx-auto w-full max-w-md">
            <button
              type="button"
              onClick={() => setCheckoutTier(null)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              All plans
            </button>

            <div className="mt-4 pr-8 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">Upgrade</p>
              <h2
                id={titleId}
                ref={headingRef}
                tabIndex={-1}
                className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none"
              >
                Upgrade to {checkoutTier.name}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                <span className="font-semibold text-slate-700">{checkoutTier.price}</span>{' '}
                {checkoutTier.period} · cancel anytime
              </p>
            </div>

            <div className="mt-6 text-left">
              <WhopEmbedCheckout key={checkoutTier.planId} planId={checkoutTier.planId} accentColor="#3358d4" />
            </div>
          </div>
        ) : (
          /* ---- Phase 1: compare the three tiers ---- */
          <>
            <div className="pr-8 text-center">
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Plans</p>
              <h2
                id={titleId}
                ref={headingRef}
                tabIndex={-1}
                className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none sm:text-3xl"
              >
                Choose your plan
              </h2>
              {intro ? (
                <p className="mx-auto mt-3 max-w-lg text-slate-600">{intro}</p>
              ) : (
                <p className="mx-auto mt-3 max-w-lg text-slate-600">
                  Pick the plan that fits how you use ComputerCaller.
                </p>
              )}
            </div>

            <ul className="mt-8 grid gap-4 sm:grid-cols-3" role="list">
              {plans.map((plan) => {
                const rank = TIER_RANK[plan.tier];
                const isCurrent = currentRank === rank;
                const isLower = currentRank >= 0 && rank < currentRank;
                return (
                  <li
                    key={plan.tier}
                    className={clsx(
                      'relative flex flex-col rounded-2xl border p-5 text-left transition-shadow',
                      plan.highlight
                        ? 'border-blue-600 ring-1 ring-blue-600/20 shadow-sm shadow-blue-600/10 sm:-mt-2 sm:mb-2'
                        : 'border-slate-200',
                      isCurrent && 'bg-slate-50/60',
                    )}
                  >
                    {plan.highlight && (
                      <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm">
                        <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                        Recommended
                      </span>
                    )}

                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-base font-bold text-slate-900">{plan.name}</h3>
                      {isCurrent && (
                        <span className="inline-flex items-center rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          Current
                        </span>
                      )}
                    </div>

                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-3xl font-semibold tracking-tight text-slate-900">
                        {plan.price}
                      </span>
                      <span className="text-sm text-slate-500">{plan.period}</span>
                    </div>

                    <ul className="mt-4 flex-1 space-y-2.5" role="list">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-sm text-slate-700">
                          <span
                            className={clsx(
                              'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border',
                              plan.highlight
                                ? 'border-blue-100 bg-blue-50'
                                : 'border-slate-200 bg-slate-50',
                            )}
                          >
                            <Check
                              className={clsx('h-2.5 w-2.5', plan.highlight ? 'text-blue-600' : 'text-slate-500')}
                              strokeWidth={3}
                              aria-hidden="true"
                            />
                          </span>
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-5">
                      {isCurrent ? (
                        <span className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-semibold text-slate-500">
                          <Check className="h-4 w-4" aria-hidden="true" />
                          Current plan
                        </span>
                      ) : isLower ? (
                        <span className="flex w-full items-center justify-center rounded-xl border border-dashed border-slate-200 py-2.5 text-sm font-medium text-slate-400">
                          Included in your plan
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setCheckoutTier(plan)}
                          aria-label={`Upgrade to ${plan.name} — ${plan.a11yLabel}`}
                          className={clsx(
                            'flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                            plan.highlight
                              ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700 focus-visible:ring-blue-500/40'
                              : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:ring-slate-400/40',
                          )}
                        >
                          Choose {plan.name}
                          <ArrowRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Risk-reversal band — honest for existing subscribers (no trial promise). */}
            <div className="mt-8 flex justify-center">
              <p className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600 shadow-sm">
                <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-500" aria-hidden="true" />
                Change or cancel your plan anytime — no lock-in.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default UpgradeModal;
