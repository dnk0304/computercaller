// Unit tests for the 3-tier feature-gating core (2026-07-27, dispatch
// feature/tier-gating):
//   • lib/tiers-core.js       — plan_id → tier → limit-set mapping + since-floor
//   • lib/entitlement-core.js — tier/limits decoration on the entitlement result
//   • the GET /api/entitlement contract SHAPE (mirrored — the route pulls
//     @/lib/db which can't be type-stripped standalone, so we build the response
//     the exact way the route does and assert its shape, per the repo's
//     runner-less mirror convention).
//
// Runner-less by design (repo convention — no Jest/Vitest). Both core modules
// are plain CJS with no `@/` alias and no Prisma at import time, so they require
// cleanly here. Run directly:
//
//   node tests/tier-gating.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

const assert = require('node:assert').strict;

const {
  PLAN_IDS,
  TIER_LIMITS,
  planIdToTier,
  limitsForTier,
  syncSinceFloorMs,
} = require('../lib/tiers-core.js');
const { evaluateEntitlement } = require('../lib/entitlement-core.js');

const DAY_MS = 24 * 60 * 60 * 1000;
let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
}
function eq(name, a, b) {
  assert.deepStrictEqual(a, b, name);
  passed += 1;
}

// ── 1. planId → tier mapping ────────────────────────────────────────────────
eq('solo plan → solo', planIdToTier(PLAN_IDS.solo), 'solo');
eq('plus plan → plus', planIdToTier(PLAN_IDS.plus), 'plus');
eq('pro plan → pro', planIdToTier(PLAN_IDS.pro), 'pro');
eq('null → solo (safe default)', planIdToTier(null), 'solo');
eq('undefined → solo', planIdToTier(undefined), 'solo');
eq('unknown id → solo', planIdToTier('plan_totally_unknown'), 'solo');
eq('empty string → solo', planIdToTier(''), 'solo');
// The 3 CURRENT ids, pinned against a typo edit. The price in each label is the audit trail:
// Solo $6, Pro $7, Pro+ $9 — Dennis's final answer, corroborated against Whop's product page.
eq('solo id pinned ($6)', PLAN_IDS.solo, 'plan_6DJ4H4iPEQo5X');
eq('plus id pinned ($7, displays "Pro")', PLAN_IDS.plus, 'plan_IvKRyvHtl4Q8w');
eq('pro id pinned ($9, displays "Pro+")', PLAN_IDS.pro, 'plan_h587GLZLlOXP4');

// ⭐ GRANDFATHERING. Every current paying customer sits on the $5 Solo id. If a legacy id stops
// resolving it does NOT error — it falls through the fail-closed default to `solo`. Harmless for a
// legacy Solo subscriber, and a silent demotion for a legacy plus/pro one. Hence explicit tests.
eq('legacy $5 id → solo (grandfathered)', planIdToTier('plan_CGlYdJJr3Btlu'), 'solo');
eq('legacy $7 id → plus', planIdToTier('plan_Ogrl3wQ8GM8zr'), 'plus');
eq('legacy $10 id → pro', planIdToTier('plan_lOhMcnZspvgnm'), 'pro');

// ⛔ THE DUPLICATE-PLAN-ID GUARD. Dennis supplied the same id for two tiers on 2026-08-11 and it
// was caught by eye. A shared id silently grants a $9 customer $7 limits — no error, no log.
// NEGATIVE: a planted duplicate must be refused BY NAME. The real module source is re-compiled
// with the duplicate planted, so this exercises the ACTUAL guard rather than a copy of it.
{
  let code = '';
  try {
    const Module = require('module');
    const fs = require('fs');
    const src = fs
      .readFileSync(require.resolve('../lib/tiers-core.js'), 'utf8')
      .replace("pro: 'plan_h587GLZLlOXP4'", "pro: 'plan_IvKRyvHtl4Q8w'");
    const m = new Module('dup-probe');
    m._compile(src, require.resolve('../lib/tiers-core.js'));
  } catch (e) {
    code = String((e && e.message) || e);
  }
  eq('duplicate plan id is REFUSED by name', code.includes('ERR_TIER_PLAN_ID_COLLISION'), true);
}
// ACCEPT-CONTROL: three distinct ids load fine. Without this the negative above would still pass
// if the guard simply rejected everything.
eq('the three current ids are distinct', new Set([PLAN_IDS.solo, PLAN_IDS.plus, PLAN_IDS.pro]).size, 3);

