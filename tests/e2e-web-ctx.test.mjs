#!/usr/bin/env node
/**
 * tests/e2e-web-ctx.test.mjs — GATE1 Addendum A3 on the WEB DECODE side.
 *
 * Vector I asserted through the path a real accept actually takes, which for
 * this lane is:
 *
 *     the accept block as it arrives  ->  hooks/phoneE2e.readAcceptBlock
 *       ->  lib/e2e/kdf.pairContextFromWire(ctx, {userId, deviceId, pairingId})
 *       ->  lib/e2e/session traffic keys + nonce prefixes
 *       ->  A2 vector F's ciphertext OPENS
 *
 * Every one of those is production code. Nothing in this file re-implements a
 * derivation, and no expected byte is computed here: the values come out of the
 * P0.2/P1.1-frozen tests/kdf-vectors.json, which Security generated in an
 * INDEPENDENT HKDF/GCM implementation and which the Android lane asserts from
 * its own side. That pairing is what makes vector I cross-implementation
 * evidence rather than two copies of one belief — P4 asserts I.1 through its
 * ENCODE path (it builds ctx), this file asserts it through the DECODE path.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM e2e-web-session:
 * the session suite proves the key schedule is right given a context. This one
 * proves the CONTEXT is right given a wire frame, and that is the failure A3
 * was raised for: both sides can have a flawless key schedule and still derive
 * different keys forever because they disagreed about four fields. A test that
 * builds the context locally on both sides cannot see that class of bug at all
 * — it is exactly what the two loopbacks were blind to (gap c3).
 *
 * THE ONE ASSERTION THAT MATTERS, stated plainly: wire ctx + LOCAL userId must
 * reproduce the frozen contextBytesHex BYTE FOR BYTE. If it does, the phone and
 * the browser cannot disagree. If it does not, every sealed frame fails
 * authentication while both sides log success.
 */

import { createRequire } from 'node:module';

import { readAcceptBlock } from '../hooks/phoneE2e.ts';
import {
  pairContextFromWire,
  pairContext,
  toHex,
  fromHex,
  trafficKeys,
  aad as buildAad,
  nonce as buildNonce,
  DIR_P2C,
  PAIR_EPOCH_WIRE_RE,
  MAX_UINT64,
} from '../lib/e2e/kdf.mjs';
import { deriveNoncePrefixes } from '../lib/e2e/session.mjs';

const require = createRequire(import.meta.url);
const V = require('../tests/kdf-vectors.json');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function show(v) {
  return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
}
function eq(name, got, want) {
  check(name, got === want, `got ${show(got)} want ${show(want)}`);
}
async function throws(name, fn, predicate) {
  try {
    await fn();
  } catch (e) {
    check(name, predicate ? predicate(e) : true, `threw ${e?.name}: ${e?.message}`);
    return;
  }
  check(name, false, 'did not throw');
}

const I = V.ctxWire;
const OWN_DEVICE_ID = I.positiveI1.ctxWire.peerDeviceId;   // 'dev-web-01' — us
const OWN_PAIRING_ID = I.positiveI1.ctxWire.pairingId;
const LOCAL_USER_ID = I.positiveI1.localUserId;

// ---------------------------------------------------------------------------
// A real accept block, shaped exactly as one arrives on PAIRING_ACTIVE.
// Built from the frozen vector's own ctx so nothing here can drift from it.
// ---------------------------------------------------------------------------
// A REAL 65-byte SEC1 point, base64url, 87 chars. hooks/phoneE2e.isPinned
// decodes it and requires the 0x04 prefix, so a string of filler is rejected —
// which is correct of it, and worth knowing before the next person writes one.
const PIN = (() => {
  const pt = new Uint8Array(65);
  pt[0] = 0x04;
  for (let i = 1; i < 65; i += 1) pt[i] = i;
  return Buffer.from(pt).toString('base64url');
})();

function acceptFrame(overrides = {}) {
  const { ctx, ...rest } = overrides;
  const frame = {
    v: 1,
    mode: 1,
    kid: V.aead.vectorF.kid,
    epk: PIN,
    recipKeys: [PIN],
    wraps: [{ deviceId: OWN_DEVICE_ID, wrap: 'd2hhdGV2ZXI' }],
    ...rest,
  };
  if (!('ctx' in overrides) || ctx !== undefined) {
    frame.ctx = 'ctx' in overrides ? ctx : { ...I.positiveI1.ctxWire };
  }
  return frame;
}

