/**
 * tests/e2e-sw-a3-ctx.test.mjs — E2E-P3: GATE1 Addendum A3, vector I + M2/M3/M4.
 *
 * A3 (RATIFIED (A), AMENDED, 2026-09-17T23:41Z) gives `pairContext` a channel:
 * the phone carries `ctx = {pairingId, phoneDeviceId, peerDeviceId, pairEpoch}`
 * inside the e2e block, `userId` stays local to each side, and the derivation
 * itself is §13.10.3 unchanged.
 *
 * Vector I's whole assertion is one sentence: **wire ctx + local userId == the
 * frozen local context, byte for byte.** A3 requires the Android lane to assert
 * I through its ENCODE path and P2/P3 through their DECODE path, "that pairing
 * is what makes the vector cross-implementation rather than two copies of one
 * belief". This file is the SW's decode half.
 *
 * ── VECTOR SOURCE (P3 follow-up, rebased onto P1.1 46e3084) ────────────────
 * The earlier revision of this file carried A3's published bytes INLINE, with
 * a flag saying to re-point them once the §13.10.x follow-up landed vector I
 * in the P0.2-frozen `tests/kdf-vectors.json`. P1.1 landed it (`ctxWire`), so
 * every expected byte below is now READ FROM THAT FILE and nothing is
 * transcribed. The inline copies were compared against the frozen file before
 * deletion and agreed byte-for-byte — no value was adjusted in either
 * direction, which is the only outcome that means anything: a mismatch would
 * have been a finding, not a merge conflict.
 *
 * `mustBeFromFile()` below makes the re-point structural rather than a promise
 * — it fails if a field the frozen file is supposed to supply is missing, so a
 * future edit cannot quietly reintroduce a local expectation.
 *
 * Run: node tests/e2e-sw-a3-ctx.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

// ── Fake chrome.storage (local AND session), installed before the module ────
let local = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (k, cb) => cb(k in local ? { [k]: local[k] } : {}),
      set: (o, cb) => { Object.assign(local, structuredClone(o)); if (cb) cb(); },
    },
    session: {
      get: (k, cb) => cb({}),
      set: (o, cb) => { if (cb) cb(); },
    },
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = JSON.parse(readFileSync(join(ROOT, 'tests/kdf-vectors.json'), 'utf8'));

const K = await import('../chrome-extension/e2e/kdf.mjs');
const S = await import('../chrome-extension/e2e/sw-session.js');

// ── A3's published bytes — READ FROM THE FROZEN FILE, never transcribed ─────
// A missing field is a hard stop rather than an `undefined` that turns an
// assertion into a tautology (`undefined === undefined` passes).
function mustBeFromFile(value, where) {
  if (value === undefined || value === null) {
    throw new Error(`frozen tests/kdf-vectors.json is missing ${where} — refusing to substitute a local expectation`);
  }
  return value;
}
const W = mustBeFromFile(V.ctxWire, 'ctxWire');
const WI1 = mustBeFromFile(W.positiveI1, 'ctxWire.positiveI1');
const WI2 = mustBeFromFile(W.negativeI2EpochDrift, 'ctxWire.negativeI2EpochDrift');
const WI3 = mustBeFromFile(W.negativeI3UserIdDrift, 'ctxWire.negativeI3UserIdDrift');
const WI4 = mustBeFromFile(W.negativeI4Parser, 'ctxWire.negativeI4Parser');

const I1 = {
  ctxWire: mustBeFromFile(WI1.ctxWire, 'ctxWire.positiveI1.ctxWire'),
  localUserId: mustBeFromFile(WI1.localUserId, 'positiveI1.localUserId'),
  contextBytesHex: mustBeFromFile(WI1.contextBytesHex, 'positiveI1.contextBytesHex'),
  kP2cHex: mustBeFromFile(WI1.phoneToComputerKeyHex, 'positiveI1.phoneToComputerKeyHex'),
  kC2pHex: mustBeFromFile(WI1.computerToPhoneKeyHex, 'positiveI1.computerToPhoneKeyHex'),
  np2cHex: mustBeFromFile(WI1.np2cHex, 'positiveI1.np2cHex'),
  nc2pHex: mustBeFromFile(WI1.nc2pHex, 'positiveI1.nc2pHex'),
  openedPlaintextHex: mustBeFromFile(WI1.openedPlaintextHex, 'positiveI1.openedPlaintextHex'),
};
const I2 = {
  pairEpoch: mustBeFromFile(WI2.pairEpoch, 'negativeI2EpochDrift.pairEpoch'),
  contextBytesHex: mustBeFromFile(WI2.contextBytesHex, 'negativeI2EpochDrift.contextBytesHex'),
  kP2cHex: mustBeFromFile(WI2.phoneToComputerKeyHex, 'negativeI2EpochDrift.phoneToComputerKeyHex'),
  np2cHex: mustBeFromFile(WI2.np2cHex, 'negativeI2EpochDrift.np2cHex'),
};
const I3 = {
  localUserId: mustBeFromFile(WI3.localUserId, 'negativeI3UserIdDrift.localUserId'),
  kP2cHex: mustBeFromFile(WI3.phoneToComputerKeyHex, 'negativeI3UserIdDrift.phoneToComputerKeyHex'),
};
// A2 vector F — the p2c frame the opened plaintext above comes from. Same
// file, `aead.vectorF`, so I.1's "opensVectorF" claim is checked against the
// very bytes vector F publishes rather than a second copy of them.
const VF = mustBeFromFile(V.aead?.vectorF, 'aead.vectorF');
const F = {
  frameType: mustBeFromFile(VF.frameType, 'aead.vectorF.frameType'),
  kid: mustBeFromFile(VF.kid, 'aead.vectorF.kid'),
  seq: mustBeFromFile(VF.seq, 'aead.vectorF.seq'),
  pairEpoch: mustBeFromFile(VF.pairEpoch, 'aead.vectorF.pairEpoch'),
  ciphertextHex: mustBeFromFile(VF.ciphertextHex, 'aead.vectorF.ciphertextHex'),
};

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
async function refuses(fn, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`${what}: expected a refusal, got none`);
  if (!(err instanceof S.CtxRefused)) throw new Error(`${what}: threw ${err.name}, expected CtxRefused`);
  assert(err.countsOnly === true, `${what}: refusal must carry countsOnly`);
  return err;
}

const OWN = I1.ctxWire.peerDeviceId;          // this "device" is the web peer id
const sessionKey = K.fromHex(V.traffic.sessionKeyHex);
const reset = () => { local = {}; };

console.log('A3 vector I + MUSTs (decode path)\n');

// ── I.1 — the positive: wire ctx + local userId == the frozen context ───────

await check('I.1: wire ctx + local userId reproduces the FROZEN contextBytes', async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: I1.ctxWire },
    ownDeviceId: OWN,
    userId: I1.localUserId,
  });
  const bytes = K.pairContext(inputs);
  eq(K.toHex(bytes), I1.contextBytesHex, 'contextBytes');
  // …and that value IS the file's own frozen local context. This equality is
  // the entire claim of A3: nothing about the derivation changed, only where
  // four of its five inputs come from.
  eq(K.toHex(bytes), V.contextBytesHex, 'contextBytes == the frozen local value');
});

await check('I.1: traffic keys and A2 prefixes derive from the wire ctx', async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId,
  });
  const ctxBytes = K.pairContext(inputs);
  const keys = await K.trafficKeys({
    pairingId: inputs.pairingId, sessionKey, context: ctxBytes, role: 'phone',
  }, subtle);
  eq(K.toHex(keys.send.rawBytes), I1.kP2cHex, 'k_p2c');
  eq(K.toHex(keys.recv.rawBytes), I1.kC2pHex, 'k_c2p');
  const { np2c, nc2p } = await S.noncePrefixes({
    pairingId: inputs.pairingId, sessionKey, context: ctxBytes,
  }, subtle);
  eq(K.toHex(np2c), I1.np2cHex, 'np2c');
  eq(K.toHex(nc2p), I1.nc2pHex, 'nc2p');
});

await check('I.1: A2 vector F OPENS under the wire-derived key + prefix', async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId,
  });
  const ctxBytes = K.pairContext(inputs);
  const { np2c } = await S.noncePrefixes({ pairingId: inputs.pairingId, sessionKey, context: ctxBytes }, subtle);
  const key = await subtle.importKey('raw', K.fromHex(I1.kP2cHex), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: K.nonce(np2c, F.seq),
      additionalData: K.aad({
        frameType: F.frameType, kid: F.kid, seq: F.seq,
        direction: K.DIR_P2C, pairEpoch: F.pairEpoch,
      }),
      tagLength: 128,
    },
    key,
    K.fromHex(F.ciphertextHex),
  ));
  // The padded block, not the unpadded string: this asserts the bytes A3
  // published, which are the §13.4 padded form.
  eq(K.toHex(plain), I1.openedPlaintextHex, 'opened plaintext');
});

// ── I.2 — epoch drift ───────────────────────────────────────────────────────

await check(`I.2: pairEpoch "${I2.pairEpoch}" gives a DIFFERENT context, key and prefix`, async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: I2.pairEpoch } },
    ownDeviceId: OWN,
    userId: I1.localUserId,
  });
  const ctxBytes = K.pairContext(inputs);
  eq(K.toHex(ctxBytes), I2.contextBytesHex, 'contextBytes (last byte 2b)');
  const keys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: ctxBytes, role: 'phone' }, subtle);
  eq(K.toHex(keys.send.rawBytes), I2.kP2cHex, 'k_p2c');
  const { np2c } = await S.noncePrefixes({ pairingId: inputs.pairingId, sessionKey, context: ctxBytes }, subtle);
  eq(K.toHex(np2c), I2.np2cHex, 'np2c');
});

await check(`I.2: A2 vector F FAILS AUTHENTICATION under the epoch-${I2.pairEpoch} key`, async () => {
  assert(WI2.opensVectorF === false, 'the frozen file must be asserting non-opening here');
  const key = await subtle.importKey('raw', K.fromHex(I2.kP2cHex), 'AES-GCM', false, ['decrypt']);
  let opened = false;
  try {
    await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: K.nonce(K.fromHex(I2.np2cHex), F.seq),
        additionalData: K.aad({
          frameType: F.frameType, kid: F.kid, seq: F.seq,
          direction: K.DIR_P2C, pairEpoch: F.pairEpoch,
        }),
        tagLength: 128,
      },
      key,
      K.fromHex(F.ciphertextHex),
    );
    opened = true;
  } catch { /* expected */ }
  assert(!opened, 'an epoch-drifted key must not open the frame');
});

