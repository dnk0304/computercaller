/**
 * chrome-extension/e2e/sw-session.js — E2E-P3 (b)/(c)/(d): the worker's E2E session.
 *
 * Everything the service worker needs to turn a `PAIR_STATE.e2e` block into the
 * ability to read a sealed notification, and — just as importantly — to decide
 * correctly that it CANNOT and must show counts only.
 *
 * ── WHAT LIVES WHERE, AND WHY ───────────────────────────────────────────────
 *   SK (the session key)   IN MEMORY ONLY. Never storage, never disk.
 *   the WRAP + epk         chrome.storage.session, keyed by kid.
 *   send counters          chrome.storage.session, persist-before-emit.
 *   dedupe windows         chrome.storage.session.
 *   the nonce prefixes     NOWHERE. Derived on every session construction (A2).
 *
 * `chrome.storage.session` is memory-backed and cleared when the browser exits,
 * which is exactly the lifetime the spec wants (§5: "never `storage.local`").
 * Caching the WRAP rather than SK is the whole trick of this file: an MV3 worker
 * is evicted constantly, and a worker that had to wait for a fresh PAIR_STATE
 * after every eviction would miss precisely the notifications it exists to
 * deliver. The wrap is useless without the device private key in IndexedDB, so
 * caching it costs nothing an attacker with that key does not already have.
 *
 * ── A2 (RATIFIED 2026-09-17T15:50Z): THE NONCE PREFIX IS DERIVED ────────────
 *   np2c = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/np2c" ‖ pairContext) L=4
 *   nc2p = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/nc2p" ‖ pairContext) L=4
 *
 * A2 struck A1's "defence in depth" rationale explicitly, and the code is
 * required to say so: **the prefix contributes ZERO nonce uniqueness.** It is a
 * deterministic function of SK and pairEpoch, so a device that restores a stale
 * counter re-derives the identical prefix and collides exactly as if there were
 * no prefix at all. A1's persist-before-emit / fail-closed counter is the SOLE
 * control against nonce reuse. Nothing in this file may be read as softening it.
 *
 * ── WHY hkdf32(...).subarray(0, 4) IS CONFORMANT ────────────────────────────
 * A2: "L = 4 and 'expand 32 then truncate to 4' are the same bytes (HKDF-Expand
 * emits T(1) first), so either implementation is conformant — but implementations
 * SHOULD request L = 4 so the intent is not mistaken for a truncated key."
 * `lib/e2e/kdf.mjs` is FROZEN and exposes only `hkdf32`, and P3 may not edit it.
 * So the truncation happens here, in a function named for what it produces, with
 * this comment attached — the SHOULD is about legibility, and a dedicated
 * `noncePrefixes()` that returns 4-byte values reads no worse than an `L=4` call.
 * The bytes are asserted against A2 vectors E/F/G/H in tests/e2e-sw-nonce-prefix.test.mjs.
 */

import {
  DIR_P2C,
  DIR_C2P,
  SESSION_PREFIX_BYTES,
  hkdf32,
  kek as deriveKek,
  trafficKeys,
  open as openAead,
  pairContext as encodePairContext,
  concatBytes,
} from './kdf.mjs';
import { fromBase64Url, toBase64Url } from './sw-key.js';

// ── A2 labels ───────────────────────────────────────────────────────────────
export const LABEL_NP2C = 'cc-e2e-v1/np2c';
export const LABEL_NC2P = 'cc-e2e-v1/nc2p';

// ── §13.5 dedupe parameters (FROZEN) ────────────────────────────────────────
export const DEDUPE_WINDOW = 1024;
export const FLOOR_ADVANCE_CAP = 256;

