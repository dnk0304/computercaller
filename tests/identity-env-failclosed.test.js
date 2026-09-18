/**
 * tests/identity-env-failclosed.test.js
 * Dispatch forge/w-strip-email-literals (2026-09-17).
 *
 * WHAT THIS PROTECTS: lib/entitlement-core.js used to carry two hardcoded email
 * allowlists as string literals (the entitlement allowlist and the admin
 * email). The module is plain CommonJS and therefore cannot be tree-shaken, so
 * when a 'use client' component transitively imported it, those real addresses
 * shipped to every visitor in a publicly fetchable _next/static chunk.
 *
 * The literals are gone. Both identities now come EXCLUSIVELY from the
 * environment, read at call time, and both FAIL CLOSED when unset. This suite
 * pins that contract so a future "no-lockout" fallback cannot be reintroduced.
 *
 * NOTE: every address here is synthetic. No real personal address appears in
 * this repo's tests — that is the point of the dispatch.
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- this test targets the
   plain-CJS entitlement core (see lib/entitlement-core.js header) and follows
   the repo's runner-less CJS test convention. */

const assert = require('node:assert');

// Import BEFORE touching env to prove the reads are at call time, not load time.
const { isEntitlementAllowed, isAdminUser } = require('../lib/entitlement-core.js');

let pass = 0;
function ok(name, actual, expected) {
  assert.strictEqual(actual, expected, name);
  pass += 1;
  console.log('  PASS ', name);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

console.log('=== 1. ENTITLEMENT_ALLOWLIST unset → allowlist is EMPTY (no bypass) ===');
withEnv({ ENTITLEMENT_ALLOWLIST: undefined }, () => {
  ok('unset → nobody is allowlisted', isEntitlementAllowed('anyone@example.test'), false);
  // The two addresses that used to be hardcoded must NOT be special any more.
  ok('unset → the old admin fallback is not allowlisted', isEntitlementAllowed('admin@example.test'), false);
  ok('unset → the old reviewer fallback is not allowlisted', isEntitlementAllowed('reviewer@example.test'), false);
  ok('unset → null email', isEntitlementAllowed(null), false);
});
withEnv({ ENTITLEMENT_ALLOWLIST: '   ' }, () => {
  ok('whitespace-only → empty, no bypass', isEntitlementAllowed('anyone@example.test'), false);
});
withEnv({ ENTITLEMENT_ALLOWLIST: ',,  ,' }, () => {
  ok('separators-only → empty, no bypass', isEntitlementAllowed('anyone@example.test'), false);
});

console.log('=== 2. Reviewer bypass ONLY via ENTITLEMENT_ALLOWLIST ===');
withEnv({ ENTITLEMENT_ALLOWLIST: 'reviewer@example.test' }, () => {
  ok('listed reviewer admitted', isEntitlementAllowed('reviewer@example.test'), true);
  ok('case-insensitive', isEntitlementAllowed('REVIEWER@Example.TEST'), true);
  ok('trims surrounding whitespace', isEntitlementAllowed('  reviewer@example.test  '), true);
  ok('a non-listed address is refused', isEntitlementAllowed('someone@example.test'), false);
});
withEnv({ ENTITLEMENT_ALLOWLIST: ' a@example.test , reviewer@example.test ' }, () => {
  ok('CSV entries are trimmed', isEntitlementAllowed('reviewer@example.test'), true);
  ok('CSV first entry works too', isEntitlementAllowed('a@example.test'), true);
});
// The LOGIN allowlist (AUTH_ALLOWLIST) must NOT grant the paywall bypass — the
// two lists are deliberately decoupled (see lib/auth.ts). Setting only
// AUTH_ALLOWLIST must leave the entitlement allowlist empty.
withEnv({ ENTITLEMENT_ALLOWLIST: undefined, AUTH_ALLOWLIST: 'reviewer@example.test' }, () => {
  ok('AUTH_ALLOWLIST does NOT grant entitlement bypass',
    isEntitlementAllowed('reviewer@example.test'), false);
});

console.log('=== 3. ADMIN_EMAIL unset → admin via email is DISABLED (fail closed) ===');
withEnv({ ADMIN_EMAIL: undefined }, () => {
  ok('unset → email route to admin is closed',
    isAdminUser({ isAdmin: false, email: 'admin@example.test' }), false);
  ok('unset → arbitrary email is not admin',
    isAdminUser({ isAdmin: false, email: 'attacker@example.test' }), false);
  // The DB flag remains an independent, still-working route to admin.
  ok('unset → isAdmin DB flag still grants admin',
    isAdminUser({ isAdmin: true, email: 'someone@example.test' }), true);
});
withEnv({ ADMIN_EMAIL: '   ' }, () => {
  ok('whitespace-only ADMIN_EMAIL → closed',
    isAdminUser({ isAdmin: false, email: 'admin@example.test' }), false);
});

console.log('=== 4. ADMIN_EMAIL set → admin ONLY for the exact value ===');
withEnv({ ADMIN_EMAIL: 'admin@example.test' }, () => {
  ok('exact match → admin', isAdminUser({ isAdmin: false, email: 'admin@example.test' }), true);
  ok('case-insensitive match → admin',
    isAdminUser({ isAdmin: false, email: 'Admin@Example.TEST' }), true);
  ok('trimmed match → admin',
    isAdminUser({ isAdmin: false, email: '  admin@example.test  ' }), true);
  ok('a DIFFERENT address is NOT admin',
    isAdminUser({ isAdmin: false, email: 'attacker@example.test' }), false);
  ok('a superstring is NOT admin (no partial match)',
    isAdminUser({ isAdmin: false, email: 'xadmin@example.test' }), false);
});
withEnv({ ADMIN_EMAIL: ' admin@example.test ' }, () => {
  ok('env value itself is trimmed',
    isAdminUser({ isAdmin: false, email: 'admin@example.test' }), true);
});

console.log('=== 5. isAdminUser stays fail-closed on malformed input ===');
withEnv({ ADMIN_EMAIL: 'admin@example.test' }, () => {
  ok('null account', isAdminUser(null), false);
  ok('undefined account', isAdminUser(undefined), false);
  ok('empty object', isAdminUser({}), false);
  ok('non-object', isAdminUser('admin@example.test'), false);
  ok('non-string email', isAdminUser({ isAdmin: false, email: 42 }), false);
  ok('isAdmin truthy-but-not-true is NOT admin',
    isAdminUser({ isAdmin: 1, email: 'x@example.test' }), false);
});

console.log('=== 6. The removed constants are NOT exported any more ===');
const core = require('../lib/entitlement-core.js');
ok('no exported allowlist fallback constant',
  Object.keys(core).some((k) => k.includes('ALLOWLIST')), false);
ok('no exported admin-email fallback constant',
  Object.keys(core).some((k) => k.includes('ADMIN_EMAIL')), false);

console.log(`\nidentity-env-failclosed: ${pass} assertions PASSED`);
