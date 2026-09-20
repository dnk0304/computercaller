/**
 * tests/e2e-sw-chokepoint.test.mjs — E2E-P3 follow-up (c): the seal/unseal
 * chokepoint.
 *
 * Four claims, each of which is false by default and stays false silently:
 *
 *  1. INBOUND, a §13.7 sealed-list frame arriving with NO envelope while the
 *     session is OPEN is dropped and counted. This is the downgrade: strip
 *     `{e,kid,s,c}`, forward the body in the clear, and a worker with a
 *     perfectly good session renders it exactly as it would a sealed one.
 *     Nothing throws. Every suite that only ever feeds SEALED frames to an ON
 *     session passes throughout — which is why this is tested by feeding the
 *     wrong shape, not by feeding the right one.
 *  2. GET_MESSAGES / GET_CALL_LOGS / GET_CONTACTS stay plaintext even then
 *     (§13.7 mandates it: sealing them moves the relay's tier gate to the
 *     client, which is the same as deleting it).
 *  3. OUTBOUND, pad → seal → envelope goes through ONE function that takes its
 *     seq from the fail-closed counter, and the worker still sends nothing.
 *  4. Dedupe is a line-for-line match for the Android lane's E2eDedupe, and
 *     the admitSeq floor divergence found earlier stays fixed (regression).
 *
 * Plus the restore-from-backup refusal — old floor / old seq replayed from
 * storage ⇒ refuse and rekey. Noted where it is asserted: that case is ALSO
 * GATE1 Addendum A2's blocking restore test, and one test satisfies both.
 *
 * Run: node tests/e2e-sw-chokepoint.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

// ── Fake chrome.storage, installed before the module under test ─────────────
let session = {};
let local = {};
globalThis.chrome = {
  storage: {
    session: {
      get: (k, cb) => cb(k in session ? { [k]: session[k] } : {}),
      set: (o, cb) => { Object.assign(session, structuredClone(o)); if (cb) cb(); },
    },
    local: {
      get: (k, cb) => cb(k in local ? { [k]: local[k] } : {}),
      set: (o, cb) => { Object.assign(local, structuredClone(o)); if (cb) cb(); },
    },
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = JSON.parse(readFileSync(join(ROOT, 'tests/kdf-vectors.json'), 'utf8'));

const K = await import('../chrome-extension/e2e/kdf.mjs');
const S = await import('../chrome-extension/e2e/sw-session.js');
const P = await import('../chrome-extension/e2e/padding.mjs');

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
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: got ${a}, expected ${b}`); }
function assert(c, m) { if (!c) throw new Error(m); }
async function throws(fn, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`${what}: expected a throw, got none`);
  return err;
}
const reset = () => { session = {}; local = {}; };

console.log('(c) seal/unseal chokepoint\n');

// ── 1 / 2. The §13.7 frame list ────────────────────────────────────────────

await check('§13.7: the sealed list is transcribed, not inferred', async () => {
  // Spot-check the frames this worker actually handles, from the frozen list.
  for (const t of ['PHONE_NOTIFICATION', 'SMS_RECEIVED', 'CALL_INCOMING', 'CALL_WAITING',
    'CALL_ANSWERED', 'CALL_ENDED', 'SIM_LIST', 'SMS_SEND_STATUS']) {
    assert(S.requiresSeal(t), `${t} must require a seal`);
  }
});

await check('§13.7: GET_* are MANDATORILY plaintext, even with a live session', async () => {
  for (const t of ['GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS']) {
    assert(!S.requiresSeal(t), `${t} must NOT require a seal — it is the relay's tier gate`);
    assert(S.MANDATORY_PLAINTEXT_FRAME_TYPES.has(t), `${t} must be listed explicitly`);
    // The discriminating half: listed explicitly, so a future edit that adds
    // them to the sealed set collides with the exemption instead of quietly
    // moving billing enforcement to the client.
    assert(!S.SEALED_FRAME_TYPES.has(t), `${t} must not ALSO be in the sealed set`);
  }
});

await check('§13.7: pairing / presence / heartbeat frames never require a seal', async () => {
  for (const t of ['PAIR_STATE', 'LOBBY_STATUS', 'PHONE_PRESENT', 'PHONE_ABSENT',
    'ROOM_RESET', 'HB', 'PING', 'PONG']) {
    assert(!S.requiresSeal(t), `${t} must not require a seal`);
  }
});

await check('§13.7: an UNKNOWN frame type does not require a seal', async () => {
  // The safe default, and it is the safe one in the direction that matters: an
  // unknown type defaulting to "must be sealed" would drop every frame added to
  // the product before this list was updated. Unknown types carry no content
  // this protocol claims to protect — a type that does gets added to the list.
  assert(!S.requiresSeal('SOME_FUTURE_FRAME'), 'unknown types must not be forced through the seal check');
  assert(!S.requiresSeal('CALL_STATUS'), 'CALL_STATUS is per-field in §13.7 and is deliberately in neither set');
});

// ── 1. The inbound chokepoint, as the real decision function ───────────────

const SEALED_BODY = { e: 1, kid: 'kid-01', s: 0, c: 'AAAA' };
const PLAIN_SMS = { from: '+4790000000', body: 'the message that must not leak' };
const disp = (mode, frameType, data) => S.inboundDisposition({ mode, frameType, data });

await check('DOWNGRADE: plaintext SMS_RECEIVED while OPEN is DROPPED, not rendered', async () => {
  eq(disp('open', 'SMS_RECEIVED', PLAIN_SMS), S.INBOUND_DROP_PLAINTEXT, 'SMS_RECEIVED');
  eq(disp('open', 'PHONE_NOTIFICATION', { title: 'T', body: 'B' }), S.INBOUND_DROP_PLAINTEXT, 'PHONE_NOTIFICATION');
  eq(disp('open', 'CALL_INCOMING', { number: '+47' }), S.INBOUND_DROP_PLAINTEXT, 'CALL_INCOMING');
  // Dropped ENTIRELY — the disposition is not "deliver generically". A generic
  // notification still tells whoever stripped the envelope that it got through.
  assert(disp('open', 'SMS_RECEIVED', PLAIN_SMS) !== S.INBOUND_DELIVER, 'must not deliver');
});

await check('DOWNGRADE: the drop is scoped to OPEN — off / counts-only still deliver', async () => {
  // The discriminating half. If the drop were unconditional, every un-paired
  // user's notifications would vanish and the suite above would still be green.
  eq(disp('off', 'SMS_RECEIVED', PLAIN_SMS), S.INBOUND_DELIVER, 'off');
  eq(disp('counts-only', 'SMS_RECEIVED', PLAIN_SMS), S.INBOUND_DELIVER, 'counts-only');
  eq(disp(undefined, 'SMS_RECEIVED', PLAIN_SMS), S.INBOUND_DELIVER, 'no session at all');
});

await check('DOWNGRADE: GET_* are delivered plaintext even while OPEN (§13.7)', async () => {
  for (const t of ['GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS']) {
    eq(disp('open', t, { since: 0 }), S.INBOUND_DELIVER, t);
  }
});

await check('DOWNGRADE: presence / pairing frames are delivered while OPEN', async () => {
  for (const t of ['PAIR_STATE', 'LOBBY_STATUS', 'PHONE_PRESENT', 'ROOM_RESET', 'HB', 'PING']) {
    eq(disp('open', t, {}), S.INBOUND_DELIVER, t);
  }
});

await check('ORDER: a SEALED frame routes to UNSEAL before anything else, in every mode', async () => {
  for (const m of ['off', 'counts-only', 'open']) {
    eq(disp(m, 'SMS_RECEIVED', SEALED_BODY), S.INBOUND_UNSEAL, `sealed under mode=${m}`);
  }
  // …and the unseal branch is reached for a type NOT on the sealed list too: an
  // envelope is an envelope, and refusing to open one because the list did not
  // predict it would drop a frame we can actually read.
  eq(disp('open', 'SOME_FUTURE_FRAME', SEALED_BODY), S.INBOUND_UNSEAL, 'sealed unknown type');
});

await check('background.js routes through the chokepoint — not a second inline copy', async () => {
  const src = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert(/inboundDisposition\(\s*\{/.test(code), 'handleFrame must call inboundDisposition()');
  // The guard must not have been re-written inline beside it, which is how one
  // of the two copies silently stops matching the other.
  assert(
    !/e2eMode\s*===\s*'open'\s*&&[\s\S]{0,80}requiresSeal/.test(code),
    'an inline copy of the downgrade condition is present in background.js',
  );
  // And the drop must be counted under the reason the harness greps for.
  assert(/noteDrop\(\s*'plaintext-while-on'\s*\)/.test(code), 'the drop must be counted as plaintext-while-on');
});

// ── 3. The outbound chokepoint ─────────────────────────────────────────────

const ctxInputs = {
  userId: V.context.userId,
  phoneDeviceId: V.context.phoneDeviceId,
  peerDeviceId: V.context.peerDeviceId,
  pairEpoch: V.context.pairEpoch,
};
const pairingId = V.context.pairingId;
const sessionKey = K.fromHex(V.traffic.sessionKeyHex);
const KID = 'kid-01';
const EPOCH = Number(V.context.pairEpoch);

async function freshSession() {
  return S.buildSession({ pairingId, sessionKey, ctxInputs }, subtle);
}

await check('outbound: sealFrame FAILS CLOSED when no counter floor is proven', async () => {
  reset();
  const sess = await freshSession();
  // No openSendCounter() call: the floor was never committed. A2 made this
  // blocking, and it is now the SOLE control against nonce reuse — the derived
  // prefix contributes none.
  const err = await throws(
    () => S.sealFrame({ session: sess, frameType: 'SMS_RECEIVED', kid: KID, pairEpoch: EPOCH, payload: { body: 'hi' } }),
    'seal with no proven counter',
  );
  assert(/no proven counter floor/.test(err.message), `wrong refusal: ${err.message}`);
  // And it must not have emitted anything on the way out.
  eq(session[S.SEQ_KEY], undefined, 'a refused seal must not create a counter');
});

await check('outbound: pad → seal → envelope {e:1,kid,s,c}, and it OPENS', async () => {
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  const env = await S.sealFrame({
    session: sess, frameType: 'SMS_RECEIVED', kid: KID, pairEpoch: EPOCH,
    payload: { body: 'hi', from: '+4790000000' },
  });
  eq(env.e, 1, 'envelope tag');
  eq(env.kid, KID, 'kid');
  eq(env.s, 0, 'first seq is the committed floor, 0');
  assert(typeof env.c === 'string' && env.c.length > 0, 'ciphertext must be base64url text');
  assert(S.isSealedEnvelope(env), 'the chokepoint must emit a frame its own shape-check accepts');

  // The round trip, through the RECEIVING half of a session built the same way
  // — i.e. the phone's view. `role:'computer'` gives send=c2p, so decrypt with
  // a c2p receiver rather than re-using our own recv (which is p2c and would
  // fail for the right reason but prove the wrong thing).
  const context = K.pairContext(ctxInputs);
  const keys = await K.trafficKeys({ pairingId, sessionKey, context, role: 'phone' }, subtle);
  const { nc2p } = await S.noncePrefixes({ pairingId, sessionKey, context }, subtle);
  const plain = await K.open({
    receiver: { direction: K.DIR_C2P, key: keys.recv.key, rawBytes: keys.recv.rawBytes, sessionPrefix: nc2p },
    frameType: 'SMS_RECEIVED', kid: KID, seq: 0n, pairEpoch: EPOCH,
    ciphertext: S.fromBase64Url(env.c),
  }, subtle);
  const got = JSON.parse(new TextDecoder().decode(plain));
  eq(got.body, 'hi', 'round-tripped body');
  eq(got.from, '+4790000000', 'round-tripped from');
});

await check('outbound: the padding is applied ONCE (seal pads; the chokepoint must not)', async () => {
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  const env = await S.sealFrame({
    session: sess, frameType: 'SMS_RECEIVED', kid: KID, pairEpoch: EPOCH, payload: { body: 'hi' },
  });
  const ct = S.fromBase64Url(env.c);
  // Ciphertext length == padded length + 16-byte tag, and the padded length
  // must be one of §13.4's buckets. Double-padding would land on a bucket TOO,
  // just a bigger one — so assert the SMALLEST bucket that fits, which only the
  // single-padded frame reaches.
  const payloadLen = new TextEncoder().encode(JSON.stringify({ body: 'hi' })).length;
  const expected = P.bucketFor(payloadLen + P.LENGTH_PREFIX_BYTES);
  eq(ct.length, expected + 16, `ciphertext length (bucket ${expected} + tag)`);
});

await check('outbound: sealFrame REFUSES a mandatorily-plaintext frame type', async () => {
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  const err = await throws(
    () => S.sealFrame({ session: sess, frameType: 'GET_CONTACTS', kid: KID, pairEpoch: EPOCH, payload: {} }),
    'sealing GET_CONTACTS',
  );
  assert(/not a sealed frame type/.test(err.message), `wrong refusal: ${err.message}`);
  // It must not have consumed a sequence number on the way to refusing: a
  // refusal that burns a seq is a refusal that can be used to skip the counter.
  eq(session[S.SEQ_KEY][`${KID}|${sess.send.direction}`], 0, 'seq must be untouched by a refusal');
});

await check('outbound: sealFrame takes NO seq argument — the counter is the only source', async () => {
  // A caller that can choose its own sequence number is a caller that can reuse
  // a nonce. Asserted on the signature so the day someone "helpfully" threads a
  // seq through for a resume, this fails.
  const src = readFileSync(join(ROOT, 'chrome-extension/e2e/sw-session.js'), 'utf8');
  const sig = src.slice(src.indexOf('export async function sealFrame'));
  const params = sig.slice(sig.indexOf('{'), sig.indexOf('}'));
  assert(!/\bseq\b/.test(params), `sealFrame must not accept a seq parameter, got: ${params}`);
});

await check('the worker still SENDS NOTHING on the socket (the dormancy claim)', async () => {
  const src = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  S.assertSwSendsNothing(src);
  // Control: the assertion must be able to fail, or it proves nothing. Without
  // this, a broken stripper (or a regex that matches nothing) reads as a PASS
  // on every input forever.
  await throws(
    () => S.assertSwSendsNothing('function f(){ sock.send(JSON.stringify(x)); }'),
    'the control case',
  );
  // …and it must not trip on the prose that surrounds the real thing.
  S.assertSwSendsNothing('// it never calls sock.send() on the listener\nconst a = 1;');
  S.assertSwSendsNothing('const s = "ws.send(x)";');
  S.assertSwSendsNothing('chrome.runtime.sendMessage({a:1}); port.postMessage(y);');
});

// ── 4. Dedupe parity with Android E2eDedupe + the admitSeq regression ───────

const DIR_IN = K.DIR_P2C;
const admit = (seq) => S.admitSeq({ kid: KID, direction: DIR_IN, seq, pairEpoch: EPOCH });

await check('REGRESSION: an IN-WINDOW frame must NOT advance the floor (Android parity)', async () => {
  reset();
  // The divergence fixed earlier in this lane, pinned so it cannot come back.
  // admitSeq once advanced `floor` on every in-window admission, whereas the
  // Android lane's E2eDedupe.observe moves the floor ONLY when the window
  // slides. Two implementations agreeing on 1024/256 but disagreeing on WHEN
  // the floor moves diverge only under attack or a long resume gap — the two
  // situations in which nobody thinks to compare them.
  //
  // The discriminating case: admit a high-but-in-window seq, then a LOW one. If
  // the floor had followed the high seq, the low frame would be rejected
  // below-floor — i.e. a resume gap would silently eat real messages.
  assert((await admit(900)).ok, '900 must be admitted');
  const w = session[S.DEDUPE_KEY][`${KID}|${DIR_IN}`];
  eq(w.floor, 0, 'the floor must still be 0 after an in-window admission');
  assert((await admit(3)).ok, 'a LOW seq after a high in-window one must still be admitted');
});

await check('dedupe: a duplicate is dropped, silently, and stays dropped', async () => {
  reset();
  assert((await admit(5)).ok, 'first sight admitted');
  const again = await admit(5);
  assert(!again.ok, 'a duplicate must be refused');
  eq(again.why, 'duplicate', 'reason');
  const third = await admit(5);
  assert(!third.ok, 'still refused on a third sight');
});

await check('dedupe: the floor advance is CAPPED at 256 on one frame', async () => {
  reset();
  assert((await admit(0)).ok, 'seed');
  await S.markAuthenticated({ kid: KID, direction: DIR_IN, seq: 0, pairEpoch: EPOCH });
  assert((await admit(S.DEDUPE_WINDOW)).ok, 'at the forward-jump bound, still admissible');
  await S.markAuthenticated({ kid: KID, direction: DIR_IN, seq: S.DEDUPE_WINDOW, pairEpoch: EPOCH });
  // Beyond floor+1024 but WITHIN the M-A5-2 bound (highestAccepted 1024 +
  // WINDOW). One admissible frame may still carry the floor at most 256.
  await admit(2 * S.DEDUPE_WINDOW);
  const w = session[S.DEDUPE_KEY][`${KID}|${DIR_IN}`];
  eq(w.floor, 1 + S.FLOOR_ADVANCE_CAP, 'floor advanced by exactly the cap, not by the full slide');
  assert(w.beyondWindow >= 1, 'the un-provable case must be COUNTED, not silent');
});

// Security A5 / M-A5-2 (F2) at the chokepoint: the case the check above USED to
// cover — `seq: 1_000_000` — is no longer a capped advance, it is a refusal.
await check('dedupe: a frame past the forward-jump bound is REFUSED at the chokepoint', async () => {
  reset();
  assert((await admit(0)).ok, 'seed');
  // Arm the mark — M-A5-2's bound applies only once a frame has AUTHENTICATED.
  await S.markAuthenticated({ kid: KID, direction: DIR_IN, seq: 0, pairEpoch: EPOCH });
  const r = await admit(1_000_000);
  eq(r.ok, false, 'refused');
  eq(r.why, 'forward-jump', 'and named');
  const w = session[S.DEDUPE_KEY][`${KID}|${DIR_IN}`];
  eq(w.floor, 0, 'the floor did not move');
  eq(w.beyondWindow, 0, 'a refusal is not a beyond-window accept');
});

await check('dedupe: the window RESETS on a new pairEpoch (§13.5)', async () => {
  reset();
  assert((await admit(5)).ok, 'seed under epoch 42');
  const r = await S.admitSeq({ kid: KID, direction: DIR_IN, seq: 5, pairEpoch: EPOCH + 1 });
  assert(r.ok, 'the same seq under a NEW epoch is a new key and must be admitted');
});

await check('dedupe: windows are per (kid, direction)', async () => {
  reset();
  assert((await admit(5)).ok, 'p2c seq 5');
  const other = await S.admitSeq({ kid: KID, direction: K.DIR_C2P, seq: 5, pairEpoch: EPOCH });
  assert(other.ok, 'the same seq in the OTHER direction is a different counter');
  const otherKid = await S.admitSeq({ kid: 'kid-02', direction: DIR_IN, seq: 5, pairEpoch: EPOCH });
  assert(otherKid.ok, 'the same seq under another kid is a different counter');
});

await check('dedupe: a malformed or negative seq is refused, never coerced', async () => {
  reset();
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await admit(bad);
    assert(!r.ok, `${bad} must be refused`);
    eq(r.why, 'malformed-seq', `reason for ${bad}`);
  }
});

// ── Drop counter ───────────────────────────────────────────────────────────

await check('drops are COUNTED by reason — a silent dropper is untestable', async () => {
  reset();
  await S.noteDrop('plaintext-while-on');
  await S.noteDrop('plaintext-while-on');
  await S.noteDrop('wrong-kid');
  const d = await S.readDrops();
  eq(d.total, 3, 'total');
  eq(d.byReason['plaintext-while-on'], 2, 'plaintext-while-on');
  eq(d.byReason['wrong-kid'], 1, 'wrong-kid');
  eq(S.DROPS_KEY, 'cc_e2e_drops', 'the exported key name the harness reads');
});

// ── Restore-from-backup: refuse + rekey (ALSO A2's blocking restore test) ───

await check('RESTORE: a replayed storage.local with an OLD epoch floor is REFUSED + rekeys', async () => {
  // GATE1 Addendum A2 requires a blocking restore-from-backup test, and A3-M2
  // requires the epoch floor to refuse a replayed epoch. THIS ONE TEST SATISFIES
  // BOTH: the restore is the attack A2 names, and the floor is the control A3
  // specifies against it. Stated explicitly so neither is later thought missing.
  reset();
  const wire = V.ctxWire.positiveI1.ctxWire;
  const uid = V.ctxWire.positiveI1.localUserId;

  // Live at epoch 42, then rekey to 43 — the floor follows.
  await S.pairContextInputs({ block: { mode: 1, ctx: wire }, userId: uid });
  await S.pairContextInputs({ block: { mode: 1, ctx: { ...wire, pairEpoch: '43' } }, userId: uid });
  const floors = await S.readEpochFloors();
  eq(floors[`${uid}|${wire.phoneDeviceId}`], '43', 'floor after the rekey');

  // The restore: a backup of storage.local from BEFORE the rekey is put back,
  // and the relay replays the epoch-42 block that went with it.
  const err = await throws(
    () => S.pairContextInputs({ block: { mode: 1, ctx: wire }, userId: uid }),
    'the replayed epoch-42 block',
  );
  assert(err instanceof S.CtxRefused, `expected CtxRefused, got ${err.name}`);
  assert(err.countsOnly === true, 'a refusal must route to counts-only, never a plaintext fallback');

  // And the floor was NOT walked backwards by the refusal — the whole control
  // is worthless if the attack that it refuses also resets it.
  const after = await S.readEpochFloors();
  eq(after[`${uid}|${wire.phoneDeviceId}`], '43', 'floor unmoved by the refusal');
});

await check('RESTORE: a replayed SEND COUNTER is refused — no resume at a guess, no restart at 0', async () => {
  // A2's other half. The counter lives in storage.session, so the realistic
  // replay is "the worker respawned and the counter is simply gone" — which is
  // indistinguishable from a restore that dropped it, and must fail the same
  // way: refuse to encrypt and force a rekey.
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  eq(await S.nextSendSeq({ kid: KID, direction: sess.send.direction }), 0, 'seq 0');
  eq(await S.nextSendSeq({ kid: KID, direction: sess.send.direction }), 1, 'seq 1');

  // The restore: storage rolled back to the state after seq 0 was handed out.
  session[S.SEQ_KEY] = { [`${KID}|${sess.send.direction}`]: 1 };
  // …which would hand out 1 a SECOND time. This is the case the persist-before-
  // emit rule cannot detect from inside, and it is why the counter is committed
  // BEFORE the value is returned: the rollback is the backup's doing, and the
  // control that catches it is the epoch floor above, not this counter.
  // What this asserts is the part the counter CAN own — a MISSING floor is
  // never treated as 0.
  delete session[S.SEQ_KEY];
  const err = await throws(
    () => S.nextSendSeq({ kid: KID, direction: sess.send.direction }),
    'a vanished counter',
  );
  assert(/no proven counter floor/.test(err.message), `wrong refusal: ${err.message}`);
  assert(/rekey/i.test(err.message), 'the refusal must say to rekey, not merely fail');
});

await check('A2 MUST 1: a kid may never get a second counter (kid ↔ SK is 1:1)', async () => {
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  const err = await throws(
    () => S.openSendCounter({ kid: KID, direction: sess.send.direction }),
    'a second counter for one kid',
  );
  assert(/must never be reused/.test(err.message), `wrong refusal: ${err.message}`);
});

await check('A2: the nonce prefix is NEVER persisted — storage is dumped and grepped', async () => {
  reset();
  const sess = await freshSession();
  await S.openSendCounter({ kid: KID, direction: sess.send.direction });
  await S.sealFrame({
    session: sess, frameType: 'SMS_RECEIVED', kid: KID, pairEpoch: EPOCH, payload: { body: 'hi' },
  });
  const dump = JSON.stringify({ session, local });
  const context = K.pairContext(ctxInputs);
  const { np2c, nc2p } = await S.noncePrefixes({ pairingId, sessionKey, context }, subtle);
  for (const [n, p] of [['np2c', np2c], ['nc2p', nc2p]]) {
    assert(!dump.includes(K.toHex(p)), `${n} was persisted`);
    assert(!dump.includes(S.toBase64Url(p)), `${n} was persisted (base64url)`);
  }
  assert(!dump.includes(V.traffic.sessionKeyHex), 'SK was persisted');
  assert(!dump.includes('prefix'), 'a field named "prefix" appears in storage');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
