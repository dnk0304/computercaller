/**
 * tests/e2e-epoch-claim.test.mjs — E2E-P6 deliverable (b), M-D items (i) and (ii).
 *
 * TWO SCENARIOS THAT ARE EACH OTHER'S MIRROR IMAGE
 * ------------------------------------------------
 * (i)  A pairEpoch BUMP while a Forge-M panel-close resume claim is held.
 *      New epoch ⇒ new SK ⇒ new kid ⇒ the §13.5 dedupe window RESETS.
 * (ii) A dock RESUME on the SAME kid. §13.8: resume/hold/dock reuse SK, so the
 *      relay re-sends the SAME e2e block, there is NO epoch bump, and therefore
 *      the dedupe window must NOT reset — the frameBuffer replay has to be
 *      DEDUPED, silently, rather than rejected.
 *
 * Writing only (i) would let "reset the window" become "reset the window
 * always", which silently swallows nothing but also silently un-protects every
 * resume. Writing only (ii) would let "never reset" stand, which silently
 * swallows the first 1024 frames of every new epoch. The pair is the test.
 *
 * WHAT IS UNDER TEST, AND WHAT IS MERELY MIRRORED
 * -----------------------------------------------
 *  • WEB lane  — `lib/e2e/session.mjs` is IMPORTED and driven for real, with
 *    real AES-256-GCM under real HKDF traffic keys. Nothing here is a stub.
 *  • SW lane   — `chrome-extension/e2e/sw-session.js` is also IMPORTED, behind
 *    the same fake `chrome.storage` the existing SW suites install (see
 *    `tests/e2e-sw-a3-ctx.test.mjs`). The dispatch suggested mirroring the SW
 *    rule as text; importing it is strictly stronger — a text mirror proves
 *    what the file SAYS, an import proves what it DOES — and the precedent for
 *    the stub already ships, so the "chrome.* at module scope" hazard is
 *    already solved in-tree. Deviation noted deliberately.
 *  • RELAY     — the resume claim's lifetime is asserted over `server.js` as
 *    TEXT. This is the one honest claim available here: the shipped relay is
 *    exercised by P6 (g), and the property wanted is a NEGATIVE one ("no term
 *    in the claim's expiry mentions the epoch"), which a source assertion can
 *    actually establish and a mirrored state machine cannot.
 *  • ANDROID   — asserted only from the frozen byte contract (the AAD binds
 *    pairEpoch, §13.10 / `lib/e2e/kdf.mjs` aad()). THE LIVE ANDROID ASSERTION
 *    BELONGS TO P6 (g); nothing below may be cited as evidence about the
 *    shipped app.
 *
 * Run: node tests/e2e-epoch-claim.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

// ── Fake chrome.storage, installed BEFORE the SW module is imported ─────────
// A real session store, not a stub that always answers empty: the dedupe
// window LIVES in storage.session, and a get that returned {} would make every
// seq look like a first sight — the duplicate branch would be untestable and,
// worse, would look tested.
let swLocal = {};
let swSession = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (k, cb) => cb(k in swLocal ? { [k]: swLocal[k] } : {}),
      set: (o, cb) => { Object.assign(swLocal, structuredClone(o)); if (cb) cb(); },
    },
    session: {
      get: (k, cb) => cb(k in swSession ? { [k]: swSession[k] } : {}),
      set: (o, cb) => { Object.assign(swSession, structuredClone(o)); if (cb) cb(); },
    },
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const K = await import('../lib/e2e/kdf.mjs');
const S = await import('../lib/e2e/session.mjs');
const SW = await import('../chrome-extension/e2e/sw-session.js');
const { e2eBlock } = await import('./lib/sealed-twin.mjs');

let passed = 0;
let total = 0;
const failures = [];

async function check(name, fn) {
  total += 1;
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

const te = new TextEncoder();
const PAIRING_ID = 'p6-md-pairing-0001';
const USER_ID = 'user-p6-md';
const PHONE_DEVICE_ID = 'phone-dev-p6';
const PEER_DEVICE_ID = 'sw-dev-p6';

/** The §13.10.8 / A3 ctx. pairEpoch is a DECIMAL STRING on the wire. */
function ctxFor(pairEpoch) {
  return {
    pairingId: PAIRING_ID,
    phoneDeviceId: PHONE_DEVICE_ID,
    peerDeviceId: PEER_DEVICE_ID,
    pairEpoch: String(pairEpoch),
  };
}

