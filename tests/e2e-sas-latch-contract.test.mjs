/**
 * tests/e2e-sas-latch-contract.test.mjs — vc67 T-SAS-TIMEOUT-LATCH +
 * T-SAS-GATE-TIMEOUT-30S, RESUME-PROTOCOL v3.0 RULE 30.
 *
 * ONE vector file, `tests/e2e-sas-latch-vectors.json`, consumed by TWO
 * implementations:
 *
 *   - dnkdialer-android/app/src/test/.../E2eDowngradeLatchTest.kt — the phone
 *     half, running the REAL `DowngradeLatch`, `E2eNegotiation.decide` and
 *     `E2eSasGate.Pending`;
 *   - this file — the node twin, which re-derives the same table out of the
 *     KOTLIN SOURCES. A row edited on one side and not the other fails a build
 *     instead of shipping.
 *
 * ## What a node twin can honestly assert about Kotlin
 *
 * Not behaviour — there is no JVM here. What it CAN do, and what the INC-0923
 * and vc66 incidents both needed, is hold the TABLE and its SOURCE in
 * agreement: that `latchesOnRefusal` names every reason the vector file names,
 * puts each one on the side the file says, and that no call site in
 * `PhoneService.kt` latches around it. Those are textual facts about a file the
 * android lane may not have rebuilt, and they are the facts that drifted.
 *
 * The negative control matters as much as the assertions: this suite parses the
 * `when` branches out of the Kotlin rather than matching a name anywhere in the
 * file, so moving a reason from the `true` arm to the `false` arm changes the
 * result. It is proved by planting exactly that (see the lane's résumé).
 *
 * Run: node tests/e2e-sas-latch-contract.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const VECTORS = require('./e2e-sas-latch-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');
const KROOT = path.join(ROOT, 'dnkdialer-android/app/src/main/java/com/dnkdialer/companion');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/**
 * CRLF-safe read. The android tree is CRLF in a fresh checkout, and a `$`
 * anchored regex over CRLF matches after the CR — which silently disables
 * every line-oriented assertion below.
 */