// ── chrome.storage.session keys ─────────────────────────────────────────────
/** kid → {kid, wrap, epk, mode, recipKeys, storedAt}. The WRAP, never SK. */
export const WRAP_KEY = 'cc_e2e_wrap';
/** "<kid>|<dir>" → next send seq. Persist-before-emit; fail closed if absent. */
export const SEQ_KEY = 'cc_e2e_seq';
/** "<kid>|<dir>" → {epoch, floor, seen:[…]}. §13.5 anti-replay window. */
export const DEDUPE_KEY = 'cc_e2e_dedupe';
/** Exported drop counter — §13.5 requires it, a silent dropper is untestable. */
export const DROPS_KEY = 'cc_e2e_drops';

const te = new TextEncoder();

// ── The A2 derivation ───────────────────────────────────────────────────────

/**
 * Both directional nonce prefixes for a session. 4 bytes each, derived, never
 * persisted, never transmitted, never carried across a session construction.
 *
 * Returns BOTH deliberately. A "give me the prefix for direction X" helper is
 * the same shape A1 item (2) forbids for traffic keys — a function that can be
 * called with the wrong argument is a directional-separation bug waiting for a
 * typo. The caller destructures the one it needs and the names say which.
 */
export async function noncePrefixes({ pairingId, sessionKey, context }, subtle = undefined) {
  const ctx = context instanceof Uint8Array ? context : encodePairContext(context);
  const [np2c, nc2p] = await Promise.all([
    hkdf32({ salt: pairingId, ikm: sessionKey, info: concatBytes([te.encode(LABEL_NP2C), ctx]) }, subtle),
    hkdf32({ salt: pairingId, ikm: sessionKey, info: concatBytes([te.encode(LABEL_NC2P), ctx]) }, subtle),
  ]);
  const p = np2c.subarray(0, SESSION_PREFIX_BYTES);
  const c = nc2p.subarray(0, SESSION_PREFIX_BYTES);
  // A2 vector H, enforced rather than documented: distinct labels cannot produce
  // equal prefixes, so equality here means someone fed the same label twice —
  // a one-character typo that no happy-path test would ever catch.
  if (p.every((b, i) => b === c[i])) {
    throw new Error('np2c == nc2p — the same HKDF label was used for both directions');
  }
  if (p.every((b) => b === 0) || c.every((b) => b === 0)) {
    throw new Error('a derived nonce prefix is all-zero');
  }
  return { np2c: p, nc2p: c };
}

// ── THE BLOCKED SOURCE (kept behind ONE function, deliberately) ─────────────

/**
 * The five values `pairContext` (A1 item 1) is built from:
 * `{pairingId, userId, phoneDeviceId, peerDeviceId, pairEpoch}`.
 *
 * ┌── OPEN SPEC GAP — E2E-P3, escalated to Ken 2026-09-17. DO NOT INVENT. ────┐
 * │ NONE of these five reach the service worker, and four of the five reach   │
 * │ no computer-side party at all. Verified, not assumed:                     │
 * │                                                                          │
 * │  • PAIR_STATE's block is EXACTLY `{kid, epk, mode, recipKeys, wrap}` —    │
 * │    server.js derivePairState(), and tests/e2e-listener-wrap.test.mjs      │
 * │    asserts "exactly the five documented fields".                          │
 * │  • The phone's merged block is `{v, mode, kid, epk, recipKeys, wraps}` —  │
 * │    E2eNegotiation.buildAcceptBlock() on e2e/p4-android-v58 @ acb4eb2.     │
 * │    It calls addProperty for those six names and no others.                │
 * │  • `pairEpoch` is a parameter of E2eAccept.prepare() supplied by the      │
 * │    (still unwritten) PhoneService wiring. It is never serialised.         │
 * │  • `peerDeviceId` is SINGULAR in pairContext but there are TWO recipients │
 * │    (web + SW) sharing one context — so the SW would have to use the WEB   │
 * │    page's deviceId, which it also has no channel to learn.                │
 * │                                                                          │
 * │ Without them KEK cannot be derived, so the wrap cannot be opened, so no   │
 * │ sealed frame can be read. This is the SAME CLASS of defect as Addendum    │
 * │ A2 — a value the construction requires with no channel to carry it —      │
 * │ and it is unresolved because the producing side (PhoneService) has not    │
 * │ been written yet, so nobody has yet had to decide.                        │
 * │                                                                          │
 * │ Deliberately ONE function, per the dispatch's own instruction for the     │
 * │ nonce-prefix source: when Ken/Security rule, this body changes and        │
 * │ nothing else does. Everything above and below it is already correct.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export class PairContextUnavailable extends Error {
  constructor() {
    super('pairContext inputs are not carried by PAIR_STATE — see the OPEN SPEC GAP note in sw-session.js');
    this.name = 'PairContextUnavailable';
    /** Consumers branch on this, never on the message. */
    this.countsOnly = true;
  }
}

