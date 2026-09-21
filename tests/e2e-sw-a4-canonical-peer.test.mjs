/**
 * tests/e2e-sw-a4-canonical-peer.test.mjs — E2E-P3 next follow-up, A4.
 *
 * GATE1 Addendum A4 (RATIFIED (1) AMENDED, 2026-09-17T20:58Z) + vector K
 * (COUNTERSIGNED, 2026-09-17T19:07:20Z). P1.2 froze J, K1 and K2 into
 * `tests/kdf-vectors.json` and landed `canonicalPeerDeviceId()` plus the
 * re-scoped `pairContextFromWire()` in `lib/e2e/kdf.mjs`.
 *
 * WHAT THIS FILE ADDS THAT `tests/kdf-vectors.test.mjs` DOES NOT. That file
 * asserts the LIB copy. Chrome loads `chrome-extension/` and nothing above it,
 * so the service worker runs a VENDORED copy, and every import below is from
 * `chrome-extension/e2e/` deliberately. `tests/e2e-sw-vendor-drift.test.mjs`
 * proves the two files are byte-identical; this one proves the bytes the SW
 * actually runs reproduce the frozen vectors. A sha match with no vector
 * assertion would prove only that two files agree — including on being wrong.
 *
 * NOTHING BELOW IS TRANSCRIBED. Every expected value is read from the frozen
 * file. No value was adjusted in either direction while writing this: a
 * mismatch here is a FINDING, not a merge conflict.
 *
 * LANE SCOPE (A4-R3 / K.4). §13.10.9 assigns P3 J.1, J.1b and J.4 through the
 * `PAIR_STATE` path — WITHOUT the deviceId set — "proving (c) is correctly
 * skipped there and (b) correctly binds". `PAIR_STATE`'s allowlist carries
 * `wrap` SINGULAR, so the SW holds no `wraps[]` and MUST NOT attempt clause
 * (c), and MUST NOT substitute its own deviceId for the canonical peer. Both
 * halves are asserted: the skip, and that the check does fire on the lane that
 * CAN see the set — so "we did not implement it" and "the spec says not to"
 * cannot be confused.
 *
 * Run: node tests/e2e-sw-a4-canonical-peer.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const subtle = webcrypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = JSON.parse(readFileSync(join(ROOT, 'tests/kdf-vectors.json'), 'utf8').replace(/\r\n?/g, '\n'));

// THE VENDORED COPY — the bytes the MV3 service worker runs.
const K = await import('../chrome-extension/e2e/kdf.mjs');

let passed = 0;
let total = 0;
const failures = [];

async function check(name, fn) {
  total += 1;
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: got ${a}, expected ${b}`); }

/** A frozen field that is missing means the re-point silently lost a vector. */
function need(v, path) {
  if (v === undefined || v === null) throw new Error(`frozen file has no ${path} — nothing to assert against`);
  return v;
}

const J = need(V.canonicalPeer, 'canonicalPeer');
const KB = need(V.canonicalPeerByteOrder, 'canonicalPeerByteOrder');
const sessionKey = K.fromHex(V.traffic.sessionKeyHex);

console.log('A4 canonical peer — vectors J, K1, K2 through the VENDORED kdf\n');

// ── The selection rule itself (A4-R2) ───────────────────────────────────────

await check('J: canonicalPeerDeviceId picks the byte-wise lowest, NOT wraps[0]', async () => {
  // The frozen wraps[] are deliberately ordered so the canonical lowest is not
  // first: an implementation that returned wraps[0] would pass a same-order
  // fixture and ship the bug.
  eq(K.canonicalPeerDeviceId(J.wraps), J.canonicalPeerDeviceId, 'canonical peer');
  assert(J.wraps[0].deviceId !== J.canonicalPeerDeviceId, 'fixture is pointless if the lowest IS first');
  eq(K.canonicalPeerDeviceId([...J.wraps].reverse()), J.canonicalPeerDeviceId, 'canonical peer (reversed)');
  // Bare string form, the shape the SW's own tests use.
  eq(K.canonicalPeerDeviceId(J.wraps.map((w) => w.deviceId)), J.canonicalPeerDeviceId, 'canonical peer (bare ids)');
});

