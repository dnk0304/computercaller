/**
 * lib/partnerKeys.ts — per-company (partner) API-key format, hashing, and
 * constant-time verification for the SDK-PKG-2 Phase-1 auth path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (feat/partner-api-keys, 2026-08-25)
 * ─────────────────────────────────────────────────────────────────────────────
 * The server-to-server relay-ticket mint (app/api/auth/relay-ticket/m2m) used to
 * authenticate ONE shared env secret (CC_M2M_MINT_KEY) held by our own dnk-crm.
 * To sell ComputerCaller as an SDK to outside companies, each company (Partner)
 * needs its OWN credential, with its OWN scopes and rate limit, issuable and
 * revocable from the DB without redeploying. This module owns the credential
 * mechanics; the route wires them in and KEEPS the legacy shared key working as
 * a deprecated fallback.
 *
 * KEY FORMAT handed to a partner (shown ONCE at issuance, never stored):
 *
 *     ccp_live_<keyId>.<secret>
 *              └─ 12 hex ─┘ └─ base64url(32 random bytes) ─┘
 *
 *   • keyId  — public, non-secret. Indexed lookup handle + display prefix. Hex,
 *              so it never contains the '.' separator.
 *   • secret — 256 bits of entropy. '.' is NOT in the base64url alphabet
 *              (A-Za-z0-9-_), so the split point is unambiguous.
 *
 * AT REST we persist only keyId (plain) and SHA-256(secret) (hex). The plaintext
 * secret never touches the DB or a log line.
 *
 * WHY SHA-256 (not argon2/bcrypt): the secret is a HIGH-ENTROPY random value, not
 * a human password. There is no dictionary to grind, so a slow KDF buys no extra
 * resistance — it would only tax every single mint with argon2 cost and hand an
 * attacker a CPU-DoS amplifier. A fast cryptographic hash + constant-time compare
 * is the correct tool here (same posture as the existing shared-key compare).
 *
 * REVERSIBILITY: additive module. Nothing here mutates existing behavior; the
 * route decides when to call it.
 */

import crypto from 'node:crypto';

/** Live-key marker. A '_test_' variant can be added later without schema change. */
export const PARTNER_KEY_PREFIX = 'ccp_live_';

/** Phase-1 scope vocabulary. Only 'call' is honoured by the mint today. */
export type PartnerScope = 'call' | 'presence' | 'read_logs' | 'sms';

/** Default per-partner-key rate limit (mints/min) when the row leaves it NULL. */
export const PARTNER_DEFAULT_RATE_LIMIT_PER_MIN = 120;

/**
 * A fixed dummy digest compared against on the not-found path so a lookup miss
 * burns the same timingSafeEqual work as a real (but wrong-secret) key. Keeps the
 * "does this keyId exist?" question out of reach of a timing oracle.
 */
const DUMMY_DIGEST = crypto.createHash('sha256').update('dummy', 'utf8').digest('hex');

/** SHA-256(secret) as lowercase hex. The only representation stored at rest. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time compare of two hex digests. Both are hashed to a fixed 32-byte
 * buffer first, so length never leaks and timingSafeEqual never throws on a
 * mismatched-length input. Returns false on any empty input.
 */
export function constantTimeHexEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Mint fresh key material for issuance. Returns the public keyId, the plaintext
 * secret (to show ONCE), the full presentable token, and the hash to store.
 */
export function generatePartnerKey(): {
  keyId: string;
  secret: string;
  token: string;
  hashedSecret: string;
} {
  const keyId = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  const secret = crypto.randomBytes(32).toString('base64url'); // 256-bit secret
  const token = `${PARTNER_KEY_PREFIX}${keyId}.${secret}`;
  return { keyId, secret, token, hashedSecret: hashSecret(secret) };
}

/**
 * Does a presented bearer value even look like a partner key? Used by the route
 * to decide "partner path vs legacy shared-key path" WITHOUT leaking which one
 * failed. Cheap structural check only — no DB, no secret compare.
 */
export function looksLikePartnerKey(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(PARTNER_KEY_PREFIX);
}

/**
 * Parse `ccp_live_<keyId>.<secret>` into its parts. Returns null on any
 * structural problem (wrong prefix, missing separator, empty part). Never throws.
 */
