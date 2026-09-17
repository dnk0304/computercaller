#!/usr/bin/env node
/**
 * tests/e2e-web-ctx-a4.test.mjs — GATE1 Addendum A4 + vector K (COUNTERSIGNED),
 * asserted through the WEB (page) DECODE path.
 *
 * P1.2 landed A4 in the shared frozen module: `lib/e2e/kdf.mjs` now exports
 * `canonicalPeerDeviceId()` and `pairContextFromWire()` takes
 * `recipientDeviceIds` — with the "ctx.peerDeviceId must be my own deviceId"
 * clause DELETED. So the local copy this lane carried while the ruling was in
 * flight (`lib/e2e/pairCtxA4.ts`) is GONE, not kept as a second opinion: a
 * duplicated predicate is how A3 happened, and A4's whole point is one rule in
 * one place that three lanes assert against the same file.
 *
 * Every expected byte below is READ FROM tests/kdf-vectors.json, which is
 * frozen and countersigned. Nothing is inline, nothing is recomputed here —
 * which is the correction to the previous version of this file, where J was
 * inline because P1.2 had not yet frozen it.
 *
 * ── LANE SCOPE (A4-R3), and it is the reason this file asserts what it does ──
 * The PAGE holds the full `wraps[]` on ACCEPT_PAIRING / PAIRING_ACTIVE, so it
 * MUST run check (c) — the canonical-peer check. The extension SW receives
 * PAIR_STATE, which carries only its OWN wrap, so it MUST NOT run (c) and MUST
 * NOT substitute its own deviceId; for that lane the binding check is (b), the
 * cryptographic one (the wrap opens under KEK(ctx, own static key)). Both
 * behaviours are asserted here, because "the SW skips (c)" is a property of the
 * shared function and a page-lane test is where a regression would show.
 *
 * ── WHY K EXISTS AND WHY IT IS TWO VECTORS ─────────────────────────────────
 * Vector J's deviceIds are pure ASCII, where unsigned UTF-8 order, SIGNED byte
 * order and UTF-16 code-unit order ALL AGREE — so J cannot catch a wrong
 * comparator at all. K is the fixture where they disagree, and it takes two:
 *   K1 catches UTF-16 code-unit order (JS `<`, Kotlin String.minOrNull()).
 *      Signed-byte order picks the CORRECT id here, so K1 is vacuous for it.
 *   K2 catches signed-byte order (0xF0 -> -16 < 0x7A). UTF-16 picks the
 *      CORRECT id here, so K2 is vacuous for that.
 * The conditions are mutually exclusive at the same position, so neither vector
 * alone is sufficient — the file says so and this test asserts both, in BOTH
 * wraps[] orders, because selection must be order-independent.
 */

import { createRequire } from 'node:module';

