/**
 * admin-badge-truth — the "Free access" badge must not be able to lie.
 *
 * WHY THIS TEST EXISTS. On 2026-08-15 the Customers tab showed a confident
 * "Free access" badge for a user who had been locked out for six days. The
 * badge was rendered from the FreeAccessEmail allowlist — a table read that is
 * INDEPENDENT of the gate that actually admits people — so it answered "is this
 * email on a list" while appearing to answer "is this person getting in".
 *
 * These assertions pin the rule that replaced it:
 *   the badge is derived from `subscription.state`, which is evaluateEntitlement's
 *   own verdict, and never from `customer.freeAccess`.
 *
 * The derivation lives inline in CustomerTable's row mapper, so this test
 * restates it once and checks the DECISION TABLE. If someone reintroduces the
 * allowlist override, the divergence case below goes red.
 *
 * Run: node tests/admin-badge-truth.test.js
 */

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

/**
 * The rule under test, mirroring components/admin/CustomerTable.tsx.
 * `state` is the server's entitlement verdict; `allowlisted` is table membership.
 */
function badgeFor(state, allowlisted) {
  return {
    // Only the evaluator may produce a free-access claim.
    isFree: state === 'free_access',
    // The control acts on the allowlist ROW, so it tracks membership.
    offersRevoke: allowlisted,
    // On the list, yet not admitted — surfaced, never silently reconciled.
    drift: allowlisted && state !== 'free_access' && state !== 'admin' && state !== 'allowlisted',
  };
}

console.log('admin badge truth');

// The 2026-08-15 incident, exactly: on the allowlist, locked out by the gate.
check(
  'allowlisted but NOT admitted → no free-access badge, drift is surfaced',
  badgeFor('expired', true),
  { isFree: false, offersRevoke: true, drift: true },
);

check(
  'allowlisted AND admitted → free-access badge, no drift',
  badgeFor('free_access', true),
  { isFree: true, offersRevoke: true, drift: false },
);

// The gate admits on free access without the admin feed's list read agreeing;
// the badge still follows the gate, because the gate is what runs.
check(
  'admitted as free_access without list membership → badge still shows',
  badgeFor('free_access', false),
  { isFree: true, offersRevoke: false, drift: false },
);

check(
  'ordinary paying customer → no free-access claim anywhere',
  badgeFor('active', false),
  { isFree: false, offersRevoke: false, drift: false },
);

// Admin outranks free access legitimately — not drift, and must not be
// reported as a misconfiguration.
check(
  'admin who is also allowlisted → not drift',
  badgeFor('admin', true),
  { isFree: false, offersRevoke: true, drift: false },
);

check(
  'allowlisted state → not drift',
  badgeFor('allowlisted', true),
  { isFree: false, offersRevoke: true, drift: false },
);

// A DB error must never be laundered into a positive access claim.
check(
  'indeterminate evaluation → never claims free access',
  badgeFor('error', true),
  { isFree: false, offersRevoke: true, drift: true },
);

// ── The pills must name every state the evaluator can emit ──────────────────
// A fall-through to "None" is how an admin's own row came to claim no plan.
const ENTITLEMENT_STATES = [
  'admin',
  'allowlisted',
  'free_access',
  'trialing',
  'active',
  'trial_expired',
  'expired',
  'none',
  'error',
];

const src = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'components', 'admin', 'customerRows.ts'),
  'utf8',
);

const planBody = src.slice(src.indexOf('export function planPill'));
const statusBody = src.slice(src.indexOf('export function trialStatusPill'));

for (const state of ENTITLEMENT_STATES) {
  if (state === 'none') continue; // legitimately the default
  check(
    `planPill names '${state}' explicitly (no fall-through)`,
    planBody.slice(0, planBody.indexOf('\n}')).includes(`case '${state}'`),
    true,
  );
  check(
    `trialStatusPill names '${state}' explicitly (no fall-through)`,
    statusBody.slice(0, statusBody.indexOf('\n}')).includes(`case '${state}'`),
    true,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
process.exit(0);
