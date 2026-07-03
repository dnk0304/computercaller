'use client';

/**
 * WhopEmbedCheckout — in-page Whop checkout + post-payment unlock.
 *
 * Wave 3 (2026-07-03, Pixel). Replaces the external checkout hop on the lock
 * screen with Whop's embedded checkout so trial_expired/expired/none/cap-hit
 * users can pay WITHOUT leaving the app, then get unlocked in place.
 *
 * Two responsibilities, kept together because they're one user journey:
 *   1. Render the embedded checkout (`@whop/checkout/react`).
 *   2. On payment success, UNLOCK the user. The Whop webhook
 *      (app/api/webhooks/whop/route.ts) flips the subscription to `active`, but
 *      that can lag a few seconds — so we DON'T assume instant. We poll a
 *      lightweight entitlement check (/api/auth/me → subscription.status) and
 *      hard-navigate to /app the moment it reads `active`. If polling times out
 *      we fall back to a manual "Continue" affordance rather than trapping the
 *      user on the lock screen.
 *
 * SSR: `@whop/checkout/react` ships no `'use client'` directive and is a purely
 * client-interactive iframe/web-component. We load it via `next/dynamic` with
 * `ssr: false` so it never executes during the server render (no hydration edge
 * cases under Next 16 / React 19) and its bundle stays out of the lock screen's
 * initial paint. A skeleton holds the layout (no CLS) while it mounts.
 *
 * The callback is Whop's `onComplete(planId, receiptOrSetupIntentId?)`. Passing
 * `onComplete` makes the embed keep the top frame loaded instead of doing its
 * own redirect (the package maps `skipRedirect || !!onComplete`); we also set
 * `skipRedirect` explicitly for clarity.
 */

import React, { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, ArrowRight, RefreshCw } from 'lucide-react';

// Client-only. `ssr: false` is legal here because this module is a client
// component. `loading` holds the layout while the chunk downloads; the embed's
// own `fallback` holds it while the iframe measures itself.
const WhopCheckoutEmbed = dynamic(
  () => import('@whop/checkout/react').then((m) => m.WhopCheckoutEmbed),
  { ssr: false, loading: () => <EmbedSkeleton /> },
);

// Poll cadence for the post-payment entitlement recheck. The webhook usually
// lands within a few seconds; 1.5s × ~20s gives it comfortable headroom without
// hammering the endpoint, then hands off to a manual affordance.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 20000;

type Phase = 'checkout' | 'unlocking' | 'timeout';

export interface WhopEmbedCheckoutProps {
  /** Whop plan id (from NEXT_PUBLIC_WHOP_PLAN_ID). */
  planId: string;
  /** Brand accent for the embed. Defaults to the app blue (#3358d4). */
  accentColor?: string;
}

/** Skeleton sized to the embed's initial height so there's no layout shift. */
function EmbedSkeleton() {
  return (
    <div
      className="min-h-[480px] w-full rounded-xl border border-slate-200 bg-slate-50 motion-safe:animate-pulse"
      role="status"
      aria-label="Loading secure checkout"
    />
  );
}

export function WhopEmbedCheckout({ planId, accentColor = '#3358d4' }: WhopEmbedCheckoutProps) {
  const [phase, setPhase] = useState<Phase>('checkout');

  // Payment complete → enter the unlocking state; the effect below drives the
  // entitlement poll. We ignore the plan/receipt args — the webhook is the
  // source of truth, we just wait for it to land.
  const handleComplete = useCallback(() => {
    setPhase('unlocking');
  }, []);

  // Entitlement poll. Runs only while `phase === 'unlocking'`. On success we
  // hard-navigate (window.location) rather than client-route so the server
  // re-evaluates the entitlement gate and the app boots against a fresh session.
  useEffect(() => {
    if (phase !== 'unlocking') return;

    let cancelled = false;
    let timer: number | undefined;
    const start = Date.now();

    const isEntitled = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/auth/me', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = (await res.json()) as {
          user?: { subscription?: { status?: string } | null } | null;
        };
        return data.user?.subscription?.status === 'active';
      } catch {
        return false;
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (await isEntitled()) {
        if (!cancelled) window.location.assign('/app');
        return;
      }
      if (cancelled) return;
      if (Date.now() - start >= POLL_TIMEOUT_MS) {
        setPhase('timeout');
        return;
      }
      timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase]);

  if (phase === 'unlocking') {
    return (
      <div
        className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-6 py-10 text-center"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-7 w-7 text-blue-600 motion-safe:animate-spin" aria-hidden="true" />
        <p className="text-sm font-semibold text-slate-800">Unlocking your account…</p>
        <p className="max-w-xs text-xs leading-relaxed text-slate-500">
          Payment received. We&apos;re activating your subscription — this only takes a moment.
        </p>
      </div>
    );
  }

  if (phase === 'timeout') {
    return (
      <div
        className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-xl border border-slate-200 bg-white px-6 py-10 text-center"
        role="status"
        aria-live="polite"
      >
        <div>
          <p className="text-sm font-semibold text-slate-800">Almost there</p>
          <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500">
            Your payment went through. Activation is taking a little longer than usual — continue to
            the app, or check again in a moment.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => window.location.assign('/app')}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          >
            Continue to app
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setPhase('unlocking')}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check again
          </button>
        </div>
      </div>
    );
  }

  // phase === 'checkout'
  return (
    <div className="w-full">
      <WhopCheckoutEmbed
        planId={planId}
        theme="light"
        themeOptions={{ accentColor }}
        skipRedirect
        onComplete={handleComplete}
        // Absolute return target for redirect-based payment methods (e.g. 3DS)
        // that leave and re-enter the page; landing back on /subscribe bounces
        // straight to /app once the webhook has flipped the sub to active.
        returnUrl={typeof window !== 'undefined' ? `${window.location.origin}/subscribe` : undefined}
        fallback={<EmbedSkeleton />}
      />
    </div>
  );
}

export default WhopEmbedCheckout;
