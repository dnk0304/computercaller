/**
 * tests/e2e-a41-room-reset.test.mjs — E2E-P6 deliverable (b): GATE1 Addendum
 * A4.1's informational finding, turned into an executable scenario.
 *
 * THE FINDING, VERBATIM
 * ---------------------
 *   "A relay-position attacker can erase the TOFU pin at will: ROOM_RESET
 *    arrives on the wire and calls clearOwnPairingId() (background.js L1315).
 *    Forge a ROOM_RESET, then present a new epoch's ctx bearing any pairingId,
 *    and the TOFU branch pins it with no comparison. Clause (a) therefore has
 *    NO adversarial strength against the threat model it sits in. This is
 *    acceptable *only* because clause (b) is untouched: the own wrap must open
 *    under KEK(ctx, own static key), ctx binds pairingId, so a foreign
 *    pairingId fails the unwrap → setAborted() (A4-M3, sticky), never
 *    counts-only, never plaintext. The same ROOM_RESET also calls
 *    clearAborted(); that is survivable because the next block re-fails the
 *    unwrap and re-aborts, and because both landing states (abort, counts-only)
 *    hide bodies. Severity: Informational. No fix dispatched."
 *
 * THIS FILE DOCUMENTS REALITY RATHER THAN WISHING IT AWAY
 * ------------------------------------------------------
 * Checks 2 and 3b below assert that the WEAKNESS IS STILL PRESENT — the pin is
 * erasable, and the attacker's pairingId IS re-pinned. That is deliberate and
 * it is the only honest shape for an accepted-risk finding: if either of those
 * assertions goes RED, the finding has been FIXED and this file says so loudly
 * rather than quietly passing. A test that asserted the wish ("the pin is not
 * erasable") would be red today and would be deleted by the next person.
 *
 * The load-bearing assertions are 3a, 4 and 5: clause (b) refuses, the abort is
 * sticky, and the pin is NON-AUTHORITATIVE (A4.1-M2) — a MATCHING pin with a
 * failing wrap must still abort. Those are what make the finding informational
 * instead of critical, and those are the ones that must never go red.
 *
 * WHAT IS REAL HERE. `chrome-extension/e2e/sw-session.js` is IMPORTED and
 * driven — real P-256 ECDH, a real KEK, a real AES-256-GCM wrap minted the way
 * the phone mints it. The only thing modelled is background.js's three-branch
 * disposition (ctx-refused → counts-only, unwrap-failed → ABORT, ok → session),
 * and the model is anchored to the shipped file by source assertions so it
 * cannot drift into being a description of a program nobody runs.
 *
 * Run: node tests/e2e-a41-room-reset.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

// ── Fake chrome.storage — a REAL one. The pin lives in storage.session and the
// epoch floor in storage.local; a stub that answered {} would make every
// pairingId a first sight and every epoch admissible, i.e. it would make the
// whole file green by removing the state it is about.
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
const K = await import('../chrome-extension/e2e/kdf.mjs');
const SW = await import('../chrome-extension/e2e/sw-session.js');

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
/** For an accepted-risk assertion: a RED here means the finding was FIXED. */
function stillTrue(cond, what) {
  if (!cond) {
    throw new Error(
      `A4.1 FINDING APPEARS TO BE FIXED — ${what}. This is GOOD NEWS, not a regression. ` +
      'Re-read GATE1 Addendum A4.1, confirm the fix, then update this file to assert the new behaviour.',
    );
  }
}

const USER_ID = 'user-a41';
const PHONE_DEVICE_ID = 'phone-a41';
const OWN_DEVICE_ID = 'sw-a41';
const LEGIT_PAIRING = 'pairing-legit-a41';
const ATTACKER_PAIRING = 'pairing-attacker-a41';

// ── The SW's own static device key. NON-EXTRACTABLE private half, exactly as
// loadOrCreateDeviceKey() produces it — clause (b) is only a membership proof
// if the key really is ours and really cannot leave.
const ownKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const ownPubRaw = new Uint8Array(await subtle.exportKey('raw', ownKeys.publicKey));
eq(ownPubRaw.length, 65, 'the SW public key must be SEC1 uncompressed (65 bytes)');
const ownPubB64 = SW.toBase64Url(ownPubRaw);

