#!/usr/bin/env node
/**
 * tests/e2e-resume-sw-key-race.test.mjs — T-RESUME-SW-KEY-RACE (RULE 30).
 *
 * ── WHAT WENT WRONG ON PROD ────────────────────────────────────────────────
 * live-acceptance 9ca5ba7, 2026-09-23. The lab pair was formed while the
 * service worker still had no registered key, so the transcript went out with
 * `recipients=1 swBridge=none` — NO extension recipient in it. The browser was
 * restarted on the same profile inside the relay's 180 s soft hold; the relay
 * auto-resumed the pair (gap 4979 ms) and the page got PAIRING_ACTIVE
 * resumed:true at 20:15:16.706Z. 220 ms later the M-A5-3 coverage guard fired:
 *
 *   [E2E] re-pair-needed — the SAS transcript carries an extension key the
 *   service worker no longer reports (M-A5-3)
 *
 * -> leaveActive -> relay `terminateActivePair: user_left` -> the phone's E2E
 * torn down, and the user was told "This browser's keys were cleared". Nothing
 * had been cleared. The restarted SW had come up WITH a key; the transcript
 * simply never carried one.
 *
 * ── WHY A TEST AND NOT A PATCH ─────────────────────────────────────────────
 * This is a RACE, and the same step PASSED on deploy #10 an hour earlier. A
 * defect that is green half the time cannot be held by a live run — it needs a
 * harness that owns the clock. So `awaitSwKeyAnswer` takes its `sleep` as an
 * argument and this file supplies a virtual one, landing the SW's answer at
 * 0 ms, 1 s and never, and asserting the verdict AND what the wait cost.
 *
 * ── WHAT IS REAL HERE ──────────────────────────────────────────────────────
 * The three shipped functions, called in the order hooks/useE2e.ts
 * onPairingActive calls them (sasCoverage -> awaitSwKeyAnswer -> the guard ->
 * sasCoverage again -> swKeyGuardVerdict), the real `readAcceptBlock` /
 * `readSwKey` parsers on the way in, and the real `encryptionIndicator` copy on
 * the way out. Nothing about the decision is re-implemented in this file — the
 * driver only moves the clock and delivers the bridge message.
 *
 * ── AND THE CONTROLS ───────────────────────────────────────────────────────
 * Section 4 plants the PRE-FIX predicate and requires it to go RED on the prod
 * row: an assertion that both implementations pass proves nothing about the
 * bug. Section 5 forces `graceExpired:false` on the late row and requires the
 * leave to disappear, so the grace flag is proven load-bearing rather than
 * decorative. Section 6 pins the copy and requires it NOT to be the
 * "keys were cleared" line.
 *
 * Run: node tests/e2e-resume-sw-key-race.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readAcceptBlock,
  readSwKey,
  sasCoverage,
  swKeyGuardVerdict,
  awaitSwKeyAnswer,
} from '../hooks/phoneE2e.ts';
import { E2E_ERRORS, encryptionIndicator } from '../lib/encryptedModeCopy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'e2e-resume-sw-key-race-vectors.json'), 'utf8'),
);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── symbolic keys: real SEC1 shapes, so readAcceptBlock/readSwKey accept them ─
const key = (b) => Buffer.from([4, ...new Array(64).fill(b)])
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const KEYS = {
  phone: key(0x11),
  web: key(0x22),
  'ext-live': key(0x33),
  'ext-other': key(0x44),
};

const blockFor = (transcript) => readAcceptBlock({
  v: 1,
  mode: 1,
  kid: 'kid-resume',
  epk: key(0xaa),
  recipKeys: transcript.map((t) => KEYS[t]),
  wraps: [{ deviceId: 'web-1', wrap: 'd3JhcA' }],
});

const SW_UNKNOWN = readSwKey(null);
const SW_ANSWERS = {
  'present-live': readSwKey({ v: 1, deviceId: 'ext-1', pub: KEYS['ext-live'] }),
  'present-other': readSwKey({ v: 1, deviceId: 'ext-1', pub: KEYS['ext-other'] }),
  absent: readSwKey({ v: 1, deviceId: null, pub: null }),
};

/**
 * The page's sequence, verbatim from hooks/useE2e.ts onPairingActive. The only
 * things this driver owns are the CLOCK and the delivery of the bridge message;
 * every decision below is the shipped function's.
 */
