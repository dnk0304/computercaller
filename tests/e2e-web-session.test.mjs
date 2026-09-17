#!/usr/bin/env node
/**
 * tests/e2e-web-session.test.mjs — the sealed session (E2E-P2 (d), (e), (f)).
 *
 * Four things are being proved, in descending order of what they cost if wrong:
 *
 *  1. GATE1 Addendum A2's vectors E, F, G, H reproduce BYTE-EXACT from
 *     lib/e2e/session.mjs against tests/kdf-vectors.json. A2 requires the web/SW
 *     lane to assert E–H "against the same file, or the file constrains one
 *     implementation of three". Vectors A–D (A1) are still asserted by
 *     tests/kdf-vectors.test.mjs and were not regenerated when E–H were added.
 *
 *  2. The persist-before-emit counter FAILS CLOSED. Under A2 this is the SOLE
 *     control against GCM nonce reuse — the derived prefix contributes nothing,
 *     because a device that restores a stale counter re-derives the identical
 *     prefix. So the restore scenarios are driven for real: storage cleared,
 *     profile copied, and a commit that rejects. Each must REFUSE and ask for a
 *     rekey. This is the web equivalent of P4's
 *     E2eSeqStoreTest.restore_from_backup_fails_closed, which A2 names as the
 *     model and makes blocking for this lane.
 *
 *  3. A duplicate is DROPPED, never rejected. frameBuffer replay on resume is
 *     legitimate traffic; a dedupe window that errors on it would break the
 *     feature it is protecting. The 1,000-frame replay required by (h) is run
 *     here at the unit level and must produce ZERO legitimate drops.
 *
 *  4. The AEAD binds what A1 says it binds. Rather than asserting "a good frame
 *     opens" (which any construction satisfies), every field the AAD covers is
 *     mutated in turn — frameType, kid, seq, direction, pairEpoch — and each
 *     mutation must make the open FAIL. A test that only proves the happy path
 *     would pass against an implementation with no AAD at all.
 */

import { createRequire } from 'node:module';
import {
  DIR_P2C, DIR_C2P,
  LABEL_NP2C, LABEL_NC2P,
  WRAP_FRAME_TYPE,
  noncePrefixInfo, deriveNoncePrefixes, wrapPrefix, openWrap,
  toBase64Url, fromBase64Url,
  encodeEnvelope, decodeEnvelope,
  memorySeqStore, bindKid, createFailClosedSender, skFingerprint,
  SeqFailClosedError, SEQ_RECORD_VERSION,
  createDedupeWindow, DEDUPE_WINDOW, DEDUPE_FLOOR_ADVANCE_CAP,
  createComputerSession,
} from '../lib/e2e/session.mjs';
import * as KDF from '../lib/e2e/kdf.mjs';
import { padPlaintext } from '../lib/e2e/padding.mjs';

const require = createRequire(import.meta.url);
const V = require('./kdf-vectors.json');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
async function throws(name, fn, predicate) {
  try { await fn(); } catch (e) {
    check(name, predicate ? predicate(e) : true, `threw ${e?.name}: ${e?.message}`);
    return;
  }
  check(name, false, 'did not throw');
}

const hex = KDF.toHex;
const unhex = KDF.fromHex;
const ctx = KDF.pairContext(V.context);
const SK = unhex(V.traffic.sessionKeyHex);
const PAIRING_ID = V.context.pairingId;

eq('context: reproduces the frozen contextBytesHex', hex(ctx), V.contextBytesHex);

// ── 1. A2 vectors E, F, G, H ────────────────────────────────────────────────
eq('A2 label: np2c', LABEL_NP2C, V.noncePrefix.labels.np2c);
eq('A2 label: nc2p', LABEL_NC2P, V.noncePrefix.labels.nc2p);
eq('E: infoNp2c bytes', hex(noncePrefixInfo(ctx, DIR_P2C)), V.noncePrefix.infoNp2cHex);
eq('E: infoNc2p bytes', hex(noncePrefixInfo(ctx, DIR_C2P)), V.noncePrefix.infoNc2pHex);