for (const [name, kv] of [['K1', KB.K1], ['K2', KB.K2]]) {
  await check(`${name}: canonical is order-independent and uses UNSIGNED UTF-8 bytes`, async () => {
    // K is where unsigned-UTF-8, signed-byte and UTF-16 orders DISAGREE. J
    // cannot catch a wrong comparator at all — all its ids are ASCII, where the
    // three agree. K1 catches UTF-16 (Kotlin String.minOrNull, JS `<`); K2
    // catches signed Byte. Neither alone is sufficient: Security's countersign
    // is explicit that K1 alone does NOT satisfy the requirement.
    eq(K.canonicalPeerDeviceId(kv.wrapsOrderAB), kv.canonicalPeerDeviceId, 'canonical (order A,B)');
    eq(K.canonicalPeerDeviceId(kv.wrapsOrderBA), kv.canonicalPeerDeviceId, 'canonical (order B,A)');
    eq(kv.orderIndependent, true, 'frozen file must claim order-independence');
    // The naive JS comparator, run here as the CONTROL. On K1 it disagrees with
    // the frozen answer; on K2 it agrees — which is exactly why K2 exists and
    // why this assertion is a comparison, not a blanket "must differ".
    const utf16Pick = [...kv.wrapsOrderAB].map((w) => w.deviceId).sort()[0];
    const discriminating = name === 'K1';
    eq(utf16Pick !== kv.canonicalPeerDeviceId, discriminating,
      `JS string order should ${discriminating ? 'DISagree' : 'agree'} on ${name}`);
  });
}

// ── J.1 / K1.1 / K2.1 — the positive, through the PAIR_STATE lane ───────────

const LANE = [
  ['J.1', J.positiveJ1.ctxWire, J.positiveJ1.contextBytesHexSw, J.positiveJ1],
  ['K1.1', { pairingId: KB.sharedFixture.pairingId, phoneDeviceId: KB.sharedFixture.phoneDeviceId,
    peerDeviceId: KB.K1.positiveK1_1.ctxPeerDeviceId, pairEpoch: KB.sharedFixture.pairEpoch },
  KB.K1.positiveK1_1.contextBytesHex, KB.K1.positiveK1_1],
  ['K2.1', { pairingId: KB.sharedFixture.pairingId, phoneDeviceId: KB.sharedFixture.phoneDeviceId,
    peerDeviceId: KB.K2.positiveK2_1.ctxPeerDeviceId, pairEpoch: KB.sharedFixture.pairEpoch },
  KB.K2.positiveK2_1.contextBytesHex, KB.K2.positiveK2_1],
];

for (const [label, ctxWire, ctxHex, keysVec] of LANE) {
  await check(`${label}: the SW lane derives the frozen context and traffic keys from ONE shared ctx`, async () => {
    // `recipientDeviceIds` is OMITTED — this is the PAIR_STATE lane, which holds
    // no wraps[]. `deviceId` is not passed either; A4-M1 makes the module reject
    // it outright, which is asserted below.
    const inputs = K.pairContextFromWire(ctxWire, { userId: J.localUserId });
    const bytes = inputs.contextBytes;   // the module returns them; re-encoding would assert a second path
    eq(K.toHex(bytes), ctxHex, `${label} contextBytes`);
    const keys = await K.trafficKeys(
      { pairingId: inputs.pairingId, sessionKey, context: bytes, role: 'phone' }, subtle,
    );
    eq(K.toHex(keys.send.rawBytes), keysVec.phoneToComputerKeyHex, `${label} k_p2c`);
    eq(K.toHex(keys.recv.rawBytes), keysVec.computerToPhoneKeyHex, `${label} k_c2p`);
    const { np2c, nc2p } = await K.deriveNoncePrefixes(
      { pairingId: inputs.pairingId, sessionKey, context: bytes }, subtle,
    );
    eq(K.toHex(np2c), keysVec.np2cHex, `${label} np2c`);
    eq(K.toHex(nc2p), keysVec.nc2pHex, `${label} nc2p`);
  });
}

await check('J.1: the SW lane derives BYTE-IDENTICAL context bytes to the page lane', async () => {
  // A4-R1's whole claim: ONE ctx, ONE pairContext, ONE traffic-key set per
  // pairing, shared by every recipient. The frozen file asserts the two lanes'
  // context bytes are EQUAL, not merely both present, so this compares them.
  eq(J.positiveJ1.contextsIdentical, true, 'frozen file must claim identical contexts');
  eq(J.positiveJ1.contextBytesHexSw, J.positiveJ1.contextBytesHexPage, 'sw vs page contextBytes');
  eq(J.positiveJ1.swKeysEqualPageKeys, true, 'frozen file must claim identical key sets');
});