// ── 0. readAcceptBlock CARRIES ctx, and carries it UNTOUCHED ────────────────
//
// This is the half of the path that is easy to get silently wrong: the block
// parser is an allowlist, so a ctx it does not name is dropped exactly the way
// PAIR_STATE dropped it before P1.1's A3-M1 splice — and the symptom would be
// "mode ON never pairs", three layers away from the cause.
{
  const block = readAcceptBlock(acceptFrame());
  check('block: a well-formed accept parses', block !== null);
  check('block: ctx survives the parser', block.ctx !== undefined && block.ctx !== null);
  eq('block: ctx is carried byte-for-byte, not normalised',
    JSON.stringify(block.ctx), JSON.stringify(I.positiveI1.ctxWire));
  eq('block: pairEpoch is still the STRING "42", not a number',
    typeof block.ctx.pairEpoch, 'string');

  // A HOSTILE ctx must also traverse the parser unchanged and be refused LATER,
  // by the one function that owns the rules. A parser that quietly repaired a
  // bad epoch here would be the second opinion A3 exists to prevent.
  const hostile = readAcceptBlock(acceptFrame({ ctx: { ...I.positiveI1.ctxWire, pairEpoch: 42 } }));
  eq('block: a NUMERIC epoch traverses the parser unchanged (refused later)',
    typeof hostile.ctx.pairEpoch, 'number');

  const noCtx = readAcceptBlock(acceptFrame({ ctx: undefined }));
  check('block: a ctx-less block still parses (the refusal is A3-M4\'s, not the parser\'s)',
    noCtx !== null && noCtx.ctx === undefined);
}

// ── I.1 — the positive. The whole point of the vector. ─────────────────────
{
  const block = readAcceptBlock(acceptFrame());
  const ctx = pairContextFromWire(block.ctx, {
    userId: LOCAL_USER_ID,
    deviceId: OWN_DEVICE_ID,
    pairingId: OWN_PAIRING_ID,
  });

  eq('I.1: wire ctx + LOCAL userId == the frozen context, byte for byte',
    toHex(ctx.contextBytes), I.positiveI1.contextBytesHex);
  eq('I.1: and that is the file\'s own top-level contextBytesHex',
    toHex(ctx.contextBytes), V.contextBytesHex);
  eq('I.1: pairEpoch parsed as a BigInt', ctx.pairEpoch, 42n);
  eq('I.1: pairingId', ctx.pairingId, I.positiveI1.ctxWire.pairingId);
  eq('I.1: phoneDeviceId', ctx.phoneDeviceId, I.positiveI1.ctxWire.phoneDeviceId);

  // The context is not the claim — the KEYS are. Derive them through the real
  // traffic-key function and compare against Security's independent values.
  const SK = fromHex(V.traffic.sessionKeyHex);
  const keys = await trafficKeys({
    pairingId: ctx.pairingId, sessionKey: SK, context: ctx.contextBytes, role: 'computer',
  });
  // role 'computer' RECEIVES p2c, so recv is k_p2c and send is k_c2p.
  eq('I.1: k_p2c', toHex(keys.recv.rawBytes), I.positiveI1.phoneToComputerKeyHex);
  eq('I.1: k_c2p', toHex(keys.send.rawBytes), I.positiveI1.computerToPhoneKeyHex);

  const prefixes = await deriveNoncePrefixes({
    pairingId: ctx.pairingId, sessionKey: SK, context: ctx.contextBytes,
  });
  eq('I.1: np2c (A2 vector E, reached from the WIRE ctx)', toHex(prefixes.np2c), I.positiveI1.np2cHex);
  eq('I.1: nc2p (A2 vector E, reached from the WIRE ctx)', toHex(prefixes.nc2p), I.positiveI1.nc2pHex);

  // THE CLOSING ASSERTION: A2 vector F's ciphertext — sealed by Security's
  // independent implementation — opens under the key and prefix this lane just
  // derived from a wire frame, to A2's exact plaintext.
  const F = V.aead.vectorF;
  const key = await crypto.subtle.importKey(
    'raw', fromHex(I.positiveI1.phoneToComputerKeyHex), { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const opened = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: buildNonce(prefixes.np2c, F.seq),
      additionalData: buildAad({
        frameType: F.frameType, kid: F.kid, seq: F.seq,
        direction: DIR_P2C, pairEpoch: F.pairEpoch,
      }),
      tagLength: 128,
    },
    key,
    fromHex(F.ciphertextHex),
  ));
  eq('I.1: A2 vector F OPENS under the wire-derived key + prefix',
    toHex(opened), I.positiveI1.openedPlaintextHex);
}