const prefixes = await deriveNoncePrefixes({ pairingId: PAIRING_ID, sessionKey: SK, context: ctx });
eq('E: np2c', hex(prefixes.np2c), V.noncePrefix.np2cHex);
eq('E: nc2p', hex(prefixes.nc2p), V.noncePrefix.nc2pHex);
eq('E: np2c is 4 bytes', prefixes.np2c.length, 4);

// H — the negative. Asserted as a property, and the guard is proven non-vacuous
// by feeding the same label twice through the frozen hkdf32 directly.
check('H: np2c !== nc2p', hex(prefixes.np2c) !== hex(prefixes.nc2p));
check('H: neither prefix is all-zero',
  !prefixes.np2c.every((b) => b === 0) && !prefixes.nc2p.every((b) => b === 0));
{
  const same = (await KDF.hkdf32({
    salt: PAIRING_ID, ikm: SK, info: noncePrefixInfo(ctx, DIR_P2C),
  })).slice(0, 4);
  eq('H: the one-character typo (same label twice) WOULD collide', hex(same), hex(prefixes.np2c));
}
// The truncation is the documented-equivalent of L=4: T(1) first.
eq('E: L=4 and truncate-32 are the same bytes',
  hex((await KDF.hkdf32({ salt: PAIRING_ID, ikm: SK, info: noncePrefixInfo(ctx, DIR_P2C) })).slice(0, 4)),
  V.noncePrefix.np2cHex);

