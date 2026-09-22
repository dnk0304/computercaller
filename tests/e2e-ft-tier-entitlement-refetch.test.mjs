/**
 * EXT-UI-3 (a) — a `tier` FILE_FAILED must invalidate the client's entitlement
 * snapshot exactly once; nothing else may.
 *
 * ── WHAT WOULD MAKE THIS SUITE VACUOUS, AND WHY IT IS NOT ───────────────────
 * Asserting the decision table against a list this file typed out would prove
 * only that the parser works. So the reason table is taken from the PRODUCT's
 * own frozen enum (`FILE_FAILED_REASONS` in lib/fileTransfer/reasons.ts) and
 * every member of it is pinned: `tier` arms, the other ten do not. A reason
 * added to the wire enum later lands in this loop automatically and has to be
 * classified deliberately, not by omission.
 *
 * ── THE "EXACTLY ONCE" HALF ─────────────────────────────────────────────────
 * The product does not hold a counter; it feeds `entitlementStaleKey(error)` to
 * a `useEffect` dependency array in FileTransferLayer, and React's
 * change-detection is what makes the call happen once. This suite models that
 * one rule and nothing else — an effect body runs when, and only when, its key
 * differs from the previous render's key — and drives the real key function
 * through a render script that contains the two cases the defect turns on:
 *   • the refetch's own state write re-renders the layer with the SAME failure
 *     still showing  → must NOT call again (this is the infinite-loop case);
 *   • a SECOND, distinct tier failure later in the session → must call again.
 * The model is not React. The end-to-end proof that the real component is wired
 * to this is the browser arm of scripts/ft-ui-proof.mjs, which pushes a real
 * FILE_FAILED through the real inbound path and asserts a second
 * /api/entitlement request plus the locked control appearing.
 */
import {
  entitlementStaleKey, invalidatesEntitlement, ENTITLEMENT_STALE_REASONS,
} from '../lib/fileTransfer/tierRefetch.ts';
import { FILE_FAILED_REASONS } from '../lib/fileTransfer/reasons.ts';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const eq = (name, a, b) => check(name, Object.is(a, b), { got: a, want: b });

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

// ── 1. the table comes from the product, and every member is classified ─────
check('the wire enum is non-trivial', FILE_FAILED_REASONS.length >= 11);
check('tier is in the product enum', FILE_FAILED_REASONS.includes('tier'));
check('quota is in the product enum', FILE_FAILED_REASONS.includes('quota'));
eq('exactly one reason invalidates the entitlement', ENTITLEMENT_STALE_REASONS.length, 1);
eq('and it is tier', ENTITLEMENT_STALE_REASONS[0], 'tier');
for (const r of FILE_FAILED_REASONS) {
  const want = r === 'tier';
  check(`${r} ${want ? 'invalidates' : 'does not invalidate'} the entitlement`,
    invalidatesEntitlement(r) === want, { reason: r, got: invalidatesEntitlement(r), want });
  check(`key for ${r} is ${want ? 'set' : 'null'}`,
    (entitlementStaleKey({ id: ID_A, reason: r }) !== null) === want);
}
// quota is the one a future reader is most likely to "fix" by hand.
eq('quota is a daily counter, not an entitlement change',
  entitlementStaleKey({ id: ID_A, reason: 'quota' }), null);

// ── 2. degenerate inputs never arm ──────────────────────────────────────────
eq('no failure showing', entitlementStaleKey(null), null);
eq('undefined', entitlementStaleKey(undefined), null);
eq('an empty id cannot key an effect', entitlementStaleKey({ id: '', reason: 'tier' }), null);
eq('a non-string reason', entitlementStaleKey({ id: ID_A, reason: 7 }), null);
eq('an unknown reason', entitlementStaleKey({ id: ID_A, reason: 'martians' }), null);

// ── 3. the key distinguishes transfers, not just reasons ────────────────────
check('two distinct tier failures produce distinct keys',
  entitlementStaleKey({ id: ID_A, reason: 'tier' })
  !== entitlementStaleKey({ id: ID_B, reason: 'tier' }));
check('the same tier failure produces a stable key',
  entitlementStaleKey({ id: ID_A, reason: 'tier' })
  === entitlementStaleKey({ id: ID_A, reason: 'tier' }));

/**
 * ── 4. the exactly-once property, over a render script ─────────────────────
 * `runEffect` is React's dependency rule and nothing more: run the body when
 * the key differs from the previous render's key.
 */
function replay(renders) {
  let calls = 0;
  let prev = Symbol('first-render');
  for (const error of renders) {
    const key = entitlementStaleKey(error);
    if (!Object.is(key, prev)) {
      prev = key;
      if (key) calls++;
    }
  }
  return calls;
}
const TIER_A = { id: ID_A, reason: 'tier' };
const TIER_B = { id: ID_B, reason: 'tier' };
const QUOTA_A = { id: ID_A, reason: 'quota' };
const NET_A = { id: ID_A, reason: 'transport' };

eq('a tier failure refetches once', replay([null, TIER_A]), 1);
eq('the refetch\'s own re-renders do not re-enter',
  replay([null, TIER_A, TIER_A, TIER_A, TIER_A]), 1);
eq('dismiss then re-fail on the SAME transfer refetches again',
  replay([null, TIER_A, null, TIER_A]), 2);
eq('a second, distinct tier failure refetches again',
  replay([null, TIER_A, TIER_A, null, TIER_B, TIER_B]), 2);
eq('a quota failure never refetches', replay([null, QUOTA_A, QUOTA_A, null]), 0);
eq('a transport failure never refetches', replay([null, NET_A, NET_A, null]), 0);
eq('a session with no failures never refetches', replay([null, null, null]), 0);
eq('non-tier failures around a tier one still yield exactly one',
  replay([null, QUOTA_A, null, TIER_A, TIER_A, null, NET_A, null]), 1);
// Every other reason in the product enum, driven through the same script.
for (const r of FILE_FAILED_REASONS.filter((x) => x !== 'tier')) {
  eq(`replay: ${r} yields 0 refetches`, replay([null, { id: ID_A, reason: r }, { id: ID_A, reason: r }]), 0);
}

// ── 5. positive control — the script CAN go red ─────────────────────────────
// If entitlementStaleKey ever returned a constant, case 4's "distinct failures"
// assertion would read 1 instead of 2. Prove the harness detects that shape
// rather than trusting it.
{
  const constantKey = () => 'tier';
  let calls = 0; let prev = Symbol('f');
  for (let i = 0; i < 4; i++) {
    const k = constantKey();
    if (!Object.is(k, prev)) { prev = k; calls++; }
  }
  eq('control: a constant key would collapse two failures into one', calls, 1);
}

const total = passed + failures.length;
console.log(`\ne2e-ft-tier-entitlement-refetch: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