// ── J.1b — ONE broadcast ciphertext opens for BOTH recipients ───────────────

await check('J.1b: one broadcast ciphertext opens under the SW-derived key', async () => {
  // The property a device-scoped ctx would destroy. Sealed phone data frames
  // are ONE ciphertext broadcast byte-identically to every listener; under a
  // per-recipient key set it would open for exactly one and hand the other a
  // tag failure indistinguishable from a network fault.
  //
  // Opened with raw WebCrypto, not `K.open()`: the vector fixes an EMPTY AAD
  // deliberately so that it stands alone and does not re-pin A2's frame header,
  // and `K.open()` builds the A2 header. Using it here would assert a different
  // vector and quietly stop asserting this one.
  const B = need(J.positiveJ1bBroadcast, 'canonicalPeer.positiveJ1bBroadcast');
  eq(B.aadHex, '', 'this vector is pinned with an EMPTY aad');
  const inputs = K.pairContextFromWire(J.positiveJ1.ctxWire, { userId: J.localUserId });
  const bytes = inputs.contextBytes;   // the module returns them; re-encoding would assert a second path
  const keys = await K.trafficKeys(
    { pairingId: inputs.pairingId, sessionKey, context: bytes, role: 'computer' }, subtle,
  );
  const { np2c } = await K.deriveNoncePrefixes({ pairingId: inputs.pairingId, sessionKey, context: bytes }, subtle);
  const iv = K.concatBytes([np2c, K.be64(B.seq)]);
  const pt = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new Uint8Array(0), tagLength: K.TAG_BITS },
    keys.recv.key, K.fromHex(B.ciphertextHex),
  ));
  eq(new TextDecoder().decode(pt), B.plaintextUtf8, 'opened plaintext');
  eq(B.opensForPage, B.opensForSw, 'the frozen file must claim it opens for BOTH');
});

// ── J.4 — clause (b), the SW lane's BINDING check, fail-closed ──────────────

await check('J.4: a non-member KEK does NOT open the frame — fail-closed, no fallback', async () => {
  // A3-M3(b) as re-scoped. The outsider's static key comes from scalar 3; it
  // has no wraps[] entry, and a wrap spliced from another recipient does not
  // open under its KEK. The frozen file carries that KEK, so the assertion is
  // the real one — a rejection, not a re-derivation of our own belief.
  const N = need(J.negativeJ4NonMember, 'canonicalPeer.negativeJ4NonMember');
  const B = need(J.positiveJ1bBroadcast, 'canonicalPeer.positiveJ1bBroadcast');
  const inputs = K.pairContextFromWire(J.positiveJ1.ctxWire, { userId: J.localUserId });
  const bytes = inputs.contextBytes;   // the module returns them; re-encoding would assert a second path
  const { np2c } = await K.deriveNoncePrefixes({ pairingId: inputs.pairingId, sessionKey, context: bytes }, subtle);
  const outsider = await subtle.importKey('raw', K.fromHex(N.outsiderKekHex), 'AES-GCM', false, ['decrypt']);
  let opened = null;
  try {
    opened = await subtle.decrypt(
      { name: 'AES-GCM', iv: K.concatBytes([np2c, K.be64(B.seq)]), additionalData: new Uint8Array(0), tagLength: K.TAG_BITS },
      outsider, K.fromHex(B.ciphertextHex),
    );
  } catch { /* the required outcome */ }
  assert(opened === null, 'a non-member KEK opened the frame — clause (b) is not binding');
});

// ── Clause (c): SKIPPED on this lane, and NOT because it is unimplemented ───

