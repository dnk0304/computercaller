/**
 * lib/e2e/sas.d.mts — the TypeScript sidecar for sas.mjs (Gate 1 R2).
 *
 * R-A froze the implementation as ONE .mjs so node tests, the web page (P2) and
 * the extension service worker (P3) import the same bytes with no build step.
 * The cost of that is that TS callers get `any` and the frozen transcript could
 * be mis-called from TypeScript without a compile error. This sidecar buys the
 * types back without reintroducing a build step.
 *
 * The sidecar is named `.d.mts`, not `.d.ts`: TypeScript resolves the types for
 * `./sas.mjs` at `./sas.d.mts`. A `.d.ts` beside an `.mjs` is never consulted.
 *
 * `lib/e2e/types-proof.mts` compiles against this file, so a sidecar that drifts
 * from the implementation fails `tsc --noEmit` in the gate rather than silently
 * describing a function that no longer exists.
 */

/** A public key or transcript field: raw bytes, or a whole-byte hex string. */
export type KeyMaterial = Uint8Array | string;

export interface SasInput {
  /** HKDF salt. Must be a non-empty string. */
  pairingId: string;
  /** The ephemeral public key. P-256 uncompressed SEC1: 65 bytes, 0x04-prefixed. */
  epk: KeyMaterial;
  /** ALL static public keys in the pairing — phone plus every recipient (B9). */
  keys: readonly KeyMaterial[];
  pairEpoch: number | bigint;
  /** The EFFECTIVE mode: the OR of both sides' per-device settings (C-1). */
  modeOn: boolean;
}

/** The inputs sasTranscript needs — everything but the HKDF salt. */
export type SasTranscriptInput = Omit<SasInput, 'pairingId'>;

/** Unsigned lexicographic byte comparison; a prefix sorts before its extension. */
export declare function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1;

/** Hex -> bytes. Throws on anything that is not whole bytes of hex. */
export declare function fromHex(hex: string): Uint8Array;

export declare function toHex(bytes: Uint8Array): string;

/** Deduplicated and sorted by unsigned byte order — the canonical key SET. */
export declare function canonicalKeySet(keys: readonly KeyMaterial[]): Uint8Array[];

/** The exact IKM bytes, so a test can pin the transcript and not just the digits. */
export declare function sasTranscript(input: SasTranscriptInput): Uint8Array;

/** The five-digit code shown to the user. Resolves to exactly 5 ASCII digits. */
export declare function sasDigits(input: SasInput, subtle?: SubtleCrypto): Promise<string>;

export declare const SAS_INFO: string;
