// Unit tests for the tier feature-gating core, updated 2026-08-17 for the
// $5-promoted / $7-hidden + LIMITED-TRIAL pricing switch (dispatch
// forge/pricing-trial-limited):
//   • lib/tiers-core.js       — NEW + GRANDFATHERED plan→tier + limit-set maps,
//                               since-floor, upgrade-path signal
//   • lib/entitlement-core.js — tier/limits/grandfathered/upgrade decoration,
//                               incl. the new limited-trial special-case
//   • the GET /api/entitlement contract SHAPE (mirrored)
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/tier-gating.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this test targets the
   plain-CJS tier/entitlement core (see lib/tiers-core.js header) and follows the
   repo's runner-less CJS test convention. */

const assert = require('node:assert').strict;

const {
  PLAN_IDS,
  PROMOTED_PLAN_ID,
  TIER_LIMITS,
  GRANDFATHERED_TIER_LIMITS,
  planIdToTier,
  planIdToTierGrandfathered,
  limitsForTier,
  syncSinceFloorMs,
  syncSinceFloorMsFromLimits,
  upgradePathForTier,
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

// ── 1. NEW-world planId → tier ──────────────────────────────────────────────
eq('promoted $5 id → plus', planIdToTier(PLAN_IDS.plus), 'plus');
eq('promoted constant is the plus id', PROMOTED_PLAN_ID, PLAN_IDS.plus);
eq('hidden $7 id → pro', planIdToTier(PLAN_IDS.pro), 'pro');
eq('hidden $9 id → pro (fallback)', planIdToTier('plan_h587GLZLlOXP4'), 'pro');
eq('null → solo (safe default)', planIdToTier(null), 'solo');
eq('undefined → solo', planIdToTier(undefined), 'solo');
eq('unknown id → solo', planIdToTier('plan_totally_unknown'), 'solo');
eq('empty string → solo', planIdToTier(''), 'solo');
// The 2 CURRENT purchasable ids, pinned against a typo edit. Price = audit trail.
eq('plus id pinned ($5 promoted, live plan)', PLAN_IDS.plus, 'plan_CGlYdJJr3Btlu');
eq('pro id pinned ($7 hidden upgrade)', PLAN_IDS.pro, 'plan_IvKRyvHtl4Q8w');
eq('the $6 plan is NOT promoted → solo fallback', planIdToTier('plan_6DJ4H4iPEQo5X'), 'solo');
eq('the two purchasable ids are distinct', new Set([PLAN_IDS.plus, PLAN_IDS.pro]).size, 2);

// ── 1b. GRANDFATHERED-world planId → tier (frozen pre-launch resolution) ─────
eq('gf: old $6 solo id → solo', planIdToTierGrandfathered('plan_6DJ4H4iPEQo5X'), 'solo');
eq('gf: old $7 id → plus', planIdToTierGrandfathered('plan_IvKRyvHtl4Q8w'), 'plus');
eq('gf: old $9 id → pro', planIdToTierGrandfathered('plan_h587GLZLlOXP4'), 'pro');
eq('gf: legacy $5 id → solo', planIdToTierGrandfathered('plan_CGlYdJJr3Btlu'), 'solo');
eq('gf: legacy $7 id → plus', planIdToTierGrandfathered('plan_Ogrl3wQ8GM8zr'), 'plus');
eq('gf: legacy $10 id → pro', planIdToTierGrandfathered('plan_lOhMcnZspvgnm'), 'pro');
eq('gf: unknown → solo', planIdToTierGrandfathered('nope'), 'solo');

// ⛔ THE DUPLICATE-PLAN-ID GUARD (NEW purchasable set). A shared id silently
// grants the wrong tier. Plant a duplicate in the real source and require the
// guard to refuse it BY NAME.
{
  let code = '';
  try {
    const Module = require('module');
    const fs = require('fs');
    const src = fs
      .readFileSync(require.resolve('../lib/tiers-core.js'), 'utf8')
      .replace("pro: 'plan_IvKRyvHtl4Q8w'", "pro: PROMOTED_PLAN_ID");
    const m = new Module('dup-probe');
    m._compile(src, require.resolve('../lib/tiers-core.js'));
  } catch (e) {
    code = String((e && e.message) || e);
  }
  eq('duplicate plan id is REFUSED by name', code.includes('ERR_TIER_PLAN_ID_COLLISION'), true);
}

// ── 2. tier → limit set (NEW world) ─────────────────────────────────────────
// FREE TIER (forge/free-tier-p1): 6-key set, carries the two daily-cap fields
// (callsPerDay/messagesPerDay) that mark it as relay-metered. No paid tier does.
eq('free limits (daily-capped entry point)', TIER_LIMITS.free, {
  templates: 0, quickReplies: 0, syncRangeMax: '14d', contactSync: true, callsPerDay: 20, messagesPerDay: 10,
});
eq('free carries callsPerDay', TIER_LIMITS.free.callsPerDay, 20);
eq('free carries messagesPerDay', TIER_LIMITS.free.messagesPerDay, 10);
eq('solo has NO callsPerDay (unlimited)', 'callsPerDay' in TIER_LIMITS.solo, false);
eq('plus has NO callsPerDay (unlimited)', 'callsPerDay' in TIER_LIMITS.plus, false);
eq('pro has NO messagesPerDay (unlimited)', 'messagesPerDay' in TIER_LIMITS.pro, false);
eq('trial has NO callsPerDay (unlimited)', 'callsPerDay' in TIER_LIMITS.trial, false);
eq('trial limits (limited)', TIER_LIMITS.trial, {
  templates: 1, quickReplies: 0, syncRangeMax: '3d', contactSync: true, calls: true, notifications: true,
});
eq('solo limits (legacy, unchanged)', TIER_LIMITS.solo, {
  templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false,
});
eq('plus = $5 promoted limits', TIER_LIMITS.plus, {
  templates: 7, quickReplies: 3, syncRangeMax: '3mo', contactSync: true,
});
eq('pro = $7 hidden limits', TIER_LIMITS.pro, {
  templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true,
});
// ⭐ contact-sync is ungated: trial ON, $5 ON, $7 ON (only legacy solo false).
eq('trial contactSync ON', TIER_LIMITS.trial.contactSync, true);
eq('plus contactSync ON', TIER_LIMITS.plus.contactSync, true);
eq('pro contactSync ON', TIER_LIMITS.pro.contactSync, true);
// solo/plus/pro carry NO calls/notifications keys (trial-only descriptive flags).
eq('plus has no calls key', 'calls' in TIER_LIMITS.plus, false);
eq('limitsForTier(unknown) → solo', limitsForTier('nope'), TIER_LIMITS.solo);

// ── 2b. GRANDFATHERED limit set (frozen) ────────────────────────────────────
eq('gf plus keeps 10/3/6mo', GRANDFATHERED_TIER_LIMITS.plus, {
  templates: 10, quickReplies: 3, syncRangeMax: '6mo', contactSync: true,
});
eq('gf has no trial key', 'trial' in GRANDFATHERED_TIER_LIMITS, false);

// ── 3. since-floor ──────────────────────────────────────────────────────────
const NOW = 1_800_000_000_000;
eq('free floor = now − 14d', syncSinceFloorMs('free', NOW), NOW - 14 * DAY_MS);
eq('trial floor = now − 3d', syncSinceFloorMs('trial', NOW), NOW - 3 * DAY_MS);
eq('solo floor = now − 30d', syncSinceFloorMs('solo', NOW), NOW - 30 * DAY_MS);
eq('plus floor = now − 90d (3mo)', syncSinceFloorMs('plus', NOW), NOW - 90 * DAY_MS);
eq('pro floor = now − 365d', syncSinceFloorMs('pro', NOW), NOW - 365 * DAY_MS);
eq('unknown tier floor = 30d (fail-closed)', syncSinceFloorMs('xxx', NOW), NOW - 30 * DAY_MS);
// The relay uses the limits-based variant so a GRANDFATHERED plus (6mo) is honored.
eq('gf-plus limits floor = 180d', syncSinceFloorMsFromLimits(GRANDFATHERED_TIER_LIMITS.plus, NOW), NOW - 180 * DAY_MS);
eq('trial limits floor = 3d', syncSinceFloorMsFromLimits(TIER_LIMITS.trial, NOW), NOW - 3 * DAY_MS);

// ── 3b. upgrade-path signal ─────────────────────────────────────────────────
eq('free → subscribe ($5)', upgradePathForTier('free'), { reason: 'free-limit-hit', cta: 'subscribe', targetTier: 'plus' });
eq('trial → activate $5', upgradePathForTier('trial'), { reason: 'trial-limit-hit', cta: 'activate-5', targetTier: 'plus' });
eq('plus → upgrade $7', upgradePathForTier('plus'), { reason: 'plus-limit-hit', cta: 'upgrade-7', targetTier: 'pro' });
eq('pro → nowhere up', upgradePathForTier('pro'), { reason: null, cta: null, targetTier: null });
eq('solo (gf) → nowhere up', upgradePathForTier('solo'), { reason: null, cta: null, targetTier: null });

// ── 4. entitlement decoration ───────────────────────────────────────────────
const T = NOW;
const nowDate = new Date(T);
const future = new Date(T + 10 * DAY_MS);
const past = new Date(T - 10 * DAY_MS);
function ent(input) {
  return evaluateEntitlement(input, nowDate);
}

// admin / allowlisted → Pro (never gated down), regardless of sub/planId.
let r = ent({ isAdmin: true, email: 'x@y.z', subscription: null });
eq('admin → pro tier', r.tier, 'pro');
eq('admin → pro limits', r.limits, TIER_LIMITS.pro);
eq('admin not grandfathered', r.grandfathered, false);
eq('admin no upgrade path', r.upgrade.reason, null);

r = ent({ isAdmin: false, email: 'dennis.kotlenko@gmail.com', subscription: null });
eq('allowlisted → pro', r.tier, 'pro');

// ⭐ NEW LIMITED TRIAL: a trialing NEW row → 'trial' tier REGARDLESS of planId,
// still allowed:true, caps are the trial floor, upgrade = activate-$5.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: PLAN_IDS.pro } });
eq('new trialing state', r.state, 'trialing');
eq('new trialing → trial tier (ignores planId)', r.tier, 'trial');
eq('new trialing allowed:true', r.allowed, true);
eq('new trialing → 1 template', r.limits.templates, 1);
eq('new trialing → 0 quick-replies', r.limits.quickReplies, 0);
eq('new trialing → 3d sync', r.limits.syncRangeMax, '3d');
eq('new trialing → contacts ON', r.limits.contactSync, true);
eq('new trialing → activate-$5 upgrade', r.upgrade.cta, 'activate-5');
ok('new trialing keeps trialDaysLeft', typeof r.trialDaysLeft === 'number' && r.trialDaysLeft > 0);

// $5 active → plus (7 tpl / 3 qr / 3mo), upgrade = upgrade-$7.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } });
eq('$5 active → plus tier', r.tier, 'plus');
eq('$5 → 7 templates', r.limits.templates, 7);
eq('$5 → 3 quick-replies', r.limits.quickReplies, 3);
eq('$5 → upgrade-$7', r.upgrade.cta, 'upgrade-7');

// $7 active → pro (30 / 5 / 1yr), nowhere up.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.pro } });
eq('$7 active → pro tier', r.tier, 'pro');
eq('$7 → 30 templates', r.limits.templates, 30);
eq('$7 → no upgrade path', r.upgrade.reason, null);

// ── 4b. GRANDFATHERED rows keep pre-launch behavior ─────────────────────────
// A grandfathered trialing row → its plan's FULL tier (not the limited trial).
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: 'plan_IvKRyvHtl4Q8w', grandfathered: true } });
eq('gf trialing → plan full tier (plus)', r.tier, 'plus');
eq('gf trialing allowed', r.allowed, true);
eq('gf trialing → 10 templates (frozen plus)', r.limits.templates, 10);
eq('gf trialing → 6mo sync (frozen)', r.limits.syncRangeMax, '6mo');
eq('gf flag surfaced', r.grandfathered, true);

