// Regression tests for the BROWSER (proxy.ts) entitlement gate — the free-access
// drift bug, fixed 2026-08-15.
//
// THE BUG: proxy.ts hand-rolled its own `db.user.findUnique` + pure
// `evaluateEntitlement` call and never resolved the DB-backed FreeAccessEmail
// allowlist, while the relay gate (server.js → evaluateUserEntitlement) did.
// Admin-panel free-access grants therefore worked on the relay but bounced the
// same user to /subscribe forever in the browser. Proven in prod for
// netsoftgi@gmail.com (no subscription) and eines.josef@gmail.com (expired
// trial). proxy.ts now calls evaluateUserEntitlement — the same one source.
//
// FAIL-OPEN: evaluateUserEntitlement fails CLOSED (it is also the relay's money
// chokepoint). The proxy must NOT inherit that — a DB blip must not bounce a
// paying user. `isEntitlementIndeterminate` is the one place that distinction
// lives, and browserGateDecision below mirrors proxy.ts's two-line use of it.
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/browser-gate-entitlement.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this test targets the
   plain-CJS entitlement core (see lib/entitlement-core.js header) and follows
   the repo's runner-less CJS test convention. */

const assert = require('node:assert').strict;
const {
  evaluateUserEntitlement,
  isEntitlementIndeterminate,
} = require('../lib/entitlement-core.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-15T12:00:00.000Z');

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

// ── The proxy's decision, mirrored EXACTLY (proxy.ts, /app/* gate) ───────────
// `redirect: '/subscribe'` or `pass: true`. Keep in sync with proxy.ts.
async function browserGateDecision(db, userId, now) {
  try {
    const ent = await evaluateUserEntitlement(db, userId, now);
    if (!ent.allowed && !isEntitlementIndeterminate(ent)) {
      return { pass: false, redirect: '/subscribe', state: ent.state };
    }
    return { pass: true, redirect: null, state: ent.state };
  } catch {
    // Outer belt-and-braces fail-open.
    return { pass: true, redirect: null, state: 'threw' };
  }
}

