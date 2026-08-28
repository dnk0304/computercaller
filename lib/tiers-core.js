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
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-17 — $5-PROMOTED / $7-HIDDEN + LIMITED TRIAL (dispatch
 * forge/pricing-trial-limited). TWO WORLDS now live in this file, selected by a
 * per-subscription `grandfathered` flag resolved in lib/entitlement-core.js:
 *
 *   NEW world  (grandfathered=false — every row created after launch):
 *     • plan_CGlYdJJr3Btlu is the LIVE $5 PROMOTED plan → 'plus' limits (7 tpl /
 *       3 qr / 3mo sync / contacts ON). The plan already exists at $5 in Whop —
 *       no price change at deploy. (plan_6DJ4H4iPEQo5X, the old $6 plan, is
 *       deliberately NOT promoted — grandfathered only.)
 *     • plan_IvKRyvHtl4Q8w is the $7 HIDDEN upgrade → 'pro' limits (30 / 5 / 1yr).
 *     • trialing → a NEW limited 'trial' tier (1 tpl / 0 qr / 3d sync), resolved
 *       in entitlement-core REGARDLESS of the sub's planId, still allowed:true.
 *
 *   GRANDFATHERED world (grandfathered=true — every pre-launch row, set by the
 *   migration): resolves through GRANDFATHERED_PLAN_IDS + GRANDFATHERED_TIER_
 *   LIMITS, which are a FROZEN byte-for-byte snapshot of the pre-launch map. A
 *   grandfathered trialing sub keeps the OLD "trial === its plan's full tier"
 *   behavior. Nobody who already paid or is mid-trial sees any change.
 *
 * The grandfathered branch lives in entitlement-core.js (resolveTier/withTier),
 * because only that layer knows the subscription's flag. This file exports both
 * map-sets and both resolvers so that branch has one honest place to choose from.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SAFE DEFAULT: both plan→tier resolvers map anything unrecognized — an unknown
 * id, null, undefined — to 'solo' (the cheapest tier, least privilege). This is
 * the fail-closed stance: an unrecognized plan can never silently unlock a
 * richer tier.
 */

'use strict';

/**
 * ⚠️⚠️ THE INTERNAL KEY AND THE DISPLAY NAME ARE NOT THE SAME WORD. ⚠️⚠️
 *
 *     internal key    NEW meaning (2026-08-17)      NEW price
 *     ------------    ------------------------      ---------
 *     trial       →   the limited free trial        $0 (7-day, card-first)
 *     plus        →   the PROMOTED plan             $5
 *     pro         →   the HIDDEN upgrade target     $7
 *     solo        →   grandfathered-only legacy     ($5/$6 legacy)
 *
 * The keys deliberately DO NOT change. They are load-bearing in TIER_LIMITS,
 * planIdToTier, the entitlement contract, the relay's gating and the pinned
 * tests — renaming them risks the fail-closed default (unknown plan → `solo`,
 * least privilege). Display names are a PRESENTATION concern and live at the
 * presentation boundary, not here.
 */

/**
 * NEW purchasable Whop plan ids (grandfathered=false rows only). Two plans:
 *
 *   ⭐ plus = the ONLY PROMOTED plan — the LIVE, already-$5 Whop plan
 *      `plan_CGlYdJJr3Btlu` (Dennis, CORRECTED 2026-08-17). This plan already
 *      exists and is buyable at $5, so there is NO Whop price change at deploy.
 *      The stale ledger note calling this id "grandfathered-only $5 Solo" is
 *      WRONG — it is now the promoted $5 plan and grants the `plus` limit set
 *      (7 tpl / 3 qr / 3mo / contacts ON) for NEW rows. (Existing rows already
 *      on it are grandfathered → they keep their frozen solo tier; see the
 *      GRANDFATHERED map below, where plan_CGlYdJJr3Btlu → solo.)
 *
 *   pro = the HIDDEN $7 upgrade (`plan_IvKRyvHtl4Q8w`, the pre-launch $7 id). It
 *      is the in-app upgrade target, never advertised on the pricing page.
 *
 * ⚠️ `plan_6DJ4H4iPEQo5X` ($6) is DELIBERATELY NOT here — Dennis: leave it out
 * of the promoted path entirely and grandfather anyone already on it (it maps to
 * 'solo' in HIDDEN_PLAN_IDS below and in the grandfathered map). There is no
 * "set the price in Whop" action item.
 *
 * ⭐ THE PRICE IN EACH COMMENT IS THE AUDIT TRAIL, NOT DECORATION — see the note
 * on assertNoDuplicatePlanIds() about what the guard can and cannot catch.
 */
