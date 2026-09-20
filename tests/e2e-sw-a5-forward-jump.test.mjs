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
// A parity file that silently lost its cases would make all three lanes pass.

await check('the vector file is P2.2 frozen table and names this lane a consumer', () => {
  eq(VECTORS.window, S.FORWARD_JUMP_WINDOW, 'window');
  eq(VECTORS.window, S.DEDUPE_WINDOW, 'window == dedupe window');
  eq(VECTORS.cases.length, 8, 'case count');
  const ids = VECTORS.cases.map((c) => c.id);
  eq(new Set(ids).size, ids.length, 'unique ids');
  assert(VECTORS.consumers.some((c) => /SW|P3\.2/.test(c)), 'the SW must be listed as a consumer');
  assert(/UNARMED \(-1\)/.test(VECTORS.armRule), 'the arm rule this lane implements');
  assert(/NOT zeroed by a dedupe reset/.test(VECTORS.counterRule), 'the counter rule this lane implements');
});

// ── 1. Every case, step by step, against the real module ────────────────────
//
// `expect` is P2.2's vocabulary, mapped onto the SW's two-call shape:
//   accepted                      -> admitSeq ok, then markAuthenticated()
//   accepted-but-unauthenticated  -> admitSeq ok, markAuthenticated NOT called
//   duplicate                     -> admitSeq {ok:false, why:'duplicate'}
//   refused                       -> admitSeq {ok:false, why:'forward-jump'}
// The unauthenticated arm is the whole point of the split: see markAuthenticated().

