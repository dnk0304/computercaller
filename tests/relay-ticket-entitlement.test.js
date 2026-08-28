// Regression tests for the RELAY-TICKET (app/api/auth/relay-ticket/route.ts)
// entitlement gate — the same one-source drift bug merge 6235d6c fixed in
// proxy.ts, fixed here 2026-08-15.
//
// THE BUG: this route hand-rolled its own `db.user.findUnique` (selecting
// isAdmin/email/subscription, and NOT planId) then called the PURE
// `evaluateEntitlement`. Two consequences:
//
//   1. FREE-ACCESS LOCKOUT. The DB-backed FreeAccessEmail allowlist was never
//      resolved. A free-access user cleared proxy.ts AND server.js:1251 (both
//      call evaluateUserEntitlement, which folds in isFreeAccessEmail) and was
//      then denied `403 subscription_required` HERE. The user-visible bug was
//      not fixed by the proxy merge — the wall just moved one step further in.
//      netsoftgi@gmail.com and eines.josef@gmail.com reached /app and still
//      could not drive the phone.
//
//   2. EVERY TICKET RESOLVED TO 'solo'. `planId` was never selected, so
//      resolveTier saw `subscription.planId === undefined` and fell to its safe
//      default for EVERYONE — including paying Plus/Pro customers, who were
//      under-served their tier limits at the relay (server.js caches ws.tier off
//      the admission result).
//
// FAIL-CLOSED is the whole point of this route. It is the PRIMARY v1 money
// chokepoint: the ticket is what the browser trades to open the WS and actually
// drive the phone. Unlike the UX-layer proxy, a DB error here MUST deny, so
// `isEntitlementIndeterminate` is deliberately NOT applied. Case 6 pins that.
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/relay-ticket-entitlement.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this test targets the
   plain-CJS entitlement core (see lib/entitlement-core.js header) and follows
   the repo's runner-less CJS test convention. */

const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { evaluateUserEntitlement } = require('../lib/entitlement-core.js');
const { PLAN_IDS } = require('../lib/tiers-core.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-15T12:00:00.000Z');

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

// ── The route's decision, mirrored EXACTLY (relay-ticket/route.ts) ───────────
// Returns { status, body, tier }. Keep in sync with the route.
//
// Order is load-bearing and matches the route: sessionVersion (409) is resolved
// BEFORE entitlement, so a kicked session keeps reading as 409 rather than being
// re-labelled a billing problem.
async function relayTicketDecision(db, payload, now) {
  let user;
  try {
    user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { sessionVersion: true },
    });
  } catch {
    return { status: 401, body: 'Not authenticated', tier: null };
  }
  if (!user) return { status: 401, body: 'Not authenticated', tier: null };

  const tokenVer = typeof payload.ver === 'number' ? payload.ver : 0;
  if (tokenVer !== user.sessionVersion) {
    return { status: 409, body: 'session_superseded', tier: null };
  }

  // UNCONDITIONAL — no isEntitlementIndeterminate escape hatch.
  const ent = await evaluateUserEntitlement(db, payload.userId, now);
  if (!ent.allowed) {
    return { status: 403, body: 'subscription_required', tier: ent.tier, state: ent.state };
  }
  return { status: 200, body: 'ticket', tier: ent.tier, state: ent.state };
}

// ── Mock Prisma client ──────────────────────────────────────────────────────
function makeDb({
  user,
  sessionVersion = 0,
  freeAccess = false,
  throwOnUser = false,
  throwOnFree = false,
}) {
  return {
    user: {
      findUnique: async (args) => {
        if (throwOnUser) throw new Error('simulated DB blip');
        // The route makes TWO distinct selects against this model: a lean
        // sessionVersion probe, and entitlement-core's own richer select. Serve
        // whichever was asked for so the mock cannot paper over a bad select.
        if (args && args.select && args.select.sessionVersion) {
          return user === null ? null : { sessionVersion };
        }
        return user;
      },
    },
    freeAccessEmail: {
      findUnique: async () => {
        if (throwOnFree) throw new Error('simulated DB blip');
        return freeAccess ? { email: 'x' } : null;
      },
    },
  };
}

const NOT_ALLOWLISTED = 'netsoftgi@gmail.com'; // not in ENTITLEMENT_ALLOWLIST
const VER0 = { userId: 'u', ver: 0 };

