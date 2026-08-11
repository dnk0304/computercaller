/**
 * lib/whop.ts — minimal Whop admin (company) API client used by the customer
 * dashboard to surface LIVE card-on-file status (dispatch
 * forge/trial7-caps-whopcard, 2026-07-03).
 *
 * Design constraints (from the dispatch brief):
 *   - The admin customers route lists ALL users. We must NOT fire one unbounded
 *     Whop call per row — bounded concurrency + per-call timeout + graceful
 *     degradation to the STORED value on any failure. The dashboard renders fast
 *     even if Whop is slow or down.
 *   - Short in-memory cache (60s) keyed by membershipId so repeated admin
 *     refreshes don't hammer Whop.
 *   - Only rows WITH a whopMembershipId ever hit the network.
 *
 * CREDENTIAL NOTE: the real admin key must be in process.env.WHOP_API_KEY. When
 * it is unset or the dev placeholder ("dev-placeholder"), we skip the live fetch
 * entirely and return null so the caller falls back to the stored boolean. No
 * key is ever hardcoded.
 */

// v5 company API. Base per Whop docs; membership retrieve is
// GET /api/v5/company/memberships/{id}.
const WHOP_API_BASE = 'https://api.whop.com/api/v5';

const CARD_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CONCURRENCY = 6;

/**
 * What one live membership read tells us. Every field independently degrades to
 * null when Whop doesn't answer or doesn't carry it — the caller falls back to
 * the value we stored from the webhook.
 */
export interface WhopMembershipState {
  /** Card on file. */
  cardOnFile: boolean | null;
  /**
   * The customer has cancelled and the membership runs out at
   * `currentPeriodEnd` (2026-08-11). Whop keeps a mid-period cancellation
   * VALID, so this is the only way to see it live.
   */
  cancelAtPeriodEnd: boolean | null;
  /** ISO end of the current paid period, i.e. the next-payment / access-until date. */
  currentPeriodEnd: string | null;
}

const EMPTY_STATE: WhopMembershipState = {
  cardOnFile: null,
  cancelAtPeriodEnd: null,
  currentPeriodEnd: null,
};

interface CardCacheEntry {
  value: WhopMembershipState;
  expiresAt: number;
}

// Module-scope cache. In Next's server runtime a warm invocation reuses module
// state, so this coalesces repeated dashboard refreshes within the TTL window.
const cardCache = new Map<string, CardCacheEntry>();

/** True only when a REAL admin key is configured (not unset / not the dev stub). */
export function isWhopKeyConfigured(): boolean {
  const key = process.env.WHOP_API_KEY?.trim();
  return !!key && key !== 'dev-placeholder';
}

/**
 * Derive a card-on-file boolean from a Whop membership payload. Whop's v5
 * membership object does NOT expose a single documented "card on file" flag, so
 * we read defensively, most-explicit signal first:
 *   1) an explicit boolean field if Whop ever returns one;
 *   2) a populated payment_method / payment_processor → a saved card exists;
 *   3) `valid` — on this product every plan trial is card-required up front
 *      (Whop platform default + Buyer Terms), so a valid membership has a card;
 *   4) status as a last resort.
 * Returns null when nothing usable is present (caller falls back to stored).
 */
export function deriveCardOnFile(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  // Some Whop responses wrap the object in { data: {...} }.
  const root = payload as Record<string, unknown>;
  const m = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;

  for (const field of ['has_payment_method', 'payment_method_attached', 'card_on_file']) {
    if (typeof m[field] === 'boolean') return m[field] as boolean;
  }

  const paymentMethod = m.payment_method;
  if (typeof paymentMethod === 'string' && paymentMethod.length > 0) return true;
  if (paymentMethod && typeof paymentMethod === 'object') return true;

  const processor = m.payment_processor;
  if (typeof processor === 'string' && processor.length > 0) return true;

  if (typeof m.valid === 'boolean') return m.valid as boolean;

  if (typeof m.status === 'string') {
    return ['active', 'trialing', 'completed', 'past_due'].includes(m.status as string);
  }

  return null;
}