// ── I.3 — userId drift proves the UN-transmitted field is load-bearing ──────

await check('I.3: one character of local userId drift gives total key divergence', async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I3.localUserId,
  });
  const ctxBytes = K.pairContext(inputs);
  const keys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: ctxBytes, role: 'phone' }, subtle);
  eq(K.toHex(keys.send.rawBytes), I3.kP2cHex, 'k_p2c under the drifted userId');
  assert(K.toHex(keys.send.rawBytes) !== I1.kP2cHex, 'it must differ from I.1');
});

// ── I.4 — parser negatives: refuse, NEVER coerce ────────────────────────────

// The refused set is the frozen file's `badPairEpoch` list, taken verbatim and
// in order, plus two cases this lane adds on top (the frozen list's
// `missingPairEpoch` flag, and the 2^64 boundary A3 bounds the parser at). The
// coverage assertion below is the point: if a later edit to the frozen file
// adds a case, this file starts failing instead of quietly testing the old set.
const FROZEN_BAD_EPOCHS = mustBeFromFile(WI4.badPairEpoch, 'negativeI4Parser.badPairEpoch');
const BAD_EPOCHS = [
  ...FROZEN_BAD_EPOCHS.map((v) => [v, `frozen badPairEpoch ${JSON.stringify(v)}`]),
  [undefined, 'an absent value (frozen missingPairEpoch)'],
  ['18446744073709551616', 'a value above 2^64-1'],
];
await check('I.4: every frozen badPairEpoch case is exercised', async () => {
  assert(WI4.missingPairEpoch === true, 'frozen file must flag missingPairEpoch');
  assert(WI4.missingCtxOnMode1 === true, 'frozen file must flag missingCtxOnMode1');
  for (const v of FROZEN_BAD_EPOCHS) {
    assert(
      BAD_EPOCHS.some(([value]) => Object.is(value, v)),
      `frozen badPairEpoch case ${JSON.stringify(v)} is not covered`,
    );
  }
});
for (const [value, label] of BAD_EPOCHS) {
  await check(`I.4: pairEpoch with ${label} is REFUSED, not coerced`, async () => {
    reset();
    await refuses(
      () => S.pairContextInputs({
        block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: value } },
        ownDeviceId: OWN,
        userId: I1.localUserId,
      }),
      label,
    );
    // The discriminating half: nothing was written. A parser that refused but
    // had already moved the floor would have made the refusal expensive.
    eq(Object.keys(local[S.EPOCH_FLOOR_KEY] || {}).length, 0, 'no floor written on a refusal');
  });
}

