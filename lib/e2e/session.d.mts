/**
 * lib/e2e/session.d.mts — the TypeScript sidecar for session.mjs (Gate 1 R2).
 *
 * `.d.mts`, not `.d.ts`: TypeScript resolves the types for `./session.mjs` at
 * `./session.d.mts`, and a `.d.ts` beside an `.mjs` is never consulted. That is
 * the P1 (a0) finding and it is load-bearing here too.
 *
 * The implementation is a single `.mjs` so the node tests, the web page and the
 * extension service worker import the same bytes with no build step (R-A). This
 * file is what stops a TypeScript caller from mis-calling it without a compile
 * error. `lib/e2e/types-proof.mts` compiles against this sidecar, so drift fails
 * `tsc --noEmit` in the gate rather than quietly describing a function that no
 * longer exists.
 */

import type { Direction, DirectionalKey, ContextLike, Bytes } from './kdf.d.mts';

export type { Direction };

export declare const DIR_P2C: 0x01;
export declare const DIR_C2P: 0x02;
export declare const SESSION_PREFIX_BYTES: number;

// ── A2: the derived nonce prefixes ─────────────────────────────────────────

export declare const LABEL_NP2C: string;
export declare const LABEL_NC2P: string;

/** "cc-e2e-v1/np2c" ‖ pairContext (or /nc2p). Exposed so a test can pin vector E's info bytes. */
export declare function noncePrefixInfo(context: ContextLike, direction: Direction): Uint8Array;

/**
 * Both prefixes, together. There is deliberately no "prefix for a direction"
 * accessor — the same discipline A1 (2) imposed on `trafficKeys`.
 *
 * The prefix contributes ZERO nonce uniqueness (A2 strikes A1's defence-in-depth
 * rationale); the persist-before-emit counter is the sole control. Never persist
 * the result — re-derive it on every session construction (A2 MUST #2).
 */
export declare function deriveNoncePrefixes(
  input: { pairingId: string; sessionKey: Bytes; context: ContextLike },
  subtle?: SubtleCrypto,
): Promise<{ np2c: Uint8Array; nc2p: Uint8Array }>;

// ── key agreement + unwrap ─────────────────────────────────────────────────

export declare const WRAP_FRAME_TYPE: string;

/** SHA-256(UTF8(deviceId))[0..4] — the phone's per-recipient wrap prefix. */
export declare function wrapPrefix(deviceId: string, subtle?: SubtleCrypto): Promise<Uint8Array>;

/**
 * ECDH(epk, ourPriv) → KEK → open our wrap → SK.
 * Throws when the wrap does not authenticate — including when it was minted for
 * another recipient, which is what binding K_i into the KEK info buys.
 */
export declare function openWrap(
  input: {
    wrap: string | Uint8Array;
    kid: string;
    epk: Bytes;
    /** The NON-EXTRACTABLE CryptoKey from webKey.ts. */
    ourPrivateKey: CryptoKey;
    ourPublicSec1: Bytes;
    ourDeviceId: string;
    pairingId: string;
    context: ContextLike;
    pairEpoch: number | bigint;
  },
  subtle?: SubtleCrypto,
): Promise<Uint8Array>;

export declare function toBase64Url(bytes: Uint8Array): string;
export declare function fromBase64Url(value: string): Uint8Array;

// ── the envelope ───────────────────────────────────────────────────────────

export declare const ENVELOPE_VERSION: 1;

export interface Envelope {
  e: 1;
  kid: string;
  s: number;
  c: string;
}

export declare function encodeEnvelope(input: {
  kid: string;
  seq: number | bigint;
  ciphertext: Uint8Array;
}): Envelope;

/** Null for anything that is not an envelope — a plaintext frame is the OTHER branch, not an error. */
export declare function decodeEnvelope(
  value: unknown,
): { kid: string; seq: number; ciphertext: Uint8Array } | null;

// ── the fail-closed send counter ───────────────────────────────────────────

export declare const SEQ_RECORD_VERSION: number;
export declare const SEQ_REKEY_LIMIT: number;

export interface SeqRecord {
  v: number;
  kid: string;
  direction: Direction;
  next: number;
  sk: string;
}

