/**
 * tests/e2e-sw-a5-forward-jump.test.mjs — E2E-P3.2 (a) / Security A5 M-A5-2 (F2).
 *
 * The SW half of the three-lane parity set. Every vector in
 * tests/e2e-forward-jump-vectors.json is replayed through the REAL
 * chrome-extension/e2e/sw-session.js `admitSeq`, and the stored record is read
 * back out of the faked `chrome.storage.session` afterwards — floor,
 * highestAccepted and the refusal count, not just the return values.
 *
 * Reading the RECORD is the point. `admitSeq` returning `{ok:false}` proves the
 * frame was dropped; it does not prove the floor stayed where it was, and "the
 * floor did not move" is the entire content of F2. A refuser that still walked
 * the floor would pass a return-value-only test and remain exploitable.
 *
 * `chrome.storage.session` is faked with a plain object, same as
 * tests/e2e-sw-session.test.mjs — the thing under test is the arithmetic and
 * the ordering around the store, and a real MV3 profile cannot be driven from
 * node. The browser-side counter is asserted by scripts/ext-badge-counter-proof.
 *
 * Run: node tests/e2e-sw-a5-forward-jump.test.mjs
 */

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

let store = {};
globalThis.chrome = {
  storage: {
    session: {
      get: (key, cb) => cb(key in store ? { [key]: store[key] } : {}),
      set: (obj, cb) => { Object.assign(store, structuredClone(obj)); if (cb) cb(); },
    },
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const S = await import('../chrome-extension/e2e/sw-session.js');

const VECTORS = JSON.parse(
  readFileSync(new URL('./e2e-forward-jump-vectors.json', import.meta.url), 'utf8'),
);

let passed = 0;
let total = 0;
const failures = [];

async function check(name, fn) {
  total += 1;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

const KID = 'kid-a5';
const DIR = 0x01;
const reset = () => { store = {}; };
const record = () => (store[S.DEDUPE_KEY] || {})[`${KID}|${DIR}`] || null;

console.log('SW forward-jump bound — Security A5 M-A5-2 / F2\n');

// ── 0. The vector file itself ───────────────────────────────────────────────
// A parity file that silently lost its vectors would make every lane pass.

await check('the vector file matches the module\'s frozen parameters', () => {
  eq(VECTORS.params.window, S.FORWARD_JUMP_WINDOW, 'window');
  eq(VECTORS.params.window, S.DEDUPE_WINDOW, 'window == dedupe window');
  eq(VECTORS.params.floorAdvanceCap, S.FLOOR_ADVANCE_CAP, 'floor advance cap');
});

await check('the vector file carries all seven vectors with unique ids', () => {
  eq(VECTORS.vectors.length, 7, 'vector count');
  const ids = VECTORS.vectors.map((v) => v.id);
  eq(new Set(ids).size, ids.length, 'unique ids');
  for (const v of VECTORS.vectors) {
    assert(Array.isArray(v.frames) && v.frames.length > 0, `${v.id}: no frames`);
    assert(v.after && typeof v.after.floor === 'number', `${v.id}: no expected floor`);
  }
});

// ── 1. Every vector, frame by frame, against the real module ────────────────

for (const v of VECTORS.vectors) {
  await check(`vector ${v.id}`, async () => {
    reset();
    let i = 0;
    for (const f of v.frames) {
      const r = await S.admitSeq({
        kid: KID, direction: DIR, seq: f.seq, pairEpoch: f.epoch,
      });
      const label = `${v.id} frame[${i}] seq=${f.seq} epoch=${f.epoch}`;
      eq(r.ok, f.expect === 'accept', `${label} verdict`);
      if (f.why) eq(r.why, f.why, `${label} why`);
      i += 1;
    }
    const w = record();
    assert(w, `${v.id}: no stored record`);
    eq(w.v, S.DEDUPE_RECORD_V, `${v.id} record version`);
    eq(w.floor, v.after.floor, `${v.id} floor`);
    eq(w.highestAccepted, v.after.highestAccepted, `${v.id} highestAccepted`);
    eq(w.refusedForwardJump || 0, v.after.refusedForwardJump, `${v.id} per-window refusals`);
  });
}

// ── 2. The exported counter, which is the deliverable A5 actually names ─────
// "a silent refuser and a working receiver are otherwise indistinguishable".

await check('refusedForwardJump is exported, distinct from total and from byReason', async () => {
  reset();
  await S.noteDrop('duplicate');
  await S.noteRefusedForwardJump();
  await S.noteRefusedForwardJump();
  const d = await S.readDrops();
  eq(d.refusedForwardJump, 2, 'refusedForwardJump');
  eq(d.total, 1, 'droppedTotal is NOT inflated by a forward-jump refusal');
  eq(d.byReason['forward-jump'], undefined, 'and it does not hide inside byReason either');
});

await check('readDrops reports 0 rather than undefined on a virgin store', async () => {
  reset();
  const d = await S.readDrops();
  eq(d.refusedForwardJump, 0, 'virgin refusedForwardJump');
  eq(d.total, 0, 'virgin total');
});

await check('a burst of refusals is not lost to the read-modify-write race', async () => {
  reset();
  // Fired in ONE tick, exactly like a relay pushing a run of forged frames.
  // Unserialised, all 50 read the same value and the counter records 1.
  await Promise.all(Array.from({ length: 50 }, () => S.noteRefusedForwardJump()));
  eq((await S.readDrops()).refusedForwardJump, 50, 'every refusal in the burst');
});

// ── 3. The stored-record version guard (RESUME-PROTOCOL rule 6) ─────────────

await check('a pre-M-A5-2 record (no v, no highestAccepted) throws loudly', async () => {
  reset();
  store[S.DEDUPE_KEY] = { [`${KID}|${DIR}`]: { epoch: 1, floor: 0, seen: [], beyondWindow: 0 } };
  let threw = null;
  try { await S.admitSeq({ kid: KID, direction: DIR, seq: 5, pairEpoch: 1 }); }
  catch (e) { threw = e; }
  assert(threw, 'expected a throw against an unversioned record');
  eq(threw.name, 'DedupeRecordVersionError', 'error name');
  assert(/forward-jump bound/.test(threw.message), `message must say why: ${threw.message}`);
});

await check('an unknown FUTURE version throws too — not just a missing one', async () => {
  reset();
  store[S.DEDUPE_KEY] = { [`${KID}|${DIR}`]: { v: 99, epoch: 1, floor: 0, seen: [], highestAccepted: 0 } };
  let threw = null;
  try { await S.admitSeq({ kid: KID, direction: DIR, seq: 5, pairEpoch: 1 }); }
  catch (e) { threw = e; }
  assert(threw && threw.name === 'DedupeRecordVersionError', 'expected the version error');
});

await check('a new pairEpoch rebuilds an unversioned record instead of throwing', async () => {
  reset();
  store[S.DEDUPE_KEY] = { [`${KID}|${DIR}`]: { epoch: 1, floor: 900, seen: [], beyondWindow: 0 } };
  const r = await S.admitSeq({ kid: KID, direction: DIR, seq: 0, pairEpoch: 2 });
  eq(r.ok, true, 'the Accept heals it');
  eq(record().v, S.DEDUPE_RECORD_V, 'rebuilt at the current version');
  eq(record().floor, 0, 'and the stale floor is gone');
});

// ── 4. Nothing else about §13.5 moved ───────────────────────────────────────

await check('below-window behaviour is unchanged: dedupe, never reject', async () => {
  reset();
  const args = { kid: KID, direction: DIR, pairEpoch: 7 };
  for (const seq of [0, 1, 2, 3]) eq((await S.admitSeq({ ...args, seq })).ok, true, `seq ${seq}`);
  for (const seq of [1, 2, 3]) {
    eq((await S.admitSeq({ ...args, seq })).why, 'duplicate', `replay ${seq} is a duplicate, not a jump`);
  }
  eq((await S.admitSeq({ ...args, seq: 4 })).ok, true, 'the next real frame still lands');
  eq((await S.readDrops()).refusedForwardJump, 0, 'and no refusal was counted');
});

await check('a duplicate does NOT widen the bound', async () => {
  reset();
  const args = { kid: KID, direction: DIR, pairEpoch: 7 };
  await S.admitSeq({ ...args, seq: 10 });
  await S.admitSeq({ ...args, seq: 10 });          // duplicate
  eq(record().highestAccepted, 10, 'highestAccepted after a duplicate');
  eq((await S.admitSeq({ ...args, seq: 1035 })).ok, false, '10 + 1024 + 1 is still refused');
});

await check('a below-floor drop does NOT widen the bound', async () => {
  reset();
  const args = { kid: KID, direction: DIR, pairEpoch: 7 };
  await S.admitSeq({ ...args, seq: 0 });
  await S.admitSeq({ ...args, seq: 1024 });        // floor -> 1
  await S.admitSeq({ ...args, seq: 0 });           // below floor now
  eq(record().highestAccepted, 1024, 'unchanged by a below-floor drop');
});

console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
