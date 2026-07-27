/**
 * Type declarations for lib/entitlement-core.js (the shared plain-JS runtime
 * implementation consumed by both server.js and the TS layer). Keeping the
 * runtime in .js lets `node server.js` require it without transpilation; this
 * .d.ts gives the TS callers full types with zero drift.
 */

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
}

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
