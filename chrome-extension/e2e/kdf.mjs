/**
 * lib/e2e/kdf.mjs — the frozen key schedule and AEAD layout (E2E-SPEC §13.10,
 * the section Security's GATE1 "Addendum A1 — AMENDED" calls §13.9).
 *
 * Three implementations must derive the same bytes from the same inputs: the
 * web page (P2), the extension service worker (P3) and the Android app (P4).
 * When they disagree the only symptom is "Encrypted mode never pairs", with
 * every log line on every side reporting success — so the schedule is frozen
 * here, byte for byte, and pinned by tests/kdf-vectors.json (which the Android
 * lane asserts against the same file).
 *
 * WHY THE FRAMING EXISTS (the bug A1 ratifies the fix for):
 * the original prose was `info = "cc-e2e-v1" ‖ userId ‖ phoneDeviceId ‖ …`.
 * Bare concatenation of variable-length ids is ambiguous: user `ab` + phone
 * `cd` produces the same info bytes as user `a` + phone `bcd`, so two different
 * pairings derive identical traffic keys. It is invisible to any test using
 * fixed-width ids and unfixable after ship. Every variable-length value
 * therefore carries a one-byte TAG and a u8 LENGTH prefix, exactly as the
 * already-frozen SAS transcript (§13.3) frames its own inputs.
 *
 * RESERVED TAG RANGES — disjoint by construction, and they MUST stay disjoint:
 *
 *   0x01..0x04   SAS transcript          (§13.3, frozen)
 *   0x11..0x15   KDF pair context        (this module)
 *   0x21..0x25   AEAD associated data    (this module)
 *   0x05..0x10, 0x16..0x20, 0x26..0xff   RESERVED — allocate a NEW range.
 *
 * Disjointness is a real cross-protocol defence, not tidiness: a SAS transcript
 * can never be replayed as a KDF info string, or the reverse.
 *
 * LAYOUT (authoritative — Addendum A1, 2026-09-17T22:34Z):
 *
 *   pairContext = 0x11 u8(len) userId
 *               ‖ 0x12 u8(len) phoneDeviceId
 *               ‖ 0x13 u8(len) peerDeviceId
 *               ‖ 0x14 be64(pairEpoch)
 *
 *   salt        = UTF8(pairingId)            -- the HKDF salt, no tag, no prefix:
 *                                               it is a separate argument, so it
 *                                               is structurally unambiguous.
 *
 *   KEK_i = HKDF-SHA-256(salt, ikm = ECDH(epk_priv, K_i),
 *               info = "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i)  -> 32 B
 *   k_p2c = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/p2c" ‖ pairContext)
 *   k_c2p = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/c2p" ‖ pairContext)
 *
 *   np2c  = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/np2c" ‖ pairContext) -> 4
 *   nc2p  = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/nc2p" ‖ pairContext) -> 4
 *
 *   cipher      = AES-256-GCM, 128-bit tag, 96-bit nonce
 *   nonce (12B) = np2c ‖ be64(seq)   for p2c,  nc2p ‖ be64(seq)   for c2p
 *                 (A2: DERIVED, never transmitted, never persisted — NOT random)
 *   AAD         = 0x21 u8(len) frameType ‖ 0x22 u8(len) kid ‖ 0x23 be64(seq)
 *               ‖ 0x24 u8 direction (0x01 p2c / 0x02 c2p) ‖ 0x25 be64(pairEpoch)
 *   GCM plaintext = the §13.4 PADDED block. Pad first, then seal.
 *
 * FOUR RULES THAT ARE NOT OPTIONAL:
 *
 * 1. THE AAD IS NOT THE JSON HEADER BYTES. The wire header `{e,kid,s}` is JSON,
 *    and JSON key order, spacing and number formatting are not canonical across
 *    Kotlin and JS. Both sides parse the header and RE-ENCODE the five fields
 *    above. Authenticating serializer output would make a whitespace difference
 *    present itself as a decryption failure.
 *
 * 2. THE NONCE IS COUNTER-BASED, AND THE PREFIX CONTRIBUTES NOTHING. `seq` is
 *    per (kid, direction), starts at 0 and strictly increments. A2 REPLACED
 *    A1's "4-byte random sessionPrefix" with a derived one and WITHDREW the
 *    "defence in depth against a state-restore bug" rationale along with it:
 *    the prefix is a deterministic function of SK and pairEpoch, so within one
 *    epoch a restore reproduces it exactly. Rule 3 below is now the SOLE
 *    control against nonce reuse. Anyone reasoning "the prefix varies so a
 *    counter collision is fine" has reintroduced the bug, and in GCM a repeated
 *    nonce is not a degradation — it is total loss of confidentiality AND
 *    forgery for that key.
 *
 * 3. PERSIST BEFORE EMIT, AND FAIL CLOSED. The counter must be durably
 *    committed before the frame it authorises leaves the device. A device that
 *    cannot prove its counter is strictly beyond every value it has used
 *    (restore from backup, cleared storage, corrupt state) MUST refuse to
 *    encrypt and force a rekey — never resume at a guess, never restart at 0.
 *    `createSender()` below makes that structural: it will not mint a sequence
 *    number without an awaited durable commit.
 *
 * 4. DIRECTIONAL KEYS NEVER CROSS. `k_p2c ≠ k_c2p`, so a frame reflected back
 *    at its sender cannot decrypt under the sender's own receive key. There is
 *    deliberately NO `keyForDirection(dir)` helper: `trafficKeys()` hands a
 *    caller exactly one send key and one receive key, and the caller cannot
 *    name the other. Directional separation enforced by a naming convention is
 *    directional separation that will be violated.
 *
 * Environment: WebCrypto only (`crypto.subtle`) plus lib/e2e/padding.mjs. No
 * DOM, no Node built-ins — this exact module runs unchanged inside the MV3
 * service worker, where `window` and `document` do not exist.
 */

