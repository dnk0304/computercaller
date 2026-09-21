/**
 * lib/e2e/webKey.ts — the WEB surface's static device key (E2E-P2 (a)).
 *
 * One P-256 ECDH keypair per browser profile. It is the key the phone wraps the
 * session key to (§13.10 `K_i`), so three properties are load-bearing and each
 * one is enforced here rather than left to a convention:
 *
 *  1. THE PRIVATE KEY IS NON-EXTRACTABLE. `generateKey(..., false, ...)` and a
 *     `CryptoKey` handed to IndexedDB by structured clone — never a JWK, never
 *     raw bytes, never a string that could reach a log, a bug report, or
 *     `JSON.stringify` of application state. `assertNonExtractable()` proves it
 *     by trying the export and requiring the rejection.
 *
 *  2. THE RECORD IS VERSIONED AND THE GUARD FAILS LOUDLY. A record written by a
 *     future build MUST NOT be silently replaced with a fresh key: regenerating
 *     is indistinguishable, from the phone's side, from an attacker swapping the
 *     recipient key — and it would do it quietly, on the one path nobody tests.
 *     An unknown `v` throws `WebKeyRecordVersionError`, which the hook surfaces
 *     as `error:'re-pair-needed'` (deliverable (g)).
 *
 *  3. THE PUBLIC KEY HAS EXACTLY ONE ENCODING. Uncompressed SEC1, 65 bytes,
 *     `0x04`-prefixed, base64url — GATE1 R1 / spec §2.1, the same pin the relay
 *     applies in `lib/e2eBlock-core.js`. That module is CommonJS and uses
 *     `Buffer`, so it cannot be imported here; the pin is re-stated rather than
 *     shared, and `tests/e2e-web-webkey.test.mjs` asserts the two agree on the
 *     constants so the restatement cannot drift unnoticed.
 *
 * ROTATION is explicit only. `ensureWebDeviceKey()` is idempotent and never
 * regenerates; `resetWebDeviceKey()` is the single door, and it is the caller's
 * job (a user action) to open it. Register-on-first-use is best effort: a failed
 * POST leaves the local key intact and is retried on the next `ensure`, because
 * a device that cannot reach the API is a device that should still be able to
 * pair in plaintext.
 *
 * The IndexedDB and `fetch` edges are injectable (`WebKeyStore`, `registerFn`)
 * so `node tests/*.test.mjs` exercises the real WebCrypto against an in-memory
 * store. Type-stripped by node 24 on import; no build step (R-A).
 */

import {
  CC_E2E_DB_NAME,
  CC_E2E_DB_VERSION,
  CC_E2E_STORE_DEVICE_KEY,
  ccE2eRead,
  ccE2eWrite,
} from './idb.mjs';

/**
 * Record format version. Bump ONLY with a migration; readers must fail loudly.
 *
 * v2 (E2E-P2 follow-up, GATE1 Addendum A3-M2) adds `epochFloors`. The bump is
 * deliberate and it is NOT cosmetic: a v1 record is a record written by a build
 * that had no floor, so a browser that silently kept using it would accept any
 * `ctx.pairEpoch` once — which is exactly the replay A3-M2 exists to refuse.
 * `hydrateRecord` therefore rejects v1 as an unknown version and the user
 * re-pairs, per CHECKPOINT protocol rule 6 (a resumer must never "work on my
 * machine" against an old record). There is no upgrade path from v1 on purpose:
 * migrating would mean inventing a floor, and the only honest floor for a
 * record that never had one is "none yet, and no key either".
 *
 * v3 (E2E-P2.6, A6-P61D-RESUME-TEARDOWN) adds `epochFloorKids`: the accept
 * block's `kid` at the moment each floor was admitted. It is what lets the
 * equal-epoch case be split (see {@link admitPairEpoch}) instead of being
 * refused wholesale, which is what killed a pair on a bare page reload.
 *
 * v2 IS READ, unlike v1, and this is not the same decision. v1 was rejected
 * because it had no floor at all, so keeping it would have thrown the control
 * away. A v2 record HAS every floor; it is only missing the kids. Carrying it
 * forward invents nothing: the kid map starts empty, every v2-era floor is
 * therefore "kid unknown", and a kid-unknown floor REFUSES the equal-epoch case
 * exactly as v2 did (P2.6 rule 4 — no migration, no guessed kid). The next
 * genuine re-pair writes a real kid and the pair gets the new behaviour. The
 * record is re-stamped `v: 3` on the next store write, so an OLDER build that
 * later reads it gets `WebKeyRecordVersionError` — the same loud mechanism,
 * not a second one.
 */
import { rememberWebDeviceKeyId } from './webKeyId.ts';

export const WEB_KEY_RECORD_VERSION = 3;

/**
 * Versions this build can READ. Everything outside it — a v1 record, or one
 * from a future build — is `WebKeyRecordVersionError`. Writes are always at
 * {@link WEB_KEY_RECORD_VERSION}.
 */
