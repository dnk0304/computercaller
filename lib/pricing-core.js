/**
 * lib/pricing-core.js — the SINGLE source of truth for every DISPLAYED price and
 * for the machine-driven upgrade-prompt selection ($5-promoted / $7-hidden +
 * limited trial, dispatch pricing-5-promoted-7-hidden, 2026-08-17).
 *
 * WHY THIS FILE IS PLAIN COMMONJS (mirrors lib/tiers-core.js / entitlement-core.js
 * exactly): the shared truth must be require-able by the runner-less node tests
 * (see tests/pricing-storefront.test.mjs) AND consumed by the TS presentation
 * layer (lib/pricing.ts). Keeping the price map + the prompt-selection here — not
 * inside a .ts — means the numbers the tests pin are the SAME numbers the page
 * renders, with zero drift. lib/pricing.ts is a thin TS view over this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE vs lib/tiers-core.js:
 *   tiers-core.js  = LIMITS + plan→tier resolution (what the SERVER enforces).
 *   pricing-core.js = PRICES + which prompt to show (what the CUSTOMER sees).
 * A price is the one fact the backend has no opinion on — it stores plan ids and
 * limits, never a dollar amount. So the dollar amounts live here, keyed by the
 * SAME internal tier keys, and every feature number is READ from TIER_LIMITS
 * (never re-typed) so a displayed limit cannot disagree with the enforced one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE $5-PROMOTED / $7-HIDDEN MODEL (Dennis, 2026-08-17):
 *   • The pricing page shows ONE plan: $5/mo (internal `plus`). That is the only
 *     price a visitor ever sees on the storefront.
 *   • $7/mo (internal `pro`) is NEVER on the pricing page. It is named in exactly
 *     one place: the in-app upgrade prompt shown to a paying $5 user who hits a
 *     $5 ceiling — and only because the server's `upgrade` signal said so.
 *   • The trial (card-first, 7-day) is feature-limited (`trial` tier). Its column
 *     is rendered from TIER_LIMITS.trial so the page is honest about what the
 *     trial actually gives before the customer activates.
 *
 * PROMPT SELECTION IS SERVER-DRIVEN, NEVER GUESSED. selectUpgradeOffer() takes the
 * server's machine-readable `upgrade` object ({reason,cta,targetTier} — produced
 * by tiers-core.upgradePathForTier and shipped on /api/entitlement AND the 409
 * bodies) and returns the offer to render. The UI never inspects which wall was
 * hit; it renders exactly what this returns. A grandfathered / top-tier user's
 * upgrade signal is all-null → this returns null → no prompt. That is how a
 * grandfathered user never sees a prompt for a limit that doesn't apply to them.
 */

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- shared CJS core, same
   convention as lib/tiers-core.js / lib/entitlement-core.js. */
const { TIER_LIMITS, PLAN_IDS, upgradePathForTier } = require('./tiers-core.js');

/**
 * Displayed price per internal tier. The ONE place a dollar amount is written.
 *   plus → $5  (the PROMOTED, only-visible plan)
 *   pro  → $7  (the HIDDEN in-app upgrade target)
 *   solo → $5  (grandfathered-legacy; NEVER displayed — kept only so a stray
 *              read can't crash. A legacy Solo row is handled by the app, not
 *              sold on the storefront.)
 * priceValue is the numeric form for JSON-LD offers.
 */
const TIER_PRICE = {
  solo: { price: '$5', priceValue: 5 },
  plus: { price: '$5', priceValue: 5 },
  pro: { price: '$7', priceValue: 7 },
};

/** The single plan shown on the pricing page. */
const PROMOTED_TIER = 'plus';
/** The hidden in-app upgrade target — named ONLY in the upgrade prompt. */
const UPGRADE_TIER = 'pro';
/** The limited-trial resolved tier (from TIER_LIMITS). */
const TRIAL_TIER = 'trial';
/** Trial length in days. Card-first (no "no card needed" copy anywhere). */
const TRIAL_DAYS = 7;
/** Billing cadence phrase shared by every price. */
const PERIOD = 'per month';

/**
 * syncCaps RangeKey → human phrase. Every displayed history window ('3 days',
 * '3 months', '1 year') comes through here keyed off TIER_LIMITS[tier].syncRangeMax,
 * so the window shown is the window enforced.
 */
const SYNC_WORDS = {
  '3d': '3 days',
  '30d': '30 days',
  '3mo': '3 months',
  '6mo': '6 months',
  '1yr': '1 year',
};
function syncWords(rangeKey) {
  return SYNC_WORDS[rangeKey] || String(rangeKey);
}

/**
 * The Whop plan id to check out on for a target tier. Sourced from the SAME
 * PLAN_IDS the entitlement core resolves tiers from → the plan a user pays on and
 * the tier they are granted cannot drift. plus → $5 promoted id, pro → $7 id.
 * @param {'plus'|'pro'} tier
 * @returns {string}
 */
function planIdForTier(tier) {
  return tier === 'pro' ? PLAN_IDS.pro : PLAN_IDS.plus;
}

/**
 * Pure prompt-selection. Given the server's machine-readable `upgrade` signal —
 * off /api/entitlement (the user's current tier) OR a template/quick-reply 409
 * body — return the single offer the UI should render, or null when there is
 * nowhere up (top-tier / grandfathered-top / privileged: all-null signal).
 *
 * The two offers are DISTINCT and chosen by the SERVER, never by the UI:
 *   { reason:'trial-limit-hit', cta:'activate-5', targetTier:'plus' } → activate $5
 *   { reason:'plus-limit-hit',  cta:'upgrade-7',  targetTier:'pro'  } → upgrade $7
 *
 * @param {{reason:string|null, cta:string|null, targetTier:string|null}|null|undefined} upgrade
 * @returns {{reason:string, cta:string, targetTier:('plus'|'pro'), price:string,
 *            priceValue:number, planId:string, limits:object}|null}
 */
function selectUpgradeOffer(upgrade) {
  if (!upgrade || !upgrade.reason || !upgrade.targetTier) return null;
  const tier = upgrade.targetTier;
  const price = TIER_PRICE[tier];
  const limits = TIER_LIMITS[tier];
  if (!price || !limits) return null;
  return {
    reason: upgrade.reason,
    cta: upgrade.cta,
    targetTier: tier,
    price: price.price,
    priceValue: price.priceValue,
    planId: planIdForTier(tier),
    limits,
  };
}

/**
 * Convenience wrapper: the upgrade offer for a user CURRENTLY on `tier`, derived
 * through the same tiers-core.upgradePathForTier the server uses. Handy for tests
 * and for any caller holding a tier rather than a raw `upgrade` object.
 * @param {string} tier
 */
function upgradeOfferForTier(tier) {
  return selectUpgradeOffer(upgradePathForTier(tier));
}

module.exports = {
  TIER_PRICE,
  PROMOTED_TIER,
  UPGRADE_TIER,
  TRIAL_TIER,
  TRIAL_DAYS,
  PERIOD,
  SYNC_WORDS,
  syncWords,
  planIdForTier,
  selectUpgradeOffer,
  upgradeOfferForTier,
};
