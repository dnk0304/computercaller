package com.dnkdialer.companion

/**
 * E2E programme, phase P4 Part 2 (c) — the frozen padding contract.
 *
 * A byte-for-byte port of `lib/e2e/padding.mjs` (E2E-SPEC-v1.0 §13.4, FROZEN).
 * The web lane, the service worker and this one must agree exactly: the padded
 * plaintext is what goes into the AEAD, so a disagreement is a decrypt failure
 * on every frame, not a subtle one.
 *
 * ## Why padding is not optional
 *
 * The relay sees every ciphertext's length. An unpadded AEAD leaks its
 * plaintext length to the byte, and for the traffic this product carries that
 * is not a subtle leak — a six-digit bank OTP, a two-word 2FA code and a
 * paragraph of conversation are trivially separable by size alone. "Notification
 * content is protected" cannot be claimed while the relay can read the length of
 * every notification.
 *
 * ```
 *   padded = be32(len(plaintext)) || plaintext || 0x00 * (bucket - 4 - len)
 *   bucket = smallest of 64,128,256,512,1024,2048 that fits;
 *            above 2048 -> the next multiple of 2048
 * ```
 *
 * Three details that are the whole construction:
 *
 *  - **The inner length prefix is what makes the padding removable.** 0x00 is
 *    legal plaintext, so "strip trailing zeros" corrupts any payload ending in
 *    one.
 *  - **Above the top bucket, round UP** (M7 gap i). Leaving the tail unpadded
 *    would reinstate the byte-exact leak for every large payload.
 *  - **`*_CHUNK` is exempt by SUFFIX, not by a list** (M7 gap ii). A suffix rule
 *    means a new `FOO_CHUNK` frame is exempt the day it is added rather than the
 *    day somebody remembers to update a list. Fixed-count bulk transfer already
 *    discloses its size through the chunk count, so padding each chunk costs
 *    bandwidth and hides nothing.
 *
 * `CALL_INCOMING` / `CALL_WAITING` / `CALL_STATUS` **do** pad: their sealed
 * `{number, contactName}` is short, and a caller's number length is exactly the
 * kind of short secret buckets exist to hide.
 */
object E2ePadding {

    /** The fixed buckets. Below the top bucket a length is one of exactly these. */
    val BUCKETS = intArrayOf(64, 128, 256, 512, 1024, 2048)

    /** Above the top bucket, lengths step in multiples of this. */
    const val BUCKET_STEP = 2048

    /** Bytes of big-endian length prefix that precede the plaintext in a bucket. */
    const val LENGTH_PREFIX_BYTES = 4

    /** The largest plaintext a single bucketed frame may carry. */
    const val MAX_PLAINTEXT_BYTES = Int.MAX_VALUE - LENGTH_PREFIX_BYTES

    /** Bulk-transfer frames, exempt by suffix. */
    const val EXEMPT_SUFFIX = "_CHUNK"

    /** Thrown on a malformed or tampered padded frame. Never returns a truncated payload. */
    class PaddingException(message: String) : IllegalArgumentException(message)

    fun isExempt(frameType: String?): Boolean =
        frameType != null && frameType.endsWith(EXEMPT_SUFFIX)

    /** The padded length for a plaintext of [n] bytes. */
    fun bucketFor(n: Int): Int {
        if (n < 0) throw PaddingException("length must be non-negative, got $n")
        if (n > MAX_PLAINTEXT_BYTES) throw PaddingException("plaintext exceeds the be32 prefix ($n)")
        val needed = n + LENGTH_PREFIX_BYTES
        for (b in BUCKETS) if (needed <= b) return b
        // Gap (i): round UP to the next whole step above the top bucket.
        return ((needed + BUCKET_STEP - 1) / BUCKET_STEP) * BUCKET_STEP
    }

    /**
     * Pad a plaintext for sealing. An exempt frame type is returned UNCHANGED —
     * no prefix, no padding — so the chunk path stays byte-for-byte what it is.
     */
    fun pad(frameType: String?, plaintext: ByteArray): ByteArray {
        if (isExempt(frameType)) return plaintext
        val n = plaintext.size
        val out = ByteArray(bucketFor(n)) // zero-filled: the pad bytes ARE 0x00
        out[0] = ((n ushr 24) and 0xff).toByte()
        out[1] = ((n ushr 16) and 0xff).toByte()
        out[2] = ((n ushr 8) and 0xff).toByte()
        out[3] = (n and 0xff).toByte()
        System.arraycopy(plaintext, 0, out, LENGTH_PREFIX_BYTES, n)
        return out
    }

    /**
     * Recover the plaintext after unsealing.
     *
     * Fails loudly on a length prefix that does not fit its bucket, and on a
     * frame whose length is not a legal bucket at all. A frame claiming more
     * than its bucket can hold is malformed or tampered, and the one thing it
     * must not do is silently return a truncated payload.
     */
    fun unpad(frameType: String?, padded: ByteArray): ByteArray {
        if (isExempt(frameType)) return padded
        if (padded.size < LENGTH_PREFIX_BYTES) {
            throw PaddingException("frame shorter than the length prefix (${padded.size})")
        }
        val n = ((padded[0].toInt() and 0xff) shl 24) or
            ((padded[1].toInt() and 0xff) shl 16) or
            ((padded[2].toInt() and 0xff) shl 8) or
            (padded[3].toInt() and 0xff)
        if (n < 0 || n.toLong() + LENGTH_PREFIX_BYTES > padded.size) {
            throw PaddingException("length prefix $n does not fit a ${padded.size}-byte frame")
        }
        if (padded.size != bucketFor(n)) {
            throw PaddingException(
                "${padded.size}-byte frame is not the bucket for $n bytes (${bucketFor(n)})"
            )
        }
        return padded.copyOfRange(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + n)
    }
}