export const SUPPORTED_WEB_KEY_RECORD_VERSIONS: readonly number[] = Object.freeze([2, 3]);

/** A `kid` is 1..128 chars — the same pin lib/e2eBlock-core.js applies to a block. */
export const EPOCH_FLOOR_KID_MAX = 128;

/** Uncompressed SEC1 P-256 point: 0x04 ‖ X(32) ‖ Y(32). */
export const SEC1_P256_BYTES = 65;
export const SEC1_P256_PREFIX = 0x04;
/** base64url of 65 bytes is exactly 87 unpadded characters. */
export const SEC1_P256_B64URL_LENGTH = 87;

/** Device id entropy. 128 bits, hex — stable for the life of the record. */
export const DEVICE_ID_BYTES = 16;

/**
 * The decimal-string form a floor is stored in. Identical to kdf.mjs's
 * PAIR_EPOCH_WIRE_RE on purpose: the value that goes into the floor is the same
 * value that came off the wire, and two regexes that are meant to agree but are
 * written twice are two regexes that will eventually disagree. This module
 * cannot import kdf.mjs (it is the .ts half and kdf.mjs is the frozen P0.2
 * artifact), so the constant is restated here and
 * tests/e2e-web-webkey.test.mjs asserts the two are the SAME SOURCE STRING.
 */
export const PAIR_EPOCH_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
/**
 * 2^64-1. Written as a BigInt() CALL, not the `0xffff…n` literal kdf.mjs uses:
 * this file is typechecked against the project's ES2017 target, where a BigInt
 * literal is TS2737. Changing the shared target to satisfy one constant would
 * move every other file on a branch three lanes are editing.
 */
export const MAX_UINT64 = BigInt('18446744073709551615');

/**
 * Re-exported from lib/e2e/idb.mjs, which OWNS the `cc-e2e` database. The names
 * are kept because callers and tests use them, but they are no longer a second
 * declaration of the truth: this file used to declare version 1 while
 * session.mjs declared its own version 1 with a DIFFERENT schema, and whichever
 * opened first settled the database for the other. See the idb.mjs header.
 */
export const WEB_KEY_DB_NAME = CC_E2E_DB_NAME;
export const WEB_KEY_DB_VERSION = CC_E2E_DB_VERSION;
export const WEB_KEY_STORE_NAME = CC_E2E_STORE_DEVICE_KEY;
/** Single-row store: there is one web device key per browser profile. */
export const WEB_KEY_RECORD_ID = 'self';

export type WebKeyKind = 'web';

/** What actually lives in IndexedDB. `privateKey` is a non-extractable CryptoKey. */
export interface WebDeviceKeyRecord {
  v: number;
  deviceId: string;
  kind: WebKeyKind;
  createdAt: number;
  /** The 65-byte uncompressed SEC1 point. Raw bytes, not a string. */
  pub: Uint8Array;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /**
   * A3-M2. The monotonic epoch floor per `(userId, phoneDeviceId)`, keyed by
   * {@link epochFloorKey}, VALUE AS A DECIMAL STRING.
   *
   * The string is not a style choice. `pairEpoch` is a uint64 and A1 forbids it
   * rounding above 2^53; IndexedDB's structured clone would happily round-trip
   * a `number`, so storing one would reintroduce on the READ side the exact
   * precision loss A3 spent a paragraph forbidding on the wire side. BigInt is
   * structured-cloneable too, but a decimal string survives a JSON export, a
   * devtools edit and a future storage swap identically, and it is the same
   * spelling the wire uses.
   *
   * NOTE what is deliberately NOT in this record: the nonce prefix. A2 MUST #2
   * — the prefix is re-derived from SK + pairContext on every session
   * construction and MUST NEVER be persisted, because a persisted prefix is
   * stale state that can survive a restore. `tests/e2e-web-webkey.test.mjs`
   * asserts the stored record has no prefix-shaped field at all.
   */
  epochFloors: Record<string, string>;
  /**
   * A6-P61D / P2.6. The accept block's `kid` that was in force when the
   * matching {@link epochFloors} entry was written, under the SAME key.
   *
   * A SEPARATE map rather than a richer floor value on purpose: a v2 record's
   * floors then keep their exact stored spelling (a decimal string) and are
   * read by the unchanged, well-tested `hydrateEpochFloors`, while the kid is
   * simply absent — which is the honest statement "this floor was written by a
   * build that did not record one" and the state that refuses an equal epoch.
   *
   * ABSENCE IS THE SAFE VALUE IN BOTH DIRECTIONS. A floor with no kid refuses
   * the equal-epoch case; a kid with no floor is not reachable (the floor is
   * always written first, in the same record) and would be ignored.
   */
  epochFloorKids: Record<string, string>;
}

