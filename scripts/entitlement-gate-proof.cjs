/**
 * scripts/entitlement-gate-proof.cjs — end-to-end proof that the relay
 * entitlement gate closes the revenue leak (dispatch forge/relay-entitlement-
 * gate, 2026-07-27).
 *
 * It exercises the EXACT shared functions the production code paths call:
 *   • server.js relay admission → evaluateUserEntitlement(db, userId)
 *   • /api/auth/qr-token + /api/auth/relay-ticket → evaluateEntitlement(input)
 *   • /api/webhooks/whop card honesty → resolveWhopCardState(action, data)
 * against a MOCK Prisma client (no real DB, no real charges — per brief).
 *
 * Because the browser gate and the relay gate now share ONE runtime module,
 * proving these functions proves both doors. Run: `node scripts/entitlement-gate-proof.cjs`
 * Exits non-zero if any assertion fails.
 */
'use strict';

const {
  evaluateEntitlement,
  evaluateUserEntitlement,
  resolveWhopCardState,
  isAdminUser,
} = require('../lib/entitlement-core.js');

const NOW = new Date('2026-07-27T12:00:00Z');
const future = (days) => new Date(NOW.getTime() + days * 86400000);
const past = (days) => new Date(NOW.getTime() - days * 86400000);

// ── Mock Prisma client ──────────────────────────────────────────────────────
// Keyed by userId. `__throw` simulates a DB outage (fail-closed test).
const USERS = {
  u_none: { isAdmin: false, email: 'nopay@example.com', subscription: null },
  u_active: {
    isAdmin: false, email: 'payer@example.com',
    subscription: { status: 'active', trialEndsAt: past(30), currentPeriodEnd: future(20) },
  },
  u_trial: {
    isAdmin: false, email: 'trial@example.com',
    subscription: { status: 'trial', trialEndsAt: future(3), currentPeriodEnd: null },
  },
  u_trial_expired: {
    isAdmin: false, email: 'exttrial@example.com',
    subscription: { status: 'trial', trialEndsAt: past(1), currentPeriodEnd: null },
  },
  u_expired: {
    isAdmin: false, email: 'lapsed@example.com',
    subscription: { status: 'active', trialEndsAt: past(60), currentPeriodEnd: past(1) },
  },
  u_admin: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
  u_reviewer: { isAdmin: false, email: 'reviewer@computercaller.com', subscription: null },
  // Free-access user: NO subscription, email is in the FreeAccessEmail table.
  // Must resolve to state 'free_access' / Pro / allowed — proving a granted
  // email is admitted through the SAME gate without any paywall change.
  u_free: { isAdmin: false, email: 'freebie@example.com', subscription: null },
  // Free-access user whose sub is EXPIRED — proves the free_access short-circuit
  // ranks before the deny branches (grant overrides a dead sub).
  u_free_expired: {
    isAdmin: false, email: 'friend@example.com',
    subscription: { status: 'active', trialEndsAt: past(60), currentPeriodEnd: past(1) },
  },
};

// DB-backed free-access allowlist (lowercased), what FreeAccessEmail holds.
const FREE_ACCESS = new Set(['freebie@example.com', 'friend@example.com']);

const mockDb = {
  user: {
    findUnique: async ({ where }) => {
      if (where.id === 'u_dbdown') throw new Error('simulated DB outage');
      return USERS[where.id] || null;
    },
  },
  // Mirrors prisma db.freeAccessEmail.findUnique used by isFreeAccessEmail.
  freeAccessEmail: {
    findUnique: async ({ where }) => {
      const email = where && typeof where.email === 'string' ? where.email.toLowerCase() : '';
      return FREE_ACCESS.has(email) ? { email } : null;
    },
  },
};

// ── Faithful re-creation of each production gate's DECISION ──────────────────
// (mirrors the branch each route/server.js takes on the shared result)