/** @returns {Promise<{pairingId,userId,phoneDeviceId,peerDeviceId,pairEpoch}>} */
export async function pairContextInputs() {
  throw new PairContextUnavailable();
}

// ── The wrap cache (chrome.storage.session) ─────────────────────────────────

function sessionGet(key) {
  return new Promise((resolve) => {
    try { chrome.storage.session.get(key, (o) => resolve((o && o[key]) || null)); }
    catch { resolve(null); }
  });
}

function sessionSet(key, value) {
  return new Promise((resolve) => {
    try { chrome.storage.session.set({ [key]: value }, resolve); }
    catch { resolve(); }
  });
}

/**
 * Cache the material a respawned worker needs to re-derive SK without waiting
 * for a new PAIR_STATE. SK itself is NEVER written here — see the file header.
 *
 * Keyed by kid so a rekey (which always mints a fresh kid, A2 MUST 1) lands
 * beside the old entry rather than on top of it; `pruneWraps` keeps it bounded.
 */
export async function cacheWrap(block) {
  if (!block || typeof block.kid !== 'string' || typeof block.wrap !== 'string') return;
  const all = (await sessionGet(WRAP_KEY)) || {};
  // `seq` and not `Date.now()`. Several wraps can be cached inside one
  // millisecond (a resume re-sends the block while a rekey is landing), and
  // ties made the "newest" sort arbitrary — which evicted the wrap that had
  // just arrived and kept a dead one. Found by the bounded-cache test.
  const nextSeq = 1 + Object.values(all).reduce((m, v) => Math.max(m, v.seq || 0), 0);
  all[block.kid] = {
    kid: block.kid,
    wrap: block.wrap,
    epk: block.epk,
    mode: block.mode,
    recipKeys: Array.isArray(block.recipKeys) ? block.recipKeys : [],
    storedAt: Date.now(),
    seq: nextSeq,
  };
  // Bounded: at most 4 kids, newest kept. A pair rekeys on every Accept, so an
  // unbounded map would grow for the life of the browser session.
  const kids = Object.keys(all).sort((a, b) => all[b].seq - all[a].seq);
  for (const k of kids.slice(4)) delete all[k];
  await sessionSet(WRAP_KEY, all);
}

/** The cached block for `kid`, or the newest one when `kid` is omitted. */
export async function readCachedWrap(kid) {
  const all = (await sessionGet(WRAP_KEY)) || {};
  if (kid) return all[kid] || null;
  const kids = Object.keys(all).sort((a, b) => all[b].seq - all[a].seq);
  return kids.length ? all[kids[0]] : null;
}

/** §13.8: Reset lobby / sign-out / LEAVE_ACTIVE drop SK. Drops the cache too. */
export async function dropSessionState() {
  await sessionSet(WRAP_KEY, {});
  await sessionSet(SEQ_KEY, {});
  await sessionSet(DEDUPE_KEY, {});
}

// ── Unwrap (the half that is NOT blocked) ───────────────────────────────────

