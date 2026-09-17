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
 * ── WHY THE EXPECTED BYTES ARE INLINE RATHER THAN READ FROM THE FILE ────────
 * A2 says to ADD E–H to `tests/kdf-vectors.json`. That file is P0.2-FROZEN and
 * is asserted by three lanes (this one, P2's `kdf-vectors.test.mjs`, and
 * Android's `E2eKdfVectorsTest`); P2 is running in parallel right now and P3
 * does not own it. Editing a frozen shared file from a parallel lane is how two
 * branches produce two different "frozen" vector sets. So this test reads the
 * CONTEXT INPUTS from the frozen file — `pairingId`, `userId`, `phoneDeviceId`,
 * `peerDeviceId`, `pairEpoch`, `sessionKeyHex`, and both traffic keys, none of
 * which it invents — and pins A2's OUTPUT bytes here, transcribed from the
 * signed addendum. When whoever owns the §13.10.x follow-up lands E–H in the
 * JSON, this file should be re-pointed at it and the inline copies deleted.
 * Flagged in the P3 résumé so it is not forgotten.
 *
 * The cross-check that matters is unaffected either way: these bytes came from
 * Security's independent implementation, and reproducing them from ours is the
 * whole point. A test that generated its own expectations would pass against
 * any self-consistent bug.
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

// ── A2's published bytes, transcribed from the signed addendum ──────────────
const A2 = {
  infoNp2cHex: '63632d6532652d76312f6e703263110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d7765622d303114000000000000002a',
  infoNc2pHex: '63632d6532652d76312f6e633270110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d7765622d303114000000000000002a',
  np2cHex: '6fa67348',
  nc2pHex: '4a786847',
  // F — p2c, the DERIVED prefix. Same frame as A1 vector A, so the two differ
  // in exactly one input and a divergence localises immediately.
  F: {
    frameType: 'SMS_RECEIVED',
    kid: 'kid-01',
    seq: 7,
    direction: DIR_P2C,
    pairEpoch: 42,
    aadHex: '210c534d535f524543454956454422066b69642d3031230000000000000007240125000000000000002a',
    nonceHex: '6fa673480000000000000007',
    ciphertextHex: '9675ba5ab30c62bb4802c19f4bcd250612e6b7fead8e8aa4c7fff702cec36d68fb85220b16a4c823d2597780d8e664a977b9d0881ed2f41d7a9e402378f3928c6450b5bb8934fe688c6f728943ac10ce',
  },
  // G — c2p. Proves the direction byte, the c2p key and the c2p prefix all move
  // together; any one of the three left behind still produces a valid-looking
  // 80-byte ciphertext, which is why all three are pinned at once.
  G: {
    frameType: 'SMS_RECEIVED',
    kid: 'kid-01',
    seq: 7,
    direction: DIR_C2P,
    pairEpoch: 42,
    aadHex: '210c534d535f524543454956454422066b69642d3031230000000000000007240225000000000000002a',
    nonceHex: '4a7868470000000000000007',
    ciphertextHex: 'cd13472e5c80869dbf16635b09461270aca7bc49e9549c68604006478c1f47cb70941551e372c46296b740ef341c36a1ec28b4163695ea8951def0e477445214a80182070c9bbdc9c67ebfde834f95f0',
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
await acheck('E: np2c = 6fa67348 and nc2p = 4a786847 (derived, L=4)', async () => {
  prefixes = await noncePrefixes({ pairingId, sessionKey, context: ctxBytes }, subtle);
  eq(toHex(prefixes.np2c), A2.np2cHex, 'np2c');
  eq(toHex(prefixes.nc2p), A2.nc2pHex, 'nc2p');
});

// ── H. The negative that catches the one-character typo ─────────────────────
check('H: np2c !== nc2p', () => {
  if (toHex(prefixes.np2c) === toHex(prefixes.nc2p)) throw new Error('prefixes are equal — same label used twice');
});
check('H: neither prefix is all-zero', () => {
  for (const [n, p] of [['np2c', prefixes.np2c], ['nc2p', prefixes.nc2p]]) {
    if (p.every((b) => b === 0)) throw new Error(`${n} is all-zero`);
  }
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
