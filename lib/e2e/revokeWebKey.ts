/**
 * lib/e2e/revokeWebKey.ts — the web client for `POST /api/devicekeys/revoke`
 * (E2E-P2.3 (c), GATE1 Addendum A5 F1 / MUST M-A5-1 (a)).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * P2.2 built the local leg of M-A5-1 (a) — `revokeLocalPair` drops the SK — and
 * the route has existed since P1. Nothing in the web bundle ever called it, so
 * the server-side half of "the revoking side tears itself down" was dead code:
 * signing out left this browser's DeviceKey row LIVE, and a live row is exactly
 * what the OTHER side's M-A5-1 (b) re-check reads as healthy.
 *
 * ── THE ONE SECURITY PROPERTY ──────────────────────────────────────────────
 * The payload is `{ id }` and the id is ALWAYS this browser's own row. Two
 * independent reasons, because one would be a promise and two are a design:
 *
 *   1. The id is only ever obtained from a response to a request this browser
 *      made — the `register` echo, or a `list` row whose `publicKey` equals the
 *      public half of the key in THIS profile's IndexedDB. There is no input
 *      through which another row's id can reach {@link revokeOwnWebDeviceKey}.
 *   2. The route resolves `(id AND caller.userId)` in one query, so even a
 *      wrong id cannot revoke somebody else's row — it 404s.
 *
 * The PHONE's row is deliberately NOT revocable from here: it is not the
 * caller's own device, the route 404s by design (§ the route header), and the
 * phone tearing itself down is P4.x.
 *
 * ── FAIL-CLOSED LOCALLY, BEST-EFFORT REMOTELY ──────────────────────────────
 * Every function here resolves; none of them throw. A revoke that cannot be
 * delivered (offline, 500, a session that already expired) must never block the
 * sign-out the user asked for — the SK is already gone locally by the time this
 * runs, and THAT is the control. See lib/e2e/signOutEverywhere.ts for the
 * ordering that makes this safe to say.
 */

import { loadWebDeviceKey, type WebDeviceKey, type WebKeyOptions } from './webKey';
import { forgetWebDeviceKeyId, peekWebDeviceKeyId } from './webKeyId';

export { forgetWebDeviceKeyId, peekWebDeviceKeyId, rememberWebDeviceKeyId } from './webKeyId';

/** The subset of `/api/devicekeys/list`'s rows this module reads. */
interface DeviceKeyRowish {
  id?: unknown;
  kind?: unknown;
  publicKey?: unknown;
  revokedAt?: unknown;
}

export type RevokeFailureReason =
  /** No key in this profile and none registered this session — nothing of ours exists to revoke. */
  | 'no-own-key'
  /** We have a key, but the server's ledger has no live row for it (already revoked, or wiped). */
  | 'no-live-row'
  /** The list lookup could not be completed. NOT a pass — it is "we could not tell". */
  | 'lookup-failed'
  /** The revoke POST itself failed or was refused. */
  | 'revoke-failed';

export interface RevokeOwnKeyResult {
  ok: boolean;
  /** The row id acted on. Present only when one was resolved. */
  id?: string;
  /** The route's own idempotency signal: revoking a revoked row is SUCCESS. */
  alreadyRevoked?: boolean;
  reason?: RevokeFailureReason;
  status?: number;
  detail?: string;
}

export interface RevokeWebKeyOptions extends WebKeyOptions {
  /** Injected for the node suite; defaults to the global. */
  fetch?: typeof fetch;
  /** Injected for the node suite; defaults to {@link loadWebDeviceKey}. */
  loadKey?: (opts: WebKeyOptions) => Promise<WebDeviceKey | null>;
}

// ---------------------------------------------------------------------------
// the remembered id
// ---------------------------------------------------------------------------
//
// Lives in lib/e2e/webKeyId.ts, a leaf module, because webKey.ts WRITES the
// cache and this file READS it — keeping it here would make those two modules
// an import cycle. Re-exported above so callers have one door.

// ---------------------------------------------------------------------------
// id resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the id of THIS browser's live `kind:'web'` DeviceKey row, or null.
 *
 * Order: the remembered echo first (free), then a `list` lookup matched on the
 * public key held in this profile. The public-key match is what makes the
 * lookup exact — a user with five browsers has five `kind:'web'` rows, and
 * "the web row" would be the wrong one four times out of five.
 */
export async function resolveOwnWebDeviceKeyId(
  opts: RevokeWebKeyOptions = {},
): Promise<{ id: string | null; reason?: RevokeFailureReason }> {
  const remembered = peekWebDeviceKeyId();
  if (remembered) return { id: remembered };

  const load = opts.loadKey ?? loadWebDeviceKey;
  let key: WebDeviceKey | null;
  try {
    key = await load(opts);
  } catch {
    // A key we cannot read is a key we cannot identify. Not a pass.
    return { id: null, reason: 'no-own-key' };
  }
  if (!key) return { id: null, reason: 'no-own-key' };

  const doFetch = opts.fetch ?? fetch;
  let rows: DeviceKeyRowish[];
  try {
    const res = await doFetch('/api/devicekeys/list?includeRevoked=0', {
      credentials: 'same-origin',
    });
    if (!res.ok) return { id: null, reason: 'lookup-failed' };
    const data = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(data?.keys)) return { id: null, reason: 'lookup-failed' };
    rows = data.keys as DeviceKeyRowish[];
  } catch {
    return { id: null, reason: 'lookup-failed' };
  }

  const mine = rows.find(
    (r) =>
      r
      && r.kind === 'web'
      && typeof r.publicKey === 'string'
      && r.publicKey === key!.pubB64Url
      && (r.revokedAt === null || r.revokedAt === undefined),
  );
  const id = mine && typeof mine.id === 'string' && mine.id.length > 0 ? mine.id : null;
  return id ? { id } : { id: null, reason: 'no-live-row' };
}

// ---------------------------------------------------------------------------
// the revoke
// ---------------------------------------------------------------------------

/**
 * Revoke this browser's own DeviceKey row. Resolves always; never throws.
 *
 * Same-origin with the session cookie: `resolveCaller` reads the session and
 * the route then runs `requireSameOrigin`, so `credentials: 'same-origin'` is
 * the whole of the CSRF story — there is no token to attach.
 *
 * MUST be issued while the session cookie is still live, i.e. BEFORE the
 * `POST /api/auth/logout` that ends it. Afterwards it is a guaranteed 401.
 */
export async function revokeOwnWebDeviceKey(
  opts: RevokeWebKeyOptions = {},
): Promise<RevokeOwnKeyResult> {
  const resolved = await resolveOwnWebDeviceKeyId(opts);
  if (!resolved.id) return { ok: false, reason: resolved.reason ?? 'no-own-key' };

  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch('/api/devicekeys/revoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // The ENTIRE payload. No userId, no kind, no "all" flag — the route
      // scopes by the session and there is nothing here to widen.
      body: JSON.stringify({ id: resolved.id }),
    });
    if (!res.ok) {
      return { ok: false, id: resolved.id, reason: 'revoke-failed', status: res.status };
    }
    const data = (await res.json()) as { alreadyRevoked?: unknown };
    // The remembered id names a row that is now revoked; keeping it would make
    // a later revoke on the same page a no-op against a stale id.
    forgetWebDeviceKeyId();
    return { ok: true, id: resolved.id, alreadyRevoked: data?.alreadyRevoked === true };
  } catch (e) {
    return {
      ok: false,
      id: resolved.id,
      reason: 'revoke-failed',
      detail: (e as Error)?.message,
    };
  }
}