// server.js relay upgrade: admit iff evaluateUserEntitlement().allowed
async function relayAdmits(userId) {
  const ent = await evaluateUserEntitlement(mockDb, userId, NOW);
  return { admitted: ent.allowed, reason: ent.reason };
}

// Full relay result incl. state + tier — used to prove free-access → Pro and to
// prove a paying user's tier is unchanged.
async function relayFull(userId) {
  const ent = await evaluateUserEntitlement(mockDb, userId, NOW);
  return { allowed: ent.allowed, state: ent.state, reason: ent.reason, tier: ent.tier };
}

// The admin-panel gate every /api/admin/* route applies: load {isAdmin,email},
// admit iff isAdminUser(...). Proves a non-admin is blocked, Dennis is not.
function adminGate(userId) {
  const u = USERS[userId];
  if (!u) return { status: 401 };
  return isAdminUser({ isAdmin: u.isAdmin, email: u.email })
    ? { status: 200 }
    : { status: 403 };
}

// /api/auth/qr-token GET: 403 subscription_required unless entitled, else 200 + token
async function qrTokenResponse(userId) {
  const u = USERS[userId];
  if (!u) return { status: 401 };
  const ent = evaluateEntitlement(
    { isAdmin: u.isAdmin, email: u.email, subscription: u.subscription }, NOW,
  );
  return ent.allowed ? { status: 200, discloseToken: true } : { status: 403, error: 'subscription_required' };
}

// ── Assertion harness ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
const rows = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  rows.push({ label, expected: JSON.stringify(expected), actual: JSON.stringify(actual), result: ok ? 'PASS' : 'FAIL' });
}

