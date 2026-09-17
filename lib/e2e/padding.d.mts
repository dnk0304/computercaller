/**
 * lib/e2e/padding.d.mts — the TypeScript sidecar for padding.mjs (Gate 1 R2).
 *
 * Named `.d.mts` because TypeScript resolves the types for `./padding.mjs` at
 * `./padding.d.mts`; a `.d.ts` beside an `.mjs` is never consulted. See the
 * header of sas.d.mts for why the implementation stays a single .mjs.
 */

/** The fixed buckets. Below the top bucket, a padded length is one of exactly these. */
export declare const BUCKETS: readonly number[];

/** Above the top bucket, lengths step in multiples of this. */
export declare const BUCKET_STEP: number;

/** Bytes of big-endian length prefix that precede the plaintext inside a bucket. */
export declare const LENGTH_PREFIX_BYTES: number;

/** The largest plaintext a single bucketed frame may carry. */
export declare const MAX_PLAINTEXT_BYTES: number;

/** Bulk-transfer frames are exempt by SUFFIX, so a new `FOO_CHUNK` is exempt on day one. */
export declare const EXEMPT_SUFFIX: string;

export declare function isExempt(frameType: string): boolean;

/** The padded length for a plaintext of `n` bytes. Throws on a negative or oversized `n`. */
export declare function bucketFor(n: number): number;

/** Every length a padded frame is allowed to have, for a given ceiling. */
export declare function allowedLengths(maxPlaintextBytes: number): number[];

/** Pad for sealing. An exempt frame type is returned UNCHANGED. */
export declare function padPlaintext(frameType: string, plaintext: Uint8Array): Uint8Array;

/** Recover the plaintext after unsealing. Throws loudly on a malformed frame. */
export declare function unpadPlaintext(frameType: string, padded: Uint8Array): Uint8Array;
