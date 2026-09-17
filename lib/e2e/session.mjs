/**
 * lib/e2e/session.mjs — the sealed session: key agreement, the A2 nonce
 * prefixes, the fail-closed send counter, the envelope, and the dedupe window.
 * (E2E-P2 (d), (e), (f).)
 *
 * WHY .mjs AND NOT .ts (brief allows either): the SERVICE WORKER needs the same
 * bytes. R-A's rule — one implementation, imported by the node tests, the web
 * page and the SW, with no build step — applies to this file for exactly the
 * reason it applied to kdf/padding/sas: two implementations of a nonce
 * derivation is one implementation plus a future incident. `session.d.mts` is
 * the sidecar that buys the TypeScript types back. P3 imports this module; it
 * does not reimplement it.
 *
 * WHAT IS FROZEN ELSEWHERE AND ONLY IMPORTED HERE: lib/e2e/kdf.mjs (pairContext,
 * kek, trafficKeys, nonce, aad, seal, open), lib/e2e/padding.mjs, lib/e2e/sas.mjs.
 * Nothing in this file re-derives any of those bytes.
 *
 * ── A2: THE NONCE PREFIX IS DERIVED, AND IT CONTRIBUTES NOTHING ────────────
 * GATE1 Addendum A2 (RATIFIED (A), 2026-09-17T15:50Z) replaced A1's "4 B random
 * per (kid,direction)" — which had no channel on any frozen frame and was
 * therefore undecryptable as written — with two HKDF outputs:
 *
 *     np2c = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/np2c" ‖ pairContext)[4]
 *     nc2p = HKDF-SHA-256(salt=UTF8(pairingId), ikm=SK, info="cc-e2e-v1/nc2p" ‖ pairContext)[4]
 *
 * A2 STRIKES A1's "defence in depth" rationale, and the strike is the part that
 * must survive into the code: **the prefix contributes ZERO nonce uniqueness.**
 * It is a deterministic function of SK and pairEpoch, so a device that restores
 * a stale counter re-derives the identical prefix. Anyone reasoning "the prefix
 * varies, so a repeated seq is survivable" has reintroduced GCM nonce reuse —
 * total loss of confidentiality AND forgery resistance for that key.
 *
 * Therefore A1's persist-before-emit counter is the SOLE control, and A2
 * upgrades it from acceptance criterion to BLOCKING. Two consequences are
 * implemented here rather than documented:
 *
 *   • {@link createFailClosedSender} refuses to hand out a seq it cannot prove
 *     is beyond every value already used, and says `rekey` when it refuses.
 *     `tests/e2e-web-session.test.mjs` drives the cleared-IndexedDB and
 *     copied-profile cases and requires the refusal — the web equivalent of
 *     P4's E2eSeqStoreTest.restore_from_backup_fails_closed.
 *   • {@link bindKid} enforces A2's MUST #1, kid ↔ SK strictly 1:1. The web is
 *     not the minter, so it cannot enforce this at mint; it enforces the
 *     property it CAN observe — the same kid coming back under a different SK —
 *     and refuses, because that is precisely the state (a counter restarting at
 *     0 against a live key) the MUST exists to prevent.
 *
 * A2 MUST #2: the prefix is DERIVED EVERY SESSION AND NEVER PERSISTED. There is
 * no code path in this file that writes a prefix to storage; a persisted prefix
 * is stale state that can outlive a restore and is the one way this design
 * drifts back into the bug A2 removed.
 *
 * ── THE WRAP FORMAT IS NOT IN THE SPEC ─────────────────────────────────────
 * §13.10 specifies the KEK and the frame AEAD but never says how SK is sealed
 * to a recipient. The phone is the minter, so the phone's implementation is the
 * contract; {@link openWrap} is transcribed from `E2eAccept.kt` on
 * `e2e/p4-android-v58` @ acb4eb2 (frameType "cc-e2e-wrap", seq 0, direction
 * p2c, sessionPrefix = SHA-256(UTF8(deviceId))[0..4], padded per §13.4, wire
 * form base64url). Flagged to Ken as a spec gap: this is a cross-lane byte
 * contract living in one lane's source file, and the next implementer will not
 * find it by reading the spec.
 */

