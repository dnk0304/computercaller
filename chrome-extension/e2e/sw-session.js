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
 * UPDATE (P3 follow-up, rebased onto P1.1 46e3084): when this was written,
 * `lib/e2e/kdf.mjs` exposed only `hkdf32`, so the L=4 truncation lived here.
 * P1.1 landed `deriveNoncePrefixes()` in the shared module with a real
 * `hkdfBytes({length: 4})` call — the A2 SHOULD, done properly. This file now
 * DELEGATES to it rather than keeping a second derivation: two implementations
 * of one KDF is precisely the drift `e2e-sw-vendor-drift.test.mjs` exists to
 * prevent, and a local copy would have kept passing vectors E–H while silently
 * diverging from the page the moment either side was touched.
 *
 * What stays here is the part the shared module does NOT do: vector H's guard.
 * The bytes are asserted against A2 vectors E/F/G/H in tests/e2e-sw-nonce-prefix.test.mjs.
 */

import {
  DIR_P2C,
  DIR_C2P,
  SESSION_PREFIX_BYTES,
  deriveNoncePrefixes,
  pairContextFromWire,
  kek as deriveKek,
  trafficKeys,
  open as openAead,
  seal as sealAead,
  pairContext as encodePairContext,
} from './kdf.mjs';
import { fromBase64Url, toBase64Url } from './sw-key.js';

// ── A2 labels ───────────────────────────────────────────────────────────────
// RE-EXPORTED from the shared module, not re-declared. A local string literal
// here would be a second place the label could be typo'd, and vector H only
// catches the case where BOTH directions get the same one.
export { LABEL_NP2C, LABEL_NC2P } from './kdf.mjs';

// ── §13.5 dedupe parameters (FROZEN) ────────────────────────────────────────
export const DEDUPE_WINDOW = 1024;
export const FLOOR_ADVANCE_CAP = 256;

/**
 * Security A5 / M-A5-2 (F2). The forward-jump bound, same width as the dedupe
 * window and deliberately so: `frameBuffer` resume re-sends frames at or below
 * the highest sequence already seen, so no honest sender can produce a frame
 * more than one window ahead of the highest one this receiver has ACCEPTED.
 * The band above it is reachable only by a forgery.
 */
export const FORWARD_JUMP_WINDOW = DEDUPE_WINDOW;

/**
 * The stored dedupe-record version (RESUME-PROTOCOL v2 rule 6).
 *
 * WHY A VERSION TAG WITH A LOUD FAILURE, in the same shape sw-key.js uses for
 * the device-key record. Before M-A5-2 the record was
 * `{epoch, floor, seen, beyondWindow}` and carried no `highestAccepted`. A
 * worker that silently kept using such a record would enforce NO forward-jump
 * bound — F2 would still be open, and nothing would say so: the frames would
 * keep flowing and the counter would keep reading 0. So an unversioned or
 * unknown-versioned record is a THROW, the caller turns it into a drop, and the
 * next Accept (a new pairEpoch) rebuilds the record from scratch.
 */
export const DEDUPE_RECORD_V = 1;

/** Thrown by admitSeq() for a record it must not reason about. */
export class DedupeRecordVersionError extends Error {
  constructor(message) { super(message); this.name = 'DedupeRecordVersionError'; }
}

// ── chrome.storage.session keys ─────────────────────────────────────────────
/** kid → {kid, wrap, epk, mode, recipKeys, storedAt}. The WRAP, never SK. */
export const WRAP_KEY = 'cc_e2e_wrap';
/** "<kid>|<dir>" → next send seq. Persist-before-emit; fail closed if absent. */
export const SEQ_KEY = 'cc_e2e_seq';
/** "<kid>|<dir>" → {v, epoch, floor, seen:[…], highestAccepted}. §13.5 window. */
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
  // The derivation itself is the SHARED one — same bytes as the page, by
  // construction rather than by two copies agreeing today.
  const { np2c: p, nc2p: c } = await deriveNoncePrefixes({ pairingId, sessionKey, context }, subtle);
  if (p.length !== SESSION_PREFIX_BYTES || c.length !== SESSION_PREFIX_BYTES) {
    throw new Error(`a derived nonce prefix is ${p.length}/${c.length} bytes, expected ${SESSION_PREFIX_BYTES}`);
  }
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