// ── I.2 — epoch drift. The A3-M2 replay case, at the derivation level. ─────
//
// Note what this proves and what it does NOT. It proves an edited epoch yields
// a DIFFERENT key, so a replayed block cannot silently decrypt. It does not
// prove the replay is refused — nothing about a wrong key stops a counter from
// restarting at 0. That is A3-M2's floor, asserted in e2e-web-webkey.
{
  const drift = { ...I.positiveI1.ctxWire, pairEpoch: I.negativeI2EpochDrift.pairEpoch };
  const ctx = pairContextFromWire(drift, {
    userId: LOCAL_USER_ID, deviceId: OWN_DEVICE_ID, pairingId: OWN_PAIRING_ID,
  });
  eq('I.2: the context bytes end in 2b, not 2a',
    toHex(ctx.contextBytes), I.negativeI2EpochDrift.contextBytesHex);

  const SK = fromHex(V.traffic.sessionKeyHex);
  const keys = await trafficKeys({
    pairingId: ctx.pairingId, sessionKey: SK, context: ctx.contextBytes, role: 'computer',
  });
  eq('I.2: k_p2c diverges completely', toHex(keys.recv.rawBytes), I.negativeI2EpochDrift.phoneToComputerKeyHex);
  const prefixes = await deriveNoncePrefixes({
    pairingId: ctx.pairingId, sessionKey: SK, context: ctx.contextBytes,
  });
  eq('I.2: np2c diverges too', toHex(prefixes.np2c), I.negativeI2EpochDrift.np2cHex);

  // And vector F MUST FAIL AUTHENTICATION under it. The rejection is the test.
  const F = V.aead.vectorF;
  const key = await crypto.subtle.importKey(
    'raw', keys.recv.rawBytes, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  await throws('I.2: vector F does NOT open under the drifted epoch', async () => {
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildNonce(prefixes.np2c, F.seq),
        additionalData: buildAad({
          frameType: F.frameType, kid: F.kid, seq: F.seq,
          direction: DIR_P2C, pairEpoch: F.pairEpoch,
        }),
        tagLength: 128,
      },
      key,
      fromHex(F.ciphertextHex),
    );
  });
}

// ── I.3 — userId drift. Proves the UN-TRANSMITTED field is load-bearing. ───
//
// One character of difference in a value that never crosses the wire produces a
// completely different key. That is the fail-closed property A3 relies on when
// it declines to transmit userId: a relay cannot propose an identity, because
// each side derives under the one its own session cookie proves.
{
  const ctx = pairContextFromWire(I.positiveI1.ctxWire, {
    userId: I.negativeI3UserIdDrift.localUserId,   // ONE character different
    deviceId: OWN_DEVICE_ID, pairingId: OWN_PAIRING_ID,
  });
  const SK = fromHex(V.traffic.sessionKeyHex);
  const keys = await trafficKeys({
    pairingId: ctx.pairingId, sessionKey: SK, context: ctx.contextBytes, role: 'computer',
  });
  eq('I.3: a one-character userId difference changes k_p2c entirely',
    toHex(keys.recv.rawBytes), I.negativeI3UserIdDrift.phoneToComputerKeyHex);
  check('I.3: and it is not the I.1 key',
    toHex(keys.recv.rawBytes) !== I.positiveI1.phoneToComputerKeyHex);
}

// ── I.4 — parser negatives. All MUST refuse; none may coerce. ──────────────
const local = { userId: LOCAL_USER_ID, deviceId: OWN_DEVICE_ID, pairingId: OWN_PAIRING_ID };

for (const bad of I.negativeI4Parser.badPairEpoch) {
  await throws(
    `I.4: pairEpoch ${show(bad)} is REFUSED, never coerced`,
    () => pairContextFromWire({ ...I.positiveI1.ctxWire, pairEpoch: bad }, local),
  );
}
// The regex itself, stated as the contract the refusals rest on. Number() would
// happily turn every one of the strings above into an epoch.
for (const bad of ['042', ' 42', '-1', '4.2', '', '+42', '42 ', '0x2a']) {
  check(`I.4: the wire regex rejects ${show(bad)}`, !PAIR_EPOCH_WIRE_RE.test(bad));
}
check('I.4: and it ACCEPTS a bare "42" (the guard is not vacuous)', PAIR_EPOCH_WIRE_RE.test('42'));
check('I.4: and "0"', PAIR_EPOCH_WIRE_RE.test('0'));

{
  const { pairEpoch: _dropped, ...noEpoch } = I.positiveI1.ctxWire;
  await throws('I.4: an ABSENT pairEpoch is refused', () => pairContextFromWire(noEpoch, local));
}
await throws('I.4: above 2^64-1 is refused',
  () => pairContextFromWire({ ...I.positiveI1.ctxWire, pairEpoch: (MAX_UINT64 + 1n).toString(10) }, local));