/**
 * Raised when a `ctx.pairEpoch` is at or below the stored floor (A3-M2).
 *
 * This is a REFUSAL, not a warning, and there is no plaintext fallback: the
 * failure it guards is a relay replaying a superseded `ACCEPT_PAIRING`, which
 * re-installs an old `SK` under its old epoch. A2's per-`(kid,direction)`
 * counter then restarts at 0 against a key AND a prefix that have already
 * sealed frames — GCM nonce reuse, the one failure in this protocol whose cost
 * is total. The SAS would also mismatch, but §13 makes the SAS explicitly
 * non-blocking, so it cannot be the control here.
 */
export type EpochFloorRefusal =
  /** `pairEpoch < floor` — a strictly superseded epoch. */
  | 'below-floor'
  /** `pairEpoch === floor` and the block's kid is NOT the one admitted at that floor. */
  | 'kid-mismatch'
  /** `pairEpoch === floor` and the floor predates P2.6, so no kid was recorded. */
  | 'kid-unknown'
  /**
   * `pairEpoch === floor`, the kid matches, but the kid has NO seq history left
   * to continue (Security MUST #1). The floor and the counters live in two
   * object stores and can be lost independently; a resume onto a counter that
   * is gone is a counter restarting at 0 under a key the phone has sealed with.
   */
  | 'seq-state-missing';

const EPOCH_FLOOR_WHY =
  'accepting it would restart a seq counter at 0 against a key that has already sealed frames.';

export class EpochFloorError extends Error {
  readonly code = 'e2e-epoch-replayed';
  /** The hook state this maps to — abandon the pair and force a rekey. */
  readonly state = 're-pair-needed';
  readonly floor: bigint;
  readonly offered: bigint;
  /** WHICH of the three refusing cells fired. Diagnostic; the code is unchanged. */
  readonly reason: EpochFloorRefusal;
  constructor(floor: bigint, offered: bigint, scope: string, reason: EpochFloorRefusal) {
    super(
      reason === 'below-floor'
        ? `E2E pairEpoch ${offered} is below the stored floor ${floor} for ${scope}: ` +
            `refusing the pairing (A3-M2 epoch monotonicity). This is what a replayed ` +
            `ACCEPT_PAIRING looks like; ${EPOCH_FLOOR_WHY}`
        : reason === 'kid-mismatch'
          ? `E2E pairEpoch ${offered} equals the stored floor ${floor} for ${scope} but the ` +
            `block's kid is NOT the one admitted at that floor: refusing the pairing ` +
            `(A3-M2). A resume of the same pair carries the same kid; a different kid at ` +
            `the same epoch is a replay or a re-key that failed to bump, and ${EPOCH_FLOOR_WHY}`
          : reason === 'kid-unknown'
            ? `E2E pairEpoch ${offered} equals the stored floor ${floor} for ${scope}, which was ` +
              `written before kids were recorded, so the resume cannot be told from a replay: ` +
              `refusing the pairing (A3-M2). Pair again from your phone to record one; ${EPOCH_FLOOR_WHY}`
            : `E2E pairEpoch ${offered} equals the stored floor ${floor} for ${scope} under the ` +
              `expected kid, but that kid has no seq history left to continue: refusing the ` +
              `pairing (A3-M2 + A2). The counter store was cleared or restored while the floor ` +
              `survived, so resuming would start a counter the phone believes has already run, and ` +
              `${EPOCH_FLOOR_WHY}`,
    );
    this.name = 'EpochFloorError';
    this.floor = floor;
    this.offered = offered;
    this.reason = reason;
  }
}

/**
 * The floor's key. NUL-joined rather than `:`-joined because both halves are
 * caller-supplied strings and `:` is legal in a userId — `a:b` + `c` and `a` +
 * `b:c` would collide, and a collision here merges two phones' floors, which
 * either blocks a legitimate pair or admits a replayed one. NUL cannot appear
 * in either field (both are length-prefixed UTF-8 ids under A1's encoder, and
 * the relay charset is `[A-Za-z0-9_-]`).
 */
export function epochFloorKey(userId: string, phoneDeviceId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new WebKeyRecordShapeError('epoch floor: userId must be a non-empty string');
  }
  if (typeof phoneDeviceId !== 'string' || phoneDeviceId.length === 0) {
    throw new WebKeyRecordShapeError('epoch floor: phoneDeviceId must be a non-empty string');
  }
  return `${userId} ${phoneDeviceId}`;
}

/** The record as the rest of the client uses it, with the wire encoding attached. */
export interface WebDeviceKey extends WebDeviceKeyRecord {
  /** base64url of `pub` — the form that goes on the wire and into the API. */
  pubB64Url: string;
}

/**
 * An IndexedDB record written by a version of the app this build does not
 * understand. NEVER recover by regenerating: see property 2 in the header.
 */
export class WebKeyRecordVersionError extends Error {
  readonly code = 'e2e-record-version';
  /** The hook state this maps to (deliverable (g)). */
  readonly state = 're-pair-needed';
  readonly found: unknown;
  constructor(found: unknown) {
    super(
      `E2E device-key record version ${String(found)} is not supported by this build ` +
        `(expected ${WEB_KEY_RECORD_VERSION}). Re-pair needed.`,
    );
    this.name = 'WebKeyRecordVersionError';
    this.found = found;
  }
}

