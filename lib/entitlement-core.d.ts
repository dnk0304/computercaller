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
  subscription: EntitlementSubscriptionInput | null;
}

export function isEntitlementAllowed(email: string | null | undefined): boolean;

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