import {
  DIR_P2C,
  DIR_C2P,
  LABEL_PREFIX,
  SESSION_PREFIX_BYTES,
  concatBytes,
  fromHex,
  hkdf32,
  kek as deriveKek,
  open as aeadOpen,
  pairContext as buildPairContext,
  seal as aeadSeal,
  toHex,
  trafficKeys,
} from './kdf.mjs';

export { DIR_P2C, DIR_C2P, SESSION_PREFIX_BYTES };

const te = new TextEncoder();

function requireSubtle(subtle) {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s) throw new Error('session: no WebCrypto SubtleCrypto in this context');
  return s;
}

// ───────────────────────────────────────────────────────────────────────────
// A2 — the derived nonce prefixes. THE ONE SOURCE. Nothing else may build a
// nonce prefix; a second source is how the two ends stop agreeing.
// ───────────────────────────────────────────────────────────────────────────

export const LABEL_NP2C = `${LABEL_PREFIX}/np2c`;
export const LABEL_NC2P = `${LABEL_PREFIX}/nc2p`;

/** "cc-e2e-v1/np2c" ‖ pairContext (or the /nc2p label). Split out so a test can pin the info bytes (vector E). */
export function noncePrefixInfo(context, direction) {
  const ctx = context instanceof Uint8Array ? context : buildPairContext(context);
  if (direction === DIR_P2C) return concatBytes([te.encode(LABEL_NP2C), ctx]);
  if (direction === DIR_C2P) return concatBytes([te.encode(LABEL_NC2P), ctx]);
  throw new Error(`session: direction must be 0x01 or 0x02, got ${direction}`);
}

/**
 * Both prefixes, derived. Returned together and never individually, so a caller
 * cannot ask for "the prefix for a direction" with the wrong direction in hand —
 * the same discipline A1 (2) imposed on `trafficKeys`.
 *
 * A2: "L = 4 and expand-32-then-truncate are the same bytes (HKDF-Expand emits
 * T(1) first), but implementations SHOULD request L = 4 so the intent is not
 * mistaken for a truncated key." The frozen `hkdf32` only emits 32, and it is
 * frozen, so this truncates — which A2 explicitly declares conformant. The
 * intent is stated here instead, and vector E pins the result either way.
 */
export async function deriveNoncePrefixes({ pairingId, sessionKey, context }, subtle = undefined) {
  const s = requireSubtle(subtle);
  const ctx = context instanceof Uint8Array ? context : buildPairContext(context);
  const np2c = (await hkdf32(
    { salt: pairingId, ikm: sessionKey, info: noncePrefixInfo(ctx, DIR_P2C) }, s,
  )).slice(0, SESSION_PREFIX_BYTES);
  const nc2p = (await hkdf32(
    { salt: pairingId, ikm: sessionKey, info: noncePrefixInfo(ctx, DIR_C2P) }, s,
  )).slice(0, SESSION_PREFIX_BYTES);
  // A2 vector H, enforced rather than merely tested: distinct labels cannot
  // produce equal prefixes, but feeding the same label twice is a one-character
  // typo and this is where it surfaces.
  if (toHex(np2c) === toHex(nc2p)) {
    throw new Error('session: np2c === nc2p — the two labels collapsed (A2 vector H)');
  }
  if (np2c.every((b) => b === 0) || nc2p.every((b) => b === 0)) {
    throw new Error('session: a derived nonce prefix is all-zero (A2 vector H)');
  }
  return { np2c, nc2p };
}

// ───────────────────────────────────────────────────────────────────────────
// (d) key agreement + unwrap
// ───────────────────────────────────────────────────────────────────────────

/** The phone's wrap frame type. Not `*_CHUNK`, so the wrap IS padded (§13.4). */
export const WRAP_FRAME_TYPE = 'cc-e2e-wrap';

/** SHA-256(UTF8(deviceId))[0..4] — the phone's per-recipient wrap prefix. */
export async function wrapPrefix(deviceId, subtle = undefined) {
  const s = requireSubtle(subtle);
  const digest = new Uint8Array(await s.digest('SHA-256', te.encode(deviceId)));
  return digest.slice(0, SESSION_PREFIX_BYTES);
}

