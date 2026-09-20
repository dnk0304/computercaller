#!/usr/bin/env node
/**
 * scripts/e2e-replay-proof.mjs — E2E-P6 deliverable (e), THE REPLAY HARNESS.
 *
 * Security Gate 2, numbered check (3): "drop-counter — replay harness over
 * 10 000 frames reports 0 legitimate frames dropped."
 *
 * ── THE TWO WORDS THIS FILE IS ABOUT ────────────────────────────────────────
 *
 *   LEGITIMATE DROP   — a frame the receiver has ALREADY seen arrives again.
 *                       A phone re-sends its un-acked outbox on resume and the
 *                       relay's `frameBuffer` re-sends a buffered window, so
 *                       this is ordinary, expected traffic. §13.5: it is DROPPED,
 *                       silently, COUNTED, and the socket is untouched. A
 *                       legitimate drop is NOT a fault. This harness asserts
 *                       the counter equals EXACTLY the number of duplicates it
 *                       injected — no more, no fewer.
 *
 *   ILLEGITIMATE DROP — a NEW, never-before-seen frame that did not reach the
 *                       application. This is data loss. This is the failure the
 *                       deliverable exists to catch, and it is what the brief's
 *                       "0 legitimate frames dropped" means in plain terms:
 *                       ZERO NEW FRAMES LOST. Target is exactly 0.
 *
 * A third thing that is NEITHER: a REJECTION. Anti-replay must never reject.
 * A receiver that answered a duplicate with an error, a re-pair request or a
 * socket close would turn every single reconnect into a failure — because the
 * resume replay IS the duplicate. That is the single most important property
 * in this file, and it is asserted on every lane.
 *
 * ── WHAT IS LIVE AND WHAT IS STATIC — READ BEFORE QUOTING A NUMBER ──────────
 *
 *   WEB           LIVE. `lib/e2e/session.mjs` imported and driven directly:
 *                 real createComputerSession, real AES-GCM seal/open from
 *                 lib/e2e/kdf.mjs, real createFailClosedSender, real
 *                 createDedupeWindow, real exported drop counter.
 *
 *   EXTENSION SW  LIVE. `chrome-extension/e2e/sw-session.js` is IMPORTED — the
 *                 real module, not a mirror. It touches `chrome.*` only inside
 *                 function bodies (never at module scope), so the import itself
 *                 is safe; a minimal in-memory `globalThis.chrome.storage`
 *                 surface is installed so the real `admitSeq` runs its real
 *                 persistence path. No `extractFn` text surgery and no mirror
 *                 was needed. THE ROUTE TAKEN IS PRINTED IN THE OUTPUT.
 *
 *   ANDROID       STATIC / VECTOR ONLY. Kotlin cannot execute here. Two things
 *                 are asserted: (1) frozen VECTORS — the admit/drop decision
 *                 for a fixed sequence schedule, produced by the two live lanes
 *                 and pinned in this file, so the Kotlin runner that belongs to
 *                 deliverable (g) has a table to agree with; (2) a TEXT drift
 *                 guard over E2eDedupe.kt asserting the frozen constants and
 *                 the absence of any reject/close verdict. THE ANDROID CODE WAS
 *                 NOT RUN. Nothing printed here may be read as Android passing.
 *
 *   RELAY         LIVE for a 500-frame slice; IN-PROCESS for the 10 000-frame
 *                 bulk. Reason: 10 000 frames through `node server.js` + Next +
 *                 Postgres blows the 3-minute budget, and the property under
 *                 test (the dedupe window) lives at the ENDPOINT, not in the
 *                 relay. So the bulk volume runs against the real endpoint
 *                 modules in-process, and a smaller slice runs over a real
 *                 WebSocket through the real relay with a real browser drop
 *                 and a real relay-side auto-resume. The output labels which is
 *                 which and never presents one as the other.
 *
 * ── ANTI-PATTERN GUARD ──────────────────────────────────────────────────────
 * Every headline assertion is proved capable of failing (section F): a NEW
 * frame is deliberately lost and the illegitimate-drop check is shown going
 * RED; a rejecting dedupe is substituted and the never-rejects check is shown
 * going RED; an empty run is fed to the volume check and it is shown going RED;
 * the Kotlin text guard is run against a doctored source and shown going RED.
 * An assertion that cannot fail is not evidence.
 *
 * Exit: prints `N passed, M failed`, then exits IMMEDIATELY (gate ticket
 * P5a-1.1 — a harness that prints its summary and then dangles is a hang).
 */

import { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── chrome stub, installed BEFORE the SW module is imported ─────────────────
// The SW module reads chrome.storage only inside function bodies, but
// installing the stub first keeps the import order honest regardless of how
// that file evolves. This is a STORAGE stub, not a stub of any logic under
// test: admitSeq, noteDrop and readDrops are the shipped implementations.
const __swStore = { session: new Map(), local: new Map() };
function areaStub(map) {
  return {
    get(key, cb) { cb({ [key]: map.get(key) ?? null }); },
    set(obj, cb) { for (const [k, v] of Object.entries(obj)) map.set(k, v); if (cb) cb(); },
    remove(key, cb) { map.delete(key); if (cb) cb(); },
  };
}
globalThis.chrome = {
  storage: { session: areaStub(__swStore.session), local: areaStub(__swStore.local) },
};

let SW = null;
let SW_ROUTE = 'unknown';
let SW_ERR = null;
try {
  SW = await import('../chrome-extension/e2e/sw-session.js');
  SW_ROUTE = 'REAL MODULE IMPORTED (in-memory chrome.storage stub only; no mirror, no text extraction)';
} catch (e) {
  SW_ERR = e;
  SW_ROUTE = `IMPORT FAILED — ${e.message}`;
}

const SESSION = await import('../lib/e2e/session.mjs');
const KDF = await import('../lib/e2e/kdf.mjs');

const subtle = webcrypto.subtle;

// ── result plumbing ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`ok   ${name}`); return true; }
  failed++;
  console.log(`FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  return false;
}
function section(t) { console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`); }