/** A stored record that is structurally wrong — also never silently replaced. */
export class WebKeyRecordShapeError extends Error {
  readonly code = 'e2e-record-shape';
  readonly state = 're-pair-needed';
  constructor(what: string) {
    super(`E2E device-key record is malformed: ${what}. Re-pair needed.`);
    this.name = 'WebKeyRecordShapeError';
  }
}

// ---------------------------------------------------------------------------
// encoding — the ONE pinned form
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  // btoa exists in every browser and in node >= 16; no Buffer, so the SW can
  // import this module unchanged (P3 consumes the same encoding).
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  if (typeof value !== 'string' || !B64URL_ALPHABET.test(value)) {
    throw new Error('not base64url');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The relay's pin, restated for the browser (lib/e2eBlock-core.js is CJS+Buffer).
 * Charset and length are checked BEFORE decoding for the same reason they are
 * there: base64 decoders are lenient and skip characters outside the alphabet,
 * so decoding first makes the length check satisfiable by strings that are not
 * base64url at all.
 */
export function isPinnedPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== SEC1_P256_B64URL_LENGTH) return false;
  if (!B64URL_ALPHABET.test(value)) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    return false;
  }
  return bytes.length === SEC1_P256_BYTES && bytes[0] === SEC1_P256_PREFIX;
}