await check('I.4 / A3-M4: a mode=1 block with NO ctx is refused, never derived from local', async () => {
  reset();
  const err = await refuses(
    () => S.pairContextInputs({ block: { mode: 1 }, ownDeviceId: OWN, userId: I1.localUserId }),
    'absent ctx on mode=1',
  );
  assert(/A3-M4/.test(err.why), `refusal should cite A3-M4, said: ${err.why}`);
});

await check('I.4 / A3-M3: a block addressed to ANOTHER device is refused', async () => {
  reset();
  // The frozen file names both sides of this case; using its own pair means the
  // "own" id is the one vector I says we are, not one this test chose.
  const M3 = mustBeFromFile(WI4.peerDeviceIdMismatch, 'negativeI4Parser.peerDeviceIdMismatch');
  eq(M3.ownDeviceId, OWN, 'frozen ownDeviceId must be the device this file plays');
  const err = await refuses(
    () => S.pairContextInputs({
      block: { mode: 1, ctx: { ...I1.ctxWire, peerDeviceId: M3.ctxPeerDeviceId } },
      ownDeviceId: M3.ownDeviceId,
      userId: I1.localUserId,
    }),
    'peerDeviceId mismatch',
  );
  assert(/A3-M3/.test(err.why), `refusal should cite A3-M3, said: ${err.why}`);
});

