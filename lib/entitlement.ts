/**
 * lib/entitlement.ts — single source of truth for "is this user allowed to use
 * the paid product right now?" (dispatch forge/trial-lock-and-admin-dashboard,
 * 2026-07-03).
 *
 * This is a PURE function — no DB, no env reads beyond isEntitlementAllowed
 * (which is itself pure over process.env at call time). The caller loads the
 * user + subscription and passes them in. That keeps it trivially unit-testable
 * and lets every gate (proxy.ts, relay-ticket, /subscribe, admin API) share one
 * implementation so the money/access decision can never drift between call
 * sites.
 *
 * NO-LOCKOUT GUARANTEE: rule (1) admin and rule (2) allowlist are checked FIRST
 * and short-circuit to allowed=true regardless of subscription state. Dennis
 * (isAdmin) and the reviewer@ / ENTITLEMENT_ALLOWLIST emails can therefore never
 * be locked out by a missing, expired, or corrupt subscription row.
 */

import { isEntitlementAllowed } from '@/lib/auth';

export type EntitlementState =
  | 'admin'
  | 'allowlisted'
  | 'trialing'
  | 'active'
  | 'trial_expired'
  | 'expired'
  | 'none';

export interface EntitlementResult {
  allowed: boolean;
  state: EntitlementState;
  /** Whole days remaining in a live trial (ceil). null unless state==='trialing'. */
  trialDaysLeft: number | null;
  /** Machine-readable reason for the decision — logged, never shown to the user. */
  reason: string;
}

/**
 * Minimal subscription shape the evaluator needs. Deliberately NOT the full
 * Prisma model so callers can `select` only these columns.
 */
export interface EntitlementSubscriptionInput {
  status: string;
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
}

export interface EntitlementInput {
  isAdmin: boolean;
  email: string;
  subscription: EntitlementSubscriptionInput | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate entitlement. Rules are applied IN ORDER — the first matching rule
 * wins:
 *   (1) isAdmin                      → admin, allowed (never locked)
 *   (2) isEntitlementAllowed(email)  → allowlisted, allowed
 *   (3) no subscription              → none, denied
 *   (4) active AND (currentPeriodEnd null OR > now) → active, allowed
 *   (5) trial AND trialEndsAt > now  → trialing, allowed (trialDaysLeft = ceil)
 *   (6) trial AND trialEndsAt <= now → trial_expired, denied
 *   (7) else (expired / cancelled /  → expired, denied
 *       active-with-past-period)
 *
 * `now` is injectable purely so tests can pin the clock; production callers use
 * the default.
 */
export function evaluateEntitlement(
  input: EntitlementInput,
  now: Date = new Date(),
): EntitlementResult {
  const { isAdmin, email, subscription } = input;
  const nowMs = now.getTime();

  // (1) Admin — never locked, regardless of subscription. Highest priority so a
  // wrong/missing sub row can never lock Dennis out of his own app.
  if (isAdmin) {
    return { allowed: true, state: 'admin', trialDaysLeft: null, reason: 'admin' };
  }

  // (2) Entitlement allowlist (env ENTITLEMENT_ALLOWLIST + hardcoded fallback).
  // Second safety net for Dennis + the Play reviewer account.
  if (isEntitlementAllowed(email)) {
    return {
      allowed: true,
      state: 'allowlisted',
      trialDaysLeft: null,
      reason: 'entitlement_allowlist',
    };
  }

  // (3) No subscription at all — cannot be entitled.
  if (!subscription) {
    return { allowed: false, state: 'none', trialDaysLeft: null, reason: 'no_subscription' };
  }

  const { status, trialEndsAt, currentPeriodEnd } = subscription;

  // (4) Active paid subscription. currentPeriodEnd null = open-ended active
  // (e.g. a webhook that set active without an expiry); > now = still within the
  // paid period. An active row whose period has LAPSED falls through to (7).
  if (status === 'active' && (currentPeriodEnd === null || currentPeriodEnd.getTime() > nowMs)) {
    return { allowed: true, state: 'active', trialDaysLeft: null, reason: 'active_subscription' };
  }

  // (5) Live trial.
  if (status === 'trial' && trialEndsAt.getTime() > nowMs) {
    const trialDaysLeft = Math.ceil((trialEndsAt.getTime() - nowMs) / DAY_MS);
    return { allowed: true, state: 'trialing', trialDaysLeft, reason: 'trial_active' };
  }

  // (6) Trial that has run out.
  if (status === 'trial' && trialEndsAt.getTime() <= nowMs) {
    return { allowed: false, state: 'trial_expired', trialDaysLeft: 0, reason: 'trial_expired' };
  }

  // (7) Everything else: expired, cancelled, or active-with-a-past-period.
  return {
    allowed: false,
    state: 'expired',
    trialDaysLeft: null,
    reason: `not_entitled_status_${status}`,
  };
}
