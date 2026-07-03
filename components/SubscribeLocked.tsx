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
 *   - €7.99/month (same figure shown in ProfileMenu + /app/settings)
 *   - support@computercaller.com (the app's real reply-to, see lib/email.ts)
 */

import React from 'react';
import { Lock, ArrowRight, ShieldCheck, RefreshCw, LifeBuoy, LogOut } from 'lucide-react';
import { clsx } from 'clsx';

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
   * Forge can pass the true length (14 or 30 depending on WAITLIST_MODE)
   * without this component hard-coding a number that could be wrong.
   */
  trialDays?: number;
  /** Support email; defaults to the app's real reply-to address. */
  supportEmail?: string;
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
}: SubscribeLockedProps) {
  const { headline, subtext } = resolveCopy(state, trialDays);
  const ctaLabel = state === 'expired' || state === 'cancelled' ? 'Reactivate' : 'Subscribe now';

  const handleLogout = () => {
    // Best-effort logout, then land on the marketing page (mirrors ProfileMenu).
    fetch('/api/auth/logout', { method: 'POST' })
      .catch(() => { /* cookie expires server-side regardless */ })
      .finally(() => {
        window.location.href = '/';
      });
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-10 font-sans">
      {/* Subtle brand wash — same palette as the app content slot. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-blue-50/60 via-indigo-50/30 to-purple-50/50"
        aria-hidden="true"
      />

      <section
        className={clsx(
          'relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-900/5',
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

        {/* Primary CTA → Whop checkout */}
        <a
          href={whopCheckoutUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          {ctaLabel}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <p className="mt-2 text-xs text-slate-400">
          €7.99/month · cancel anytime
        </p>

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