// A3's grammar for pairEpoch (decimal string, BigInt, bounded at 2^64-1) is
// the shared parser's — see the note where parseEpoch() used to be.
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
 * `ctx.pairEpoch` parsing used to live here as `parseEpoch()`. It is now the
 * shared parser's job (`pairContextFromWire` in lib/e2e/kdf.mjs, landed by
 * P1.1): decimal STRING only, BigInt not Number, bounded at 2^64-1, no leading
 * zeros / sign / whitespace / decimal point. A local copy of that grammar is a
 * second thing to keep in step with the page, and the failure mode of it
 * drifting is a wire value the two sides read as two different epochs — which
 * derives two different keys and looks exactly like a network problem.
 * The A3 grammar is asserted end-to-end in tests/e2e-sw-a3-ctx.test.mjs (I.4),
 * driven off the frozen file's own `badPairEpoch` list.
 */

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
  // A4-M1, mirrored from `pairContextFromWire`. `ownDeviceId` USED to be the
  // A3-M3 peer check on this lane; A4 DELETED that clause, and this lane is the
  // one that must never resurrect it (the SW holds no wraps[], so it cannot
  // perform clause (c) and MUST NOT substitute its own id for the canonical
  // peer). Silently ignoring the option would leave a caller believing a
  // membership check is running while it is gone — the decorative control the
  // kdf refuses by name, refused here for the same reason.
  if (ownDeviceId !== undefined) {
    throw new CtxRefused(
      '`ownDeviceId` is not an input to validateCtx — A4 deleted the peerDeviceId==own refusal. The SW lane\'s binding membership check is clause (b), the wrap opening under KEK(ctx, own static key), in unwrapSessionKey (A4-M1)',
    );
  }
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

  // ── Everything below is the SHARED parser, not a second copy of it ────────
  // P1.1 landed `pairContextFromWire()` in lib/e2e/kdf.mjs: the pairEpoch
  // decimal-string regex, the 2^64-1 bound, A3-M3(a)'s pairingId check, A4's
  // conditional clause (c) and A3-M4's refuse-without-ctx all live there, and the page
  // and the SW must apply byte-identical rules or a frame one side accepts is a
  // frame the other silently derives a different key for. Duplicating the regex
  // here is how the two drift by one character with every suite still green.
  //
  // Two things stay OURS and are the reason this wrapper exists at all:
  //   1. the UTF-8 byte cap above — A1 (4)'s u8 field length, re-asserted at
  //      DECODE. The shared parser leaves it to pairContext()'s encode-time
  //      throw, which is correct but fires far from the field that caused it.
  //   2. the error TYPE. The SW's m-G tolerance needs `CtxRefused.countsOnly`
  //      to tell "refuse this block and show counts" apart from a bug; a plain
  //      Error escaping here would surface as an error toast, which m-G forbids.
  //
  // A3-M3(a) — the pairingId half — under A4.1's channel ruling (R-T). The SW
  // does NOT learn its pairingId from PAIR_STATE (that frame carries the value
  // only INSIDE ctx, and checking ctx.pairingId against itself is a check that
  // CANNOT FAIL). It learns it two ways, neither of which touches the relay:
  // handed over by the page over the FORGE-P pinned bridge, else TOFU from the
  // first ctx of a new pairEpoch. `pairContextInputs` resolves that and passes
  // it here; a `null` still SKIPS, so the branch is never faked.
  //
  // `recipientDeviceIds` is deliberately NOT passed: clause (c) is checked ONLY
  // where the receiver holds the full wraps[], and PAIR_STATE's allowlist
  // carries `wrap` SINGULAR. Omitting it makes the kdf perform NO peer check —
  // which is A4-R3's whole point, not an oversight.
  let parsed;
  try {
    parsed = pairContextFromWire(ctx, { userId, pairingId });
  } catch (e) {
    throw new CtxRefused(e && e.message ? e.message.replace(/^kdf: /, '') : 'ctx refused');
  }

  return {
    pairingId: parsed.pairingId,
    userId,
    phoneDeviceId: parsed.phoneDeviceId,
    peerDeviceId: parsed.peerDeviceId,
    pairEpoch: parsed.pairEpoch,
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
  // A4-M1, same reasoning as validateCtx's: the option is REJECTED, not
  // ignored, so no caller can keep believing a peer check runs here.
  if (ownDeviceId !== undefined) {
    throw new CtxRefused(
      '`ownDeviceId` is not an input to pairContextInputs — A4 deleted the peerDeviceId==own refusal; the SW lane\'s binding check is clause (b) at unwrap (A4-M1)',
    );
  }
  // A4.1 step 1: what pairingId do we independently know? A bridge hand-over
  // beats TOFU and is epoch-independent (the page owns the pairing). A TOFU
  // pin is only good for the epoch it was pinned in, and the epoch is not
  // trustworthy until the shared parser has validated it — so the TOFU half
  // runs AFTER the parse, in `admitOwnPairingId`.
  const known = await readOwnPairingId();
  const expectPairingId = known && known.source === 'bridge' ? known.pairingId : null;
  const inputs = validateCtx({
    ctx: block && block.ctx,
    mode: block && block.mode,
    userId,
    pairingId: expectPairingId,
  });
  await admitOwnPairingId({ known, ...inputs });   // A4.1 TOFU half; throws on drift
  await admitEpoch(inputs);          // persist-before-use; throws on a replay
  return inputs;
}

// ── A4.1 — the SW's `pairingId` channel (Ken's ruling R-T) ──────────────────
/**
 * `{ pairingId, pairEpoch, source:'bridge'|'tofu' }` in chrome.storage.SESSION.
 *
 * SESSION, not local, and that is the deliberate half. This is a consistency
 * pin, NOT the anchor — clause (b), the SW's own wrap opening under its own
 * KEK, stays the cryptographic proof of membership and A4.1 does not weaken it.
 * A pin that outlived the browser would turn a legitimate re-pair into a
 * permanent refusal for a check that was never load-bearing; the epoch floor
 * (A3-M2), which IS load-bearing against nonce reuse, is the one that lives in
 * storage.local. Keeping them in different stores is the point.
 */
export const OWN_PAIRING_KEY = 'cc_e2e_own_pairing';