import { padPlaintext, unpadPlaintext } from './padding.mjs';

/** The common label prefix. The three suffixes below are what separate purposes. */
export const LABEL_PREFIX = 'cc-e2e-v1';
export const LABEL_KEK = `${LABEL_PREFIX}/kek`;
export const LABEL_P2C = `${LABEL_PREFIX}/p2c`;
export const LABEL_C2P = `${LABEL_PREFIX}/c2p`;
/**
 * A2 (RATIFIED, 2026-09-17T15:50Z) — the nonce-prefix labels. New members of
 * the `cc-e2e-v1/` namespace, distinct from /kek, /p2c and /c2p, and a typo
 * that fed the same label to both directions would produce equal prefixes,
 * which vector H exists to catch.
 */
export const LABEL_NP2C = `${LABEL_PREFIX}/np2c`;
export const LABEL_NC2P = `${LABEL_PREFIX}/nc2p`;

/** Pair-context tags (0x11..0x15). */
export const TAG_USER_ID = 0x11;
export const TAG_PHONE_DEVICE_ID = 0x12;
export const TAG_PEER_DEVICE_ID = 0x13;
export const TAG_PAIR_EPOCH = 0x14;
export const TAG_RECIPIENT_KEY = 0x15;

/** AEAD associated-data tags (0x21..0x25). */
export const TAG_AAD_FRAME_TYPE = 0x21;
export const TAG_AAD_KID = 0x22;
export const TAG_AAD_SEQ = 0x23;
export const TAG_AAD_DIRECTION = 0x24;
export const TAG_AAD_PAIR_EPOCH = 0x25;

/** Direction bytes. p2c = phone → computer, c2p = computer → phone. */
export const DIR_P2C = 0x01;
export const DIR_C2P = 0x02;

/** GCM parameters. 96-bit nonce, 128-bit tag — both frozen. */
export const NONCE_BYTES = 12;
export const SESSION_PREFIX_BYTES = 4;
export const TAG_BITS = 128;
export const KEY_BYTES = 32;

/**
 * A recipient static public key is uncompressed SEC1, 0x04-prefixed, EXACTLY
 * 65 bytes (GATE1 R1). Reject any other length at import — never infer.
 */
export const SEC1_P256_BYTES = 65;

/** The u8 length-prefix cap. Enforced, never assumed — see assertU8Length. */
export const MAX_PREFIXED_BYTES = 255;

const te = new TextEncoder();

// ── byte helpers (kept local so the module imports nothing but padding) ─────