/** The pairContext bytes the KDF actually consumes (userId is LOCAL, never wired). */
function contextFor(pairEpoch) {
  return K.pairContext({
    userId: USER_ID,
    phoneDeviceId: PHONE_DEVICE_ID,
    peerDeviceId: PEER_DEVICE_ID,
    pairEpoch: BigInt(pairEpoch),
  });
}

/**
 * One end-to-end pair at one epoch: a real computer session (the web lane) and
 * the phone's matching p2c sender.
 *
 * `fresh: true` because a new epoch always mints a fresh kid (A2 MUST #1), and
 * a fresh kid on a fresh store is the first-use arm of bindKid().
 */
async function makePairAt({ epoch, sk, kid, store }) {
  const context = contextFor(epoch);
  const computer = await S.createComputerSession({
    pairingId: PAIRING_ID,
    sessionKey: sk,
    context,
    kid,
    pairEpoch: BigInt(epoch),
    store,
    fresh: true,
  }, subtle);
  const phone = await K.trafficKeys(
    { pairingId: PAIRING_ID, sessionKey: sk, context, role: 'phone' }, subtle,
  );
  return { epoch, kid, sk, context, computer, phone };
}

/** The phone seals a p2c frame at `seq` under `pair`, optionally spoofing kid. */
async function phoneSeal(pair, frameType, seq, payload, kidOverride = undefined) {
  const kid = kidOverride ?? pair.kid;
  const ciphertext = await K.seal({
    sender: pair.phone.send,
    frameType,
    kid,
    seq,
    pairEpoch: BigInt(pair.epoch),
    plaintext: te.encode(JSON.stringify(payload)),
  }, subtle);
  return S.encodeEnvelope({ kid, seq, ciphertext });
}

const EPOCH_OLD = 7;
const EPOCH_NEW = 8;
const SK_OLD = new Uint8Array(32).fill(0xa1);
const SK_NEW = new Uint8Array(32).fill(0xb2);
const KID_OLD = 'kid-md-epoch7';
const KID_NEW = 'kid-md-epoch8';

// ═══════════════════════════════════════════════════════════════════════════
// M-D (i) — pairEpoch BUMP while a panel-close resume claim is HELD
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nM-D (i) — pairEpoch bump under a held resume claim');

const storeOld = S.memorySeqStore();
const storeNew = S.memorySeqStore();
const oldPair = await makePairAt({ epoch: EPOCH_OLD, sk: SK_OLD, kid: KID_OLD, store: storeOld });
const newPair = await makePairAt({ epoch: EPOCH_NEW, sk: SK_NEW, kid: KID_NEW, store: storeNew });

await check('sanity: each epoch opens its OWN frames (the test can succeed at all)', async () => {
  const a = await oldPair.computer.open('PHONE_NOTIFICATION', await phoneSeal(oldPair, 'PHONE_NOTIFICATION', 0, { n: 'old-0' }));
  assert(a.ok === true, `old epoch frame did not open: ${a.reason}`);
  const b = await newPair.computer.open('PHONE_NOTIFICATION', await phoneSeal(newPair, 'PHONE_NOTIFICATION', 0, { n: 'new-0' }));
  assert(b.ok === true, `new epoch frame did not open: ${b.reason}`);
});

await check('(i) the OLD SK does not decrypt a POST-BUMP frame (kid held constant to isolate the key)', async () => {
  // kid spoofed to the OLD kid so the envelope survives the kid gate and the
  // AEAD is what has to refuse. Without this the test would pass on the kid
  // check alone and prove nothing about the key.
  const spoofed = await phoneSeal(newPair, 'PHONE_NOTIFICATION', 900, { n: 'post-bump' }, KID_OLD);
  const r = await oldPair.computer.open('PHONE_NOTIFICATION', spoofed);
  eq(r.ok, false, 'post-bump frame under the old SK');
  eq(r.reason, 'auth', 'refusal reason');
  assert(r.plaintext === undefined, 'a refused open must yield no plaintext');
});

