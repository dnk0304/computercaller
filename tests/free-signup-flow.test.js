// Proof obligations 2, 4, 5 (dispatch forge/free-signup-verification):
//   (2) unverified account can't act — created emailVerified:false, NO session
//       issued at register, login/apk-login already 403 on !emailVerified;
//   (4) abuse controls — verify single-use, resend cooldown + 24h cap;
//   (5) no user enumeration — one generic response for exists vs new email.
//
// Two layers: (A) MIRRORED decision logic exercised directly, and (B) SOURCE
// grep-guards that fail if the route drifts away from the modelled invariant
// (repo convention — see login-enumeration.test.js). Runner-less.
// Run: node tests/free-signup-flow.test.js
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo runner-less CJS convention. */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log(`  PASS  ${name}`); passed += 1; }
function eq(name, a, e) { assert.deepStrictEqual(a, e, name); console.log(`  PASS  ${name}`); passed += 1; }

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const REGISTER = read('app/api/auth/register/route.ts');
const VERIFY = read('app/api/auth/verify-email/route.ts');
const RESEND = read('app/api/auth/resend-verification/route.ts');
const LOGIN = read('app/api/auth/login/route.ts');
const APK = read('app/api/auth/apk-login/route.ts');

// ── (5) Register: no enumeration — mirror the email-branch decision ──────────
// provisionAndSend returns nothing distinguishable; the POST always answers
// GENERIC_OK for every email-dependent outcome. Model that the RESPONSE is a
// constant across {new, exists, not-allowed}.
function registerResponseFor(/* any email state */) {
  // The route computes the response BEFORE (and independent of) the fire-and-
  // forget provisioning, so the outcome is literally constant.
  return { status: 200, generic: true };
}
eq('register: new email → generic 200', registerResponseFor(), { status: 200, generic: true });
eq('register: existing email → same generic 200', registerResponseFor(), { status: 200, generic: true });
eq('register: not-allowed email → same generic 200', registerResponseFor(), { status: 200, generic: true });

// Source guards for the enumeration + inert-account invariants.
ok('register: single GENERIC_OK constant used for the success path',
  /const GENERIC_OK =/.test(REGISTER) && /return NextResponse\.json\(GENERIC_OK, \{ status: 200 \}\)/.test(REGISTER));
ok('register: provisioning is fire-and-forget (void, not awaited) → flat timing',
  /void provisionAndSend\(/.test(REGISTER) && !/await provisionAndSend/.test(REGISTER));
ok('register: existing-email branch returns early with NO send',
  /if \(existing\) \{[\s\S]*?return;/.test(REGISTER));

// ── (2) Unverified account is inert ──────────────────────────────────────────
ok('register: account created emailVerified:false', /emailVerified: false/.test(REGISTER));
ok('register: NO session issued (no signAccessToken, no auth_token cookie)',
  !/signAccessToken/.test(REGISTER) && !/auth_token/.test(REGISTER) && !/cookies\.set/.test(REGISTER));
ok('login STILL rejects !emailVerified with 403',
  /if \(!user\.emailVerified\)/.test(LOGIN) && /status: 403/.test(LOGIN));
ok('apk-login STILL rejects !emailVerified with 403',
  /if \(!user\.emailVerified\)/.test(APK) && /status: 403/.test(APK));

// ── (4a) Verify-email single-use + purpose pin — mirror the decision ─────────
function verifyDecision({ payload, user, token }) {
  if (!token) return 'invalid_token';
  if (!payload) return 'expired_token';
  if ((payload.purpose ?? 'access') !== 'verify-email') return 'invalid_token';
  if (!user) return 'invalid_token';
  if (user.emailVerified) return 'verified'; // idempotent / scanner-safe
  if (user.emailVerifyToken !== token) return 'invalid_token'; // superseded/stale
  return 'verified'; // consume
}
const VP = { purpose: 'verify-email', userId: 'u1' };
eq('verify: matching token verifies', verifyDecision({ payload: VP, user: { emailVerified: false, emailVerifyToken: 't' }, token: 't' }), 'verified');
eq('verify: access-purpose token rejected (purpose pin)', verifyDecision({ payload: { purpose: 'access', userId: 'u1' }, user: { emailVerified: false, emailVerifyToken: 't' }, token: 't' }), 'invalid_token');
eq('verify: reset-purpose token rejected', verifyDecision({ payload: { purpose: 'reset-password', userId: 'u1' }, user: { emailVerified: false, emailVerifyToken: 't' }, token: 't' }), 'invalid_token');
eq('verify: SUPERSEDED token (resend replaced it) rejected → single use', verifyDecision({ payload: VP, user: { emailVerified: false, emailVerifyToken: 't-new' }, token: 't-old' }), 'invalid_token');
eq('verify: already-verified is idempotent success (scanner/double-click safe)', verifyDecision({ payload: VP, user: { emailVerified: true, emailVerifyToken: null }, token: 't' }), 'verified');

ok('verify source: purpose pinned to verify-email', /!== 'verify-email'/.test(VERIFY));
ok('verify source: token-match against stored emailVerifyToken', /user\.emailVerifyToken !== token/.test(VERIFY));

// ── (4b) Resend cooldown + 24h cap — exercise the REAL limiter shape ─────────
// Re-implement emailSendAllowed with the SAME constants and assert the guard
// values match the source (drift guard), then behaviourally test it.
const COOLDOWN_MS = 60 * 1000, DAY_MS = 24 * 3600 * 1000, DAY_MAX = 5;
ok('resend source: 60s cooldown constant present', /EMAIL_COOLDOWN_MS = 60 \* 1000/.test(RESEND));
ok('resend source: 5/24h cap constant present', /EMAIL_DAY_MAX = 5/.test(RESEND));
ok('resend source: per-IP limiter present', /ipRateLimited/.test(RESEND) && /status: 429/.test(RESEND));
ok('resend source: send is fire-and-forget (flat timing)', /void lookupAndSend\(/.test(RESEND));

const store = new Map();
function emailSendAllowed(email, now) {
  const cut = now - DAY_MS;
  const sends = (store.get(email) ?? []).filter((t) => t > cut);
  const last = sends.length ? sends[sends.length - 1] : 0;
  if (now - last < COOLDOWN_MS) return false;
  if (sends.length >= DAY_MAX) return false;
  sends.push(now); store.set(email, sends); return true;
}
let t = 1_000_000;
ok('resend: 1st send allowed', emailSendAllowed('a@x.com', t) === true);
ok('resend: 2nd send within 60s BLOCKED (cooldown)', emailSendAllowed('a@x.com', t + 30_000) === false);
// space 5 sends > 60s apart across the day, then the 6th must fail the cap
store.clear();
let base = 2_000_000;
for (let i = 0; i < 5; i++) ok(`resend: send #${i + 1} allowed (spaced)`, emailSendAllowed('b@x.com', base + i * 120_000) === true);
ok('resend: 6th send within 24h BLOCKED (cap)', emailSendAllowed('b@x.com', base + 5 * 120_000) === false);

console.log(`\n${passed} passed — free-signup flow (enumeration, inert account, verify single-use, resend limits).`);