export function readOwnPairingId() {
  return sessionGet(OWN_PAIRING_KEY);
}

/**
 * A4.1 source 1 — the page hands its pairingId over the FORGE-P pinned bridge.
 * The page initiated the pairing, so this is the AUTHORITATIVE value and it
 * outranks any TOFU pin, including one from a different epoch.
 */
export async function setOwnPairingId(pairingId) {
  if (typeof pairingId !== 'string' || pairingId.length === 0) return null;
  if (utf8Len(pairingId) > MAX_ID_BYTES) return null;
  const rec = { pairingId, pairEpoch: null, source: 'bridge' };
  await sessionSet(OWN_PAIRING_KEY, rec);
  return rec;
}

export async function clearOwnPairingId() {
  await sessionSet(OWN_PAIRING_KEY, null);
}

/**
 * A4.1 source 2 — TOFU, per pairEpoch.
 *
 * FIRST ctx of a NEW epoch pins the pairingId with no comparison (there is
 * nothing to compare against, and refusing would make a first pair impossible —
 * the same shape as A3-M2's first-sight rule). Every LATER ctx in that epoch
 * must match the pin or the block is refused. A new epoch RESETS the pin: a
 * legitimate re-pair mints a new pairingId, and pinning across epochs would
 * refuse it forever.
 *
 * A bridge hand-over is authoritative and was already compared at ingest, so
 * this only records the epoch it was seen under.
 */
export async function admitOwnPairingId({ known, pairingId, pairEpoch }) {
  const epoch = String(pairEpoch);
  if (known && known.source === 'bridge') {
    if (known.pairEpoch !== epoch) {
      await sessionSet(OWN_PAIRING_KEY, { ...known, pairEpoch: epoch });
    }
    return;
  }
  if (known && known.source === 'tofu' && known.pairEpoch === epoch) {
    if (known.pairingId !== pairingId) {
      throw new CtxRefused(
        `ctx.pairingId "${pairingId}" is not the one TOFU-pinned for pairEpoch ${epoch} — refusing the block (A3-M3(a) / A4.1)`,
      );
    }
    return;
  }
  await sessionSet(OWN_PAIRING_KEY, { pairingId, pairEpoch: epoch, source: 'tofu' });
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
 *
 * M-A5-2 (F2) adds ONE bound on top of that frozen set, and changes no other
 * number: a frame more than FORWARD_JUMP_WINDOW above `highestAccepted` is
 * REFUSED — dropped, floor NOT advanced, counted separately. Before this, a
 * single forged far-future seq walked the floor up by 256 every time it was
 * replayed, so an attacker who could inject 20 000 such frames could push the
 * floor past every frame still in flight and silence the pairing. The cap
 * bounded the damage per frame; it did not bound the attack.
 *
 * @throws {DedupeRecordVersionError} for a stored record of an unknown version.
 */
export async function admitSeq({ kid, direction, seq, pairEpoch }) {
  const mapKey = `${kid}|${direction}`;
  const all = (await sessionGet(DEDUPE_KEY)) || {};
  let w = all[mapKey];
  if (w && w.epoch === Number(pairEpoch) && w.v !== DEDUPE_RECORD_V) {
    // Loud, per RESUME-PROTOCOL rule 6. A pre-M-A5-2 record has no `v` and no
    // `highestAccepted`; reasoning about it would silently disable the bound
    // this function exists to enforce. The caller drops the frame; the next
    // Accept carries a new pairEpoch and rebuilds the record below.
    throw new DedupeRecordVersionError(
      `cc-e2e dedupe record version ${JSON.stringify(w.v)} is not ${DEDUPE_RECORD_V} — `
      + `refusing to admit frames against a record with no forward-jump bound; re-pair to rebuild it`,
    );
  }
  if (!w || w.epoch !== Number(pairEpoch)) {
    w = {
      v: DEDUPE_RECORD_V,
      epoch: Number(pairEpoch),
      floor: 0,
      seen: [],
      beyondWindow: 0,
      // UNARMED. -1 is not "zero minus one", it is a distinct state: no frame
      // has authenticated in this epoch, so there is no honest high-water mark
      // to measure a jump against. Arming from 0 would refuse a peer that is
      // legitimately past the window -- the normal situation after a resume or
      // a reattach, when this receiver rebuilds the record from nothing while
      // the sender is at seq 90 000. The vector file's `armRule` and case A.
      highestAccepted: -1,
    };
  }
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, why: 'malformed-seq' };

  // ── M-A5-2 / F2: the forward-jump bound, BEFORE any floor movement ────────
  // Order is the whole fix. Checked after the slide it would be checking a
  // floor the forgery had already moved.
  //
  // ARMED ONLY. An unarmed window (-1) admits by the ordinary rules below and
  // the first AUTHENTICATED frame sets the mark -- see markAuthenticated().
  if (w.highestAccepted >= 0 && n > w.highestAccepted + FORWARD_JUMP_WINDOW) {
    // Counted HERE rather than by the caller, and on the DROPS record rather
    // than on this window. The vector file's `counterRule`: the counter is
    // session-lifetime and must NOT be zeroed by an epoch change, because an
    // epoch change is something an attacker can provoke -- and a counter an
    // attacker can zero is not a counter. The window is rebuilt on every
    // epoch; the drops record is not.
    await noteRefusedForwardJump();
    all[mapKey] = w;      // floor, seen and the mark ALL unmoved; seq unrecorded
    await sessionSet(DEDUPE_KEY, all);
    return { ok: false, why: 'forward-jump' };
  }

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

/**
 * Arm/raise the forward-jump mark. Called ONLY after the frame's AEAD tag has
 * verified (M-A5-2 `armRule`).
 *
 * WHY THIS IS A SECOND CALL AND NOT A LINE INSIDE admitSeq(). admitSeq() runs
 * BEFORE the open, deliberately -- §13.5 wants a replayed frame to cost no
 * crypto -- so at that point the only thing known about the frame is that it is
 * well SHAPED. Raising the mark there would mean an attacker who can emit a
 * well-shaped envelope at seq 2^40 sets the high-water mark himself, and the
 * bound then admits everything below it: the fix would hand over the very
 * property it exists to protect. Authentication is the only evidence that a
 * sequence number came from the peer, and it is available only here.
 *
 * A no-op when the window is gone or the epoch has moved on: a reset DISARMS
 * the mark by design (vector H), and re-arming it from a frame decrypted under
 * the previous epoch would undo that.
 */
export async function markAuthenticated({ kid, direction, seq, pairEpoch }) {
  const mapKey = `${kid}|${direction}`;
  const all = (await sessionGet(DEDUPE_KEY)) || {};
  const w = all[mapKey];
  if (!w || w.epoch !== Number(pairEpoch) || w.v !== DEDUPE_RECORD_V) return;
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n < 0) return;
  if (n > w.highestAccepted) {
    w.highestAccepted = n;
    all[mapKey] = w;
    await sessionSet(DEDUPE_KEY, all);
  }
}