/** Hex → bytes. Accepts upper or lower case; rejects anything else loudly. */
export function fromHex(hex) {
  const s = String(hex).trim();
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`kdf: not a hex string of whole bytes (length ${s.length})`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function u8(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`kdf: u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

/**
 * Big-endian uint64. BigInt, not a JS number: a pairEpoch or seq above 2^53
 * would silently round on the web side and derive a different key from the one
 * Kotlin derives from the same value.
 */
export function be64(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`kdf: value out of uint64 range: ${value}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function asBytes(value, what) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return te.encode(value);
  throw new Error(`kdf: ${what} must be a string or Uint8Array`);
}

/**
 * The u8 cap, ENFORCED. A1 ratified u8 over u16 on the grounds that the ids are
 * cuid/uuid-shaped (~25–36 bytes), but explicitly required the cap to throw:
 * silent truncation to `len & 0xff` would recreate the exact collision the
 * framing exists to kill, in the one code path nobody tests.
 */
function assertU8Length(bytes, what) {
  if (bytes.length === 0) throw new Error(`kdf: ${what} may not be empty`);
  if (bytes.length > MAX_PREFIXED_BYTES) {
    throw new Error(
      `kdf: ${what} is ${bytes.length} bytes; the frozen layout u8-length-prefixes it, so ${MAX_PREFIXED_BYTES} is the cap`,
    );
  }
  return bytes;
}

/** tag ‖ u8(len) ‖ value, the framing inherited from the frozen SAS (§13.3). */
function tagged(tag, value, what) {
  const bytes = assertU8Length(asBytes(value, what), what);
  return [u8(tag), u8(bytes.length), bytes];
}

// ── (1) pair context ────────────────────────────────────────────────────────

/**
 * The exact pairContext bytes. Split out from every derivation so a test can
 * pin the context itself rather than only the keys it happens to produce — a
 * 32-byte key that matches proves the whole chain, but when it does NOT match
 * the context is where the divergence is readable.
 */
export function pairContext({ userId, phoneDeviceId, peerDeviceId, pairEpoch }) {
  return concatBytes([
    ...tagged(TAG_USER_ID, userId, 'userId'),
    ...tagged(TAG_PHONE_DEVICE_ID, phoneDeviceId, 'phoneDeviceId'),
    ...tagged(TAG_PEER_DEVICE_ID, peerDeviceId, 'peerDeviceId'),
    u8(TAG_PAIR_EPOCH), be64(pairEpoch),
  ]);
}

/**
 * A3 (RATIFIED AMENDED, 2026-09-17T23:41Z) — build the pair context from the
 * `ctx` object carried on the wire PLUS the receiver's OWN session userId.
 *
 * Why this function exists at all: three of the four context fields are known
 * only to the phone. Before A3 the computer side had to guess `phoneDeviceId`
 * and `pairEpoch`, and a guess that differs by one byte derives a completely
 * different key — every sealed frame fails authentication while both sides log
 * success, and both loopback tests are blind to it by construction.
 *
 * `userId` is deliberately NOT on the wire. Each side uses its own
 * authenticated session identity and a mismatch fails closed; transmitting it
 * would let the relay propose an identity, and the derivation would then agree
 * with the relay instead of with the session. Vector I.3 pins that: one
 * character of local userId yields total key divergence.
 *
 * `pairEpoch` arrives as a DECIMAL STRING and is parsed with BigInt. It must
 * never be a JSON number — `JSON.parse` yields a double, and A1 forbids
 * pairEpoch rounding above 2^53. The regex is deliberately narrow: no leading
 * zeros, no sign, no whitespace, no decimal point, and `Number()` is never
 * reached. Every one of those is a value that would otherwise COERCE into a
 * plausible epoch and derive a key nobody else holds.
 *
 * A3-M3 is RE-SCOPED IN FULL by GATE1 Addendum A4 (RATIFIED AMENDED,
 * 2026-09-17T20:58Z). What this function used to enforce —
 * `ctx.peerDeviceId !== own deviceId → refuse` — is DELETED, not relaxed. It
 * refused every recipient except one and made multi-recipient pairing
 * impossible: `ctx` is PAIR-scoped (A3-M1: "every recipient gets the identical
 * object"), so under that clause the page and the extension SW could not both
 * be admitted by the same block, and a single broadcast ciphertext (the relay
 * sends ONE, byte-identically, to every listener) had no reading under which it
 * opened for both.
 *
 * What replaces it, and where each half is checked:
 *
 *   (a) PAIRING — `ctx.pairingId` must equal the pairing this receiver is party
 *       to, wherever it independently knows that value. Checked here, via
 *       `pairingId`. Passing `ctxWire.pairingId` back as its own expectation is
 *       a check that CANNOT FAIL, which is worse than no check because it reads
 *       like one that can; callers must supply a value they learned elsewhere.
 *
 *   (b) MEMBERSHIP — the wrap addressed to this device opens under
 *       `KEK(pairContext, its own static key)`. That is the binding check and
 *       it is NOT here: this module does not hold wraps. It lives at the
 *       caller's unwrap, and A4-M3 makes its failure a PAIRING ABORT — never a
 *       degrade to counts-only, which §13.2 row 2 grants only to a recipient
 *       that never had a key at all.
 *
 *   (c) CANONICAL PEER — conditional, and ONLY where verifiable. A receiver
 *       that holds the full `wraps[]` (the page, via ACCEPT_PAIRING /
 *       PAIRING_ACTIVE, which forward the block whole) passes
 *       `recipientDeviceIds` and we refuse unless `ctx.peerDeviceId` is the
 *       byte-wise lowest of that set. A receiver that does NOT hold the set
 *       (the extension service worker, via PAIR_STATE, whose allowlist carries
 *       `wrap` SINGULAR — deliberately, so other devices' sealed key material
 *       never enters a service worker) omits it, and we then perform NO peer
 *       check at all. It MUST NOT substitute its own deviceId: that is exactly
 *       the deleted clause coming back through the side door.
 *
 * Hence `deviceId` is REJECTED rather than ignored. A caller still passing it
 * believes a membership check is running; silently dropping the option would
 * leave that belief intact while the check was gone — the decorative-control
 * shape this programme has refused since §13.6's pin. It throws, and the
 * message names the option to pass instead.
 *
 * NOT enforced here, and deliberately: A3-M2's epoch floor
 * (`lastPairEpoch[(userId, phoneDeviceId)]`, persisted BEFORE the derived keys
 * are used, refusing `pairEpoch <= floor`, TOFU on first sight, cleared only by
 * an explicit user unpair). That needs durable per-device storage this module
 * does not have and must not invent — each lane owns it. `pairEpoch` is
 * returned alongside the bytes so the caller has no excuse not to check it.
 *
 * A3-M4 — a mode=1 block arriving with NO ctx MUST be refused, never
 * derived-from-local — is why the missing-ctx case THROWS rather than falling
 * back to `pairContext()` with local guesses.
 */
export const PAIR_EPOCH_WIRE_RE = /^(0|[1-9][0-9]{0,19})$/;
export const MAX_UINT64 = 0xffffffffffffffffn;

/** Byte-wise lexicographic order over two UTF-8 encodings. Shorter-is-lower on a prefix. */
function compareUtf8(a, b) {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * A4-R2 (FROZEN) — the CANONICAL PEER of a pairing: the byte-wise
 * lexicographically lowest `wraps[].deviceId`, compared as raw UTF-8 bytes.
 *
 * The canonical set is `wraps[].deviceId` and NOT `recipKeys[]`. `recipKeys[]`
 * is the full static KEY set of the pairing — SEC1 public keys, and it includes
 * the PHONE (lib/e2eBlock-core.js:152-155). A "lowest of recipKeys[]" is
 * neither a deviceId nor a recipient-only set. `wraps[].deviceId` is bounded
 * 1..128 chars and already proven duplicate-free by `validateE2eBlock`
 * (lib/e2eBlock-core.js:169-173), and that uniqueness is what makes "lowest"
 * TOTAL: there can be no tie to break.
 *
 * UTF-8 BYTES, not JS string order. `a < b` on strings compares UTF-16 code
 * units, which disagrees with byte order for anything above U+FFFF (a
 * surrogate pair sorts below U+E000..U+FFFF in UTF-16 and above it in UTF-8).
 * deviceIds are ASCII today; the day one is not, a JS-`<` implementation and a
 * Kotlin one would pick DIFFERENT canonical peers and every recipient would
 * fail closed with a tag error and no attribution. `localeCompare` is worse
 * still — it is locale-dependent, so the same build would disagree with itself
 * across machines.
 *
 * Deterministic and ORDER-INDEPENDENT: a relay that re-orders `wraps[]` without
 * editing it derives the same peer, so reordering alone cannot steer.
 *
 * Accepts `[{deviceId}]` (the block's own shape) or a bare `[string]`.
 */
export function canonicalPeerDeviceId(wraps) {
  if (!Array.isArray(wraps) || wraps.length === 0) {
    throw new Error('kdf: canonicalPeerDeviceId needs a non-empty wraps[] (or deviceId[]) — A4-R2');
  }
  const ids = wraps.map((w, i) => {
    const id = typeof w === 'string' ? w : (w && typeof w === 'object' ? w.deviceId : undefined);
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`kdf: wraps[${i}].deviceId must be a non-empty string — A4-R2`);
    }
    // The cap is on UTF-8 BYTES, not characters: `pairContext` length-prefixes
    // this id with a u8, so a 200-character id that encodes to 400 bytes is the
    // truncation-to-`len & 0xff` collision A1's u8 ratification exists to kill.
    const n = te.encode(id).length;
    if (n > MAX_PREFIXED_BYTES) {
      throw new Error(`kdf: wraps[${i}].deviceId is ${n} UTF-8 bytes, over the u8 cap of ${MAX_PREFIXED_BYTES} — A4-R2`);
    }
    return id;
  });
  // Duplicate-free is validateE2eBlock's guarantee; re-asserted because it is
  // the precondition that makes "lowest" a total order rather than a coin flip.
  if (new Set(ids).size !== ids.length) {
    throw new Error('kdf: wraps[] contains a duplicate deviceId — the canonical peer would be ambiguous (A4-R2)');
  }
  let lowest = null;
  let lowestBytes = null;
  for (const id of ids) {
    const b = te.encode(id);
    if (lowestBytes === null || compareUtf8(b, lowestBytes) < 0) { lowest = id; lowestBytes = b; }
  }
  return lowest;
}

export function pairContextFromWire(ctxWire, { userId, deviceId, pairingId, recipientDeviceIds } = {}) {
  if (deviceId !== undefined) {
    throw new Error(
      'kdf: `deviceId` is not an input to pairContextFromWire — A4 DELETED the "ctx.peerDeviceId must be my own deviceId" refusal (it makes multi-recipient pairing impossible). Pass `recipientDeviceIds` (the full wraps[].deviceId set) where you hold it; omit it on the PAIR_STATE lane, where the cryptographic wrap-opens check is the binding one (A4-M1)',
    );
  }
  if (ctxWire === undefined || ctxWire === null) {
    throw new Error('kdf: ctx is absent — a mode=1 block without ctx MUST be refused, never derived from a local guess (A3-M4)');
  }
  if (typeof ctxWire !== 'object' || Array.isArray(ctxWire)) {
    throw new Error('kdf: ctx must be an object');
  }
  for (const f of ['pairingId', 'phoneDeviceId', 'peerDeviceId']) {
    if (typeof ctxWire[f] !== 'string' || ctxWire[f].length === 0) {
      throw new Error(`kdf: ctx.${f} must be a non-empty string`);
    }
  }
  const epoch = ctxWire.pairEpoch;
  if (typeof epoch !== 'string' || !PAIR_EPOCH_WIRE_RE.test(epoch)) {
    throw new Error(
      `kdf: ctx.pairEpoch must be a decimal STRING matching ${PAIR_EPOCH_WIRE_RE} — got ${typeof epoch} ${JSON.stringify(epoch)}. A JSON number would round above 2^53 and derive a different key`,
    );
  }
  const pairEpoch = BigInt(epoch);
  if (pairEpoch > MAX_UINT64) throw new Error(`kdf: ctx.pairEpoch exceeds 2^64-1: ${epoch}`);

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('kdf: the LOCAL session userId is required — it is never taken from the wire (A3)');
  }
  // A3-M3(a), re-scoped by A4. Fail closed, no plaintext fallback. Checked only
  // when the caller independently knows the value, which is the addendum's own
  // wording — and the reason the caller, not this function, supplies it.
  if (pairingId !== undefined && pairingId !== null && ctxWire.pairingId !== pairingId) {
    throw new Error('kdf: ctx.pairingId is not the pairing this device is party to — refusing the block (A3-M3(a))');
  }
  // A3-M3(c), re-scoped by A4: ONLY where the receiver holds the deviceId set.
  // Absent means "this lane cannot see the set" (PAIR_STATE), and the correct
  // behaviour there is NO peer check — never a fallback to the caller's own id.
  if (recipientDeviceIds !== undefined && recipientDeviceIds !== null) {
    const canonical = canonicalPeerDeviceId(recipientDeviceIds);
    if (ctxWire.peerDeviceId !== canonical) {
      throw new Error(
        `kdf: ctx.peerDeviceId "${ctxWire.peerDeviceId}" is not the canonical (byte-wise lowest) recipient "${canonical}" — refusing the block (A3-M3(c) / A4-R2)`,
      );
    }
  }

  return {
    // The same encoder as the local path, so the two CANNOT drift: vector I.1's
    // whole assertion is that wire ctx + local userId reproduces the frozen
    // local context byte for byte.
    contextBytes: pairContext({
      userId,
      phoneDeviceId: ctxWire.phoneDeviceId,
      peerDeviceId: ctxWire.peerDeviceId,
      pairEpoch,
    }),
    pairingId: ctxWire.pairingId,
    phoneDeviceId: ctxWire.phoneDeviceId,
    peerDeviceId: ctxWire.peerDeviceId,
    /** BigInt, for the A3-M2 floor comparison the CALLER owns. */
    pairEpoch,
  };
}