// A grandfathered active $6-Solo row keeps solo (3/1/30d, contacts OFF).
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: 'plan_6DJ4H4iPEQo5X', grandfathered: true } });
eq('gf $6 active → solo tier', r.tier, 'solo');
eq('gf solo → 3 templates', r.limits.templates, 3);
eq('gf solo → contacts OFF (unchanged)', r.limits.contactSync, false);

// The live $5 plan id (plan_CGlYdJJr3Btlu) on a NEW row is the promoted plus —
// while a GRANDFATHERED row on the SAME id stays solo (its frozen tier). This is
// the flag, not the plan id, driving the world.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: 'plan_CGlYdJJr3Btlu' } });
eq('new $5 active → plus (promoted)', r.tier, 'plus');
eq('new $5 → 7 templates', r.limits.templates, 7);
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: 'plan_CGlYdJJr3Btlu', grandfathered: true } });
eq('gf $5 (same id) → solo (frozen)', r.tier, 'solo');

// ── 4c. FREE TIER: no subscription → ALLOWED entry point (forge/free-tier-p1) ─
// PREVIOUSLY this was {allowed:false, state:'none'}. Free tier makes a logged-in
// user with NO subscription the no-card entry point: allowed:true, state
// 'free_tier', tier 'free', with daily outbound caps. Updated DELIBERATELY.
r = ent({ isAdmin: false, email: 'a@b.c', subscription: null });
eq('no-sub → allowed (free tier)', r.allowed, true);
eq('no-sub → free_tier state', r.state, 'free_tier');
eq('no-sub → free tier', r.tier, 'free');
eq('free → 0 templates', r.limits.templates, 0);
eq('free → 0 quick-replies', r.limits.quickReplies, 0);
eq('free → 14d sync', r.limits.syncRangeMax, '14d');
eq('free → contacts ON', r.limits.contactSync, true);
eq('free → 20 calls/day', r.limits.callsPerDay, 20);
eq('free → 10 messages/day', r.limits.messagesPerDay, 10);
eq('free → subscribe upgrade', r.upgrade, { reason: 'free-limit-hit', cta: 'subscribe', targetTier: 'plus' });
eq('free not grandfathered', r.grandfathered, false);
eq('free → null trialDaysLeft', r.trialDaysLeft, null);

