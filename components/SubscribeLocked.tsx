'use client';

/**
 * SubscribeLocked — the paywall a locked-out user is redirected to.
 *
 * Rendered by Forge's server component at `app/subscribe/page.tsx`, which
 * resolves the entitlement `state` + trial length server-side and passes them
 * down. This component is presentation-only: it decides the words and the
 * layout, never the gate.
 *
 * Tone: calm and reassuring, not punitive. A locked user is a customer we can
 * still keep — the screen's job is to make subscribing feel like the obvious,
 * low-risk next step, and to promise (truthfully) that nothing was deleted.
 *
 * Design: matches the app's LIGHT theme (slate-50 surface, white card, blue
 * primary button, the same focus-ring conventions). Single screen, centered,
 * no scroll.
 *
 * Pricing/support are kept consistent with the rest of the app:
 *   - ONE plan ($5/month, 7-day trial — Dennis 2026-07-05) drives the embedded
 *     checkout; the price comes from the shared `lib/pricing` config. The
 *     multi-tier radio selector from the 2026-07-03 rollout was removed with
 *     the extra tiers; `tiers` stays an array so a second plan can return
 *     without a prop-contract change (the first entry drives the embed).
 *   - support@computercaller.com (the app's real reply-to, see lib/email.ts)
 */

