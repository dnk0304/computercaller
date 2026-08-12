// Unit tests for lib/whop-core.js — the PURE membership-selection and
// membership→Subscription mapping rules shared by the reconciliation job
// (lib/whop-reconcile.ts), the one-shot backfill script
// (scripts/backfill-whop-subscription.mjs), and the webhook's identity
// extraction (lib/whop-resolve.ts).
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/whop-reconcile.test.js
//
// Exits non-zero on the first failing assertion.
//
// The fixture is the REAL 2026-08-11 incident, verified live against the Whop
// v5 company API: sendyfeldheim@gmail.com (Whop user user_HbSqIfzhtq1Bg) holds
// TWO memberships on product prod_cyc65yqHR5ilm — a cancelled `trialing` one
// and the live `active` one he actually pays for. Storing the wrong one
// expires a paying customer on 2026-08-18 instead of 2026-09-10.

'use strict';

const assert = require('node:assert').strict;
const core = require('../lib/whop-core.js');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${name} (got ${String(actual)})`);
  console.log(`  PASS  ${name} = ${String(actual)}`);
  passed += 1;
}

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// 0. Export surface.
//
// A handwritten .d.ts does NOT prove the runtime exports exist — `tsc` happily
// type-checks a symbol that module.exports never lists, and the failure only
// shows up at runtime in production. Assert every declared symbol is really
// there and really callable.
// ---------------------------------------------------------------------------
console.log('\n0. export surface (guards lib/whop-core.d.ts against drift)');
const DECLARED = [
  'toEpochMs',
  'extractWhopUserId',
  'extractPayloadEmail',
  'extractPlanId',
  'extractMembershipId',
  'membershipPeriodEndMs',
  'membershipCreatedAtMs',
  'membershipIsValid',
  'membershipCancelAtPeriodEnd',
  'membershipCancellationIntended',
  'pickAuthoritativeMembership',
  'membershipToSubscriptionFields',
];
for (const name of DECLARED) {
  ok(`${name} is exported and callable`, typeof core[name] === 'function');
}
eq(
  'no undeclared exports (the .d.ts is complete)',
  Object.keys(core).filter((k) => !DECLARED.includes(k)),
  [],
);

// ---------------------------------------------------------------------------
// The incident fixture — the exact two-membership shape.
// ---------------------------------------------------------------------------
const TRIAL = {
  id: 'mem_ImMmoRWEIz6SJL',
  status: 'trialing',
  valid: true,
  plan_id: 'plan_CGlYdJJr3Btlu',
  user_id: 'user_HbSqIfzhtq1Bg',
  cancel_at_period_end: true,
  created_at: sec('2026-08-11T05:39:44Z'),
  renewal_period_end: sec('2026-08-18T05:39:44Z'),
};
const PAID = {
  id: 'mem_HPhwHX2wrXsWGV',
  status: 'active',
  valid: true,
  plan_id: 'plan_CGlYdJJr3Btlu',
  user_id: 'user_HbSqIfzhtq1Bg',
  cancel_at_period_end: false,
  created_at: sec('2026-08-11T05:43:15Z'),
  renewal_period_end: sec('2026-09-10T05:43:15Z'),
};

console.log('\n1. pickAuthoritativeMembership — the two-membership incident shape');
eq(
  'picks the live paid membership, not the cancelled trial',
  core.pickAuthoritativeMembership([TRIAL, PAID]).id,
  'mem_HPhwHX2wrXsWGV',
);
eq(
  'order-independent (paid listed first)',
  core.pickAuthoritativeMembership([PAID, TRIAL]).id,
  'mem_HPhwHX2wrXsWGV',
);
// Negative control: prove this test would actually CATCH the naive bug. Whop
// returned the trial first, so "just take the first membership" — the shape of
// the original defect — picks the cancelled trial.
eq('negative control: taking list[0] would pick the trial', [TRIAL, PAID][0].id, 'mem_ImMmoRWEIz6SJL');

// A discriminating case. In the real incident the paid membership happens to
// ALSO be the newest-created, so that fixture alone cannot tell "latest period
// end" apart from "newest created" — a proof window where both hypotheses
// agree proves nothing. Here a trial is started AFTER the paid subscription
// and ends sooner; only the period-end rule survives.
const LATER_SHORTER_TRIAL = {
  ...TRIAL,
  id: 'mem_LATER_TRIAL',
  created_at: sec('2026-08-12T09:00:00Z'), // newest created
  renewal_period_end: sec('2026-08-19T09:00:00Z'), // but ends first
};
eq(
  'discriminating: newest-created loses to latest-period-end',
  core.pickAuthoritativeMembership([PAID, LATER_SHORTER_TRIAL]).id,
  'mem_HPhwHX2wrXsWGV',
);
eq(
  'an INVALID membership never outranks a valid one, however long its period',
  core.pickAuthoritativeMembership([
    PAID,
    { ...TRIAL, id: 'mem_DEAD', valid: false, renewal_period_end: sec('2027-01-01T00:00:00Z') },
  ]).id,
  'mem_HPhwHX2wrXsWGV',
);
eq(
  'all-invalid falls back to the latest-ending one (so churn still reconciles)',
  core.pickAuthoritativeMembership([
    { ...TRIAL, valid: false },
    { ...PAID, valid: false },
  ]).id,
  'mem_HPhwHX2wrXsWGV',
);
eq('empty list → null', core.pickAuthoritativeMembership([]), null);
eq('garbage list → null', core.pickAuthoritativeMembership([null, 'nope', 7]), null);

console.log('\n2. membershipToSubscriptionFields — the paid membership');
const NOW = new Date('2026-08-12T12:00:00Z');
const f = core.membershipToSubscriptionFields(PAID, NOW);
eq('whopMembershipId', f.whopMembershipId, 'mem_HPhwHX2wrXsWGV');
eq('status', f.status, 'active');
eq('planId', f.planId, 'plan_CGlYdJJr3Btlu');
eq('currentPeriodEnd', f.currentPeriodEnd.toISOString(), '2026-09-10T05:43:15.000Z');
eq('cancelAtPeriodEnd', f.cancelAtPeriodEnd, false);
eq('canceledAt stays null on a live, uncancelled sub', f.canceledAt, null);
eq('paymentMethodAttached', f.paymentMethodAttached, true);
eq('convertedAt = membership created_at', f.convertedAt.toISOString(), '2026-08-11T05:43:15.000Z');
eq('trialEndsAt = membership created_at', f.trialEndsAt.toISOString(), '2026-08-11T05:43:15.000Z');

console.log('\n3. membershipToSubscriptionFields — status mapping');
eq(
  'a VALID trialing membership maps to active, never expired (no wrongful lockout)',
  core.membershipToSubscriptionFields(TRIAL, NOW).status,
  'active',
);
eq(
  'invalid + cancellation intended → cancelled (voluntary churn)',
  core.membershipToSubscriptionFields({ ...PAID, valid: false, cancel_at_period_end: true }, NOW).status,
  'cancelled',
);
eq(
  'invalid with no cancellation → expired (involuntary churn)',
  core.membershipToSubscriptionFields({ ...PAID, valid: false }, NOW).status,
  'expired',
);
eq(
  'a dead membership never advertises a future cancellation',
  core.membershipToSubscriptionFields({ ...PAID, valid: false, cancel_at_period_end: true }, NOW)
    .cancelAtPeriodEnd,
  false,
);
eq(
  'no period end → undefined, so a good stored date is never clobbered',
  core.membershipToSubscriptionFields(
    { id: 'mem_X', valid: true, user_id: 'user_X', created_at: sec('2026-08-01T00:00:00Z') },
    NOW,
  ).currentPeriodEnd,
  undefined,
);

console.log('\n4. field extraction across Whop payload generations');
eq('v5 seconds', core.membershipPeriodEndMs({ renewal_period_end: sec('2026-09-10T05:43:15Z') }), Date.parse('2026-09-10T05:43:15Z'));
eq('v1 ISO string', core.membershipPeriodEndMs({ current_period_end: '2026-09-10T05:43:15Z' }), Date.parse('2026-09-10T05:43:15Z'));
eq('v2 expires_at', core.membershipPeriodEndMs({ expires_at: sec('2026-09-10T05:43:15Z') }), Date.parse('2026-09-10T05:43:15Z'));
eq('millisecond guard', core.toEpochMs(1.8e12), 1.8e12);
eq('slim v1: user id from user_id', core.extractWhopUserId({ user_id: 'user_A' }), 'user_A');
eq('legacy: user id from nested user object', core.extractWhopUserId({ user: { id: 'user_B' } }), 'user_B');
eq('email is lowercased', core.extractPayloadEmail({ user: { email: '  Sendy@Example.COM ' } }), 'sendy@example.com');
eq('slim v1 payload carries NO email (the blind spot)', core.extractPayloadEmail({ id: 'mem_X', user_id: 'user_A' }), null);
eq('plan id: plan_id', core.extractPlanId({ plan_id: 'plan_A' }), 'plan_A');
eq('plan id: nested plan object', core.extractPlanId({ plan: { id: 'plan_B' } }), 'plan_B');
eq('plan id: bare plan string', core.extractPlanId({ plan: 'plan_C' }), 'plan_C');
eq('unwraps a {data:{…}} envelope', core.extractMembershipId({ data: { id: 'mem_W' } }), 'mem_W');

console.log(`\nAll ${passed} assertions passed.`);