const PROMOTED_PLAN_ID = 'plan_CGlYdJJr3Btlu'; // the live, buyable $5 plan → promoted
const PLAN_IDS = {
  plus: PROMOTED_PLAN_ID, // $5/mo — PROMOTED (live plan_CGlYdJJr3Btlu, already priced $5)
  pro: 'plan_IvKRyvHtl4Q8w', // $7/mo — HIDDEN in-app upgrade target
};

/**
 * Hidden / grandfathered-only ids that still resolve in the NEW world so a
 * (rare) new signup on one can never silently under-grant, but which are NOT
 * advertised or purchasable:
 *   plan_h587GLZLlOXP4 — the old $9 Pro+ plan. Hidden entirely; grandfathered
 *     payers keep access via the grandfathered branch. → 'pro' fallback.
 *   plan_6DJ4H4iPEQo5X — the $6 plan, left OUT of the promoted path (Dennis,
 *     2026-08-17). Not purchasable; → 'solo' fallback (its historical tier).
 */
const HIDDEN_PLAN_IDS = {
  plan_h587GLZLlOXP4: 'pro', // $9/mo — hidden, grandfathered only
  plan_6DJ4H4iPEQo5X: 'solo', // $6/mo — NOT promoted, grandfathered only
};

/**
 * FROZEN pre-launch plan→tier map. Consulted ONLY for grandfathered rows
 * (entitlement-core resolveTier, grandfathered branch) so a pre-launch
 * subscriber resolves to EXACTLY the tier they resolved to before this dispatch.
 * Do not edit — it is a historical snapshot, not a live map.
 *
 *   plan_6DJ4H4iPEQo5X → solo   ($6 — its pre-launch tier; now repurposed to $5
 *                                plus for NEW rows, but a grandfathered row on it
 *                                keeps solo)
 *   plan_IvKRyvHtl4Q8w → plus   ($7 — its pre-launch tier)
 *   plan_h587GLZLlOXP4 → pro    ($9 — its pre-launch tier)
 *   plan_CGlYdJJr3Btlu → solo   ($5 legacy — every current paying customer)
 *   plan_Ogrl3wQ8GM8zr → plus   (superseded $7 id)
 *   plan_lOhMcnZspvgnm → pro    (superseded $10 id)
 */
const GRANDFATHERED_PLAN_IDS = {
  plan_6DJ4H4iPEQo5X: 'solo',
  plan_IvKRyvHtl4Q8w: 'plus',
  plan_h587GLZLlOXP4: 'pro',
  plan_CGlYdJJr3Btlu: 'solo',
  plan_Ogrl3wQ8GM8zr: 'plus',
  plan_lOhMcnZspvgnm: 'pro',
};

/**
 * ⛔ BUILD-TIME GUARD: refuse to load if two NEW-world tiers share a plan id.
 *
 * Not hypothetical. On 2026-08-11 Dennis supplied the SAME plan id for two
 * different tiers, caught by eye. A shared id silently grants the wrong limits —
 * no error, no log. Throwing at module load makes that unshippable.
 *
 * ⚠️ WHAT THIS CANNOT CATCH, stated plainly: it detects DUPLICATES within the
 * NEW purchasable set, not a CROSSED mapping. Only the price-paired comments
 * above close that hole, and only a human reading them.
 *
 * NOTE (2026-08-17): the pre-launch guard also forbade a legacy id from
 * "shadowing" a current id. That invariant is DELIBERATELY GONE now: grand-
 * fathering re-points the SAME physical plan id to different tiers depending on
 * the row's `grandfathered` flag (plan_6DJ4H4iPEQo5X is grandfathered-solo AND
 * new-plus by design). Cross-map overlap is now correct, not a collision — so
 * the guard checks only the NEW purchasable set for internal duplicates.
 */