for (const c of VECTORS.cases) {
  await check(`case ${c.id}`, async () => {
    reset();
    let epoch = 1;
    let i = 0;
    for (const st of c.steps) {
      const label = `${c.id} step[${i}]`;
      if (st.reset) {
        // The SW's real §13.8 reset path, not an edit to the store: it clears
        // the dedupe windows outright, and a new pairEpoch comes with it. That
        // makes the counter assertion on this step load-bearing —
        // dropSessionState() must NOT take cc_e2e_drops with it, or an
        // attacker who can provoke a reset can zero the security counter
        // (the vector file's counterRule).
        await S.dropSessionState();
        epoch += 1;
      } else {
        const r = await S.admitSeq({ kid: KID, direction: DIR, seq: st.seq, pairEpoch: epoch });
        if (st.expect === 'refused') {
          eq(r.ok, false, `${label} verdict`);
          eq(r.why, 'forward-jump', `${label} why`);
        } else if (st.expect === 'duplicate') {
          eq(r.ok, false, `${label} verdict`);
          eq(r.why, 'duplicate', `${label} why`);
        } else {
          eq(r.ok, true, `${label} verdict (${st.expect})`);
          if (st.authenticates) {
            await S.markAuthenticated({ kid: KID, direction: DIR, seq: st.seq, pairEpoch: epoch });
          }
        }
      }
      const w = record();
      if (typeof st.highestAcceptedAfter === 'number') {
        // After a reset the window is rebuilt lazily by the next admitSeq, so
        // "disarmed" is either a rebuilt record at -1 or no record at all.
        eq(w ? w.highestAccepted : -1, st.highestAcceptedAfter, `${label} highestAccepted`);
      }
      if (typeof st.floorAfter === 'number') eq(w ? w.floor : 0, st.floorAfter, `${label} floor`);
      if (typeof st.refusedForwardJumpAfter === 'number') {
        eq((await S.readDrops()).refusedForwardJump, st.refusedForwardJumpAfter, `${label} refusedForwardJump`);
      }
      i += 1;
    }
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

await check('markAuthenticated is a NO-OP for a stale epoch (the rekey race)', async () => {
  reset();
  // The race this guards: openIfSealed() awaits the AEAD open, and a rekey can
  // land during that await. A mark carrying the OLD epoch must not be written
  // into the NEW window, or it re-arms a bound the reset just disarmed.
  await S.admitSeq({ kid: KID, direction: DIR, seq: 5, pairEpoch: 2 });
  await S.markAuthenticated({ kid: KID, direction: DIR, seq: 900000, pairEpoch: 1 });
  eq(record().highestAccepted, -1, 'a mark from the previous epoch must not land');
  await S.markAuthenticated({ kid: KID, direction: DIR, seq: 5, pairEpoch: 2 });
  eq(record().highestAccepted, 5, 'the current epoch still marks normally');
});

const NL_ = String.fromCharCode(10);
const BG_SRC = readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
/** openIfSealed()'s body with comment lines removed (a check must not match prose). */
function openIfSealedCode() {
  const start = BG_SRC.indexOf('async function openIfSealed(');
  assert(start > 0, 'openIfSealed not found');
  const rest = BG_SRC.slice(start);
  const stop = rest.indexOf('function splitFrame');
  assert(stop > 0, 'could not bound openIfSealed');
  return rest.slice(0, stop).split(NL_).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join(NL_);
}

await check('openIfSealed bounding worked (positive control)', () => {
  const code = openIfSealedCode();
  assert(/admitSeq\(/.test(code) && /openSealedFrame\(/.test(code), 'the extracted body is wrong');
});

await check('background.js captures the epoch ONCE across the open', () => {
  const code = openIfSealedCode();
  assert(/const epoch = e2ePairEpoch;/.test(code), 'the epoch must be captured once');
  const reads = [...code.matchAll(/pairEpoch:\s*([A-Za-z0-9_$.]+)/g)].map((m) => m[1]);
  assert(reads.length >= 3, `expected >= 3 pairEpoch sites, saw ${reads.length}`);
  for (const r of reads) eq(r, 'epoch', 'pairEpoch site must use the captured epoch, not a re-read');
});

await check('a forward-jump is counted ONCE, not by both module and caller', async () => {
  reset();
  await S.admitSeq({ kid: KID, direction: DIR, seq: 0, pairEpoch: 1 });
  await S.markAuthenticated({ kid: KID, direction: DIR, seq: 0, pairEpoch: 1 });
  await S.admitSeq({ kid: KID, direction: DIR, seq: 99999, pairEpoch: 1 });
  eq((await S.readDrops()).refusedForwardJump, 1, 'exactly one');
  const code = openIfSealedCode();
  assert(!/noteRefusedForwardJump/.test(code),
    'admitSeq() owns the counter; a second bump here double-counts every refusal');
  assert(/admit\.why !== 'forward-jump'/.test(code),
    'a forward-jump must be excluded from noteDrop(), or it inflates droppedTotal');
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

// NEGATIVE-TEST NOTE, recorded because it changes what these two checks are
// worth. Planting "a duplicate widens highestAccepted" does NOT turn them red,
// and cannot: a duplicate seq is by construction one already seen, hence <=
// highestAccepted, so the widening branch is unreachable. Same for a
// below-floor drop, which is strictly lower still. They are cheap REGRESSION
// PINS on the second half of each assertion (the bound is still where the
// accepts left it), not detectors. The detector for "a drop widens the bound"
// is the RATCHET case — a refusal setting highestAccepted = n, which would let
// an attacker climb one window per forged frame — and that is caught by
// vectors F2-2/F2-3/F2-6, verified red by plant.
await check('a duplicate does NOT widen the bound', async () => {
  reset();
  const args = { kid: KID, direction: DIR, pairEpoch: 7 };
  await S.admitSeq({ ...args, seq: 10 });
  await S.markAuthenticated({ ...args, seq: 10 });
  await S.admitSeq({ ...args, seq: 10 });          // duplicate
  await S.markAuthenticated({ ...args, seq: 10 }); // even if the caller marked it
  eq(record().highestAccepted, 10, 'highestAccepted after a duplicate');
  eq((await S.admitSeq({ ...args, seq: 1035 })).ok, false, '10 + 1024 + 1 is still refused');
});

await check('a below-floor drop does NOT widen the bound', async () => {
  reset();
  const args = { kid: KID, direction: DIR, pairEpoch: 7 };
  await S.admitSeq({ ...args, seq: 0 });
  await S.markAuthenticated({ ...args, seq: 0 });
  await S.admitSeq({ ...args, seq: 1024 });        // floor -> 1
  await S.markAuthenticated({ ...args, seq: 1024 });
  await S.admitSeq({ ...args, seq: 0 });           // below floor now
  eq(record().highestAccepted, 1024, 'unchanged by a below-floor drop');
});

console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
