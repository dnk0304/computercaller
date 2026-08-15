/**
 * lib/passwordSetToken-core.js — the single-use, expiring set-password token
 * primitive (dispatch forge/admin-create-account, 2026-08-15).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `User.resetToken` + `User.resetTokenExpiry` and `sendPasswordResetEmail()`
 * have been in the schema/lib since the beginning, but NO route ever used them —
 * password reset was never implemented. The admin "create account" feature needs
 * exactly that primitive (an admin must never invent, see, or handle a user's
 * password), so it is built here ONCE, properly, and the eventual
 * forgot-password flow reuses it verbatim rather than re-deriving it.
 *
 * WHY PLAIN JS (repo convention — see entitlement-core.js / whop-core.js /
 * tiers-core.js): the security decisions live in here, and a plain-JS core that
 * takes its Prisma client as an ARGUMENT can be exercised runner-less against a
 * mock client (`node tests/…`) with no database, no transpiler and no server.
 * lib/passwordSetToken.ts is a thin typed wrapper that binds the real `db`.
 *
 * SECURITY MODEL
 * --------------
 *  1. The raw token is 32 crypto-random bytes, base64url — ~256 bits. It exists
 *     in exactly two places: the invite email/URL, and the HTTP response to the
 *     admin who created the account. It is NEVER logged and NEVER persisted.
 *  2. What lands in the DB is `sha256(raw)`, hex. A database dump therefore does
 *     not yield a usable token — the same reason we store bcrypt hashes and not
 *     passwords. Unsalted SHA-256 is correct HERE and wrong for passwords: the
 *     input is 256 bits of uniform entropy, so there is nothing to brute force
 *     and a slow KDF would only add latency to every redemption.
 *  3. Lookup is by hash (indexed — `@@index([resetToken])`), and the fetched
 *     hash is then re-compared with `timingSafeEqual`.
 *  4. SINGLE USE is enforced at the DATABASE, not in application logic. The
 *     consuming write is an `updateMany` whose WHERE still contains the token
 *     hash and the expiry; Postgres serialises the row update, so of two
 *     concurrent redemptions of one link exactly one reports `count === 1`. A
 *     read-then-write in app code would let both through.
 *  5. Expiry is checked on read AND re-asserted in the consuming WHERE, so a
 *     token cannot expire in the gap between the check and the write.
 *
 * The token is deliberately NOT a JWT: a JWT is not revocable, and "this link
 * stops working the moment it is used" is the entire point.
 */
'use strict';

const crypto = require('crypto');

/** Invite TTL — 72h. Long enough to survive a weekend and a spam folder. */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** Self-serve password-reset TTL — 1h (for the future forgot-password route). */
const RESET_TTL_MS = 60 * 60 * 1000;

/** Mint a raw token. 32 bytes → base64url so it survives a URL/query intact. */
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** sha256(raw) as lowercase hex — the ONLY form that touches the database. */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time hex-digest comparison. `timingSafeEqual` throws on a length
 * mismatch, so guard that first. Lengths are public (both are 64-char sha256
 * digests), so an early length return leaks nothing.
 */
function tokensMatch(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Reject obviously-unusable input before it reaches the database. */
function isPlausibleToken(raw) {
  return typeof raw === 'string' && raw.length >= 16 && raw.length <= 512;
}

/**
 * Mint a token and return it alongside the exact column values to persist.
 *
 * Deliberately does NOT write: the account-create path folds `fields` straight
 * into its `user.create` data, so the row is born with its invite token and
 * there is no window in which an account exists with no way to claim it (and no
 * second write that can fail halfway).
 */
function mintPasswordSetToken(ttlMs = INVITE_TTL_MS, nowMs = Date.now()) {
  const rawToken = generateRawToken();
  const expiresAt = new Date(nowMs + ttlMs);
  return {
    rawToken,
    expiresAt,
    fields: { resetToken: hashToken(rawToken), resetTokenExpiry: expiresAt },
  };
}

/**
 * Build the one-time URL the invitee follows. Kept here so the emailed link and
 * the admin panel's "copy link" fallback can never drift.
 */
function buildSetPasswordUrl(rawToken, appUrl) {
  const base = (
    appUrl ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
  return `${base}/auth/set-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * PURE decision function: given the row we found (or null) and the hash we
 * computed, is this token usable right now?
 *
 * Split out from the query so the whole invalid/expired/ok truth table is
 * testable with no database at all. Both failure modes collapse to one generic
 * message at the route boundary — `reason` is for our logs and UX copy, never
 * for an attacker to enumerate with.
 */
function evaluateTokenRow(row, hash, nowMs = Date.now()) {
  if (!row || !row.resetToken || !tokensMatch(row.resetToken, hash)) {
    return { ok: false, reason: 'invalid' };
  }
  const exp = row.resetTokenExpiry;
  if (!exp || new Date(exp).getTime() <= nowMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, userId: row.id, email: row.email };
}

/**
 * Resolve a raw token to its user WITHOUT consuming it. Used by the GET
 * pre-flight so the set-password page can say "this link has expired" before
 * the user types a password into a form that is going to fail.
 */
async function lookupPasswordSetToken(db, rawToken, nowMs = Date.now()) {
  if (!isPlausibleToken(rawToken)) return { ok: false, reason: 'invalid' };
  const hash = hashToken(rawToken);
  const row = await db.user.findFirst({
    where: { resetToken: hash },
    select: { id: true, email: true, resetToken: true, resetTokenExpiry: true },
  });
  return evaluateTokenRow(row, hash, nowMs);
}

/**
 * Consume the token and set the password, atomically.
 *
 * The single conditional write does all the things that must never happen apart:
 *   • sets passwordHash                    (the user now has a credential)
 *   • clears resetToken + resetTokenExpiry (the link is dead — single use)
 *   • increments sessionVersion            (setting a password is a credential
 *     change and must revoke every session that predates it — the same lever
 *     /api/auth/login pulls for single-active-session)
 *   • re-checks the hash AND the expiry in the WHERE, closing the
 *     check-then-act race for both replay and just-expired tokens.
 *
 * `count === 0` after a successful lookup means another request won the race →
 * report 'invalid' (the token is genuinely gone), never a 500.
 */
async function consumePasswordSetToken(db, rawToken, passwordHash, nowMs = Date.now()) {
  const found = await lookupPasswordSetToken(db, rawToken, nowMs);
  if (!found.ok) return found;

  const hash = hashToken(rawToken);
  const result = await db.user.updateMany({
    where: {
      id: found.userId,
      resetToken: hash,
      resetTokenExpiry: { gt: new Date(nowMs) },
    },
    data: {
      passwordHash,
      resetToken: null,
      resetTokenExpiry: null,
      sessionVersion: { increment: 1 },
    },
  });
  if (!result || result.count !== 1) return { ok: false, reason: 'invalid' };

  // Read back the post-bump version — the JWT must be signed with the value the
  // row now holds, or validateSessionToken rejects the session we just created.
  const fresh = await db.user.findUnique({
    where: { id: found.userId },
    select: { sessionVersion: true },
  });
  return {
    ok: true,
    userId: found.userId,
    email: found.email,
    sessionVersion: (fresh && fresh.sessionVersion) || 0,
  };
}

module.exports = {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  generateRawToken,
  hashToken,
  tokensMatch,
  isPlausibleToken,
  mintPasswordSetToken,
  buildSetPasswordUrl,
  evaluateTokenRow,
  lookupPasswordSetToken,
  consumePasswordSetToken,
};
