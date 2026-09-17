#!/usr/bin/env node
/**
 * tests/e2e-web-ctx-a4.test.mjs — GATE1 Addendum A4 (RATIFIED (1) AMENDED,
 * 2026-09-17T20:58Z), vector J, through the WEB DECODE path.
 *
 * A4's assertion split is what makes J cross-implementation rather than two
 * copies of one belief:
 *   P4  asserts J.1 + J.3's canonical selection through its ENCODE path
 *   P2  (this file) asserts J.1 / J.1b / J.1c / J.3 / J.5 through DECODE,
 *       holding the full wraps[]
 *   P3  asserts J.1 / J.1b / J.4 through PAIR_STATE WITHOUT the deviceId set,
 *       proving (c) is correctly SKIPPED there and (b) correctly binds
 *
 * Every expected byte below is Security's, computed in a clean-room HKDF/GCM
 * implementation that imports nothing from lib/e2e/kdf.mjs
 * (security/PROJECTS/computercaller/e2e/a4-vectors-verify.mjs). Nothing here
 * recomputes an expectation.
 *
 * THE POINT OF A4, in one line: there is ONE ctx, ONE pairContext, ONE traffic
 * key set and ONE nonce-prefix pair per pairing, shared by every recipient.
 * Per-recipient separation lives in the KEK, which binds each recipient's own
 * static key on top of the shared context. J.1b and J.1c are the two halves of
 * that and they must both hold, or the design is wrong in one direction or the
 * other.
 *
 * NOTE ON WHERE J LIVES: vector J is frozen into tests/kdf-vectors.json by
 * Ken's P1.2 (together with A4-M1's change to pairContextFromWire). That file
 * is P0.2-frozen and this lane does not own it — adding J here would be the
 * duplicate-under-a-second-spelling mistake this lane already had to undo once
 * during the rebase. So the values are INLINE, sourced from the addendum text,
 * and this file is to be re-pointed at kdf-vectors.json the moment P1.2 lands.
 * That is flagged in the résumé, not buried.
 */

import { createRequire } from 'node:module';

import {
  resolvePairContextA4,
  canonicalPeerDeviceId,
  compareUtf8,
  PairCtxRefused,
} from '../lib/e2e/pairCtxA4.ts';
import {
  pairContextFromWire,
  toHex,
  fromHex,
  trafficKeys,
  kek,
  be64,
  concatBytes,
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
function show(v) { return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v); }
function eq(name, got, want) { check(name, got === want, `got ${show(got)} want ${show(want)}`); }
async function throws(name, fn, predicate) {
  try { await fn(); } catch (e) {
    check(name, predicate ? predicate(e) : true, `threw ${e?.name}: ${e?.message}`);
    return;
  }
  check(name, false, 'did not throw');
}

// ── A4 vector J fixtures, continuing A3's, so J composes with E–H and I ─────
const PAIRING_ID = 'pair-7f3a9c21';
const LOCAL_USER_ID = 'user-0191aa';
const SK = fromHex(V.traffic.sessionKeyHex);

// Deliberately ordered so the canonical lowest is NOT first in array order.
const WRAPS = [{ deviceId: 'dev-web-01' }, { deviceId: 'dev-ext-02' }];
const CANONICAL = 'dev-ext-02';

const J = {
  ctxWire: {
    pairingId: PAIRING_ID,
    phoneDeviceId: 'dev-phone-01',
    peerDeviceId: CANONICAL,
    pairEpoch: '42',
  },
  contextBytesHex: '110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d6578742d303214000000000000002a',
  kP2c: '01de194d76408bb67774e73b673a4153b4bfcda2eff1b183ddb4a13a60e6e0f9',
  kC2p: '84217963288dbd103a6720a5f94c4e7403e02bebd21212d6ba64a2fe364b3021',
  np2c: 'bb33f7f1',
  nc2p: '17d7abbc',
  // J.1b — ONE broadcast ciphertext, empty AAD, nonce = np2c ‖ be64(1)
  broadcastCiphertext: '5967c31e987e458d11cd13edfe0f899382d9ee35787565d08ac83ea1',
  broadcastPlaintext: 'a4-broadcast',
  // J.1c — per-recipient KEKs from fixed P-256 scalars 1 and 2
  kWeb: '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
  kExt: '047cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1',
  kekWeb: '91bda28813f03d61302f75a40027d259983299f9b200f8f38304e7440fa17bea',
  kekExt: '2ebed4a09e5a79706646d4b1a56f96824b405291fe1021498cf38d5327488607',
  // J.3 — steered to a non-canonical peer
  steeredPeer: 'dev-web-01',
  steeredContextHex: '110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d7765622d303114000000000000002a',
  steeredKP2c: 'b12f964e487f7bf39a0b37df9715ca9e606c642c28bdf430f51b2051a4e0e060',
};

