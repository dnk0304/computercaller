/**
 * POST /api/auth/relay-ticket/m2m — SERVER-TO-SERVER (machine-to-machine)
 * variant of the browser relay-ticket mint.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (CC-CHANGE-1, 2026-08-03)
 * ─────────────────────────────────────────────────────────────────────────
 * The browser mint (../route.ts) is gated on a browser session: an auth_token
 * cookie, a same-origin CSRF check, a session-version check, and an idle-token
 * check. A trusted BACKEND (the dnk-crm server) that wants to obtain a real
 * per-rep relay-ticket has none of those — it is not a browser, holds no
 * cookie, and cannot pass CSRF. This route is the server-caller equivalent:
 * it authenticates the CALLER with a shared server-to-server API key instead
 * of a user session, and mints the SAME 30 s relay-ticket the browser mints.
 *
 * WHAT IS AND IS NOT SKIPPED (deliberate):
 *   - SKIPPED: cookie / CSRF (requireSameOrigin) / session-version / idle-token.
 *     These are BROWSER-session gates that do not apply to a server caller.
 *   - KEPT (non-negotiable): the entitlement gate. A non-entitled ccUserId
 *     mints NOTHING (403), exactly like the browser path. The M2M key
 *     authenticates the trusted server; it does NOT bypass entitlement. This
 *     is enforced via evaluateUserEntitlement(db, ccUserId), which does its own
 *     DB lookup (subscription + admin + free-access) and fails CLOSED (denied)
 *     on a missing user or any DB error.
 *
 * OUTPUT IS IDENTICAL to the browser mint: the same
 * `jwt.sign({ userId, purpose: 'relay-ticket' }, secret, HS256, 30s)`. The
 * relay (server.js WS upgrade handler) verifies tickets by signature + purpose
 * + expiry only, so it accepts an M2M-minted ticket with ZERO changes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AUTH CONTRACT (for the CRM backend)
 * ─────────────────────────────────────────────────────────────────────────
 *   Header:  Authorization: Bearer <credential>
 *              where <credential> is EITHER
 *                (A) a per-partner key `ccp_live_<keyId>.<secret>`  (SDK partners), or
 *                (B) the legacy shared `CC_M2M_MINT_KEY`  (DEPRECATED — dnk-crm).
 *   Body:    { "ccUserId": "<the rep's CC user id>" }
 *
 *   401  → missing / malformed / wrong / revoked key, or suspended partner
 *          (all collapse to one opaque 401; the legacy path is also disabled +
 *          fails closed, non-revealing, if CC_M2M_MINT_KEY is unset).
 *   403  → partner key lacks the 'call' scope (insufficient_scope), OR key OK but
 *          ccUserId is not entitled (entitlement held — never bypassable).
 *   429  → per-IP flood backstop, or per-partner rate limit exceeded.
 *   400  → missing / non-string ccUserId.
 *   200  → { ticket } — a 30 s relay-ticket, identical in shape to the browser mint.
 *
 * SDK-PKG-2 Phase 1 (2026-08-25): per-partner keys are DB-backed (Partner /
 * PartnerApiKey), stored HASHED (SHA-256), scoped, and per-partner rate-limited.
 * See lib/partnerKeys.ts. The legacy shared key stays a working fallback.
 *
 * SECURITY POSTURE:
 *   - CC_M2M_MINT_KEY is a TOP-TIER secret: >=32 bytes of randomness, TLS-only
 *     in transit, NEVER logged, rotate-on-suspicion. It is compared in constant
 *     time (SHA-256 digest → timingSafeEqual) so neither the value nor its
 *     length leaks via a timing oracle.
 *   - This is a NEW server-to-server path that mints call-authorizing tokens.
 *     It MUST pass a Security review before any REAL activation. Until then the
 *     CRM keeps using the mock relay (dummy test).
 *
 * REVERSIBILITY: additive route + one env var. Clean revert = delete this file
 * and unset CC_M2M_MINT_KEY. No change to the browser mint, the relay, or the
 * entitlement logic.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';
import { getJwtSecret } from '@/lib/auth';
import { evaluateUserEntitlement } from '@/lib/entitlement';
import {
  m2mSourceIp,
  m2mRateLimited,
  m2mPartnerRateLimited,
  auditM2MMint,
} from '@/lib/m2mMintAudit';
import {
  looksLikePartnerKey,
  resolvePartnerKey,
  hasScope,
  touchPartnerKeyLastUsed,
  type PartnerKeyDbClient,
} from '@/lib/partnerKeys';

// jsonwebtoken + node:crypto require the Node.js runtime (not Edge).
export const runtime = 'nodejs';

/**
 * Constant-time secret compare over arbitrary-charset strings (the M2M key is
 * base64url, not hex). Hashing both sides to a fixed 32-byte digest before
 * timingSafeEqual means the compare is length-independent — a wrong-length
 * guess cannot be distinguished from a wrong-value guess by timing, and the
 * key's length never leaks. Returns false for any null/empty input.
 */