function ctxFor(pairingId, pairEpoch) {
  return { pairingId, phoneDeviceId: PHONE_DEVICE_ID, peerDeviceId: OWN_DEVICE_ID, pairEpoch: String(pairEpoch) };
}

/**
 * Mint a wrap exactly the way the phone does: ECDH(epk, SW static pub) → KEK
 * bound to (pairingId, pairContext, recipient key), then AES-256-GCM over SK
 * with frameType "cc-e2e-wrap", seq 0, direction p2c, prefix
 * SHA-256(UTF8(recipientDeviceId))[0..4].
 *
 * `ctxValues` is what the MINTER believed. The block's advertised ctx is a
 * separate argument, so the attacker case — a block whose ctx does not match
 * the ctx the wrap was minted under — is expressible rather than assumed.
 */
async function mintBlock({ kid, sk, mintCtx, wireCtx, recipientPub = ownPubRaw, recipientDeviceId = OWN_DEVICE_ID, mode = 1 }) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const peer = await subtle.importKey('raw', recipientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
  const context = K.pairContext({
    userId: USER_ID,
    phoneDeviceId: mintCtx.phoneDeviceId,
    peerDeviceId: mintCtx.peerDeviceId,
    pairEpoch: BigInt(mintCtx.pairEpoch),
  });
  const kekBytes = await K.kek({ pairingId: mintCtx.pairingId, sharedSecret: z, context, recipientKey: recipientPub }, subtle);
  const kekKey = await subtle.importKey('raw', kekBytes, 'AES-GCM', false, ['encrypt']);
  const wrap = await K.seal({
    sender: { direction: K.DIR_P2C, key: kekKey, sessionPrefix: await SW.wrapPrefix(recipientDeviceId, subtle) },
    frameType: SW.WRAP_FRAME_TYPE,
    kid,
    seq: 0,
    pairEpoch: BigInt(mintCtx.pairEpoch),
    plaintext: sk,
  }, subtle);
  return {
    mode,
    kid,
    epk: SW.toBase64Url(new Uint8Array(await subtle.exportKey('raw', eph.publicKey))),
    wrap: SW.toBase64Url(wrap),
    ctx: wireCtx ?? ctxFor(mintCtx.pairingId, mintCtx.pairEpoch),
  };
}

// ── The modelled half: background.js's ensureSession() disposition. ──────────
// Three branches, and the split between them IS A4-M3: a ctx refusal degrades
// to counts-only, a WRAP that does not open ABORTS. Anchored to the shipped
// file by `check` #0 below, so this cannot become fiction.
const sw = {
  mode: 'off', why: null, abortedKid: null, session: null, plaintextEverProduced: false, bodiesRendered: 0,
};
function setCountsOnly(why) { sw.mode = 'counts-only'; sw.why = why; sw.session = null; }
function setAborted(why, kid) { sw.mode = 'aborted'; sw.why = why; sw.abortedKid = kid || null; sw.session = null; }
function clearAborted() { if (sw.mode !== 'aborted') return; sw.mode = 'off'; sw.why = null; sw.abortedKid = null; }

/** background.js noteE2eBlock() + ensureSession(), over the REAL SW functions. */
async function presentBlock(block) {
  // A4-M3's release valve, verbatim from background.js L1368.
  if (sw.mode === 'aborted' && block.kid !== sw.abortedKid) clearAborted();
  if (sw.mode === 'aborted' && block.kid === sw.abortedKid) return { disposition: 'aborted-sticky' };

  let ctxInputs;
  try {
    ctxInputs = await SW.pairContextInputs({ block, userId: USER_ID });
  } catch (e) {
    setCountsOnly(e instanceof SW.CtxRefused ? `ctx:${e.message}` : (e && e.message) || 'ctx-failed');
    return { disposition: 'counts-only', reason: sw.why };
  }
  let sk;
  try {
    sk = await SW.unwrapSessionKey({
      block, privateKey: ownKeys.privateKey, ownPub: ownPubB64, ownDeviceId: OWN_DEVICE_ID, ctxInputs,
    }, subtle);
  } catch (e) {
    // BRANCH 2 — clause (b). A wrap that does not open is an ABORT, never a
    // degrade. Nothing decrypted, so nothing to leak.
    setAborted(`unwrap:${(e && e.message) || 'failed'}`, block.kid);
    return { disposition: 'aborted', reason: sw.why };
  }
  sw.session = await SW.buildSession({ pairingId: ctxInputs.pairingId, sessionKey: sk, ctxInputs }, subtle);
  sw.mode = 'open';
  sw.why = null;
  return { disposition: 'open', sk };
}