await check('J.3: the SW lane performs NO peer check — and MUST NOT substitute its own id', async () => {
  // A4-R3. The relay-steered ctx (peerDeviceId forced to the NON-canonical
  // dev-web-01) is ADMITTED here, deriving J.3's frozen key. That is correct,
  // not a hole: this lane cannot see wraps[], so its binding check is the
  // cryptographic one — the steered context yields a key the phone did not use
  // and the wrap simply fails to open, which A4-M3 turns into a pairing abort.
  const S3 = need(J.negativeJ3SteeredPeer, 'canonicalPeer.negativeJ3SteeredPeer');
  const steered = { ...J.positiveJ1.ctxWire, peerDeviceId: S3.ctxPeerDeviceId };
  const inputs = K.pairContextFromWire(steered, { userId: J.localUserId });
  const bytes = inputs.contextBytes;   // the module returns them; re-encoding would assert a second path
  eq(K.toHex(bytes), S3.contextBytesHex, 'J.3 contextBytes');
  const keys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: bytes, role: 'phone' }, subtle);
  eq(K.toHex(keys.send.rawBytes), S3.phoneToComputerKeyHex, 'J.3 k_p2c');
  // A4-R2's single-recipient invariance, proved rather than asserted: J.3's
  // steered key IS vector I.1's frozen phoneToComputerKey. A4 rekeys nothing
  // already shipped.
  eq(S3.phoneToComputerKeyHex, V.traffic.phoneToComputerKeyHex, 'J.3 k_p2c == I.1 k_p2c (invariance)');
});

await check('J.3: the PAGE lane — which DOES hold wraps[] — refuses the same steered ctx', async () => {
  // The other half, and the reason the skip above is a decision rather than an
  // omission. Same module, same ctx, one extra argument.
  const S3 = need(J.negativeJ3SteeredPeer, 'canonicalPeer.negativeJ3SteeredPeer');
  const steered = { ...J.positiveJ1.ctxWire, peerDeviceId: S3.ctxPeerDeviceId };
  let threw = null;
  try { K.pairContextFromWire(steered, { userId: J.localUserId, recipientDeviceIds: J.wraps }); }
  catch (e) { threw = e; }
  assert(threw, 'the page lane admitted a steered peer');
  assert(/A4-R2|A3-M3\(c\)/.test(threw.message), `refusal should cite clause (c)/A4-R2, said: ${threw.message}`);
});

for (const [name, kv, neg] of [['K1.2', KB.K1, KB.K1.negativeK1_2Utf16Pick], ['K2.3', KB.K2, KB.K2.negativeK2_3SignedPick]]) {
  await check(`${name}: the key a WRONG comparator derives — page lane refuses it`, async () => {
    // Frozen so the failure mode is visible: the derivation SUCCEEDS under the
    // wrong comparator. It is simply a key nobody else holds — a silent,
    // unattributable half-break, which is why the refusal has to be explicit.
    const ctxWire = {
      pairingId: KB.sharedFixture.pairingId,
      phoneDeviceId: KB.sharedFixture.phoneDeviceId,
      peerDeviceId: neg.wrongCanonical,
      pairEpoch: KB.sharedFixture.pairEpoch,
    };
    const inputs = K.pairContextFromWire(ctxWire, { userId: KB.sharedFixture.localUserId });
    const bytes = inputs.contextBytes;   // the module returns them; re-encoding would assert a second path
    eq(K.toHex(bytes), neg.contextBytesHex, `${name} contextBytes`);
    const keys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: bytes, role: 'phone' }, subtle);
    eq(K.toHex(keys.send.rawBytes), neg.phoneToComputerKeyHex, `${name} k_p2c`);
    assert(neg.phoneToComputerKeyHex !== kv.positiveK1_1?.phoneToComputerKeyHex
      && neg.phoneToComputerKeyHex !== kv.positiveK2_1?.phoneToComputerKeyHex,
    `${name} must differ from the canonical key`);
    let threw = null;
    try { K.pairContextFromWire(ctxWire, { userId: KB.sharedFixture.localUserId, recipientDeviceIds: kv.wrapsOrderAB }); }
    catch (e) { threw = e; }
    assert(threw, `${name}: the page lane admitted the wrong-comparator peer`);
  });
}

// ── J.5 — the regression this addendum exists for ──────────────────────────