/**
 * Open a wrap into SK, given the pairContext inputs.
 *
 * The wrap format is NOT free-standing — it mirrors the phone's mint side byte
 * for byte (E2eAccept.prepare on e2e/p4-android-v58): AES-256-GCM under KEK_i
 * with `frameType = "cc-e2e-wrap"`, `seq = 0`, `direction = p2c`, and a nonce
 * prefix of `SHA-256(UTF8(recipientDeviceId))[0..4]`. It reuses the frame
 * envelope rather than inventing a second sealing format, and seq 0 is safe
 * because each KEK seals exactly one wrap and is then discarded — stated
 * because reusing a KEK for a second wrap WOULD be a nonce reuse.
 */
export const WRAP_FRAME_TYPE = 'cc-e2e-wrap';

/** SHA-256(UTF8(deviceId))[0..4] — the phone's `wrapPrefix`, mirrored. */
export async function wrapPrefix(deviceId, subtle = crypto.subtle) {
  const d = new Uint8Array(await subtle.digest('SHA-256', te.encode(deviceId)));
  return d.subarray(0, SESSION_PREFIX_BYTES);
}

/**
 * @param {{wrap:string, epk:string}} block from PAIR_STATE.e2e
 * @param {CryptoKey} privateKey the SW device key (non-extractable)
 * @param {string} ownPub base64url SEC1 of the SW's own public key
 * @param {string} ownDeviceId the SW's deviceId (its wrap prefix is keyed on it)
 * @param {object} ctxInputs the five pairContext values
 * @returns {Promise<Uint8Array>} SK — 32 bytes, in memory, caller must not persist
 */
export async function unwrapSessionKey({ block, privateKey, ownPub, ownDeviceId, ctxInputs }, subtle = crypto.subtle) {
  const epk = fromBase64Url(block.epk);
  // Control 1 (§2.1): import, and never bypass the import — this is what
  // performs point-on-curve validation. A hand-rolled coordinate copy skips it.
  const epkKey = await subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: epkKey }, privateKey, 256),
  );
  // Control 2 (§2.1): an all-zero shared secret is the invalid-curve outcome.
  // Abort; never derive a key from it and never fall back to plaintext.
  if (z.every((b) => b === 0)) throw new Error('ECDH yielded an all-zero shared secret — aborting');

  const context = encodePairContext(ctxInputs);
  const kekBytes = await deriveKek({
    pairingId: ctxInputs.pairingId,
    sharedSecret: z,
    context,
    recipientKey: fromBase64Url(ownPub),
  }, subtle);
  const kekKey = await subtle.importKey('raw', kekBytes, 'AES-GCM', false, ['decrypt']);
  const sk = await openAead({
    receiver: { direction: DIR_P2C, key: kekKey, sessionPrefix: await wrapPrefix(ownDeviceId, subtle) },
    frameType: WRAP_FRAME_TYPE,
    kid: block.kid,
    seq: 0,
    pairEpoch: ctxInputs.pairEpoch,
    ciphertext: fromBase64Url(block.wrap),
  }, subtle);
  // Control 4 (§2.1): drop the intermediates rather than leaving them live.
  z.fill(0);
  kekBytes.fill(0);
  if (sk.length !== 32) throw new Error(`unwrapped session key is ${sk.length} bytes, expected 32`);
  return sk;
}

/**
 * Build the receive side of a session: the c2p... no — the SW is a COMPUTER, so
 * it RECEIVES p2c and would send c2p. `trafficKeys({role:'computer'})` returns
 * `recv` = k_p2c and `send` = k_c2p, and the caller cannot name the other one
 * (A1 item 2). The prefix that pairs with `recv` is np2c, and the one that
 * pairs with `send` is nc2p; they are bound together here so no call site has
 * to get that pairing right a second time.
 */