function read(rel) {
  const src = readFileSync(path.join(KROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  check(`${rel} is readable and non-trivial`, src.length > 500, `${src.length} bytes`);
  return src;
}

/** Strip `//` line comments so prose about a reason cannot satisfy a match. */
function stripLineComments(src) {
  return src.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

const negotiation = read('E2eNegotiation.kt');
const service = read('PhoneService.kt');
const contract = read('E2eSasContract.kt');
const gate = read('E2eSasGate.kt');
const activity = read('MainActivity.kt');

// ── 1. the rule, parsed out of the `when` ───────────────────────────────────
//
// The body between `fun latchesOnRefusal(...)` and its closing brace, split on
// `-> true` / `-> false`. Anything that changes which arm a reason sits in
// changes what this reads.
console.log('\n1. latchesOnRefusal — the table');
{
  const body = stripLineComments(negotiation)
    .split('fun latchesOnRefusal(reason: RefusalReason): Boolean = when (reason) {')[1];
  check('latchesOnRefusal is present in E2eNegotiation.kt', Boolean(body));
  const decl = (body || '').split('\n');
  // Walk the arms in order; each `-> true|false` closes the group of reasons
  // listed since the previous arrow.
  const table = new Map();
  let pending = [];
  for (const line of decl) {
    const t = line.trim();
    if (t === '}' && pending.length === 0) break;
    const arrow = /->\s*(true|false)\s*$/.exec(t);
    const names = t.replace(/->\s*(true|false)\s*$/, '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => /^RefusalReason\.[A-Z_]+$/.test(n))
      .map((n) => n.slice('RefusalReason.'.length));
    pending.push(...names);
    if (arrow) {
      for (const n of pending) table.set(n, arrow[1] === 'true');
      pending = [];
    }
    if (t === '}') break;
  }

  const rows = VECTORS.latch.rows;
  eq('every row is represented in the when', table.size, rows.length);
  for (const row of rows) {
    check(`${row.id}: ${row.reason} appears in the rule`, table.has(row.reason));
    eq(`${row.id}: latches`, table.get(row.reason), row.latches);
  }

  // The enum itself must not carry a member no row pins.
  const enumBody = stripLineComments(negotiation)
    .split('enum class RefusalReason {')[1].split('\n        }')[0];
  const members = [...enumBody.matchAll(/^\s{12}([A-Z][A-Z_]+),\s*$/gm)].map((m) => m[1]);
  eq('the enum has exactly the pinned members', members.length, rows.length);
  for (const m of members) {
    check(`${m} is pinned by a row`, rows.some((r) => r.reason === m));
  }

  // The two that DO latch, named positively — a rule that latched nothing
  // would satisfy every "does not latch" row above.
  const latching = rows.filter((r) => r.latches).map((r) => r.reason).sort();
  eq('exactly two reasons latch', latching.length, 2);
  eq('and they are the peer-evidence ones', latching.join(','),
    'KEY_PIN_MISMATCH,PEER_OFFERED_NOTHING');
}

// ── 2. the call sites ───────────────────────────────────────────────────────
console.log('\n2. PhoneService call sites go through the rule');
{
  const s = stripLineComments(service);
  const door = VECTORS.latch.callSites.door;
  const bare = (s.match(/e2eDowngradeLatch\.latch\(/g) || []).length;
  eq('the only raw latch( call is inside the door',
    bare - 1, VECTORS.latch.callSites.bareLatchCalls);
  check(`${door} exists`, s.includes(`private fun ${door}(`));
  const calls = (s.match(new RegExp(`${door}\\(`, 'g')) || []).length - 1; // minus the declaration
  check(`${door} is used by every refusal path (found ${calls})`, calls >= 5);
  // Each named reason must actually be reachable from a call site: the pin
  // path, the malformed path, the SAS verdict map and the crypto-failure arms.
  for (const name of ['KEY_PIN_MISMATCH', 'SAS_MALFORMED', 'LOCAL_CRYPTO_FAILURE']) {
    check(`${name} is named at a call site`, s.includes(`RefusalReason.${name}`));
  }
  check('the SAS refusal maps the verdict rather than latching flat',
    /latchForRefusal\(refusalReasonFor\(sas\)\)/.test(s));
  const map = stripLineComments(service).split('private fun refusalReasonFor(')[1] || '';
  for (const [verdict, reason] of [
    ['TIMED_OUT', 'SAS_TIMED_OUT'],
    ['REFUSED', 'SAS_REFUSED'],
    ['CANCELLED', 'SAS_NOT_SHOWN'],
    ['MALFORMED', 'SAS_MALFORMED'],
  ]) {
    check(`Verdict.${verdict} maps to ${reason}`,
      new RegExp(`Verdict\\.${verdict}\\s*->[\\s\\S]{0,160}${reason}`).test(map));
    const row = VECTORS.latch.rows.find((r) => r.reason === reason);
    check(`and ${reason} does not latch`, row && row.latches === false);
  }
}

// ── 3. the clear table (unchanged by vc67) ──────────────────────────────────
console.log('\n3. clearsLatch is unchanged');
{
  const body = stripLineComments(negotiation)
    .split('fun clearsLatch(event: Event): Boolean = when (event) {')[1].split('\n            }')[0];
  for (const [event, clears] of Object.entries(VECTORS.latch.clear)) {
    if (event.startsWith('$')) continue;
    const re = new RegExp(`Event\\.${event}\\b[\\s\\S]{0,160}?->\\s*(true|false)`);
    const m = re.exec(body);
    check(`${event} appears in clearsLatch`, Boolean(m));
    if (m) eq(`clearsLatch(${event})`, m[1] === 'true', clears);
  }
}

// ── 4. the two deadlines ────────────────────────────────────────────────────
console.log('\n4. the SAS deadlines');
{
  const t = VECTORS.timeout;
  const s = stripLineComments(service);
  const short = /PENDING_REQUEST_TIMEOUT_MS = ([0-9_]+)L/.exec(s);
  const long = /SAS_SURFACED_TIMEOUT_MS = ([0-9_]+)L/.exec(s);
  check('PENDING_REQUEST_TIMEOUT_MS is declared', Boolean(short));
  check('SAS_SURFACED_TIMEOUT_MS is declared', Boolean(long));
  if (short) eq('the unacked deadline', Number(short[1].replace(/_/g, '')), t.unsurfacedMs);
  if (long) eq('the acked deadline', Number(long[1].replace(/_/g, '')), t.surfacedMs);
  check('the long deadline is longer than the short one',
    t.surfacedMs > t.unsurfacedMs, `${t.surfacedMs} vs ${t.unsurfacedMs}`);
  check('the accept path passes BOTH to the gate',
    /surfacedTimeoutMs = SAS_SURFACED_TIMEOUT_MS/.test(s));

  // The gate only takes the long deadline after the short one expires AND the
  // UI acked — the fail-closed half of the change.
  const g = stripLineComments(gate);
  check('the wait is two-phase',
    /fun await\(unsurfacedMs: Long, surfacedMs: Long = unsurfacedMs\): Verdict \{/.test(g));
  check('and the extension is conditional on the ack',
    /if \(!surfaced \|\| extra <= 0L\) return Verdict\.TIMED_OUT/.test(g));
  check('an expired wait is a refusal, never a proceed',
    !/return Verdict\.MATCHED/.test(g.split('fun await(unsurfacedMs')[1].split('\n        }')[0]));
}

// ── 5. the ack ──────────────────────────────────────────────────────────────
console.log('\n5. the SAS_SHOWN ack');
{
  const t = VECTORS.timeout;
  const declared = /const val ACTION_E2E_SAS_SHOWN = "([^"]+)"/.exec(stripLineComments(contract));
  check('the contract declares the ack action', Boolean(declared));
  if (declared) eq('and it is the action the vector file names', declared[1], t.ackAction);

  const show = stripLineComments(activity)
    .split('private fun showSasConfirm')[1].split('private fun hideSasConfirm')[0];
  check('showSasConfirm is sliceable', Boolean(show && show.length > 200));
  check('showSasConfirm acks once the digits are on screen',
    /ACTION_E2E_SAS_SHOWN/.test(show));
  check('the ack carries no digits',
    !/ACTION_E2E_SAS_SHOWN[\s\S]{0,400}EXTRA_SAS_DIGITS/.test(show));
  eq('and the vector file agrees', t.ackCarriesDigits, false);
  check('the malformed refusal precedes the ack',
    show.indexOf('dispatchSasVerdict(matched = false') < show.indexOf('ACTION_E2E_SAS_SHOWN'));

  const g = stripLineComments(gate);
  check('the gate listens for the ack on the SAS receiver',
    /addAction\(E2eSasContract\.ACTION_E2E_SAS_SHOWN\)/.test(g));
  check('an ack for another pairing is ignored',
    /fun markSurfaced\(forPairingId: String\): Boolean \{\n\s*if \(forPairingId != pairingId\) return false/
      .test(g));
  check('the ack cannot decide a verdict',
    !/markSurfaced[\s\S]{0,200}decided\.compareAndSet/.test(g));
}

// ── 6. expiry: teardown + copy ──────────────────────────────────────────────
console.log('\n6. what the user is told on expiry');
{
  const t = VECTORS.timeout;
  const s = stripLineComments(service);
  const copy = /const val SAS_TIMEOUT_MESSAGE = "([^"]+)"/.exec(stripLineComments(negotiation));
  check('a timeout message exists', Boolean(copy));
  if (copy) eq('and it is the pinned copy', copy[1], t.expiryCopy);
  check('it is not the generic setup-failure copy',
    copy && copy[1] !== 'Couldn’t set up encrypted pairing — try again');
  const refusal = s.split('if (!E2eSasGate.mayProceed(sas)) {')[1]
    .split('e2eSasPending = false')[0];
  check('the refusal arm is sliceable', refusal.length > 200);
  check(`expiry uses the existing ${t.expiryTeardown} funnel`,
    refusal.includes('leaveActivePair('));
  check('the pair is still torn down', refusal.includes('tearDownE2e('));
  check('a timed-out SAS is reported as not-confirmed, not as a failure',
    /Verdict\.TIMED_OUT[\s\S]{0,160}SAS_TIMEOUT_MESSAGE/.test(refusal));
  // The other verdicts keep the existing copy — the change is scoped.
  check('every other refusal keeps ABORT_MESSAGE', /ABORT_MESSAGE/.test(refusal));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