/** "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i — the exact KEK info bytes. */
export function kekInfo(context, recipientKey) {
  const ctx = context instanceof Uint8Array ? context : pairContext(context);
  const k = recipientKey instanceof Uint8Array ? recipientKey : fromHex(recipientKey);
  if (k.length !== SEC1_P256_BYTES) {
    throw new Error(`kdf: recipient key must be ${SEC1_P256_BYTES}-byte uncompressed SEC1, got ${k.length}`);
  }
  if (k[0] !== 0x04) throw new Error(`kdf: recipient key must be 0x04-prefixed, got 0x${k[0].toString(16)}`);
  return concatBytes([te.encode(LABEL_KEK), ctx, u8(TAG_RECIPIENT_KEY), u8(k.length), k]);
}

/** "cc-e2e-v1/p2c" ‖ pairContext (or /c2p). */
export function trafficInfo(context, direction) {
  const ctx = context instanceof Uint8Array ? context : pairContext(context);
  return concatBytes([te.encode(labelFor(direction)), ctx]);
}

function labelFor(direction) {
  if (direction === DIR_P2C) return LABEL_P2C;
  if (direction === DIR_C2P) return LABEL_C2P;
  throw new Error(`kdf: direction must be DIR_P2C (0x01) or DIR_C2P (0x02), got ${direction}`);
}