// F and G — full AEAD under the DERIVED prefix, one input different from A.
for (const [name, vec, prefix] of [
  ['F (p2c)', V.aeadDerived.p2c, prefixes.np2c],
  ['G (c2p)', V.aeadDerived.c2p, prefixes.nc2p],
]) {
  eq(`${name}: the vector's prefix is the DERIVED one`, hex(prefix), vec.noncePrefixHex);
  eq(`${name}: nonce`, hex(KDF.nonce(prefix, vec.seq)), vec.nonceHex);
  eq(`${name}: aad`, hex(KDF.aad({
    frameType: vec.frameType, kid: vec.kid, seq: vec.seq,
    direction: vec.direction, pairEpoch: vec.pairEpoch,
  })), vec.aadHex);
  eq(`${name}: padded plaintext`, hex(padPlaintext(vec.frameType, new TextEncoder().encode(vec.plaintextUtf8))),
    vec.plaintextHex);
  const key = await crypto.subtle.importKey('raw', unhex(vec.keyHex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const ct = await KDF.seal({
    sender: { direction: vec.direction, key, sessionPrefix: prefix },
    frameType: vec.frameType, kid: vec.kid, seq: vec.seq, pairEpoch: vec.pairEpoch,
    plaintext: new TextEncoder().encode(vec.plaintextUtf8),
  });
  eq(`${name}: ciphertext`, hex(ct), vec.ciphertextHex);
  const back = await KDF.open({
    receiver: { direction: vec.direction, key, sessionPrefix: prefix },
    frameType: vec.frameType, kid: vec.kid, seq: vec.seq, pairEpoch: vec.pairEpoch, ciphertext: ct,
  });
  eq(`${name}: opens back to the plaintext`, new TextDecoder().decode(back), vec.plaintextUtf8);
}
// F is A with ONE input changed, so the comparison against A1's vector A is the
// localiser A2 asked for: same AAD, same key, same padded plaintext, different
// prefix -> different ciphertext. If F ever fails while A passes, the prefix
// derivation is the only thing that can be wrong.
eq('F vs A: the AAD is IDENTICAL', V.aeadDerived.p2c.aadHex, V.aead.vectorA.aadHex);
eq('F vs A: the key is identical', V.aeadDerived.p2c.keyHex, V.aead.vectorA.keyHex);
eq('F vs A: the padded plaintext is identical',
  V.aeadDerived.p2c.plaintextHex, V.aead.vectorA.paddedPlaintextHex);
check('F vs A: the supplied prefix and the derived one really differ',
  V.aead.vectorA.sessionPrefixHex !== V.aeadDerived.p2c.noncePrefixHex);
check('F vs A: so the ciphertexts DIFFER (the prefix really is an AEAD input)',
  V.aeadDerived.p2c.ciphertextHex !== V.aead.vectorA.ciphertextHex);

// ── 2. the AAD binds what A1 says it binds ─────────────────────────────────
{
  const vec = V.aeadDerived.p2c;
  const key = await crypto.subtle.importKey('raw', unhex(vec.keyHex), { name: 'AES-GCM' }, false, ['decrypt']);
  const base = {
    receiver: { direction: vec.direction, key, sessionPrefix: prefixes.np2c },
    frameType: vec.frameType, kid: vec.kid, seq: vec.seq, pairEpoch: vec.pairEpoch,
    ciphertext: unhex(vec.ciphertextHex),
  };
  check('aad: the unmutated frame opens',
    await KDF.open(base).then(() => true, () => false));
  for (const [what, patch] of [
    ['frameType (relabel CALL_STATUS as SMS_RECEIVED)', { frameType: 'CALL_STATUS' }],
    ['kid', { kid: 'kid-02' }],
    ['seq (slide it past the dedupe window)', { seq: 8 }],
    ['direction (reflect it back at the sender)', { receiver: { ...base.receiver, direction: DIR_C2P } }],
    ['pairEpoch (replay into the next epoch)', { pairEpoch: 43 }],
    ['nonce prefix', { receiver: { ...base.receiver, sessionPrefix: prefixes.nc2p } }],
  ]) {
    await throws(`aad: mutating ${what} makes the open FAIL`,
      () => KDF.open({ ...base, ...patch }));
  }
}

// ── 3. the envelope ────────────────────────────────────────────────────────
{
  const ct = unhex(V.aeadDerived.p2c.ciphertextHex);
  const env = encodeEnvelope({ kid: 'kid-01', seq: 7, ciphertext: ct });
  eq('envelope: e', env.e, 1);
  eq('envelope: field set', Object.keys(env).sort().join(','), 'c,e,kid,s');
  const round = decodeEnvelope(env);
  eq('envelope: decodes kid', round.kid, 'kid-01');
  eq('envelope: decodes seq', round.seq, 7);
  eq('envelope: decodes ciphertext', hex(round.ciphertext), V.aeadDerived.p2c.ciphertextHex);
  eq('envelope: base64url round-trips', hex(fromBase64Url(toBase64Url(ct))), hex(ct));
  for (const [name, bad] of [
    ['a plaintext object', { deviceName: 'Pixel' }],
    ['null', null], ['a string', 'SMS_RECEIVED:{}'], ['an array', [1]],
    ['e:2', { ...env, e: 2 }],
    ['a negative seq', { ...env, s: -1 }],
    ['a fractional seq', { ...env, s: 1.5 }],
    ['a seq as a string', { ...env, s: '7' }],
    ['an empty kid', { ...env, kid: '' }],
    ['a ciphertext shorter than a tag+bucket', { ...env, c: toBase64Url(new Uint8Array(79)) }],
    ['a non-base64url ciphertext', { ...env, c: '*'.repeat(100) }],
  ]) {
    eq(`envelope: ${name} is NOT an envelope`, decodeEnvelope(bad), null);
  }
}

// ── 4. the fail-closed counter — A2's sole control ─────────────────────────
const fp = await skFingerprint(SK);
{
  const store = memorySeqStore();
  const bound = await bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: SK, fresh: true });
  eq('seq: a FRESH kid starts at 0', bound.next, 0);
  check('seq: and is committed BEFORE any frame', (await store.load('kid-01:2')) !== undefined);
  eq('seq: the SK fingerprint is bound to the kid', bound.sk, fp);

  const sender = createFailClosedSender({ store, kid: 'kid-01', direction: DIR_C2P, floor: bound.next, sk: fp });
  eq('seq: first seq is 0', await sender.nextSeq(), 0);
  eq('seq: the floor was committed as 1 BEFORE 0 was returned', (await store.load('kid-01:2')).next, 1);
  eq('seq: second seq is 1', await sender.nextSeq(), 1);
  eq('seq: strictly increasing', await sender.nextSeq(), 2);
  eq('seq: record version', (await store.load('kid-01:2')).v, SEQ_RECORD_VERSION);

  // RESUME: the same kid, same SK, a store that remembers → continue from 3.
  const again = await bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: SK, fresh: false });
  check('seq: a resumed kid is recognised as resumed', again.resumed === true);
  eq('seq: and resumes at the stored floor, NOT 0', again.next, 3);
}
// THE scenario A2 made blocking: storage is gone, the pair is not.
{
  const store = memorySeqStore(); // cleared site data / restored profile / new browser
  await throws(
    'RESTORE: a resumed kid with NO stored counter REFUSES',
    () => bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: SK, fresh: false }),
    (e) => e instanceof SeqFailClosedError && e.reason === 'counter-lost' && e.rekey === true,
  );
  check('RESTORE: nothing was written on the refusal', (await store.load('kid-01:2')) === undefined);
}
// Copied profile: the counter is STALE rather than absent. The 1:1 kid↔SK rule
// is what catches the re-Accept, because a re-Accept mints a new SK.
{
  const store = memorySeqStore();
  await bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: SK, fresh: true });
  const otherSK = new Uint8Array(32).fill(7);
  await throws(
    'COPIED PROFILE: the same kid under a DIFFERENT SK REFUSES (A2 MUST kid<->SK 1:1)',
    () => bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: otherSK, fresh: false }),
    (e) => e instanceof SeqFailClosedError && e.reason === 'kid-reused',
  );
  await throws(
    'COPIED PROFILE: ...and fresh:true does not launder it either',
    () => bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: otherSK, fresh: true }),
    (e) => e instanceof SeqFailClosedError && e.reason === 'kid-reused',
  );
}
// A commit that cannot be made durable is a REFUSAL, and it poisons the sender.
{
  const store = memorySeqStore();
  await bindKid({ store, kid: 'kid-01', direction: DIR_C2P, sessionKey: SK, fresh: true });
  let allow = true;
  const flaky = {
    load: store.load,
    commit: async (id, r) => { if (!allow) throw new Error('QuotaExceededError'); return store.commit(id, r); },
  };
  const sender = createFailClosedSender({ store: flaky, kid: 'kid-01', direction: DIR_C2P, floor: 0, sk: fp });
  eq('commit-fail: a healthy commit yields a seq', await sender.nextSeq(), 0);
  allow = false;
  await throws('commit-fail: a failed commit REFUSES to emit',
    () => sender.nextSeq(),
    (e) => e instanceof SeqFailClosedError && e.reason === 'commit-failed' && e.rekey === true);
  allow = true;
  await throws('commit-fail: and the sender stays poisoned — no quiet recovery',
    () => sender.nextSeq(), (e) => e instanceof SeqFailClosedError);
}