/**
 * ECDH(epk, ourPriv) → KEK → open our wrap → SK.
 *
 * `ourPrivateKey` is the NON-EXTRACTABLE CryptoKey from webKey.ts; the shared
 * secret `Z` is the only intermediate that exists as bytes here, and it is
 * zeroed before returning. SK is returned to the caller and lives in module
 * scope from there — never in storage, on either the success or the error path.
 */
export async function openWrap(
  { wrap, kid, epk, ourPrivateKey, ourPublicSec1, ourDeviceId, pairingId, context, pairEpoch },
  subtle = undefined,
) {
  const s = requireSubtle(subtle);
  const epkBytes = epk instanceof Uint8Array ? epk : fromHex(epk);
  const ctx = context instanceof Uint8Array ? context : buildPairContext(context);
  const peer = await s.importKey('raw', epkBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  let z = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: peer }, ourPrivateKey, 256));
  let kekBytes;
  try {
    kekBytes = await deriveKek(
      { pairingId, sharedSecret: z, context: ctx, recipientKey: ourPublicSec1 }, s,
    );
    const key = await s.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    return await aeadOpen({
      receiver: { direction: DIR_P2C, key, sessionPrefix: await wrapPrefix(ourDeviceId, s) },
      frameType: WRAP_FRAME_TYPE,
      kid,
      seq: 0,
      pairEpoch,
      ciphertext: wrap instanceof Uint8Array ? wrap : fromBase64Url(wrap),
    }, s);
  } finally {
    z.fill(0);
    if (kekBytes) kekBytes.fill(0);
    z = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// base64url — browser-safe (no Buffer), shared with the SW
// ───────────────────────────────────────────────────────────────────────────

export function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('session: not base64url');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// (e) the envelope — {e:1, kid, s, c}
// ───────────────────────────────────────────────────────────────────────────

export const ENVELOPE_VERSION = 1;

export function encodeEnvelope({ kid, seq, ciphertext }) {
  return { e: ENVELOPE_VERSION, kid, s: Number(seq), c: toBase64Url(ciphertext) };
}

/**
 * Recognise and validate an envelope. Returns null for anything that is not one
 * — a plaintext frame is not an error here, it is the OTHER branch, and the
 * mode check that decides whether plaintext is acceptable lives at the call
 * site (C-1's downgrade latch), never in a parser.
 */
export function decodeEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.e !== ENVELOPE_VERSION) return null;
  if (typeof value.kid !== 'string' || value.kid.length === 0 || value.kid.length > 128) return null;
  if (typeof value.s !== 'number' || !Number.isInteger(value.s) || value.s < 0) return null;
  if (typeof value.c !== 'string' || value.c.length === 0) return null;
  let ciphertext;
  try {
    ciphertext = fromBase64Url(value.c);
  } catch {
    return null;
  }
  // GCM tag is 16 bytes and the smallest §13.4 bucket is 64, so anything under
  // 80 cannot be a sealed frame whatever else it is.
  if (ciphertext.length < 80) return null;
  return { kid: value.kid, seq: value.s, ciphertext };
}

// ───────────────────────────────────────────────────────────────────────────
// the fail-closed send counter — A2's SOLE control against nonce reuse
// ───────────────────────────────────────────────────────────────────────────

export const SEQ_RECORD_VERSION = 1;

/**
 * Why `refuse` is a value and not an exception at construction: the caller must
 * be able to tell "this pair needs a rekey" (LEAVE_ACTIVE, re-Accept, new SK,
 * new kid) apart from "something is broken", and act on the first without a
 * try/catch around its own state machine.
 */
export class SeqFailClosedError extends Error {
  constructor(reason, detail) {
    super(`session: refusing to encrypt — ${detail}`);
    this.name = 'SeqFailClosedError';
    this.code = 'e2e-seq-fail-closed';
    this.reason = reason; // 'counter-lost' | 'kid-reused' | 'commit-failed'
    this.rekey = true;
  }
}

/**
 * A durable per-(kid, direction) counter.
 *
 * `load` returns the stored record or undefined; `commit` MUST NOT resolve
 * until the value is durable. The web implementation is IndexedDB
 * ({@link indexedDbSeqStore}); the tests inject memory and a failing store.
 */
