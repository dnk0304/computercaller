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

// ── A3: the pairContext channel (RATIFIED (A), AMENDED — 2026-09-17T23:41Z) ─

/**
 * The epoch floor store. `chrome.storage.LOCAL`, not session — and that choice
 * is the whole point of A3-M2.
 *
 * A replayed `ACCEPT_PAIRING` reinstalls a superseded SK under its old epoch,
 * and A2's per-(kid,direction) counter then restarts at 0 against a key and a
 * derived prefix that have already sealed frames — GCM nonce reuse, the one
 * failure in this protocol whose cost is total. A floor kept in
 * `storage.session` would be cleared by a browser restart, so the replay would
 * simply have to wait for one. It must outlive the browser; it lives in
 * `storage.local`.
 *
 * Keyed by (userId, phoneDeviceId). Cleared ONLY by an explicit user unpair /
 * revoke / sign-out — NEVER by a value arriving on the wire.
 */
export const EPOCH_FLOOR_KEY = 'cc_e2e_epoch_floor';

/** A3's exact grammar for pairEpoch. No sign, no leading zeros, no whitespace. */
const EPOCH_RE = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const MAX_ID_BYTES = 255;

export class CtxRefused extends Error {
  constructor(why) {
    super(`e2e ctx refused: ${why}`);
    this.name = 'CtxRefused';
    this.why = why;
    /** Every refusal lands in counts-only — never in a plaintext fallback. */
    this.countsOnly = true;
  }
}

function localGet(key) {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(key, (o) => resolve((o && o[key]) || null)); }
    catch { resolve(null); }
  });
}
function localSet(key, value) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ [key]: value }, resolve); }
    catch { resolve(); }
  });
}

const utf8Len = (v) => te.encode(v).length;

/**
 * Parse `ctx.pairEpoch`. A3: DECIMAL STRING, parsed with BigInt, never Number.
 *
 * `JSON.parse` turns a JSON number into a double and A1 already forbids
 * `pairEpoch` rounding above 2^53 — so a number here is refused outright rather
 * than accepted-and-rounded. `Number()` appears nowhere on this path: it would
 * happily take `" 42"`, `"042"`, `"4.2"` and `"-1"` and coerce four distinct
 * wire values into one epoch, which is precisely the silent agreement A3 exists
 * to prevent.
 */
export function parseEpoch(raw) {
  if (typeof raw === 'number') throw new CtxRefused('pairEpoch is a JSON number; it MUST be a decimal string');
  if (typeof raw !== 'string') throw new CtxRefused('pairEpoch is missing or not a string');
  if (!EPOCH_RE.test(raw)) throw new CtxRefused(`pairEpoch ${JSON.stringify(raw)} does not match the A3 grammar`);
  const v = BigInt(raw);
  if (v > U64_MAX) throw new CtxRefused('pairEpoch exceeds 2^64-1');
  return v;
}

/**
 * Validate the transmitted `ctx` and combine it with the LOCAL userId.
 *
 * `userId` is deliberately NOT on the wire (A3). Each side uses its own
 * authenticated session identity, so a mismatch fails closed — transmitting it
 * would let the relay propose an identity, and the derivation would then agree
 * with the relay instead of with the session. Vector I.3 pins the consequence:
 * one character of userId drift gives total key divergence.
 */
export function validateCtx({ ctx, mode, ownDeviceId, userId, pairingId = null }) {
  // A3-M4: a mode=1 block with NO ctx is REFUSED, never derived from local
  // values. Deriving from a locally guessed context is the silent divergence
  // A3 exists to kill, and it would let a stripping relay force both sides
  // into a guess.
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
    throw new CtxRefused(mode === 1 ? 'mode=1 block carries no ctx (A3-M4)' : 'no ctx');
  }
  const ctxPairingId = ctx.pairingId;
  const phoneDeviceId = ctx.phoneDeviceId;
  const peerDeviceId = ctx.peerDeviceId;
  for (const [name, v] of [
    ['pairingId', ctxPairingId],
    ['phoneDeviceId', phoneDeviceId],
    ['peerDeviceId', peerDeviceId],
  ]) {
    if (typeof v !== 'string' || v.length === 0) throw new CtxRefused(`ctx.${name} is missing or not a string`);
    // A1 (4)'s u8 cap, re-asserted on the DECODE side. A1 required the throw at
    // encode time on every platform; a decoder that accepted 256 bytes would
    // hand them to pairContext(), which throws there instead — correct, but far
    // away from the field that caused it.
    if (utf8Len(v) > MAX_ID_BYTES) throw new CtxRefused(`ctx.${name} exceeds ${MAX_ID_BYTES} UTF-8 bytes`);
  }
  if (typeof userId !== 'string' || userId.length === 0) throw new CtxRefused('no local userId — cannot derive');
  if (utf8Len(userId) > MAX_ID_BYTES) throw new CtxRefused(`userId exceeds ${MAX_ID_BYTES} UTF-8 bytes`);

  // A3-M3: the block must be addressed to US. One whose peerDeviceId names
  // another device could not be opened anyway, but refusing it by identity
  // rather than by decryption failure is the difference between a clear
  // refusal and three seconds of indistinguishable tag failures.
  if (peerDeviceId !== ownDeviceId) {
    throw new CtxRefused(`ctx.peerDeviceId ${JSON.stringify(peerDeviceId)} is not this device (A3-M3)`);
  }
  // …and the pairingId, "wherever it independently knows the value". The SW
  // does NOT: PAIR_STATE is its only pairing frame and carries no pairingId
  // outside ctx, so there is nothing to compare against and the check is
  // SKIPPED rather than faked against the very value it would be checking.
  // The web page, which initiated the pairing, does know it and must compare —
  // that is P2's half of A3-M3, not P3's.
  if (pairingId !== null && ctxPairingId !== pairingId) {
    throw new CtxRefused('ctx.pairingId does not match the pairing we are party to (A3-M3)');
  }

  return {
    pairingId: ctxPairingId,
    userId,
    phoneDeviceId,
    peerDeviceId,
    pairEpoch: parseEpoch(ctx.pairEpoch),
  };
}