await check('I.4 / A3-M3: the pairingId half refuses WHEN the caller knows the value', async () => {
  // A3-M3 is two checks. The SW cannot perform the pairingId half from
  // PAIR_STATE alone (that frame carries no pairingId — documented in
  // validateCtx, and it is P2's half), so `pairingId` is an optional argument
  // that defaults to null. Optional is not the same as absent: this asserts the
  // branch is real and refuses, so the day a caller CAN supply the value it
  // gets a check rather than a parameter nothing reads.
  const MP = mustBeFromFile(WI4.pairingIdMismatch, 'negativeI4Parser.pairingIdMismatch');
  eq(MP.ownPairingId, I1.ctxWire.pairingId, 'frozen ownPairingId must be vector I.1\'s');
  let threw = null;
  try {
    S.validateCtx({
      ctx: { ...I1.ctxWire, pairingId: MP.ctxPairingId },
      mode: 1,
      ownDeviceId: OWN,
      userId: I1.localUserId,
      pairingId: MP.ownPairingId,
    });
  } catch (e) { threw = e; }
  assert(threw instanceof S.CtxRefused, `expected CtxRefused, got ${threw && threw.name}`);
  assert(/A3-M3/.test(threw.why), `refusal should cite A3-M3, said: ${threw.why}`);
  // Control: the SAME call with the matching pairingId must NOT refuse, or the
  // assertion above would pass for any reason at all.
  S.validateCtx({
    ctx: I1.ctxWire, mode: 1, ownDeviceId: OWN, userId: I1.localUserId, pairingId: MP.ownPairingId,
  });
});

const OVERSIZE = mustBeFromFile(WI4.oversizeFieldBytes, 'negativeI4Parser.oversizeFieldBytes');
await check(`I.4: an id of ${OVERSIZE} UTF-8 bytes is refused on the DECODE side`, async () => {
  for (const field of ['pairingId', 'phoneDeviceId', 'peerDeviceId']) {
    reset();
    const ctx = { ...I1.ctxWire, [field]: 'a'.repeat(OVERSIZE) };
    if (field === 'peerDeviceId') continue;       // that one fails A3-M3 first
    await refuses(
      () => S.pairContextInputs({ block: { mode: 1, ctx }, ownDeviceId: OWN, userId: I1.localUserId }),
      `${field} 256 bytes`,
    );
  }
  reset();
  await refuses(
    () => S.pairContextInputs({
      block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: 'u'.repeat(OVERSIZE),
    }),
    `userId ${OVERSIZE} bytes`,
  );
});