/** The wire-arrived ROOM_RESET handler, background.js L1434-1441. */
async function roomReset() {
  await SW.dropSessionState();
  await SW.clearOwnPairingId();
  clearAborted();
  sw.session = null;
}

const KID_LEGIT = 'kid-a41-legit';
const KID_ATTACK = 'kid-a41-attacker';
const SK_LEGIT = new Uint8Array(32).fill(0x5a);
const SK_ATTACK = new Uint8Array(32).fill(0x77);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA4.1 — ROOM_RESET erases the TOFU pin; clause (b) is what holds');

await check('0. the MODEL is anchored: background.js really does split ctx-refusal from unwrap-failure, and ROOM_RESET really does clear both', async () => {
  const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  assert(/setCountsOnly\(e instanceof CtxRefused/.test(bg), 'a ctx refusal must land in counts-only');
  assert(/setAborted\(`unwrap:/.test(bg), 'an unwrap failure must land in setAborted (A4-M3)');
  assert(/if \(e2eMode === 'aborted' && block\.kid !== e2eAbortedKid\) clearAborted\(\);/.test(bg),
    'the abort must be pinned to the failing kid');
  const at = bg.indexOf("if (type === 'ROOM_RESET') {");
  assert(at !== -1, 'the ROOM_RESET handler must exist');
  const reset = bg.slice(at, bg.indexOf('\n    return;', at));
  assert(/clearOwnPairingId\(\)/.test(reset), 'ROOM_RESET calls clearOwnPairingId — the finding names this line');
  assert(/clearAborted\(\)/.test(reset), 'ROOM_RESET also calls clearAborted — the finding names this too');
  assert(/dropSessionState\(\)/.test(reset), 'and it drops the cached wrap');
  // The whole premise: this handler is reached from an inbound WIRE frame, with
  // no authentication of any kind on the frame itself.
  assert(/const type = /.test(bg) && /ROOM_RESET/.test(bg), 'ROOM_RESET is dispatched on the inbound frame `type`');
});

await check('1. clause (a): the own-pairingId TOFU PINS on first sight of a new epoch, and every later ctx in that epoch must MATCH', async () => {
  swLocal = {}; swSession = {};
  const inputs = await SW.pairContextInputs({ block: { mode: 1, ctx: ctxFor(LEGIT_PAIRING, 8) }, userId: USER_ID });
  eq(inputs.pairingId, LEGIT_PAIRING, 'the first ctx of the epoch is admitted');
  const pin = await SW.readOwnPairingId();
  eq(pin.pairingId, LEGIT_PAIRING, 'pinned pairingId');
  eq(pin.pairEpoch, '8', 'pinned epoch');
  eq(pin.source, 'tofu', 'pin source');

  // A later ctx in the SAME epoch with a DIFFERENT pairingId: REFUSED.
  // Driven through `admitOwnPairingId` directly rather than through
  // `pairContextInputs`, and the reason is a FINDING, asserted next door in
  // check 1b: inside one epoch `pairContextInputs` never reaches the pin
  // comparison, because A3-M2's epoch floor refuses `pairEpoch <= floor` first.
  let refused = null;
  try {
    await SW.admitOwnPairingId({ known: await SW.readOwnPairingId(), pairingId: ATTACKER_PAIRING, pairEpoch: 8n });
  } catch (e) { refused = e; }
  assert(refused instanceof SW.CtxRefused, `a drifting pairingId inside one epoch must be refused, got ${refused}`);
  assert(/not the one TOFU-pinned/.test(refused.message), `refusal message: ${refused && refused.message}`);
  eq((await SW.readOwnPairingId()).pairingId, LEGIT_PAIRING, 'and the pin must NOT have moved');

  // The consistent case is admitted and leaves the pin alone.
  await SW.admitOwnPairingId({ known: await SW.readOwnPairingId(), pairingId: LEGIT_PAIRING, pairEpoch: 8n });
  eq((await SW.readOwnPairingId()).pairingId, LEGIT_PAIRING, 'a consistent later ctx keeps the pin');
});

await check('1b. FINDING — inside ONE epoch the pin comparison is UNREACHABLE via pairContextInputs: A3-M2 refuses first', async () => {
  // A3-M2 says "refuse pairEpoch <= floor", and admitEpoch implements exactly
  // that (sw-session.js admitEpoch). admitOwnPairingId runs FIRST, so a second
  // block in the SAME epoch is pinned/compared and then refused by the floor —
  // which means A4.1 clause (a)'s "every later ctx in that epoch must match"
  // can never decide anything on this path. Reported, not fixed.
  let e = null;
  try {
    await SW.pairContextInputs({ block: { mode: 1, ctx: ctxFor(LEGIT_PAIRING, 8) }, userId: USER_ID });
  } catch (err) { e = err; }
  assert(e instanceof SW.CtxRefused, 'a repeat of the SAME epoch is refused outright');
  assert(/not above the floor/.test(e.message),
    `the refusal comes from the epoch floor, not the pin — got: ${e && e.message}`);
});

await check('1c. A3-M4: a mode=1 block with NO ctx is REFUSED, never derived from local values', async () => {
  let e = null;
  try { await SW.pairContextInputs({ block: { mode: 1 }, userId: USER_ID }); } catch (err) { e = err; }
  assert(e instanceof SW.CtxRefused, 'a mode=1 block with no ctx must be refused');
  assert(/no ctx/.test(e.message), `refusal message: ${e && e.message}`);
});

await check('2. FINDING STILL TRUE: a wire ROOM_RESET erases the pin AND clears the abort — no authentication required', async () => {
  // Precondition: something is pinned and the worker is aborted.
  setAborted('unwrap:seeded-for-this-check', KID_LEGIT);
  eq((await SW.readOwnPairingId()).pairingId, LEGIT_PAIRING, 'pinned before the reset');
  eq(sw.mode, 'aborted', 'aborted before the reset');

  await roomReset();   // forged by a relay-position attacker; indistinguishable on the wire

  stillTrue((await SW.readOwnPairingId()) === null, 'the TOFU pin survived a forged ROOM_RESET');
  stillTrue(sw.mode !== 'aborted', 'the sticky abort survived a forged ROOM_RESET');
  // Clause (a) therefore has NO adversarial strength: the attacker chose when
  // the pin exists. Everything that follows is about clause (b).
});

await check('3a. LOAD-BEARING — a foreign ctx after the reset FAILS the own-wrap unwrap ⇒ STICKY ABORT, never counts-only', async () => {
  // The attacker presents a NEW epoch (the A3-M2 floor forbids <= the old one)
  // bearing HIS pairingId, carrying the wrap he intercepted from the legitimate
  // pairing. ctx binds pairingId, so the KEK the SW derives is not the KEK the
  // wrap was sealed under.
  const legitWrapBlock = await mintBlock({
    kid: KID_ATTACK,
    sk: SK_LEGIT,
    mintCtx: ctxFor(LEGIT_PAIRING, 9),          // minted for the REAL pairing
    wireCtx: ctxFor(ATTACKER_PAIRING, 9),       // advertised under the ATTACKER's
  });
  const r = await presentBlock(legitWrapBlock);
  eq(r.disposition, 'aborted', 'a foreign pairingId must ABORT');
  assert(/^unwrap:/.test(sw.why), `the abort must come from the UNWRAP, not from a ctx refusal — got ${sw.why}`);
  eq(sw.mode, 'aborted', 'mode');
  assert(sw.mode !== 'counts-only', 'A4-M3: clause (b) failing must never degrade to counts-only');
  eq(sw.session, null, 'no session may exist after an abort');
  eq(sw.plaintextEverProduced, false, 'NO PLAINTEXT may ever be produced on this path');
  eq(sw.bodiesRendered, 0, 'no body may be rendered');
});

await check('3b. FINDING STILL TRUE (and harmless): the attacker\'s pairingId IS re-pinned by the TOFU branch, with no comparison', async () => {
  // The finding's own words: "present a new epoch's ctx bearing any pairingId,
  // and the TOFU branch pins it with no comparison."
  //
  // NOTE FOR THE RECORD — the P6 (b) dispatch asked this file to assert "there
  // is NO re-pin to the attacker's pairing". The CODE does re-pin
  // (sw-session.js admitOwnPairingId, the final `sessionSet(...source:'tofu')`
  // line), which is exactly what A4.1 describes. The dispatch text and the code
  // disagree; the code and the FINDING agree, so the finding is what is
  // asserted here and the divergence is reported rather than papered over.
  const pin = await SW.readOwnPairingId();
  stillTrue(pin !== null && pin.pairingId === ATTACKER_PAIRING,
    'the attacker\'s pairingId was NOT re-pinned by the TOFU branch');
  eq(pin.source, 'tofu', 'and it is pinned with no comparison, as TOFU');
  // Harmless for exactly one reason, asserted next door: the pin decides
  // nothing. 3a already aborted, and 5 proves the pin is not consulted.
});

await check('4. LOAD-BEARING — the abort is STICKY across a later legitimate-looking block in the same epoch', async () => {
  eq(sw.mode, 'aborted', 'precondition: still aborted from 3a');
  // (a) the SAME kid — a resume or a replay of the broken block: unchanged.
  const replay = await presentBlock({ mode: 1, kid: KID_ATTACK, wrap: 'AAAA', epk: 'AAAA', ctx: ctxFor(ATTACKER_PAIRING, 9) });
  eq(replay.disposition, 'aborted-sticky', 'the same kid must stay aborted without re-running anything');
  eq(sw.mode, 'aborted', 'still aborted');

  // (b) a DIFFERENT kid clears the abort (A4-M3's release valve) — and then
  // clause (b) re-fails and RE-ABORTS. This is the finding's "survivable"
  // clause, and it is only survivable if the re-abort actually happens.
  const anotherForgery = await mintBlock({
    kid: 'kid-a41-attacker-2',
    sk: SK_ATTACK,
    mintCtx: ctxFor(LEGIT_PAIRING, 10),
    wireCtx: ctxFor(ATTACKER_PAIRING, 10),
  });
  const r = await presentBlock(anotherForgery);
  eq(r.disposition, 'aborted', 'the next forged block must RE-ABORT');
  assert(/^unwrap:/.test(sw.why), `re-abort must be an unwrap failure, got ${sw.why}`);
  eq(sw.plaintextEverProduced, false, 'still no plaintext');
});

await check('5. LOAD-BEARING (A4.1-M2) — clause (a) is NON-AUTHORITATIVE: a MATCHING pin with a failing wrap must STILL abort', async () => {
  // This is the whole point of the finding being informational. Construct the
  // case the pin would "approve": the pin matches, the epoch is fresh, the ctx
  // is internally consistent — and the wrap is addressed to SOMEONE ELSE.
  swLocal = {}; swSession = {};
  sw.mode = 'off'; sw.why = null; sw.abortedKid = null; sw.session = null;

  const strangerKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const strangerPub = new Uint8Array(await subtle.exportKey('raw', strangerKeys.publicKey));
  const block = await mintBlock({
    kid: 'kid-a41-pin-matches',
    sk: SK_LEGIT,
    mintCtx: ctxFor(LEGIT_PAIRING, 11),
    wireCtx: ctxFor(LEGIT_PAIRING, 11),
    recipientPub: strangerPub,                 // wrapped for a DIFFERENT device
    recipientDeviceId: 'some-other-computer',
  });
  const r = await presentBlock(block);
  const pin = await SW.readOwnPairingId();
  eq(pin.pairingId, LEGIT_PAIRING, 'precondition: the pin MATCHES the presented ctx');
  eq(r.disposition, 'aborted', 'a matching pin must not rescue a wrap that does not open');
  assert(/^unwrap:/.test(sw.why), `the decision must come from the unwrap, got ${sw.why}`);
  eq(sw.session, null, 'no session');
  eq(sw.plaintextEverProduced, false, 'no plaintext');

  // And structurally: nothing in the decision path gates on the pin. The pin's
  // only output is a CtxRefused (branch 1, counts-only); it can never produce
  // an "approved" that skips the unwrap.
  const sws = readFileSync(join(ROOT, 'chrome-extension/e2e/sw-session.js'), 'utf8');
  const fn = /export async function admitOwnPairingId\(([\s\S]*?)\n\}/.exec(sws);
  assert(fn, 'admitOwnPairingId must exist');
  assert(!/return true|approved|trusted/i.test(fn[1]), 'the pin must not emit an approval token');
  const bg = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  assert(!/readOwnPairingId\(\)[\s\S]{0,200}?(skip|bypass|trust)/i.test(bg),
    'no decision in background.js may be gated on the pin alone');
});

await check('6. a LEGITIMATE ROOM_RESET and re-pair: re-TOFU is survivable, clause (b) is untouched, the pair RECOVERS', async () => {
  await roomReset();
  eq(await SW.readOwnPairingId(), null, 'a real reset clears the pin too — same code path, no way to tell them apart');
  sw.mode = 'off'; sw.why = null; sw.abortedKid = null;

  // A genuine re-pair: a new epoch, a NEW pairingId (a real re-pair mints one),
  // and a wrap genuinely addressed to this device.
  const NEW_PAIRING = 'pairing-legit-a41-v2';
  const fresh = await mintBlock({
    kid: 'kid-a41-repair',
    sk: SK_LEGIT,
    mintCtx: ctxFor(NEW_PAIRING, 12),
    wireCtx: ctxFor(NEW_PAIRING, 12),
  });
  const r = await presentBlock(fresh);
  eq(r.disposition, 'open', `the legitimate re-pair must recover, got ${r.disposition} (${sw.why})`);
  eq(K.toHex(r.sk), K.toHex(SK_LEGIT), 'and it must recover the SK the phone actually minted');
  eq(sw.mode, 'open', 'mode');
  const pin = await SW.readOwnPairingId();
  eq(pin.pairingId, NEW_PAIRING, 're-TOFU pinned the new pairing');
  eq(pin.pairEpoch, '12', 'at the new epoch');

  // The epoch floor — the check that IS load-bearing against nonce reuse — did
  // NOT get cleared by the reset, and still refuses a replayed old epoch.
  let stale = null;
  try {
    await SW.pairContextInputs({ block: { mode: 1, ctx: ctxFor(NEW_PAIRING, 9) }, userId: USER_ID });
  } catch (e) { stale = e; }
  assert(stale instanceof SW.CtxRefused, 'a replayed OLD epoch must still be refused after a ROOM_RESET (A3-M2)');
  assert(/not above the floor/.test(stale.message), `refusal message: ${stale && stale.message}`);
});

await check('7. the ABORT landing state hides bodies: a stripped plaintext body is DROPPED, exactly as in mode-OPEN', async () => {
  // A4-M3's premise, and the reason an abort is an acceptable landing state.
  // `inboundDisposition` groups 'aborted' with 'open', NOT with 'counts-only':
  // in an aborted pairing the PHONE is still sealing, so a sealed-required type
  // arriving in the clear is a STRIP, not the ordinary un-paired case.
  //
  // NOTE, precisely: the finding says "both landing states (abort, counts-only)
  // hide bodies". They do, but by DIFFERENT mechanisms, and the code is explicit
  // about it (sw-session.js, inboundDisposition): an aborted worker DROPS a
  // stripped plaintext frame, whereas a counts-only worker still DELIVERS
  // plaintext (that is how an un-paired install works) and hides bodies only
  // because it holds no SK and so cannot open the sealed ones. Asserting one
  // rule for both would be an assertion that does not match the code.
  eq(SW.inboundDisposition({ mode: 'aborted', frameType: 'SMS_RECEIVED', data: { body: 'secret' } }),
    SW.INBOUND_DROP_PLAINTEXT, 'an aborted worker must DROP a plaintext body');
  eq(SW.inboundDisposition({ mode: 'open', frameType: 'SMS_RECEIVED', data: { body: 'secret' } }),
    SW.INBOUND_DROP_PLAINTEXT, 'a mode-OPEN worker must DROP a plaintext body');
  eq(SW.inboundDisposition({ mode: 'counts-only', frameType: 'SMS_RECEIVED', data: { body: 'x' } }),
    SW.INBOUND_DELIVER, 'counts-only still delivers plaintext — it hides bodies by holding no key, not by dropping');
  // A sealed envelope always routes to the opener FIRST, so an aborted worker
  // can never render one: it has no session to open it with.
  eq(SW.inboundDisposition({ mode: 'aborted', frameType: 'SMS_RECEIVED', data: { e: 1, kid: 'k', s: 0, c: 'AA' } }),
    SW.INBOUND_UNSEAL, 'a sealed frame is routed to the opener, never rendered as-is');
  assert(SW.requiresSeal('SMS_RECEIVED'), 'SMS_RECEIVED is in the sealed allowlist');
  assert(!SW.requiresSeal('GET_MESSAGES'), 'GET_MESSAGES is mandatorily plaintext (billing enforcement)');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
process.exit(0);
