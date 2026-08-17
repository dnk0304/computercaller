// ENTITLEMENT-GATE-PROOF for the $5-promoted / $7-hidden + limited-trial switch
// (dispatch forge/pricing-trial-limited, 2026-08-17).
//
// Proves the full gate for every persona the brief names — trial, $5, $7,
// grandfathered, and admin/free-access — end to end: the entitlement decision,
// the caps it grants, the sync window, contact-sync, the template/quick-reply
// create-cap enforcement (mirrored from the routes: count >= limit → 409), and
// the machine-readable upgrade signal Pixel consumes.
//
// Runner-less by design. Run directly:  node tests/pricing-trial-limited.test.js
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this proof targets the
   plain-CJS tier/entitlement core (see lib/tiers-core.js header) and follows the
   repo's runner-less CJS test convention. */

const assert = require('node:assert').strict;
const { PLAN_IDS } = require('../lib/tiers-core.js');
const { evaluateEntitlement, evaluateUserEntitlement } = require('../lib/entitlement-core.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-17T12:00:00.000Z');
const future = new Date(NOW.getTime() + 5 * DAY_MS);
const past = new Date(NOW.getTime() - 5 * DAY_MS);

let passed = 0;
function eq(name, a, b) {
  assert.deepStrictEqual(a, b, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

// Mirror of the /api/templates + /api/quick-replies create-cap decision:
// count >= ent.limits.X → 409 { limit, upgrade }; else 201.
function templateCreate(ent, currentCount) {
  const limit = ent.limits.templates;
  return currentCount >= limit
    ? { status: 409, limit, upgrade: ent.upgrade }
    : { status: 201, limit };
}
function quickReplyCreate(ent, currentCount) {
  const limit = ent.limits.quickReplies;
  return currentCount >= limit
    ? { status: 409, limit, upgrade: ent.upgrade }
    : { status: 201, limit };
}

function ent(sub, opts) {
  return evaluateEntitlement(
    { isAdmin: (opts && opts.isAdmin) || false, email: (opts && opts.email) || 'user@x.com', freeAccess: (opts && opts.freeAccess) || false, subscription: sub },
    NOW,
  );
}

// ── TRIAL (new, limited) ────────────────────────────────────────────────────
{
  const e = ent({ status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: PLAN_IDS.pro });
  eq('TRIAL: allowed (drives phone, places calls)', e.allowed, true);
  eq('TRIAL: tier is the limited trial (ignores attached plan)', e.tier, 'trial');
  eq('TRIAL: 1 template', e.limits.templates, 1);
  eq('TRIAL: 0 quick-replies', e.limits.quickReplies, 0);
  eq('TRIAL: 3d sync', e.limits.syncRangeMax, '3d');
  eq('TRIAL: contacts ON', e.limits.contactSync, true);
  eq('TRIAL: calls ON', e.limits.calls, true);
  eq('TRIAL: notifications ON', e.limits.notifications, true);
  // 1 template allowed, the 2nd (4th-etc.) is denied with the $5 upsell.
  eq('TRIAL: 1st template creates', templateCreate(e, 0).status, 201);
  eq('TRIAL: 2nd template is 409', templateCreate(e, 1).status, 409);
  eq('TRIAL: template 409 says activate-$5', templateCreate(e, 1).upgrade.cta, 'activate-5');
  eq('TRIAL: template 409 reason', templateCreate(e, 1).upgrade.reason, 'trial-limit-hit');
  // 0 quick-replies → the very first is denied.
  eq('TRIAL: 1st quick-reply is 409 (cap 0)', quickReplyCreate(e, 0).status, 409);
  eq('TRIAL: quick-reply 409 says activate-$5', quickReplyCreate(e, 0).upgrade.cta, 'activate-5');
}

// ── $5 (plus, promoted) ─────────────────────────────────────────────────────
{
  const e = ent({ status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.plus });
  eq('$5: allowed', e.allowed, true);
  eq('$5: tier plus', e.tier, 'plus');
  eq('$5: 7 templates', e.limits.templates, 7);
  eq('$5: 3 quick-replies', e.limits.quickReplies, 3);
  eq('$5: 3mo sync', e.limits.syncRangeMax, '3mo');
  eq('$5: contacts ON', e.limits.contactSync, true);
  eq('$5: 7th template creates', templateCreate(e, 6).status, 201);
  eq('$5: 8th (=#11-ish over trial) template is 409', templateCreate(e, 7).status, 409);
  eq('$5: template 409 says upgrade-$7', templateCreate(e, 7).upgrade.cta, 'upgrade-7');
  eq('$5: template 409 reason', templateCreate(e, 7).upgrade.reason, 'plus-limit-hit');
  eq('$5: 4th quick-reply is 409', quickReplyCreate(e, 3).status, 409);
  eq('$5: quick-reply 409 says upgrade-$7', quickReplyCreate(e, 3).upgrade.cta, 'upgrade-7');
}

// ── $7 (pro, hidden upgrade) ────────────────────────────────────────────────
{
  const e = ent({ status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: PLAN_IDS.pro });
  eq('$7: allowed', e.allowed, true);
  eq('$7: tier pro', e.tier, 'pro');
  eq('$7: 30 templates', e.limits.templates, 30);
  eq('$7: 5 quick-replies', e.limits.quickReplies, 5);
  eq('$7: 1yr sync (>3mo)', e.limits.syncRangeMax, '1yr');
  eq('$7: 30th template creates', templateCreate(e, 29).status, 201);
  eq('$7: 31st template is 409 (hard ceiling)', templateCreate(e, 30).status, 409);
  eq('$7: top tier has no upgrade path', e.upgrade.reason, null);
}

// ── GRANDFATHERED (pre-launch payer/trialer — behavior UNCHANGED) ───────────
{
  // Grandfathered $7-plan trialing row keeps the OLD full-tier trial (10/3/6mo).
  const e = ent({ status: 'trial', trialEndsAt: future, currentPeriodEnd: null, planId: 'plan_IvKRyvHtl4Q8w', grandfathered: true });
  eq('GF trial: allowed', e.allowed, true);
  eq('GF trial: keeps plan full tier (plus)', e.tier, 'plus');
  eq('GF trial: 10 templates (frozen, NOT the limited 1)', e.limits.templates, 10);
  eq('GF trial: 6mo sync (frozen, NOT 3d)', e.limits.syncRangeMax, '6mo');
  eq('GF trial: grandfathered flag true', e.grandfathered, true);
  // A grandfathered $6-Solo active row: contacts stay OFF (unchanged), 3 tpl.
  const s = ent({ status: 'active', trialEndsAt: past, currentPeriodEnd: future, planId: 'plan_6DJ4H4iPEQo5X', grandfathered: true });
  eq('GF solo: tier solo', s.tier, 'solo');
  eq('GF solo: 3 templates', s.limits.templates, 3);
  eq('GF solo: contacts OFF (unchanged)', s.limits.contactSync, false);
  eq('GF solo: 30d sync (unchanged)', s.limits.syncRangeMax, '30d');
}

// ── ADMIN + FREE-ACCESS (privileged — top tier, unaffected) ─────────────────
(async () => {
  {
    const e = ent(null, { isAdmin: true, email: 'dennis.kotlenko@gmail.com' });
    eq('ADMIN: allowed with no subscription', e.allowed, true);
    eq('ADMIN: top (pro) tier', e.tier, 'pro');
    eq('ADMIN: not grandfathered', e.grandfathered, false);
    eq('ADMIN: 30 templates', e.limits.templates, 30);
    eq('ADMIN: no upgrade path (already top)', e.upgrade.reason, null);
  }
  {
    // free_access via the DB-backed helper — mirror the relay/browser loaders.
    const db = {
      user: {
        findUnique: async () => ({ isAdmin: false, email: 'granted@x.com', subscription: null }),
      },
      freeAccessEmail: { findUnique: async () => ({ email: 'granted@x.com' }) },
    };
    const e = await evaluateUserEntitlement(db, 'u-free', NOW);
    eq('FREE-ACCESS: allowed', e.allowed, true);
    eq('FREE-ACCESS: state free_access', e.state, 'free_access');
    eq('FREE-ACCESS: top (pro) tier', e.tier, 'pro');
    eq('FREE-ACCESS: full templates', e.limits.templates, 30);
  }

  console.log(`\n✓ pricing-trial-limited gate-proof: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