// ── A4-R2: the canonical peer rule ─────────────────────────────────────────
eq('A4-R2: canonical peer of wraps[] is the byte-wise lowest', canonicalPeerDeviceId(WRAPS), CANONICAL);
// The set is deliberately NOT in sorted order, so a "take wraps[0]" bug fails here.
eq('A4-R2: ...and the lowest is NOT first in array order', WRAPS[0].deviceId, 'dev-web-01');
eq('A4-R2: order-independent', canonicalPeerDeviceId([...WRAPS].reverse()), CANONICAL);
check('A4-R2: byte-wise comparison, not localeCompare', compareUtf8('dev-ext-02', 'dev-web-01') < 0);
// The rule says RAW UTF-8 BYTES. For the relay charset UTF-16 order agrees, so
// a `<` implementation passes every test in this repo — this is the case that
// separates them, and it is why compareUtf8 encodes rather than compares.
check('A4-R2: byte order differs from UTF-16 order where it can (non-BMP vs U+FF21)',
  compareUtf8('\u{1D400}', 'Ａ') > 0 && '\u{1D400}' < 'Ａ');
await throws('A4-R2: an empty wraps[] cannot yield a canonical peer', () => canonicalPeerDeviceId([]));

// ── J.1 — one ctx, one key set, shared by every recipient ──────────────────
{
  const ctx = resolvePairContextA4({
    ctxWire: J.ctxWire, userId: LOCAL_USER_ID, pairingId: PAIRING_ID, wraps: WRAPS,
  });
  eq('J.1: contextBytes', toHex(ctx.contextBytes), J.contextBytesHex);
  eq('J.1: the canonical peer we verified against', ctx.canonicalPeerDeviceId, CANONICAL);
  eq('J.1: pairEpoch is a BigInt', ctx.pairEpoch, 42n);

  const keys = await trafficKeys({
    pairingId: PAIRING_ID, sessionKey: SK, context: ctx.contextBytes, role: 'computer',
  });
  eq('J.1: k_p2c', toHex(keys.recv.rawBytes), J.kP2c);
  eq('J.1: k_c2p', toHex(keys.send.rawBytes), J.kC2p);

  const pre = await deriveNoncePrefixes({ pairingId: PAIRING_ID, sessionKey: SK, context: ctx.contextBytes });
  eq('J.1: np2c', toHex(pre.np2c), J.np2c);
  eq('J.1: nc2p', toHex(pre.nc2p), J.nc2p);

  // The SW derives from the SAME ctx with NO wraps[] — (c) skipped, per A4-R3.
  // Asserted EQUAL, not merely "both present": that identity is the ruling.
  const swCtx = resolvePairContextA4({
    ctxWire: J.ctxWire, userId: LOCAL_USER_ID, pairingId: null, wraps: undefined,
  });
  eq('J.1: the SW path (no wraps[], (c) SKIPPED) derives IDENTICAL context bytes',
    toHex(swCtx.contextBytes), toHex(ctx.contextBytes));

  // ── J.1b — ONE broadcast ciphertext opens for BOTH recipients ───────────
  // This is the property device-scoped ctx (option 2) would have destroyed:
  // sealed phone frames are one ciphertext broadcast byte-identically to every
  // listener, so a per-recipient key would open for exactly one of them and
  // hand the other a GCM tag failure indistinguishable from a network fault.
  const key = await crypto.subtle.importKey('raw', fromHex(J.kP2c), { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = concatBytes([fromHex(J.np2c), be64(1n)]);
  for (const who of ['page', 'sw']) {
    const opened = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new Uint8Array(0), tagLength: 128 },
      key, fromHex(J.broadcastCiphertext),
    ));
    eq(`J.1b: the ONE broadcast ciphertext opens for the ${who}`,
      new TextDecoder().decode(opened), J.broadcastPlaintext);
  }

  // ── J.1c — per-recipient KEKs DIFFER from the same ctx ──────────────────
  // Where separation actually lives. If these were equal, one recipient could
  // open another's wrap and the multi-recipient design would be decorative.
  const kekWeb = await kek({
    pairingId: PAIRING_ID, sharedSecret: SK, context: ctx.contextBytes, recipientKey: fromHex(J.kWeb),
  });
  const kekExt = await kek({
    pairingId: PAIRING_ID, sharedSecret: SK, context: ctx.contextBytes, recipientKey: fromHex(J.kExt),
  });
  eq('J.1c: KEK_web', toHex(kekWeb), J.kekWeb);
  eq('J.1c: KEK_ext', toHex(kekExt), J.kekExt);
  check('J.1c: the two KEKs DIFFER from one shared context', toHex(kekWeb) !== toHex(kekExt));
}

// ── J.2 — refusal (a): pairingId ───────────────────────────────────────────
await throws('J.2: a ctx.pairingId we are not party to is refused at ingest',
  () => resolvePairContextA4({
    ctxWire: { ...J.ctxWire, pairingId: 'pair-DEADBEEF' },
    userId: LOCAL_USER_ID, pairingId: PAIRING_ID, wraps: WRAPS,
  }),
  (e) => e instanceof PairCtxRefused);