/**
 * Bump and return the exported drop counter (§13.5: it must be observable).
 *
 * SERIALISED, and that is a FIX, not decoration (found by P3.1's burst arms).
 * The body is a read-modify-write across two awaits on `chrome.storage.session`.
 * Two drops in the same tick both read the same value, both write value+1, and
 * the counter records ONE. That is not a rare interleaving: the shape that
 * produces it is a burst — a relay stripping envelopes off a run of frames, or
 * a chunk stream arriving marked — which is precisely and only the case the
 * counter exists to make visible. A counter that under-reports during an attack
 * and is exact at rest converts a tamper campaign into an invisible one, which
 * is the outcome FT-A1.1 M2 names.
 *
 * The queue is a tail promise rather than a lock because every caller is
 * fire-and-forget (`noteDrop(x).catch(() => {})`): there is nothing to block,
 * only an order to keep. A rejected link must not poison the chain, hence the
 * `catch` on the tail rather than on the returned promise.
 */
let dropQueue = Promise.resolve();
export function noteDrop(reason) {
  const next = dropQueue.then(async () => {
    const all = (await sessionGet(DROPS_KEY)) || { total: 0, byReason: {} };
    all.total = (all.total || 0) + 1;
    all.byReason[reason] = (all.byReason[reason] || 0) + 1;
    await sessionSet(DROPS_KEY, all);
    return all;
  });
  dropQueue = next.catch(() => {});
  return next;
}

/**
 * M-A5-2's counter: refused forward jumps, in the `cc_e2e_drops` family but
 * DISTINCT from `total` and from the per-window `beyondWindow`.
 *
 * Distinctness is the requirement, not a style choice (A5 F2: "a new exported
 * `refusedForwardJump` counter, distinct from `droppedTotal` and from
 * `beyondWindow`"). Folding it into `total` would make a forgery campaign look
 * like a noisy relay; folding it into `beyondWindow` would make a REFUSAL look
 * like an ACCEPT, which is the exact confusion F2 is about.
 *
 * Shares `dropQueue` for the same reason noteDrop() does: the shape that
 * produces this counter is a BURST, and an unserialised read-modify-write
 * across two awaits records one increment for a whole flood.
 */
export function noteRefusedForwardJump() {
  const next = dropQueue.then(async () => {
    const all = (await sessionGet(DROPS_KEY)) || { total: 0, byReason: {} };
    all.refusedForwardJump = (all.refusedForwardJump || 0) + 1;
    await sessionSet(DROPS_KEY, all);
    return all;
  });
  dropQueue = next.catch(() => {});
  return next;
}