await check('J.5: the pre-A4 check is GONE — both recipients are admitted, and `deviceId` is rejected', async () => {
  const R = need(J.negativeJ5PreA4Regression, 'canonicalPeer.negativeJ5PreA4Regression');
  eq(R.bothMustBeAdmittedAfterA4, true, 'frozen file must require both admitted');
  // Under the struck clause, being `dev-web-01` refused J.1's ctx outright. The
  // option no longer exists at all, so the only thing left to assert is that
  // passing it THROWS — silently ignoring it would leave a caller believing a
  // membership check was running with the check gone.
  for (const own of [R.preA4RefusedDeviceId, R.preA4AdmittedDeviceId]) {
    K.pairContextFromWire(J.positiveJ1.ctxWire, { userId: J.localUserId });   // admitted whoever we are
    let threw = null;
    try { K.pairContextFromWire(J.positiveJ1.ctxWire, { userId: J.localUserId, deviceId: own }); }
    catch (e) { threw = e; }
    assert(threw, `deviceId "${own}" was silently ignored instead of rejected`);
    assert(/A4-M1/.test(threw.message), `rejection should cite A4-M1, said: ${threw.message}`);
  }
});

// ── Clause (b) + A4-M3 — the unwrap is the membership proof, and its failure
//    is an ABORT, never a degrade to counts-only ────────────────────────────

const S = await import('../chrome-extension/e2e/sw-session.js');

/**
 * Build a real §13.2 wrap addressed to `ownDeviceId`, sealed under
 * KEK(pairContext(ctx), the recipient's own static key) — the exact object
 * `unwrapSessionKey` expects. Real ECDH, real AES-GCM; nothing is mocked,
 * because the whole assertion is that the CRYPTOGRAPHY binds membership.
 */
async function buildWrap({ ctxWire, userId, ownDeviceId, kid = 'kid-a4' }) {
  const inputs = K.pairContextFromWire(ctxWire, { userId });
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recip = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipPub = new Uint8Array(await subtle.exportKey('raw', recip.publicKey));
  const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: recip.publicKey }, eph.privateKey, 256));
  const kekBytes = await K.kek(
    { pairingId: inputs.pairingId, sharedSecret: z, context: inputs.contextBytes, recipientKey: recipPub }, subtle,
  );
  const kekKey = await subtle.importKey('raw', kekBytes, 'AES-GCM', false, ['encrypt']);
  const sk = new Uint8Array(32).fill(7);
  const sealed = await K.seal({
    sender: { direction: K.DIR_P2C, key: kekKey, sessionPrefix: await S.wrapPrefix(ownDeviceId, subtle) },
    frameType: S.WRAP_FRAME_TYPE, kid, seq: 0, pairEpoch: inputs.pairEpoch, plaintext: sk,
  }, subtle);
  const b64 = (u8) => S.toBase64Url(u8);
  return {
    block: {
      kid,
      mode: 1,
      ctx: ctxWire,
      epk: b64(new Uint8Array(await subtle.exportKey('raw', eph.publicKey))),
      wrap: b64(sealed),
    },
    privateKey: recip.privateKey,
    ownPub: b64(recipPub),
    ownDeviceId,
    ctxInputs: { ...inputs, userId },
    skHex: K.toHex(sk),
  };
}

await check('A4 (b): the wrap addressed to this device OPENS under KEK(ctx, its own static key)', async () => {
  // The POSITIVE control the negatives below need. Without it they would all
  // pass against a harness that could never open anything at all.
  const w = await buildWrap({ ctxWire: J.positiveJ1.ctxWire, userId: J.localUserId, ownDeviceId: 'dev-ext-02' });
  const sk = await S.unwrapSessionKey(w, subtle);
  eq(K.toHex(sk), w.skHex, 'unwrapped session key');
});

await check('A4 (b): a wrap belonging to ANOTHER recipient does NOT open', async () => {
  // Same pairing, same ctx — only the recipient key differs, which is exactly
  // where A4-R1 says per-recipient separation lives (J.1c). A spliced wrap must
  // fail, fail-closed, with no plaintext fallback and no derive-anyway.
  const mine = await buildWrap({ ctxWire: J.positiveJ1.ctxWire, userId: J.localUserId, ownDeviceId: 'dev-ext-02' });
  const theirs = await buildWrap({ ctxWire: J.positiveJ1.ctxWire, userId: J.localUserId, ownDeviceId: 'dev-ext-02' });
  let threw = null;
  try { await S.unwrapSessionKey({ ...mine, block: { ...mine.block, wrap: theirs.block.wrap } }, subtle); }
  catch (e) { threw = e; }
  assert(threw, "another recipient's wrap opened under our KEK — clause (b) does not bind");
});