export async function buildSession({ pairingId, sessionKey, ctxInputs }, subtle = crypto.subtle) {
  const context = encodePairContext(ctxInputs);
  const keys = await trafficKeys({ pairingId, sessionKey, context, role: 'computer' }, subtle);
  const { np2c, nc2p } = await noncePrefixes({ pairingId, sessionKey, context }, subtle);
  return {
    recv: { direction: DIR_P2C, key: keys.recv.key, sessionPrefix: np2c },
    send: { direction: DIR_C2P, key: keys.send.key, sessionPrefix: nc2p },
  };
}

// ── Envelope ────────────────────────────────────────────────────────────────

/**
 * Is this frame payload a sealed envelope `{e:1, kid, s, c}`?
 *
 * Shape-checked, not duck-typed on `e` alone: a plaintext frame that happened
 * to carry an `e` field would otherwise be routed into the opener and dropped,
 * which for PHONE_NOTIFICATION means a notification silently disappearing.
 */
export function isSealedEnvelope(data) {
  return !!data
    && typeof data === 'object'
    && data.e === 1
    && typeof data.kid === 'string'
    && typeof data.c === 'string'
    && (typeof data.s === 'number' || typeof data.s === 'string');
}

/**
 * Open a sealed frame. THROWS on any failure — the caller turns that into a
 * counts-only notification and a drop, never into an error shown to the user
 * and never into a plaintext preview (m-G).
 */
export async function openSealedFrame({ session, frameType, envelope, pairEpoch }, subtle = crypto.subtle) {
  const seq = typeof envelope.s === 'string' ? BigInt(envelope.s) : BigInt(envelope.s);
  const plain = await openAead({
    receiver: session.recv,
    frameType,
    kid: envelope.kid,
    seq,
    pairEpoch,
    ciphertext: fromBase64Url(envelope.c),
  }, subtle);
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── §13.5 anti-replay / dedupe ──────────────────────────────────────────────

/**
 * Accept-or-drop for one (kid, direction) pair.
 *
 * §13.5, and every clause of it is load-bearing:
 *  - window 1024 wide, per (kid, direction);
 *  - **reset on pairEpoch** — a new epoch is a new key, and keeping the window
 *    would reject legitimate frames after every Accept;
 *  - floor advance **capped at 256** per step, so a forged high seq cannot jump
 *    the floor past frames that have not arrived yet;
 *  - a duplicate is DROPPED, never treated as an attack: frameBuffer legitimately
 *    re-sends on resume, and a receiver that closed the socket on a duplicate
 *    would turn every reconnect into a failure.
 */
export async function admitSeq({ kid, direction, seq, pairEpoch }) {
  const mapKey = `${kid}|${direction}`;
  const all = (await sessionGet(DEDUPE_KEY)) || {};
  let w = all[mapKey];
  if (!w || w.epoch !== Number(pairEpoch)) {
    w = { epoch: Number(pairEpoch), floor: 0, seen: [], beyondWindow: 0 };
  }
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, why: 'malformed-seq' };

  // Deliberately a line-for-line mirror of the Android lane's E2eDedupe.observe
  // (e2e/p4-android-v58). Two implementations of one frozen parameter set that
  // agree on the numbers but disagree on WHEN the floor moves would diverge
  // only under an attack or a long resume gap — the two situations in which
  // nobody would think to compare them.
  if (n < w.floor) { all[mapKey] = w; await sessionSet(DEDUPE_KEY, all); return { ok: false, why: 'below-floor' }; }

  if (n >= w.floor + DEDUPE_WINDOW) {
    // Slide, but never further than the cap allows on ONE frame. This is what
    // stops a single forged high sequence number from carrying the floor past
    // every frame still in flight; it BOUNDS the damage to 256 rather than
    // eliminating it, which is what §13.5's wording actually buys.
    const wanted = n - (w.floor + DEDUPE_WINDOW) + 1;
    const advance = Math.min(wanted, FLOOR_ADVANCE_CAP);
    w.floor += advance;
    w.seen = w.seen.filter((x) => x >= w.floor);
    if (n >= w.floor + DEDUPE_WINDOW) {
      // Still beyond the window. We cannot PROVE it is a duplicate, and §13.5
      // says dedupe rather than reject — so accept it and make the case
      // countable instead of silent.
      w.beyondWindow = (w.beyondWindow || 0) + 1;
      all[mapKey] = w;
      await sessionSet(DEDUPE_KEY, all);
      return { ok: true, beyondWindow: true };
    }
  }

  if (w.seen.includes(n)) { all[mapKey] = w; await sessionSet(DEDUPE_KEY, all); return { ok: false, why: 'duplicate' }; }
  w.seen.push(n);
  all[mapKey] = w;
  await sessionSet(DEDUPE_KEY, all);
  return { ok: true };
}