export interface SeqStore {
  load(id: string): Promise<SeqRecord | undefined>;
  commit(id: string, record: SeqRecord): Promise<void>;
  clear?(): Promise<void>;
}

/** `rekey === true` on every instance: the caller's cue to LEAVE_ACTIVE and re-Accept. */
export declare class SeqFailClosedError extends Error {
  readonly code: 'e2e-seq-fail-closed';
  readonly reason: 'counter-lost' | 'kid-reused' | 'commit-failed';
  readonly rekey: true;
  constructor(reason: string, detail: string);
}

export declare function memorySeqStore(seed?: Map<string, SeqRecord>): SeqStore & {
  _snapshot(): Map<string, SeqRecord>;
};

export declare const SEQ_DB_NAME: string;
export declare const SEQ_DB_VERSION: number;
export declare const SEQ_STORE_NAME: string;

/** Commits resolve on the transaction's `complete`, not the request's `success`. */
export declare function indexedDbSeqStore(factory?: IDBFactory): SeqStore;

export declare function skFingerprint(sessionKey: Uint8Array, subtle?: SubtleCrypto): Promise<string>;

/**
 * A2 MUST #1, from the side that does not mint. `fresh` is the caller's evidence
 * that this kid was minted now — a PAIRING_ACTIVE that is NOT a resume.
 * THROWS `SeqFailClosedError` on a resumed kid with no counter, and on a kid
 * that returns under a different SK.
 */
export declare function bindKid(
  input: {
    store: SeqStore;
    kid: string;
    direction: Direction;
    sessionKey: Uint8Array;
    fresh: boolean;
  },
  subtle?: SubtleCrypto,
): Promise<SeqRecord & { resumed: boolean }>;

export interface FailClosedSender {
  readonly kid: string;
  readonly direction: Direction;
  readonly floor: number;
  /** Commits `n + 1` and only then returns `n`. A failed commit poisons the sender. */
  nextSeq(): Promise<number>;
}

export declare function createFailClosedSender(input: {
  store: SeqStore;
  kid: string;
  direction: Direction;
  floor: number;
  sk: string;
}): FailClosedSender;

// ── the dedupe window ──────────────────────────────────────────────────────

export declare const DEDUPE_WINDOW: number;
export declare const DEDUPE_FLOOR_ADVANCE_CAP: number;

export interface DedupeWindow {
  readonly floor: number;
  readonly drops: number;
  readonly size: number;
  /** true when the frame is NEW. false is a silent DROP, never an error. */
  accept(seq: number): boolean;
  reset(): void;
}

export declare function createDedupeWindow(): DedupeWindow;

// ── the session ────────────────────────────────────────────────────────────

export type OpenResult =
  | { ok: true; plaintext: Uint8Array; seq: number }
  | { ok: false; reason: 'shape' | 'kid' | 'duplicate' | 'auth' };

export interface ComputerSession {
  readonly kid: string;
  readonly pairEpoch: number | bigint;
  readonly resumed: boolean;
  readonly drops: number;
  readonly sendFloor: number;
  readonly recvFloor: number;
  resetDedupe(): void;
  /** THE outbound chokepoint: pads (§13.4), seals, returns the envelope. */
  seal(frameType: string, plaintext: Uint8Array): Promise<Envelope>;
  /** THE inbound decoder. Never throws for a bad frame — every failure is a drop. */
  open(frameType: string, envelope: unknown): Promise<OpenResult>;
  /** Tests and vectors only. */
  _raw: { send: Uint8Array; recv: Uint8Array; np2c: Uint8Array; nc2p: Uint8Array };
}

/**
 * `role` is NOT a parameter: this module runs on the web page and in the service
 * worker, and both are the computer. A1 (2)'s mandatory consequence is that a
 * caller must not be able to name the other side's key pair.
 */
export declare function createComputerSession(
  input: {
    pairingId: string;
    sessionKey: Uint8Array;
    context: ContextLike;
    kid: string;
    pairEpoch: number | bigint;
    store: SeqStore;
    fresh: boolean;
  },
  subtle?: SubtleCrypto,
): Promise<ComputerSession>;

export type { DirectionalKey };
