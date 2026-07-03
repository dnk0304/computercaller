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

interface CardCacheEntry {
  value: boolean | null;
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
 * Fetch card-on-file for a single membership. Returns:
 *   true | false — Whop answered
 *   null         — key not configured, non-2xx, timeout, or network error
 *                  (the caller MUST fall back to the stored value).
 * Results (including nulls from a non-2xx) are cached for CARD_CACHE_TTL_MS.
 */
export async function fetchCardOnFile(
  membershipId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean | null> {
  if (!isWhopKeyConfigured()) return null;

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
      cardCache.set(membershipId, { value: null, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
      return null;
    }

    const data: unknown = await res.json();
    const value = deriveCardOnFile(data);
    cardCache.set(membershipId, { value, expiresAt: Date.now() + CARD_CACHE_TTL_MS });
    return value;
  } catch {
    // Timeout (abort) or network error — do NOT cache, so a transient blip can
    // recover on the next refresh. Fall back to stored.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve card-on-file for many memberships with bounded concurrency. Returns a
 * Map membershipId → (true | false | null). Never throws; every per-id failure
 * degrades to null for that id. When no real key is configured, resolves every
 * id to null immediately without a single network call.
 */
export async function resolveCardStatuses(
  membershipIds: readonly string[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<Map<string, boolean | null>> {
  const result = new Map<string, boolean | null>();
  const unique = Array.from(new Set(membershipIds.filter((id) => id && id.length > 0)));

  if (unique.length === 0 || !isWhopKeyConfigured()) {
    for (const id of unique) result.set(id, null);
    return result;
  }

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, unique.length));
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const idx = cursor++;
      const id = unique[idx]!;
      result.set(id, await fetchCardOnFile(id));
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}