// ── HKDF ────────────────────────────────────────────────────────────────────

function requireSubtle(subtle) {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s) throw new Error('kdf: no WebCrypto SubtleCrypto in this context');
  return s;
}

/**
 * HKDF-SHA-256 → 32 raw bytes. `ikm` is an ECDH shared secret or a session key;
 * an all-zero secret is refused here as well as at the ECDH endpoint (§2.1), on
 * the principle that the check belongs on every path the bytes can arrive by.
 */
export async function hkdf32({ salt, ikm, info }, subtle = undefined) {
  return hkdfBytes({ salt, ikm, info, length: KEY_BYTES }, subtle);
}

/**
 * HKDF-SHA-256 → `length` raw bytes. Split out from hkdf32 for A2's 4-byte
 * nonce prefixes, which are a length and not a truncation: HKDF-Expand emits
 * T(1) first, so `L = 4` and "expand 32, keep 4" are the same bytes — but the
 * implementation SHOULD request 4 so the intent is never mistaken for a
 * truncated key. All the refusals below apply identically at either length.
 */
export async function hkdfBytes({ salt, ikm, info, length = KEY_BYTES }, subtle = undefined) {
  const s = requireSubtle(subtle);
  if (!Number.isInteger(length) || length <= 0) throw new Error(`kdf: length must be a positive integer, got ${length}`);
  const ikmBytes = ikm instanceof Uint8Array ? ikm : fromHex(ikm);
  if (ikmBytes.length === 0) throw new Error('kdf: ikm may not be empty');
  if (ikmBytes.every((b) => b === 0)) {
    throw new Error('kdf: refusing an all-zero shared secret (invalid-curve / small-order point)');
  }
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new Error('kdf: pairingId must be a non-empty string (it is the HKDF salt)');
  }
  const key = await s.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await s.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(salt), info },
    key,
    length * 8,
  ));
}