export function memorySeqStore(seed = new Map()) {
  const m = new Map(seed);
  return {
    async load(id) { return m.get(id); },
    async commit(id, record) { m.set(id, { ...record }); },
    async clear() { m.clear(); },
    /** Test affordance: the copied-profile / restore-from-backup scenario. */
    _snapshot() { return new Map(m); },
  };
}

function seqId(kid, direction) {
  return `${kid}:${direction}`;
}

/** SHA-256(SK), hex — the SK identity we compare a returning kid against. */
export async function skFingerprint(sessionKey, subtle = undefined) {
  const s = requireSubtle(subtle);
  return toHex(new Uint8Array(await s.digest('SHA-256', sessionKey)));
}

/**
 * A2 MUST #1, enforced from the side that does not mint.
 *
 * `fresh` is the caller's evidence that this kid was minted NOW — a
 * PAIRING_ACTIVE that is not a resume. Read the four outcomes as a table:
 *
 *   no record + fresh    → first use. Commit next=0 BEFORE any frame. OK.
 *   no record + resumed  → REFUSE. The pair predates our storage, so the phone
 *                          believes this kid has history we cannot bound. This
 *                          is the restore-from-backup / cleared-site-data case
 *                          and the one A2 made blocking.
 *   record + same SK     → resume. Continue from the stored floor. OK.
 *   record + other SK    → REFUSE. A kid reused under a second SK restarts a
 *                          counter at 0 against a live key and a re-derived
 *                          prefix: GCM nonce reuse.
 */
export async function bindKid(
  { store, kid, direction, sessionKey, fresh }, subtle = undefined,
) {
  const id = seqId(kid, direction);
  const fp = await skFingerprint(sessionKey, subtle);
  const existing = await store.load(id);
  if (existing === undefined || existing === null) {
    if (!fresh) {
      throw new SeqFailClosedError(
        'counter-lost',
        `kid ${kid} arrived on a RESUME with no stored counter — its history cannot be bounded, ` +
          'so every seq we could choose may already have been used under this key (A2)',
      );
    }
    const record = { v: SEQ_RECORD_VERSION, kid, direction, next: 0, sk: fp };
    await store.commit(id, record);
    return { ...record, resumed: false };
  }
  if (existing.v !== SEQ_RECORD_VERSION) {
    throw new SeqFailClosedError('counter-lost', `seq record version ${existing.v} is unreadable`);
  }
  if (existing.sk !== fp) {
    throw new SeqFailClosedError(
      'kid-reused',
      `kid ${kid} has returned under a DIFFERENT session key (A2 MUST: kid <-> SK is 1:1)`,
    );
  }
  if (typeof existing.next !== 'number' || !Number.isInteger(existing.next) || existing.next < 0) {
    throw new SeqFailClosedError('counter-lost', 'stored seq floor is not a whole number');
  }
  return { ...existing, resumed: true };
}

/** §13.8: rekey at 2^32 frames. Load-bearing for the AEAD under A1 (3). */
export const SEQ_REKEY_LIMIT = 2 ** 32;

/**
 * Persist-before-emit. `next()` commits `n + 1` and only then returns `n`, so a
 * crash between the two loses a sequence number — which is free — instead of
 * reusing one, which is not. A failed commit is a REFUSAL, never a warning:
 * emitting after a failed commit is exactly the state the rule forbids.
 */