/** Read the drop counter. Exported so a harness can assert it. */
export function readDrops() {
  return sessionGet(DROPS_KEY).then((v) => ({
    total: 0, byReason: {}, refusedForwardJump: 0, ...(v || {}),
  }));
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
/**
 * T-FT-WEB-CHUNK-SEQ-RACE (the SW twin). `nextSendSeq` is a read-modify-write
 * over an ASYNC store: two overlapping calls both read the same floor before
 * either writes, and both hand out the same seq. That is exactly the defect
 * the browser's `createFailClosedSender` shipped -- three FILE_CHUNKs sealed
 * back-to-back under one `s`, two of them dropped by the phone as duplicates,
 * and under mode ON a GCM nonce reuse. The SW sends no sealed frames today
 * (`assertSwSendsNothing()` pins it), so this is the latent half; it is fixed
 * here so the day a send path is added it cannot inherit the race.
 *
 * Every handout goes through ONE chain, so the read and the write of a single
 * call can never be split by another call's read.
 */
let seqHandoutTail = Promise.resolve();

export async function nextSendSeq({ kid, direction }) {
  const mapKey = `${kid}|${direction}`;
  // The chain must survive a rejection, or one failed call would poison every
  // later one with an error that was never theirs.
  const mine = seqHandoutTail.then(async () => {
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
  });
  seqHandoutTail = mine.catch(() => {});
  return mine;
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

// ── §13.7 FROZEN frame list — the seal/plaintext chokepoint ────────────────

/**
 * The frames §13.7 says are SEALED, transcribed from the frozen list.
 *
 * This set is the whole point of deliverable (c)'s inbound half. Without it a
 * DOWNGRADE is free: the relay strips the envelope off an SMS_RECEIVED, sends
 * the body in the clear, and the worker — which has a perfectly good session —
 * renders it exactly as it would have rendered a sealed one. Nothing throws,
 * nothing is dropped, the badge is right, the notification is right, and the
 * message crossed the wire in plaintext. Every test that only ever feeds sealed
 * frames to an ON session passes throughout.
 *
 * So the rule is stated positively over the FROZEN list rather than inferred
 * from what happens to arrive: while the session is OPEN, a frame of a type on
 * this list that carries no envelope is DROPPED AND COUNTED. It is not
 * rendered, not counted as unread, and not shown generically — a generic
 * notification would still tell the attacker their strip worked.
 *
 * Grouped as §13.7 groups them so the two can be diffed by eye.
 */
export const SEALED_FRAME_TYPES = Object.freeze(new Set([
  'PHONE_NOTIFICATION', 'SMS_RECEIVED',
  'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CONTACTS_CHUNK',
  'CALL_LOGS', 'CALL_LOGS_CHUNK', 'CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK', 'MMS_MEDIA_ERROR',
  'CALL_INCOMING', 'CALL_ADD', 'CALL_UPDATE', 'CALL_WAITING',
  'CALL_ANSWERED', 'CALL_ENDED', 'CALL_REMOVE',
  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE',
  'SEND_SMS', 'MAKE_CALL',
  'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS',
  'NOTIFICATION_REPLY_SENT', 'NOTIFICATION_REPLY_FAILED', 'NOTIFICATION_REMOVED',
]));

/**
 * The frames §13.7 marks **mandatorily** plaintext, even with a live session.
 *
 * `gateBrowserSyncFrame()` on the relay is the only tier-enforcement chokepoint
 * in the product — it clamps `since` and drops `GET_CONTACTS` below Plus.
 * Sealing these would move billing enforcement to the client, which is the same
 * as deleting it. What leaks is a timestamp and a category, no content. §13.7
 * calls this an accepted, documented trade; it is listed EXPLICITLY here rather
 * than left to fall through the sealed-set check, so that a future edit that
 * adds them to the sealed list collides with this constant instead of quietly
 * breaking billing.
 */
export const MANDATORY_PLAINTEXT_FRAME_TYPES = Object.freeze(new Set([
  'GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS',
]));

/**
 * Must a frame of this type be sealed when the session is open?
 *
 * `CALL_STATUS` is deliberately absent from both sets: §13.7 splits it — the
 * `{state}` field is clear and only the number and name are sealed — so it is
 * neither wholly sealed nor mandatorily plaintext, and a blanket rule either
 * way would be wrong. It stays out until §13.7 says how to express a per-field
 * frame, and the unknown-type default below is the safe one.
 */
export function requiresSeal(frameType) {
  if (MANDATORY_PLAINTEXT_FRAME_TYPES.has(frameType)) return false;
  // FT-A1 MUST B-1. Sealed when ON, but ROUTED not opened — see the set below.
  // This is why the two sets are asked in this order and never merged: the
  // downgrade rule is the same for both, the disposition is not.
  if (SEALED_PASSTHROUGH_FRAME_TYPES.has(frameType)) return true;
  return SEALED_FRAME_TYPES.has(frameType);
}

// ── FT-A1 §2 / FT-A1.1 §2.5 — the file-transfer passthrough family ──────────

/**
 * Sealed when the session is ON, but ROUTED to the page rather than opened.
 *
 * THIS SET IS DISJOINT FROM `SEALED_FRAME_TYPES` ON PURPOSE, and merging them
 * would be a regression, not a tidy-up. `SEALED_FRAME_TYPES` is §13.7's FROZEN
 * list and it is simultaneously (a) the set the downgrade guard protects, (b)
 * the set `sealFrame()` is willing to seal, and (c) the set the unseal path
 * serves. FILE_* needs exactly (a) and must never get (b) or (c): a worker that
 * opened a FILE_CHUNK would be holding file bytes, and the whole 1 GB design
 * rests on it never doing that — this worker is evicted on a 30 s idle timer.
 *
 * So the FILE family gets the DROP rule via `requiresSeal()` above and a
 * disposition of its own (`INBOUND_ROUTE_SEALED`) below. §13.7's list gains no
 * entry and `sealFrame()`'s refusal is not widened.
 *
 * Before FT-A1 this hole was live and exploitable: `requiresSeal()` named no
 * FILE_* type, so a relay that stripped `{e,kid,s,c}` off a FILE_OFFER while
 * the session was OPEN got the body — filename, size, sender — delivered in the
 * clear, and every subsequent chunk with it. The one frame family that carries
 * whole documents was the one family with no downgrade guard.
 */
export const SEALED_PASSTHROUGH_FRAME_TYPES = Object.freeze(new Set([
  'FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK',
  'FILE_ACK', 'FILE_RESUME', 'FILE_DONE', 'FILE_FAILED',
]));

/**
 * The eight reasons the RELAY is allowed to author (FT-A1.1 §2.2, frozen).
 *
 * The relay cannot seal — it holds no session key — so its own refusals are
 * necessarily plaintext, and a strict B-1 receiver would drop every one of
 * them. That is not an acceptable outcome: "timeout" as the only visible result
 * of a tier or quota refusal hides the exact events the controls exist to
 * surface. Hence the one narrow exception in `inboundDisposition()`.
 *
 * `hash_mismatch`, `cancelled` and `oom` are PEER-owned and deliberately
 * absent. A plaintext one of those, marked or not, is a downgrade and is
 * dropped — the peer can seal, so it has no excuse.
 *
 * Transcribed from file-transfer/WIRE-TRUTH-v1.md. Kept as a literal here
 * rather than imported from `lib/fileTransfer/reasons.ts` because that is
 * TypeScript on the web lane and this file must load in an MV3 worker with no
 * build step (R-A). A test asserts the two lists match.
 */
export const RELAY_OWNED_FAIL_REASONS = Object.freeze(new Set([
  'tier', 'quota', 'too_large', 'size_mismatch',
  'busy', 'relay_backpressure', 'timeout', 'connection_lost',
]));

/** True when the frame body carries a top-level `relay` key of its own. */
function carriesRelayMark(data) {
  return !!data && typeof data === 'object'
    && Object.prototype.hasOwnProperty.call(data, 'relay');
}

/** What the inbound chokepoint decided to do with a frame. */
export const INBOUND_DELIVER = 'deliver';
export const INBOUND_UNSEAL = 'unseal';
export const INBOUND_DROP_PLAINTEXT = 'drop-plaintext-while-on';
/** FT-A1 MUST B-1 — forward the envelope VERBATIM; never call openIfSealed. */
export const INBOUND_ROUTE_SEALED = 'route-sealed';
/** FT-A1.1 M9 — a relay-MINTED plaintext FILE_FAILED. Abort-only, page-owned. */
export const INBOUND_DELIVER_RELAY_ABORT = 'deliver-relay-abort';
/** FT-A1.1 M7, receiver half — a `relay` mark on a shape that cannot be honest. */
export const INBOUND_DROP_RELAY_MARK = 'drop-bad-relay-mark';
/** BAT-A1 MUST-3 — a BATTERY frame whose three fields are not the frozen shape. */
export const INBOUND_DROP_BATTERY_SHAPE = 'drop-battery-shape';

/**
 * BAT-A1 MUST-3 — the frozen BATTERY shape, validated at the chokepoint.
 *
 * `BATTERY:{pct,charging,ts}` is DISPLAY-ONLY telemetry: nothing downstream of
 * here may read it into mode, pairing, tier, quota or session state. That makes
 * validation cheap and makes skipping it tempting — which is exactly why it is
 * done here, at the one place every inbound frame passes, rather than in the
 * three surfaces that render it. A `pct` of `"47"` renders identically to 47
 * and then sorts, compares and clamps differently everywhere; a `charging` of
 * `1` is truthy today and a bug the first time someone writes `=== true`.
 *
 * Strict on the three named fields, TOLERANT of unknown extra keys: the wire
 * form is frozen, but a receiver that drops on an unrecognised field freezes it
 * against its own future. `relay` is the one named exception and is rejected
 * above this, under MUST-2.
 *
 * Exported so the node suites assert the SHIPPED predicate rather than a copy.
 */
export function isValidBatteryPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Number.isInteger(data.pct) || data.pct < 0 || data.pct > 100) return false;
  if (data.charging !== true && data.charging !== false) return false;
  if (typeof data.ts !== 'number' || !Number.isFinite(data.ts)) return false;
  return true;
}