await check('(i) and the reverse: the NEW SK does not decrypt a PRE-BUMP frame', async () => {
  const spoofed = await phoneSeal(oldPair, 'PHONE_NOTIFICATION', 901, { n: 'pre-bump' }, KID_NEW);
  const r = await newPair.computer.open('PHONE_NOTIFICATION', spoofed);
  eq(r.ok, false, 'pre-bump frame under the new SK');
  eq(r.reason, 'auth', 'refusal reason');
});

await check('(i) kid CHANGES with the epoch, and an OLD-kid frame after the bump is DROPPED-AND-COUNTED', async () => {
  assert(KID_OLD !== KID_NEW, 'kid <-> SK is 1:1 (A2 MUST #1): a new SK means a new kid');
  const before = newPair.computer.drops;
  const stale = await phoneSeal(oldPair, 'PHONE_NOTIFICATION', 3, { n: 'stale-kid' });
  const r = await newPair.computer.open('PHONE_NOTIFICATION', stale);
  eq(r.ok, false, 'an old-kid frame after the bump');
  eq(r.reason, 'kid', 'refusal reason');
  eq(newPair.computer.drops - before, 1, 'the drop counter must move by exactly one (§13.5: the counter is exported and asserted)');
});

await check('(i) the dedupe window RESETS on the bump — a seq already seen under the old epoch is NOT a duplicate under the new one', async () => {
  // This is the bug the assertion exists for: without a reset, the new epoch's
  // first 1024 frames land under a window that has already seen those numbers
  // and every one of them is silently swallowed.
  const SEQ = 5;
  const a = await oldPair.computer.open('PHONE_NOTIFICATION', await phoneSeal(oldPair, 'PHONE_NOTIFICATION', SEQ, { n: 'old-5' }));
  assert(a.ok === true, 'the old epoch must consume seq 5 first, or there is nothing to reset');
  const dupOld = await oldPair.computer.open('PHONE_NOTIFICATION', await phoneSeal(oldPair, 'PHONE_NOTIFICATION', SEQ, { n: 'old-5' }));
  eq(dupOld.reason, 'duplicate', 'seq 5 IS a duplicate inside the old epoch');

  const b = await newPair.computer.open('PHONE_NOTIFICATION', await phoneSeal(newPair, 'PHONE_NOTIFICATION', SEQ, { n: 'new-5' }));
  assert(b.ok === true, `seq ${SEQ} must be NEW under the new epoch, got reason=${b.reason}`);
  eq(b.seq, SEQ, 'the opened seq');
});

await check('(i) SW lane: admitSeq() is keyed on the epoch — the same seq re-admits after a bump, and duplicates inside one epoch do not', async () => {
  swSession = {};
  const arg = { kid: KID_OLD, direction: 'p2c', seq: 11 };
  const first = await SW.admitSeq({ ...arg, pairEpoch: EPOCH_OLD });
  eq(first.ok, true, 'first sight of seq 11 at epoch 7');
  const again = await SW.admitSeq({ ...arg, pairEpoch: EPOCH_OLD });
  eq(again.ok, false, 'seq 11 repeated inside epoch 7');
  eq(again.why, 'duplicate', 'why');
  const bumped = await SW.admitSeq({ ...arg, pairEpoch: EPOCH_NEW });
  eq(bumped.ok, true, 'seq 11 after the epoch bump must be NEW (§13.5: reset on pairEpoch)');
});