/** Reject anything that is not the pinned shape AT IMPORT — never infer (A1). */
export function assertSec1P256(bytes: Uint8Array, what = 'public key'): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${what} must be bytes`);
  if (bytes.length !== SEC1_P256_BYTES) {
    throw new Error(`${what} must be ${SEC1_P256_BYTES} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== SEC1_P256_PREFIX) {
    throw new Error(`${what} must be 0x04-prefixed (uncompressed SEC1)`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// key generation
// ---------------------------------------------------------------------------

function subtleOf(cryptoLike: Crypto | undefined): SubtleCrypto {
  const c = cryptoLike ?? (globalThis.crypto as Crypto | undefined);
  if (!c || !c.subtle) {
    throw new Error('WebCrypto SubtleCrypto is unavailable (needs a secure context)');
  }
  return c.subtle;
}

function randomHex(cryptoLike: Crypto | undefined, nBytes: number): string {
  const c = cryptoLike ?? (globalThis.crypto as Crypto | undefined);
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable');
  }
  const bytes = new Uint8Array(nBytes);
  c.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Generate the keypair. `extractable = false` on the PRIVATE key is the whole
 * point of this function; the public key is generated extractable because it has
 * to be exported to `raw` to reach the wire.
 */
export async function generateWebDeviceKey(
  opts: { crypto?: Crypto; deviceId?: string; now?: number } = {},
): Promise<WebDeviceKey> {
  const subtle = subtleOf(opts.crypto);
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // The `extractable = false` argument governs the PRIVATE half only: the
  // WebCrypto generateKey steps set the public key's [[extractable]] slot to
  // true unconditionally, so the public point can still be exported to `raw`
  // and reach the wire. Both halves of that sentence are asserted in
  // tests/e2e-web-webkey.test.mjs, because the whole security property of this
  // module rests on the flag applying where it is claimed to apply.
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  assertSec1P256(raw, 'generated public key');
  const publicKey = pair.publicKey;
  return {
    v: WEB_KEY_RECORD_VERSION,
    deviceId: opts.deviceId ?? randomHex(opts.crypto, DEVICE_ID_BYTES),
    kind: 'web',
    createdAt: opts.now ?? Date.now(),
    pub: raw,
    privateKey: pair.privateKey,
    publicKey,
    // A fresh browser has seen no phone, so it has no floor. TOFU: the first
    // epoch that arrives for a (userId, phoneDeviceId) is accepted with no
    // comparison and BECOMES the floor (A3-M2, consistent with §13 device
    // pinning). An empty map is the honest starting state; a map seeded with
    // zeroes would refuse a legitimate first pair at epoch 0.
    epochFloors: {},
    // No floors means no kids. Same TOFU argument.
    epochFloorKids: {},
    pubB64Url: toBase64Url(raw),
  };
}

/**
 * Prove the private key cannot leave. Resolves on the REJECTION; a successful
 * export is a hard failure, not a warning — an extractable ECDH private key in
 * IndexedDB is the entire threat model of this phase undone.
 */
export async function assertNonExtractable(
  key: CryptoKey,
  cryptoLike?: Crypto,
): Promise<void> {
  if (key.extractable) {
    throw new Error('device private key is marked extractable');
  }
  const subtle = subtleOf(cryptoLike);
  let exported = false;
  try {
    await subtle.exportKey('pkcs8', key);
    exported = true;
  } catch {
    // expected
  }
  if (exported) throw new Error('device private key exported despite extractable=false');
}

// ---------------------------------------------------------------------------
// the record: validation + storage
// ---------------------------------------------------------------------------

/**
 * Turn a stored value into a usable key, or THROW. Version is checked first and
 * separately from shape: "written by a newer build" and "corrupt" want different
 * words in the log even though both land on `re-pair-needed`.
 */
export function hydrateRecord(raw: unknown): WebDeviceKey {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebKeyRecordShapeError('not an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== 'number' || !SUPPORTED_WEB_KEY_RECORD_VERSIONS.includes(r.v)) {
    throw new WebKeyRecordVersionError(r.v);
  }
  if (typeof r.deviceId !== 'string' || r.deviceId.length === 0 || r.deviceId.length > 128) {
    throw new WebKeyRecordShapeError('deviceId must be a 1..128 char string');
  }
  if (r.kind !== 'web') throw new WebKeyRecordShapeError(`kind must be 'web'`);
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) {
    throw new WebKeyRecordShapeError('createdAt must be a finite number');
  }
  const pub = r.pub instanceof Uint8Array ? r.pub : null;
  if (!pub) throw new WebKeyRecordShapeError('pub must be raw bytes');
  try {
    assertSec1P256(pub, 'stored public key');
  } catch (e) {
    throw new WebKeyRecordShapeError((e as Error).message);
  }
  const privateKey = r.privateKey as CryptoKey | undefined;
  const publicKey = r.publicKey as CryptoKey | undefined;
  if (!privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private') {
    throw new WebKeyRecordShapeError('privateKey must be a private CryptoKey');
  }
  if (privateKey.extractable) {
    // A record whose private key is extractable was not written by this code.
    throw new WebKeyRecordShapeError('privateKey is extractable');
  }
  if (!publicKey || typeof publicKey !== 'object' || publicKey.type !== 'public') {
    throw new WebKeyRecordShapeError('publicKey must be a public CryptoKey');
  }
  return {
    v: WEB_KEY_RECORD_VERSION,
    deviceId: r.deviceId,
    kind: 'web',
    createdAt: r.createdAt,
    pub,
    privateKey,
    publicKey,
    epochFloors: hydrateEpochFloors(r.epochFloors),
    epochFloorKids: hydrateEpochFloorKids(r.epochFloorKids),
    pubB64Url: toBase64Url(pub),
  };
}

/**
 * A malformed floor map is a SHAPE error, never an empty map.
 *
 * This is the one place where "be liberal in what you accept" is exactly wrong.
 * Silently substituting `{}` for an unreadable map is indistinguishable, from
 * the code's point of view, from a browser that has never paired — so every
 * floor would be forgotten and the very next replayed epoch would be accepted
 * under TOFU. The failure this guards against is a bug that DELETES a security
 * control while every test that only checks "does it pair" stays green.
 */
export function hydrateEpochFloors(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) {
    throw new WebKeyRecordShapeError('epochFloors is absent (v2 records always carry the map)');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebKeyRecordShapeError('epochFloors must be a plain object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || !PAIR_EPOCH_DECIMAL.test(v)) {
      throw new WebKeyRecordShapeError(
        `epochFloors[${JSON.stringify(k)}] must be a decimal string matching ${PAIR_EPOCH_DECIMAL} — ` +
          `got ${typeof v} ${JSON.stringify(v)}`,
      );
    }
    if (BigInt(v) > MAX_UINT64) {
      throw new WebKeyRecordShapeError(`epochFloors[${JSON.stringify(k)}] exceeds 2^64-1`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * The kid map. Unlike {@link hydrateEpochFloors}, ABSENT IS LEGAL and means
 * `{}` — that is the whole v2-compatibility story (see the version header): a
 * record written before P2.6 has floors and no kids, and an empty kid map makes
 * every one of those floors refuse the equal-epoch case, which is precisely the
 * v2 behaviour. Substituting `{}` here therefore removes no control.
 *
 * A PRESENT-BUT-MALFORMED map is still a hard shape error, for the same reason
 * `hydrateEpochFloors` refuses one: a build that wrote kids and a reader that
 * quietly discarded them would look identical to a legacy record while actually
 * being a bug, and it would take the resume path away silently.
 */
export function hydrateEpochFloorKids(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebKeyRecordShapeError('epochFloorKids must be a plain object when present');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.length === 0 || v.length > EPOCH_FLOOR_KID_MAX) {
      throw new WebKeyRecordShapeError(
        `epochFloorKids[${JSON.stringify(k)}] must be a 1..${EPOCH_FLOOR_KID_MAX} char string — ` +
          `got ${typeof v} ${JSON.stringify(v)}`,
      );
    }
    out[k] = v;
  }
  return out;
}

/** The persisted projection — `pubB64Url` is derived, so it is NOT stored. */
export function toRecord(key: WebDeviceKey): WebDeviceKeyRecord {
  return {
    v: key.v,
    deviceId: key.deviceId,
    kind: key.kind,
    createdAt: key.createdAt,
    pub: key.pub,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    // Copied, not aliased: the persisted projection must not share a mutable
    // object with the live one, or a later in-memory write would reach storage
    // without going through admitPairEpoch's persist-before-use ordering.
    epochFloors: { ...key.epochFloors },
    // Copied for the same reason, and ALWAYS written: a record that carried
    // kids must never be re-persisted without them, or the next equal-epoch
    // resume would refuse and the reload bug would be back.
    epochFloorKids: { ...key.epochFloorKids },
  };
}

/** The storage edge, so node tests run the real logic against memory. */
export interface WebKeyStore {
  get(): Promise<unknown>;
  put(record: WebDeviceKeyRecord): Promise<void>;
  clear(): Promise<void>;
}

/** An in-memory store. Used by the tests and by any non-browser caller. */
export function memoryWebKeyStore(): WebKeyStore {
  let held: unknown;
  return {
    async get() {
      return held;
    },
    async put(record) {
      held = record;
    },
    async clear() {
      held = undefined;
    },
  };
}

/**
 * The real store. Every open goes through lib/e2e/idb.mjs, so this file no
 * longer knows the database version and cannot disagree with session.mjs about
 * it. Writes resolve on the TRANSACTION's `complete` (idb.mjs's ccE2eWrite),
 * which is stricter than the request-level `success` this used to resolve on —
 * it matters for the A3-M2 epoch floor, whose whole contract is that it is
 * durable BEFORE the epoch it admits is used.
 */
export function indexedDbWebKeyStore(factory?: IDBFactory): WebKeyStore {
  return {
    get: () => ccE2eRead<WebDeviceKeyRecord | undefined>(
      factory, WEB_KEY_STORE_NAME, (s) => s.get(WEB_KEY_RECORD_ID),
    ),
    put: (record) => ccE2eWrite(
      factory, WEB_KEY_STORE_NAME, (s) => { s.put(record, WEB_KEY_RECORD_ID); },
    ),
    clear: () => ccE2eWrite(
      factory, WEB_KEY_STORE_NAME, (s) => { s.delete(WEB_KEY_RECORD_ID); },
    ),
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export interface RegisterResult {
  ok: boolean;
  /** 409 = a pairing handshake is mid-flight (N-1). Not an error; retry later. */
  inFlight?: boolean;
  status?: number;
  rotated?: boolean;
  error?: string;
  /**
   * P2.3 (c). The DeviceKey ROW id the route echoed back for this key.
   *
   * Kept because `POST /api/devicekeys/revoke` addresses a row by id and, until
   * P2.3, the web client threw this away — so the one thing the revoke endpoint
   * needs was the one thing the browser never held. It is also mirrored into
   * lib/e2e/revokeWebKey.ts's module cache at the call site below, which is
   * what makes a sign-out revoke free of an extra round-trip.
   */
  id?: string;
}

export type RegisterFn = (key: WebDeviceKey, label?: string) => Promise<RegisterResult>;

/**
 * POST /api/devicekeys/register. Same-origin with the session cookie — the
 * route's CSRF gate is `requireSameOrigin`, which is satisfied by an ordinary
 * same-origin fetch; there is no token to attach.
 */
export const registerViaApi: RegisterFn = async (key, label) => {
  try {
    const res = await fetch('/api/devicekeys/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: key.deviceId,
        kind: 'web',
        publicKey: key.pubB64Url,
        ...(label ? { label } : {}),
      }),
    });
    if (res.status === 409) return { ok: false, inFlight: true, status: 409 };
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
    const data = (await res.json()) as { rotated?: boolean; key?: { id?: unknown } };
    const id = typeof data?.key?.id === 'string' ? data.key.id : undefined;
    // P2.3 (c): remember OUR row id so sign-out can revoke it. Ignored when the
    // route echoes no id — the revoke client then re-derives it from `list`.
    rememberWebDeviceKeyId(id);
    return { ok: true, status: res.status, rotated: data?.rotated === true, ...(id ? { id } : {}) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

// ---------------------------------------------------------------------------
// the public API
// ---------------------------------------------------------------------------

export interface WebKeyOptions {
  store?: WebKeyStore;
  crypto?: Crypto;
  register?: RegisterFn;
  label?: string;
  now?: number;
}

function storeOf(opts: WebKeyOptions): WebKeyStore {
  return opts.store ?? indexedDbWebKeyStore();
}

/**
 * Read the stored key, or `null` when there is none.
 * THROWS `WebKeyRecordVersionError` / `WebKeyRecordShapeError` — the caller must
 * not treat either as "absent" and generate a replacement.
 */
export async function loadWebDeviceKey(opts: WebKeyOptions = {}): Promise<WebDeviceKey | null> {
  const raw = await storeOf(opts).get();
  if (raw === undefined || raw === null) return null;
  return hydrateRecord(raw);
}

export interface EnsureResult {
  key: WebDeviceKey;
  created: boolean;
  registration: RegisterResult | null;
}

/**
 * Idempotent, and NEVER regenerates: an existing record is returned as-is.
 *
 * Registration is re-attempted on every call rather than tracked with a stored
 * "registered" flag. `registerDeviceKey` is idempotent for an unchanged
 * `publicKey` — it bumps `lastSeen` and returns the same row — so a redundant
 * POST costs one cheap write, while a flag that says "registered" after a
 * server-side wipe costs a pairing that can never be opened. Cheap and
 * self-healing beats bookkeeping that can be wrong.
 */
export async function ensureWebDeviceKey(opts: WebKeyOptions = {}): Promise<EnsureResult> {
  const store = storeOf(opts);
  const existing = await loadWebDeviceKey({ ...opts, store });
  const register = opts.register ?? registerViaApi;
  if (existing) {
    return { key: existing, created: false, registration: await register(existing, opts.label) };
  }
  const key = await generateWebDeviceKey({ crypto: opts.crypto, now: opts.now });
  await assertNonExtractable(key.privateKey, opts.crypto);
  // Persist BEFORE registering: a key the server knows about but the browser has
  // forgotten is a wrap nobody can open. The reverse (stored, unregistered) is
  // recoverable on the next call.
  await store.put(toRecord(key));
  return { key, created: true, registration: await register(key, opts.label) };
}

/**
 * The ONLY door to rotation. Discards the local record and generates a new key,
 * which `registerDeviceKey` turns into a revoke+insert (N-4) server-side.
 */
export async function resetWebDeviceKey(opts: WebKeyOptions = {}): Promise<EnsureResult> {
  const store = storeOf(opts);
  await store.clear();
  return ensureWebDeviceKey({ ...opts, store });
}

// ---------------------------------------------------------------------------
// A3-M2 — the epoch floor
// ---------------------------------------------------------------------------

/** Read the stored floor for a pair, or `null` on first sight (TOFU). */
export function readEpochFloor(
  key: Pick<WebDeviceKey, 'epochFloors'>,
  userId: string,
  phoneDeviceId: string,
): bigint | null {
  const v = key.epochFloors[epochFloorKey(userId, phoneDeviceId)];
  return v === undefined ? null : BigInt(v);
}

/**
 * The kid recorded with the floor, or `null` when there is none — either
 * because the pair is unseen, or because the floor predates P2.6.
 */
export function readEpochFloorKid(
  key: Pick<WebDeviceKey, 'epochFloorKids'>,
  userId: string,
  phoneDeviceId: string,
): string | null {
  const v = key.epochFloorKids[epochFloorKey(userId, phoneDeviceId)];
  return v === undefined ? null : v;
}

export interface AdmitEpochResult {
  /** The floor now in storage — always equal to `pairEpoch` on success. */
  floor: bigint;
  /** True when this `(userId, phoneDeviceId)` had never been seen (TOFU). */
  firstSight: boolean;
  /**
   * True when this was the RESUME cell: the same epoch under the same kid, so
   * no floor moved and the same session key is about to be re-derived.
   *
   * THE CALLER MUST NOT START A FRESH SEQ COUNTER WHEN THIS IS TRUE. Same key,
   * same nonce prefix, a counter back at 0 = GCM nonce reuse — the failure
   * A3-M2 exists to prevent, arriving through the door A3-M2 just opened.
   */
  resume: boolean;
}

/**
 * A3-M2, the whole control, in one function the caller cannot go around.
 *
 * ORDERING IS THE POINT. The new floor is written to the store and the write is
 * AWAITED before this resolves, so the derived keys cannot be used to seal or
 * unseal anything until the floor is durable. A crash between "used" and
 * "persisted" must leave the floor AHEAD of reality, never behind: a floor that
 * is too high costs one re-pair, a floor that is too low costs the confidentiality
 * of every frame under the replayed key. Same family as A2's persist-before-emit
 * counter rule, and for the same reason.
 *
 * It takes the LIVE key object and mutates `epochFloors` only AFTER the store
 * write succeeds, so a failed write leaves memory and storage agreeing.
 *
 * `pairEpoch` is a bigint because that is what `pairContextFromWire` returns;
 * there is no overload taking a number, deliberately — a `number` here is how
 * the uint64 gets rounded back.
 *
 * ── P2.6 / A6-P61D-RESUME-TEARDOWN: the equal-epoch cell ───────────────────
 *
 * v2 refused `pairEpoch === floor` outright. That is correct for a REPLAY and
 * wrong for a RESUME, and until P2.6 the two were indistinguishable here, so a
 * bare page reload — relay soft-hold, auto-resume, the SAME accept block
 * re-delivered by design (P1(b)) — landed on the refusing branch and tore the
 * pair down (`e2e-epoch-replayed` -> leaveActive -> `user_left`).
 *
 * The thing that tells them apart is the KID, and it is the right discriminator
 * rather than a convenient one: the kid names the key material in the block. A
 * resume re-delivers the same block, so the same kid; anything that would
 * actually restart a counter against an already-sealing key — a new SK minted
 * at a stale epoch, a second Accept that failed to bump — carries a DIFFERENT
 * kid, and is still refused. The four cells:
 *
 *   pairEpoch >  floor                     -> ADMIT, floor and kid move
 *   pairEpoch == floor && kid == floor.kid -> ADMIT AS RESUME, nothing moves
 *   pairEpoch == floor && kid != floor.kid -> REFUSE  (kid-mismatch)
 *   pairEpoch == floor && no stored kid    -> REFUSE  (kid-unknown, pre-P2.6)
 *   pairEpoch <  floor                     -> REFUSE  (below-floor)
 *
 * WHAT IS DELIBERATELY NOT AN INPUT: the relay's `resumed` bit. It does not
 * appear in this function and must not be passed to it. `resumed` is set by a
 * relay-position party, and a control a relay can set is a control a relay can
 * lift — the same argument `useE2e.ts` already makes for the sticky unseal
 * refusal. The bit stays what it was: a UI hint and one input to the seq
 * store's `fresh` selector. A resume is recognised from the key schedule
 * itself, by two parties that both hold it, or it is not recognised.
 */
export async function admitPairEpoch(opts: {
  store: WebKeyStore;
  key: WebDeviceKey;
  userId: string;
  phoneDeviceId: string;
  pairEpoch: bigint;
  /** The accept block's `kid`. REQUIRED — see the equal-epoch cell above. */
  kid: string;
  /**
   * Security MUST #1: does this kid still have seq history? Consulted ONLY on
   * the equal-epoch cell, and its ABSENCE REFUSES — a caller that forgets to
   * pass it does not get a silently weaker rule, it gets no resume at all.
   * `lib/e2e/session.mjs` `hasSeqRecord` is the implementation.
   */
  hasSeqState?: (kid: string) => Promise<boolean> | boolean;
}): Promise<AdmitEpochResult> {
  const { store, key, userId, phoneDeviceId, pairEpoch, kid, hasSeqState } = opts;
  if (typeof pairEpoch !== 'bigint') {
    throw new TypeError('admitPairEpoch: pairEpoch must be a bigint (a number rounds above 2^53)');
  }
  if (pairEpoch < BigInt(0) || pairEpoch > MAX_UINT64) {
    throw new WebKeyRecordShapeError(`pairEpoch ${pairEpoch} is outside uint64`);
  }
  // Required, not optional-with-a-fallback. An absent kid would silently make
  // every equal-epoch case refuse again — the bug back, and green tests.
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > EPOCH_FLOOR_KID_MAX) {
    throw new WebKeyRecordShapeError(
      `admitPairEpoch: kid must be a 1..${EPOCH_FLOOR_KID_MAX} char string (the accept block's kid)`,
    );
  }
  const k = epochFloorKey(userId, phoneDeviceId);
  const existing = key.epochFloors[k];
  const firstSight = existing === undefined;

  if (!firstSight) {
    const floor = BigInt(existing);
    if (pairEpoch < floor) throw new EpochFloorError(floor, pairEpoch, k, 'below-floor');
    if (pairEpoch === floor) {
      const storedKid = key.epochFloorKids[k];
      if (storedKid === undefined) {
        throw new EpochFloorError(floor, pairEpoch, k, 'kid-unknown');
      }
      if (storedKid !== kid) {
        throw new EpochFloorError(floor, pairEpoch, k, 'kid-mismatch');
      }
      // Security MUST #1. Note the `!hasSeqState` arm: no probe = refuse.
      if (!hasSeqState || !(await hasSeqState(kid))) {
        throw new EpochFloorError(floor, pairEpoch, k, 'seq-state-missing');
      }
      // RESUME. Nothing to persist: the floor is already this epoch and the kid
      // is already this kid, so there is no write to await and no window where
      // storage lags memory. The ordering guarantee below is about ADVANCING a
      // floor; a floor that does not move cannot be behind reality.
      return { floor, firstSight: false, resume: true };
    }
  }

  const next = { ...key.epochFloors, [k]: pairEpoch.toString(10) };
  const nextKids = { ...key.epochFloorKids, [k]: kid };
  // Persist FIRST. `toRecord` copies the maps, so the record written here is the
  // new floor even though `key.epochFloors` is still the old one at this line.
  await store.put(toRecord({ ...key, epochFloors: next, epochFloorKids: nextKids }));
  key.epochFloors = next;
  key.epochFloorKids = nextKids;
  return { floor: pairEpoch, firstSight, resume: false };
}

/**
 * Drop every floor. The ONLY caller is an explicit user action — unpair, revoke
 * or sign-out.
 *
 * There is deliberately no wire-triggered path to this function and no
 * per-pairing reset: if a value arriving from the relay could clear a floor,
 * the floor would defend against exactly nothing, because the replay that
 * A3-M2 refuses could simply be preceded by a clear. Grep this symbol before
 * adding a caller.
 */
export async function clearEpochFloors(opts: {
  store: WebKeyStore;
  key: WebDeviceKey;
}): Promise<void> {
  await opts.store.put(toRecord({ ...opts.key, epochFloors: {} }));
  opts.key.epochFloors = {};
}
