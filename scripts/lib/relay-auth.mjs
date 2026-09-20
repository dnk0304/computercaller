/**
 * Real credentials for the real relay. (Shared harness infrastructure; written
 * for E2E-P6, brought onto e2e/soak-rig for the R-AM 24 h soak.)
 *
 * VERIFIED AGAINST 392e490, not against the P6 tree it came from. Every claim
 * below was re-read out of that commit rather than inherited:
 *   - `validateTicket` (server.js) refuses a secret under 32 chars, accepts
 *     ONLY HS256, and requires `purpose === 'relay-ticket'` plus a string
 *     `userId` — exactly what `mintTicket()` signs.
 *   - the relay entitlement chokepoint calls `evaluateUserEntitlement`, whose
 *     rule (1) is `if (isAdmin) → allowed` (lib/entitlement-core.js:218),
 *     which is why `seedEntitledUser` sets `isAdmin: true`.
 *   - `User.phoneToken` is still `@unique` with NO database default, so it must
 *     be set explicitly in app code (prisma/schema.prisma, Bundle A C2).
 * No DeviceKey row is needed by anything here: DeviceKey rows key the `wraps[]`
 * of a real encrypted pairing, and these helpers only get a peer ADMITTED to a
 * room. A harness that drives a real SAS pairing seeds its own key rows.
 *
 * WHY THIS EXISTS — a discovery that reshaped the P6 harnesses
 * ------------------------------------------------------------
 * The first soak rehearsal against `node server.js` produced 178 socket closes,
 * 89 reconnects per role and zero frames in 90 seconds. The verifier refused to
 * certify it, which is exactly what it is for — but the cause is the useful
 * part: every socket was closed with **4401 invalid_token**.
 *
 * The relay authenticates at the WS UPGRADE, before any frame exists, and then
 * runs the entitlement gate — which is the paywall, and is deliberately
 * fail-CLOSED: a missing user row or a DB throw rejects the upgrade with 4403.
 * So a harness that merely opens `ws://host/relay?role=phone` is not testing
 * the relay at all; it is testing the rejection path, and it will happily
 * report a socket "held" for 24 h while nothing whatsoever is being soaked.
 *
 * Any harness that claims to use the real relay therefore needs REAL
 * credentials, and that is not a detail to leave to each caller to rediscover.
 *
 * THE CONTRACT, read out of server.js rather than assumed
 * -------------------------------------------------------
 *   browser  →  /relay?ticket=<HS256 JWT>     claims {purpose:'relay-ticket', userId}
 *   listener →  /relay?ticket=<…>&role=listener
 *   phone    →  /relay/phone?token=<phoneToken>   the long-lived DB bearer
 *
 * Two edges worth knowing before they cost an afternoon:
 *  - `JWT_SECRET` shorter than **32 characters** makes the relay refuse ALL
 *    ticket auth and say so only on its own stdout. The rehearsal's secret was
 *    17 characters, which is why even the browser sockets died. `mintSecret()`
 *    below cannot produce a short one.
 *  - `phoneToken` has NO database default by design (Bundle A C2) — every row
 *    must set it explicitly to crypto-random bytes. Seeding a user without one
 *    fails at the unique constraint, not at the relay, which makes it look like
 *    a schema problem rather than an auth one.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

/** A secret that is always long enough for the relay to accept tickets at all. */
export function mintSecret() {
  return crypto.randomBytes(48).toString('base64url'); // ~64 chars, well over 32
}

/**
 * Seed one entitled test user in the scratch database.
 *
 * `isAdmin: true` is used rather than a subscription row because
 * evaluateEntitlement's rule (1) short-circuits on it — so the harness depends
 * on ONE documented branch instead of on a pricing model that changes with
 * every dispatch. The alternative (ENTITLEMENT_ALLOWLIST) needs an env var to
 * reach the relay process and silently falls back to a hardcoded list when
 * fat-fingered, which is a worse failure to debug.
 *
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function seedEntitledUser(db, { email = null } = {}) {
  const addr = email || `e2e-harness-${crypto.randomBytes(6).toString('hex')}@example.invalid`;
  const phoneToken = crypto.randomBytes(32).toString('base64url');
  const user = await db.user.create({
    data: {
      email: addr,
      emailVerified: true,
      isAdmin: true,
      phoneToken,
    },
    select: { id: true, email: true, phoneToken: true },
  });
  return user;
}

/** Remove a seeded user. Scratch DB only — never point this at anything else. */
export async function removeUser(db, userId) {
  try { await db.user.delete({ where: { id: userId } }); } catch { /* already gone */ }
}

/**
 * Mint a relay ticket for `userId`.
 *
 * The real ticket is short-lived (30 s from /api/auth/relay-ticket). Harnesses
 * that hold a socket for hours do not need a long ticket — the ticket is only
 * checked at upgrade — but a RECONNECT needs a fresh one, so callers that
 * reconnect must call this again rather than caching the string. Made explicit
 * because a stale cached ticket reproduces the 4401 storm this module exists to
 * explain.
 */
export function mintTicket({ secret, userId, expiresIn = '10m' }) {
  if (!secret || secret.length < 32) {
    throw new Error('mintTicket: JWT_SECRET must be at least 32 chars — the relay refuses ALL ticket auth below that');
  }
  return jwt.sign({ purpose: 'relay-ticket', userId }, secret, { algorithm: 'HS256', expiresIn });
}

/** The three URLs a harness can legitimately connect to. */
export function relayUrls({ wsBase, secret, user, listenerDeviceId = null }) {
  const ticket = () => mintTicket({ secret, userId: user.id });
  return {
    browser: () => `${wsBase}/relay?ticket=${encodeURIComponent(ticket())}`,
    listener: () => `${wsBase}/relay?ticket=${encodeURIComponent(ticket())}&role=listener`
      + (listenerDeviceId ? `&deviceId=${encodeURIComponent(listenerDeviceId)}` : ''),
    phone: () => `${wsBase}/relay/phone?token=${encodeURIComponent(user.phoneToken)}`,
  };
}

/**
 * Open a socket and REQUIRE it to stay open.
 *
 * The default `ws` behaviour on an auth rejection is an 'open' followed almost
 * immediately by a 'close' with 4401/4403. A harness that resolves on 'open'
 * therefore reports success for a socket the relay already rejected — which is
 * precisely how the rehearsal logged 89 "opens" per role and zero frames. So
 * this helper waits out a settle window and rejects with the close code, which
 * turns a silent all-zero run into a legible error at the first socket.
 */
export function openAuthed(WebSocket, url, { settleMs = 750, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const t = setTimeout(() => done(reject, new Error(`socket did not open within ${timeoutMs}ms`)), timeoutMs);
    ws.on('open', () => {
      setTimeout(() => {
        clearTimeout(t);
        if (ws.readyState === 1) done(resolve, ws);
      }, settleMs);
    });
    ws.on('close', (code, reason) => {
      clearTimeout(t);
      const why = code === 4401 ? 'invalid_token — check JWT_SECRET length (>=32) and that the user row exists'
        : code === 4403 ? 'subscription_required — the entitlement gate rejected this user'
          : String(reason || '');
      done(reject, new Error(`relay closed the socket: ${code} ${why}`));
    });
    ws.on('error', (e) => { clearTimeout(t); done(reject, e); });
  });
}
