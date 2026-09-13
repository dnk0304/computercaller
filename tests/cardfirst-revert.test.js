// Proof for dispatch forge/cardfirst-revert (2026-09-13): retiring the no-card
// free tier behind the FREE_TIER flag, with a grandfather carve-out for the
// accounts that signed up while it was advertised.
//
// THE OBLIGATION THIS FILE EXISTS TO DISCHARGE
//   Exactly ONE population may change behaviour when FREE_TIER flips: a user
//   with NO Subscription row who is NOT grandfathered and NOT privileged.
//   EVERY other population — the live payer, the 6 trialists, the comped
//   internal rows, admin, the Play reviewer, free-access grants, expired and
//   trial-expired users — must be BYTE-IDENTICAL in both flag states. So every
//   case below is asserted TWICE, once per state, and the flag-invariant cases
//   are additionally asserted to be deep-equal across the two.
//
// Uses the REAL runtime source of truth (lib/entitlement-core.js), never a
// mirror, so these assertions cannot drift from production. The flag is read
// from process.env at CALL time, which is what lets one process exercise both
// states. Runner-less (repo convention).
//   Run: node tests/cardfirst-revert.test.js
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo runner-less CJS convention. */
const assert = require('node:assert').strict;
const { evaluateEntitlement } = require('../lib/entitlement-core.js');
const { isFreeTierEnabled } = require('../lib/freeTierMode-core.js');

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