/**
 * A3-M2. Refuse a replayed or stale epoch, and commit the new floor BEFORE the
 * derived keys are used for anything (persist-before-use).
 *
 * The ordering matters for the same reason A2's counter ordering does: a crash
 * between use and persist must leave the floor AHEAD, not behind. Ahead costs
 * one refused pair and a re-Accept; behind leaves a replay window open.
 *
 * FIRST SIGHT IS TOFU — a phoneDeviceId with no floor sets one with no
 * comparison, consistent with §13's device pinning. There is nothing to compare
 * against on a first pair, and refusing would make a first pair impossible.
 */
export async function admitEpoch({ userId, phoneDeviceId, pairEpoch }) {
  const mapKey = `${userId}|${phoneDeviceId}`;
  const all = (await localGet(EPOCH_FLOOR_KEY)) || {};
  const seen = all[mapKey];
  if (seen !== undefined) {
    const floor = BigInt(seen);
    if (pairEpoch <= floor) {
      throw new CtxRefused(
        `pairEpoch ${pairEpoch} is not above the floor ${floor} for this phone (A3-M2) — ` +
        'refusing the pair. A replayed ACCEPT would reinstall a superseded SK and restart ' +
        'its counter at 0 against a key that has already sealed frames.',
      );
    }
  }
  // Persist BEFORE the caller derives or uses anything.
  all[mapKey] = pairEpoch.toString();
  await localSet(EPOCH_FLOOR_KEY, all);
  return { tofu: seen === undefined };
}

/**
 * Clear the floor for a user. A3-M2: ONLY an explicit user unpair / revoke /
 * sign-out may do this, NEVER a value arriving on the wire. There is
 * deliberately no "reset the floor because the phone said so" path, and adding
 * one would hand a replaying relay the key to the door this store is.
 */
export async function clearEpochFloors(userId) {
  const all = (await localGet(EPOCH_FLOOR_KEY)) || {};
  if (!userId) { await localSet(EPOCH_FLOOR_KEY, {}); return; }
  for (const k of Object.keys(all)) if (k.startsWith(`${userId}|`)) delete all[k];
  await localSet(EPOCH_FLOOR_KEY, all);
}

/** Read the floors. Exported so the harness and tests can assert them. */
export function readEpochFloors() {
  return localGet(EPOCH_FLOOR_KEY).then((v) => v || {});
}

/**
 * THE ONE DERIVATION-INPUT FUNCTION (A3).
 *
 * Everything §13.10.3's pairContext needs: four fields from the wire `ctx` plus
 * the local session `userId`. It refuses rather than guesses at every step, and
 * every refusal is a `CtxRefused` carrying `countsOnly` — so the caller shows a
 * badge and a generic body (m-G) instead of an error or a plaintext preview.
 *
 * NOTE ON WHAT IS NOT YET ON THE WIRE (A3-M1). `derivePairState`'s listener
 * slice is an explicit allowlist — `{kid, epk, mode, recipKeys, wrap}` — so it
 * DROPS `ctx` today, and this function therefore refuses every real block until
 * Ken's one-line P1 splice (`ctx: block.ctx`) lands on e2e/integration. That is
 * the correct behaviour in the meantime and needs no flag of its own: A3-M4
 * says a mode=1 block with no ctx is refused, which is exactly what happens.
 * This code is written against the SPLICED shape and changes not at all when
 * the splice arrives.
 */
export async function pairContextInputs({ block, ownDeviceId, userId }) {
  const inputs = validateCtx({
    ctx: block && block.ctx,
    mode: block && block.mode,
    ownDeviceId,
    userId,
  });
  await admitEpoch(inputs);          // persist-before-use; throws on a replay
  return inputs;
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