import {
  pairContextFromWire,
  canonicalPeerDeviceId,
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

const SK = fromHex(V.traffic.sessionKeyHex);
const J = V.canonicalPeer;
const K = V.canonicalPeerByteOrder;
const PAIRING_ID = J.positiveJ1.ctxWire.pairingId;
const USER = J.localUserId;
const ids = (wraps) => wraps.map((w) => w.deviceId);

/** The page lane: holds wraps[], so (c) applies. */
const asPage = (ctxWire, wraps, pairingId = PAIRING_ID) =>
  pairContextFromWire(ctxWire, { userId: USER, pairingId, recipientDeviceIds: ids(wraps) });
/** The SW lane: no deviceId set, so (c) MUST be skipped. */
const asSw = (ctxWire) => pairContextFromWire(ctxWire, { userId: USER });

async function keysFor(contextBytes) {
  const t = await trafficKeys({ pairingId: PAIRING_ID, sessionKey: SK, context: contextBytes, role: 'computer' });
  const p = await deriveNoncePrefixes({ pairingId: PAIRING_ID, sessionKey: SK, context: contextBytes });
  // role 'computer' RECEIVES p2c and SENDS c2p.
  return { kP2c: toHex(t.recv.rawBytes), kC2p: toHex(t.send.rawBytes), np2c: toHex(p.np2c), nc2p: toHex(p.nc2p) };
}

// ── the deleted clause is really gone, and loudly ──────────────────────────
// A4-M1 required deletion, not relaxation. Passing `deviceId` must now be a
// hard error rather than silently ignored: a caller still passing it is a
// caller that believes a refusal is in force which no longer exists.
await throws('A4-M1: passing `deviceId` to pairContextFromWire THROWS (clause deleted, not relaxed)',
  () => pairContextFromWire(J.positiveJ1.ctxWire, { userId: USER, deviceId: 'dev-web-01' }),
  (e) => /deviceId. is not an input/.test(e.message));

// ── vector J ──────────────────────────────────────────────────────────────
eq('J: canonical peer of wraps[]', canonicalPeerDeviceId(ids(J.wraps)), J.canonicalPeerDeviceId);
eq('J: the canonical id is NOT first in array order (a wraps[0] bug would pass otherwise)',
  J.wraps[0].deviceId !== J.canonicalPeerDeviceId, true);
eq('J: selection is order-independent', canonicalPeerDeviceId([...ids(J.wraps)].reverse()), J.canonicalPeerDeviceId);
eq('J: the block shape [{deviceId}] is accepted too', canonicalPeerDeviceId(J.wraps), J.canonicalPeerDeviceId);

{
  const j1 = J.positiveJ1;
  const page = asPage(j1.ctxWire, J.wraps);
  eq('J.1: page contextBytes', toHex(page.contextBytes), j1.contextBytesHexPage);

  // A4-R3: the SW derives from the SAME ctx with NO deviceId set. Asserted
  // EQUAL, not merely both-present — that identity IS the ruling.
  const sw = asSw(j1.ctxWire);
  eq('J.1: SW contextBytes (no wraps[], (c) SKIPPED)', toHex(sw.contextBytes), j1.contextBytesHexSw);
  check('J.1: contextsIdentical', toHex(page.contextBytes) === toHex(sw.contextBytes) && j1.contextsIdentical);

  const k = await keysFor(page.contextBytes);
  eq('J.1: k_p2c', k.kP2c, j1.phoneToComputerKeyHex);
  eq('J.1: k_c2p', k.kC2p, j1.computerToPhoneKeyHex);
  eq('J.1: np2c', k.np2c, j1.np2cHex);
  eq('J.1: nc2p', k.nc2p, j1.nc2pHex);
  const kSw = await keysFor(sw.contextBytes);
  check('J.1: swKeysEqualPageKeys', kSw.kP2c === k.kP2c && kSw.kC2p === k.kC2p && j1.swKeysEqualPageKeys);

  // J.1b — ONE broadcast ciphertext opens for BOTH recipients. This is the
  // property a device-scoped ctx would have destroyed: sealed phone frames are
  // one ciphertext broadcast byte-identically to every listener, so per-
  // recipient keys would open for exactly one and hand the other a GCM tag
  // failure indistinguishable from a network fault.
  const b = J.positiveJ1bBroadcast;
  const aead = await crypto.subtle.importKey('raw', fromHex(j1.phoneToComputerKeyHex), { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = concatBytes([fromHex(j1.np2cHex), be64(BigInt(b.seq))]);
  for (const [who, want] of [['page', b.opensForPage], ['sw', b.opensForSw]]) {
    const out = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: fromHex(b.aadHex), tagLength: 128 },
      aead, fromHex(b.ciphertextHex),
    ));
    eq(`J.1b: the ONE broadcast ciphertext opens for the ${who}`, new TextDecoder().decode(out), want);
  }

  // J.1c — per-recipient KEKs DIFFER from that same shared ctx. Where the
  // separation actually lives. If these were equal, one recipient could open
  // another's wrap and the multi-recipient design would be decorative.
  const c = J.positiveJ1cKeks;
  const kekWeb = await kek({ pairingId: PAIRING_ID, sharedSecret: SK, context: page.contextBytes, recipientKey: fromHex(c.webKeyHex) });
  const kekExt = await kek({ pairingId: PAIRING_ID, sharedSecret: SK, context: page.contextBytes, recipientKey: fromHex(c.extKeyHex) });
  eq('J.1c: KEK_web', toHex(kekWeb), c.kekWebHex);
  eq('J.1c: KEK_ext', toHex(kekExt), c.kekExtHex);
  check('J.1c: keksDiffer', toHex(kekWeb) !== toHex(kekExt) && c.keksDiffer);
}

// J.2 — refusal (a)
await throws('J.2: a foreign ctx.pairingId is refused at ingest',
  () => asPage({ ...J.positiveJ1.ctxWire, pairingId: J.negativeJ2PairingId.ctxPairingId },
    J.wraps, J.negativeJ2PairingId.ownPairingId));

// J.3 — refusal (c): relay steering to a non-canonical peer
{
  const j3 = J.negativeJ3SteeredPeer;
  const steered = { ...J.positiveJ1.ctxWire, peerDeviceId: j3.ctxPeerDeviceId };
  await throws('J.3: the PAGE refuses a steered (non-canonical) peer BEFORE deriving',
    () => asPage(steered, J.wraps));
  // ...and the SW, which cannot see the set, correctly does NOT refuse here.
  // Its binding check is (b), the unwrap. Asserting this is what proves (c) is
  // genuinely lane-scoped rather than skipped by accident.
  const sw = asSw(steered);
  eq('J.3: the SW lane derives it (c SKIPPED) — (b) is its binding check',
    toHex(sw.contextBytes), j3.contextBytesHex);
}