const te = new TextEncoder();
const td = new TextDecoder();

// ═══════════════════════════════════════════════════════════════════════════
// THE SHARED SEQUENCE SCHEDULE
//
// One schedule drives every lane, so "all three implementations agree" is a
// claim about the SAME inputs rather than three independent stories.
//
//   phase A   seq 0 .. 5999        delivered live
//   RESUME    seq 5500 .. 5999     REPLAYED — 500 true duplicates, legitimate
//   phase B   seq 6000 .. 9999     delivered live
//
// 10 000 distinct frames; 500 injected duplicates; 0 new frames withheld.
// The replay window sits INSIDE the dedupe window's reach: at seq 5999 the
// floor is 4976, so every replayed seq is still remembered and must be
// recognised as a duplicate rather than mistaken for a fresh frame.
// ═══════════════════════════════════════════════════════════════════════════
const TOTAL = 10_000;
const REPLAY_FROM = 5_500;
const REPLAY_TO = 5_999;                                 // inclusive
const EXPECTED_DUPES = REPLAY_TO - REPLAY_FROM + 1;      // 500

function buildSchedule({ withhold = new Set() } = {}) {
  const out = [];
  for (let s = 0; s <= REPLAY_TO; s++) if (!withhold.has(s)) out.push({ seq: s, dupe: false });
  for (let s = REPLAY_FROM; s <= REPLAY_TO; s++) out.push({ seq: s, dupe: true });
  for (let s = REPLAY_TO + 1; s < TOTAL; s++) if (!withhold.has(s)) out.push({ seq: s, dupe: false });
  return out;
}

/** The universe of frames the phone INTENDED to deliver. Never derived from
 *  the schedule — that is exactly how a withheld frame would hide. */
const UNIVERSE = new Set(Array.from({ length: TOTAL }, (_, i) => i));

// ═══════════════════════════════════════════════════════════════════════════
// LANE 1 — WEB: the real lib/e2e/session.mjs, live, 10 000 sealed frames
// ═══════════════════════════════════════════════════════════════════════════

const PAIRING_ID = 'p6-replay-00000000-0000-4000-8000-000000000001';
const USER_ID = 'user-p6-replay';
const PHONE_DEV = 'phone-p6-replay';
const PEER_DEV = 'web-p6-replay';
const PAIR_EPOCH = 7n;
const KID = 'kid-p6-replay';

function ctxBytes(epoch) {
  return KDF.pairContext({
    userId: USER_ID, phoneDeviceId: PHONE_DEV, peerDeviceId: PEER_DEV, pairEpoch: epoch,
  });
}

/** The PHONE end: real trafficKeys(role:'phone') + real np2c prefix + real seal. */
async function makePhoneSealer({ sessionKey, context, pairEpoch, kid }) {
  const keys = await KDF.trafficKeys({ pairingId: PAIRING_ID, sessionKey, context, role: 'phone' });
  const { np2c } = await SESSION.deriveNoncePrefixes({ pairingId: PAIRING_ID, sessionKey, context }, subtle);
  return async (frameType, seq, bodyBytes) => SESSION.encodeEnvelope({
    kid,
    seq,
    ciphertext: await KDF.seal({
      sender: { ...keys.send, sessionPrefix: np2c },
      frameType, kid, seq, pairEpoch, plaintext: bodyBytes,
    }, subtle),
  });
}

async function makeWebLane({ epoch = PAIR_EPOCH } = {}) {
  const sessionKey = new Uint8Array(crypto.randomBytes(32));
  const context = ctxBytes(epoch);
  const comp = await SESSION.createComputerSession({
    pairingId: PAIRING_ID, sessionKey, context, kid: KID,
    pairEpoch: epoch, store: SESSION.memorySeqStore(), fresh: true,
  }, subtle);
  const seal = await makePhoneSealer({ sessionKey, context, pairEpoch: epoch, kid: KID });
  return { comp, seal };
}

/**
 * Run a schedule through the real web session and classify EVERY outcome.
 *
 * This function is the thing under test AND the thing section F doctors — the
 * negative controls never re-implement it, so a detector proof that goes red
 * proves THIS code path can go red, not that a copy of it can.
 */