/**
 * "cc-e2e-v1/np2c" ‖ pairContext (or /nc2p) — the exact nonce-prefix info bytes.
 * Pinned by vector E separately from the prefixes themselves so a mismatch is
 * readable at the byte that differs rather than only as "the prefix is wrong".
 */
export function noncePrefixInfo(context, direction) {
  const ctx = context instanceof Uint8Array ? context : pairContext(context);
  if (direction !== DIR_P2C && direction !== DIR_C2P) {
    throw new Error(`kdf: direction must be DIR_P2C (0x01) or DIR_C2P (0x02), got ${direction}`);
  }
  return concatBytes([te.encode(direction === DIR_P2C ? LABEL_NP2C : LABEL_NC2P), ctx]);
}

/**
 * The two 4-byte nonce prefixes, DERIVED (A2, RATIFIED).
 *
 * A1 said the prefix was "random per (kid, direction)", which the frozen frame
 * has no field to carry — undecryptable as written. A2 replaces that word with
 * the standard construction: derive it, exactly as TLS 1.3 derives its record
 * IV from the traffic secret and never transmits it (RFC 8446 §5.3). A nonce
 * prefix has no confidentiality or unpredictability requirement at all; GCM's
 * requirement is uniqueness under a key, and that is the counter's job.
 *
 * TWO RULES, BOTH A2 MUSTs:
 *
 * 1. THE PREFIX CONTRIBUTES ZERO NONCE-UNIQUENESS. A1 justified it as "defence
 *    in depth against a state-restore bug"; A2 WITHDRAWS that rationale, and on
 *    inspection it was never sound — under A2 the prefix is a deterministic
 *    function of SK and pairEpoch, so within one epoch a restore reproduces it
 *    exactly. `createSender`'s persist-before-emit / fail-closed counter is now
 *    the SOLE control against nonce reuse. Anyone reasoning "the prefix varies,
 *    so a counter collision is survivable" has reintroduced the bug, and in GCM
 *    a repeated nonce is total loss of confidentiality AND forgery.
 *
 * 2. NEVER PERSIST IT, NEVER CARRY IT ACROSS A SESSION. Re-derive on every
 *    session construction — which is why this is a function of SK and context
 *    and returns bytes, rather than something a caller is tempted to store. A
 *    persisted prefix is stale state that can survive a restore, and that is
 *    the only way this design drifts back into the bug it just removed.
 *
 * A2 MUST#1 lives outside this module and must not be forgotten: `kid` <-> `SK`
 * is strictly 1:1. pairContext does not bind `kid`, so these prefixes and keys
 * are scoped to (pairing, pairEpoch, direction) while the counter is scoped to
 * (kid, direction). Those coincide ONLY while one kid names exactly one SK. A
 * second kid under the same SK restarts a counter at 0 against the same key and
 * the same prefix. Enforce it where kid is MINTED, not by convention.
 */