// ── 5. the dedupe window — DROP, never reject ──────────────────────────────
{
  const w = createDedupeWindow();
  check('dedupe: a new seq is accepted', w.accept(0) === true);
  check('dedupe: the same seq again is DROPPED', w.accept(0) === false);
  eq('dedupe: the drop was counted', w.drops, 1);
  check('dedupe: out-of-order within the window is fine', w.accept(5) === true && w.accept(3) === true);
  check('dedupe: a repeat of an out-of-order seq is dropped', w.accept(3) === false);
  check('dedupe: a negative seq is dropped, not thrown', w.accept(-1) === false);

  // The floor-advance cap. Without it, ONE forged far-future seq would slide the
  // floor past ~10 million sequence numbers and every frame the real peer sends
  // for the rest of the epoch would be dropped as "old" — a denial of service
  // built out of the replay defence. With it the damage is bounded to 256.
  const cap = createDedupeWindow();
  cap.accept(0);
  cap.accept(10_000_000);
  eq('dedupe: a far-future seq advances the floor by EXACTLY the cap, not to it',
    cap.floor, DEDUPE_FLOOR_ADVANCE_CAP);
  check('dedupe: the damage is bounded — seq 256 onwards is still accepted',
    cap.accept(DEDUPE_FLOOR_ADVANCE_CAP) === true);
  check('dedupe: and the 256 it did cost are dropped, not errors',
    cap.accept(1) === false);
  check('dedupe: uncapped, that ONE frame would have cost ~10,000,000 instead of 256',
    10_000_000 - DEDUPE_WINDOW + 1 > DEDUPE_FLOOR_ADVANCE_CAP * 1000);;

  // (h) — 1,000 buffered frames replayed: ZERO legitimate drops.
  const replay = createDedupeWindow();
  let accepted = 0;
  for (let i = 0; i < 1000; i += 1) if (replay.accept(i)) accepted += 1;
  eq('replay: 1,000 fresh buffered frames → 0 legitimate drops', accepted, 1000);
  eq('replay: ...and drops is 0', replay.drops, 0);
  let redelivered = 0;
  for (let i = 0; i < 1000; i += 1) if (replay.accept(i)) redelivered += 1;
  eq('replay: the SAME 1,000 replayed again → all dropped, none processed twice', redelivered, 0);
  eq('replay: and all 1,000 were counted as drops', replay.drops, 1000);

  const e = createDedupeWindow();
  e.accept(4); e.reset();
  check('dedupe: reset (new pairEpoch) lets the old seq through again', e.accept(4) === true);
  eq('dedupe: reset zeroes the counter', e.drops, 0);
}

