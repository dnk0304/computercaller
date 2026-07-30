/**
 * Type declarations for lib/entitlement-core.js (the shared plain-JS runtime
 * implementation consumed by both server.js and the TS layer). Keeping the
 * runtime in .js lets `node server.js` require it without transpilation; this
 * .d.ts gives the TS callers full types with zero drift.
 */

import type { Tier, TierLimits } from './tiers-core';

export type EntitlementState =
  | 'admin'
  | 'allowlisted'
  | 'free_access'
  | 'trialing'
  | 'active'
  | 'trial_expired'
  | 'expired'
  | 'none'
  | 'error';

export interface EntitlementResult {
  allowed: boolean;
  state: EntitlementState;
  /** Whole days remaining in a live trial (ceil). null unless state==='trialing'. */
  trialDaysLeft: number | null;
  /** Machine-readable reason for the decision — logged, never shown to the user. */
  reason: string;
  /**
   * Billing tier (2026-07-27, additive). Derived from state + subscription.planId:
   * admin/allowlisted → 'pro'; else planIdToTier(planId) (unknown/null → 'solo').
   */
  tier: Tier;
  /** The limit set for `tier` (TIER_LIMITS[tier]). Additive. */
  limits: TierLimits;
}

export interface EntitlementSubscriptionInput {
  status: string;
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
  /**
   * Whop plan id → tier (2026-07-27). Optional: callers that don't select it
   * resolve to the 'solo' default. Any path that ENFORCES a tier must select it.
   */
  planId?: string | null;
}

export interface EntitlementInput {
  isAdmin: boolean;
  email: string;
  /**
   * DB-backed free-access grant, resolved by the caller (relay/browser/admin
   * feed) via isFreeAccessEmail. Optional & defaults to false — a true value is
   * a privileged admit → 'free_access' state → Pro tier, ranked with
   * admin/allowlist. Omitting it preserves the exact prior decision.
   */
  freeAccess?: boolean;
  subscription: EntitlementSubscriptionInput | null;
}

export function isEntitlementAllowed(email: string | null | undefined): boolean;

/**
 * The single admin authority: isAdmin===true OR email === the hardcoded admin
 * email (case-insensitive, trimmed). Fail-safe for Dennis, fail-closed (→false
 * on any error/malformed input) for everyone else. Gates every /api/admin/*
 * route + the admin page.
 */
export function isAdminUser(account: {
  isAdmin?: unknown;
  email?: unknown;
}): boolean;

/**
 * Is this email in the DB-backed FreeAccessEmail allowlist? The ONE query all
 * gates share. Fail-closed (→false) on null/blank email, a client missing the
 * model, or any DB error.
 */
export function isFreeAccessEmail(
  // Loosely typed so the real PrismaClient (whose findUnique arg type is far
  // stricter than `unknown`) is assignable — function-arg contravariance means
  // an `unknown`-arg slot would reject the Prisma method. Only server.js and a
  // couple of TS routes call this; the runtime guards a missing model itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbClient: { freeAccessEmail?: { findUnique: (args: any) => Promise<unknown> } },
  email: string | null | undefined,
): Promise<boolean>;

export const ADMIN_EMAIL_FALLBACK: string;

export function evaluateEntitlement(
  input: EntitlementInput,
  now?: Date,
): EntitlementResult;

export function evaluateUserEntitlement(
  // Prisma client (or a mock exposing user.findUnique). Typed loosely because
  // only server.js (plain JS) calls this; TS callers use evaluateEntitlement.
  dbClient: { user: { findUnique: (args: unknown) => Promise<unknown> } },
  userId: string,
  now?: Date,
): Promise<EntitlementResult>;

export function resolveWhopCardState(action: string, data: unknown): boolean | null;

export const ENTITLEMENT_ALLOWLIST_FALLBACK: string;