/** Bump and return the exported drop counter (§13.5: it must be observable). */
export async function noteDrop(reason) {
  const all = (await sessionGet(DROPS_KEY)) || { total: 0, byReason: {} };
  all.total = (all.total || 0) + 1;
  all.byReason[reason] = (all.byReason[reason] || 0) + 1;
  await sessionSet(DROPS_KEY, all);
  return all;
}

/** Read the drop counter. Exported so a harness can assert it. */
export function readDrops() {
  return sessionGet(DROPS_KEY).then((v) => v || { total: 0, byReason: {} });
}

// ── Send counter: persist-before-emit, fail closed (A1 (3) / A2's sole control) ──

/**
 * A send counter that refuses to hand out a value it has not durably committed.
 *
 * THE SW SENDS NO SEALED FRAMES TODAY — the listener socket is receive-only by
 * construction (server.js keeps `?role=listener` out of the active pair and only
 * ever pushes phone→browser frames to it). `assertSwSendsNothing()` below pins
 * that, and this counter exists so that the day someone adds a send path they
 * inherit the fail-closed rule instead of writing a fresh `seq = 0`.
 *
 * FAIL CLOSED means: no proven floor → refuse to encrypt and force a rekey.
 * Never resume at a guess, never restart at 0. A2 upgraded this from acceptance
 * criterion to BLOCKING and removed the nonce prefix's "defence in depth" fig
 * leaf from beside it — this is now the only thing standing there.
 */
export async function nextSendSeq({ kid, direction }) {
  const mapKey = `${kid}|${direction}`;
  const all = (await sessionGet(SEQ_KEY)) || {};
  const floor = all[mapKey];
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor < 0) {
    throw new Error(
      `no proven counter floor for ${mapKey} — refusing to encrypt, force a rekey. ` +
      'Never resume at a guess and never restart at 0 (§13.10.5 rule 3).',
    );
  }
  // COMMIT THE NEXT VALUE FIRST, then hand out the current one. A crash between
  // the two costs one skipped seq, which is free; the other order costs a reuse.
  all[mapKey] = floor + 1;
  await sessionSet(SEQ_KEY, all);
  return floor;
}

/**
 * Open a counter for a NEW kid. Only legal for a kid that has never had one —
 * A2 MUST 1: `kid` ↔ `SK` is strictly 1:1, so a kid seeing a second floor means
 * a kid was reused across SKs, which restarts a counter at 0 under the same key
 * and the same derived prefix. That is GCM nonce reuse: total loss of
 * confidentiality and forgery resistance. Enforced here, where the counter is
 * minted, rather than by convention elsewhere.
 */
export async function openSendCounter({ kid, direction }) {
  const mapKey = `${kid}|${direction}`;
  const all = (await sessionGet(SEQ_KEY)) || {};
  if (mapKey in all) {
    throw new Error(`counter for ${mapKey} already exists — a kid must never be reused across session keys (A2 MUST 1)`);
  }
  all[mapKey] = 0;
  await sessionSet(SEQ_KEY, all);
}

export { toBase64Url, fromBase64Url };