// ── Mock Prisma client ──────────────────────────────────────────────────────
function makeDb({ user, freeAccess = false, throwOnUser = false, throwOnFree = false }) {
  return {
    user: {
      findUnique: async () => {
        if (throwOnUser) throw new Error('simulated DB blip');
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
const baseUser = { isAdmin: false, email: NOT_ALLOWLISTED, subscription: null };

(async () => {
  // 1. free-access email + NO subscription → allowed, free_access.
  //    (netsoftgi@gmail.com — this FAILED before the fix: browser said none/denied.)
  {
    const db = makeDb({ user: baseUser, freeAccess: true });
    const d = await browserGateDecision(db, 'u1', NOW);
    eq('1. free-access + no subscription passes', d.pass, true);
    eq('1. state is free_access', d.state, 'free_access');
    eq('1. no redirect', d.redirect, null);
  }

  // 2. free-access email + EXPIRED trial → allowed, free_access.
  //    (eines.josef@gmail.com — browser said trial_expired/denied before the fix.)
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
    const d = await browserGateDecision(db, 'u2', NOW);
    eq('2. free-access + expired trial passes', d.pass, true);
    eq('2. state is free_access', d.state, 'free_access');
  }

  // 3. active paying subscriber, NOT on any allowlist → allowed (Sendy control).
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'sendyfeldheim@gmail.com',
        subscription: {
          status: 'active',
          trialEndsAt: new Date(NOW.getTime() - 30 * DAY_MS),
          currentPeriodEnd: new Date(NOW.getTime() + 26 * DAY_MS),
          planId: null,
        },
      },
      freeAccess: false,
    });
    const d = await browserGateDecision(db, 'u3', NOW);
    eq('3. active paying subscriber passes', d.pass, true);
    eq('3. state is active', d.state, 'active');
  }

  // 4. no subscription, not free-access, not allowlisted → DENIED → /subscribe.
  {
    const db = makeDb({ user: baseUser, freeAccess: false });
    const d = await browserGateDecision(db, 'u4', NOW);
    eq('4. never-paid user is bounced', d.pass, false);
    eq('4. redirected to /subscribe', d.redirect, '/subscribe');
    eq('4. state is none', d.state, 'none');
  }

  // 4b. expired trial, no free access → still bounced (paywall byte-stable).
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
    const d = await browserGateDecision(db, 'u4b', NOW);
    eq('4b. expired trial without free access is bounced', d.redirect, '/subscribe');
    eq('4b. state is trial_expired', d.state, 'trial_expired');
  }

  // 5. admin → allowed regardless of subscription (NO-LOCKOUT short-circuit).
  {
    const db = makeDb({
      user: { isAdmin: true, email: 'dennis.kotlenko@gmail.com', subscription: null },
      freeAccess: false,
    });
    const d = await browserGateDecision(db, 'u5', NOW);
    eq('5. admin passes with no subscription', d.pass, true);
    eq('5. state is admin', d.state, 'admin');
  }

  // 5b. ENTITLEMENT_ALLOWLIST email (non-admin) → allowed (NO-LOCKOUT).
  {
    const db = makeDb({
      user: { isAdmin: false, email: 'reviewer@computercaller.com', subscription: null },
      freeAccess: false,
    });
    const d = await browserGateDecision(db, 'u5b', NOW);
    eq('5b. allowlisted reviewer passes', d.pass, true);
    eq('5b. state is allowlisted', d.state, 'allowlisted');
  }

  // 6. THE FAIL-OPEN REGRESSION GUARD. evaluateUserEntitlement fails CLOSED
  //    (allowed:false / state 'error'); the BROWSER gate must still pass the
  //    request through and NOT redirect. A naive swap would lock out every
  //    paying user, Dennis included, during a transient DB blip.
  {
    const db = makeDb({ user: null, throwOnUser: true });
    const d = await browserGateDecision(db, 'u6', NOW);
    eq('6. DB error → request passes (fail-open)', d.pass, true);
    eq('6. DB error → no redirect', d.redirect, null);
    eq('6. DB error state is error', d.state, 'error');
    // And the underlying core is still fail-CLOSED — the relay guarantee.
    const raw = await evaluateUserEntitlement(db, 'u6', NOW);
    eq('6. core still returns allowed:false (relay fail-closed intact)', raw.allowed, false);
    eq('6. error result is indeterminate', isEntitlementIndeterminate(raw), true);
  }

  // 6b. missing user row → also indeterminate → fail-open (prior behavior:
  //     the old code skipped the check entirely when user === null).
  {
    const db = makeDb({ user: null });
    const d = await browserGateDecision(db, 'u6b', NOW);
    eq('6b. missing user row → passes (fail-open)', d.pass, true);
    eq('6b. missing user row → no redirect', d.redirect, null);
  }

  // 6c. a genuine deny is NOT indeterminate (so case 4 can never be softened).
  {
    const db = makeDb({ user: baseUser, freeAccess: false });
    const raw = await evaluateUserEntitlement(db, 'u6c', NOW);
    eq('6c. no_subscription is a determinate deny', isEntitlementIndeterminate(raw), false);
  }
  eq('6d. null/malformed result reads as indeterminate', isEntitlementIndeterminate(null), true);

  // 7. free-access LOOKUP error must not flip an entitled payer to denied
  //    (isFreeAccessEmail is fail-closed internally → just "not free").
  {
    const db = makeDb({
      user: {
        isAdmin: false,
        email: 'sendyfeldheim@gmail.com',
        subscription: {
          status: 'active',
          trialEndsAt: new Date(NOW.getTime() - 30 * DAY_MS),
          currentPeriodEnd: null,
          planId: null,
        },
      },
      throwOnFree: true,
    });
    const d = await browserGateDecision(db, 'u7', NOW);
    eq('7. free-access lookup error leaves payer allowed', d.pass, true);
    eq('7. state still active', d.state, 'active');
  }

  // 8. /subscribe must stay OUTSIDE the proxy matcher — otherwise the redirect
  //    in case 4 loops forever. Asserted against the real exported matcher
  //    literal in proxy.ts (read as text: proxy.ts imports next/server and the
  //    `@/` alias, so it cannot be require()d here).
  {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'proxy.ts'), 'utf8');
    const m = src.match(/matcher:\s*\[([^\]]*)\]/);
    assert.ok(m, 'proxy.ts exports a matcher array');
    const patterns = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    eq('8. matcher is the expected 3 patterns', patterns, ['/', '/app/:path*', '/auth/:path*']);
    eq(
      '8. no matcher pattern covers /subscribe (no redirect loop)',
      patterns.some((p) => p === '/subscribe' || p.startsWith('/subscribe')),
      false,
    );
    // 8b. the proxy must call the SHARED loader, never re-roll its own lookup.
    eq('8b. proxy calls evaluateUserEntitlement', src.includes('evaluateUserEntitlement(db, payload.userId)'), true);
    eq('8b. proxy no longer hand-rolls db.user.findUnique', src.includes('db.user.findUnique'), false);
  }

  console.log(`\n✓ browser-gate-entitlement: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
