/**
 * lib/e2e/types-proof.mts — compile-time proof that the .d.mts sidecars resolve
 * and describe the real modules (Gate 1 R2).
 *
 * A declaration file nothing imports is unverified: it can name a function that
 * was renamed, or sit at a path TypeScript never consults (`.d.ts` beside an
 * `.mjs` is exactly that trap), and `tsc --noEmit` stays green because no call
 * site ever asked. This file is that call site. It emits nothing at runtime and
 * is never imported by shipping code — its only job is to fail the gate's tsc
 * step when a sidecar drifts from the implementation it claims to describe.
 */

import {
  sasDigits, sasTranscript, canonicalKeySet, compareBytes, fromHex, toHex, SAS_INFO,
  type SasInput,
} from './sas.mjs';
import {
  padPlaintext, unpadPlaintext, bucketFor, allowedLengths, isExempt,
  BUCKETS, BUCKET_STEP, LENGTH_PREFIX_BYTES, MAX_PLAINTEXT_BYTES, EXEMPT_SUFFIX,
} from './padding.mjs';

// P-256 uncompressed SEC1 is the pinned wire encoding (Gate 1 R1): 65 bytes, 0x04.
const p256Point = new Uint8Array(65);
p256Point[0] = 0x04;

export async function proveSas(): Promise<string> {
  const input: SasInput = {
    pairingId: 'pair-1',
    epk: p256Point,
    keys: [p256Point, toHex(p256Point)],
    pairEpoch: 1,
    modeOn: true,
  };
  const ikm: Uint8Array = sasTranscript(input);
  const set: Uint8Array[] = canonicalKeySet(input.keys);
  const order: number = compareBytes(set[0], fromHex('04'));
  void ikm;
  void order;
  void SAS_INFO;
  return sasDigits(input);
}

export function provePadding(): number {
  const padded: Uint8Array = padPlaintext('NOTIFICATION_NEW', new Uint8Array([1, 2, 3]));
  const back: Uint8Array = unpadPlaintext('NOTIFICATION_NEW', padded);
  const exempt: boolean = isExempt(`FOO${EXEMPT_SUFFIX}`);
  const lengths: number[] = allowedLengths(BUCKET_STEP * 3);
  void back;
  void exempt;
  void lengths;
  void BUCKETS;
  void LENGTH_PREFIX_BYTES;
  void MAX_PLAINTEXT_BYTES;
  return bucketFor(padded.length);
}