function constantTimeKeyEqual(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  // Digests are always 32 bytes, so timingSafeEqual never throws on length.
  return crypto.timingSafeEqual(a, b);
}

/** Extract the bearer token from an Authorization header. Null if absent/malformed. */
function extractBearer(req: NextRequest): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function POST(req: NextRequest) {
  // Trusted-hop client IP (CF → Traefik chain via lib/ip). Resolved once and
  // threaded into every audit entry. 'unknown' if no proxy header is present.
  const sourceIp = m2mSourceIp(req);
  try {
    // ── Per-IP rate limit (M2M-3) — BEFORE any key/DB work ─────────────────
    // Hygiene + a DoS/enumeration backstop. Mirrors the app's in-memory token
    // bucket (app/api/waitlist). Evaluated first so a flood — even of bad-key
    // attempts — is throttled before it can touch the key compare or the DB.
    // Brute-force is already infeasible (>=32-byte key); this caps volume.
    if (m2mRateLimited(sourceIp)) {
      auditM2MMint(sourceIp, null, 'rate_limited');
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    // ── Server-to-server auth (NOT a user session) ─────────────────────────
    // TWO accepted credentials (SDK-PKG-2 Phase 1):
    //   (A) a PER-PARTNER key  `ccp_live_<keyId>.<secret>` — DB-backed, scoped,
    //       per-partner rate-limited. The path outside companies use.
    //   (B) the LEGACY shared `CC_M2M_MINT_KEY` (env) — DEPRECATED, kept fully
    //       working so our own dnk-crm does not break during the transition.
    // We branch on the key SHAPE (cheap, no DB) so a caller never learns which
    // credential type failed — every failure is one opaque 401.
    const providedKey = extractBearer(req);

    // partnerId/apiKeyId/rateLimit are populated ONLY on the partner path; they
    // stay null for the legacy path (which keeps its per-IP-only limiting).
    let partnerId: string | null = null;
    let partnerApiKeyId: string | null = null;

    if (looksLikePartnerKey(providedKey)) {
      // ── (A) Per-partner key ────────────────────────────────────────────────
      // resolvePartnerKey fails CLOSED and is constant-time on the secret compare
      // (it burns a dummy hash even on a keyId miss, so "does this keyId exist?"
      // is not answerable by timing). invalid / revoked / suspended all collapse
      // here to ONE opaque 401 — the caller cannot tell them apart.
      const res = await resolvePartnerKey(db as unknown as PartnerKeyDbClient, providedKey);
      if (!res.ok) {
        console.warn(`[RelayTicketM2M] partner auth reject: ${res.reason}`);
        auditM2MMint(sourceIp, null, 'unauthorized');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // Scope enforcement (server-side, deny by default). Minting a relay-ticket
      // is the precursor to placing a call, so it requires the 'call' scope.
      if (!hasScope(res.scopes, 'call')) {
        console.warn(`[RelayTicketM2M] partner ${res.partnerId} lacks 'call' scope`);
        auditM2MMint(sourceIp, null, 'insufficient_scope', Date.now(), res.partnerId);
        return NextResponse.json({ error: 'insufficient_scope' }, { status: 403 });
      }

      // Per-partner rate limit (configurable per key; default in lib/partnerKeys).
      // Replaces the per-IP bucket for partner traffic so one partner's shared
      // egress IP can't starve another, and abuse is contained per-partner. The
      // per-IP backstop above still guards the pre-DB flood surface for everyone.
      if (m2mPartnerRateLimited(res.partnerId, res.rateLimitPerMin)) {
        auditM2MMint(sourceIp, null, 'rate_limited', Date.now(), res.partnerId);
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      }

      partnerId = res.partnerId;
      partnerApiKeyId = res.apiKeyId;
    } else {
      // ── (B) LEGACY shared key (DEPRECATED — remove once dnk-crm migrates) ────
      // The configured key is the gate. If it is unset, the legacy path is
      // disabled and fails CLOSED: every caller gets 401, and we do NOT reveal
      // that the server has no key. Ops sees the reason in the server log only.
      const expectedKey = process.env.CC_M2M_MINT_KEY;
      if (!expectedKey || expectedKey.length < 32) {
        console.warn(
          '[RelayTicketM2M] CC_M2M_MINT_KEY is unset or <32 chars — legacy M2M mint disabled (failing closed).',
        );
        auditM2MMint(sourceIp, null, 'unauthorized');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (!constantTimeKeyEqual(providedKey, expectedKey)) {
        // No detail on WHY (missing vs wrong) — a single opaque 401.
        console.warn('[RelayTicketM2M] auth reject: missing or invalid legacy M2M key');
        auditM2MMint(sourceIp, null, 'unauthorized');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // ── Input ──────────────────────────────────────────────────────────────
    let ccUserId: unknown;
    try {
      const body = await req.json();
      ccUserId = body?.ccUserId;
    } catch {
      auditM2MMint(sourceIp, null, 'bad_request');
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (typeof ccUserId !== 'string' || ccUserId.trim().length === 0) {
      auditM2MMint(sourceIp, null, 'bad_request');
      return NextResponse.json({ error: 'ccUserId (string) is required' }, { status: 400 });
    }
    const userId = ccUserId.trim();

    // SECURITY: Phase-1 trust boundary — partner may mint for any entitled
    // ccUserId; per-user consent binding (proving THIS ccUserId authorized THIS
    // partner) is deferred to Phase 2 OAuth. Today a partner key is trusted to
    // pass only ccUserIds it manages, exactly like dnk-crm with the shared key.
    // The entitlement gate below still independently gates the TARGET user, so a
    // partner key can NEVER bypass the paywall — it only authenticates the CALLER.

    // ── HARD entitlement chokepoint (KEPT — mirrors the browser mint) ──────
    // evaluateUserEntitlement does its own DB lookup (subscription + admin +
    // free-access) and fails CLOSED: a non-existent user or any DB error →
    // allowed:false → 403. The M2M key authenticates the trusted CALLER; it
    // does NOT grant a non-entitled user any product value. Admin + allowlist
    // + free-access bypass via the same rules the browser path honors, so
    // Dennis/allowlisted reps are never blocked.
    // Cast: evaluateUserEntitlement's dbClient param is typed with an
    // `(args: unknown)` findUnique (see entitlement-core.d.ts — it's typed
    // loosely because only server.js, plain JS, normally calls it). Function-arg
    // contravariance makes the real (stricter) PrismaClient un-assignable to
    // that slot, so we cast the runtime PrismaClient through the expected shape.
    // Same known quirk documented on isFreeAccessEmail. Runtime is a real Prisma
    // client either way.
    const ent = await evaluateUserEntitlement(
      db as unknown as Parameters<typeof evaluateUserEntitlement>[0],
      userId,
    );
    if (!ent.allowed) {
      console.warn(`[RelayTicketM2M] entitlement denied (${ent.reason}) for user ${userId}`);
      auditM2MMint(sourceIp, userId, 'denied_entitlement', Date.now(), partnerId);
      return NextResponse.json({ error: 'subscription_required' }, { status: 403 });
    }

    // ── Mint — IDENTICAL to the browser path so the relay accepts it as-is ──
    const ticket = jwt.sign(
      { userId, purpose: 'relay-ticket' },
      getJwtSecret(),
      { algorithm: 'HS256', expiresIn: '30s' },
    );

    // Best-effort lastUsedAt bump for a partner key (fire-and-forget; a failure
    // here never fails an already-authorized mint). No-op for the legacy path.
    if (partnerApiKeyId) {
      void touchPartnerKeyLastUsed(db as unknown as PartnerKeyDbClient, partnerApiKeyId);
    }

    // Audit the successful mint (this also evaluates the anomaly trip-wire).
    // Only partnerId + ccUserId + outcome + IP are recorded — never the minted
    // `ticket` and never the key/secret.
    auditM2MMint(sourceIp, userId, 'minted', Date.now(), partnerId);
    return NextResponse.json({ ticket });
  } catch (e) {
    // getJwtSecret throws if JWT_SECRET is missing in prod → server-config, 500.
    console.error('[RelayTicketM2M] error:', e);
    return NextResponse.json({ error: 'Ticket mint failed' }, { status: 500 });
  }
}
