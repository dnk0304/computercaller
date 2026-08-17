/**
 * /subscribe — the lock screen an unentitled (but logged-in) user is redirected
 * to by proxy.ts (dispatch forge/trial-lock-and-admin-dashboard, 2026-07-03).
 *
 * Server component. It resolves entitlement server-side and renders Pixel's
 * <SubscribeLocked>. Critically it is NOT in proxy.ts's matcher
 * (['/', '/app/:path*', '/auth/:path*']), so the entitlement gate does not run
 * here — otherwise a locked user would loop /app → /subscribe → /subscribe …
 *
 * Access rules:
 *   - Guest (no valid session) → /auth/login?next=/subscribe.
 *   - Logged-in AND entitled   → /app (they don't belong on the lock screen;
 *                                e.g. Dennis/admin, allowlisted, trialing,
 *                                active). This also handles the post-payment
 *                                case: once the Whop webhook flips the sub to
 *                                active, the next load of /subscribe bounces
 *                                them straight back into the app.
 *   - Logged-in AND NOT entitled → render the lock (trial_expired/expired/none).
 *
 * There is no realtime push after payment — the user subscribes on Whop, then
 * refreshes; the webhook (usually within seconds) flips them to active and the
 * next request passes. SubscribeLocked surfaces a "Refresh" affordance for this.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { evaluateEntitlement, type EntitlementState } from '@/lib/entitlement';
import { getPromotedPlan } from '@/lib/pricing';
import SubscribeLocked, { type SubscribeLockedState } from '@/components/SubscribeLocked';

const DAY_MS = 24 * 60 * 60 * 1000;

// Map the full entitlement state to SubscribeLocked's narrower prop union. Only
// the DENIED states can reach the render below (allowed states redirect to
// /app first), so this is total over what actually arrives; the default is a
// defensive fallback that should never fire.
function toLockedState(state: EntitlementState): SubscribeLockedState {
  switch (state) {
    case 'trial_expired':
      return 'trial_expired';
    case 'expired':
      return 'expired';
    case 'none':
      return 'none';
    default:
      return 'none';
  }
}

/**
 * SINGLE-PLAN storefront ($5-promoted / $7-hidden, 2026-08-17): the page sells
 * exactly one plan — $5/mo — so the old `?plan=<tier>` selection is moot. The
 * param is still accepted (harmless if present from an old link) but no longer
 * steers a choice; there is only one plan to check out on.
 */
export default async function SubscribePage() {
  const token = (await cookies()).get('auth_token')?.value;
  const payload = token ? await validateSessionToken(token) : null;

  // Guest → login, preserving intent.
  if (!payload) {
    redirect('/auth/login?next=/subscribe');
  }

  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: {
      isAdmin: true,
      email: true,
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          createdAt: true,
        },
      },
    },
  });

  // Row vanished (deleted account mid-session) — treat as guest.
  if (!user) {
    redirect('/auth/login?next=/subscribe');
  }

  const ent = evaluateEntitlement({
    isAdmin: user.isAdmin,
    email: user.email,
    subscription: user.subscription
      ? {
          status: user.subscription.status,
          trialEndsAt: user.subscription.trialEndsAt,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
        }
      : null,
  });

  // Entitled users don't belong here — send them into the app.
  if (ent.allowed) {
    redirect('/app');
  }

  const whopCheckoutUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';
  // The single $5/month promoted plan for the in-page embedded checkout. Its
  // planId comes from PLAN_IDS.plus (lib/tiers-core) via getPromotedPlan — the
  // same id the entitlement core resolves the `plus` tier from, so the plan the
  // user pays on and the tier they are granted cannot drift. Passed as a
  // one-element array so SubscribeLocked's `tiers` contract is unchanged.
  const tiers = [getPromotedPlan()];

  // True trial LENGTH in whole days (trialEndsAt - subscription.createdAt),
  // derived rather than hard-coded so the "Your N-day free trial has ended"
  // copy stays correct if the grant length ever changes. Only meaningful for a
  // trial_expired user; omitted otherwise.
  let trialDays: number | undefined;
  if (ent.state === 'trial_expired' && user.subscription) {
    const span = user.subscription.trialEndsAt.getTime() - user.subscription.createdAt.getTime();
    const days = Math.round(span / DAY_MS);
    if (days > 0) trialDays = days;
  }

  return (
    <SubscribeLocked
      state={toLockedState(ent.state)}
      whopCheckoutUrl={whopCheckoutUrl}
      trialDays={trialDays}
      tiers={tiers}
    />
  );
}