// ── 2. tier → limit set ─────────────────────────────────────────────────────
eq('solo limits', TIER_LIMITS.solo, {
  templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false,
});
eq('plus limits', TIER_LIMITS.plus, {
  templates: 10, quickReplies: 3, syncRangeMax: '6mo', contactSync: true,
});
eq('pro limits', TIER_LIMITS.pro, {
  templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true,
});
eq('limitsForTier(unknown) → solo', limitsForTier('nope'), TIER_LIMITS.solo);

// ── 3. since-floor (relay sync-range clamp) ─────────────────────────────────
const NOW = 1_800_000_000_000; // fixed epoch-ms for determinism
eq('solo floor = now − 30d', syncSinceFloorMs('solo', NOW), NOW - 30 * DAY_MS);
eq('plus floor = now − 180d', syncSinceFloorMs('plus', NOW), NOW - 180 * DAY_MS);
eq('pro floor = now − 365d', syncSinceFloorMs('pro', NOW), NOW - 365 * DAY_MS);
eq('unknown tier floor = 30d (fail-closed)', syncSinceFloorMs('xxx', NOW), NOW - 30 * DAY_MS);

// ── 4. entitlement decoration: state + planId → tier/limits ─────────────────
const T = NOW;
const nowDate = new Date(T);
const future = new Date(T + 10 * DAY_MS);
const past = new Date(T - 10 * DAY_MS);

function ent(input) {
  return evaluateEntitlement(input, nowDate);
}

// admin / allowlisted → Pro (never gated down), regardless of sub/planId.
let r = ent({ isAdmin: true, email: 'x@y.z', subscription: null });
eq('admin state', r.state, 'admin');
eq('admin → pro tier', r.tier, 'pro');
eq('admin → pro limits', r.limits, TIER_LIMITS.pro);

r = ent({ isAdmin: false, email: 'dennis.kotlenko@gmail.com', subscription: null });
eq('allowlisted state', r.state, 'allowlisted');
eq('allowlisted → pro', r.tier, 'pro');

// active + each planId → that tier.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } });
eq('active+plus state', r.state, 'active');
eq('active+plus → plus tier', r.tier, 'plus');
eq('active+plus → 10 templates', r.limits.templates, 10);

r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.pro } });
eq('active+pro → pro tier', r.tier, 'pro');
eq('active+pro → contactSync', r.limits.contactSync, true);
// `mirroring` was REMOVED 2026-08-11 — it advertised a feature that was never built. Asserted as
// ABSENT rather than deleted from the test, so a reintroduction fails loudly instead of quietly
// re-adding a promise we cannot keep.
eq('pro limits carry NO mirroring field', 'mirroring' in r.limits, false);

// active + null planId → Solo (the backfill rule: legacy $5 buyers).
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: null } });
eq('active+null planId → solo (backfill)', r.tier, 'solo');
eq('active+null → 3 templates', r.limits.templates, 3);

// active + planId absent from select (optional field) → Solo.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future } });
eq('active+missing planId → solo', r.tier, 'solo');

// trialing honors an attached planId (card-first checkout), else Solo.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: PLAN_IDS.plus } });
eq('trialing+plus state', r.state, 'trialing');
eq('trialing+plus → plus tier', r.tier, 'plus');
ok('trialing keeps trialDaysLeft', typeof r.trialDaysLeft === 'number' && r.trialDaysLeft > 0);

r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: null } });
eq('trialing+no plan → solo', r.tier, 'solo');