/**
 * THE INBOUND CHOKEPOINT, as a pure decision.
 *
 * It lives here rather than inline in `background.js` for one reason: inline,
 * the only way to test it is to drive a whole service worker in a browser, and
 * a rule that can only be checked by the slowest harness in the programme is a
 * rule that stops being checked. Here it is three lines of node.
 *
 * The order of the branches IS the security property:
 *   1. a sealed envelope → UNSEAL (before any counter, badge or notification);
 *   2. otherwise, if the session is OPEN and §13.7 says this type is sealed →
 *      DROP, because a plaintext frame of a sealed type while we hold a working
 *      session is a strip, not a fallback;
 *   3. otherwise → deliver as plaintext, which is every frame today.
 *
 * Note what (2) does NOT do: downgrade to the generic counts-only body. A badge
 * increment still confirms to whoever stripped the envelope that it reached us,
 * and counts-only is for frames we cannot READ, not for frames that should
 * never have arrived in this shape.
 *
 * `mode` is the worker's own e2e mode — 'off' | 'counts-only' | 'open'. The
 * drop is scoped to 'open' deliberately: in the other two there is no session,
 * plaintext is simply how the product works today, and dropping would break
 * every un-paired user.
 */
export function inboundDisposition({ mode, frameType, data }) {
  // ── FT-A1 §2 / FT-A1.1 §2.5: the file family, decided FIRST and in full ──
  //
  // It is lifted above the general branches rather than threaded through them
  // because its sealed case is the OPPOSITE of theirs: every other sealed type
  // is opened here, and these are the types that must not be. Leaving that to a
  // later `if` inside the unseal branch is how a refactor eventually opens one.
  if (SEALED_PASSTHROUGH_FRAME_TYPES.has(frameType)) {
    const on = mode === 'open' || mode === 'aborted';
    const marked = carriesRelayMark(data);
    if (isSealedEnvelope(data)) {
      // A sealed frame carrying `relay` cannot be honest from either author:
      // the relay stamps the mark only on frames it MINTS (M6) and it mints
      // nothing sealed (it has no key), and it must REJECT rather than forward
      // any peer frame carrying the key (M7). So this shape means the mark
      // survived a path that promised to reject it. Drop it — and do not
      // "helpfully" strip the key and route the rest, because the page would
      // then treat a frame with a broken provenance story as ordinary.
      return marked ? INBOUND_DROP_RELAY_MARK : INBOUND_ROUTE_SEALED;
    }
    // Mode OFF / counts-only: plaintext FILE_* is simply how the product works
    // without a session, and the relay mints its refusals plaintext in BOTH
    // modes (FT-A1.1 §2.1, one mint path). Unchanged, byte for byte.
    if (!on) return INBOUND_DELIVER;
    // M9, the one narrow exception, and every clause of it is load-bearing.
    // The SW applies all of them EXCEPT liveness: it does not track transfer
    // state and must not start — the page owns that, and the page applies it.
    if (marked
      && frameType === 'FILE_FAILED'
      && data.relay === true
      && RELAY_OWNED_FAIL_REASONS.has(data.reason)) return INBOUND_DELIVER_RELAY_ABORT;
    return marked ? INBOUND_DROP_RELAY_MARK : INBOUND_DROP_PLAINTEXT;
  }
  // ── BAT-A1 MUSTs 2 and 3: BATTERY, decided before the general branches ──
  //
  // BATTERY is §13.7 PLAINTEXT — it is in neither sealed set, so `requiresSeal`
  // is false for it and the general branches below would DELIVER it in every
  // mode, including 'open'. That is the correct outcome and this branch does
  // not change it; what it adds is the two refusals the general branches have
  // no vocabulary for.
  //
  // MUST-2, the relay mark, mirrors §13.7.2 M6/M7 exactly. The relay never
  // mints a BATTERY frame (it has nothing to mint one FROM — the reading comes
  // from the phone's own OS), so a top-level `relay` key on this type cannot be
  // honest from any author. REJECTED, never stripped: stripping would make a
  // forged mark indistinguishable from an absent one, which is the entire
  // property the mark carries. Reuses INBOUND_DROP_RELAY_MARK rather than
  // inventing a second class — one counter for one kind of lie.
  //
  // It is placed ABOVE `isSealedEnvelope` deliberately. A BATTERY frame shaped
  // like an envelope is not a frame we failed to predict: §13.7 says this type
  // is plaintext and `sealFrame()` refuses to seal it, so an envelope here is
  // either a mislabelled frame or a probe, and the display-only reading is to
  // refuse it on shape rather than spend a key operation opening it.
  if (frameType === 'BATTERY') {
    if (carriesRelayMark(data)) return INBOUND_DROP_RELAY_MARK;
    if (!isValidBatteryPayload(data)) return INBOUND_DROP_BATTERY_SHAPE;
    return INBOUND_DELIVER;
  }
  if (isSealedEnvelope(data)) return INBOUND_UNSEAL;
  // 'aborted' (A4-M3) sits with 'open', not with 'counts-only'. In an aborted
  // pairing the PHONE is still sealing — the abort is our side's refusal, not
  // the phone's — so a frame that requiresSeal() arriving in the CLEAR is an
  // anomaly, not the ordinary un-paired case, and accepting it would be the
  // downgrade the abort exists to refuse. 'off' and 'counts-only' keep
  // delivering plaintext: that is simply how an un-paired or key-less install
  // works, and dropping there would break every such user.
  if ((mode === 'open' || mode === 'aborted') && requiresSeal(frameType)) return INBOUND_DROP_PLAINTEXT;
  return INBOUND_DELIVER;
}