// ── vector K — the comparator ─────────────────────────────────────────────
for (const [name, k] of [['K1', K.K1], ['K2', K.K2]]) {
  // BOTH orders: selection must be order-independent, so a relay re-ordering
  // wraps[] without editing it cannot steer the derivation.
  for (const [order, wraps] of [['A,B', k.wrapsOrderAB], ['B,A', k.wrapsOrderBA]]) {
    eq(`${name}: canonical peer with wraps[] in order ${order}`,
      canonicalPeerDeviceId(ids(wraps)), k.canonicalPeerDeviceId);
  }
  check(`${name}: orderIndependent`, k.orderIndependent === true);

  // The UTF-8 encodings are pinned too — if the fixture's ids ever lost their
  // non-ASCII characters (an editor "fixing" the file), the comparator test
  // would silently become another ASCII case that discriminates nothing.
  eq(`${name}: idA UTF-8 bytes`, toHex(new TextEncoder().encode(k.idA)), k.idAUtf8Hex);
  eq(`${name}: idB UTF-8 bytes`, toHex(new TextEncoder().encode(k.idB)), k.idBUtf8Hex);

  const pos = k.positiveK1_1 ?? k.positiveK2_1;
  const wraps = k.wrapsOrderAB;
  const ctxWire = { ...J.positiveJ1.ctxWire, peerDeviceId: pos.ctxPeerDeviceId };
  const page = asPage(ctxWire, wraps);
  eq(`${name}: contextBytes for the canonical peer`, toHex(page.contextBytes), pos.contextBytesHex);
  const keys = await keysFor(page.contextBytes);
  eq(`${name}: k_p2c`, keys.kP2c, pos.phoneToComputerKeyHex);
  eq(`${name}: k_c2p`, keys.kC2p, pos.computerToPhoneKeyHex);
  eq(`${name}: np2c`, keys.np2c, pos.np2cHex);
  eq(`${name}: nc2p`, keys.nc2p, pos.nc2pHex);

  // The negative: the id a WRONG comparator would choose. The page lane MUST
  // refuse it. The vector records the derived key precisely to show the failure
  // is SILENT without that refusal — the derivation succeeds, it is simply a
  // key nobody else holds.
  const neg = k.negativeK1_2Utf16Pick ?? k.negativeK2_3SignedPick;
  await throws(`${name}: the PAGE REFUSES the id a wrong comparator would pick (${neg.wrongCanonical})`,
    () => asPage({ ...J.positiveJ1.ctxWire, peerDeviceId: neg.wrongCanonical }, wraps));
  check(`${name}: pageLaneMustRefuse`, neg.pageLaneMustRefuse === true);
  // And that wrong pick really does derive a DIFFERENT, working key — so the
  // refusal is load-bearing rather than belt-and-braces over a failure that
  // would surface anyway.
  const wrongKeys = await keysFor(asSw({ ...J.positiveJ1.ctxWire, peerDeviceId: neg.wrongCanonical }).contextBytes);
  eq(`${name}: the wrong pick derives a different k_p2c (silent without (c))`,
    wrongKeys.kP2c, neg.phoneToComputerKeyHex);
  check(`${name}: differsFromCanonical`, wrongKeys.kP2c !== pos.phoneToComputerKeyHex && neg.differsFromCanonical);
}

// The vacuity notes are ASSERTED, not just read: each vector is non-discriminating
// for the OTHER bug, which is exactly why both are required. If someone deletes
// one of them, this is the line that should make the loss obvious.
check('K1 is vacuous for signed-byte order (so K2 is required)',
  K.K1.K1_3SignedIsVacuous.discriminating === false
  && K.K1.K1_3SignedIsVacuous.signedBytePick === K.K1.canonicalPeerDeviceId);
check('K2 is vacuous for UTF-16 order (so K1 is required)',
  K.K2.K2_2Utf16IsVacuous.discriminating === false
  && K.K2.K2_2Utf16IsVacuous.utf16Pick === K.K2.canonicalPeerDeviceId);

// And the comparator this lane runs is demonstrably neither wrong comparator:
// on K1's pair JS `<` picks the WRONG id, and on K2's pair a signed-byte
// comparison would. Proving the negative directly beats trusting the name.
check('K1: JS string `<` really does pick the WRONG id here (the bug is reachable)',
  (K.K1.idB < K.K1.idA) && K.K1.canonicalPeerDeviceId === K.K1.idA);
check('K2: signed-byte order really would pick the WRONG id here',
  (() => {
    const a = new TextEncoder().encode(K.K2.idA);
    const b = new TextEncoder().encode(K.K2.idB);
    // first differing byte, compared as SIGNED int8
    let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    const s = (x) => (x > 127 ? x - 256 : x);
    return s(b[i]) < s(a[i]) && K.K2.canonicalPeerDeviceId === K.K2.idA;
  })());

const total = passed + failed;
console.log(`e2e-web-ctx-a4: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