// non-entitled states → Solo limits, still denied.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: null });
eq('none state', r.state, 'none');
eq('none → solo', r.tier, 'solo');
eq('none denied', r.allowed, false);

r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: past, currentPeriodEnd: null, planId: PLAN_IDS.pro } });
eq('expired trial state', r.state, 'trial_expired');
// Even with a pro planId, an expired trial is denied — but tier still resolves
// off the attached plan (limits are advisory; `allowed:false` is the gate).
eq('trial_expired denied', r.allowed, false);

// ── 5. byte-stability: the original 4 fields are unchanged & present ─────────
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.solo } });
ok('has allowed', typeof r.allowed === 'boolean');
ok('has state', typeof r.state === 'string');
ok('has trialDaysLeft key', 'trialDaysLeft' in r);
ok('has reason', typeof r.reason === 'string');
ok('additive tier', typeof r.tier === 'string');
ok('additive limits', r.limits && typeof r.limits === 'object');

// ── 6. GET /api/entitlement contract SHAPE (mirror) ─────────────────────────
// Build the response object exactly as app/api/entitlement/route.ts does, with
// mock usage counts, and assert the frozen shape Pixel builds against.
function buildEntitlementResponse(entResult, usage) {
  return {
    tier: entResult.tier,
    state: entResult.state,
    allowed: entResult.allowed,
    trialDaysLeft: entResult.trialDaysLeft,
    limits: {
      templates: entResult.limits.templates,
      quickReplies: entResult.limits.quickReplies,
      syncRangeMax: entResult.limits.syncRangeMax,
      contactSync: entResult.limits.contactSync,
    },
    usage: { templates: usage.templates, quickReplies: usage.quickReplies },
  };
}

const resp = buildEntitlementResponse(
  ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } }),
  { templates: 2, quickReplies: 1 },
);
eq('contract top-level keys', Object.keys(resp).sort(), ['allowed', 'limits', 'state', 'tier', 'trialDaysLeft', 'usage']);
eq('contract limits keys (no mirroring)', Object.keys(resp.limits).sort(), ['contactSync', 'quickReplies', 'syncRangeMax', 'templates']);
eq('contract usage keys', Object.keys(resp.usage).sort(), ['quickReplies', 'templates']);
eq('contract tier', resp.tier, 'plus');
eq('contract limits.templates', resp.limits.templates, 10);
eq('contract limits.syncRangeMax', resp.limits.syncRangeMax, '6mo');
eq('contract limits.contactSync', resp.limits.contactSync, true);
// The route no longer projects `mirroring`; assert its ABSENCE so a reintroduction fails.
eq('contract carries NO mirroring', 'mirroring' in resp.limits, false);
eq('contract usage.templates', resp.usage.templates, 2);
ok('contract allowed is boolean', typeof resp.allowed === 'boolean');
ok('contract trialDaysLeft number|null', resp.trialDaysLeft === null || typeof resp.trialDaysLeft === 'number');

// ── 7. relay since-clamp DECISION (mirror of gateBrowserSyncFrame's clamp) ──
// gateBrowserSyncFrame lives in server.js's closure; mirror its since-clamp
// decision against the real syncSinceFloorMs so a change to the floor math is
// caught. If you change the clamp in server.js, update this mirror.
function clampSince(tier, since, now) {
  const floor = syncSinceFloorMs(tier, now);
  return typeof since === 'number' && since < floor ? floor : since;
}
eq('solo clamps a 90d-old since up to 30d floor', clampSince('solo', NOW - 90 * DAY_MS, NOW), NOW - 30 * DAY_MS);
eq('pro allows a 90d-old since (within 1y)', clampSince('pro', NOW - 90 * DAY_MS, NOW), NOW - 90 * DAY_MS);
eq('solo leaves a 1d-old since untouched', clampSince('solo', NOW - DAY_MS, NOW), NOW - DAY_MS);

console.log(`\n✓ tier-gating: ${passed} assertions passed`);
