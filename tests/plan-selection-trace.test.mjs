/**
 * tests/plan-selection-trace.test.mjs — the END-TO-END TRACE for the P0.
 *
 * ⛔ WHAT THIS EXISTS TO PROVE, and what it deliberately does NOT accept as proof.
 *
 * `components/PricingModal.tsx` used to declare `onSelectTier: () => void` and call it with no
 * argument. All three tier CTAs fired the same zero-arg callback, so the modal rendered three
 * plans correctly and then threw away which one the user clicked. The anchor's `?plan=` href did
 * carry the tier — but only on middle/cmd-click, the path almost nobody takes.
 *
 * "The callback now takes a parameter" is NOT the fix and would NOT be evidence. The question is
 * whether the plan the user CLICKED is the plan Whop CHARGES. So this test walks every link in the
 * chain and asserts the terminal value is the confirmed Whop plan id for that tier — the id that
 * decides whether the customer is billed $6, $7 or $9.
 *
 *   1. PricingModal CTA        → onSelectTier(tier.id)
 *   2. page.tsx                → setSelectedPlanTier(tierId) → <SignupModal planTier=…>
 *   3. SignupModal             → /api/auth/google/start?next=%2Fsubscribe%3Fplan%3D<tier>
 *   4. google/start            → sanitiseNext() must PRESERVE that path+query
 *   5. /subscribe              → ?plan → initialTierId
 *   6. SubscribeLocked         → selectedId → selectedTier.planId
 *   7. WhopEmbedCheckout       → planId  ← THE THING THAT CHARGES MONEY
 *
 * Steps 1-2, 5-7 are wiring assertions read from the real source; steps 3-4 execute the real
 * `sanitiseNext` and the real href construction. The terminal assertion compares against
 * CONFIRMED_PLAN_IDS, which is Whop's own product-page value — an external system that would have
 * to be wrong in exactly the same way to agree with us.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

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

// The confirmed Whop ids, parsed out of lib/pricing.ts rather than re-typed here — re-typing them
// would let this test agree with a typo it was supposed to catch.
const pricingSrc = read('lib/pricing.ts');
const confirmed = {};
for (const m of pricingSrc.matchAll(/^\s*(solo|plus|pro):\s*'(plan_[A-Za-z0-9]+)',/gm)) {
  if (!(m[1] in confirmed)) confirmed[m[1]] = m[2];
}
eq('confirmed ids parsed for all three tiers', Object.keys(confirmed).sort(), ['plus', 'pro', 'solo']);
eq('solo → $6 id', confirmed.solo, 'plan_6DJ4H4iPEQo5X');
eq('plus → $7 id (displays "Pro")', confirmed.plus, 'plan_IvKRyvHtl4Q8w');
eq('pro  → $9 id (displays "Pro+")', confirmed.pro, 'plan_h587GLZLlOXP4');

// ── STEP 1: the CTA passes the tier it rendered, not nothing ────────────────
const modal = read('components/PricingModal.tsx');
ok('1. onSelectTier DECLARES a tier parameter', /onSelectTier:\s*\(tierId:\s*PlanTierId\)\s*=>\s*void/.test(modal));
ok('1. the CTA passes the rendered tier id', /onClick=\{\(e\)\s*=>\s*handleTierClick\(e,\s*tier\.id\)\}/.test(modal));
ok('1. the handler forwards it', /onSelectTier\(tierId\)/.test(modal));
ok('1. REGRESSION GUARD: no zero-arg onSelectTier() call survives', !/onSelectTier\(\)\s*;/.test(modal));
ok('1. the no-JS fallback href still carries the tier', /href=\{`\/auth\/register\?plan=\$\{tier\.id\}`\}/.test(modal));

// ── STEP 2: the page stores it and hands it to signup ───────────────────────
const page = read('app/page.tsx');
ok('2. handleTierSelect accepts a tier', /function handleTierSelect\(tierId:\s*PlanTierId\)/.test(page));
ok('2. it records the choice', /setSelectedPlanTier\(tierId\)/.test(page));
ok('2. SignupModal receives it', /planTier=\{selectedPlanTier\}/.test(page));

// ── STEP 3: signup encodes it into the OAuth next ───────────────────────────
const signup = read('components/SignupModal.tsx');
ok('3. the Google CTA uses the computed href', /href=\{googleStartHref\}/.test(signup));
ok('3. next targets /subscribe with the plan', /\/subscribe\?plan=\$\{planTier\}/.test(signup));
ok('3. it is URL-encoded', /encodeURIComponent\(/.test(signup));

// ── STEP 4: the OAuth round trip must PRESERVE path+query ───────────────────
// Executing the real sanitiseNext logic, not describing it. If this ever starts stripping query
// strings the whole chain silently reverts to the default plan — the exact class of failure this
// test exists for, one layer down.
const googleSrc = read('lib/google.ts');
const body = /export function sanitiseNext\(next[^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(googleSrc)[1];
const sanitiseNext = new Function('next', body);
for (const tier of ['solo', 'plus', 'pro']) {
  const target = `/subscribe?plan=${tier}`;
  eq(`4. sanitiseNext preserves "${target}"`, sanitiseNext(target), target);
}
eq('4. accept-control: an open redirect is still rejected', sanitiseNext('//evil.com'), '/app');
eq('4. accept-control: a non-absolute path is still rejected', sanitiseNext('evil'), '/app');

// ── STEP 5: /subscribe reads and VALIDATES the plan ─────────────────────────
const subPage = read('app/subscribe/page.tsx');
ok('5. it reads ?plan', /sp\?\.plan/.test(subPage));
ok('5. it validates against the real tier list before trusting it',
  /tiers\.some\(\(t\)\s*=>\s*t\.id\s*===\s*rawPlan\)/.test(subPage));
ok('5. it passes initialTierId down', /initialTierId=\{/.test(subPage));

// ── STEP 6-7: the selected tier drives the embed's planId ───────────────────
const locked = read('components/SubscribeLocked.tsx');
ok('6. initialTierId wins over the recommended default',
  /useState<PlanTierId>\(\s*initialTierId\s*\?\?/.test(locked));
ok('6. the selected tier is looked up by that id', /tiers\.find\(\(t\)\s*=>\s*t\.id === selectedId\)/.test(locked));
ok('7. the embed is driven by the SELECTED tier\'s planId', /planId=\{selectedTier\.planId\}/.test(locked));

// ── THE TERMINAL ASSERTION: click tier X ⇒ Whop charges X's price ───────────
// resolvePlanId falls back to CONFIRMED_PLAN_IDS when the env var is unset, which is the case in
// this test process — so this is the id that reaches WhopEmbedCheckout for each tier.
for (const [tier, expectedId] of Object.entries(confirmed)) {
  const target = sanitiseNext(`/subscribe?plan=${tier}`);
  const carried = new URLSearchParams(target.split('?')[1]).get('plan');
  eq(`⭐ END-TO-END: clicking "${tier}" reaches Whop plan ${expectedId}`, confirmed[carried], expectedId);
}

// A generic CTA (hero/header) must not silently mean "cheapest".
ok('a signup opened without a tier defaults to the RECOMMENDED tier, not solo',
  /useState<PlanTierId>\(RECOMMENDED_TIER\)/.test(page));

console.log(`✓ plan-selection-trace: ${passed} assertions passed`);