// ── 6. wrap open, end to end against a simulated phone ─────────────────────
{
  // The phone side, built from the FROZEN primitives exactly as E2eAccept.kt does.
  const web = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const webPub = new Uint8Array(await crypto.subtle.exportKey('raw', web.publicKey));
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const webDeviceId = V.context.peerDeviceId;

  eq('wrap: the prefix is SHA-256(deviceId)[0..4]',
    hex(await wrapPrefix(webDeviceId)),
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(webDeviceId))).slice(0, 4)));

  const importedWeb = await crypto.subtle.importKey('raw', webPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: importedWeb }, eph.privateKey, 256));
  const kekBytes = await KDF.kek({ pairingId: PAIRING_ID, sharedSecret: z, context: ctx, recipientKey: webPub });
  const kekKey = await crypto.subtle.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const wrapCt = await KDF.seal({
    sender: { direction: DIR_P2C, key: kekKey, sessionPrefix: await wrapPrefix(webDeviceId) },
    frameType: WRAP_FRAME_TYPE, kid: 'kid-01', seq: 0, pairEpoch: V.context.pairEpoch, plaintext: SK,
  });

  const opened = await openWrap({
    wrap: toBase64Url(wrapCt), kid: 'kid-01', epk,
    ourPrivateKey: web.privateKey, ourPublicSec1: webPub, ourDeviceId: webDeviceId,
    pairingId: PAIRING_ID, context: ctx, pairEpoch: V.context.pairEpoch,
  });
  eq('wrap: the web opens its own wrap and recovers SK exactly', hex(opened), V.traffic.sessionKeyHex);

  // A wrap minted for ANOTHER recipient must not open here — that is what
  // binding K_i into the KEK info buys (A1 (1), "noted, not amended").
  const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const otherPub = new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey));
  const zo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', otherPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, eph.privateKey, 256));
  const kekOther = await crypto.subtle.importKey('raw',
    await KDF.kek({ pairingId: PAIRING_ID, sharedSecret: zo, context: ctx, recipientKey: otherPub }),
    { name: 'AES-GCM' }, false, ['encrypt']);
  const wrapOther = await KDF.seal({
    sender: { direction: DIR_P2C, key: kekOther, sessionPrefix: await wrapPrefix('someone-else') },
    frameType: WRAP_FRAME_TYPE, kid: 'kid-01', seq: 0, pairEpoch: V.context.pairEpoch, plaintext: SK,
  });
  await throws("wrap: the SW's wrap does NOT open in the web page",
    () => openWrap({
      wrap: toBase64Url(wrapOther), kid: 'kid-01', epk,
      ourPrivateKey: web.privateKey, ourPublicSec1: webPub, ourDeviceId: webDeviceId,
      pairingId: PAIRING_ID, context: ctx, pairEpoch: V.context.pairEpoch,
    }));
}