await check('(i) §13.5 constants are the frozen ones, and both lanes agree on them', async () => {
  eq(S.DEDUPE_WINDOW, 1024, 'web DEDUPE_WINDOW');
  eq(S.DEDUPE_FLOOR_ADVANCE_CAP, 256, 'web floor-advance cap');
  const swSrc = readFileSync(join(ROOT, 'chrome-extension/e2e/sw-session.js'), 'utf8');
  assert(/DEDUPE_WINDOW\s*=\s*1024/.test(swSrc), 'the SW must carry window 1024');
  assert(/FLOOR_ADVANCE_CAP\s*=\s*256/.test(swSrc), 'the SW must carry floor-advance cap 256');
});

await check('(i) dedupe NEVER rejects: a duplicate and an auth failure are both DROPS, neither closes anything', async () => {
  const w = S.createDedupeWindow();
  assert(w.accept(0) === true, 'first sight');
  assert(w.accept(0) === false, 'a duplicate is refused ACCEPTANCE');
  eq(w.drops, 1, 'and counted');
  // The contract is that `open` RETURNS a refusal rather than throwing, on
  // every failure path. A throw here would reach a call site that has no
  // try/catch and would take the socket down — precisely what §13.5 forbids.
  const junk = { e: 1, kid: newPair.kid, s: 77, c: 'A'.repeat(200) };
  const r = await newPair.computer.open('PHONE_NOTIFICATION', junk);
  eq(r.ok, false, 'a forged ciphertext');
  assert(r.reason === 'auth' || r.reason === 'duplicate', `a failure must be a drop reason, got ${r.reason}`);
});

await check('(i) the floor advance is CAPPED at 256 per step — one forged high seq cannot strand the real peer', async () => {
  const w = S.createDedupeWindow();
  w.accept(0);
  w.accept(10_000_000);           // an attacker's far-future seq
  assert(w.floor <= 256, `the floor moved to ${w.floor}; the cap bounds one step to 256`);
  assert(w.accept(300) === true, 'a real in-flight frame just above the capped floor must still be accepted');
});

await check('(i) the HELD claim is epoch-blind: every resume-claim expiry in server.js is a fixed window, with no e2e/epoch/kid term', async () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const assigns = [...src.matchAll(/(?:^|[^.\w])(?:claim\.expiresAt|expiresAt)\s*:?=\s*([^,;\n]+)/g)]
    .map((m) => m[1].trim());
  assert(assigns.length >= 4, `expected the claim-expiry sites to be found, got ${assigns.length}`);
  for (const rhs of assigns) {
    assert(!/e2e|pairEpoch|epoch|kid|wrap|\bsk\b/i.test(rhs),
      `a resume-claim lifetime is computed from "${rhs}" — mode must not extend or shorten a claim`);
  }
  // The positive half: the lifetimes that DO exist are the fixed windows, so
  // "no epoch term" cannot be satisfied by there being no expiry at all.
  assert(assigns.some((r) => /RESUME_WINDOW_MS/.test(r)), 'the resume claim must still have a real fixed window');
});

await check('(i) ANDROID / cross-lane: the AAD BINDS pairEpoch, so an epoch bump separates key spaces by construction', async () => {
  // Expressible from the frozen byte contract alone. THE LIVE ANDROID
  // ASSERTION IS P6 (g)'s — this proves the contract, not the app.
  const a = K.aad({ frameType: 'PHONE_NOTIFICATION', kid: KID_OLD, seq: 4, direction: K.DIR_P2C, pairEpoch: BigInt(EPOCH_OLD) });
  const b = K.aad({ frameType: 'PHONE_NOTIFICATION', kid: KID_OLD, seq: 4, direction: K.DIR_P2C, pairEpoch: BigInt(EPOCH_NEW) });
  assert(K.toHex(a) !== K.toHex(b), 'two epochs must not produce identical AAD');
  assert(/TAG_AAD_PAIR_EPOCH/.test(readFileSync(join(ROOT, 'lib/e2e/kdf.mjs'), 'utf8')), 'the pairEpoch AAD tag must exist');
  // And pairContext itself: same everything, different epoch ⇒ different bytes
  // ⇒ different traffic keys and different nonce prefixes.
  assert(K.toHex(contextFor(EPOCH_OLD)) !== K.toHex(contextFor(EPOCH_NEW)), 'pairContext must separate on pairEpoch');
});