export function parsePartnerKey(token: string | null | undefined): { keyId: string; secret: string } | null {
  if (!looksLikePartnerKey(token)) return null;
  const rest = (token as string).slice(PARTNER_KEY_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const keyId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

/** The minimal Prisma surface this module needs — keeps it test-mockable. */
export interface PartnerKeyDbClient {
  partnerApiKey: {
    findUnique(args: {
      where: { keyId: string };
      select?: unknown;
    }): Promise<{
      id: string;
      partnerId: string;
      keyId: string;
      hashedSecret: string;
      scopes: string[];
      status: string;
      rateLimitPerMin: number | null;
      partner: { id: string; slug: string; status: string } | null;
    } | null>;
    update(args: { where: { id: string }; data: { lastUsedAt: Date } }): Promise<unknown>;
  };
}

export type PartnerAuthResult =
  | {
      ok: true;
      partnerId: string;
      partnerSlug: string;
      apiKeyId: string;
      scopes: string[];
      rateLimitPerMin: number;
    }
  | { ok: false; reason: 'not_partner_key' | 'invalid' | 'revoked' | 'suspended' };

/**
 * Resolve + verify a presented partner key against the DB.
 *
 * Fail-CLOSED at every step. Ordering matters for the timing posture:
 *   1. Structural parse (no DB).
 *   2. Lookup by keyId (public handle).
 *   3. Constant-time secret compare — ALWAYS runs, even on a lookup miss (dummy
 *      digest), so "keyId exists?" is not answerable by timing.
 *   4. Only AFTER a valid secret do we branch on key/partner status. A revoked
 *      key or suspended partner returns a distinct reason to the CALLER of this
 *      function (the route collapses them all to one opaque 401 — see the route).
 *
 * NOTE the deliberate asymmetry: secret validity is checked in constant time
 * BEFORE status, so an attacker with a WRONG secret can never distinguish
 * revoked/suspended/active — they all read as `invalid`. Only a holder of the
 * real secret ever sees `revoked`/`suspended`, which is fine (they already had
 * the secret).
 */
export async function resolvePartnerKey(
  db: PartnerKeyDbClient,
  token: string | null | undefined,
): Promise<PartnerAuthResult> {
  const parsed = parsePartnerKey(token);
  if (!parsed) return { ok: false, reason: 'not_partner_key' };

  let row: Awaited<ReturnType<PartnerKeyDbClient['partnerApiKey']['findUnique']>> = null;
  try {
    row = await db.partnerApiKey.findUnique({
      where: { keyId: parsed.keyId },
      select: {
        id: true,
        partnerId: true,
        keyId: true,
        hashedSecret: true,
        scopes: true,
        status: true,
        rateLimitPerMin: true,
        partner: { select: { id: true, slug: true, status: true } },
      },
    });
  } catch {
    // DB error → fail closed, and still burn a compare below to keep timing flat.
    row = null;
  }

  const expectedHash = row ? row.hashedSecret : DUMMY_DIGEST;
  const presentedHash = hashSecret(parsed.secret);
  const secretOk = constantTimeHexEqual(presentedHash, expectedHash);

  // No row, or wrong secret → single opaque `invalid`. (Row-null still ran the
  // compare above against the dummy digest, so the two paths are timing-flat.)
  if (!row || !secretOk) return { ok: false, reason: 'invalid' };

  if (row.status !== 'active' || !row.partner) return { ok: false, reason: 'revoked' };
  if (row.partner.status !== 'active') return { ok: false, reason: 'suspended' };

  return {
    ok: true,
    partnerId: row.partnerId,
    partnerSlug: row.partner.slug,
    apiKeyId: row.id,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    rateLimitPerMin:
      typeof row.rateLimitPerMin === 'number' && row.rateLimitPerMin > 0
        ? row.rateLimitPerMin
        : PARTNER_DEFAULT_RATE_LIMIT_PER_MIN,
  };
}

/** Server-side scope check. Deny by default: an absent/empty scope list fails. */
export function hasScope(scopes: string[] | null | undefined, required: PartnerScope): boolean {
  return Array.isArray(scopes) && scopes.includes(required);
}

/**
 * Best-effort lastUsedAt bump. Fire-and-forget: a failure here must NEVER fail a
 * mint (the key was already validated). Swallows errors by design.
 */
export async function touchPartnerKeyLastUsed(db: PartnerKeyDbClient, apiKeyId: string): Promise<void> {
  try {
    await db.partnerApiKey.update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } });
  } catch {
    /* non-fatal */
  }
}
