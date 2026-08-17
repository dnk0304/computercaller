/**
 * tests/plan-selection-trace.test.mjs — the END-TO-END TRACE, updated for the
 * SINGLE-PLAN storefront ($5-promoted / $7-hidden, dispatch
 * pricing-5-promoted-7-hidden, 2026-08-17).
 *
 * ⛔ WHAT THIS PROVES: the pricing page sells exactly ONE plan, and clicking its
 * one CTA reaches the LIVE $5 Whop plan id at the checkout embed — the id that
 * decides whether the customer is charged. The old three-plan version of this
 * trace (solo/plus/pro CTAs, ?plan= selection, initialTierId) is gone with the
 * extra tiers; there is nothing to "pick" anymore, so the failure mode this now
 * guards is a different one: the single CTA reaching the WRONG plan id, or a
 * second price/plan creeping back onto the page.
 *
 *   1. PricingModal CTA     → onSelectTier(PROMOTED_TIER) + href ?plan=plus
 *   2. page.tsx             → setSelectedPlanTier → <SignupModal planTier=…>
 *   3. SignupModal          → /subscribe?plan=${planTier}
 *   4. google/start         → sanitiseNext() preserves path+query
 *   5. /subscribe           → getPromotedPlan() (single plan)
 *   6. SubscribeLocked      → tiers[0].planId → WhopEmbedCheckout
 *   7. planId               ← THE THING THAT CHARGES MONEY = PLAN_IDS.plus
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let passed = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label);
  passed++;
}
function ok(label, cond) {
  assert.ok(cond, label);
  passed++;
}

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Comment-stripped view, so wiring guards match RENDERED source, not the header
// comments (which mention /auth/register?plan=plus by way of explanation).
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const { PLAN_IDS } = require('../lib/tiers-core.js');
const { PROMOTED_TIER, planIdForTier } = require('../lib/pricing-core.js');

// The live $5 promoted id, from the shared core — never re-typed here.
eq('promoted tier resolves to the live $5 Whop id', planIdForTier(PROMOTED_TIER), PLAN_IDS.plus);
eq('the live $5 promoted id', PLAN_IDS.plus, 'plan_CGlYdJJr3Btlu');

// ── STEP 1: the single CTA passes the promoted tier and carries it in the href
const modal = code('components/PricingModal.tsx');
ok('1. onSelectTier DECLARES a tier parameter', /onSelectTier:\s*\(tierId:\s*PlanTierId\)\s*=>\s*void/.test(modal));
ok('1. the CTA hands off the promoted tier', /onSelectTier\(PROMOTED_TIER\)/.test(modal));
ok('1. REGRESSION GUARD: no zero-arg onSelectTier() survives', !/onSelectTier\(\)\s*;/.test(modal));
ok('1. the no-JS fallback href carries the plan', /href=\{`\/auth\/register\?plan=\$\{plan\.id\}`\}/.test(modal));
ok('1. exactly one register CTA on the page (single plan)',
  (modal.match(/\/auth\/register\?plan=/g) || []).length === 1);

// ── STEP 2: the page stores it and hands it to signup ───────────────────────
const page = read('app/page.tsx');
ok('2. handleTierSelect accepts a tier', /function handleTierSelect\(tierId:\s*PlanTierId\)/.test(page));
ok('2. it records the choice', /setSelectedPlanTier\(tierId\)/.test(page));
ok('2. SignupModal receives it', /planTier=\{selectedPlanTier\}/.test(page));
ok('2. a signup opened without a tier defaults to the PROMOTED tier',
  /useState<PlanTierId>\(PROMOTED_TIER\)/.test(page));

// ── STEP 3: signup encodes it into the OAuth next ───────────────────────────
const signup = read('components/SignupModal.tsx');
ok('3. the Google CTA uses the computed href', /href=\{googleStartHref\}/.test(signup));
ok('3. next targets /subscribe with the plan', /\/subscribe\?plan=\$\{planTier\}/.test(signup));
ok('3. it is URL-encoded', /encodeURIComponent\(/.test(signup));

// ── STEP 4: the OAuth round trip must PRESERVE path+query ───────────────────
const googleSrc = read('lib/google.ts');
const body = /export function sanitiseNext\(next[^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(googleSrc)[1];
const sanitiseNext = new Function('next', body);
eq('4. sanitiseNext preserves "/subscribe?plan=plus"', sanitiseNext('/subscribe?plan=plus'), '/subscribe?plan=plus');
eq('4. accept-control: an open redirect is still rejected', sanitiseNext('//evil.com'), '/app');
eq('4. accept-control: a non-absolute path is still rejected', sanitiseNext('evil'), '/app');

// ── STEP 5: /subscribe builds the single promoted plan ──────────────────────
const subPage = read('app/subscribe/page.tsx');
ok('5. it sources the single promoted plan', /getPromotedPlan\(\)/.test(subPage));
ok('5. it passes the plan array down', /tiers=\{tiers\}/.test(subPage));

// ── STEP 6-7: tiers[0] drives the embed's planId ────────────────────────────
const locked = read('components/SubscribeLocked.tsx');
ok('6. the single plan is tiers[0]', /const plan = tiers\[0\];/.test(locked));
ok('7. the embed is driven by that plan\'s planId', /planId=\{plan\.planId\}/.test(locked));

// ── getPromotedPlan checks out on PLAN_IDS.plus (pay-tier == grant-tier) ─────
const pricingSrc = read('lib/pricing.ts');
ok('the promoted plan\'s checkout id is PLAN_IDS.plus', /planId:\s*PLAN_IDS\.plus/.test(pricingSrc));

console.log(`✓ plan-selection-trace: ${passed} assertions passed`);
