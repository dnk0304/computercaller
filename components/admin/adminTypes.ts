/**
 * Admin customer-tracking types — the FROZEN contract for
 * `GET /api/admin/customers`.
 *
 * These mirror Forge's server response EXACTLY (no renamed keys) so the
 * mock→live swap is zero-friction: the same `AdminCustomersResponse` shape
 * flows from the mock fixture today and from `fetch('/api/admin/customers')`
 * once Forge's endpoint lands.
 *
 * Two nullability rules from the contract worth calling out:
 *   1. `subscription` may itself be `null` OR an object whose `status` is null
 *      and `state` is `'none'`. Consumers must handle BOTH — the presentation
 *      layer normalises via `resolveState()` in customerRows.ts.
 *   2. `paymentMethodAttached` is `boolean | null` — `null` means "unknown"
 *      (renders as "—", not "no").
 */

/** Coarse subscription status. `null` when the user never started a trial. */
export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled' | null;

/**
 * Fine-grained lifecycle state — the field the UI actually keys off for the
 * trial-status pill and the "paying customer" column. Kept as a string union
 * with an explicit `'none'` sentinel so a `null` subscription still resolves
 * to a concrete, styleable value.
 */
export type SubscriptionState =
  | 'trialing'
  | 'active'
  | 'trial_expired'
  | 'expired'
  | 'cancelled'
  | 'none';

/** How the account authenticates. Drives the Auth-method badge. */
export type AuthProvider = 'email' | 'google' | 'both';

export interface AdminSubscription {
  status: SubscriptionStatus;
  state: SubscriptionState;
  trialEndsAt: string | null;
  /** Whole days remaining in the trial; only meaningful while `state === 'trialing'`. */
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  /** ISO timestamp the user first converted to paying, else `null`. */
  convertedAt: string | null;
  canceledAt: string | null;
  /** `true`/`false` known, `null` = unknown (render as "—"). */
  paymentMethodAttached: boolean | null;
  whopMembershipId: string | null;
}

export interface AdminCustomer {
  id: string;
  email: string;
  emailVerified: boolean;
  authProvider: AuthProvider;
  registeredAt: string;
  /** May be `null` entirely — see file header. */
  subscription: AdminSubscription | null;
  lastActiveAt: string | null;
  signupIp: string | null;
  lastLoginIp: string | null;
  /** Number of accounts sharing this account's signup IP. */
  sameIpAccountCount: number;
  /** Server-computed: `sameIpAccountCount >= meta.sameIpThreshold`. */
  flagged: boolean;
}

export interface AdminCustomersMeta {
  total: number;
  /** Accounts-per-IP count at/above which a row is flagged (e.g. 3). */
  sameIpThreshold: number;
  generatedAt: string;
}

export interface AdminCustomersResponse {
  customers: AdminCustomer[];
  meta: AdminCustomersMeta;
}