import React from 'react';
import { Lock, ArrowRight, ShieldCheck, RefreshCw, LifeBuoy, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { WhopEmbedCheckout } from './WhopEmbedCheckout';
import {
  STOREFRONT_MATRIX,
  INCLUDED_ON_EVERY_PLAN,
  TRIAL_DAYS,
  type PlanTier,
  type PlanTierId,
} from '@/lib/pricing';

export type SubscribeLockedState = 'trial_expired' | 'expired' | 'cancelled' | 'none';

export interface SubscribeLockedProps {
  /** Entitlement state resolved server-side. Drives the headline + subtext. */
  state: SubscribeLockedState;
  /** Whop checkout URL (from NEXT_PUBLIC_WHOP_CHECKOUT_URL). */
  whopCheckoutUrl: string;
  /**
   * Optional trial length in days. When provided for `trial_expired`, the
   * headline specialises to "Your N-day free trial has ended"; omitted, it
   * reads "Your free trial has ended". Kept optional (and additive to the
   * frozen `{ state, whopCheckoutUrl }` contract) so it never goes stale —
   * Forge can pass the true length (7 or 30 depending on WAITLIST_MODE)
   * without this component hard-coding a number that could be wrong.
   */
  trialDays?: number;
  /**
   * Pre-selected tier, carried from the landing-page pricing modal through
   * signup and the OAuth round trip via `?plan=`. Undefined (or unrecognised —
   * the page validates before passing) falls back to the recommended tier, so a
   * missing value degrades to the sensible default rather than to the cheapest.
   */
  initialTierId?: PlanTierId;
  /** Support email; defaults to the app's real reply-to address. */
  supportEmail?: string;
  /**
   * Available subscription plans, resolved from env by the server via
   * `getPlanTiers()`. When ≥1 plan is present, the in-page embedded checkout
   * (driven by the first plan) becomes the PRIMARY conversion surface and the
   * external `whopCheckoutUrl` link drops to a secondary fallback. When the
   * list is empty (env unset), we render only the external "Subscribe"
   * button — no embed, no crash.
   */
  tiers?: PlanTier[];
}

interface Copy {
  headline: string;
  subtext: string;
}

function resolveCopy(state: SubscribeLockedState, trialDays?: number): Copy {
  switch (state) {
    case 'trial_expired':
      return {
        headline: trialDays
          ? `Your ${trialDays}-day free trial has ended`
          : 'Your free trial has ended',
        subtext:
          'Subscribe to keep making calls and sending texts straight from your computer.',
      };
    case 'expired':
      return {
        headline: 'Your subscription has lapsed',
        subtext: 'Reactivate to pick up right where you left off — no setup, no re-pairing.',
      };
    case 'cancelled':
      return {
        headline: 'Your subscription was cancelled',
        subtext: 'Reactivate anytime to pick up right where you left off.',
      };
    case 'none':
    default:
      return {
        headline: 'Subscribe to get started',
        subtext: 'Unlock calling and texting from your computer.',
      };
  }
}

export function SubscribeLocked({
  state,
  whopCheckoutUrl,
  trialDays,
  supportEmail = 'support@computercaller.com',
  tiers = [],
}: SubscribeLockedProps) {
  const { headline, subtext } = resolveCopy(state, trialDays);
  const ctaLabel = state === 'expired' || state === 'cancelled' ? 'Reactivate' : 'Subscribe now';

  // Embed is primary when the plan is configured. The external Whop URL is a
  // real link only when set (page passes '#' as a sentinel when env is missing)
  // — we never render a dead fallback link.
  const hasEmbed = tiers.length > 0;
  const hasExternalUrl = Boolean(whopCheckoutUrl) && whopCheckoutUrl !== '#';

  // SINGLE-PLAN storefront ($5-promoted / $7-hidden, 2026-08-17): the pricing
  // page sells exactly ONE plan — $5/mo. `initialTierId` is retained on the prop
  // contract (carried from the landing page through OAuth) but there is now only
  // one plan to select, so the first (only) tier drives the embed. $7 is never
  // shown here — it is an in-app upgrade prompt only.
  const plan = tiers[0];

  const handleLogout = () => {
    // Best-effort logout, then land on the marketing page (mirrors ProfileMenu).
    fetch('/api/auth/logout', { method: 'POST' })
      .catch(() => { /* cookie expires server-side regardless */ })
      .finally(() => {
        window.location.href = '/';
      });
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden bg-slate-50 px-4 py-10 font-sans">
      {/* Subtle brand wash — same palette as the app content slot. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-blue-50/60 via-indigo-50/30 to-purple-50/50"
        aria-hidden="true"
      />

      <section
        className={clsx(
          'relative w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-900/5',
          // Widths, in order of how much the card has to hold:
          //   plain CTA        — a headline and a button
          //   embed only       — plus Whop's iframe
          //   embed + 3 plans  — plus a selector and a comparison table
          // Three plans at max-w-lg wrapped each card's tagline to four lines and
          // squeezed the table's numeric columns; the plans are the decision the
          // page exists to support, so they get the room.
          hasEmbed ? (tiers.length > 1 ? 'max-w-2xl' : 'max-w-lg') : 'max-w-md',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300'
        )}
        aria-labelledby="subscribe-locked-heading"
      >
        {/* Lock badge */}
        <span
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-sm"
          aria-hidden="true"
        >
          <Lock className="h-6 w-6" />
        </span>

        <h1 id="subscribe-locked-heading" className="text-xl font-bold tracking-tight text-slate-900">
          {headline}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">{subtext}</p>

        {/* Reassurance — the truthful "nothing is lost" promise. */}
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-left">
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-emerald-800">
            Your account, paired phone, and saved templates are safe and waiting — nothing has been
            deleted. Subscribing picks up exactly where you left off.
          </p>
        </div>

        {hasEmbed && plan ? (
          <>
            {/* SINGLE plan — $5/mo. Price + benefits read from lib/pricing
                (TIER_LIMITS), never typed here. */}
            <div className="mt-6 rounded-xl border-2 border-blue-600 bg-blue-50/40 p-4 text-left ring-1 ring-blue-600/10">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">{plan.name}</span>
                <span className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-slate-900">{plan.price}</span>
                  <span className="text-[11px] text-slate-500">/mo</span>
                </span>
              </div>
              <ul className="mt-3 space-y-1.5" role="list">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-1.5 text-xs text-slate-700">
                    <span aria-hidden="true" className="mt-0.5 text-blue-600">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Free trial vs the $5 plan. Every value is reconciled against
                TIER_LIMITS by reconcileStorefrontWithLimits() — this table is a
                promise, so it is checked against what the app enforces. */}
            <table className="mt-4 w-full border-collapse text-left text-xs">
              <caption className="sr-only">Free trial compared with the {plan.price} plan</caption>
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className="py-2 pr-2 font-medium text-slate-500">Included</th>
                  <th scope="col" className="px-1 py-2 text-center font-semibold text-slate-600">
                    Free trial
                  </th>
                  <th scope="col" className="px-1 py-2 text-center font-semibold text-blue-700">
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
                        <span className="block text-[10px] leading-snug text-slate-400">{row.note}</span>
                      )}
                    </th>
                    {(['trial', 'plus'] as const).map((col) => {
                      const v = row.values[col];
                      const notIncluded = v === 0;
                      return (
                        <td
                          key={col}
                          className={clsx(
                            'px-1 py-2 text-center tabular-nums',
                            col === 'plus' ? 'font-semibold text-slate-900' : 'text-slate-600'
                          )}
                        >
                          {notIncluded ? (
                            <>
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">not included</span>
                            </>
                          ) : (
                            v
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="mt-3 space-y-1 text-left text-[11px] text-slate-500">
              {INCLUDED_ON_EVERY_PLAN.map((line) => (
                <li key={line} className="flex items-start gap-1.5">
                  <span aria-hidden="true" className="mt-0.5 text-emerald-600">✓</span>
                  <span>{line}<span className="sr-only"> — included on every plan</span></span>
                </li>
              ))}
            </ul>

            {/* PRIMARY conversion surface — in-page Whop embedded checkout for
                the $5 plan. `plan` is guaranteed defined inside this branch. */}
            <div className="mt-4 text-left">
              <WhopEmbedCheckout
                key={plan.planId}
                planId={plan.planId}
                accentColor="#3358d4"
              />
            </div>
            <p className="mt-3 text-xs text-slate-400">{TRIAL_DAYS}-day free trial · cancel anytime</p>

            {/* SECONDARY fallback — external Whop checkout, for anyone who'd
                rather complete payment on Whop's own page. */}
            {hasExternalUrl && (
              <a
                href={whopCheckoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:underline"
              >
                Prefer to check out on Whop?
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </>
        ) : (
          <>
            {/* Primary CTA → external Whop checkout (embed not configured). */}
            <a
              href={whopCheckoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              {ctaLabel}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <p className="mt-2 text-xs text-slate-400">{TRIAL_DAYS}-day free trial · cancel anytime</p>
          </>
        )}

        {/* Already-subscribed escape hatch — the Whop webhook can lag a few
            seconds after payment, so give the user a manual re-check. */}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mx-auto mt-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Already subscribed? Refresh
        </button>

        {/* Footer — support + logout. Subtle, secondary. */}
        <div className="mt-6 flex items-center justify-center gap-4 border-t border-slate-100 pt-5 text-xs">
          <a
            href={`mailto:${supportEmail}`}
            className="inline-flex items-center gap-1.5 font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:underline"
          >
            <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" />
            Contact support
          </a>
          <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:underline"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Log out
          </button>
        </div>
      </section>
    </main>
  );
}

export default SubscribeLocked;