function assertNoDuplicatePlanIds() {
  const seen = new Map();
  for (const [tier, id] of Object.entries(PLAN_IDS)) {
    if (seen.has(id)) {
      throw new Error(
        `ERR_TIER_PLAN_ID_COLLISION: plan id "${id}" is mapped to BOTH "${seen.get(id)}" and ` +
          `"${tier}". Every purchasable tier must have its own Whop plan id — a shared id silently ` +
          'grants the wrong tier to a paying customer. Fix PLAN_IDS in lib/tiers-core.js.',
      );
    }
    seen.set(id, tier);
  }
}
assertNoDuplicatePlanIds();

/**
 * NEW-world per-tier limit set (grandfathered=false). Locked by Dennis
 * 2026-08-17.
 *   templates     — server-enforced create cap.
 *   quickReplies  — server-enforced create cap. Now a real tier differentiator
 *                   AND enforced tier-wide (trial 0 / plus 3 / pro 5) — the
 *                   /api/quick-replies route reads this off the entitlement
 *                   result, same as templates.
 *   syncRangeMax  — the widest sync-history window this tier may pick, as a
 *                   syncCaps RangeKey. The relay clamps GET_MESSAGES /
 *                   GET_CALL_LOGS `since` to no older than this.
 *   contactSync   — may pull the phone's contact book (GET_CONTACTS).
 *                   ⭐ 2026-08-17 LOCKED: EVERYONE gets contact-sync — trial ON,
 *                   $5 ON, $7 ON. It is ungated, NOT a differentiator. Only the
 *                   grandfathered-legacy `solo` set keeps it false (unchanged
 *                   pre-launch behavior for a legacy Solo row).
 *
 * The `trial` tier additionally carries descriptive `calls` / `notifications`
 * flags (both ON): a trial user is allowed:true so they place calls and receive
 * notifications like any paid user — there is no server gate for those, so the
 * flags document intent rather than drive enforcement. They are OPTIONAL and
 * appear ONLY on `trial` (the pinned deep-equality tests for solo/plus/pro must
 * stay 4-key).
 *
 * @typedef {'free'|'trial'|'solo'|'plus'|'pro'} Tier
 */
const TIER_LIMITS = {
  // FREE TIER (dispatch forge/free-tier-p1, 2026-08-28). The no-card, no-trial
  // ENTRY POINT: resolved by state==='free_tier' (a logged-in user with NO
  // subscription row) in entitlement-core, REGARDLESS of planId. allowed:true —
  // a free user is in the FULL app, not the lock screen. Its two EXTRA keys
  // (callsPerDay / messagesPerDay) are the daily OUTBOUND caps the relay meters;
  // NO paid tier carries them, so `typeof cap === 'number'` cleanly selects
  // "metered" vs "unlimited" with zero new DB traffic for paying users. 0
  // templates / 0 quick-replies fall straight out of the existing per-tier cap
  // routes (effectiveTemplateLimit returns limits.templates). 14d sync window is
  // picked up by the existing since-clamp via SYNC_RANGE_WINDOW_DAYS — no new
  // code. Counters reset at midnight UTC; on breach the action is blocked for
  // the rest of the UTC day and the client is pushed to subscribe (Whop).
  free: {
    templates: 0,
    quickReplies: 0,
    syncRangeMax: '14d',
    contactSync: true,
    callsPerDay: 20,
    messagesPerDay: 10,
  },
  // Limited free trial (7-day, card-first). Every cap is the trial floor,
  // resolved by state==='trialing' REGARDLESS of planId (see entitlement-core).
  trial: {
    templates: 1,
    quickReplies: 0,
    syncRangeMax: '3d',
    contactSync: true,
    calls: true,
    notifications: true,
  },
  // Grandfathered-legacy only in the NEW world (no purchasable plan maps here);
  // unchanged from pre-launch so a legacy Solo row is byte-identical.
  solo: { templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false },
  // $5 PROMOTED.
  plus: { templates: 7, quickReplies: 3, syncRangeMax: '3mo', contactSync: true },
  // $7 HIDDEN upgrade.
  pro: { templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true },
};

