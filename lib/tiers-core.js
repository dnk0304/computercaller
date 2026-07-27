/**
 * lib/tiers-core.js — the SINGLE runtime source of truth for the
 * "which billing tier is this plan, and what limits does it grant?" decision.
 *
 * WHY THIS FILE IS PLAIN COMMONJS (mirrors lib/entitlement-core.js exactly):
 *   The relay (server.js) is plain Node — NOT transpiled by Next — so it cannot
 *   `import` a `.ts`. The relay must gate contact-sync and sync-range frames by
 *   the caller's tier, and the TS routes (templates cap, /api/entitlement) must
 *   gate by the SAME tier. If the map were duplicated in JS-for-the-relay and
 *   TS-for-the-routes it WOULD drift and silently over/under-grant. So, exactly
 *   like entitlement-core, this is the ONE implementation both worlds consume:
 *     • server.js            → require('./tiers-core.js')       (Node)
 *     • lib/entitlement-core.js → require('./tiers-core.js')    (Node)
 *     • lib/tiers.ts (+ TS routes) → re-export from here        (TS, via .d.ts)
 *
 * WHY IT IS A SEPARATE LAYER FROM lib/syncCaps.ts:
 *   syncCaps.ts is a pure range→ROW-cap map and its own header forbids adding
 *   tier logic inside it. This file IS "the separate layer" that header points
 *   to. NOTE the two are unrelated: syncCaps.RANGE_CAP bounds how many ROWS a
 *   chosen range transfers; TIER_LIMITS.syncRangeMax bounds which range windows
 *   a tier is ALLOWED to pick. Do not conflate them.
 *
 * SAFE DEFAULT: planIdToTier maps the 3 locked plan ids; anything else — an
 * unknown id, null, undefined — resolves to 'solo' (the cheapest tier, least
 * privilege). This is the fail-closed stance: an unrecognized plan can never
 * silently unlock Plus/Pro features.
 */

'use strict';

// The 3 locked Whop plan ids (Dennis, 2026-07-27). Stable identifiers.
const PLAN_IDS = {
  solo: 'plan_CGlYdJJr3Btlu', // $5/mo
  plus: 'plan_Ogrl3wQ8GM8zr', // $7/mo
  pro: 'plan_lOhMcnZspvgnm', // $10/mo
};

/**
 * Per-tier limit set. Locked by Dennis 2026-07-27.
 *   templates     — server-enforced create cap (3 | 10 | 30).
 *   quickReplies  — 5 for every paid tier. D5 (Ken): quick-replies are NOT a
 *                   tier differentiator per Dennis's table — kept at the
 *                   existing paying=5 behavior as a placeholder until/unless
 *                   Dennis specifies per-tier scaling. See FLAG in dispatch.
 *   syncRangeMax  — the widest sync-history window this tier may pick, as a
 *                   syncCaps RangeKey. The relay clamps GET_MESSAGES /
 *                   GET_CALL_LOGS `since` to no older than this window.
 *   contactSync   — may pull the phone's contact book (GET_CONTACTS). Solo: no.
 *   mirroring     — screen-mirroring (Pro). FORWARD NO-OP: the mirroring
 *                   feature does not exist in code yet, so this flag enforces
 *                   nothing today — it is returned in the contract so the UI /
 *                   pricing can advertise it and so enforcement is one wire-up
 *                   away once the feature ships. Do NOT invent mirroring here.
 * @typedef {'solo'|'plus'|'pro'} Tier
 */
const TIER_LIMITS = {
  solo: { templates: 3, quickReplies: 5, syncRangeMax: '30d', contactSync: false, mirroring: false },
  plus: { templates: 10, quickReplies: 5, syncRangeMax: '6mo', contactSync: true, mirroring: false },
  pro: { templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true, mirroring: true },
};

// syncRangeMax RangeKey → window length in days. Used ONLY by the relay
// since-clamp (server.js) to derive the oldest timestamp a tier may request.
// Kept here (not in syncCaps.ts) because it is tier-window logic, not a row
// cap. '3mo' is included for completeness though no tier currently uses it.
const SYNC_RANGE_WINDOW_DAYS = {
  '30d': 30,
  '3mo': 90,
  '6mo': 180,
  '1yr': 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a Whop plan id to a billing tier. The 3 locked ids map to their tier;
 * EVERYTHING else — an unknown id, null, undefined, empty string — maps to
 * 'solo' (safe default; least privilege).
 * @param {string|null|undefined} planId
 * @returns {'solo'|'plus'|'pro'}
 */
function planIdToTier(planId) {
  if (planId === PLAN_IDS.plus) return 'plus';
  if (planId === PLAN_IDS.pro) return 'pro';
  return 'solo';
}

/**
 * The limit set for a tier. Unknown tier → solo limits (defensive).
 * @param {string} tier
 * @returns {{templates:number, quickReplies:number, syncRangeMax:string, contactSync:boolean, mirroring:boolean}}
 */
function limitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.solo;
}

/**
 * The oldest epoch-ms timestamp a tier may request for a bulk sync, i.e.
 * `now - syncRangeMax window`. The relay clamps an incoming `since` UP to this
 * floor so a Solo user cannot pull messages/call-logs older than 30 days.
 * Fail-closed: an unknown tier resolves to the Solo (narrowest, 30d) window.
 * @param {string} tier
 * @param {number} [nowMs]
 * @returns {number} epoch-ms floor
 */
function syncSinceFloorMs(tier, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const key = limitsForTier(tier).syncRangeMax;
  const days = SYNC_RANGE_WINDOW_DAYS[key] != null ? SYNC_RANGE_WINDOW_DAYS[key] : 30;
  return now - days * DAY_MS;
}

module.exports = {
  PLAN_IDS,
  TIER_LIMITS,
  SYNC_RANGE_WINDOW_DAYS,
  planIdToTier,
  limitsForTier,
  syncSinceFloorMs,
};