export function createFailClosedSender({ store, kid, direction, floor, sk }) {
  let next = floor;
  let poisoned = null;
  return {
    kid,
    direction,
    get floor() { return next; },
    async nextSeq() {
      if (poisoned) throw poisoned;
      if (next >= SEQ_REKEY_LIMIT) {
        poisoned = new SeqFailClosedError('counter-lost', `seq reached the ${SEQ_REKEY_LIMIT} rekey limit (§13.8)`);
        throw poisoned;
      }
      const seq = next;
      try {
        // `sk` is carried from bindKid rather than re-read per frame: a read
        // on the hot path is one more thing that can fail between deciding to
        // send and being allowed to, and the fingerprint cannot change under a
        // sender that is already bound to this kid.
        await store.commit(seqId(kid, direction), {
          v: SEQ_RECORD_VERSION, kid, direction, next: seq + 1, sk,
        });
      } catch (e) {
        // One failure poisons the sender. Retrying a commit that failed for a
        // reason we cannot see (quota, eviction, a closed database) and then
        // emitting anyway is the failure mode dressed as resilience.
        poisoned = new SeqFailClosedError('commit-failed', `the seq counter could not be persisted: ${e.message}`);
        throw poisoned;
      }
      next = seq + 1;
      return seq;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (f) dedupe window — DROP, never reject
// ───────────────────────────────────────────────────────────────────────────

export const DEDUPE_WINDOW = 1024;
export const DEDUPE_FLOOR_ADVANCE_CAP = 256;

/**
 * Per (kid, direction). Anti-replay DEDUPES, it does not reject: `frameBuffer`
 * replay on resume re-delivers frames we have already seen, and that replay is
 * LEGITIMATE — it is how a reconnecting client catches up. A duplicate is
 * dropped silently and counted; nothing is sent back, nothing errors.
 *
 * The floor-advance cap is the part worth understanding. A far-future seq from
 * an attacker would, without a cap, slide the floor past thousands of sequence
 * numbers the real peer has not sent yet, and every one of those frames would
 * then be dropped as "old" — a denial of service built out of the replay
 * defence. Advancing at most 256 per frame bounds that damage to a window the
 * real peer refills in ordinary traffic.
 */
export function createDedupeWindow() {
  let floor = 0;
  let seen = new Set();
  let drops = 0;
  return {
    get floor() { return floor; },
    get drops() { return drops; },
    get size() { return seen.size; },
    /** @returns true when the frame is NEW and should be processed. */
    accept(seq) {
      if (!Number.isInteger(seq) || seq < 0) { drops += 1; return false; }
      if (seq < floor) { drops += 1; return false; }
      if (seen.has(seq)) { drops += 1; return false; }
      seen.add(seq);
      if (seq >= floor + DEDUPE_WINDOW) {
        const target = seq - DEDUPE_WINDOW + 1;
        floor = Math.min(target, floor + DEDUPE_FLOOR_ADVANCE_CAP);
        for (const v of seen) if (v < floor) seen.delete(v);
      }
      return true;
    },
    /** A new pairEpoch is a new key space; the old window means nothing in it. */
    reset() { floor = 0; seen = new Set(); drops = 0; },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// the session — one object, one send key, one receive key, one chokepoint
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the computer-side session from an opened wrap.
 *
 * `role: 'computer'` is hard-coded: this module runs on the web page and in the
 * service worker, and both are the computer. A1 (2)'s mandatory consequence is
 * that a caller must not be able to name the other side's key pair, so `role`
 * is not a parameter.
 */
export async function createComputerSession(
  { pairingId, sessionKey, context, kid, pairEpoch, store, fresh }, subtle = undefined,
) {
  const s = requireSubtle(subtle);
  const ctx = context instanceof Uint8Array ? context : buildPairContext(context);
  const keys = await trafficKeys({ pairingId, sessionKey, context: ctx, role: 'computer' }, s);
  const { np2c, nc2p } = await deriveNoncePrefixes({ pairingId, sessionKey, context: ctx }, s);
  // role 'computer': we SEND c2p and RECEIVE p2c. The prefixes follow the
  // direction, not the role, so they are matched to the keys here once.
  const sendPrefix = nc2p;
  const recvPrefix = np2c;

  const bound = await bindKid(
    { store, kid, direction: keys.send.direction, sessionKey, fresh }, s,
  );
  const counter = createFailClosedSender({
    store, kid, direction: keys.send.direction, floor: bound.next, sk: bound.sk,
  });
  const dedupe = createDedupeWindow();

  return {
    kid,
    pairEpoch,
    resumed: bound.resumed,
    get drops() { return dedupe.drops; },
    get sendFloor() { return counter.floor; },
    get recvFloor() { return dedupe.floor; },
    resetDedupe: () => dedupe.reset(),

    /** THE outbound chokepoint. Pads (§13.4), seals, returns the envelope. */
    async seal(frameType, plaintext) {
      // Caught by scripts/e2e-live-peer-proof.mjs, and worth a guard rather than
      // a comment: handed an OBJECT instead of bytes, the chain downstream
      // stringifies it and cheerfully seals the 15 bytes "[object Object]".
      // Everything succeeds — the envelope is well-formed, the tag verifies,
      // the peer opens it — and the user's message is simply gone. A silent,
      // authenticated, correctly-encrypted delivery of nothing.
      if (!(plaintext instanceof Uint8Array)) {
        throw new TypeError(
          `session.seal: plaintext must be a Uint8Array, got ${plaintext === null ? 'null' : typeof plaintext}`,
        );
      }
      const seq = await counter.nextSeq();
      const ciphertext = await aeadSeal({
        sender: { ...keys.send, sessionPrefix: sendPrefix },
        frameType, kid, seq, pairEpoch, plaintext,
      }, s);
      return encodeEnvelope({ kid, seq, ciphertext });
    },

    /**
     * THE inbound decoder. Returns `{ok:true, plaintext}`, or `{ok:false,
     * reason}` — never throws for a bad frame. Every failure is a DROP:
     *   'kid'       the envelope names another key id (a stale replay)
     *   'duplicate' already seen, or below the window floor — the resume replay
     *   'auth'      the tag did not verify, or the padding was malformed
     * A tag failure is indistinguishable from a duplicate to an observer, which
     * is the point: neither answers back.
     */
    async open(frameType, envelope) {
      const parsed = decodeEnvelope(envelope);
      if (!parsed) return { ok: false, reason: 'shape' };
      if (parsed.kid !== kid) { dedupe.accept(-1); return { ok: false, reason: 'kid' }; }
      if (!dedupe.accept(parsed.seq)) return { ok: false, reason: 'duplicate' };
      try {
        const plaintext = await aeadOpen({
          receiver: { ...keys.recv, sessionPrefix: recvPrefix },
          frameType, kid, seq: parsed.seq, pairEpoch, ciphertext: parsed.ciphertext,
        }, s);
        return { ok: true, plaintext, seq: parsed.seq };
      } catch {
        return { ok: false, reason: 'auth' };
      }
    },

    /** Test/vector affordance only. Production code has no reason to read these. */
    _raw: { send: keys.send.rawBytes, recv: keys.recv.rawBytes, np2c, nc2p },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// the IndexedDB seq store (web). Kept here so P3 can supply its own.
// ───────────────────────────────────────────────────────────────────────────

export const SEQ_DB_NAME = 'cc-e2e';
export const SEQ_DB_VERSION = 1;
export const SEQ_STORE_NAME = 'seq';

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * NOTE the transaction discipline: `commit` resolves on the TRANSACTION's
 * `complete` event, not on the request's `success`. A request succeeds while the
 * transaction is still in flight, so resolving there would let a frame leave
 * before its counter was durable — persist-before-emit that does not actually
 * persist first, which is the whole rule undone by one event name.
 */
export function indexedDbSeqStore(factory) {
  const resolveFactory = () => {
    const f = factory ?? globalThis.indexedDB;
    if (!f) throw new Error('session: IndexedDB is unavailable in this context');
    return f;
  };
  const open = () => new Promise((resolve, reject) => {
    const req = resolveFactory().open(SEQ_DB_NAME, SEQ_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SEQ_STORE_NAME)) db.createObjectStore(SEQ_STORE_NAME);
      if (!db.objectStoreNames.contains('deviceKey')) db.createObjectStore('deviceKey');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return {
    async load(id) {
      const db = await open();
      try {
        const tx = db.transaction(SEQ_STORE_NAME, 'readonly');
        return await idbRequest(tx.objectStore(SEQ_STORE_NAME).get(id));
      } finally { db.close(); }
    },
    async commit(id, record) {
      const db = await open();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(SEQ_STORE_NAME, 'readwrite');
          tx.objectStore(SEQ_STORE_NAME).put(record, id);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error ?? new Error('seq commit aborted'));
          tx.onerror = () => reject(tx.error ?? new Error('seq commit failed'));
        });
      } finally { db.close(); }
    },
    async clear() {
      const db = await open();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(SEQ_STORE_NAME, 'readwrite');
          tx.objectStore(SEQ_STORE_NAME).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('seq clear failed'));
        });
      } finally { db.close(); }
    },
  };
}