/**
 * FROZEN pre-launch limit set. Consulted ONLY for grandfathered rows so a
 * pre-launch subscriber keeps EXACTLY their prior caps (Plus 10/3/6mo, Pro
 * 30/5/1yr, Solo 3/1/30d). No `trial` key: a grandfathered trialing row resolves
 * to its plan's full tier here (the pre-launch behavior), never to the limited
 * trial. Do not edit — historical snapshot.
 */
const GRANDFATHERED_TIER_LIMITS = {
  solo: { templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false },
  plus: { templates: 10, quickReplies: 3, syncRangeMax: '6mo', contactSync: true },
  pro: { templates: 30, quickReplies: 5, syncRangeMax: '1yr', contactSync: true },
};

// syncRangeMax RangeKey → window length in days. Used by the relay since-clamp
// (server.js) to derive the oldest timestamp a tier may request. '3d' added
// 2026-08-17 for the limited trial. '3mo' is the promoted $5 window.
const SYNC_RANGE_WINDOW_DAYS = {
  '3d': 3,
  '14d': 14, // free tier (2026-08-28, dispatch forge/free-tier-p1)
  '30d': 30,
  '3mo': 90,
  '6mo': 180,
  '1yr': 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * NEW-world plan id → tier (grandfathered=false rows). The promoted $5 id →
 * 'plus'; the hidden $7 id → 'pro'; the hidden $9 id → 'pro' (safe fallback);
 * EVERYTHING else — unknown id, null, undefined, empty string — → 'solo'
 * (least privilege). Grandfathered rows do NOT use this — see
 * planIdToTierGrandfathered.
 * @param {string|null|undefined} planId
 * @returns {'trial'|'solo'|'plus'|'pro'}
 */
function planIdToTier(planId) {
  if (planId === PLAN_IDS.plus) return 'plus';
  if (planId === PLAN_IDS.pro) return 'pro';
  if (Object.prototype.hasOwnProperty.call(HIDDEN_PLAN_IDS, planId)) return HIDDEN_PLAN_IDS[planId];
  return 'solo';
}

/**
 * GRANDFATHERED-world plan id → tier (grandfathered=true rows). A FROZEN lookup
 * against GRANDFATHERED_PLAN_IDS reproducing the pre-launch resolution exactly.
 * Unknown/null/undefined → 'solo' (least privilege), same as pre-launch.
 * @param {string|null|undefined} planId
 * @returns {'solo'|'plus'|'pro'}
 */
function planIdToTierGrandfathered(planId) {
  const tier = Object.prototype.hasOwnProperty.call(GRANDFATHERED_PLAN_IDS, planId)
    ? GRANDFATHERED_PLAN_IDS[planId]
    : null;
  return tier === 'plus' || tier === 'pro' ? tier : 'solo';
}

/**
 * The NEW-world limit set for a tier. Unknown tier → solo limits (defensive).
 * @param {string} tier
 * @returns {{templates:number, quickReplies:number, syncRangeMax:string, contactSync:boolean}}
 */
function limitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.solo;
}

/**
 * Oldest epoch-ms `since` allowed for a given syncCaps RangeKey window
 * (now − window). Unknown key → the narrowest (30d) window (fail-closed).
 * @param {string} rangeKey
 * @param {number} [nowMs]
 * @returns {number}
 */
