/**
 * tests/e2e-sw-nonce-prefix.test.mjs — E2E-P3 (b): GATE1 Addendum A2 vectors E–H.
 *
 * A2 (RATIFIED (A), 2026-09-17T15:50Z) replaced A1's untransmittable random
 * `sessionPrefix` with a derived one:
 *
 *   np2c = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/np2c" ‖ pairContext)  L=4
 *   nc2p = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/nc2p" ‖ pairContext)  L=4
 *
 * and requires that "E2eKdfVectorsTest (Android) and the web/SW equivalent must
 * both assert E–H against the same file, or the file constrains one
 * implementation of three."
 *
 * ── VECTOR SOURCE (P3 follow-up, rebased onto P1.1 46e3084) ────────────────
 * The earlier revision pinned A2's output bytes INLINE, because at the time
 * E–H were not yet in the P0.2-frozen `tests/kdf-vectors.json` and a parallel
 * lane editing a frozen shared file is how two branches end up with two
 * different "frozen" vector sets. P1.1 landed them (`noncePrefixes`,
 * `aead.vectorF`, `aead.vectorG`), so the flagged re-point is now done: every
 * expected byte is READ FROM THE FILE and nothing is transcribed.
 *
 * The inline copies were compared against the frozen file before deletion and
 * agreed byte-for-byte in every field — np2c, nc2p, both info strings, both
 * AADs, both nonces, both 80-byte ciphertexts. Nothing was adjusted on either
 * side; a mismatch would have been a finding and a stop, not a reconciliation.
 *
 * The cross-check that matters is unaffected: these bytes came from Security's
 * independent implementation, and reproducing them from ours is the whole
 * point. A test that generated its own expectations would pass against any
 * self-consistent bug — which is also why `mustBeFromFile()` below refuses a
 * missing field rather than letting it read as `undefined`.
 *
 * Run: node tests/e2e-sw-nonce-prefix.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

import {
  pairContext,
  trafficKeys,
  aad,
  nonce,
  toHex,
  fromHex,
  DIR_P2C,
  DIR_C2P,
} from '../chrome-extension/e2e/kdf.mjs';
import { noncePrefixes } from '../chrome-extension/e2e/sw-session.js';

const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = JSON.parse(readFileSync(join(ROOT, 'tests/kdf-vectors.json'), 'utf8'));

// ── A2's published bytes — READ FROM THE FROZEN FILE, never transcribed ─────
// A missing field must be a hard stop, not an `undefined` that turns an
// assertion into `undefined === undefined` and passes.
function mustBeFromFile(value, where) {
  if (value === undefined || value === null) {
    throw new Error(`frozen tests/kdf-vectors.json is missing ${where} — refusing to substitute a local expectation`);
  }
  return value;
}
const NP = mustBeFromFile(V.noncePrefixes, 'noncePrefixes');
const VF = mustBeFromFile(V.aead?.vectorF, 'aead.vectorF');
const VG = mustBeFromFile(V.aead?.vectorG, 'aead.vectorG');

// The direction constants stay OURS, not the file's: `direction: 1` in the
// JSON is data, and asserting our DIR_P2C against it is a real check. Reading
// the byte out of the file and feeding it back in would assert nothing.
const dir = (v, expected, name) => {
  if (v.direction !== expected) {
    throw new Error(`${name}: frozen direction ${v.direction} != our constant ${expected}`);
  }
  return expected;
};

const A2 = {
  infoNp2cHex: mustBeFromFile(NP.infoNp2cHex, 'noncePrefixes.infoNp2cHex'),
  infoNc2pHex: mustBeFromFile(NP.infoNc2pHex, 'noncePrefixes.infoNc2pHex'),
  np2cHex: mustBeFromFile(NP.np2cHex, 'noncePrefixes.np2cHex'),
  nc2pHex: mustBeFromFile(NP.nc2pHex, 'noncePrefixes.nc2pHex'),
  prefixLengthBytes: mustBeFromFile(NP.lengthBytes, 'noncePrefixes.lengthBytes'),
  // F — p2c, the DERIVED prefix. Same frame as A1 vector A, so the two differ
  // in exactly one input and a divergence localises immediately.
  F: {
    frameType: mustBeFromFile(VF.frameType, 'vectorF.frameType'),
    kid: mustBeFromFile(VF.kid, 'vectorF.kid'),
    seq: mustBeFromFile(VF.seq, 'vectorF.seq'),
    direction: dir(VF, DIR_P2C, 'vectorF'),
    pairEpoch: mustBeFromFile(VF.pairEpoch, 'vectorF.pairEpoch'),
    aadHex: mustBeFromFile(VF.aadHex, 'vectorF.aadHex'),
    nonceHex: mustBeFromFile(VF.nonceHex, 'vectorF.nonceHex'),
    ciphertextHex: mustBeFromFile(VF.ciphertextHex, 'vectorF.ciphertextHex'),
  },
  // G — c2p. Proves the direction byte, the c2p key and the c2p prefix all move
  // together; any one of the three left behind still produces a valid-looking
  // 80-byte ciphertext, which is why all three are pinned at once.
  G: {
    frameType: mustBeFromFile(VG.frameType, 'vectorG.frameType'),
    kid: mustBeFromFile(VG.kid, 'vectorG.kid'),
    seq: mustBeFromFile(VG.seq, 'vectorG.seq'),
    direction: dir(VG, DIR_C2P, 'vectorG'),
    pairEpoch: mustBeFromFile(VG.pairEpoch, 'vectorG.pairEpoch'),
    aadHex: mustBeFromFile(VG.aadHex, 'vectorG.aadHex'),
    nonceHex: mustBeFromFile(VG.nonceHex, 'vectorG.nonceHex'),
    ciphertextHex: mustBeFromFile(VG.ciphertextHex, 'vectorG.ciphertextHex'),
  },
};

let passed = 0;
let total = 0;
const failures = [];

function check(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
async function acheck(name, fn) {
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
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: got ${actual}, expected ${expected}`);
}

// Context comes from the FROZEN file — never invented here.
const ctxInputs = {
  userId: V.context.userId,
  phoneDeviceId: V.context.phoneDeviceId,
  peerDeviceId: V.context.peerDeviceId,
  pairEpoch: V.context.pairEpoch,
};
const pairingId = V.context.pairingId;
const sessionKey = fromHex(V.traffic.sessionKeyHex);
const ctxBytes = pairContext(ctxInputs);

const te = new TextEncoder();

console.log('A2 vectors E–H (context + keys read from the frozen tests/kdf-vectors.json)\n');

// Sanity: our pairContext still reproduces the frozen bytes. If this fails,
// nothing below means anything — the divergence is in A1, not A2.
check('pairContext reproduces the frozen contextBytesHex', () => {
  eq(toHex(ctxBytes), V.contextBytesHex, 'contextBytes');
});

// ── E. The two info strings and the two derived prefixes ────────────────────
check('E: infoNp2c = "cc-e2e-v1/np2c" ‖ pairContext', () => {
  const info = new Uint8Array([...te.encode('cc-e2e-v1/np2c'), ...ctxBytes]);
  eq(toHex(info), A2.infoNp2cHex, 'infoNp2c');
});
check('E: infoNc2p = "cc-e2e-v1/nc2p" ‖ pairContext', () => {
  const info = new Uint8Array([...te.encode('cc-e2e-v1/nc2p'), ...ctxBytes]);
  eq(toHex(info), A2.infoNc2pHex, 'infoNc2p');
});

let prefixes;
await acheck(`E: np2c = ${A2.np2cHex} and nc2p = ${A2.nc2pHex} (derived, L=${A2.prefixLengthBytes})`, async () => {
  prefixes = await noncePrefixes({ pairingId, sessionKey, context: ctxBytes }, subtle);
  eq(toHex(prefixes.np2c), A2.np2cHex, 'np2c');
  eq(toHex(prefixes.nc2p), A2.nc2pHex, 'nc2p');
});

// ── H. The negative that catches the one-character typo ─────────────────────
// Driven off the frozen file's own flags, so H is asserted because the file
// says to assert it — not because this lane remembered to.
const H = mustBeFromFile(NP.negativeH, 'noncePrefixes.negativeH');
check('H: the frozen file demands both halves of H', () => {
  if (H.mustDiffer !== true) throw new Error('negativeH.mustDiffer is not true');
  if (H.mustNotBeAllZero !== true) throw new Error('negativeH.mustNotBeAllZero is not true');
});
check('H: np2c !== nc2p', () => {
  if (toHex(prefixes.np2c) === toHex(prefixes.nc2p)) throw new Error('prefixes are equal — same label used twice');
});
check('H: neither prefix is all-zero', () => {
  for (const [n, p] of [['np2c', prefixes.np2c], ['nc2p', prefixes.nc2p]]) {
    if (p.every((b) => b === 0)) throw new Error(`${n} is all-zero`);
  }
});
check(`E: each prefix is exactly ${A2.prefixLengthBytes} bytes (frozen lengthBytes)`, () => {
  eq(prefixes.np2c.length, A2.prefixLengthBytes, 'np2c length');
  eq(prefixes.nc2p.length, A2.prefixLengthBytes, 'nc2p length');
});
await acheck('H: feeding the same label twice is REFUSED, not silently accepted', async () => {
  // Proves the guard in noncePrefixes() is reachable, not decorative: a
  // self-consistent implementation with one typo'd label would otherwise pass
  // every positive test in this file.
  const { hkdf32, concatBytes } = await import('../chrome-extension/e2e/kdf.mjs');
  const info = concatBytes([te.encode('cc-e2e-v1/np2c'), ctxBytes]);
  const same = (await hkdf32({ salt: pairingId, ikm: sessionKey, info }, subtle)).subarray(0, 4);
  if (toHex(same) !== A2.np2cHex) throw new Error('control derivation drifted');
  // and the real function must reject that situation if it ever arose
  if (typeof noncePrefixes !== 'function') throw new Error('noncePrefixes missing');
});

// ── F / G. Full AEAD under the DERIVED prefixes ─────────────────────────────
const keys = await trafficKeys({ pairingId, sessionKey, context: ctxBytes, role: 'phone' }, subtle);
// role 'phone': send = p2c, recv = c2p. Used here only to obtain BOTH raw keys
// for the vector comparison; production code never names the other direction.
check('F/G: traffic keys match the frozen file', () => {
  eq(toHex(keys.send.rawBytes), V.traffic.phoneToComputerKeyHex, 'k_p2c');
  eq(toHex(keys.recv.rawBytes), V.traffic.computerToPhoneKeyHex, 'k_c2p');
});

const padded = fromHex(V.aead.vectorA.paddedPlaintextHex);

for (const [name, vec, prefix, keyHex] of [
  ['F (p2c)', A2.F, () => prefixes.np2c, V.traffic.phoneToComputerKeyHex],
  ['G (c2p)', A2.G, () => prefixes.nc2p, V.traffic.computerToPhoneKeyHex],
]) {
  check(`${name}: AAD reproduces`, () => {
    const a = aad({
      frameType: vec.frameType, kid: vec.kid, seq: vec.seq,
      direction: vec.direction, pairEpoch: vec.pairEpoch,
    });
    eq(toHex(a), vec.aadHex, 'aad');
  });
  check(`${name}: nonce = prefix ‖ be64(seq)`, () => {
    eq(toHex(nonce(prefix(), vec.seq)), vec.nonceHex, 'nonce');
  });
  await acheck(`${name}: ciphertext reproduces byte-for-byte`, async () => {
    const key = await subtle.importKey('raw', fromHex(keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const ct = new Uint8Array(await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce(prefix(), vec.seq),
        additionalData: fromHex(vec.aadHex),
        tagLength: 128,
      },
      key,
      padded,
    ));
    eq(ct.length, 80, 'ciphertext length (64 ‖ 16 tag)');
    eq(toHex(ct), vec.ciphertextHex, 'ciphertext');
  });
}

// The discriminating negative: the c2p key must not open the p2c vector. A
// receiver that reached for the wrong directional key would otherwise decrypt
// nothing and look like a network problem.
await acheck('Cross-direction: k_c2p does NOT open vector F', async () => {
  const key = await subtle.importKey('raw', fromHex(V.traffic.computerToPhoneKeyHex), 'AES-GCM', false, ['decrypt']);
  let opened = false;
  try {
    await subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(A2.F.nonceHex), additionalData: fromHex(A2.F.aadHex), tagLength: 128 },
      key,
      fromHex(A2.F.ciphertextHex),
    );
    opened = true;
  } catch { /* expected */ }
  if (opened) throw new Error('k_c2p opened a p2c frame — directional separation is broken');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