async function runRow(row, { graceMs }) {
  const block = blockFor(row.transcript);
  // `swRef.current` — a live ref the message listener overwrites, exactly as
  // the hook holds it. Read through a function, never captured.
  let sw = row.answerAtMs === 0 && row.swAnswer !== 'never'
    ? SW_ANSWERS[row.swAnswer]
    : SW_UNKNOWN;
  let now = 0;
  let requests = 0;
  const deliverDue = () => {
    if (row.swAnswer === 'never' || row.answerAtMs === null) return;
    if (now >= row.answerAtMs) sw = SW_ANSWERS[row.swAnswer];
  };
  const sleep = async (ms) => { now += ms; deliverDue(); };

  const covFor = (v) => sasCoverage(block, {
    ourPub: KEYS.web,
    phonePub: KEYS.phone,
    sw: v,
  });

  let graceExpired = false;
  if (row.resumed && sw.status === 'unknown' && covFor(sw).unattributed > 0) {
    const { answered } = await awaitSwKeyAnswer({
      readStatus: () => sw.status,
      request: () => { requests += 1; },
      graceMs,
      sleep,
    });
    graceExpired = !answered;
  }
  const coverage = covFor(sw);
  const verdict = swKeyGuardVerdict(coverage, { resumed: row.resumed, graceExpired });
  return { coverage, verdict, waitedMs: now, requests, graceExpired, sw, block };
}

// ── 1. every vector row ─────────────────────────────────────────────────────
const graceMs = VECTORS.graceMs;
eq('the vector file pins the grace this lane ships', graceMs, 5000);
check('the vector file carries every row this suite exists for', VECTORS.rows.length >= 10,
  `${VECTORS.rows.length} rows`);

const byName = new Map();
for (const row of VECTORS.rows) {
  const r = await runRow(row, { graceMs });
  byName.set(row.name, r);
  eq(`${row.name}: leave`, r.verdict.leave, row.expect.leave);
  eq(`${row.name}: error`, r.verdict.error ?? null, row.expect.error);
  eq(`${row.name}: coversSw`, r.coverage.coversSw, row.expect.coversSw);
  eq(`${row.name}: the wait cost`, r.waitedMs, row.expect.waitedMs);
  // A leave must always be able to say WHY, in words, or the surface has
  // nothing to render and the console line is empty.
  check(`${row.name}: a leave carries a detail`,
    !r.verdict.leave || (typeof r.verdict.detail === 'string' && r.verdict.detail.length > 20));
  check(`${row.name}: a stay carries no error`, r.verdict.leave || r.verdict.error === undefined);
}

// ── 2. the grace is spent ONLY where it is needed ───────────────────────────
{
  // One re-query, and only on the rows that actually waited. A fix that asked
  // the bridge on every PAIRING_ACTIVE would be a message storm at 25 ms.
  eq('a resumed pair with a live answer already in hand asks nothing',
    byName.get('resumed-ext-key-arrives-at-0ms').requests, 0);
  eq('a resumed pair with NO extension recipient asks nothing',
    byName.get('resumed-no-ext-recipient-sw-silent').requests, 0);
  eq('a resumed pair waiting on the worker asks exactly once',
    byName.get('resumed-ext-key-arrives-at-1s').requests, 1);
  eq('...and so does the one that never gets an answer',
    byName.get('resumed-ext-key-arrives-late').requests, 1);
  eq('a FRESH pair never enters the grace at all',
    byName.get('fresh-pair-sw-silent-with-ext-recipient').requests, 0);
  check('the answer that lands inside the grace ends the wait EARLY',
    byName.get('resumed-ext-key-arrives-at-1s').waitedMs < graceMs);
  eq('the silent one pays the whole grace and no more',
    byName.get('resumed-ext-key-arrives-late').waitedMs, graceMs);
}

// ── 3. the prod row, named ──────────────────────────────────────────────────
{
  const prod = byName.get('prod-swbridge-none-pair-resumed');
  check('PROD 9ca5ba7: the resumed pair is KEPT', prod.verdict.leave === false);
  eq('PROD 9ca5ba7: ...and nothing in the transcript is unattributed',
    prod.coverage.unattributed, 0);
  eq('PROD 9ca5ba7: ...the SW answer was definitive all along',
    prod.coverage.swStatus, 'present');
  check('PROD 9ca5ba7: ...and the badge still does not CLAIM extension coverage',
    prod.coverage.coversSw === false);
}

