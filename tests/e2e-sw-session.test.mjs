/**
 * tests/e2e-sw-session.test.mjs — E2E-P3 (b)/(c)/(d): the SW session rules.
 *
 * Covers the three things GATE1 Addendum A2 made BLOCKING for this lane:
 *
 *   1. persist-before-emit / fail-closed, proved against a restore-from-backup
 *      (A2: "a lane that seals frames without a restore-from-backup test that
 *      proves refuse-and-rekey does not ship"). The SW's equivalent of P4's
 *      `E2eSeqStoreTest.restore_from_backup_fails_closed` is a cleared or
 *      evicted `chrome.storage.session`, which is what this exercises.
 *   2. `kid` ↔ `SK` strictly 1:1, ENFORCED WHERE THE COUNTER IS MINTED rather
 *      than by convention (A2 MUST 1). A second SK under a reused kid restarts
 *      a counter at 0 under the same key and the same DERIVED prefix — GCM
 *      nonce reuse, total loss of confidentiality and forgery resistance.
 *   3. the prefix is derived per session and never persisted (A2 MUST 2) —
 *      asserted here as "no storage key ever holds prefix bytes".
 *
 * Plus §13.5's frozen dedupe parameters, whose drop counter the spec requires to
 * be exported precisely because "a silent dropper and a working receiver are
 * otherwise indistinguishable".
 *
 * `chrome.storage.session` is faked with a plain object. That is not a mock of
 * the thing under test — the thing under test is the ORDERING and the REFUSALS
 * around it, and a real MV3 profile cannot be driven from node. The browser-side
 * behaviour is proved separately by scripts/ext-badge-counter-proof.mjs.
 *
 * Run: node tests/e2e-sw-session.test.mjs
 */

import { webcrypto } from 'node:crypto';

// ── Fake chrome.storage.session, installed BEFORE the module under test ─────
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
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
async function throws(fn, needle, what) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(`${what}: expected a throw, got none`);
  if (needle && !String(threw.message).includes(needle)) {
    throw new Error(`${what}: threw "${threw.message}", expected it to mention "${needle}"`);
  }
}

const reset = () => { store = {}; };

console.log('SW session rules (A2 blocking criteria + §13.5)\n');

// ── 1. Persist-before-emit, fail closed ─────────────────────────────────────

await check('a counter with no proven floor REFUSES to issue a seq', async () => {
  reset();
  await throws(
    () => S.nextSendSeq({ kid: 'kid-01', direction: 1 }),
    'refusing to encrypt',
    'nextSendSeq with no floor',
  );
});

await check('RESTORE-FROM-BACKUP: cleared storage refuses and forces a rekey, never restarts at 0', async () => {
  reset();
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  eq(Number(await S.nextSendSeq({ kid: 'kid-01', direction: 1 })), 0, 'first seq');
  eq(Number(await S.nextSendSeq({ kid: 'kid-01', direction: 1 })), 1, 'second seq');
  eq(Number(await S.nextSendSeq({ kid: 'kid-01', direction: 1 })), 2, 'third seq');

  // The restore: storage comes back empty (profile copied, storage.session
  // evicted, site data cleared) while the PEER still holds kid-01 and its keys.
  reset();
  await throws(
    () => S.nextSendSeq({ kid: 'kid-01', direction: 1 }),
    'force a rekey',
    'after restore',
  );
  // And crucially it did NOT quietly hand back 0 — which would reuse nonce
  // 0 under a key that has already seen it. A2: this is now the SOLE control.
  assert(!(`kid-01|1` in (store[S.SEQ_KEY] || {})), 'a refused call must not create a floor');
});

await check('persist-before-emit: the NEXT value is committed before the current one is handed out', async () => {
  reset();
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  const seq = Number(await S.nextSendSeq({ kid: 'kid-01', direction: 1 }));
  eq(seq, 0, 'issued seq');
  // Storage already holds 1. A crash here costs one skipped seq (free); the
  // other ordering would cost a reuse (total).
  eq(store[S.SEQ_KEY]['kid-01|1'], 1, 'committed floor after issuing 0');
});

// ── 2. kid ↔ SK strictly 1:1, enforced at mint (A2 MUST 1) ──────────────────

await check('a kid may NEVER get a second counter — enforced where it is minted', async () => {
  reset();
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  await throws(
    () => S.openSendCounter({ kid: 'kid-01', direction: 1 }),
    'never be reused across session keys',
    'reopening a counter for the same kid',
  );
});

await check('a DIFFERENT kid opens its own counter freely (a rekey must not be blocked)', async () => {
  reset();
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  await S.openSendCounter({ kid: 'kid-02', direction: 1 });
  eq(Number(await S.nextSendSeq({ kid: 'kid-02', direction: 1 })), 0, 'fresh kid starts at 0');
});

await check('the two directions of one kid are separate counters', async () => {
  reset();
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  await S.openSendCounter({ kid: 'kid-01', direction: 2 });
  await S.nextSendSeq({ kid: 'kid-01', direction: 1 });
  eq(Number(await S.nextSendSeq({ kid: 'kid-01', direction: 2 })), 0, 'c2p unaffected by p2c');
});