function windowFloorMs(rangeKey, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const days = SYNC_RANGE_WINDOW_DAYS[rangeKey] != null ? SYNC_RANGE_WINDOW_DAYS[rangeKey] : 30;
  return now - days * DAY_MS;
}

/**
 * The oldest epoch-ms `since` a NEW-world tier may request for a bulk sync.
 * Fail-closed: unknown tier → Solo (30d) window. NOTE the relay uses
 * syncSinceFloorMsFromLimits below instead, so a GRANDFATHERED user's wider
 * window is honored from their cached (grandfathered) limits.
 * @param {string} tier
 * @param {number} [nowMs]
 * @returns {number} epoch-ms floor
 */
function syncSinceFloorMs(tier, nowMs) {
  return windowFloorMs(limitsForTier(tier).syncRangeMax, nowMs);
}

/**
 * The oldest epoch-ms `since` allowed given an already-resolved limit set. This
 * is what the relay uses (server.js caches ws.tierLimits off the admission
 * entitlement result), so a grandfathered Plus user's 6mo window and a trial
 * user's 3d window are BOTH honored from the exact limits they were admitted
 * with — never re-derived from the NEW map. Fail-closed: a missing/blank
 * syncRangeMax → 30d.
 * @param {{syncRangeMax?: string}|null|undefined} limits
 * @param {number} [nowMs]
 * @returns {number} epoch-ms floor
 */
function syncSinceFloorMsFromLimits(limits, nowMs) {
  return windowFloorMs(limits && limits.syncRangeMax, nowMs);
}

/**
 * Machine-readable upgrade signal for the client (Pixel). Given the tier a user
 * is CURRENTLY on, what should the UI offer when they hit a cap?
 *   trial → activate the $5 plan  (reason 'trial-limit-hit', targetTier 'plus')
 *   plus  → upgrade to the $7 plan (reason 'plus-limit-hit',  targetTier 'pro')
 *   everything else (solo-grandfathered, pro/top, admin) → no upgrade path
 *     (null): a top-tier or grandfathered user is not pushed.
 * Consumed by /api/entitlement (as `upgrade`) and by the 409 bodies of the
 * template / quick-reply create routes so Pixel renders the RIGHT prompt.
 * @param {string} tier
 * @returns {{reason: (string|null), cta: (string|null), targetTier: (string|null)}}
 */
function upgradePathForTier(tier) {
  // free → subscribe to the $5 plan (dispatch forge/free-tier-p1). A free user
  // who hits a daily/feature cap is pushed to the promoted $5 plan, same target
  // as an ending trial, but with its own reason so Pixel can render the
  // "you reached your daily free limit" copy distinctly from a trial upsell.
  if (tier === 'free') return { reason: 'free-limit-hit', cta: 'subscribe', targetTier: 'plus' };
  if (tier === 'trial') return { reason: 'trial-limit-hit', cta: 'activate-5', targetTier: 'plus' };
  if (tier === 'plus') return { reason: 'plus-limit-hit', cta: 'upgrade-7', targetTier: 'pro' };
  return { reason: null, cta: null, targetTier: null };
}

/** The upgrade reasons, named so callers never hand-type the strings. */
const UPGRADE_REASON = {
  FREE_LIMIT: 'free-limit-hit', // → subscribe to the $5 plan (free daily/feature cap)
  TRIAL_LIMIT: 'trial-limit-hit', // → activate the $5 plan
  PLUS_LIMIT: 'plus-limit-hit', // → upgrade to the $7 plan
};

module.exports = {
  PLAN_IDS,
  PROMOTED_PLAN_ID,
  HIDDEN_PLAN_IDS,
  GRANDFATHERED_PLAN_IDS,
  TIER_LIMITS,
  GRANDFATHERED_TIER_LIMITS,
  SYNC_RANGE_WINDOW_DAYS,
  planIdToTier,
  planIdToTierGrandfathered,
  limitsForTier,
  syncSinceFloorMs,
  syncSinceFloorMsFromLimits,
  upgradePathForTier,
  UPGRADE_REASON,
};