await check('(i) pairEpoch is a DECIMAL STRING parsed as BigInt against the frozen grammar', async () => {
  eq(K.PAIR_EPOCH_WIRE_RE.source, '^(0|[1-9][0-9]{0,19})$', 'the frozen grammar');
  for (const good of ['0', '7', '18446744073709551615']) {
    assert(K.PAIR_EPOCH_WIRE_RE.test(good), `${good} must be accepted`);
  }
  for (const bad of ['07', '-1', '1.0', '', ' 7', '0x7', '1e3']) {
    assert(!K.PAIR_EPOCH_WIRE_RE.test(bad), `${bad} must be refused`);
  }
  eq(typeof BigInt(ctxFor(EPOCH_NEW).pairEpoch), 'bigint', 'the wire value parses as BigInt');
  eq(typeof ctxFor(EPOCH_NEW).pairEpoch, 'string', 'and is carried on the wire as a string');
});

await check('(i) userId is NEVER transmitted — it is not a field of the wire ctx', async () => {
  const ctx = ctxFor(EPOCH_NEW);
  eq(Object.keys(ctx).sort().join(','), 'pairEpoch,pairingId,peerDeviceId,phoneDeviceId', 'the wire ctx field set');
  assert(!JSON.stringify(ctx).includes(USER_ID), 'the userId must not appear anywhere on the wire');
});

// ═══════════════════════════════════════════════════════════════════════════
// M-D (ii) — dock RESUME on the SAME kid
// ═══════════════════════════════════════════════════════════════════════════

console.log('\nM-D (ii) — dock resume on the same kid (no epoch bump)');

const dockStore = S.memorySeqStore();
const dock = await makePairAt({ epoch: EPOCH_NEW, sk: SK_NEW, kid: KID_NEW, store: dockStore });

await check('(ii) the resume re-sends the SAME e2e block — same kid, same wrap, NO epoch bump', async () => {
  const first = e2eBlock({ kid: KID_NEW, ctx: ctxFor(EPOCH_NEW) });
  // §13.8: resume/hold/dock reuse SK, so the relay forwards the block it is
  // already holding. Not a re-mint, not a re-wrap — the same object.
  const onResume = first;
  eq(onResume.kid, first.kid, 'kid across the resume');
  eq(onResume.epk, first.epk, 'epk across the resume');
  eq(JSON.stringify(onResume.ctx), JSON.stringify(first.ctx), 'ctx across the resume');
  eq(onResume.ctx.pairEpoch, String(EPOCH_NEW), 'the epoch must NOT move on a resume');

  // And the relay half, asserted over source: the resume path forwards the
  // stored block rather than building a new one.
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert(/e2e/.test(src), 'server.js must carry the e2e block at all');
  const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  assert(/noteE2eBlock\(data && data\.e2e\)/.test(bg),
    'the SW must handle the e2e block ABOVE the unchanged-presence early return, or every resume drops the wrap');
});

await check('(ii) buffered sealed frames replay IN ORDER and ALL open', async () => {
  const buffered = [];
  for (let seq = 0; seq < 6; seq += 1) {
    buffered.push({ seq, env: await phoneSeal(dock, 'SMS_RECEIVED', seq, { body: `msg-${seq}` }) });
  }
  const opened = [];
  for (const { env } of buffered) {
    const r = await dock.computer.open('SMS_RECEIVED', env);
    assert(r.ok === true, `buffered frame did not open: ${r.reason}`);
    opened.push(JSON.parse(new TextDecoder().decode(r.plaintext)).body);
  }
  eq(opened.join(','), 'msg-0,msg-1,msg-2,msg-3,msg-4,msg-5', 'replay order');
  dock._buffered = buffered;
});

