// Unit tests for the signed sliding idle-cookie primitives
// (lib/idleSession.ts) + the validateSessionWithIdle decision logic
// (2026-07-27, dispatch forge/web-idle-timeout).
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly with
// Node's native type stripping:
//
//   node tests/idle-session.test.ts
//
// Exits non-zero on the first failing assertion.
//
// lib/idleSession.ts is DB-free (secret is injected, not read from
// getJwtSecret) precisely so it imports cleanly here. lib/auth.ts itself pulls
// @/lib/db (Prisma) and cannot be type-stripped standalone, so the
// validateSessionWithIdle branch table below MIRRORS that wrapper's decision
// logic against the real idle verifier. If you change validateSessionWithIdle
// in lib/auth.ts, update the mirror here.

import { strict as assert } from 'node:assert';
import jwt from 'jsonwebtoken';
import {
  signIdleToken,
  verifyIdleToken,
  isIdleTokenValid,
} from '../lib/idleSession.ts';
import { IDLE_COOKIE_MAX_AGE_S, IDLE_TIMEOUT_MS } from '../lib/idleTimeout.ts';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const OTHER_SECRET = 'a-totally-different-secret-32chars-yyyy';
const USER = 'user_abc123';

let pass = 0;
const t = (name: string, fn: () => void) => {
  fn();
  pass++;
  console.log(`  PASS  ${name}`);
};

// ── constant sanity ──────────────────────────────────────────────────────
t('idle window is 4h and cookie maxAge matches', () => {
  assert.equal(IDLE_TIMEOUT_MS, 4 * 60 * 60 * 1000);
  assert.equal(IDLE_COOKIE_MAX_AGE_S, 4 * 60 * 60);
});

// ── happy path: valid + fresh ─────────────────────────────────────────────
t('valid fresh idle token verifies and returns userId', () => {
  const token = signIdleToken(USER, SECRET);
  const res = verifyIdleToken(token, SECRET);
  assert.deepEqual(res, { userId: USER });
  assert.equal(isIdleTokenValid(token, SECRET), true);
});

// ── absent cookie ─────────────────────────────────────────────────────────
t('absent idle token is rejected', () => {
  assert.equal(verifyIdleToken(undefined, SECRET), null);
  assert.equal(verifyIdleToken(null, SECRET), null);
  assert.equal(verifyIdleToken('', SECRET), null);
  assert.equal(isIdleTokenValid(undefined, SECRET), false);
});

// ── expired cookie ────────────────────────────────────────────────────────
t('expired idle token is rejected', () => {
  // Signed already-expired (expiresIn negative → iat/exp in the past).
  const expired = jwt.sign({ userId: USER, purpose: 'idle' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: -10,
  });
  assert.equal(verifyIdleToken(expired, SECRET), null);
  assert.equal(isIdleTokenValid(expired, SECRET), false);
});

// ── forged / tampered ─────────────────────────────────────────────────────
t('token signed with a different secret is rejected', () => {
  const forged = signIdleToken(USER, OTHER_SECRET);
  assert.equal(verifyIdleToken(forged, SECRET), null);
});

t('a tampered token body is rejected', () => {
  const token = signIdleToken(USER, SECRET);
  const parts = token.split('.');
  // Flip a char in the payload segment → signature no longer matches.
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
  assert.equal(verifyIdleToken(tampered, SECRET), null);
});

t('alg:none attack is rejected (alg pinned to HS256)', () => {
  const noneToken = jwt.sign({ userId: USER, purpose: 'idle' }, '', {
    algorithm: 'none',
  });
  assert.equal(verifyIdleToken(noneToken, SECRET), null);
});

// ── wrong purpose ─────────────────────────────────────────────────────────
t('a valid-signature token with the wrong purpose is rejected', () => {
  const accessLike = jwt.sign({ userId: USER, purpose: 'access' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
  assert.equal(verifyIdleToken(accessLike, SECRET), null);
  // A relay-ticket-purpose token must not double as an idle token either.
  const ticketLike = jwt.sign({ userId: USER, purpose: 'relay-ticket' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '30s',
  });
  assert.equal(verifyIdleToken(ticketLike, SECRET), null);
});

t('missing userId claim is rejected', () => {
  const noUser = jwt.sign({ purpose: 'idle' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '4h',
  });
  assert.equal(verifyIdleToken(noUser, SECRET), null);
});

// ── slide: a re-mint pushes the deadline forward ──────────────────────────
t('re-minting slides the deadline forward', () => {
  const first = jwt.decode(signIdleToken(USER, SECRET)) as { exp: number };
  // Force a later iat so exp is strictly greater (jwt uses whole-second iat).
  const laterRaw = jwt.sign({ userId: USER, purpose: 'idle', iat: Math.floor(Date.now() / 1000) + 5 }, SECRET, {
    algorithm: 'HS256',
    expiresIn: IDLE_COOKIE_MAX_AGE_S,
  });
  const second = jwt.decode(laterRaw) as { exp: number };
  assert.ok(second.exp > first.exp, 'a later re-mint must have a later exp');
  assert.equal(isIdleTokenValid(laterRaw, SECRET), true);
});

// ── validateSessionWithIdle decision table (MIRROR of lib/auth.ts) ─────────
// Mirrors the wrapper's branch logic: sessionVersion check FIRST (→'no-session'
// on failure), idle SECOND (→'idle-expired' when auth valid but idle bad).
function decideSessionWithIdle(opts: {
  sessionValid: boolean; // stands in for validateSessionToken(auth) !== null
  idleCookie: string | undefined;
  secret: string;
}): { ok: boolean; reason: 'no-session' | 'idle-expired' | null } {
  if (!opts.sessionValid) return { ok: false, reason: 'no-session' };
  if (!isIdleTokenValid(opts.idleCookie, opts.secret)) {
    return { ok: false, reason: 'idle-expired' };
  }
  return { ok: true, reason: null };
}

t('wrapper: valid session + fresh idle ⇒ ok', () => {
  const idle = signIdleToken(USER, SECRET);
  assert.deepEqual(
    decideSessionWithIdle({ sessionValid: true, idleCookie: idle, secret: SECRET }),
    { ok: true, reason: null },
  );
});

t('wrapper: valid session + expired idle ⇒ idle-expired', () => {
  const expired = jwt.sign({ userId: USER, purpose: 'idle' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: -1,
  });
  assert.deepEqual(
    decideSessionWithIdle({ sessionValid: true, idleCookie: expired, secret: SECRET }),
    { ok: false, reason: 'idle-expired' },
  );
});

t('wrapper: valid session + absent idle ⇒ idle-expired', () => {
  assert.deepEqual(
    decideSessionWithIdle({ sessionValid: true, idleCookie: undefined, secret: SECRET }),
    { ok: false, reason: 'idle-expired' },
  );
});

t('wrapper: invalid session ⇒ no-session (idle not even consulted)', () => {
  const idle = signIdleToken(USER, SECRET);
  assert.deepEqual(
    decideSessionWithIdle({ sessionValid: false, idleCookie: idle, secret: SECRET }),
    { ok: false, reason: 'no-session' },
  );
});

console.log(`\n${pass} passed`);
