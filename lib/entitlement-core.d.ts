/**
 * Type declarations for lib/entitlement-core.js (the shared plain-JS runtime
 * implementation consumed by both server.js and the TS layer). Keeping the
 * runtime in .js lets `node server.js` require it without transpilation; this
 * .d.ts gives the TS callers full types with zero drift.
 */

import type { ResolvedTier, TierLimits, UpgradePath } from './tiers-core';

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
   * Billing tier (2026-07-27, additive; extended 2026-08-17). Derived from
   * state + subscription.planId + subscription.grandfathered:
   * admin/allowlisted/free_access → 'pro'; a NEW trialing row → 'trial'; a
   * grandfathered row → its frozen pre-launch tier; else planIdToTier(planId).
   * `trial` here is the limited-trial tier (a ResolvedTier, not a paid Tier).
   */
  tier: ResolvedTier;
  /**
   * The limit set for `tier` — from GRANDFATHERED_TIER_LIMITS for a grandfathered
   * row, TIER_LIMITS otherwise. Additive.
   */
  limits: TierLimits;
  /**
   * Whether this decision used the frozen pre-launch (grandfathered) maps
   * (2026-08-17, additive). false for every post-launch row and every
   * privileged/no-subscription admit.
   */
  grandfathered: boolean;
  /**
   * Machine-readable upgrade signal for the client (2026-08-17, additive):
   * trial → activate-$5, plus → upgrade-$7, else null. Pixel reads this to pick
   * the right prompt when a cap is hit.
   */
  upgrade: UpgradePath;
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
  /**
   * Grandfathered flag (2026-08-17). true = a pre-launch row → frozen pre-launch
   * maps (prior caps + full trial). Optional/undefined → treated as a NEW row
   * (limited trial + new caps). Any path that reads tier/limits must select it.
   */
  grandfathered?: boolean | null;
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
  // Prisma client (or a mock exposing user.findUnique). `any` on the arg for
  // the same contravariance reason as isFreeAccessEmail above: a real
  // PrismaClient's findUnique takes a far stricter arg type than `unknown`, so
  // an `unknown`-arg slot would REJECT it. The browser proxy gate (proxy.ts)
  // passes the real client here.
  dbClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: { findUnique: (args: any) => Promise<unknown> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    freeAccessEmail?: { findUnique: (args: any) => Promise<unknown> };
  },
  userId: string,
  now?: Date,
): Promise<EntitlementResult>;

/**
 * True when an entitlement result means "we could not TELL" (a DB error or a
 * missing user row) rather than "genuinely not entitled". The browser proxy
 * gate fails OPEN on this; the relay / relay-ticket money chokepoint does NOT
 * (it stays fail-CLOSED on every allowed:false). A null/malformed result reads
 * as indeterminate so a shape bug can never bounce a paying user.
 */
export function isEntitlementIndeterminate(
  result: { reason?: unknown } | null | undefined,
): boolean;

export function resolveWhopCardState(action: string, data: unknown): boolean | null;

/**
 * Whether a Whop membership payload says the customer has cancelled while still
 * inside the period they paid for. `true` = churn scheduled, `false` = positively
 * not cancelled (uncancel), `null` = unknown — the caller MUST preserve the
 * stored value rather than clearing it. Reporting signal only; entitlement
 * ignores it (access runs to currentPeriodEnd either way).
 */
export function resolveWhopCancellation(data: unknown): boolean | null;

export const ENTITLEMENT_ALLOWLIST_FALLBACK: string;
