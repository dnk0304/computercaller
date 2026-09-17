/**
 * lib/e2e/kdf.d.mts — the TypeScript sidecar for kdf.mjs (Gate 1 R2).
 *
 * R-A froze the implementation as ONE .mjs so node tests, the web page (P2) and
 * the extension service worker (P3) import the same bytes with no build step.
 * The cost is that TS callers would get `any` and could mis-call the frozen
 * schedule without a compile error. This sidecar buys the types back.
 *
 * Named `.d.mts`, not `.d.ts`: TypeScript resolves the types for `./kdf.mjs` at
 * `./kdf.d.mts`. A `.d.ts` beside an `.mjs` is never consulted — that is the
 * P1 (a0) finding, and it was load-bearing there too.
 *
 * `lib/e2e/types-proof.mts` compiles against this file, so a sidecar that
 * drifts from the implementation fails `tsc --noEmit` in the gate rather than
 * silently describing a function that no longer exists.
 */

/** Raw bytes, or a whole-byte hex string. */
export type Bytes = Uint8Array | string;

/** Direction byte: 0x01 = phone→computer, 0x02 = computer→phone. */
export type Direction = 0x01 | 0x02;

/** Which end of the pair a caller is. Decides which key is send and which recv. */
export type Role = 'phone' | 'computer';

export interface PairContextInput {
  userId: string | Uint8Array;
  phoneDeviceId: string | Uint8Array;
  peerDeviceId: string | Uint8Array;
  pairEpoch: number | bigint;
}

/** A context may be passed as its inputs or as the already-encoded bytes. */
export type ContextLike = PairContextInput | Uint8Array;

export interface AadInput {
  /** ASCII frame type, e.g. "SMS_RECEIVED". Throws above 255 bytes. */
  frameType: string | Uint8Array;
  /** ASCII key id. Throws above 255 bytes. */
  kid: string | Uint8Array;
  seq: number | bigint;
  direction: Direction;
  pairEpoch: number | bigint;
}

/** One direction's key material, as handed out by trafficKeys(). */
export interface DirectionalKey {
  direction: Direction;
  /** The raw 32 bytes. Exposed for tests/kdf-vectors.json; prefer `key`. */
  rawBytes: Uint8Array;
  key: CryptoKey;
  /** A2's DERIVED 4-byte nonce prefix for this direction. Never persist it. */
  sessionPrefix: Uint8Array;
}

/** A DirectionalKey bound to its per-direction DERIVED nonce prefix (A2). */
export interface Endpoint extends Partial<DirectionalKey> {
  direction: Direction;
  sessionPrefix: Bytes;
}

export interface TrafficKeys {
  role: Role;
  send: DirectionalKey;
  recv: DirectionalKey;
}

export declare const LABEL_PREFIX: string;
export declare const LABEL_KEK: string;
export declare const LABEL_P2C: string;
export declare const LABEL_C2P: string;
/** A2 — the derived nonce-prefix labels. */
export declare const LABEL_NP2C: string;
export declare const LABEL_NC2P: string;

export declare const TAG_USER_ID: number;
export declare const TAG_PHONE_DEVICE_ID: number;
export declare const TAG_PEER_DEVICE_ID: number;
export declare const TAG_PAIR_EPOCH: number;
export declare const TAG_RECIPIENT_KEY: number;

export declare const TAG_AAD_FRAME_TYPE: number;
export declare const TAG_AAD_KID: number;
export declare const TAG_AAD_SEQ: number;
export declare const TAG_AAD_DIRECTION: number;
export declare const TAG_AAD_PAIR_EPOCH: number;

export declare const DIR_P2C: 0x01;
export declare const DIR_C2P: 0x02;

export declare const NONCE_BYTES: number;
export declare const SESSION_PREFIX_BYTES: number;
export declare const TAG_BITS: number;
export declare const KEY_BYTES: number;
export declare const SEC1_P256_BYTES: number;
export declare const MAX_PREFIXED_BYTES: number;

export declare function fromHex(hex: string): Uint8Array;
export declare function toHex(bytes: Uint8Array): string;
export declare function be64(value: number | bigint): Uint8Array;
export declare function concatBytes(chunks: readonly Uint8Array[]): Uint8Array;

/** The exact pairContext bytes. Throws on any id longer than 255 bytes. */
export declare function pairContext(input: PairContextInput): Uint8Array;

/** "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i. Throws unless K_i is 65 B, 0x04. */
export declare function kekInfo(context: ContextLike, recipientKey: Bytes): Uint8Array;

