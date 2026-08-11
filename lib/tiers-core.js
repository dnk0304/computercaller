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
 * SAFE DEFAULT: planIdToTier maps the 3 current plan ids plus the superseded ones; anything else — an
 * unknown id, null, undefined — resolves to 'solo' (the cheapest tier, least
 * privilege). This is the fail-closed stance: an unrecognized plan can never
 * silently unlock Plus/Pro features.
 */

'use strict';

/**
 * ⚠️⚠️ THE INTERNAL KEY AND THE DISPLAY NAME ARE NOT THE SAME WORD. ⚠️⚠️
 *
 *     internal key    displays as     price
 *     ------------    -----------     -----
 *     solo        →   "Solo"          $6
 *     plus        →   "Pro"           $7
 *     pro         →   "Pro+"          $9
 *
 * Read that twice. Internal `pro` is the TOP tier and displays as "Pro+"; internal `plus` is the
 * MIDDLE tier and displays as "Pro". A reader who sees `pro` and assumes it means the product
 * called "Pro" will grant the wrong limits.
 *
 * The keys deliberately DO NOT change. They are load-bearing in TIER_LIMITS, planIdToTier, the
 * entitlement contract, the relay's gating and the pinned tests — and renaming them risks the
 * fail-closed default (unknown plan → `solo`, least privilege). Display names are a PRESENTATION
 * concern and live at the presentation boundary, not here.
 */

/**
 * Current Whop plan ids, one per tier (Dennis, 2026-08-11).
 *
 * ⭐ THE PRICE IN EACH COMMENT IS THE AUDIT TRAIL, NOT DECORATION. Dennis's first two answers
 * contradicted each other and both contradicted Whop; the mapping below is the one where his final
 * answer AND Whop's own product page agree (Whop reports prod_7eySjdIjH19Vn, the Pro+ $9 product,
 * → plan_h587GLZLlOXP4). Recording the confirmed price beside each id is what lets the next person
 * re-check a mapping without another four-message round trip — see the note on assertNoDuplicate-
 * PlanIds() about what that guard can and cannot catch.
 */
const PLAN_IDS = {
  solo: 'plan_6DJ4H4iPEQo5X', // $6/mo — displays as "Solo"
  plus: 'plan_IvKRyvHtl4Q8w', // $7/mo — displays as "Pro"
  pro: 'plan_h587GLZLlOXP4', // $9/mo — displays as "Pro+"
};

/**
 * Superseded plan ids that MUST keep resolving, so existing subscribers keep their tier.
 *
 * `plan_CGlYdJJr3Btlu` is the $5 Solo plan every current paying customer is on; the price moved to
 * $6 and they are GRANDFATHERED — it stays mapped to `solo` permanently. Migrating anyone is a
 * Whop-side action, deliberately requiring no code change.
 *
 * The other two are the previous $7/$10 ids. They cost nothing to keep and dropping them would
 * silently demote a subscriber to `solo` via the fail-closed default — a fail-SAFE default doing
 * exactly the wrong thing for a paying customer.
 */
const LEGACY_PLAN_IDS = {
  plan_CGlYdJJr3Btlu: 'solo', // $5/mo — grandfathered, keep forever
  plan_Ogrl3wQ8GM8zr: 'plus', // $7/mo — superseded id
  plan_lOhMcnZspvgnm: 'pro', // $10/mo — superseded id
};

/**
 * ⛔ BUILD-TIME GUARD: refuse to load if two tiers share a plan id.
 *
 * Not hypothetical. On 2026-08-11 Dennis supplied the SAME plan id for two different tiers, and it
 * was caught by eye during a four-message clarification. Had it landed, a $9 Pro+ customer would
 * have silently received $7 Pro limits — no error, no log, just a quietly under-served paying
 * subscriber. Throwing at module load makes that unshippable rather than reviewable.
 *
 * ⚠️ WHAT THIS CANNOT CATCH, stated plainly so nobody mistakes it for full coverage: it detects
 * DUPLICATES, not a CROSSED mapping. Three distinct ids assigned to the wrong three tiers passes
 * this guard and every other check we have. Only the price-paired confirmation recorded in the
 * comments above closes that hole, and it is closed by a human reading them — which is why they
 * are there.
 */
