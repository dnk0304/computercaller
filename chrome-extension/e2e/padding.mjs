/**
 * lib/e2e/padding.mjs — the frozen padding contract. SPEC ONLY.
 *
 * Sealing itself is P2's. What is frozen here is the shape of the plaintext
 * that goes INTO the seal, because that shape is what an observer measures.
 *
 * Why padding is a blocking condition (E2E-SPEC §9.2 #5, Security M7): the relay
 * sees every ciphertext's length. An unpadded AEAD leaks its plaintext length to
 * the byte, and for the traffic this product carries that is not a subtle leak —
 * a six-digit bank OTP, a two-word 2FA code and a paragraph of conversation are
 * trivially separable by size alone. "Notification content is protected" cannot
 * be claimed while the relay can read the length of every notification.
 *
 * The construction (Security M7, both gaps closed):
 *
 *   padded = be32(len(plaintext)) || plaintext || 0x00 * (bucket - 4 - len)
 *
 *   bucket = the smallest of 64, 128, 256, 512, 1024, 2048 that fits;
 *            above 2048, the next multiple of 2048 — never an unpadded tail.
 *
 * The length prefix is what makes the padding removable: zero bytes are legal
 * plaintext, so "strip trailing zeros" would corrupt any payload ending in one.
 *
 * Scope — which frames pad (M7 gap ii):
 *   - Notification and SMS frames: yes. This is the original requirement.
 *   - CALL_INCOMING / CALL_WAITING / CALL_STATUS: YES. Their sealed body is
 *     {number, contactName}, and a caller's number length is exactly the kind of
 *     short, high-value secret buckets exist to hide. Forge's first list read as
 *     notification/SMS-only; that gap is closed here.
 *   - `*_CHUNK`: exempt. Fixed-count bulk transfer, real bandwidth cost, and no
 *     short-secret risk — the chunk count already discloses the size, so padding
 *     each chunk would cost bandwidth and hide nothing.
 *
 * Exemption is keyed on the frame TYPE, which travels in the clear on the wire
 * (`TYPE:body`), so both sides agree without inspecting the plaintext.
 *
 * Environment: no DOM, no Node built-ins — this runs unchanged in the extension
 * service worker.
 */

/** The fixed buckets. Below the top bucket, a length is one of exactly these. */
export const BUCKETS = Object.freeze([64, 128, 256, 512, 1024, 2048]);

/** Above the top bucket, lengths step in multiples of this. */
export const BUCKET_STEP = 2048;

/** Bytes of big-endian length prefix that precede the plaintext inside a bucket. */
export const LENGTH_PREFIX_BYTES = 4;

/** The largest plaintext a single bucketed frame may carry. */
export const MAX_PLAINTEXT_BYTES = 0xffffffff - LENGTH_PREFIX_BYTES;

/**
 * Bulk transfer frames, exempt by suffix. A suffix rule rather than a list so a
 * new `FOO_CHUNK` frame is exempt the day it is added, instead of the day
 * somebody remembers to update a list here.
 */
export const EXEMPT_SUFFIX = '_CHUNK';

export function isExempt(frameType) {
  return typeof frameType === 'string' && frameType.endsWith(EXEMPT_SUFFIX);
}

/**
 * The padded length for a plaintext of `n` bytes.
 * Exported on its own so a test can assert the ladder without sealing anything.
 */
export function bucketFor(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`padding: length must be a non-negative integer, got ${n}`);
  if (n > MAX_PLAINTEXT_BYTES) throw new Error(`padding: plaintext exceeds the be32 length prefix (${n})`);
  const needed = n + LENGTH_PREFIX_BYTES;
  for (const b of BUCKETS) if (needed <= b) return b;
  // Gap (i): above the top bucket, round UP to the next whole step. Leaving the
  // tail unpadded would reinstate the byte-exact leak for every large payload.
  return Math.ceil(needed / BUCKET_STEP) * BUCKET_STEP;
}

/** Every length a padded frame is allowed to have, for a given ceiling. */
export function allowedLengths(maxPlaintextBytes) {
  const top = bucketFor(maxPlaintextBytes);
  const out = BUCKETS.filter((b) => b <= top);
  for (let n = BUCKET_STEP * 2; n <= top; n += BUCKET_STEP) if (!out.includes(n)) out.push(n);
  return out.sort((a, b) => a - b);
}

/**
 * Pad a plaintext for sealing. Returns the bytes P2 will hand to the AEAD.
 * An exempt frame type is returned UNCHANGED — no prefix, no padding — so the
 * chunk path stays byte-for-byte what it is today.
 */
export function padPlaintext(frameType, plaintext) {
  if (!(plaintext instanceof Uint8Array)) throw new Error('padding: plaintext must be a Uint8Array');
  if (isExempt(frameType)) return plaintext;
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`padding: plaintext exceeds the be32 length prefix (${plaintext.length})`);
  }
  const total = bucketFor(plaintext.length);
  const out = new Uint8Array(total); // zero-filled: the pad bytes are 0x00
  const n = plaintext.length;
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  out.set(plaintext, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * Recover the plaintext after unsealing. Fails loudly on a length prefix that
 * does not fit its bucket: a frame whose prefix claims more than the bucket can
 * hold is malformed or tampered, and the one thing it must not do is silently
 * return a truncated payload.
 */
export function unpadPlaintext(frameType, padded) {
  if (!(padded instanceof Uint8Array)) throw new Error('padding: padded must be a Uint8Array');
  if (isExempt(frameType)) return padded;
  if (padded.length < LENGTH_PREFIX_BYTES) {
    throw new Error(`padding: frame shorter than the length prefix (${padded.length})`);
  }
  const n = ((padded[0] << 24) >>> 0) + (padded[1] << 16) + (padded[2] << 8) + padded[3];
  if (n + LENGTH_PREFIX_BYTES > padded.length) {
    throw new Error(`padding: length prefix ${n} does not fit a ${padded.length}-byte frame`);
  }
  if (padded.length !== bucketFor(n)) {
    throw new Error(`padding: ${padded.length}-byte frame is not the bucket for ${n} bytes (${bucketFor(n)})`);
  }
  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + n);
}