/** "cc-e2e-v1/p2c" ‖ pairContext, or the /c2p label. */
export declare function trafficInfo(context: ContextLike, direction: Direction): Uint8Array;

/** HKDF-SHA-256 → 32 bytes. Refuses an empty or all-zero ikm. */
export declare function hkdf32(
  input: { salt: string; ikm: Bytes; info: Uint8Array },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

/** HKDF-SHA-256 → `length` bytes. A2's prefixes are a LENGTH, not a truncation. */
export declare function hkdfBytes(
  input: { salt: string; ikm: Bytes; info: Uint8Array; length?: number },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

/** "cc-e2e-v1/np2c" ‖ pairContext, or the /nc2p label. */
export declare function noncePrefixInfo(context: ContextLike, direction: Direction): Uint8Array;

/**
 * The two 4-byte nonce prefixes (A2). DERIVED, never transmitted, never
 * persisted — re-derive on every session construction. They contribute ZERO
 * nonce-uniqueness; the persist-before-emit counter is the sole control.
 */
export declare function deriveNoncePrefixes(
  input: { pairingId: string; sessionKey: Bytes; context: ContextLike },
  subtle?: SubtleCrypto,
): Promise<{ np2c: Uint8Array; nc2p: Uint8Array }>;

/** The A3 `ctx` wire object. `pairEpoch` is a DECIMAL STRING, never a number. */
export interface PairContextWire {
  pairingId: string;
  phoneDeviceId: string;
  peerDeviceId: string;
  pairEpoch: string;
}

export interface ResolvedPairContext {
  contextBytes: Uint8Array;
  pairingId: string;
  phoneDeviceId: string;
  peerDeviceId: string;
  /** BigInt, for the A3-M2 epoch-floor comparison the CALLER owns. */
  pairEpoch: bigint;
}

export declare const PAIR_EPOCH_WIRE_RE: RegExp;
export declare const MAX_UINT64: bigint;

/**
 * A3 — wire ctx + the LOCAL session userId → the pair context. Throws on an
 * absent ctx (A3-M4), on any pairEpoch that is not a bare decimal string, and
 * on a peerDeviceId/pairingId that is not this device's (A3-M3). The A3-M2
 * epoch floor is the caller's: compare the returned `pairEpoch`.
 */
export declare function pairContextFromWire(
  ctxWire: PairContextWire | unknown,
  local: { userId: string; deviceId?: string | null; pairingId?: string | null },
): ResolvedPairContext;

/** KEK_i — the key that wraps the session key for ONE recipient. */
export declare function kek(
  input: { pairingId: string; sharedSecret: Bytes; context: ContextLike; recipientKey: Bytes },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

/**
 * One send key and one receive key for `role`. There is deliberately no
 * `keyForDirection()`: a caller cannot name the other side's pair (A1 (2)).
 */
export declare function trafficKeys(
  input: { pairingId: string; sessionKey: Bytes; context: ContextLike; role: Role },
  subtle?: SubtleCrypto,
): Promise<TrafficKeys>;

/** sessionPrefix(4 B) ‖ be64(seq). Uniqueness comes from seq, not the prefix. */
export declare function nonce(sessionPrefix: Bytes, seq: number | bigint): Uint8Array;

/** The canonically RE-ENCODED associated data — never the JSON header bytes. */
export declare function aad(input: AadInput): Uint8Array;

/** Pads per §13.4, then seals. Returns ciphertext ‖ 16-byte tag. */
export declare function seal(
  input: {
    sender: Endpoint;
    frameType: string;
    kid: string;
    seq: number | bigint;
    pairEpoch: number | bigint;
    plaintext: Uint8Array;
  },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

/** Opens and unpads. THROWS on a tag failure — the envelope layer turns that into a drop. */
export declare function open(
  input: {
    receiver: Endpoint;
    frameType: string;
    kid: string;
    seq: number | bigint;
    pairEpoch: number | bigint;
    ciphertext: Bytes;
  },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

export interface Sender extends Endpoint {
  sessionPrefix: Uint8Array;
  /** Durably commits the NEXT value, then hands out the current one. */
  nextSeq(): Promise<bigint>;
}

/**
 * A send counter that cannot be used without persist-before-emit (A1 (3)).
 * Throws when `resumeFrom` is absent: a device that cannot prove its counter
 * floor must force a rekey, never resume at a guess or restart at 0.
 */
export declare function createSender(input: {
  trafficKey: DirectionalKey;
  sessionPrefix: Bytes;
  resumeFrom: number | bigint;
  commitSeq: (next: bigint) => Promise<void> | void;
}): Sender;
