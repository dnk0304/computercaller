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
 *   - three plans (Monthly / 3-Month / Annual) surfaced as a selector that
 *     drives the embed; prices come from the shared `lib/pricing` config
 *   - support@computercaller.com (the app's real reply-to, see lib/email.ts)
 */

import React, { useState } from 'react';
import { Lock, ArrowRight, ShieldCheck, RefreshCw, LifeBuoy, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { WhopEmbedCheckout } from './WhopEmbedCheckout';
import type { PlanTier } from '@/lib/pricing';

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
  /** Support email; defaults to the app's real reply-to address. */
  supportEmail?: string;
  /**
   * Available subscription tiers (Monthly / 3-Month / Annual), resolved from
   * env by the server via `getPlanTiers()`. When ≥1 tier is present, the tier
   * selector + in-page embedded checkout becomes the PRIMARY conversion surface
   * and the external `whopCheckoutUrl` link drops to a secondary fallback. When
   * the list is empty (env unset), we render only the external "Subscribe"
   * button — no selector, no embed, no crash.
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

  // Embed is primary when at least one tier is configured. The external Whop
  // URL is a real link only when set (page passes '#' as a sentinel when the
  // env is missing) — we never render a dead fallback link.
  const hasEmbed = tiers.length > 0;
  const hasExternalUrl = Boolean(whopCheckoutUrl) && whopCheckoutUrl !== '#';

  // Selected tier — defaults to the first available (Monthly when configured).
  // Local UI state only; the embed re-mounts on change via `key` (see below).
  const [selectedId, setSelectedId] = useState<string | undefined>(tiers[0]?.id);
  const selectedTier = tiers.find((t) => t.id === selectedId) ?? tiers[0];

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
          // The embed needs more breathing room than the plain CTA card.
          hasEmbed ? 'max-w-lg' : 'max-w-md',
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

        {hasEmbed && selectedTier ? (
          <>
            {/* Plan selector — radiogroup of tiers driving the embed below.
                Native <input type="radio"> gives arrow-key navigation + a single
                tab stop for free; the visible card is styled from the checked
                state. */}
            <fieldset className="mt-6">
              <legend className="sr-only">Choose a subscription plan</legend>
              <div className="flex flex-col gap-2.5">
                {tiers.map((tier) => {
                  const isSelected = tier.id === selectedTier.id;
                  return (
                    <label
                      key={tier.id}
                      className={clsx(
                        'relative flex cursor-pointer items-center gap-3 rounded-xl border p-4 text-left transition-colors',
                        'focus-within:ring-2 focus-within:ring-blue-500/50 focus-within:ring-offset-1',
                        isSelected
                          ? 'border-blue-600 bg-blue-50/60 ring-1 ring-blue-600/20'
                          : 'border-slate-200 bg-white hover:border-slate-300',
                      )}
                    >
                      <input
                        type="radio"
                        name="subscription-plan"
                        value={tier.id}
                        checked={isSelected}
                        onChange={() => setSelectedId(tier.id)}
                        aria-label={tier.a11yLabel}
                        className="peer sr-only"
                      />
                      {/* Radio indicator */}
                      <span
                        aria-hidden="true"
                        className={clsx(
                          'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                          isSelected ? 'border-blue-600' : 'border-slate-300',
                        )}
                      >
                        {isSelected && <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />}
                      </span>

                      {/* Name + per-month/savings on the left, price on the right */}
                      <span className="flex flex-1 items-center justify-between gap-2">
                        <span className="flex flex-col">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900">{tier.name}</span>
                            {tier.badge && (
                              <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                                {tier.badge}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 text-xs text-slate-500">
                            {tier.perMonth}
                            {tier.savings && (
                              <span className="font-medium text-emerald-600"> · {tier.savings}</span>
                            )}
                          </span>
                        </span>
                        <span className="flex flex-col items-end">
                          <span className="text-base font-bold text-slate-900">{tier.price}</span>
                          <span className="text-[11px] text-slate-400">{tier.period}</span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* PRIMARY conversion surface — in-page Whop embedded checkout for
                the selected tier. `key={planId}` forces a clean re-mount when
                the selection changes so the iframe reloads with the new plan's
                price rather than relying on the web component to react to a prop
                change. selectedTier is guaranteed defined inside this branch. */}
            <div className="mt-4 text-left">
              <WhopEmbedCheckout
                key={selectedTier.planId}
                planId={selectedTier.planId}
                accentColor="#3358d4"
              />
            </div>
            <p className="mt-3 text-xs text-slate-400">7-day free trial · cancel anytime</p>

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
            <p className="mt-2 text-xs text-slate-400">7-day free trial · cancel anytime</p>
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