await check('A4 (b): a ctx steered to a non-canonical peer makes the wrap fail to open', async () => {
  // The SW skips clause (c) — asserted above — so THIS is what protects it. A
  // steered ctx derives a different KEK and the phone's wrap stops opening: the
  // check the SW cannot perform is replaced by one the relay cannot forge.
  const S3 = need(J.negativeJ3SteeredPeer, 'canonicalPeer.negativeJ3SteeredPeer');
  const w = await buildWrap({ ctxWire: J.positiveJ1.ctxWire, userId: J.localUserId, ownDeviceId: 'dev-ext-02' });
  const steered = K.pairContextFromWire(
    { ...J.positiveJ1.ctxWire, peerDeviceId: S3.ctxPeerDeviceId }, { userId: J.localUserId },
  );
  let threw = null;
  try { await S.unwrapSessionKey({ ...w, ctxInputs: { ...steered, userId: J.localUserId } }, subtle); }
  catch (e) { threw = e; }
  assert(threw, 'a steered ctx still opened the wrap — the cryptographic anchor is not binding');
});

await check("A4-M3: 'aborted' is fail-closed on plaintext, NOT a counts-only degrade", async () => {
  // §13.2 row 2's counts-only covers a recipient that never had a key. An
  // aborted pairing is a different thing: the PHONE is still sealing, so a
  // frame that requiresSeal() arriving in the clear is an anomaly, and
  // accepting it would be the downgrade the abort exists to refuse.
  const plaintext = { body: 'hi' };
  eq(S.inboundDisposition({ mode: 'aborted', frameType: 'SMS_RECEIVED', data: plaintext }),
    S.INBOUND_DROP_PLAINTEXT, 'aborted + requiresSeal must DROP');
  eq(S.inboundDisposition({ mode: 'counts-only', frameType: 'SMS_RECEIVED', data: plaintext }),
    S.INBOUND_DELIVER, 'counts-only must keep delivering — an un-paired install is not an attack');
  eq(S.inboundDisposition({ mode: 'off', frameType: 'SMS_RECEIVED', data: plaintext }),
    S.INBOUND_DELIVER, 'off must keep delivering');
});