export async function deriveNoncePrefixes({ pairingId, sessionKey, context }, subtle = undefined) {
  const s = requireSubtle(subtle);
  const ctx = context instanceof Uint8Array ? context : pairContext(context);
  const [np2c, nc2p] = await Promise.all([
    hkdfBytes({ salt: pairingId, ikm: sessionKey, info: noncePrefixInfo(ctx, DIR_P2C), length: SESSION_PREFIX_BYTES }, s),
    hkdfBytes({ salt: pairingId, ikm: sessionKey, info: noncePrefixInfo(ctx, DIR_C2P), length: SESSION_PREFIX_BYTES }, s),
  ]);
  return { np2c, nc2p };
}

/**
 * KEK_i — the key that wraps the session key for ONE recipient.
 *
 * `sharedSecret` is ECDH(epk_priv, K_i), computed by the caller so this module
 * never holds a private key. The info binds K_i but deliberately NOT epk: the
 * ECDH ikm already binds epk cryptographically, and pairEpoch (inside the
 * context) bumps on every Accept, so a wrap cannot be replayed into another
 * epoch. Binding K_i is the load-bearing part — it is what stops a wrap minted
 * for the web page from opening in the service worker. Recorded here so a later
 * reader does not "fix" the absence of epk.
 */
export async function kek({ pairingId, sharedSecret, context, recipientKey }, subtle = undefined) {
  return hkdf32({ salt: pairingId, ikm: sharedSecret, info: kekInfo(context, recipientKey) }, subtle);
}

/**
 * The two traffic keys, handed out as a SEND key and a RECEIVE key for one role.
 *
 * `role` is 'phone' or 'computer'. There is no `keyForDirection()` by design
 * (A1 (2), mandatory consequence): a helper that can be called with the wrong
 * direction is a helper that eventually is. The caller gets `send` and `recv`
 * and cannot name the other side's pair.
 *
 * `rawBytes` is exposed alongside each CryptoKey only so tests/kdf-vectors.json
 * can pin the schedule; production callers should use `.key`.
 */
export async function trafficKeys({ pairingId, sessionKey, context, role }, subtle = undefined) {
  const s = requireSubtle(subtle);
  if (role !== 'phone' && role !== 'computer') {
    throw new Error(`kdf: role must be 'phone' or 'computer', got ${JSON.stringify(role)}`);
  }
  const ctx = context instanceof Uint8Array ? context : pairContext(context);
  const p2c = await hkdf32({ salt: pairingId, ikm: sessionKey, info: trafficInfo(ctx, DIR_P2C) }, s);
  const c2p = await hkdf32({ salt: pairingId, ikm: sessionKey, info: trafficInfo(ctx, DIR_C2P) }, s);

  // A2: the prefixes are DERIVED here, in the same call that derives the keys,
  // and handed out attached to their own direction. That is the structural
  // expression of A2 MUST#2 — a caller that gets its prefix from the session
  // construction has nothing to persist and nothing stale to restore.
  const { np2c, nc2p } = await deriveNoncePrefixes({ pairingId, sessionKey, context: ctx }, s);

  const sendRaw = role === 'phone' ? p2c : c2p;
  const recvRaw = role === 'phone' ? c2p : p2c;
  const sendDirection = role === 'phone' ? DIR_P2C : DIR_C2P;
  const recvDirection = role === 'phone' ? DIR_C2P : DIR_P2C;

  return {
    role,
    send: {
      direction: sendDirection,
      rawBytes: sendRaw,
      sessionPrefix: sendDirection === DIR_P2C ? np2c : nc2p,
      key: await s.importKey('raw', sendRaw, { name: 'AES-GCM' }, false, ['encrypt']),
    },
    recv: {
      direction: recvDirection,
      rawBytes: recvRaw,
      sessionPrefix: recvDirection === DIR_P2C ? np2c : nc2p,
      key: await s.importKey('raw', recvRaw, { name: 'AES-GCM' }, false, ['decrypt']),
    },
  };
}

// ── (3) AEAD ────────────────────────────────────────────────────────────────

/**
 * nonce = sessionPrefix(4 B) ‖ be64(seq).
 *
 * The prefix is DERIVED by deriveNoncePrefixes() (A2) and contributes ZERO
 * uniqueness; uniqueness comes from `seq` alone. See rule 2 in the header.
 */
export function nonce(sessionPrefix, seq) {
  const prefix = sessionPrefix instanceof Uint8Array ? sessionPrefix : fromHex(sessionPrefix);
  if (prefix.length !== SESSION_PREFIX_BYTES) {
    throw new Error(`kdf: sessionPrefix must be ${SESSION_PREFIX_BYTES} bytes, got ${prefix.length}`);
  }
  return concatBytes([prefix, be64(seq)]);
}

/**
 * The associated data — canonically RE-ENCODED from the five bound fields.
 * NEVER the JSON header bytes: see rule 1 in the header.
 */
