'use client';

/**
 * PricingModal — on-page pricing dialog opened by the landing header's "Pricing"
 * nav link.
 *
 * $5-PROMOTED / $7-HIDDEN + LIMITED TRIAL (dispatch pricing-5-promoted-7-hidden,
 * 2026-08-17). SINGLE-PLAN storefront: it shows ONE price — $5/mo — beside the
 * limited free-trial column. $7 is NOT on this page (it is an in-app upgrade
 * prompt only). Every price/limit is read from lib/pricing at runtime — nothing
 * about a plan is typed into this file. The trial column is card-first: no
 * "no card needed" copy anywhere.
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
import { X, Check, Minus, ArrowRight, ShieldCheck } from 'lucide-react';
import {
  getPromotedPlan,
  STOREFRONT_MATRIX,
  INCLUDED_ON_EVERY_PLAN,
  PROMOTED_TIER,
  TRIAL_DAYS,
  type PlanTierId,
} from '@/lib/pricing';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * FEATURE labels are plural by default ("Quick replies"). On a value of exactly
 * 1 the label follows a count and needs the singular ("1 Quick reply"). Applied
 * only to the bare number 1; "3 months" already carries its own noun.
 */
function labelForCount(label: string, value: string): string {
  if (value.trim() !== '1') return label;
  const words = label.split(' ');
  const last = words[words.length - 1];
  let singular = last;
  if (/ies$/.test(last)) singular = `${last.slice(0, -3)}y`;
  else if (/[^s]s$/.test(last)) singular = last.slice(0, -1);
  if (singular === last) return label;
  words[words.length - 1] = singular;
  return words.join(' ');
}

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

        {/* What the free trial gives before you activate — vs the $5 plan. Every
            number is reconciled against TIER_LIMITS by
            reconcileStorefrontWithLimits(). This is a promise, so it is checked. */}
        <div className="mt-8">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            During your free trial vs the full plan
          </p>
          <table className="mt-4 w-full border-collapse text-left text-sm">
            <caption className="sr-only">Free trial compared with the {plan.price} plan</caption>
            <thead>
              <tr className="border-b border-slate-200">
                <th scope="col" className="py-2 pr-2 font-medium text-slate-500">
                  Included
                </th>
                <th scope="col" className="px-2 py-2 text-center font-semibold text-slate-600">
                  Free trial
                </th>
                <th scope="col" className="px-2 py-2 text-center font-semibold text-blue-700">
                  {plan.price}/mo
                </th>
              </tr>
            </thead>
            <tbody>
              {STOREFRONT_MATRIX.map((row) => (
                <tr key={row.label} className="border-b border-slate-100 last:border-0">
                  <th scope="row" className="py-2 pr-2 font-normal text-slate-600">
                    {row.label}
                    {row.note && (
                      <span className="block text-[11px] leading-snug text-slate-400">{row.note}</span>
                    )}
                  </th>
                  {(['trial', 'plus'] as const).map((col) => {
                    const v = row.values[col];
                    const notIncluded = v === 0;
                    return (
                      <td
                        key={col}
                        className={
                          'px-2 py-2 text-center tabular-nums ' +
                          (col === 'plus' ? 'font-semibold text-slate-900' : 'text-slate-600')
                        }
                      >
                        {notIncluded ? (
                          <>
                            <Minus className="mx-auto h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
                            <span className="sr-only">not included</span>
                          </>
                        ) : (
                          <span>
                            {typeof v === 'number'
                              ? `${v} ${labelForCount(row.label, String(v)).toLowerCase()}`
                              : v}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Risk-reversal — card-first, honest. No "no card needed" language. */}
        <div className="mt-8 flex justify-center">
          <p className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-center text-sm text-slate-600 shadow-sm">
            <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-500" aria-hidden="true" />
            Cancel anytime before day {TRIAL_DAYS} and you won&apos;t be charged.
          </p>
        </div>

        {/* Genuinely shared by the trial AND the plan. */}
        <div className="mx-auto mt-8 max-w-2xl">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
            Included from day one
          </p>
          <ul className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-3">
            {INCLUDED_ON_EVERY_PLAN.map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50">
                  <Check className="h-2.5 w-2.5 text-blue-600" strokeWidth={3} aria-hidden="true" />
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