// ── 4. NEGATIVE CONTROL: the pre-fix predicate must go RED on the prod row ──
{
  /** hooks/phoneE2e.ts as it shipped at 9ca5ba7. */
  const preFixStale = (block, sw) => {
    const livePub = sw.status === 'present' ? sw.recipient?.pub ?? null : null;
    return sw.status === 'present' && livePub !== null && !block.recipKeys.includes(livePub);
  };
  const prod = byName.get('prod-swbridge-none-pair-resumed');
  check('control: the PRE-FIX predicate tears the prod pair down (it is the bug)',
    preFixStale(prod.block, prod.sw) === true);
  check('control: ...and the shipped one keeps it — the two DISAGREE',
    preFixStale(prod.block, prod.sw) !== prod.coverage.staleSwKey);

  // ...and the control is not vacuous: on a genuinely swapped key the two
  // implementations AGREE, which is how we know the fix narrowed the predicate
  // instead of disabling it.
  const swapped = byName.get('resumed-sw-reports-a-different-key');
  check('control: on a REAL stale advert both readings refuse',
    preFixStale(swapped.block, swapped.sw) === true && swapped.coverage.staleSwKey === true);
}

// ── 5. NEGATIVE CONTROL: `graceExpired` is load-bearing ─────────────────────
{
  const late = byName.get('resumed-ext-key-arrives-late');
  check('the late row leaves ONLY because the grace expired',
    late.graceExpired === true && late.verdict.leave === true);
  const withoutGrace = swKeyGuardVerdict(late.coverage, { resumed: true, graceExpired: false });
  check('control: the same coverage with the grace still running does NOT leave',
    withoutGrace.leave === false);
  // The pre-fix code had no such flag at all, which is precisely why `unknown`
  // could be read as a verdict.
  const asUnknownFresh = swKeyGuardVerdict(late.coverage, { resumed: false, graceExpired: true });
  check('control: a NON-resumed pair is not leavable by the grace flag either',
    asUnknownFresh.leave === false);
}

// ── 6. the copy: never "your keys were cleared" ─────────────────────────────
{
  check('the new reason is a registered error code',
    E2E_ERRORS.includes('e2e-sw-key-unavailable'));
  const copy = encryptionIndicator({
    state: 'error', error: 'e2e-sw-key-unavailable', peer: { supports: true },
  });
  eq('the restart branch tells the user to pair again', copy.label, 'Pair again');
  eq('...with the TRUE reason', copy.detail,
    'This browser restarted before the extension was ready. Pair again.');
  check('...and never the cleared-keys story', !/cleared/i.test(copy.detail));

  const swapped = encryptionIndicator({
    state: 'error', error: 're-pair-needed', peer: { supports: true },
  });
  check('a SWAPPED key keeps the cleared-keys copy, which is what it is about',
    /cleared/i.test(swapped.detail));
  check('the two reasons are genuinely different strings', copy.detail !== swapped.detail);

  // Every leaving row's error must resolve to copy the surface can render.
  for (const [name, r] of byName) {
    if (!r.verdict.leave) continue;
    const c = encryptionIndicator({ state: 'error', error: r.verdict.error, peer: { supports: true } });
    check(`${name}: its reason renders`, typeof c.detail === 'string' && c.detail.length > 0);
    if (r.verdict.error === 'e2e-sw-key-unavailable') {
      check(`${name}: ...and does not blame cleared keys`, !/cleared/i.test(c.detail));
    }
  }
}

// ── 7. the vectors are not silently shrinkable ──────────────────────────────
{
  const names = VECTORS.rows.map((r) => r.name);
  for (const required of [
    'prod-swbridge-none-pair-resumed',
    'resumed-ext-key-arrives-at-0ms',
    'resumed-ext-key-arrives-at-1s',
    'resumed-ext-key-arrives-late',
    'resumed-sw-reports-a-different-key',
    'resumed-sw-definitively-has-no-key',
    'fresh-pair-stale-advert-still-refuses',
  ]) {
    check(`the vector file still carries ${required}`, names.includes(required));
  }
  check('every row says WHY it exists', VECTORS.rows.every((r) => typeof r.why === 'string' && r.why.length > 30));
  eq('row names are unique', new Set(names).size, names.length);
}

// ── 8. the detector itself ──────────────────────────────────────────────────
{
  // `check` must be able to fail, or all of the above is decoration.
  const before = failed;
  check('self-test (DELIBERATE — the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-resume-sw-key-race: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
