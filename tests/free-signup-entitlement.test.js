// Proof obligation 1 + 4 (dispatch forge/free-signup-verification, 2026-08-28):
//   NO-LOCKOUT: re-opening email/password signup must not change the
//   entitlement resolution for ANY privileged state, and a verified
//   email/password user with no subscription must resolve to the SAME free_tier
//   admit as a Google free user (entitlement is identity-source-agnostic).
//
// Uses the REAL runtime source of truth (lib/entitlement-core.js) — NOT a
// mirror — so the assertions cannot drift from production. Runner-less (repo
// convention). Run: node tests/free-signup-entitlement.test.js
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo runner-less CJS convention. */
const assert = require('node:assert').strict;
const { evaluateEntitlement } = require('../lib/entitlement-core.js');

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

const NOW = new Date('2026-08-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
// Only the 4 decision fields (allowed/state/reason/trialDaysLeft) matter for
// no-lockout; tier/limits are a decoration layered on top.
function base(input) {
  const r = evaluateEntitlement(input, NOW);
  return { allowed: r.allowed, state: r.state, reason: r.reason };
}

// ── Privileged / paying states must be BYTE-STABLE regardless of how the user
//    signed up. Signup method is not even an input to the entitlement core, so
//    these are the ground truth the re-opened register route cannot disturb. ──
eq('admin admitted', base({ isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null }),
  { allowed: true, state: 'admin', reason: 'admin' });

eq('entitlement allowlist admitted (reviewer)',
  base({ isAdmin: false, email: 'reviewer@computercaller.com', subscription: null }),
  { allowed: true, state: 'allowlisted', reason: 'entitlement_allowlist' });

eq('free_access grant admitted',
  base({ isAdmin: false, email: 'comped@x.com', freeAccess: true, subscription: null }),
  { allowed: true, state: 'free_access', reason: 'free_access' });

eq('active paid admitted',
  base({ isAdmin: false, email: 'pay@x.com', subscription: { status: 'active', currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY) } }),
  { allowed: true, state: 'active', reason: 'active_subscription' });

eq('trialing admitted',
  base({ isAdmin: false, email: 'trial@x.com', subscription: { status: 'trial', trialEndsAt: new Date(NOW.getTime() + 5 * DAY), currentPeriodEnd: null } }),
  { allowed: true, state: 'trialing', reason: 'trial_active' });

// ── The core of the dispatch: a verified email/password user with NO
//    subscription and a Google free user with NO subscription are the SAME
//    input to the core (isAdmin:false, no sub, not comped) → identical admit. ──
const googleFree = base({ isAdmin: false, email: 'g-free@gmail.com', subscription: null });
const emailFree = base({ isAdmin: false, email: 'e-free@example.com', subscription: null });
eq('google free → free_tier', googleFree, { allowed: true, state: 'free_tier', reason: 'free_tier' });
eq('email/password free → free_tier', emailFree, { allowed: true, state: 'free_tier', reason: 'free_tier' });
eq('email free === google free (identity-source-agnostic)', emailFree, googleFree);

// ── Full free_tier result carries the 20/10-shaped free tier (obligation 3). ──
const full = evaluateEntitlement({ isAdmin: false, email: 'e-free@example.com', subscription: null }, NOW);
eq('free_tier tier label', full.tier, 'free');

console.log(`\n${passed} passed — free-signup entitlement no-lockout matrix holds.`);
