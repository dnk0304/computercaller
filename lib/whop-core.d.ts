/**
 * Type surface for lib/whop-core.js (plain CJS, per repo convention).
 *
 * ⚠️ Handwritten declarations do not prove the runtime exports exist — `tsc`
 * happily type-checks a symbol that `module.exports` never lists. Every symbol
 * declared here is asserted to exist AND to be callable in
 * tests/whop-reconcile.test.js, which is what actually closes that gap.
 */

/** The Subscription column values one Whop membership implies. */
export interface WhopSubscriptionFields {
  whopMembershipId: string | null;
  /** 'active' | 'cancelled' | 'expired' */
  status: string;
  planId: string | null;
  /** undefined = membership carried no period end; do NOT clobber the stored value. */
  currentPeriodEnd: Date | undefined;
  cancelAtPeriodEnd: boolean;
  /** null = no cancellation known; never overwrite a stored date with it. */
  canceledAt: Date | null;
  paymentMethodAttached: boolean;
  /** null unless this membership is active; only ever fills an empty column. */
  convertedAt: Date | null;
  trialEndsAt: Date;
}

export function toEpochMs(value: unknown): number | null;
export function extractWhopUserId(payload: unknown): string | null;
export function extractPayloadEmail(payload: unknown): string | null;
export function extractPlanId(payload: unknown): string | null;
export function extractMembershipId(payload: unknown): string | null;
export function membershipPeriodEndMs(membership: unknown): number | null;
export function membershipCreatedAtMs(membership: unknown): number | null;
export function membershipIsValid(membership: unknown): boolean;
export function membershipCancelAtPeriodEnd(membership: unknown): boolean;
export function membershipCancellationIntended(membership: unknown): boolean;
export function pickAuthoritativeMembership<T>(memberships: readonly T[]): T | null;
export function membershipToSubscriptionFields(
  membership: unknown,
  now?: Date,
): WhopSubscriptionFields | null;
