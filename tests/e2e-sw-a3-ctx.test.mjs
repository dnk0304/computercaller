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
 * Expected bytes are transcribed from the signed addendum for the same reason
 * they are in tests/e2e-sw-nonce-prefix.test.mjs: A3 says to ADD vector I to
 * the P0.2-frozen `tests/kdf-vectors.json`, which three lanes assert and P3
 * does not own while P2 runs in parallel. The context INPUTS are read from that
 * file; only A3's published outputs are inline. Re-point and delete the inline
 * copies when the §13.10.x follow-up lands them.
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

// ── A3's published bytes ────────────────────────────────────────────────────
const I1 = {
  ctxWire: {
    pairingId: 'pair-7f3a9c21',
    phoneDeviceId: 'dev-phone-01',
    peerDeviceId: 'dev-web-01',
    pairEpoch: '42',
  },
  localUserId: 'user-0191aa',
  contextBytesHex: '110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d7765622d303114000000000000002a',
  kP2cHex: 'b12f964e487f7bf39a0b37df9715ca9e606c642c28bdf430f51b2051a4e0e060',
  kC2pHex: 'd519d9b52f5258e36a05e4c06a55e652a250c103743acb77ffcc6d7249bfac7d',
  np2cHex: '6fa67348',
  nc2pHex: '4a786847',
  openedPlaintextHex: '00000002686900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
};
const I2 = {
  contextBytesHex: '110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d7765622d303114000000000000002b',
  kP2cHex: '92bb769b26bd88b059fed952bc189b47fa293563324d61eb4d88438eeb713652',
  np2cHex: '13168906',
};
const I3 = {
  localUserId: 'user-0191ab',
  kP2cHex: '838a45bc4c6cb537eb16efa37c51f949efb9b54c83e3f4fc2fe11636a838a65e',
};
// A2 vector F — the p2c frame the opened plaintext above comes from.
const F = {
  frameType: 'SMS_RECEIVED',
  kid: 'kid-01',
  seq: 7,
  pairEpoch: 42,
  ciphertextHex: '9675ba5ab30c62bb4802c19f4bcd250612e6b7fead8e8aa4c7fff702cec36d68fb85220b16a4c823d2597780d8e664a977b9d0881ed2f41d7a9e402378f3928c6450b5bb8934fe688c6f728943ac10ce',
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

await check('I.2: pairEpoch "43" gives a DIFFERENT context, key and prefix', async () => {
  reset();
  const inputs = await S.pairContextInputs({
    block: { mode: 1, ctx: { ...I1.ctxWire, pairEpoch: '43' } },
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

await check('I.2: A2 vector F FAILS AUTHENTICATION under the epoch-43 key', async () => {
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

const BAD_EPOCHS = [
  [42, 'a JSON number'],
  ['042', 'a leading zero'],
  [' 42', 'leading whitespace'],
  ['-1', 'a sign'],
  ['4.2', 'a decimal point'],
  ['', 'an empty string'],
  [undefined, 'an absent value'],
  ['18446744073709551616', 'a value above 2^64-1'],
];
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
  const err = await refuses(
    () => S.pairContextInputs({
      block: { mode: 1, ctx: { ...I1.ctxWire, peerDeviceId: 'dev-someone-else' } },
      ownDeviceId: OWN,
      userId: I1.localUserId,
    }),
    'peerDeviceId mismatch',
  );
  assert(/A3-M3/.test(err.why), `refusal should cite A3-M3, said: ${err.why}`);
});

await check('I.4: an id over 255 UTF-8 bytes is refused on the DECODE side', async () => {
  for (const field of ['pairingId', 'phoneDeviceId', 'peerDeviceId']) {
    reset();
    const ctx = { ...I1.ctxWire, [field]: 'a'.repeat(256) };
    if (field === 'peerDeviceId') continue;       // that one fails A3-M3 first
    await refuses(
      () => S.pairContextInputs({ block: { mode: 1, ctx }, ownDeviceId: OWN, userId: I1.localUserId }),
      `${field} 256 bytes`,
    );
  }
  reset();
  await refuses(
    () => S.pairContextInputs({
      block: { mode: 1, ctx: I1.ctxWire }, ownDeviceId: OWN, userId: 'u'.repeat(256),
    }),
    'userId 256 bytes',
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