const NOW = new Date('2026-09-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** The 4 decision fields + the resolved tier — everything a gate acts on. */
function ev(input) {
  const r = evaluateEntitlement(input, NOW);
  return {
    allowed: r.allowed,
    state: r.state,
    reason: r.reason,
    trialDaysLeft: r.trialDaysLeft,
    tier: r.tier,
  };
}

function withFlag(value, fn) {
  const prev = process.env.FREE_TIER;
  if (value === undefined) delete process.env.FREE_TIER;
  else process.env.FREE_TIER = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FREE_TIER;
    else process.env.FREE_TIER = prev;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE FLAG READER ITSELF
//    The fail-safe direction is load-bearing: an unrecognised or empty value
//    must resolve to ON (today's behaviour), never to a silent mass-deny.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── FREE_TIER flag semantics ──');
eq('unset → ON (code default)', withFlag(undefined, isFreeTierEnabled), true);
eq('empty string → ON', withFlag('', isFreeTierEnabled), true);
eq('whitespace → ON', withFlag('   ', isFreeTierEnabled), true);
for (const v of ['on', 'ON', 'true', 'True', '1', 'yes', ' on ']) {
  eq(`"${v}" → ON`, withFlag(v, isFreeTierEnabled), true);
}
for (const v of ['off', 'OFF', 'false', 'False', '0', 'no', ' off ']) {
  eq(`"${v}" → OFF`, withFlag(v, isFreeTierEnabled), false);
}
// The whole point of the fail-safe: a fat-fingered value keeps the CURRENT
// behaviour rather than locking a live population out of an app they can use.
for (const v of ['disabled', 'none', 'nope', 'ofF!', 'undefined', 'null']) {
  eq(`unrecognised "${v}" → ON (fail-safe)`, withFlag(v, isFreeTierEnabled), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. EVERY POPULATION, IN BOTH FLAG STATES
// ═══════════════════════════════════════════════════════════════════════════

// ── Populations that MUST NOT change. Each is {name, input, expected}. ──────
const INVARIANT = [
  {
    name: 'admin (Dennis)',
    input: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
    expected: { allowed: true, state: 'admin', reason: 'admin', trialDaysLeft: null, tier: 'pro' },
  },
  {
    // Play-review blocker. The reviewer account is how Google's testers see the
    // app; a lockout here is a store rejection, not a bug report.
    name: 'reviewer allowlist (Play review)',
    input: { isAdmin: false, email: 'reviewer@computercaller.com', subscription: null },
    expected: {
      allowed: true, state: 'allowlisted', reason: 'entitlement_allowlist',
      trialDaysLeft: null, tier: 'pro',
    },
  },
  {
    name: 'reviewer allowlist is case-insensitive',
    input: { isAdmin: false, email: 'Reviewer@ComputerCaller.com', subscription: null },
    expected: {
      allowed: true, state: 'allowlisted', reason: 'entitlement_allowlist',
      trialDaysLeft: null, tier: 'pro',
    },
  },
  {
    name: 'free-access grant',
    input: { isAdmin: false, email: 'comped@x.com', freeAccess: true, subscription: null },
    expected: {
      allowed: true, state: 'free_access', reason: 'free_access',
      trialDaysLeft: null, tier: 'pro',
    },
  },
  {
    // RISK 1 in the brief: the one real paying customer. Sendy's row shape —
    // active, grandfathered (pre-2026-08-17), converted 2026-08-11, period end
    // 2026-10-10, planId null (he bought before the column existed).
    name: 'Sendy — real payer, active + grandfathered, planId null',
    input: {
      isAdmin: false,
      email: 'sendyfeldheim@gmail.com',
      subscription: {
        status: 'active',
        trialEndsAt: new Date('2026-08-18T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-10T00:00:00Z'),
        planId: null,
        grandfathered: true,
      },
    },
    expected: {
      allowed: true, state: 'active', reason: 'active_subscription',
      trialDaysLeft: null, tier: 'solo',
    },
  },
  {
    // RISK 2: comped internal rows — currentPeriodEnd 2099, no whopMembershipId.
    name: 'comped internal row (currentPeriodEnd 2099) stays active',
    input: {
      isAdmin: false,
      email: 'internal@computercaller.com',
      subscription: {
        status: 'active',
        trialEndsAt: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
        planId: null,
        grandfathered: false,
      },
    },
    expected: {
      allowed: true, state: 'active', reason: 'active_subscription',
      trialDaysLeft: null, tier: 'solo',
    },
  },
  {
    name: 'open-ended active (currentPeriodEnd null)',
    input: {
      isAdmin: false,
      email: 'openended@x.com',
      subscription: {
        status: 'active', trialEndsAt: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: null, planId: null, grandfathered: false,
      },
    },
    expected: {
      allowed: true, state: 'active', reason: 'active_subscription',
      trialDaysLeft: null, tier: 'solo',
    },
  },
  {
    // RISK 1: the 6 trialists. New (non-grandfathered) row → limited 'trial'.
    name: 'trialist (new row) — limited trial tier',
    input: {
      isAdmin: false,
      email: 'trialist@x.com',
      subscription: {
        status: 'trial', trialEndsAt: new Date(NOW.getTime() + 5 * DAY),
        currentPeriodEnd: null, planId: null, grandfathered: false,
      },
    },
    expected: {
      allowed: true, state: 'trialing', reason: 'trial_active',
      trialDaysLeft: 5, tier: 'trial',
    },
  },
  {
    name: 'trialist (grandfathered row) — frozen full tier',
    input: {
      isAdmin: false,
      email: 'oldtrial@x.com',
      subscription: {
        status: 'trial', trialEndsAt: new Date(NOW.getTime() + 2 * DAY),
        currentPeriodEnd: null, planId: null, grandfathered: true,
      },
    },
    expected: {
      allowed: true, state: 'trialing', reason: 'trial_active',
      trialDaysLeft: 2, tier: 'solo',
    },
  },
  {
    // FAIL-CLOSED on an unknown plan: a paying user must never inherit daily
    // caps, and must never be handed an unlimited tier we did not sell.
    name: 'unknown planId fails closed to solo (never free, never pro)',
    input: {
      isAdmin: false,
      email: 'mystery@x.com',
      subscription: {
        status: 'active', trialEndsAt: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY),
        planId: 'plan_THIS_DOES_NOT_EXIST', grandfathered: false,
      },
    },
    expected: {
      allowed: true, state: 'active', reason: 'active_subscription',
      trialDaysLeft: null, tier: 'solo',
    },
  },
  {
    name: 'trial_expired stays denied',
    input: {
      isAdmin: false,
      email: 'lapsed@x.com',
      subscription: {
        status: 'trial', trialEndsAt: new Date(NOW.getTime() - DAY),
        currentPeriodEnd: null, planId: null, grandfathered: false,
      },
    },
    expected: {
      allowed: false, state: 'trial_expired', reason: 'trial_expired',
      trialDaysLeft: 0, tier: 'solo',
    },
  },
  {
    name: 'cancelled/expired stays denied',
    input: {
      isAdmin: false,
      email: 'churned@x.com',
      subscription: {
        status: 'cancelled', trialEndsAt: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: new Date(NOW.getTime() - DAY), planId: null, grandfathered: false,
      },
    },
    expected: {
      allowed: false, state: 'expired', reason: 'not_entitled_status_cancelled',
      trialDaysLeft: null, tier: 'solo',
    },
  },
  {
    // A grandfathered FREE-TIER user who later subscribes must be judged on the
    // subscription, not the User column — rule (3) is never reached for them.
    name: 'grandfathered flag is INERT once a subscription row exists',
    input: {
      isAdmin: false,
      email: 'converted@x.com',
      freeTierGrandfathered: true,
      subscription: {
        status: 'trial', trialEndsAt: new Date(NOW.getTime() - DAY),
        currentPeriodEnd: null, planId: null, grandfathered: false,
      },
    },
    expected: {
      allowed: false, state: 'trial_expired', reason: 'trial_expired',
      trialDaysLeft: 0, tier: 'solo',
    },
  },
];

for (const state of ['on', 'off']) {
  console.log(`\n── Flag-INVARIANT populations · FREE_TIER=${state} ──`);
  withFlag(state, () => {
    for (const c of INVARIANT) eq(`[${state}] ${c.name}`, ev(c.input), c.expected);
  });
}

// The strongest form of the no-disturbance obligation: not just "each matches
// its expectation" but "the two flag states produce the identical object".
console.log('\n── Flag-invariance, asserted across the two states ──');
for (const c of INVARIANT) {
  const on = withFlag('on', () => ev(c.input));
  const off = withFlag('off', () => ev(c.input));
  eq(`identical in both states: ${c.name}`, off, on);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE ONE POPULATION THAT DOES CHANGE — no subscription row
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── No-subscription users ──');

const NEW_USER = { isAdmin: false, email: 'brand-new@x.com', subscription: null };
const GRANDFATHERED = {
  isAdmin: false, email: 'early-adopter@x.com', freeTierGrandfathered: true, subscription: null,
};

// FREE_TIER on — today's behaviour, byte-for-byte, for BOTH of them.
withFlag('on', () => {
  eq('[on] new user → free_tier (unchanged)', ev(NEW_USER), {
    allowed: true, state: 'free_tier', reason: 'free_tier', trialDaysLeft: null, tier: 'free',
  });
  eq('[on] grandfathered user → free_tier (unchanged)', ev(GRANDFATHERED), {
    allowed: true, state: 'free_tier', reason: 'free_tier', trialDaysLeft: null, tier: 'free',
  });
});
// Unset must be identical to explicit "on" — reversibility by construction.
eq('[unset] new user identical to [on]', withFlag(undefined, () => ev(NEW_USER)),
  withFlag('on', () => ev(NEW_USER)));

// FREE_TIER off — the card-first gate.
withFlag('off', () => {
  eq('[off] new user → needs_subscription, DENIED', ev(NEW_USER), {
    allowed: false, state: 'needs_subscription', reason: 'needs_subscription',
    trialDaysLeft: null, tier: 'solo',
  });
  eq('[off] grandfathered user → still free_tier, ALLOWED', ev(GRANDFATHERED), {
    allowed: true, state: 'free_tier', reason: 'free_tier_grandfathered',
    trialDaysLeft: null, tier: 'free',
  });
  // A grandfathered user keeps the free CAPS, not an upgrade — the carve-out
  // preserves what they had, it does not hand them a paid tier.
  const full = evaluateEntitlement(GRANDFATHERED, NOW);
  eq('[off] grandfathered keeps the free tier caps', full.tier, 'free');
  ok('[off] grandfathered limits are the free limit set', full.limits && full.limits.callsPerDay > 0);

  // Explicit false and undefined must both mean NOT grandfathered — the
  // documented default direction (absent ⇒ new-world row).
  eq('[off] freeTierGrandfathered:false → denied',
    ev({ ...NEW_USER, freeTierGrandfathered: false }).state, 'needs_subscription');
  eq('[off] freeTierGrandfathered:undefined → denied',
    ev({ ...NEW_USER, freeTierGrandfathered: undefined }).state, 'needs_subscription');
  // Only a strict `true` grandfathers. A truthy-but-wrong value (a string from
  // a raw query, say) must not silently reopen the free tier.
  eq('[off] freeTierGrandfathered:"true" (string) → denied',
    ev({ ...NEW_USER, freeTierGrandfathered: 'true' }).state, 'needs_subscription');

  // Privileged admits outrank the flag even when NOT grandfathered — this is
  // the no-lockout guarantee, re-asserted at the exact branch the flag touches.
  eq('[off] admin with no subscription is still admitted',
    ev({ isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null }).allowed, true);
  eq('[off] reviewer with no subscription is still admitted',
    ev({ isAdmin: false, email: 'reviewer@computercaller.com', subscription: null }).allowed, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. needs_subscription must REDIRECT, not fail open
//    proxy.ts redirects on `!allowed && !isEntitlementIndeterminate(ent)`. If
//    the new reason were treated as indeterminate, the gate would fail OPEN and
//    the card-first flip would silently do nothing.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── needs_subscription is a verdict, not a blip ──');
const { isEntitlementIndeterminate } = require('../lib/entitlement-core.js');
withFlag('off', () => {
  const r = evaluateEntitlement(NEW_USER, NOW);
  eq('needs_subscription is NOT indeterminate (proxy will redirect)',
    isEntitlementIndeterminate(r), false);
  ok('needs_subscription is denied', r.allowed === false);
});

console.log(`\n  ${passed} assertions passed.\n`);
