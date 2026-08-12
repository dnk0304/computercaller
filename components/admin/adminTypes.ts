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
 *
 * `'free_access'` (2026-07-30, ADDITIVE): the user is comped through the
 * DB-backed free-access allowlist. The shared entitlement core admits them at
 * Pro tier (state `free_access`, `allowed:true`) ranked with admin/allowlist —
 * so the feed reports `state:'free_access'` and `tier:'pro'` for these rows.
 */
export type SubscriptionState =
  | 'trialing'
  | 'active'
  | 'trial_expired'
  | 'expired'
  | 'cancelled'
  | 'free_access'
  | 'none';

/** Resolved billing tier (mirrors the shared entitlement core). */
export type Tier = 'solo' | 'plus' | 'pro';

/** Human-readable plan label per tier, as sent by the feed. */
export type PlanLabel = 'Solo' | 'Plus' | 'Pro';

/** How the account authenticates. Drives the Auth-method badge. */
export type AuthProvider = 'email' | 'google' | 'both';

export interface AdminSubscription {
  status: SubscriptionStatus;
  state: SubscriptionState;
  /**
   * Resolved billing tier (2026-07-30, ADDITIVE). Comes straight off the shared
   * entitlement core — for a `free_access` user this is `'pro'`.
   */
  tier: Tier;
  /** Human plan label for the tier above (Solo/Plus/Pro). Display sugar. */
  planLabel: PlanLabel;
  trialEndsAt: string | null;
  /** Whole days remaining in the trial; only meaningful while `state === 'trialing'`. */
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  /** ISO timestamp the user first converted to paying, else `null`. */
  convertedAt: string | null;
  /**
   * When we FIRST learned this subscription was cancelled — the moment the
   * customer decided to leave, not the moment access lapsed. Stamped once.
   */
  canceledAt: string | null;
  /** `true`/`false` known, `null` = unknown (render as "—"). */
  paymentMethodAttached: boolean | null;
  whopMembershipId: string | null;
  /**
   * The customer has CANCELLED but is still inside the period they paid for
   * (2026-08-11, ADDITIVE, optional — an omitted field means "not cancelled").
   *
   * Whop keeps a mid-period cancellation VALID and only flips
   * `cancel_at_period_end`; no `membership.went_invalid` fires until the period
   * actually lapses. So `state` is still `'active'` and `paymentMethodAttached`
   * is still true for these rows — this flag is the ONLY churn signal, and
   * `currentPeriodEnd` is the date access ends.
   *
   * Commercially distinct from `state === 'expired' | 'cancelled'`: those
   * customers are already gone. These are still paying customers today, leaving
   * on a known date. The table must not render them the same.
   */
  cancelAtPeriodEnd?: boolean;
}

export interface AdminCustomer {
  id: string;
  email: string;
  emailVerified: boolean;
  authProvider: AuthProvider;
  registeredAt: string;
  /**
   * Top-level free-access flag (2026-07-30, ADDITIVE): is this user's email in
   * the `FreeAccessEmail` allowlist. Drives the "Free access" plan badge and the
   * grant/revoke control state on the row. When `true`, `subscription.state` is
   * `'free_access'` and `subscription.tier` is `'pro'`.
   */
  freeAccess: boolean;
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

// ---------------------------------------------------------------------------
// Free-access allowlist manager (2026-07-30) — the contract for
// `GET/POST/DELETE /api/admin/free-access`. This is the "comp any email" panel:
// an email can be granted free access whether or not an account exists yet.
// ---------------------------------------------------------------------------

/** One row of the free-access allowlist. */
export interface FreeAccessEntry {
  id: string;
  /** Stored lowercased. */
  email: string;
  /** Optional reason captured at grant time ("beta tester", "friend"). */
  note: string | null;
  /** Admin email that granted it — the audit trail. */
  grantedBy: string;
  /** ISO timestamp the grant was created. */
  grantedAt: string;
  /** Whether this email currently maps to a registered account. */
  registered: boolean;
}

/** `GET /api/admin/free-access` response. */
export interface FreeAccessListResponse {
  entries: FreeAccessEntry[];
  meta: { total: number };
}

/** `POST /api/admin/free-access` response — the upserted grant. */
export interface FreeAccessGrantResponse {
  entry: Omit<FreeAccessEntry, 'registered'>;
}

/** `DELETE /api/admin/free-access` response. */
export interface FreeAccessRevokeResponse {
  revoked: boolean;
  email: string;
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Guides CMS (2026-08-12) — the contract for `/api/admin/articles/*`, mirrored
// verbatim from `lib/admin-articles.ts` (toListRow / toFullRecord). The list
// feed deliberately omits `body` so the index stays light; the editor fetches
// the full record by id.
// ---------------------------------------------------------------------------

/** `status` is a free string column server-side; 'published' is the only live value. */
export type ArticleStatus = 'draft' | 'published';

/** One row of `GET /api/admin/articles`. No `body`. */
export interface ArticleListRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: ArticleStatus;
  /** ISO timestamp, or null while the article has never been published. */
  publishedAt: string | null;
  updatedAt: string;
  /** Admin email that last wrote to the row — the audit trail. */
  updatedBy: string | null;
}

/** The full record: detail GET *and* the response to every mutation. */
export interface ArticleRecord extends ArticleListRow {
  body: string;
  keywords: string[];
  createdAt: string;
}

/** `GET /api/admin/articles` */
export interface ArticleListResponse {
  articles: ArticleListRow[];
}

/** Every single-article endpoint answers with the full record under `article`. */
export interface ArticleResponse {
  article: ArticleRecord;
}

/** The writable subset, as the create/update endpoints accept it. */
export interface ArticleDraftInput {
  slug: string;
  title: string;
  description: string;
  body: string;
  keywords: string[];
}