async function runWeb(lane, schedule, { rejectOnDuplicate = false, universe = UNIVERSE } = {}) {
  const { comp, seal } = lane;
  const delivered = [];         // seqs handed to the application, in order
  const seenNew = new Set();
  let legitimateDrops = 0;      // a true duplicate, dropped. EXPECTED.
  let illegitimateDrops = 0;    // a NEW frame that did not arrive. FAILURE.
  let rejections = 0;           // anything that is not a silent drop. MUST be 0.
  let maxFloorAdvance = 0;
  let prevFloor = comp.recvFloor;

  let done = 0;
  for (const step of schedule) {
    const bodyText = JSON.stringify({ n: step.seq, t: 'PHONE_NOTIFICATION' });
    const env = await seal('PHONE_NOTIFICATION', step.seq, te.encode(bodyText));

    let res;
    try {
      res = await comp.open('PHONE_NOTIFICATION', env);
    } catch {
      // §13.5: a duplicate must never throw. If open() ever throws, THAT is the
      // rejection this harness exists to forbid.
      rejections++;
      continue;
    }

    if (res.ok) {
      if (seenNew.has(step.seq)) {
        rejections++;                       // a duplicate DELIVERED TWICE
      } else {
        seenNew.add(step.seq);
        delivered.push(step.seq);
        if (td.decode(res.plaintext) !== bodyText) illegitimateDrops++;
      }
    } else if (res.reason === 'duplicate') {
      if (step.dupe) legitimateDrops++;
      else illegitimateDrops++;             // a NEW frame called a duplicate: DATA LOSS
      // The injected fault used ONLY by detector proof F2: a receiver that
      // treats a duplicate as an attack instead of a silent drop.
      if (rejectOnDuplicate) rejections++;
    } else {
      // 'auth' | 'kid' | 'shape' — all drops, none of them rejections, but a
      // NEW frame landing here is still lost.
      if (step.dupe) legitimateDrops++; else illegitimateDrops++;
    }

    const f = comp.recvFloor;
    if (f - prevFloor > maxFloorAdvance) maxFloorAdvance = f - prevFloor;
    prevFloor = f;

    if (++done % 2500 === 0) console.log(`       ... ${done}/${schedule.length} frames`);
  }

  // A frame the phone meant to send that never reached the application at all
  // is an illegitimate drop too. This is the clause that catches a harness that
  // quietly sent nothing (detector proof F3) or lost a frame in transit (F1).
  for (const s of universe) if (!seenNew.has(s)) illegitimateDrops++;

  return {
    delivered, legitimateDrops, illegitimateDrops, rejections,
    maxFloorAdvance, counter: comp.drops, distinct: seenNew.size,
  };
}