// ── FT-A1 §2.3 — the page-closed pending-offer marker ──────────────────────

/** MUST B-2. 60 s: long enough to cover "user clicks the notification". */
export const PENDING_OFFER_TTL_MS = 60_000;

/** `ft.id` is 16 random bytes rendered as 32 lowercase hex. Nothing else. */
const FT_HINT_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Read `ft.id` off a sealed FILE_OFFER envelope, or return null.
 *
 * THE VALUE IS A HINT FROM AN UNTRUSTED PARTY (FT-A1 §0/Q2): `ft` rides
 * OUTSIDE the AAD and is not authenticated. The worker is allowed to use it for
 * exactly one thing — naming a transfer in a refusal it is about to author —
 * and for nothing else. It is never compared to a key, never used to size an
 * allocation, and never shown to the user. The receiver that CAN check it (the
 * page, which unseals) does so under MUST A-5; the worker cannot and does not.
 *
 * A missing or malformed hint returns null, and the caller's only correct
 * response is to drop and count. There is no id to name, so there is no frame
 * to author — the same reasoning FT-A1.1 M1 applies to the relay's `bad_hint`.
 */
export function ftHintId(envelope) {
  const ft = envelope && typeof envelope === 'object' ? envelope.ft : null;
  if (!ft || typeof ft !== 'object') return null;
  return typeof ft.id === 'string' && FT_HINT_ID_RE.test(ft.id) ? ft.id : null;
}