// ── A3-M2 — the epoch floor ─────────────────────────────────────────────────

await check('A3-M2: first sight of a phoneDeviceId is TOFU — no comparison, floor set', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  const floors = await S.readEpochFloors();
  eq(floors[`${I1.localUserId}|${I1.ctxWire.phoneDeviceId}`], '42', 'floor after first sight');
});

await check('A3-M2: a REPLAYED epoch is refused — the GCM nonce-reuse case', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '42' } }, ownDeviceId: OWN, userId: I1.localUserId });
  // The relay replays the old ACCEPT block. Accepting it would reinstall a
  // superseded SK whose counter restarts at 0 against a key and a derived
  // prefix that have already sealed frames.
  const err = await refuses(
    () => S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '42' } }, ownDeviceId: OWN, userId: I1.localUserId }),
    'epoch replay',
  );
  assert(/A3-M2/.test(err.why), `refusal should cite A3-M2, said: ${err.why}`);
});

await check('A3-M2: an epoch BELOW the floor is refused too, not just equal', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '100' } }, ownDeviceId: OWN, userId: I1.localUserId });
  await refuses(
    () => S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '99' } }, ownDeviceId: OWN, userId: I1.localUserId }),
    'epoch below floor',
  );
});

await check('A3-M2: a HIGHER epoch is admitted and advances the floor (a real rekey)', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '42' } }, ownDeviceId: OWN, userId: I1.localUserId });
  await S.pairContextInputs({ block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '43' } }, ownDeviceId: OWN, userId: I1.localUserId });
  const floors = await S.readEpochFloors();
  eq(floors[`${I1.localUserId}|${I1.ctxWire.phoneDeviceId}`], '43', 'advanced floor');
});

await check('A3-M2: persist-before-use — the floor is committed before the caller can derive', async () => {
  reset();
  const inputs = await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  // By the time the caller holds the inputs, the floor is already on disk. A
  // crash here leaves the floor AHEAD (one refused pair, one re-Accept) rather
  // than BEHIND (an open replay window).
  const floors = await S.readEpochFloors();
  eq(floors[`${inputs.userId}|${inputs.phoneDeviceId}`], '42', 'floor already persisted');
});

await check('A3-M2: floors are per (userId, phoneDeviceId), not global', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  // A DIFFERENT phone on the same account is a different pinning subject and
  // starts at TOFU rather than inheriting another phone's floor.
  await S.pairContextInputs({
    block: { mode: 1, ctx: { ...I1.ctxWire, phoneDeviceId: 'dev-phone-02', pairEpoch: '1' } },
    ownDeviceId: OWN,
    userId: I1.localUserId,
  });
  const floors = await S.readEpochFloors();
  eq(floors[`${I1.localUserId}|dev-phone-01`], '42', 'phone 1');
  eq(floors[`${I1.localUserId}|dev-phone-02`], '1', 'phone 2 TOFU');
});

await check('A3-M2: ONLY an explicit clear removes a floor — nothing on the wire can', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  // There is deliberately no "the phone asked us to reset" path, so the only
  // way to exercise a clear is to call the explicit one.
  await S.clearEpochFloors(I1.localUserId);
  eq(Object.keys(await S.readEpochFloors()).length, 0, 'cleared');
  // …and after a clear, TOFU applies again — which is correct: an unpair is
  // the user saying "forget this phone".
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  eq((await S.readEpochFloors())[`${I1.localUserId}|dev-phone-01`], '42', 'TOFU after an explicit clear');
});

await check('A3-M2: clearing one user does not clear another', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: 'user-A' });
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: 'user-B' });
  await S.clearEpochFloors('user-A');
  const floors = await S.readEpochFloors();
  assert(!(`user-A|dev-phone-01` in floors), 'user-A cleared');
  eq(floors[`user-B|dev-phone-01`], '42', 'user-B untouched');
});

// ── The floor must be DURABLE, which is why it is storage.local ─────────────

await check('A3-M2: the floor lives in storage.LOCAL — a browser restart must not clear it', async () => {
  reset();
  await S.pairContextInputs({ block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: I1.localUserId });
  // storage.session is cleared on browser exit; a floor kept there would let a
  // replay simply wait for a restart. Assert the bytes are in `local`.
  assert(S.EPOCH_FLOOR_KEY in local, 'the floor must be in chrome.storage.local');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