await check('A4-M3: ensureSession routes the UNWRAP failure to an abort and the ctx failure to counts-only', async () => {
  // background.js cannot be imported under node (it is an MV3 module that binds
  // `self`, chrome.* and a live socket at load), so the WIRING is asserted
  // against its source — the same pattern, and for the same reason, as the
  // chokepoint proof in tests/e2e-sw-chokepoint.test.mjs. The DECISIONS above
  // are asserted behaviourally; this asserts that each one is actually reached.
  // NORMALISE THE LINE ENDINGS FIRST. The slice anchors on '\n}\n'; git checks
  // background.js out with CRLF on Windows, so after a rebase re-materialised
  // the file that needle was absent, indexOf returned -1, and
  // `code.slice(start, -1 + 1)` produced the EMPTY STRING. This check went red
  // in the P3 gate for that reason alone and nothing about ensureSession.
  //
  // The empty body did fail — `body.length > 100` caught it, and the guard below
  // is kept for exactly that reason. But it failed with the WRONG diagnosis:
  // "could not isolate ensureSession" reads as a refactor that moved the
  // function, and it cost a diagnosis pass to find a line-ending difference
  // instead. So: normalise, and fail on the ANCHOR where the anchor is what
  // broke. The length and closed-block guards stay, because they are what stand
  // between a bad slice and a body whose /…/.test() assertions would be
  // vacuously false rather than loud.
  const src = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8').replace(/\r\n?/g, '\n')
    .replace(/\r\n/g, '\n');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const start = code.indexOf('async function ensureSession');
  assert(start > 0, 'could not find ensureSession in background.js');
  const end = code.indexOf('\n}\n', start);
  // Fail on the ANCHOR, not on what the anchor's absence silently produced.
  assert(end > start, 'could not find the end of ensureSession — the slice anchor did not match');
  const body = code.slice(start, end + 1);
  // Both halves of "we isolated a function": long enough to be one, and closed.
  // Length alone would accept a runaway slice to the end of the file.
  assert(body.length > 100, 'could not isolate ensureSession from background.js');
  assert(body.trimEnd().endsWith('}'), 'the isolated ensureSession is not a closed block');

  const unwrapIdx = body.indexOf('unwrapSessionKey');
  assert(unwrapIdx > 0, 'ensureSession must still call unwrapSessionKey');
  const beforeUnwrap = body.slice(0, unwrapIdx);
  const afterUnwrap = body.slice(unwrapIdx);

  // The split itself. The single catch this item exists to remove routed EVERY
  // failure — unwrap included — to setCountsOnly.
  assert(/setAborted\(/.test(afterUnwrap), 'the unwrap failure must call setAborted (A4-M3)');
  assert(!/setCountsOnly\(/.test(afterUnwrap.slice(0, afterUnwrap.indexOf('setAborted('))),
    'a counts-only landing sits between the unwrap and its abort — A4-M3 forbids it');
  // …and the ctx branch is UNCHANGED: still CtxRefused → counts-only.
  assert(/setCountsOnly\([\s\S]{0,60}CtxRefused/.test(beforeUnwrap),
    'the CtxRefused branch must still land in counts-only, unchanged');
  // Sticky, or the abort becomes counts-only one frame later via `no-wrap`.
  assert(/e2eMode === 'aborted'[\s\S]{0,140}return null/.test(body),
    'ensureSession must early-return while aborted — otherwise the abort self-heals into counts-only');
  // And the ONLY thing that clears it is a block with a different kid.
  assert(/e2eMode === 'aborted' && block\.kid !== e2eAbortedKid/.test(code),
    'only a block with a DIFFERENT kid may clear an abort');
  // A4-M5: attribution on the failure, ids only — never key material.
  assert(/trace\('e2e-abort'[\s\S]{0,240}canonicalPeer/.test(code),
    'the abort trace must name the canonical peer it derived from (A4-M5)');
});


// ── A4.1 — the bridge hand-over (item 4) ───────────────────────────────────

await check('A4.1: the e2e-pubkey bridge carries pairingId, keeps rid, and keeps its null arm', async () => {
  // The contract P2 consumes, asserted on BOTH sides of the bridge so the two
  // cannot drift into agreeing about different fields:
  //   { source:'cc-ext', type:'e2e-pubkey', v:1, deviceId, pub, pairingId, rid? }
  const shell = readFileSync(join(ROOT, 'chrome-extension/shell.js'), 'utf8').replace(/\r\n?/g, '\n');
  const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8').replace(/\r\n?/g, '\n');

  // Page → SW. The hand-over rides the REQUEST, bounded and type-checked before
  // it reaches the worker — this branch is reachable from the app frame.
  assert(/data\.pairingId === 'string'/.test(shell), 'shell.js must type-check an inbound pairingId');
  assert(/data\.pairingId\.length <= 255/.test(shell), 'the inbound pairingId must be bounded (u8 length prefix)');
  assert(/setOwnPairingId\(/.test(bg), 'background.js must pin the handed-over pairingId (A4.1 source 1)');

  // SW → page. The reply carries what the worker now holds, null included: "no
  // pairingId yet" and "no reply arrived" must stay tellable apart, the same
  // deliberate null arm `pub` has.
  assert(/pairingId: r\.pairingId \?\? null/.test(shell), 'the reply must carry pairingId with its null arm');
  assert(/deviceId: null, pub: null, pairingId: null/.test(shell), 'the no-worker arm must be fully null, not absent');
  assert(/pairingId: \(own && own\.pairingId\) \|\| null/.test(bg), 'the worker must answer with the value it holds');
  // rid is UNCHANGED — still echoed only when the page supplied one.
  assert(/\.\.\.\(rid === undefined \? \{\} : \{ rid \}\)/.test(shell), 'the rid echo must be unchanged');
  // The envelope itself is untouched.
  assert(/source: NS, type: 'e2e-pubkey'/.test(shell), 'the bridge envelope must be unchanged');

  // A4.1 is a CONSISTENCY pin, not the anchor: the pin lives in storage.SESSION
  // while the epoch floor (A3-M2), which IS load-bearing against nonce reuse,
  // stays in storage.local. Keeping them in different stores is the point.
  const sws = readFileSync(join(ROOT, 'chrome-extension/e2e/sw-session.js'), 'utf8').replace(/\r\n?/g, '\n');
  assert(/OWN_PAIRING_KEY[\s\S]{0,400}?sessionGet\(OWN_PAIRING_KEY\)/.test(sws),
    'the pairingId pin must live in storage.session');
  assert(/EPOCH_FLOOR_KEY = 'cc_e2e_epoch_floor'/.test(sws), 'the epoch floor must keep its own (local) key');
});


console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