/** Ordering: NEW frames must reach the application in ascending seq order. */
function isOrdered(delivered) {
  for (let i = 1; i < delivered.length; i++) if (delivered[i] <= delivered[i - 1]) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// LANE 2 — EXTENSION SW: the REAL chrome-extension/e2e/sw-session.js
// ═══════════════════════════════════════════════════════════════════════════

function swSessionGet(key) {
  return new Promise((res) => chrome.storage.session.get(key, (o) => res(o[key])));
}

async function runSw(schedule, { epoch = Number(PAIR_EPOCH), universe = UNIVERSE } = {}) {
  __swStore.session.clear();
  let legitimateDrops = 0;
  let illegitimateDrops = 0;
  let rejections = 0;
  const seenNew = new Set();
  let done = 0;

  for (const step of schedule) {
    let r;
    try {
      r = await SW.admitSeq({ kid: KID, direction: 'p2c', seq: step.seq, pairEpoch: epoch });
    } catch {
      rejections++;                         // admitSeq must never throw on a duplicate
      continue;
    }
    if (r.ok) {
      if (seenNew.has(step.seq)) rejections++;   // re-admitted a frame already delivered
      seenNew.add(step.seq);
    } else {
      // The SW lane's drop counter is caller-driven by design (noteDrop is a
      // separate export so the counter also covers decrypt failures, which the
      // window never sees). Driving it here is the shipped call pattern.
      await SW.noteDrop(r.why);
      if (step.dupe) legitimateDrops++; else illegitimateDrops++;
    }
    if (++done % 2500 === 0) console.log(`       ... ${done}/${schedule.length} frames`);
  }
  for (const s of universe) if (!seenNew.has(s)) illegitimateDrops++;

  const all = (await swSessionGet('cc_e2e_dedupe')) || {};
  const w = all[`${KID}|p2c`] || { floor: 0 };
  const drops = await SW.readDrops();
  return {
    legitimateDrops, illegitimateDrops, rejections,
    floor: w.floor, counter: drops.total, distinct: seenNew.size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LANE 3 — ANDROID: STATIC text drift guard + frozen vectors. NOT EXECUTED.
// ═══════════════════════════════════════════════════════════════════════════

const KT_DEDUPE = join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion', 'E2eDedupe.kt');
const KT_SEQ = join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion', 'E2eSeqStore.kt');

/**
 * The frozen vector table: a fixed sequence schedule and the admit/drop verdict
 * every conformant §13.5 implementation MUST produce. Both LIVE lanes are
 * asserted against it here; the Kotlin lane is asserted against it by (g) when
 * a Kotlin runner exists. Written longhand rather than computed, so a change
 * that moves BOTH JS lanes together still fails.
 */
const FROZEN_VECTORS = [
  [0, 'FRESH'],
  [1, 'FRESH'],
  [1, 'DUPLICATE'],      // exact duplicate -> DROP, never reject
  [1023, 'FRESH'],       // last seq inside the initial window [0, 1024)
  [1024, 'FRESH'],       // first seq OUTSIDE it -> admitted, floor slides to 1
  [0, 'DUPLICATE'],      // now below the floor -> DROP
  [1024, 'DUPLICATE'],   // still an exact duplicate
  [2047, 'FRESH'],       // floor 1; 2047 >= 1+1024, so the floor slides by the
                         // 256 CAP to 257 (NOT to 1024 — the cap is the point)
  [1, 'DUPLICATE'],      // below the floor after that capped slide
];

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('e2e-replay-proof - E2E-P6 (e), Security Gate 2 check (3)');
  console.log(`  SW module route: ${SW_ROUTE}`);
  console.log('  ANDROID: static vector + text drift guard only. Kotlin was NOT executed.');

  // ─────────────────────────────────────────────────────────────────────────
  section('A. WEB (LIVE, IN-PROCESS) - 10 000 sealed frames across a resume');
  const t0 = Date.now();
  const lane = await makeWebLane();
  const schedule = buildSchedule();
  check('A0  schedule is 10 000 distinct frames + 500 injected duplicates',
    schedule.length === TOTAL + EXPECTED_DUPES
    && schedule.filter((s) => s.dupe).length === EXPECTED_DUPES,
    `len=${schedule.length} dupes=${schedule.filter((s) => s.dupe).length}`);

  const web = await runWeb(lane, schedule);
  console.log(`       (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  check('A1  all 10 000 distinct frames delivered and OPENED (positive control)',
    web.distinct === TOTAL, `distinct=${web.distinct} expected=${TOTAL}`);
  check('A2  ZERO illegitimate drops - no NEW frame was lost',
    web.illegitimateDrops === 0, `illegitimate=${web.illegitimateDrops}`);
  check('A3  ZERO rejections - a duplicate is dropped, never refused, never doubled',
    web.rejections === 0, `rejections=${web.rejections}`);
  check('A4  legitimate drops == the 500 duplicates injected, exactly',
    web.legitimateDrops === EXPECTED_DUPES, `legitimate=${web.legitimateDrops} expected=${EXPECTED_DUPES}`);
  check('A5  the EXPORTED drop counter equals the true duplicate count exactly',
    web.counter === EXPECTED_DUPES, `session.drops=${web.counter} expected=${EXPECTED_DUPES}`);
  check('A6  ordering preserved - NEW frames reached the app in ascending seq',
    isOrdered(web.delivered) && web.delivered.length === TOTAL,
    `ordered=${isOrdered(web.delivered)} len=${web.delivered.length}`);
  check(`A7  floor never advanced more than ${SESSION.DEDUPE_FLOOR_ADVANCE_CAP} in one step`,
    web.maxFloorAdvance <= SESSION.DEDUPE_FLOOR_ADVANCE_CAP, `maxAdvance=${web.maxFloorAdvance}`);
  console.log(`       DROP COUNTER: legitimate=${web.legitimateDrops} illegitimate=${web.illegitimateDrops} exported=${web.counter}`);

  // ─────────────────────────────────────────────────────────────────────────
  section('B. WEB - frozen §13.5 parameters, the 1024 boundary, the epoch bump');
  check('B1  DEDUPE_WINDOW is the frozen 1024', SESSION.DEDUPE_WINDOW === 1024, `${SESSION.DEDUPE_WINDOW}`);
  check('B2  DEDUPE_FLOOR_ADVANCE_CAP is the frozen 256', SESSION.DEDUPE_FLOOR_ADVANCE_CAP === 256, `${SESSION.DEDUPE_FLOOR_ADVANCE_CAP}`);
  {
    const w = SESSION.createDedupeWindow();
    check('B3  seq 0 admitted on a fresh window', w.accept(0) === true);
    check('B4  seq 1023 (last inside [0,1024)) admitted, floor still 0',
      w.accept(1023) === true && w.floor === 0, `floor=${w.floor}`);
    const a = w.accept(1024);
    check('B5  seq 1024 (first OUTSIDE the window) is ADMITTED and slides the floor to 1 - §13.5 dedupes, it does not reject',
      a === true && w.floor === 1, `accept=${a} floor=${w.floor}`);
    const below = w.accept(0);
    check('B6  a frame now BELOW the floor is DROPPED and COUNTED - not rejected, nothing thrown',
      below === false, `accept=${below}`);
    check('B7  that drop is visible in the exported counter', w.drops === 1, `drops=${w.drops}`);
  }
  {
    // "A frame 1025 back": the spec does not say reject. The window is 1024
    // wide, the floor is where it is, and a seq below the floor is
    // indistinguishable from a replay -> DROPPED, counted, socket untouched.
    const w = SESSION.createDedupeWindow();
    w.accept(0);
    w.accept(5000);                     // one far-future frame
    const floorAfter = w.floor;
    const r = w.accept(floorAfter - 1); // exactly one below the floor
    check('B8  a seq below the current floor (further back than the window reaches) is dropped, floor unmoved',
      r === false && w.floor === floorAfter, `accept=${r} floor=${w.floor}`);
    check('B9  one far-future frame advanced the floor by EXACTLY the 256 cap, not to seq-1023',
      floorAfter === 256, `floor=${floorAfter} (uncapped would be ${5000 - 1024 + 1})`);
  }
  {
    const w = SESSION.createDedupeWindow();
    w.accept(4000);
    const before = w.accept(4000);
    w.reset();                          // §13.5: a pairEpoch bump resets the window
    const floorAfterReset = w.floor;    // read BEFORE the next accept moves it again
    const after = w.accept(4000);
    check('B10 epoch bump resets the window: the floor returns to 0 and a seq seen under the OLD epoch is re-admitted under the new one',
      before === false && floorAfterReset === 0 && after === true,
      `before=${before} floorAfterReset=${floorAfterReset} after=${after}`);
    check('B11 the reset also zeroes the drop counter (a new epoch is a new count)',
      w.drops === 0, `drops=${w.drops}`);
  }
  {
    const l2 = await makeWebLane();
    const env = await l2.seal('PHONE_NOTIFICATION', 1, te.encode('{"n":1}'));
    const r1 = await l2.comp.open('PHONE_NOTIFICATION', env);
    const r2 = await l2.comp.open('PHONE_NOTIFICATION', env);
    l2.comp.resetDedupe();
    const r3 = await l2.comp.open('PHONE_NOTIFICATION', env);
    check('B12 session.open(): fresh -> ok; replay -> {ok:false,reason:"duplicate"} with NO throw; after epoch reset -> ok again',
      r1.ok === true && r2.ok === false && r2.reason === 'duplicate' && r3.ok === true,
      `r1=${r1.ok} r2=${r2.reason} r3=${r3.ok}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('C. EXTENSION SW (LIVE) - the real chrome-extension/e2e/sw-session.js');
  let sw = null;
  if (!SW) {
    check('C0  sw-session.js imported for real', false, `import failed: ${SW_ERR?.message}`);
  } else {
    check('C0  sw-session.js imported for real (no mirror, no text extraction)', true);
    check('C1  SW DEDUPE_WINDOW is the frozen 1024', SW.DEDUPE_WINDOW === 1024, `${SW.DEDUPE_WINDOW}`);
    check('C2  SW FLOOR_ADVANCE_CAP is the frozen 256', SW.FLOOR_ADVANCE_CAP === 256, `${SW.FLOOR_ADVANCE_CAP}`);
    const t1 = Date.now();
    sw = await runSw(schedule);
    console.log(`       (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    check('C3  SW: all 10 000 distinct frames admitted', sw.distinct === TOTAL, `distinct=${sw.distinct}`);
    check('C4  SW: ZERO illegitimate drops', sw.illegitimateDrops === 0, `illegitimate=${sw.illegitimateDrops}`);
    check('C5  SW: ZERO rejections (admitSeq never threw, nothing delivered twice)',
      sw.rejections === 0, `rejections=${sw.rejections}`);
    check('C6  SW: legitimate drops == the 500 injected duplicates, exactly',
      sw.legitimateDrops === EXPECTED_DUPES, `legitimate=${sw.legitimateDrops}`);
    check('C7  SW: the exported drop counter equals that count exactly',
      sw.counter === EXPECTED_DUPES, `counter=${sw.counter}`);
    check('C8  SW and WEB agree on both drop classes over the identical schedule',
      sw.legitimateDrops === web.legitimateDrops && sw.illegitimateDrops === web.illegitimateDrops,
      `sw=${sw.legitimateDrops}/${sw.illegitimateDrops} web=${web.legitimateDrops}/${web.illegitimateDrops}`);
    check('C9  SW floor after 10 000 frames is seq-1023, matching the web lane',
      sw.floor === TOTAL - 1024, `sw.floor=${sw.floor} expected=${TOTAL - 1024}`);

    __swStore.session.clear();
    const e1 = await SW.admitSeq({ kid: KID, direction: 'p2c', seq: 900, pairEpoch: 7 });
    const e2 = await SW.admitSeq({ kid: KID, direction: 'p2c', seq: 900, pairEpoch: 7 });
    const e3 = await SW.admitSeq({ kid: KID, direction: 'p2c', seq: 900, pairEpoch: 8 });
    check('C10 SW: pairEpoch bump resets the window - seq 900 seen under epoch 7 is admitted under epoch 8',
      e1.ok === true && e2.ok === false && e2.why === 'duplicate' && e3.ok === true,
      `e1=${e1.ok} e2=${e2.why} e3=${e3.ok}`);
    check('C11 SW: the duplicate verdict is a DROP, not a refusal - no throw, no close, no re-pair signal',
      e2.ok === false && typeof e2.why === 'string' && !('close' in e2) && !('rePair' in e2),
      JSON.stringify(e2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('D. FROZEN VECTORS - one table, asserted on both LIVE lanes');
  {
    const w = SESSION.createDedupeWindow();
    const expect = FROZEN_VECTORS.map(([, v]) => v);
    const webV = FROZEN_VECTORS.map(([s]) => (w.accept(s) ? 'FRESH' : 'DUPLICATE'));
    check('D1  WEB matches the frozen §13.5 vector table',
      webV.join(',') === expect.join(','), `got  ${webV.join(',')}\n       want ${expect.join(',')}`);
    if (SW) {
      __swStore.session.clear();
      const swV = [];
      for (const [s] of FROZEN_VECTORS) {
        const r = await SW.admitSeq({ kid: 'vec', direction: 'p2c', seq: s, pairEpoch: 1 });
        swV.push(r.ok ? 'FRESH' : 'DUPLICATE');
      }
      check('D2  EXTENSION SW matches the same frozen vector table',
        swV.join(',') === expect.join(','), `got  ${swV.join(',')}\n       want ${expect.join(',')}`);
    }
    console.log('       D3  ANDROID: this table is the contract deliverable (g) must run');
    console.log('           E2eDedupe.observe() against. It is NOT asserted live here.');
  }
  {
    // ── OBSERVATION, NOT AN ASSERTION ────────────────────────────────────────
    // The three implementations DISAGREE on one case: a seq so far beyond the
    // window that the capped 256 advance cannot bring it inside, arriving TWICE.
    //
    //   web  createDedupeWindow.accept()  adds the seq to `seen` BEFORE the
    //        floor-advance branch, so the repeat is recognised → DUPLICATE.
    //   sw   admitSeq()  returns {ok:true, beyondWindow:true} from inside the
    //        advance branch, before `w.seen.push(n)` → FRESH, every time.
    //   kt   E2eDedupe.observe()  returns Verdict.FRESH from the same early
    //        branch and never touches the BitSet → FRESH, every time.
    //
    // Neither side REJECTS, so §13.5's load-bearing rule is intact on all three
    // and nothing here is a security break. But on the SW and Android lanes one
    // far-future frame can be replayed without bound and is delivered to the
    // application on every repeat, while the web lane drops it — and only the
    // web lane's drop counter moves. Reported, deliberately NOT asserted and
    // NOT fixed by this harness: which behaviour is correct is a §13.5 spec
    // question, not a harness question.
    const w = SESSION.createDedupeWindow();
    w.accept(0);
    const web1 = w.accept(1_000_000);
    const web2 = w.accept(1_000_000);
    let sw1 = null; let sw2 = null;
    if (SW) {
      __swStore.session.clear();
      await SW.admitSeq({ kid: 'bw', direction: 'p2c', seq: 0, pairEpoch: 1 });
      sw1 = (await SW.admitSeq({ kid: 'bw', direction: 'p2c', seq: 1_000_000, pairEpoch: 1 })).ok;
      sw2 = (await SW.admitSeq({ kid: 'bw', direction: 'p2c', seq: 1_000_000, pairEpoch: 1 })).ok;
    }
    console.log('       D4  OBSERVATION (not asserted): a REPEATED seq beyond the capped');
    console.log(`           window — web admits then DROPS (${web1} -> ${web2}); SW admits BOTH times (${sw1} -> ${sw2});`);
    console.log('           E2eDedupe.kt returns FRESH from the same early branch without');
    console.log('           setting its BitSet, so Android matches the SW. No lane REJECTS,');
    console.log('           so §13.5\'s never-reject rule holds everywhere — but the three');
    console.log('           implementations do NOT agree, and only the web lane counts a drop.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('E. ANDROID (STATIC ONLY) - text drift guard over the Kotlin source');
  {
    const okFile = existsSync(KT_DEDUPE);
    check('E0  E2eDedupe.kt is present', okFile, KT_DEDUPE);
    if (okFile) {
      const src = readFileSync(KT_DEDUPE, 'utf8');
      check('E1  Kotlin WINDOW = 1024 (frozen §13.5)',
        /const\s+val\s+WINDOW\s*=\s*1024\b/.test(src));
      check('E2  Kotlin MAX_FLOOR_ADVANCE = 256 (frozen §13.5)',
        /const\s+val\s+MAX_FLOOR_ADVANCE\s*=\s*256\b/.test(src));
      check('E3  Kotlin FAILURE_LIMIT = 3 over FAILURE_WINDOW_MS = 10 000 (the decrypt-failure re-pair rule)',
        /const\s+val\s+FAILURE_LIMIT\s*=\s*3\b/.test(src)
        && /const\s+val\s+FAILURE_WINDOW_MS\s*=\s*10_000L/.test(src));
      check('E4  Kotlin window is keyed per (kid, direction) AND per pairEpoch - the epoch reset is structural, a new epoch needs a NEW window',
        /val\s+kid:\s*String/.test(src) && /val\s+direction:\s*Direction/.test(src)
        && /val\s+pairEpoch:\s*Long/.test(src));
      check('E5  Kotlin Verdict is exactly FRESH | DUPLICATE - no REJECT, no CLOSE',
        /enum class Verdict/.test(src) && /\bFRESH\b/.test(src) && /\bDUPLICATE\b/.test(src)
        && !/\bREJECT\b/.test(src) && !/Verdict\.CLOSE/.test(src));
      check('E6  Kotlin exports a drop counter (droppedTotal) - a silent dropper is unobservable without one',
        /var\s+droppedTotal:\s*Long/.test(src) && /droppedTotal\+\+/.test(src));
      check('E7  Kotlin caps the slide at MAX_FLOOR_ADVANCE on ONE frame',
        /minOf\(wanted,\s*MAX_FLOOR_ADVANCE/.test(src));
      check('E8  Kotlin never closes the socket - FailureTracker only REQUESTS a re-pair',
        !/\.close\(\)/.test(src) && /recordFailure/.test(src));
    }
    check('E9  E2eSeqStore.kt is present (the persist-before-emit counter the window pairs with)',
      existsSync(KT_SEQ), KT_SEQ);
    console.log('       NOTE: E1-E9 are STATIC assertions over Kotlin TEXT. The Android');
    console.log('             implementation was NOT executed by this harness. The live');
    console.log('             Android arm belongs to deliverable (g).');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('F. DETECTOR PROOFS - each headline assertion shown going RED');
  {
    const l = await makeWebLane();
    const r = await runWeb(l, buildSchedule({ withhold: new Set([4242]) }));
    check('F1  DETECTOR: withholding ONE new frame (seq 4242) turns the illegitimate-drop check RED',
      r.illegitimateDrops > 0 && r.distinct !== TOTAL,
      `illegitimateDrops=${r.illegitimateDrops} distinct=${r.distinct} - detector did NOT fire`);
    console.log('       RED OUTPUT -> FAIL A2  ZERO illegitimate drops - no NEW frame was lost');
    console.log(`                     illegitimate=${r.illegitimateDrops} distinct=${r.distinct}/${TOTAL}`);
  }
  {
    const l = await makeWebLane();
    const r = await runWeb(l, buildSchedule(), { rejectOnDuplicate: true });
    check('F2  DETECTOR: a dedupe that REJECTS a duplicate instead of dropping it turns the never-rejects check RED',
      r.rejections > 0, `rejections=${r.rejections} - detector did NOT fire`);
    console.log('       RED OUTPUT -> FAIL A3  ZERO rejections - a duplicate is dropped, never refused');
    console.log(`                     rejections=${r.rejections} (legitimate drops still ${r.legitimateDrops})`);
  }
  {
    const l = await makeWebLane();
    const r = await runWeb(l, []);
    check('F3  DETECTOR: an EMPTY run turns the 10 000-frames-processed positive control RED',
      r.distinct !== TOTAL && r.illegitimateDrops === TOTAL,
      `distinct=${r.distinct} illegitimate=${r.illegitimateDrops} - an empty run passed`);
    console.log('       RED OUTPUT -> FAIL A1  all 10 000 distinct frames delivered and OPENED');
    console.log(`                     distinct=${r.distinct} expected=${TOTAL}`);
  }
  {
    // A text guard that cannot go red is the same anti-pattern in a costume.
    const doctored = 'const val WINDOW = 512\n    const val MAX_FLOOR_ADVANCE = 256';
    check('F4  DETECTOR: the Kotlin constant guard goes RED against a source claiming WINDOW = 512',
      !/const\s+val\s+WINDOW\s*=\s*1024\b/.test(doctored));
    console.log('       RED OUTPUT -> FAIL E1  Kotlin WINDOW = 1024 (frozen §13.5)');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('G. REAL RELAY (LIVE WIRE) - a 500-frame slice through node server.js');
  await wireSlice();

  // ─────────────────────────────────────────────────────────────────────────
  section('SCOPE STATEMENT - quoted out of context this would mislead');
  console.log('  BULK VOLUME (10 000 frames; A, C, D): IN-PROCESS against the real');
  console.log('    lib/e2e/session.mjs and the real chrome-extension/e2e/sw-session.js.');
  console.log('    Real crypto, real counters, real dedupe windows. NOT over a socket.');
  console.log('  WIRE SLICE (G): 500 frames over a REAL WebSocket through a REAL');
  console.log('    `node server.js`, with a real browser drop and a real relay-side');
  console.log('    auto-resume. Smaller on purpose, and real. The duplicates there come');
  console.log('    from the PHONE\'s outbox resend, NOT from room.frameBuffer — that');
  console.log('    buffer only engages for a phone sitting in the LOBBY, and a phone that');
  console.log('    stays in room.active while the browser is soft-held does not buffer.');
  console.log('    That relay behaviour is (g)/(h) territory and is not measured here.');
  console.log('  ANDROID: static text + a frozen vector contract. NOT EXECUTED.');
  console.log('    Do not read E1-E9 as the Android implementation passing.');
}

// ═══════════════════════════════════════════════════════════════════════════
// G - the real wire slice.
//
// 500 distinct frames, phone -> relay -> browser, with a real browser drop, a
// real resume claim, and the relay's own frameBuffer replay across the gap.
// The DUPLICATES come from the phone re-sending its un-acked outbox after the
// resume - which is exactly the legitimate replay §13.5 exists to absorb.
//
// FRAME_BUFFER_MAX in server.js is 200, so the buffered phase stays under it;
// a harness that overflowed the buffer would be measuring the relay's
// drop-oldest policy and calling it a dedupe result.
// ═══════════════════════════════════════════════════════════════════════════
const WIRE_TOTAL = 500;
const WIRE_LIVE = 300;   // delivered live before the browser drops
const WIRE_DUPES = 100;  // the phone's post-resume outbox resend (true duplicates)

async function wireSlice() {
  let relayMod; let wsMod; let PrismaMod;
  try {
    relayMod = await import('./lib/real-relay.mjs');
    wsMod = await import('ws');
    PrismaMod = await import('@prisma/client');
  } catch (e) {
    check('G0  real-relay prerequisites available', false, e.message);
    return;
  }
  const { withRealRelay } = relayMod;
  const { WebSocket } = wsMod;

  const DB = 'postgresql://pix:pix@localhost:15433/cc_p6';
  const JWT_SECRET = 'p6-replay-harness-test-secret-0123456789abcdef';
  const phoneToken = crypto.randomBytes(32).toString('base64url');

  const db = new PrismaMod.PrismaClient({ datasources: { db: { url: DB } } });
  try {
    await db.user.create({
      data: {
        email: `p6-replay-${Date.now()}@harness.invalid`,
        phoneToken,
        isAdmin: true,          // entitlement rule (1) short-circuits to allowed
        emailVerified: true,
      },
    });
    check('G0  scratch user seeded in cc_p6 (isAdmin -> entitlement rule (1))', true);
  } catch (e) {
    check('G0  scratch user seeded in cc_p6', false, String(e.message).split('\n').slice(-3).join(' '));
    await db.$disconnect();
    return;
  }

  try {
    await withRealRelay({
      cwd: ROOT,
      logDir: 'C:/Users/D/worktrees/computercaller/p6-logs',
      databaseUrl: DB,
      env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET },
      timeoutMs: 90_000,
      label: 'replay',
    }, async (relay) => {
      check('G1  real relay booted (node server.js, own pid, ephemeral port)', !!relay.port, `port=${relay.port}`);

      const open = (p) => new Promise((res, rej) => {
        const ws = new WebSocket(`${relay.wsBase}${p}?token=${encodeURIComponent(phoneToken)}`);
        const t = setTimeout(() => rej(new Error(`timeout opening ${p}`)), 20_000);
        ws.on('open', () => { clearTimeout(t); res(ws); });
        ws.on('error', (e) => { clearTimeout(t); rej(e); });
      });
      const waitFor = (ws, prefix, ms = 20_000) => new Promise((res, rej) => {
        // The listener is detached on BOTH paths. A timed-out waiter that stays
        // subscribed swallows the next matching frame, so the retry below would
        // look like the relay never answered at all.
        const on = (d) => {
          const s = d.toString();
          if (s.startsWith(prefix)) { clearTimeout(t); ws.off('message', on); res(s); }
        };
        const t = setTimeout(() => { ws.off('message', on); rej(new Error(`timeout waiting for ${prefix}`)); }, ms);
        ws.on('message', on);
      });
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));

      const lane = await makeWebLane();
      const received = [];
      const seenNew = new Set();
      const sentDupe = new Set();
      let legitimateDrops = 0;
      let illegitimateDrops = 0;
      let rejections = 0;

      const onFrame = async (s) => {
        if (!s.startsWith('PHONE_NOTIFICATION:')) return;
        let env;
        try { env = JSON.parse(s.slice('PHONE_NOTIFICATION:'.length)); } catch { return; }
        let r;
        try { r = await lane.comp.open('PHONE_NOTIFICATION', env); }
        catch { rejections++; return; }
        if (r.ok) {
          if (seenNew.has(env.s)) rejections++;        // delivered twice
          else { seenNew.add(env.s); received.push(env.s); }
        } else if (r.reason === 'duplicate') {
          if (sentDupe.has(env.s)) legitimateDrops++; else illegitimateDrops++;
        } else {
          illegitimateDrops++;
        }
      };

      let queue = Promise.resolve();
      const attach = (ws) => ws.on('message', (d) => {
        const s = d.toString();
        queue = queue.then(() => onFrame(s));
      });

      let browser = await open('/relay');
      const phone = await open('/relay/phone');
      attach(browser);

      // `ws.on('open')` fires when the HANDSHAKE completes, which is BEFORE the
      // relay's async auth + lobby insert has run (it awaits a DB lookup). A
      // BROWSER_REQUEST_PAIRING sent in that gap finds no phone in the lobby
      // and comes back PAIRING_REJECTED:already_pending — which reads exactly
      // like a protocol failure and is only a race. Retry until the phone has
      // landed rather than sleeping a guessed interval.
      let req = null;
      for (let attempt = 0; attempt < 8 && !req; attempt++) {
        await settle(500);
        const reqSeen = waitFor(phone, 'PAIRING_REQUEST', 1500).catch(() => null);
        browser.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify({ ua: 'p6-replay-harness' })}`);
        req = await reqSeen;
      }
      if (!req) throw new Error('relay never forwarded PAIRING_REQUEST after 8 attempts');
      const { pairingId } = JSON.parse(req.slice('PAIRING_REQUEST:'.length));
      const activeSeen = waitFor(browser, 'PAIRING_ACTIVE');
      phone.send(`ACCEPT_PAIRING:${JSON.stringify({ pairingId })}`);
      await activeSeen;
      check('G2  a real pair formed over the real relay', true);

      const sendSeq = async (seq) => {
        const env = await lane.seal(
          'PHONE_NOTIFICATION', seq,
          te.encode(JSON.stringify({ n: seq, t: 'PHONE_NOTIFICATION' })),
        );
        phone.send(`PHONE_NOTIFICATION:${JSON.stringify(env)}`);
      };

      for (let s = 0; s < WIRE_LIVE; s++) await sendSeq(s);
      await settle(1500); await queue;
      check(`G3  ${WIRE_LIVE} frames delivered live over the wire before the drop`,
        received.length === WIRE_LIVE, `received=${received.length}`);

      // The browser DROPS. Real close, real resume claim armed by the relay.
      browser.close();
      await settle(1500);

      // The browser RETURNS. WAIT FOR THE RELAY TO SAY SO rather than sleeping
      // a guessed interval: a fixed sleep that is 200ms short makes the next
      // phase's frames land before the pair re-forms, and the resulting
      // "0 duplicates" reads as a dedupe result when it is a harness artefact.
      browser = await open('/relay');
      attach(browser);
      const resumed = await waitFor(browser, 'PAIRING_ACTIVE', 15_000).catch(() => null);
      check('G4  the relay auto-resumed the SAME pair when the browser returned (PAIRING_ACTIVE resumed:true, no re-Accept)',
        !!resumed && JSON.parse(resumed.slice('PAIRING_ACTIVE:'.length)).resumed === true,
        resumed ? resumed.slice(0, 160) : 'no PAIRING_ACTIVE within 15s');
      await settle(1000); await queue;

      // THE LEGITIMATE REPLAY. The phone got no acks for its last WIRE_DUPES
      // frames before the gap, so on resume it re-sends them. Every one is a
      // true duplicate at the receiver and every one must be DROPPED, COUNTED,
      // and absorbed with the socket left open.
      //
      // The duplicate source here is the PHONE's outbox, deliberately NOT the
      // relay's `room.frameBuffer`. That buffer only engages for a phone in the
      // LOBBY (server.js ~2210: the branch is reached from the "frame from a
      // lobby phone with no active opposite peer" path). A phone that stays in
      // `room.active` while the browser is soft-held does not buffer — its
      // frames go to forwardDataPlane and a closed browser socket. That is a
      // relay-side observation, it belongs to deliverables (g)/(h), and this
      // harness must not launder it into a dedupe result.
      const dupeFrom = WIRE_LIVE - WIRE_DUPES;
      for (let s = dupeFrom; s < WIRE_LIVE; s++) { sentDupe.add(s); await sendSeq(s); }
      for (let s = WIRE_LIVE; s < WIRE_TOTAL; s++) await sendSeq(s);
      await settle(3000); await queue;

      check(`G5  all ${WIRE_TOTAL} distinct frames arrived and OPENED over the real wire`,
        seenNew.size === WIRE_TOTAL, `distinct=${seenNew.size}`);
      check('G6  WIRE: ZERO illegitimate drops - no NEW frame lost across a real resume',
        illegitimateDrops === 0, `illegitimate=${illegitimateDrops}`);
      check('G7  WIRE: ZERO rejections - the replay was absorbed and the socket stayed OPEN',
        rejections === 0 && browser.readyState === WebSocket.OPEN,
        `rejections=${rejections} browserReadyState=${browser.readyState}`);
      check(`G8  WIRE: legitimate drops == the ${WIRE_DUPES} duplicates the phone replayed, exactly`,
        legitimateDrops === WIRE_DUPES, `legitimate=${legitimateDrops}`);
      check('G9  WIRE: ordering preserved across the resume',
        isOrdered(received), 'delivery order was not ascending');
      console.log(`       WIRE DROP COUNTER: legitimate=${legitimateDrops} illegitimate=${illegitimateDrops} exported=${lane.comp.drops}`);
      console.log(`       WIRE VOLUME: ${WIRE_TOTAL} frames over a real socket. The 10 000 in A/C are IN-PROCESS.`);

      try { browser.close(); } catch { /* closing a closed socket is fine */ }
      try { phone.close(); } catch { /* idem */ }
      await settle(300);
    });
  } catch (e) {
    check('G*  real-relay wire slice completed', false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '));
  } finally {
    try { await db.user.deleteMany({ where: { phoneToken } }); } catch { /* scratch db */ }
    await db.$disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
main().then(
  () => {
    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  },
  (e) => {
    failed++;
    console.log(`FAIL harness threw: ${e?.stack ?? e}`);
    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(1);
  },
);