export function aad({ frameType, kid, seq, direction, pairEpoch }) {
  if (direction !== DIR_P2C && direction !== DIR_C2P) {
    throw new Error(`kdf: direction must be 0x01 (p2c) or 0x02 (c2p), got ${direction}`);
  }
  return concatBytes([
    ...tagged(TAG_AAD_FRAME_TYPE, frameType, 'frameType'),
    ...tagged(TAG_AAD_KID, kid, 'kid'),
    u8(TAG_AAD_SEQ), be64(seq),
    u8(TAG_AAD_DIRECTION), u8(direction),
    u8(TAG_AAD_PAIR_EPOCH), be64(pairEpoch),
  ]);
}

/**
 * Seal one frame. PADS FIRST, then encrypts (§13.4): sealing first would put
 * the real plaintext length in the clear, which is the whole point of padding.
 *
 * `sender` is the `.send` half of trafficKeys() plus the per-(kid,direction)
 * `sessionPrefix`. The direction in the AAD comes from the sender, not from an
 * argument, so a caller cannot label a frame with the direction it is not.
 */
export async function seal({ sender, frameType, kid, seq, pairEpoch, plaintext }, subtle = undefined) {
  const s = requireSubtle(subtle);
  const padded = padPlaintext(frameType, plaintext instanceof Uint8Array ? plaintext : te.encode(String(plaintext)));
  const key = sender.key ?? await s.importKey('raw', sender.rawBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = await s.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce(sender.sessionPrefix, seq),
      additionalData: aad({ frameType, kid, seq, direction: sender.direction, pairEpoch }),
      tagLength: TAG_BITS,
    },
    key,
    padded,
  );
  return new Uint8Array(ct);
}

/**
 * Open one frame. Returns the unpadded plaintext, or THROWS on a tag failure —
 * §13.5's "return null, never throw" is the envelope layer's contract, and it
 * is the envelope's job to translate this into a drop. Swallowing the failure
 * here would make a forged frame indistinguishable from a decode bug.
 */
export async function open({ receiver, frameType, kid, seq, pairEpoch, ciphertext }, subtle = undefined) {
  const s = requireSubtle(subtle);
  const key = receiver.key ?? await s.importKey('raw', receiver.rawBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const padded = new Uint8Array(await s.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce(receiver.sessionPrefix, seq),
      additionalData: aad({ frameType, kid, seq, direction: receiver.direction, pairEpoch }),
      tagLength: TAG_BITS,
    },
    key,
    ciphertext instanceof Uint8Array ? ciphertext : fromHex(ciphertext),
  ));
  return unpadPlaintext(frameType, padded);
}

/**
 * A send-side counter that CANNOT be used without persist-before-emit (A1 (3)).
 *
 * `commitSeq(next)` must durably store `next` and resolve only once it is
 * durable; nextSeq() awaits it before returning, so a frame can never leave the
 * device on a sequence number that was not first written down. If the store
 * cannot prove where the counter got to — restore from backup, cleared storage,
 * corrupt state — the caller passes no `resumeFrom` and gets a THROW rather
 * than a guess: fail closed, force a rekey, never restart at 0.
 *
 * This is the single most likely way the design gets broken in the field, so it
 * is expressed as a constructor precondition rather than a comment.
 */
export function createSender({ trafficKey, sessionPrefix, resumeFrom, commitSeq }) {
  if (!trafficKey || typeof trafficKey.direction !== 'number') {
    throw new Error('kdf: createSender needs the .send half of trafficKeys()');
  }
  const prefix = sessionPrefix instanceof Uint8Array ? sessionPrefix : fromHex(sessionPrefix);
  if (prefix.length !== SESSION_PREFIX_BYTES) {
    throw new Error(`kdf: sessionPrefix must be ${SESSION_PREFIX_BYTES} bytes, got ${prefix.length}`);
  }
  if (typeof commitSeq !== 'function') {
    throw new Error('kdf: createSender requires commitSeq(next) — the counter must be durable BEFORE the frame is emitted');
  }
  if (resumeFrom === undefined || resumeFrom === null) {
    throw new Error(
      'kdf: createSender refuses to start without a proven counter floor. A device that cannot prove its counter exceeds every value it has used must force a rekey, not resume at a guess (A1 rule 3, FAIL CLOSED)',
    );
  }
  let next = typeof resumeFrom === 'bigint' ? resumeFrom : BigInt(resumeFrom);
  if (next < 0n) throw new Error(`kdf: resumeFrom must be a non-negative counter floor, got ${resumeFrom}`);

  return {
    direction: trafficKey.direction,
    sessionPrefix: prefix,
    key: trafficKey.key,
    rawBytes: trafficKey.rawBytes,
    /** Durably commit, THEN hand out. The order is the rule. */
    async nextSeq() {
      const seq = next;
      await commitSeq(seq + 1n);
      next = seq + 1n;
      return seq;
    },
  };
}