function assertNoDuplicatePlanIds() {
  const seen = new Map();
  for (const [tier, id] of Object.entries(PLAN_IDS)) {
    if (seen.has(id)) {
      throw new Error(
        `ERR_TIER_PLAN_ID_COLLISION: plan id "${id}" is mapped to BOTH "${seen.get(id)}" and ` +
          `"${tier}". Every tier must have its own Whop plan id — a shared id silently grants the ` +
          'wrong tier to a paying customer. Fix PLAN_IDS in lib/tiers-core.js.',
      );
    }
    seen.set(id, tier);
  }
  for (const [id, tier] of Object.entries(LEGACY_PLAN_IDS)) {
    if (seen.has(id)) {
      throw new Error(
        `ERR_TIER_PLAN_ID_COLLISION: legacy plan id "${id}" (→ "${tier}") also appears as the ` +
          `current id for "${seen.get(id)}". A legacy id must never shadow a current one.`,
      );
    }
    seen.set(id, tier);
  }
}
assertNoDuplicatePlanIds();

/**
 * Per-tier limit set. Locked by Dennis 2026-08-11.
 *   templates     — server-enforced create cap (3 | 10 | 30).
 *   quickReplies  — 1 | 3 | 5. Now a real tier differentiator (Dennis, 2026-08-11); it was
 *                   previously 5/5/5 with a comment saying quick-replies were NOT a
 *                   differentiator. That comment and its pinned tests were correct for the old
 *                   spec and are updated with this change, not worked around.
 *   syncRangeMax  — the widest sync-history window this tier may pick, as a syncCaps RangeKey.
 *                   The relay clamps GET_MESSAGES / GET_CALL_LOGS `since` to no older than this.
 *
 *                   ⭐ THIS is what the pricing table now calls "Message sync". It is a RENAME of
 *                   the row describing the existing 30d/6mo/1yr difference — NOT a new gate. There
 *                   is deliberately no `messageSync` capability flag: adding one would have to
 *                   default to false for Solo and would STRIP message sync from paying Solo
 *                   customers who have it today. A pricing-copy change must never silently revoke
 *                   a shipped capability.
 *   contactSync   — may pull the phone's contact book (GET_CONTACTS). Solo: no.
 *
 * REMOVED 2026-08-11 — `mirroring`. It was a declared-but-unimplemented flag ("FORWARD NO-OP …
 * Do NOT invent mirroring here") returned in the entitlement contract so pricing could advertise
 * screen-mirroring. The feature was never built, so the contract was advertising a capability we
 * could not deliver. Deleting the field removes the promise rather than continuing to make it.
 *
 * @typedef {'solo'|'plus'|'pro'} Tier
 */
const TIER_LIMITS = {
  solo: { templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false },
  plus: { templates: 10, quickReplies: 3, syncRangeMax: '6mo', contactSync: true },
  pro: { templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true },
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
  // Superseded ids resolve to the tier the subscriber actually bought. Checked AFTER the current
  // ids so a current id always wins, and only consulted for the two non-solo tiers — a legacy
  // `solo` id would reach the same answer through the default below anyway.
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_PLAN_IDS, planId)
    ? LEGACY_PLAN_IDS[planId]
    : null;
  if (legacy === 'plus' || legacy === 'pro') return legacy;
  return 'solo';
}

/**
 * The limit set for a tier. Unknown tier → solo limits (defensive).
 * @param {string} tier
 * @returns {{templates:number, quickReplies:number, syncRangeMax:string, contactSync:boolean}}
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