/**
 * Unwrap the membership object from a Whop response (`{data:{…}}` or bare).
 */
function membershipRoot(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  return (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
}

/**
 * Read the scheduled-cancellation flag off a live membership payload.
 * `cancel_at_period_end` is a documented boolean on BOTH the legacy v5 company
 * membership object and the modern v1 one, so this is version-agnostic.
 * Returns null when absent (caller keeps the stored value).
 */
export function deriveCancelAtPeriodEnd(payload: unknown): boolean | null {
  const m = membershipRoot(payload);
  if (!m) return null;
  if (typeof m.cancel_at_period_end === 'boolean') return m.cancel_at_period_end;
  // Corroborating status. Only ever used to assert TRUE — 'active' is exactly
  // what a mid-period cancellation still reads as, so it proves nothing.
  if (typeof m.status === 'string' && (m.status === 'canceling' || m.status === 'canceled')) {
    return true;
  }
  return null;
}

/**
 * Read the current period end (next payment / access-until) off a live
 * membership payload, normalised to ISO. Whop expresses it as
 * `renewal_period_end` / `expires_at` (v5, unix SECONDS) or
 * `current_period_end` (v1, ISO 8601) — and Whop's own spec contradicts itself
 * on the unit, so sniff the runtime type rather than trusting the docs.
 */
export function deriveCurrentPeriodEnd(payload: unknown): string | null {
  const m = membershipRoot(payload);
  if (!m) return null;
  for (const field of ['current_period_end', 'renewal_period_end', 'expires_at']) {
    const v = m[field];
    let d: Date | null = null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      d = new Date(v > 1e12 ? v : v * 1000);
    } else if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      d = Number.isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000) : new Date(v);
    }
    if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Fetch the live state for a single membership — card on file, scheduled
 * cancellation, and current period end — in ONE request. Every field is
 * `null` when the key isn't configured, the call 404s/times out, or Whop
 * simply doesn't carry it; the caller MUST fall back to the stored value.
 * Results (including a miss) are cached for CARD_CACHE_TTL_MS.
 */
export async function fetchMembershipState(
  membershipId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WhopMembershipState> {
  if (!isWhopKeyConfigured()) return EMPTY_STATE;

  const cached = cardCache.get(membershipId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const key = process.env.WHOP_API_KEY!.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${WHOP_API_BASE}/company/memberships/${encodeURIComponent(membershipId)}`,
      {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      },
    );

    if (!res.ok) {
      // Cache the miss briefly too — avoids hammering Whop with a bad id/key on
      // every refresh. Caller degrades to stored.
      cardCache.set(membershipId, { value: EMPTY_STATE, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
      return EMPTY_STATE;
    }

    const data: unknown = await res.json();
    const value: WhopMembershipState = {
      cardOnFile: deriveCardOnFile(data),
      cancelAtPeriodEnd: deriveCancelAtPeriodEnd(data),
      currentPeriodEnd: deriveCurrentPeriodEnd(data),
    };
    cardCache.set(membershipId, { value, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
    return value;
  } catch {
    // Timeout (abort) or network error — do NOT cache, so a transient blip can
    // recover on the next refresh. Fall back to stored.
    return EMPTY_STATE;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve live state for many memberships with bounded concurrency. Returns a
 * Map membershipId → WhopMembershipState. Never throws; every per-id failure
 * degrades to the all-null state for that id. When no real key is configured,
 * resolves every id immediately without a single network call.
 *
 * Cost note: this is the SAME one-request-per-membership loop that already
 * powered the card column — reading the cancellation + period-end off the same
 * response adds zero network calls.
 */
export async function resolveMembershipStates(
  membershipIds: readonly string[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<Map<string, WhopMembershipState>> {
  const result = new Map<string, WhopMembershipState>();
  const unique = Array.from(new Set(membershipIds.filter((id) => id && id.length > 0)));

  if (unique.length === 0 || !isWhopKeyConfigured()) {
    for (const id of unique) result.set(id, EMPTY_STATE);
    return result;
  }

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, unique.length));
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const idx = cursor++;
      const id = unique[idx]!;
      result.set(id, await fetchMembershipState(id));
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}