// ── 3. The prefix is derived, never persisted (A2 MUST 2) ───────────────────

await check('no storage key ever holds a nonce prefix', async () => {
  reset();
  const ctx = { userId: 'u', phoneDeviceId: 'p', peerDeviceId: 'w', pairEpoch: 1 };
  const sk = new Uint8Array(32).fill(7);
  const { np2c, nc2p } = await S.noncePrefixes({ pairingId: 'pair-1', sessionKey: sk, context: ctx }, webcrypto.subtle);
  await S.cacheWrap({ kid: 'kid-01', wrap: 'AAAA', epk: 'BBBB', mode: 1, recipKeys: [] });
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  const dumped = JSON.stringify(store);
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  for (const [n, p] of [['np2c', np2c], ['nc2p', nc2p]]) {
    assert(!dumped.includes(hex(p)), `${n} bytes found in storage — the prefix must never be persisted`);
  }
  // And the derivation is stable across "sessions" — it is a function of SK,
  // not of a stored value, which is exactly why it adds no nonce uniqueness.
  const again = await S.noncePrefixes({ pairingId: 'pair-1', sessionKey: sk, context: ctx }, webcrypto.subtle);
  eq(hex(again.np2c), hex(np2c), 're-derived np2c');
});

// ── §13.5 dedupe / anti-replay — the FROZEN parameters ──────────────────────

await check('§13.5 parameters are the frozen ones', () => {
  eq(S.DEDUPE_WINDOW, 1024, 'window width');
  eq(S.FLOOR_ADVANCE_CAP, 256, 'floor advance cap');
});

await check('a duplicate is DROPPED, silently, and counted', async () => {
  reset();
  const args = { kid: 'kid-01', direction: 1, pairEpoch: 1 };
  eq((await S.admitSeq({ ...args, seq: 5 })).ok, true, 'first arrival');
  const dup = await S.admitSeq({ ...args, seq: 5 });
  eq(dup.ok, false, 'duplicate admitted?');
  eq(dup.why, 'duplicate', 'reason');
  await S.noteDrop(dup.why);
  const drops = await S.readDrops();
  eq(drops.total, 1, 'exported drop total');
  eq(drops.byReason.duplicate, 1, 'exported drop reason');
});

await check('anti-replay DEDUPES, it never rejects a legitimate resume re-send', async () => {
  reset();
  const args = { kid: 'kid-01', direction: 1, pairEpoch: 1 };
  // frameBuffer legitimately re-sends on resume. Out-of-order and repeated
  // arrivals must all resolve to "deliver once", never to an error.
  for (const seq of [0, 1, 2, 3]) eq((await S.admitSeq({ ...args, seq })).ok, true, `seq ${seq}`);
  for (const seq of [1, 2, 3]) eq((await S.admitSeq({ ...args, seq })).ok, false, `replay ${seq}`);
  eq((await S.admitSeq({ ...args, seq: 4 })).ok, true, 'the next real frame still lands');
});

await check('the window RESETS on a new pairEpoch (a new epoch is a new key)', async () => {
  reset();
  eq((await S.admitSeq({ kid: 'kid-01', direction: 1, seq: 9, pairEpoch: 1 })).ok, true, 'epoch 1 seq 9');
  eq((await S.admitSeq({ kid: 'kid-01', direction: 1, seq: 9, pairEpoch: 1 })).ok, false, 'replay in epoch 1');
  // Same seq, new epoch: legitimate. Keeping the old window here would reject
  // real frames after every Accept — §13.5 calls this out by name.
  eq((await S.admitSeq({ kid: 'kid-01', direction: 1, seq: 9, pairEpoch: 2 })).ok, true, 'epoch 2 seq 9');
});

await check('a forged high seq advances the floor by AT MOST 256, matching the Android lane', async () => {
  reset();
  const args = { kid: 'kid-01', direction: 1, pairEpoch: 1 };
  eq((await S.admitSeq({ ...args, seq: 0 })).ok, true, 'baseline');
  // The attack: one frame claiming a huge sequence number. Uncapped, the floor
  // would jump to seq-1023 and EVERY frame still in flight would be refused as
  // "below floor" — a total denial of service costing the attacker one frame.
  const forged = await S.admitSeq({ ...args, seq: 5_000_000 });
  // §13.5 "anti-replay dedupes, it never rejects": we cannot prove the frame is
  // a duplicate, so it is accepted and COUNTED as beyond-window rather than
  // silently discarded. Same verdict as E2eDedupe.observe's beyondWindowTotal.
  eq(forged.ok, true, 'forged frame is accepted, not rejected');
  eq(forged.beyondWindow, true, 'and is counted as beyond-window');
  const w = store[S.DEDUPE_KEY]['kid-01|1'];
  eq(w.floor, 256, 'floor advanced by exactly the cap, not by 4,998,977');
  eq(w.beyondWindow, 1, 'beyond-window counter is exported');
  // The cap BOUNDS the damage; it does not eliminate it. Frames 1..255 are
  // lost — stated here rather than wished away, because the Android lane does
  // exactly the same thing and a test that claimed otherwise would be the one
  // place the two implementations silently disagreed.
  eq((await S.admitSeq({ ...args, seq: 1 })).why, 'below-floor', 'frames under the new floor are lost (bounded at 256)');
  // Everything at or above the new floor still lands normally.
  eq((await S.admitSeq({ ...args, seq: 256 })).ok, true, 'the first frame at the new floor lands');
  eq((await S.admitSeq({ ...args, seq: 900 })).ok, true, 'and the rest of the window is healthy');
});