r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'trial', trialEndsAt: past, currentPeriodEnd: null, planId: PLAN_IDS.pro } });
eq('expired trial state', r.state, 'trial_expired');
eq('trial_expired denied', r.allowed, false);

// ── 5. byte-stability: original 4 fields present ────────────────────────────
r = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } });
ok('has allowed', typeof r.allowed === 'boolean');
ok('has state', typeof r.state === 'string');
ok('has trialDaysLeft key', 'trialDaysLeft' in r);
ok('has reason', typeof r.reason === 'string');
ok('additive tier', typeof r.tier === 'string');
ok('additive limits', r.limits && typeof r.limits === 'object');
ok('additive grandfathered', typeof r.grandfathered === 'boolean');
ok('additive upgrade', r.upgrade && typeof r.upgrade === 'object');

// ── 6. GET /api/entitlement contract SHAPE (mirror) ─────────────────────────
function buildEntitlementResponse(entResult, usage) {
  return {
    tier: entResult.tier,
    state: entResult.state,
    allowed: entResult.allowed,
    trialDaysLeft: entResult.trialDaysLeft,
    grandfathered: entResult.grandfathered,
    limits: {
      templates: entResult.limits.templates,
      quickReplies: entResult.limits.quickReplies,
      syncRangeMax: entResult.limits.syncRangeMax,
      contactSync: entResult.limits.contactSync,
    },
    upgrade: entResult.upgrade,
    usage: { templates: usage.templates, quickReplies: usage.quickReplies },
  };
}
const resp = buildEntitlementResponse(
  ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } }),
  { templates: 2, quickReplies: 1 },
);
eq('contract top-level keys', Object.keys(resp).sort(), ['allowed', 'grandfathered', 'limits', 'state', 'tier', 'trialDaysLeft', 'upgrade', 'usage']);
eq('contract limits keys', Object.keys(resp.limits).sort(), ['contactSync', 'quickReplies', 'syncRangeMax', 'templates']);
eq('contract upgrade keys', Object.keys(resp.upgrade).sort(), ['cta', 'reason', 'targetTier']);
eq('contract tier', resp.tier, 'plus');
eq('contract limits.templates ($5=7)', resp.limits.templates, 7);
eq('contract limits.syncRangeMax ($5=3mo)', resp.limits.syncRangeMax, '3mo');
eq('contract limits.contactSync', resp.limits.contactSync, true);
eq('contract carries NO mirroring', 'mirroring' in resp.limits, false);