// ── 7. the session object: seal → open, and every drop reason ──────────────
{
  const mk = (store, fresh = true) => createComputerSession({
    pairingId: PAIRING_ID, sessionKey: SK, context: ctx, kid: 'kid-01',
    pairEpoch: V.context.pairEpoch, store, fresh,
  });
  const comp = await mk(memorySeqStore());
  eq('session: computer SENDS c2p', hex(comp._raw.send), V.traffic.computerToPhoneKeyHex);
  eq('session: computer RECEIVES p2c', hex(comp._raw.recv), V.traffic.phoneToComputerKeyHex);
  eq('session: send prefix is nc2p', hex(comp._raw.nc2p), V.noncePrefix.nc2pHex);

  const env = await comp.seal('SEND_SMS', new TextEncoder().encode('hello phone'));
  eq('session: seal emits an envelope', env.e, 1);
  eq('session: first frame is seq 0', env.s, 0);

  // The phone's half, built from the frozen primitives.
  const phoneKeys = await KDF.trafficKeys({ pairingId: PAIRING_ID, sessionKey: SK, context: ctx, role: 'phone' });
  const opened = await KDF.open({
    receiver: { ...phoneKeys.recv, sessionPrefix: prefixes.nc2p },
    frameType: 'SEND_SMS', kid: 'kid-01', seq: 0, pairEpoch: V.context.pairEpoch,
    ciphertext: fromBase64Url(env.c),
  });
  eq('session: the PHONE opens what the web sealed', new TextDecoder().decode(opened), 'hello phone');

  // ...and the reverse.
  const inbound = encodeEnvelope({
    kid: 'kid-01', seq: 3,
    ciphertext: await KDF.seal({
      sender: { ...phoneKeys.send, sessionPrefix: prefixes.np2c },
      frameType: 'SMS_RECEIVED', kid: 'kid-01', seq: 3, pairEpoch: V.context.pairEpoch,
      plaintext: new TextEncoder().encode('hello web'),
    }),
  });
  const got = await comp.open('SMS_RECEIVED', inbound);
  check('session: the web opens what the phone sealed', got.ok === true);
  eq('session: ...and recovers the plaintext', new TextDecoder().decode(got.plaintext), 'hello web');

  const dup = await comp.open('SMS_RECEIVED', inbound);
  check('session: a replayed frame is dropped', dup.ok === false);
  eq('session: ...with reason duplicate, NOT an error', dup.reason, 'duplicate');
  eq('session: ...and counted', comp.drops, 1);

  const wrongKid = await comp.open('SMS_RECEIVED', { ...inbound, kid: 'kid-99' });
  eq('session: a frame for another kid is dropped', wrongKid.reason, 'kid');
  const plaintextFrame = await comp.open('SMS_RECEIVED', { deviceName: 'Pixel' });
  eq('session: a PLAINTEXT frame is not an envelope (the caller decides)', plaintextFrame.reason, 'shape');
  const tampered = await comp.open('SMS_RECEIVED', { ...inbound, s: 4 });
  eq('session: a frame moved to another seq fails AUTH', tampered.reason, 'auth');
  const relabelled = await comp.open('CALL_STATUS', { ...inbound, s: 5 });
  eq('session: a frame relabelled to another type fails AUTH', relabelled.reason, 'auth');
  check('session: none of the drops threw', true);
}
// A session on a resumed kid with no counter refuses to construct — the same
// refusal, reached through the real entry point rather than bindKid directly.
await throws('session: constructing on a RESUMED kid with no counter REFUSES',
  () => createComputerSession({
    pairingId: PAIRING_ID, sessionKey: SK, context: ctx, kid: 'kid-01',
    pairEpoch: V.context.pairEpoch, store: memorySeqStore(), fresh: false,
  }),
  (e) => e instanceof SeqFailClosedError && e.rekey === true);

const total = passed + failed;
console.log(`e2e-web-session: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