(async () => {
  // 1. FREE-ACCESS + NO SUBSCRIPTION → mints a ticket. This is the live prod
  //    lockout (netsoftgi@gmail.com): 403 before the fix, 200 after.
  {
    const db = makeDb({
      user: { isAdmin: false, email: NOT_ALLOWLISTED, subscription: null },
      freeAccess: true,
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('1. free-access + no subscription mints a ticket', d.status, 200);
    eq('1. state is free_access', d.state, 'free_access');
    eq('1. free-access grant is Pro tier', d.tier, 'pro');
  }

  // 2. FREE-ACCESS + EXPIRED TRIAL → mints a ticket (eines.josef@gmail.com).
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'eines.josef@gmail.com',
        subscription: {
          status: 'trial',
          trialEndsAt: new Date(NOW.getTime() - 10 * DAY_MS),
          currentPeriodEnd: null,
          planId: null,
        },
      },
      freeAccess: true,
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('2. free-access + expired trial mints a ticket', d.status, 200);
    eq('2. state is free_access', d.state, 'free_access');
  }

  // 3. TIER RESOLUTION — the second half of the bug. A paying customer's planId
  //    must reach resolveTier. Before the fix planId was never selected, so all
  //    three of these resolved to 'solo'.
  for (const [tier, planId] of Object.entries(PLAN_IDS)) {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'sendyfeldheim@gmail.com',
        subscription: {
          status: 'active',
          trialEndsAt: new Date(NOW.getTime() - 30 * DAY_MS),
          currentPeriodEnd: new Date(NOW.getTime() + 26 * DAY_MS),
          planId,
        },
      },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq(`3. paying ${tier} customer mints a ticket`, d.status, 200);
    eq(`3. paying ${tier} customer resolves to '${tier}' (not solo)`, d.tier, tier);
  }

  // 3b. NEW limited trial (2026-08-17): a trialing NEW row mints a ticket (the
  //     paywall still admits — trial users drive the phone) but resolves to the
  //     limited 'trial' tier REGARDLESS of the plan attached at checkout.
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'sendyfeldheim@gmail.com',
        subscription: {
          status: 'trial',
          trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS),
          currentPeriodEnd: null,
          planId: PLAN_IDS.pro,
        },
      },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('3b. live trial mints a ticket', d.status, 200);
    eq('3b. new trial resolves to the limited trial tier (ignores plan)', d.tier, 'trial');
  }

  // 3c. GRANDFATHERED trialing row keeps the OLD behavior: its plan's full tier.
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'sendyfeldheim@gmail.com',
        subscription: {
          status: 'trial',
          trialEndsAt: new Date(NOW.getTime() + 5 * DAY_MS),
          currentPeriodEnd: null,
          planId: 'plan_IvKRyvHtl4Q8w',
          grandfathered: true,
        },
      },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('3c. grandfathered trial mints a ticket', d.status, 200);
    eq('3c. grandfathered trial keeps its plan full tier (plus)', d.tier, 'plus');
  }

  // 4. NO SUBSCRIPTION → FREE TIER admits at the relay (dispatch
  //    forge/free-tier-p1, 2026-08-28). CHANGED DELIBERATELY: previously a
  //    never-subscribed user got 403 subscription_required. Free tier makes them
  //    the no-card entry point — they mint a relay ticket and drive the phone,
  //    with the daily 20-call / 10-message caps enforced at the frame gate
  //    (server.js), NOT here. The relay-ticket route needs NO code change: it
  //    keys on ent.allowed, which is now true for free_tier.
  {
    const db = makeDb({
      user: { isAdmin: false, email: NOT_ALLOWLISTED, subscription: null },
      freeAccess: false,
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('4. free-tier user mints a ticket', d.status, 200);
    eq('4. state is free_tier', d.state, 'free_tier');
    eq('4. free-tier resolves to the free tier', d.tier, 'free');
  }
  // 4a. an EXPIRED trial is still denied — free tier is only for NO subscription
  //     row, never a lapsed one (that row hits rule 6 → trial_expired → 403).
  //     Paywall byte-stable for every legacy trial/expired row.
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: NOT_ALLOWLISTED,
        subscription: {
          status: 'trial',
          trialEndsAt: new Date(NOW.getTime() - DAY_MS),
          currentPeriodEnd: null,
          planId: null,
        },
      },
      freeAccess: false,
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('4b. expired trial without free access is denied', d.status, 403);
    eq('4b. state is trial_expired', d.state, 'trial_expired');
  }

  // 5. NO-LOCKOUT — admin and ENTITLEMENT_ALLOWLIST always mint, at top tier.
  {
    const db = makeDb({
      user: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('5. admin mints with no subscription', d.status, 200);
    eq('5. admin is never gated down from Pro', d.tier, 'pro');
  }
  {
    // isAdmin FALSE on Dennis's row (the fragile manual prod flag was lost).
    // Rule (2) ENTITLEMENT_ALLOWLIST_FALLBACK still admits him, which is why
    // this route not using the isAdminUser() email fallback cannot lock him out.
    const db = makeDb({
      user: { isAdmin: false, email: 'dennis.kotlenko@gmail.com', subscription: null },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('5b. lost isAdmin flag still admits Dennis via allowlist', d.status, 200);
    eq('5b. state is allowlisted', d.state, 'allowlisted');
  }
  {
    const db = makeDb({
      user: { isAdmin: false, email: 'reviewer@computercaller.com', subscription: null },
    });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('5c. allowlisted reviewer mints', d.status, 200);
  }

  // 6. ⭐ FAIL-CLOSED REGRESSION GUARD. The proxy fixes this same drift by
  //    failing OPEN via isEntitlementIndeterminate. This route must NOT inherit
  //    that: a DB error is an outage, and an outage must not become free
  //    product. A copy-paste of the proxy's two-line pattern would fail here.
  {
    const db = makeDb({ user: null, throwOnUser: true });
    const d = await relayTicketDecision(db, VER0, NOW);
    // The sessionVersion probe throws first → 401. Either way: NO ticket.
    eq('6. DB error mints NO ticket', d.body === 'ticket', false);
    eq('6. DB error is not a 200', d.status !== 200, true);
  }
  {
    // Isolate the entitlement half: the sessionVersion probe succeeds, then the
    // entitlement lookup throws. Must be 403, NOT a fail-open 200.
    const db = {
      user: {
        findUnique: async (args) => {
          if (args && args.select && args.select.sessionVersion) return { sessionVersion: 0 };
          throw new Error('simulated DB blip');
        },
      },
      freeAccessEmail: { findUnique: async () => null },
    };
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('6b. entitlement DB error DENIES (fail-closed)', d.status, 403);
    eq('6b. state is error', d.state, 'error');
    eq('6b. error result gates to solo (least privilege)', d.tier, 'solo');
  }
  {
    // Missing user row: the proxy fails OPEN on this; this route must not.
    const db = makeDb({ user: null });
    const d = await relayTicketDecision(db, VER0, NOW);
    eq('6c. missing user row mints NO ticket', d.status, 401);
  }

  // 7. SESSION-VERSION 409 PRESERVED, and resolved BEFORE entitlement so a
  //    kicked session is never mislabelled as a billing failure.
  {
    const db = makeDb({
      user: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
      sessionVersion: 7,
    });
    const d = await relayTicketDecision(db, { userId: 'u', ver: 3 }, NOW);
    eq('7. stale sessionVersion yields 409', d.status, 409);
    eq('7. body is session_superseded', d.body, 'session_superseded');
  }
  {
    // An UNENTITLED user with a stale version still reads 409, not 403 — the
    // ordering guarantee the client depends on to route to the KickedSessionGate.
    const db = makeDb({
      user: { isAdmin: false, email: NOT_ALLOWLISTED, subscription: null },
      sessionVersion: 7,
    });
    const d = await relayTicketDecision(db, { userId: 'u', ver: 3 }, NOW);
    eq('7b. 409 wins over 403 (superseded checked first)', d.status, 409);
  }
  {
    const db = makeDb({
      user: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
      sessionVersion: 4,
    });
    const d = await relayTicketDecision(db, { userId: 'u', ver: 4 }, NOW);
    eq('7c. matching sessionVersion proceeds to mint', d.status, 200);
  }

  // 8. Source-text guards on the real route — the mirror above is only as good
  //    as its fidelity to the file.
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'auth', 'relay-ticket', 'route.ts'),
      'utf8',
    );
    // Strip comments — this file DOCUMENTS the old bug at length, and a naive
    // grep would match the prose describing it and pass for the wrong reason.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    eq('8. route calls the shared evaluateUserEntitlement', code.includes('evaluateUserEntitlement('), true);
    eq('8. route no longer calls the pure evaluateEntitlement', /\bevaluateEntitlement\s*\(/.test(code), false);
    eq('8. route no longer selects isAdmin itself', code.includes('isAdmin'), false);
    // ⭐ The fail-closed pin: importing this predicate here would be the bug.
    eq(
      '8b. route does NOT use isEntitlementIndeterminate (fail-closed)',
      code.includes('isEntitlementIndeterminate'),
      false,
    );
    eq('8c. the 403 deny is still present', code.includes("status: 403"), true);
    eq('8d. the 409 superseded path is still present', code.includes('session_superseded'), true);
    eq('8e. the sessionVersion check is still present', code.includes('sessionVersion'), true);
    eq('8f. the idle-timeout gate is still present', code.includes('idle_timeout'), true);
  }

  // 9. The m2m sibling and server.js must use the same one source (audited
  //    2026-08-15: both already did — this pins them so they cannot drift back).
  {
    const m2m = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'auth', 'relay-ticket', 'm2m', 'route.ts'),
      'utf8',
    );
    eq('9. m2m route uses evaluateUserEntitlement', m2m.includes('evaluateUserEntitlement('), true);
    eq('9. m2m route does not fail open', m2m.includes('isEntitlementIndeterminate'), false);

    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    eq('9b. server.js uses evaluateUserEntitlement', server.includes('evaluateUserEntitlement(db, userId)'), true);
    eq('9b. server.js does not fail open', server.includes('isEntitlementIndeterminate'), false);
  }

  console.log(`\n✓ relay-ticket-entitlement: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
