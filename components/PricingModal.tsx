'use client';

/**
 * PricingModal — on-page pricing dialog opened by the landing header's "Pricing"
 * nav link.
 *
 * $5-PROMOTED / $7-HIDDEN + LIMITED TRIAL (dispatch pricing-5-promoted-7-hidden,
 * 2026-08-17). SINGLE-PLAN storefront: it shows ONE price — $5/mo — beside the
 * limited free-trial column. $7 is NOT on this page (it is an in-app upgrade
 * prompt only). Every price/limit is read from lib/pricing at runtime — nothing
 * about a plan is typed into this file. Below the hero card sits ONE list —
 * "Included when subscribed" — with no trial-vs-paid comparison (2026-09-15).
 *
 * Hand-off (LOCKED): pricing → SIGNUP modal, in-page. The CTA stays a REAL
 * <a href="/auth/register?plan=plus"> so middle/cmd/ctrl-click and the no-JS
 * fallback still navigate (preserving the ?plan= URL contract); a plain
 * left-click is intercepted and handed to the signup modal.
 *
 * A11y — full parity with SignupModal: role="dialog" + aria-modal + aria-labelledby,
 * focus trap, initial focus, Escape/backdrop close, focus return, body scroll
 * lock, labelled close, focus-visible rings.
 */

import React, { useEffect, useId, useMemo, useRef } from 'react';
import { X, Check, ArrowRight } from 'lucide-react';
import {
  getPromotedPlan,
  SUBSCRIBED_INCLUDES,
  PROMOTED_TIER,
  TRIAL_DAYS,
  type PlanTierId,
} from '@/lib/pricing';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface PricingModalProps {
  open: boolean;
  onClose: () => void;
  /** The nav link that opened the modal; focus returns to it on close. */
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  /** Hand-off to the signup modal on a plain left-click of the CTA. */
  onSelectTier: (tierId: PlanTierId) => void;
}

export function PricingModal({ open, onClose, triggerRef, onSelectTier }: PricingModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  const plan = useMemo(() => getPromotedPlan(), []);

  // Body scroll lock — capture + restore the exact prior inline overflow.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Focus in on open, restore to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => headingRef.current?.focus());
    const trigger = triggerRef.current;
    return () => {
      cancelAnimationFrame(raf);
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open, triggerRef]);

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

  function handleCtaClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onSelectTier(PROMOTED_TIER);
  }

  if (!open) return null;

  return (
    <div
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
          <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Pricing</p>
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none sm:text-3xl"
          >
            One plan. {plan.price} a month.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-slate-600">
            Start with a {TRIAL_DAYS}-day free trial, then {plan.price}/month. Cancel anytime.
          </p>
        </div>

        {/* Hero $5 card. Feature lines read from TIER_LIMITS at runtime. */}
        <div className="mt-8 rounded-2xl border-2 border-blue-600 bg-white p-6 shadow-md shadow-blue-600/10">
          <div className="flex items-baseline justify-center gap-1">
            <span className="text-4xl font-semibold tracking-tight text-slate-900">{plan.price}</span>
            <span className="text-sm text-slate-500">{plan.period}</span>
          </div>
          <ul className="mx-auto mt-5 max-w-xs space-y-2.5 text-left" role="list">
            {plan.features.map((f) => (
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

          <a
            href={`/auth/register?plan=${plan.id}`}
            onClick={handleCtaClick}
            aria-label={`Start free trial — ${plan.a11yLabel}`}
            className="mt-6 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          >
            Start {TRIAL_DAYS}-day free trial
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>

        {/* ONE list — what a subscriber gets. No trial-vs-paid framing anywhere
            (Dennis, 2026-09-15): the trial is already promised in the copy above
            and on the CTA, so repeating it here only invited comparison. The
            three countable lines come from TIER_LIMITS via SUBSCRIBED_INCLUDES,
            so they cannot drift from what the app enforces. */}
        <div className="mt-8">
          <h3 className="text-center text-base font-semibold tracking-tight text-slate-900">
            Included when subscribed
          </h3>
          <ul
            className="mx-auto mt-4 grid max-w-xl gap-x-6 gap-y-2.5 text-sm text-slate-700 min-[400px]:grid-cols-2"
            role="list"
          >
            {SUBSCRIBED_INCLUDES.map((f) => (
              <li key={f} className="flex items-start gap-2">
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
        </div>

      </div>
    </div>
  );
}