await check('a second forged frame cannot compound the advance without more frames', async () => {
  reset();
  const args = { kid: 'kid-01', direction: 1, pairEpoch: 1 };
  await S.admitSeq({ ...args, seq: 0 });
  await S.admitSeq({ ...args, seq: 5_000_000 });
  await S.admitSeq({ ...args, seq: 5_000_000 });
  // Each forged frame costs the attacker one frame and buys at most 256 — the
  // cap is per frame, so the ratio never improves for them.
  eq(store[S.DEDUPE_KEY]['kid-01|1'].floor, 512, 'two frames, two caps');
});

await check('a malformed or negative seq is refused, not coerced', async () => {
  reset();
  const args = { kid: 'kid-01', direction: 1, pairEpoch: 1 };
  eq((await S.admitSeq({ ...args, seq: -1 })).why, 'malformed-seq', 'negative');
  eq((await S.admitSeq({ ...args, seq: 'banana' })).why, 'malformed-seq', 'non-numeric');
});

// ── Envelope shape ──────────────────────────────────────────────────────────

await check('isSealedEnvelope is shape-checked, not duck-typed on `e`', () => {
  assert(S.isSealedEnvelope({ e: 1, kid: 'k', s: 0, c: 'AA' }), 'a real envelope');
  assert(!S.isSealedEnvelope({ e: 1 }), 'bare `e` is not an envelope');
  // The load-bearing negative: a PLAINTEXT frame carrying an `e` field must not
  // be routed into the opener, because a frame routed there and dropped is a
  // notification the user silently never sees.
  assert(!S.isSealedEnvelope({ e: 1, body: 'hello', from: '+47' }), 'plaintext frame with an `e` field');
  assert(!S.isSealedEnvelope(null), 'null');
  assert(!S.isSealedEnvelope('PHONE_NOTIFICATION'), 'a string');
});

// ── The blocked source is blocked LOUDLY and lands in counts-only ───────────

await check('a mode=1 block with no ctx refuses with countsOnly (A3-M4; full vectors live in e2e-sw-a3-ctx)', async () => {
  let err = null;
  try {
    await S.pairContextInputs({ block: { mode: 1 }, ownDeviceId: 'dev-x', userId: 'user-x' });
  } catch (e) { err = e; }
  assert(err instanceof S.CtxRefused, 'expected CtxRefused');
  eq(err.countsOnly, true, 'countsOnly flag');
});

// ── The wrap cache holds the WRAP, never SK ─────────────────────────────────

await check('the session cache stores the wrap + epk and never a session key', async () => {
  reset();
  await S.cacheWrap({ kid: 'kid-01', wrap: 'WRAP-BYTES', epk: 'EPK-BYTES', mode: 1, recipKeys: ['K'] });
  const back = await S.readCachedWrap('kid-01');
  eq(back.wrap, 'WRAP-BYTES', 'wrap round-trips');
  eq(back.epk, 'EPK-BYTES', 'epk round-trips');
  assert(!('sk' in back) && !('sessionKey' in back), 'SK must never be cached');
});

await check('the wrap cache is bounded — a rekey per Accept must not grow forever', async () => {
  reset();
  for (let i = 0; i < 9; i += 1) {
    await S.cacheWrap({ kid: `kid-${i}`, wrap: 'W', epk: 'E', mode: 1, recipKeys: [] });
  }
  eq(Object.keys(store[S.WRAP_KEY]).length, 4, 'cached kids');
  assert(await S.readCachedWrap('kid-8'), 'the newest kid is kept');
});

await check('§13.8: dropSessionState clears wraps, counters and windows together', async () => {
  reset();
  await S.cacheWrap({ kid: 'kid-01', wrap: 'W', epk: 'E', mode: 1, recipKeys: [] });
  await S.openSendCounter({ kid: 'kid-01', direction: 1 });
  await S.admitSeq({ kid: 'kid-01', direction: 1, seq: 0, pairEpoch: 1 });
  await S.dropSessionState();
  eq(Object.keys(store[S.WRAP_KEY]).length, 0, 'wraps');
  eq(Object.keys(store[S.SEQ_KEY]).length, 0, 'counters');
  eq(Object.keys(store[S.DEDUPE_KEY]).length, 0, 'windows');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