await check('(ii) counters do NOT reset on a resume: the frameBuffer REPLAY is deduped, not rejected', async () => {
  const beforeDrops = dock.computer.drops;
  const beforeFloor = dock.computer.recvFloor;
  // The dock reconnects; the relay replays everything since the claim's cutoff.
  for (const { env } of dock._buffered) {
    const r = await dock.computer.open('SMS_RECEIVED', env);
    eq(r.ok, false, 'a replayed frame must not be processed twice');
    eq(r.reason, 'duplicate', 'and the reason must be `duplicate`, never an error');
  }
  eq(dock.computer.drops - beforeDrops, dock._buffered.length,
    'every replayed frame must be counted as a drop — this is the mirror of (i): no reset means the window still remembers them');
  eq(dock.computer.recvFloor, beforeFloor, 'a resume must not move the receive floor');
});

await check('(ii) a resume does NOT reset the send counter either — persist-before-emit continues from the stored floor', async () => {
  const floorBefore = dock.computer.sendFloor;
  await dock.computer.seal('SEND_SMS', te.encode('{"to":"x"}'));
  eq(dock.computer.sendFloor, floorBefore + 1, 'the send floor advances');
  // Rebuilding the session on the SAME store and SAME kid (a resume) must pick
  // the floor back up, not restart at 0 — restarting is GCM nonce reuse, since
  // A2 makes the nonce prefix a deterministic function of SK and pairEpoch.
  const resumed = await S.createComputerSession({
    pairingId: PAIRING_ID,
    sessionKey: SK_NEW,
    context: contextFor(EPOCH_NEW),
    kid: KID_NEW,
    pairEpoch: BigInt(EPOCH_NEW),
    store: dockStore,
    fresh: false,
  }, subtle);
  eq(resumed.resumed, true, 'the rebuild must report itself as a resume');
  eq(resumed.sendFloor, floorBefore + 1, 'the resumed sender must continue from the persisted floor');
});

await check('(ii) SW lane: the same kid + same epoch across a resume keeps its window, and the replay deduplicates', async () => {
  swSession = {};
  const arg = { kid: KID_NEW, direction: 'p2c', pairEpoch: EPOCH_NEW };
  for (let seq = 0; seq < 4; seq += 1) {
    eq((await SW.admitSeq({ ...arg, seq })).ok, true, `first delivery of seq ${seq}`);
  }
  // The dock reconnects; nothing about the key material changed, so the window
  // must survive and the replay must land as duplicates.
  for (let seq = 0; seq < 4; seq += 1) {
    const r = await SW.admitSeq({ ...arg, seq });
    eq(r.ok, false, `replayed seq ${seq} must not be processed twice`);
    eq(r.why, 'duplicate', 'why');
  }
});

await check('(ii) the SW drop counter is EXPORTED and observable (§13.5 requires it to be assertable)', async () => {
  swSession = {};
  const zero = await SW.readDrops();
  eq(zero.total, 0, 'a fresh counter');
  await SW.noteDrop('duplicate');
  await SW.noteDrop('duplicate');
  await SW.noteDrop('auth');
  const drops = await SW.readDrops();
  eq(drops.total, 3, 'total');
  eq(drops.byReason.duplicate, 2, 'duplicate drops');
  eq(drops.byReason.auth, 1, 'auth drops');
});

await check('(ii) a decrypt failure DROPS and never closes the socket; 3 failures in 10 s ⇒ request re-pair', async () => {
  const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  // The rule has two halves and they are asserted separately, because the
  // dangerous regression is keeping the counter while quietly adding a close.
  assert(!/close\(\s*\)\s*;?\s*\/\/\s*decrypt/i.test(bg), 'a decrypt failure must never close the socket');
  const swSrc = readFileSync(join(ROOT, 'chrome-extension/e2e/sw-session.js'), 'utf8');
  assert(/never treated as an attack|DROPPED, never treated as an attack/.test(swSrc),
    'the SW must state and implement drop-not-reject');
  // The re-pair trigger is a product-level policy; it is named here so a
  // future implementation cannot land without this file noticing.
  const hasRepairPolicy = /re-?pair/i.test(bg) || /re-?pair/i.test(swSrc);
  assert(hasRepairPolicy, 'the re-pair request policy (3 decrypt failures in 10 s) must be present in the SW lane');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
process.exit(0);