// ── 7. relay since-clamp DECISION (mirror of gateBrowserSyncFrame) ──────────
// The relay clamps from the socket's cached LIMITS (syncSinceFloorMsFromLimits),
// so mirror that — a trial's 3d and a gf-plus's 6mo are honored.
function clampSince(limits, since, now) {
  const floor = syncSinceFloorMsFromLimits(limits, now);
  return typeof since === 'number' && since < floor ? floor : since;
}
eq('trial clamps a 30d-old since up to 3d floor', clampSince(TIER_LIMITS.trial, NOW - 30 * DAY_MS, NOW), NOW - 3 * DAY_MS);
eq('new plus clamps a 120d-old since up to 3mo floor', clampSince(TIER_LIMITS.plus, NOW - 120 * DAY_MS, NOW), NOW - 90 * DAY_MS);
eq('gf plus allows a 120d-old since (within 6mo)', clampSince(GRANDFATHERED_TIER_LIMITS.plus, NOW - 120 * DAY_MS, NOW), NOW - 120 * DAY_MS);
eq('pro allows a 90d-old since (within 1y)', clampSince(TIER_LIMITS.pro, NOW - 90 * DAY_MS, NOW), NOW - 90 * DAY_MS);

// ── 8. FREE TIER 0-caps produce a cap-hit on the FIRST create (§7 of the
//     dispatch). The /api/templates + /api/quick-replies POST handlers reject
//     when `count >= effectiveLimit`, where effectiveLimit === ent.limits
//     .templates / .quickReplies (effectiveTemplateLimit / effectiveQuickReply
//     Limit are pass-throughs). For a free user both limits are 0, so the very
//     first create (count 0) is rejected. Mirror that exact decision here.
{
  const freeEnt = ent({ isAdmin: false, email: 'a@b.c', subscription: null });
  const capHit = (count, limit) => count >= limit; // the route's 409 predicate
  eq('free: first template create is a cap-hit', capHit(0, freeEnt.limits.templates), true);
  eq('free: first quick-reply create is a cap-hit', capHit(0, freeEnt.limits.quickReplies), true);
  eq('free: template upgrade signal is subscribe', freeEnt.upgrade.cta, 'subscribe');
  // A paying $5 user is NOT capped at 0 (regression guard for the predicate).
  const plusEnt = ent({ isAdmin: false, email: 'a@b.c', subscription: { status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus } });
  eq('plus: first template create is allowed', capHit(0, plusEnt.limits.templates), false);
}

console.log(`\n✓ tier-gating: ${passed} assertions passed`);