check('I.4: exactly 2^64-1 is accepted',
  pairContextFromWire({ ...I.positiveI1.ctxWire, pairEpoch: MAX_UINT64.toString(10) }, local).pairEpoch === MAX_UINT64);

// A3-M4 — mode=1 with NO ctx. Never derive-from-local.
await throws('A3-M4: an ABSENT ctx is refused (never derived from a local guess)',
  () => pairContextFromWire(undefined, local));
await throws('A3-M4: a NULL ctx is refused', () => pairContextFromWire(null, local));
await throws('A3-M4: a non-object ctx is refused', () => pairContextFromWire('ctx', local));
await throws('A3-M4: an ARRAY ctx is refused', () => pairContextFromWire([], local));
// Driven through the block path, which is how it actually arrives.
await throws('A3-M4: a mode=1 block carrying no ctx is refused at ingest', () => {
  const block = readAcceptBlock(acceptFrame({ ctx: undefined }));
  return pairContextFromWire(block.ctx, local);
});

// A3-M3 — own-identity checks. Refused by IDENTITY, not left to fail as a tag
// error later: "the frames do not decrypt" and "this block is not addressed to
// us" want different words in the log, and only one of them is actionable.
await throws('A3-M3: ctx.peerDeviceId that is not our deviceId is refused',
  () => pairContextFromWire(
    { ...I.positiveI1.ctxWire, peerDeviceId: I.negativeI4Parser.peerDeviceIdMismatch.ctxPeerDeviceId },
    local,
  ));
await throws('A3-M3: ctx.pairingId that is not our pairing is refused',
  () => pairContextFromWire(
    { ...I.positiveI1.ctxWire, pairingId: I.negativeI4Parser.pairingIdMismatch.ctxPairingId },
    local,
  ));
// ...and when we do NOT independently know the pairingId, the check is SKIPPED
// rather than compared against itself. A check that cannot fail is worse than
// no check, because it reads like one that can.
check('A3-M3: pairingId is not checked when we do not know it',
  pairContextFromWire(I.positiveI1.ctxWire, { userId: LOCAL_USER_ID, deviceId: OWN_DEVICE_ID, pairingId: null })
    .pairingId === OWN_PAIRING_ID);

// The LOCAL userId is required — never taken from the wire, never defaulted.
await throws('A3: a missing local userId is refused',
  () => pairContextFromWire(I.positiveI1.ctxWire, { deviceId: OWN_DEVICE_ID }));
await throws('A3: an empty local userId is refused',
  () => pairContextFromWire(I.positiveI1.ctxWire, { userId: '', deviceId: OWN_DEVICE_ID }));
// A userId ON THE WIRE must not be honoured. This is the one that would look
// harmless in review: it changes nothing observable until a relay uses it.
{
  const smuggled = { ...I.positiveI1.ctxWire, userId: 'user-attacker' };
  const ctx = pairContextFromWire(smuggled, local);
  eq('A3: a userId SMUGGLED onto the wire ctx is ignored — the session one wins',
    toHex(ctx.contextBytes), I.positiveI1.contextBytesHex);
}

// A1's 255-byte id limit, re-asserted on the DECODE side: an oversized id from
// the wire must be refused, not truncated to `len & 0xff`.
for (const field of I.negativeI4Parser.oversizeFields) {
  const over = 'x'.repeat(I.negativeI4Parser.oversizeFieldBytes);
  if (field === 'userId') {
    await throws('I.4: an oversize LOCAL userId is refused',
      () => pairContextFromWire(I.positiveI1.ctxWire, { ...local, userId: over }));
  } else {
    await throws(`I.4: an oversize ctx.${field} is refused`,
      () => pairContextFromWire(
        { ...I.positiveI1.ctxWire, [field]: over },
        // deviceId/pairingId expectations relaxed so the LENGTH is what fires,
        // not A3-M3 — otherwise this would pass for the wrong reason.
        { userId: LOCAL_USER_ID },
      ));
  }
}

// ── the encode/decode agreement, stated once ───────────────────────────────
// pairContextFromWire MUST produce what pairContext produces. They are one
// function in the frozen module; if a future edit forks them, this fails.
{
  const wire = pairContextFromWire(I.positiveI1.ctxWire, local);
  const localBuilt = pairContext({
    userId: LOCAL_USER_ID,
    phoneDeviceId: I.positiveI1.ctxWire.phoneDeviceId,
    peerDeviceId: I.positiveI1.ctxWire.peerDeviceId,
    pairEpoch: 42n,
  });
  eq('encode==decode: the wire path and the local encoder agree byte for byte',
    toHex(wire.contextBytes), toHex(localBuilt));
}

const total = passed + failed;
console.log(`e2e-web-ctx: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