/**
 * Pin the claim this worker's file path makes: **it never mints `relay:true`.**
 *
 * The `relay` mark is trust-on-relay, not cryptography (FT-A1.1 §2.4). Its
 * entire value comes from exactly one party being able to set it. A worker that
 * stamped the mark on a frame of its own — even honestly, even once, even only
 * on the page-facing port — would turn the receiver's one provenance signal
 * into a signal two parties can produce, and the page's M9 exception would then
 * be admitting frames on the word of whichever of them was compromised.
 *
 * Written as a source assertion rather than a comment for the reason the
 * neighbouring `assertSwSendsNothing` gives: a comment cannot fail. Comments
 * and strings are stripped first so that the prose ABOUT the mark — of which
 * this file has a great deal — does not trip its own proof.
 */
export function assertSwMintsNoRelayMark(source) {
  const code = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  // `relay: true`, `relay:!0`, `"relay": true` — an object literal assigning a
  // truthy relay mark. A READ (`data.relay === true`) is what the disposition
  // does for a living and must not match, hence the property-KEY shape.
  const re = /(^|[{,(\s])relay\s*:\s*(?:true|!0|1)\b/;
  if (re.test(code)) {
    throw new Error(
      'the service worker now MINTS a relay:true mark. Only the relay may set it '
      + '(FT-A1.1 M6) — its whole value is that exactly one party can. Route the '
      + 'frame instead, or delete this assertion deliberately, not by accident.',
    );
  }
  return true;
}

/**
 * THE OUTBOUND CHOKEPOINT: payload → pad → seal → envelope.
 *
 * Read the warning on `nextSendSeq` first. The counter is obtained THROUGH it,
 * so this function inherits fail-closed: no durably proven floor means it
 * THROWS and the caller must rekey. It must never grow a `seq` argument and
 * must never be handed one — a caller that could choose its own sequence number
 * is a caller that can reuse a nonce, and in GCM that is not a degradation but
 * total loss of confidentiality AND forgery for the key.
 *
 * The padding is not applied here because `seal()` applies it (§13.4, via
 * padPlaintext) — doing it again here would pad the padding and produce a
 * length that no receiver's unpad accepts.
 */
export async function sealFrame({ session, frameType, kid, pairEpoch, payload }, subtle = crypto.subtle) {
  if (!session || !session.send) throw new Error('sealFrame: no open session — refusing to send');
  if (!requiresSeal(frameType)) {
    // Not an oversight to route around: a caller asking to seal a mandatorily
    // plaintext frame has misread §13.7, and silently sealing it would break
    // the relay's tier gate in a way that looks like a billing bug months later.
    throw new Error(`sealFrame: ${frameType} is not a sealed frame type (§13.7) — refusing to seal it`);
  }
  const seq = await nextSendSeq({ kid, direction: session.send.direction });
  const ciphertext = await sealAead({
    sender: session.send,
    frameType,
    kid,
    seq: BigInt(seq),
    pairEpoch,
    plaintext: new TextEncoder().encode(JSON.stringify(payload)),
  }, subtle);
  return { e: 1, kid, s: seq, c: toBase64Url(ciphertext) };
}

/**
 * Pin the claim `nextSendSeq`'s doc comment makes: **this worker sends nothing
 * on the listener socket.**
 *
 * The claim is load-bearing — the whole of `sealFrame`/`nextSendSeq` is dormant
 * scaffolding that is correct only for as long as it is unused — and until now
 * it was asserted by a doc comment referring to a function that did not exist.
 * A comment cannot fail. This can: give it the text of background.js and it
 * refuses if any `send(` call appears on a WebSocket-shaped receiver.
 *
 * Comments and strings are stripped first, because the file is full of prose
 * ABOUT sending and a grep-proof that its own explanation trips is a proof
 * nobody keeps. Returns the (empty) list of offenders so a test can print them.
 */
export function assertSwSendsNothing(source) {
  const code = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const offenders = [];
  const re = /\b([A-Za-z_$][\w$]*)\s*\.\s*send\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    // chrome.runtime.sendMessage / port.postMessage are different verbs and do
    // not match; this is specifically `<something>.send(` on the socket.
    offenders.push(m[1]);
  }
  if (offenders.length) {
    throw new Error(
      `the service worker now sends on a socket (${[...new Set(offenders)].join(', ')}.send). `
      + 'Route it through sealFrame() — which takes its seq from nextSendSeq() and so fails '
      + 'closed on an unproven counter — and delete this assertion deliberately, not by accident.',
    );
  }
  return offenders;
}

export { toBase64Url, fromBase64Url };