// ── J.3 — refusal (c): relay steering to a non-canonical peer ─────────────
{
  const steered = { ...J.ctxWire, peerDeviceId: J.steeredPeer };
  await throws('J.3: a steered (non-canonical) peer is REFUSED before deriving',
    () => resolvePairContextA4({
      ctxWire: steered, userId: LOCAL_USER_ID, pairingId: PAIRING_ID, wraps: WRAPS,
    }),
    (e) => e instanceof PairCtxRefused && e.rule === 'c');

  // A receiver WITHOUT wraps[] (the SW) must NOT attempt (c) — so the same
  // steered ctx is admitted there and caught by (b), the unwrap, instead.
  const swSteered = resolvePairContextA4({
    ctxWire: steered, userId: LOCAL_USER_ID, pairingId: null, wraps: undefined,
  });
  eq('J.3: without wraps[], (c) is SKIPPED (A4-R3) and the steered ctx parses',
    toHex(swSteered.contextBytes), J.steeredContextHex);

  const keys = await trafficKeys({
    pairingId: PAIRING_ID, sessionKey: SK, context: swSteered.contextBytes, role: 'computer',
  });
  eq('J.3: the steered context derives a DIFFERENT k_p2c', toHex(keys.recv.rawBytes), J.steeredKP2c);

  // THE CROSS-CHECK WORTH KEEPING: that steered k_p2c is byte-identical to A3
  // vector I.1's frozen traffic.phoneToComputerKeyHex — independent
  // confirmation across two clean-room implementations that the
  // SINGLE-recipient path (dev-web-01 alone -> canonical = itself) is UNCHANGED
  // by A4. This is what makes "single-recipient sealing continues under A3
  // unchanged" a proof rather than a hope.
  eq('J.3: and it EQUALS A3 vector I.1 — A4 rekeys nothing already shipped',
    toHex(keys.recv.rawBytes), V.traffic.phoneToComputerKeyHex);

  // J.1b's ciphertext MUST FAIL under the steered key. The rejection is the test.
  const badKey = await crypto.subtle.importKey('raw', keys.recv.rawBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  await throws('J.3: the broadcast ciphertext does NOT open under the steered key', async () => {
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: concatBytes([fromHex(J.np2c), be64(1n)]), additionalData: new Uint8Array(0), tagLength: 128 },
      badKey, fromHex(J.broadcastCiphertext),
    );
  });
}

// ── J.5 — THE REGRESSION THIS ADDENDUM IS REALLY FOR ──────────────────────
//
// The pre-A4 check ("ctx.peerDeviceId !== own deviceId -> refuse") applied to
// J.1 refuses dev-web-01 while ADMITTING dev-ext-02 — i.e. it makes
// multi-recipient pairing impossible for every recipient but the canonical one.
// A4 requires that assertion to exist and to be pinned.
{
  // 1. The deleted clause, still live in the FROZEN shared module, reproduced
  //    exactly. This is the bug, demonstrated rather than described.
  await throws('J.5: pre-A4 kdf.pairContextFromWire REFUSES the non-canonical recipient',
    () => pairContextFromWire(J.ctxWire, {
      userId: LOCAL_USER_ID, deviceId: 'dev-web-01', pairingId: PAIRING_ID,
    }));
  check('J.5: ...while ADMITTING the canonical one — the asymmetry IS the defect',
    pairContextFromWire(J.ctxWire, {
      userId: LOCAL_USER_ID, deviceId: 'dev-ext-02', pairingId: PAIRING_ID,
    }).peerDeviceId === CANONICAL);

  // 2. And this lane's A4 resolver admits BOTH, which is the fix.
  for (const who of ['dev-web-01', 'dev-ext-02']) {
    const ctx = resolvePairContextA4({
      ctxWire: J.ctxWire, userId: LOCAL_USER_ID, pairingId: PAIRING_ID, wraps: WRAPS,
    });
    eq(`J.5: under A4 the recipient ${who} derives the ONE shared context`,
      toHex(ctx.contextBytes), J.contextBytesHex);
  }
}

// PENDING P1.2 — kdf.mjs still carries the clause A4-M1 deletes. That is Ken's
// follow-up, not this lane's: kdf.mjs is P0.2-frozen and vendored by three
// lanes. J.5 above PINS the current behaviour, so when P1.2 lands those two
// assertions are the ones that flip, and they say so in their names.
console.log('  NOTE  A4-M1 (delete the own-deviceId clause in lib/e2e/kdf.mjs:305-307) is');
console.log('        PENDING Ken\'s P1.2, together with vector J frozen into');
console.log('        tests/kdf-vectors.json. This lane applies A4 locally behind ONE');
console.log('        function (lib/e2e/pairCtxA4.ts) and calls the frozen module with');
console.log('        deviceId:null so the doomed clause is unreachable. When P1.2 lands:');
console.log('        re-point this file at kdf-vectors.json and delete the local rule.');

const total = passed + failed;
console.log(`e2e-web-ctx-a4: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
