/**
 * tests/pricing-storefront.test.mjs — badge-truth proof for the $5-promoted /
 * $7-hidden storefront + the server-driven upgrade prompt (dispatch
 * pricing-5-promoted-7-hidden, 2026-08-17, Pixel).
 *
 * ⛔ WHAT THIS PROVES (and what it refuses to accept as proof):
 *   The storefront must show ONE price ($5) and NEVER name $7. The two in-app
 *   prompts — trial→activate-$5, $5→upgrade-$7 — must be chosen by the SERVER's
 *   machine-readable `upgrade` signal, never by the UI guessing which wall was
 *   hit. A grandfathered / top-tier user must get NO prompt.
 *
 * The prices/limits/prompt-selection come from the SHARED cores
 * (lib/pricing-core.js + lib/tiers-core.js) — the same modules lib/pricing.ts
 * and the components render — so what this pins is what the page shows. The
 * "$7 is not on the storefront" checks read the real component/page source, so a
 * stray "$7" re-appearing anywhere on the pricing page fails the build.
 *
 * Runner-less. Run:  node tests/pricing-storefront.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Strip comments so the "$7 never renders" guard tests RENDERED source, not the
// header comments that legitimately explain the $5-promoted / $7-hidden split.
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const { PLAN_IDS, TIER_LIMITS, upgradePathForTier } = require('../lib/tiers-core.js');
const {
  TIER_PRICE,
  PROMOTED_TIER,
  UPGRADE_TIER,
  TRIAL_TIER,
  planIdForTier,
  selectUpgradeOffer,
  upgradeOfferForTier,
} = require('../lib/pricing-core.js');

let passed = 0;
function eq(label, a, b) {
  assert.deepStrictEqual(a, b, label);
  console.log(`  PASS  ${label}`);
  passed++;
}
function ok(label, cond) {
  assert.ok(cond, label);
  console.log(`  PASS  ${label}`);
  passed++;
}

// ── The promoted plan is $5 and checks out on the live $5 Whop id ───────────
eq('promoted tier is plus', PROMOTED_TIER, 'plus');
eq('promoted price is $5', TIER_PRICE[PROMOTED_TIER].price, '$5');
eq('$5 checkout id === PLAN_IDS.plus (pay-tier == grant-tier)', planIdForTier('plus'), PLAN_IDS.plus);
eq('the live $5 promoted id', PLAN_IDS.plus, 'plan_CGlYdJJr3Btlu');

// ── $7 is the hidden upgrade target only ────────────────────────────────────
eq('upgrade tier is pro', UPGRADE_TIER, 'pro');
eq('upgrade price is $7', TIER_PRICE[UPGRADE_TIER].price, '$7');
eq('$7 checkout id === PLAN_IDS.pro', planIdForTier('pro'), PLAN_IDS.pro);

// ── The two prompts are chosen by the SERVER signal, not guessed ────────────
{
  // A trial user's server signal → activate the $5 plan.
  const offer = selectUpgradeOffer(upgradePathForTier('trial'));
  ok('TRIAL: a prompt is offered', offer !== null);
  eq('TRIAL prompt reason', offer.reason, 'trial-limit-hit');
  eq('TRIAL prompt cta', offer.cta, 'activate-5');
  eq('TRIAL prompt targets $5 (plus)', offer.targetTier, 'plus');
  eq('TRIAL prompt price is $5 (never $7)', offer.price, '$5');
  eq('TRIAL prompt checks out on the $5 id', offer.planId, PLAN_IDS.plus);
}
{
  // A paid $5 user's server signal → upgrade to $7. The ONLY place $7 appears.
  const offer = selectUpgradeOffer(upgradePathForTier('plus'));
  ok('$5: a prompt is offered', offer !== null);
  eq('$5 prompt reason', offer.reason, 'plus-limit-hit');
  eq('$5 prompt cta', offer.cta, 'upgrade-7');
  eq('$5 prompt targets $7 (pro)', offer.targetTier, 'pro');
  eq('$5 prompt price is $7', offer.price, '$7');
  eq('$5 prompt checks out on the $7 id', offer.planId, PLAN_IDS.pro);
}

// ── Top / grandfathered users get NO prompt (null signal → null offer) ──────
eq('$7 (top) user: no prompt', upgradeOfferForTier('pro'), null);
eq('grandfathered-legacy solo: no prompt', upgradeOfferForTier('solo'), null);
eq('a null/absent signal yields no prompt', selectUpgradeOffer(null), null);
eq('an all-null signal yields no prompt', selectUpgradeOffer({ reason: null, cta: null, targetTier: null }), null);

// ── Displayed limits equal enforced limits (the trial + $5 columns) ─────────
eq('trial column templates == TIER_LIMITS.trial', TIER_LIMITS[TRIAL_TIER].templates, 1);
eq('trial column history == 3d', TIER_LIMITS[TRIAL_TIER].syncRangeMax, '3d');
eq('$5 column templates == TIER_LIMITS.plus', TIER_LIMITS[PROMOTED_TIER].templates, 7);
eq('$5 column quick-replies == TIER_LIMITS.plus', TIER_LIMITS[PROMOTED_TIER].quickReplies, 3);
eq('$5 column history == 3mo', TIER_LIMITS[PROMOTED_TIER].syncRangeMax, '3mo');

// ── $7 must NOT appear on any pricing-PAGE surface (source-level guard) ──────
for (const file of ['components/PricingModal.tsx', 'app/page.tsx', 'components/SubscribeLocked.tsx']) {
  const src = code(file);
  ok(`${file}: never renders the $7 price literal`, !/\$7\b/.test(src));
  ok(`${file}: never references the hidden $7 plan id`, !src.includes(PLAN_IDS.pro));
}
// $7 IS allowed to be named in the in-app upgrade modal — and only there.
ok('UpgradeModal is the surface that carries the $7 prompt (via lib/pricing)', /getUpgradePrompt/.test(read('components/UpgradeModal.tsx')));

console.log(`\n✓ pricing-storefront: ${passed} assertions passed`);