(async () => {
  console.log('\n=== TEST 1 — THE LEAK: unentitled user CANNOT get token or bridge ===');
  check('1a qr-token(none) → 403 no disclosure', await qrTokenResponse('u_none'), { status: 403, error: 'subscription_required' });
  check('1b relay(none) via ?token=/Bearer → REJECT', await relayAdmits('u_none'), { admitted: false, reason: 'no_subscription' });

  console.log('=== TEST 2 — Active paid user CAN drive the phone (no regression) ===');
  check('2a qr-token(active) → 200 discloses token', await qrTokenResponse('u_active'), { status: 200, discloseToken: true });
  check('2b relay(active) → ADMIT', await relayAdmits('u_active'), { admitted: true, reason: 'active_subscription' });
  check('2c relay(trial live) → ADMIT', await relayAdmits('u_trial'), { admitted: true, reason: 'trial_active' });

  console.log('=== TEST 3 — Expiry lock: access DIES at expiry ===');
  check('3a relay(trial_expired) → REJECT', await relayAdmits('u_trial_expired'), { admitted: false, reason: 'trial_expired' });
  check('3b relay(expired/past-period) → REJECT', await relayAdmits('u_expired'), { admitted: false, reason: 'not_entitled_status_active' });
  check('3c qr-token(trial_expired) → 403', await qrTokenResponse('u_trial_expired'), { status: 403, error: 'subscription_required' });

  console.log('=== TEST 4 — NO LOCKOUT: admin + allowlist admitted despite NO sub ===');
  check('4a relay(admin,no sub) → ADMIT', await relayAdmits('u_admin'), { admitted: true, reason: 'admin' });
  check('4b relay(reviewer allowlist,no sub) → ADMIT', await relayAdmits('u_reviewer'), { admitted: true, reason: 'entitlement_allowlist' });
  check('4c qr-token(admin) → 200', await qrTokenResponse('u_admin'), { status: 200, discloseToken: true });
  console.log('    [fail-CLOSED on error] DB outage + missing row must REJECT:');
  check('4d relay(DB outage) → REJECT (fail-closed)', await relayAdmits('u_dbdown'), { admitted: false, reason: 'entitlement_lookup_error' });
  check('4e relay(user not found) → REJECT', await relayAdmits('u_ghost'), { admitted: false, reason: 'user_not_found' });

  console.log('=== TEST 5 — Webhook card honesty (paymentMethodAttached truth) ===');
  // Mirror the webhook's persistence: new row stores `cardState === true`;
  // update writes the column only when cardState !== null (else preserves prior).
  const persist = (action, data) => {
    const cs = resolveWhopCardState(action, data);
    return { cardState: cs, createStores: cs === true, updateWritesColumn: cs !== null };
  };
  check('5a no-card went_valid → stored false (was wrongly true)', persist('membership.went_valid', {}),
    { cardState: null, createStores: false, updateWritesColumn: false });
  check('5b payment.succeeded → stored true', persist('payment.succeeded', {}),
    { cardState: true, createStores: true, updateWritesColumn: true });
  check('5c explicit has_payment_method:false → stored false', persist('membership.went_valid', { has_payment_method: false }),
    { cardState: false, createStores: false, updateWritesColumn: true });
  check('5d explicit user.has_payment_method:true → stored true', persist('membership.went_valid', { user: { has_payment_method: true } }),
    { cardState: true, createStores: true, updateWritesColumn: true });

  console.log('=== TEST 6 — FREE ACCESS: granted email → allowed, Pro tier, one gate ===');
  check('6a relay(free, no sub) → ADMIT free_access/pro', await relayFull('u_free'),
    { allowed: true, state: 'free_access', reason: 'free_access', tier: 'pro' });
  check('6b relay(free w/ EXPIRED sub) → grant overrides deny', await relayFull('u_free_expired'),
    { allowed: true, state: 'free_access', reason: 'free_access', tier: 'pro' });
  // Paywall UNWEAKENED: a non-free, non-admin user NOT in the allowlist stays
  // exactly as before (state/tier byte-stable).
  check('6c relay(none, NOT free) → still DENIED none/solo', await relayFull('u_none'),
    { allowed: false, state: 'none', reason: 'no_subscription', tier: 'solo' });
  check('6d relay(expired, NOT free) → still DENIED', await relayFull('u_expired'),
    { allowed: false, state: 'expired', reason: 'not_entitled_status_active', tier: 'solo' });
  // A normal paying user is UNCHANGED — allowed, active, Solo (planId null).
  check('6e relay(active payer) UNCHANGED active/solo', await relayFull('u_active'),
    { allowed: true, state: 'active', reason: 'active_subscription', tier: 'solo' });

  console.log('=== TEST 7 — ADMIN AUTHORITY: isAdminUser + admin-route gate ===');
  check('7a isAdminUser(Dennis email, no flag) → true',
    isAdminUser({ isAdmin: false, email: 'Dennis.Kotlenko@Gmail.com ' }), true);
  check('7b isAdminUser(flag true) → true', isAdminUser({ isAdmin: true, email: 'someone@x.com' }), true);
  check('7c isAdminUser(random) → false', isAdminUser({ isAdmin: false, email: 'rando@x.com' }), false);
  check('7d isAdminUser(empty) → false', isAdminUser({}), false);
  check('7e isAdminUser(null) → false (fail-closed)', isAdminUser(null), false);
  check('7f admin-route gate(admin) → 200', adminGate('u_admin'), { status: 200 });
  check('7g admin-route gate(non-admin payer) → 403 BLOCKED', adminGate('u_active'), { status: 403 });
  check('7h admin-route gate(free-access user) → 403 (free ≠ admin)', adminGate('u_free'), { status: 403 });

  // Render results table
  const w = (s, n) => String(s).padEnd(n);
  console.log('\n' + w('RESULT', 6) + '| ' + w('CASE', 46) + '| ' + w('EXPECTED', 42) + '| ACTUAL');
  console.log('-'.repeat(140));
  for (const r of rows) {
    console.log(w(r.result, 6) + '| ' + w(r.label, 46) + '| ' + w(r.expected, 42) + '| ' + r.actual);
  }
  console.log('-'.repeat(140));
  console.log(`\n${pass} passed, ${fail} failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
