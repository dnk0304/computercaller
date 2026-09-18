package com.dnkdialer.companion

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

/**
 * E2E programme, phase P4 Part 2 (b) — the Short Authentication String.
 *
 * This is the five-digit code the user compares between phone and computer. It
 * is a **byte-for-byte port of `lib/e2e/sas.mjs`**, the frozen reference, and it
 * is pinned by the same `tests/sas-vectors.json` the web and service-worker
 * lanes are pinned by (see [E2eSasVectorsTest], which asserts every vector
 * including the full transcript hex, not merely the five digits).
 *
 * ## Layout — E2E-SPEC-v1.0 §13.3, FROZEN (AUDIT-SECURITY-v1 B7 as corrected by v2 B9)
 *
 * ```
 *   salt = UTF8(pairingId)
 *   info = "cc-sas-v1"
 *   ikm  = 0x01 || u8(len(epk)) || epk
 *        || 0x02 || u8(n) || u8(len(K_1)) || K_1 || … || u8(len(K_n)) || K_n
 *        || 0x03 || be64(pairEpoch)
 *        || 0x04 || modeByte
 *   digits = be32(HKDF-SHA256(salt, ikm, info)[0..4]) mod 100000, zero-padded to 5
 * ```
 *
 * ## The three rules that are easy to get subtly wrong
 *
 * **1. `K_1…K_n` is the WHOLE key set, not the two peers.** Phone plus every
 * recipient — web, the extension's service worker, any further computer. One
 * code per pairing, never one per recipient. Under a per-recipient SAS the
 * service worker's code is never displayed because the SW has no UI, so a
 * swapped SW key would be invisible to the user while remaining the one leg
 * that decrypts notification bodies with the panel closed. That is precisely
 * the attack Encrypted mode exists to stop. Vector `v4-3key-sw-swapped` is v3
 * with only the SW key changed, and its digits differ — if a port gets this
 * wrong, that vector is the one that catches it.
 *
 * **2. The set is deduplicated and sorted by UNSIGNED byte order.** Kotlin's
 * `Byte` is signed, so a naive comparison orders 0x80 *before* 0x01 and two
 * parties that learned the keys in different orders compute different digits.
 * [compareBytes] masks to 0..255 for exactly this reason. A prefix sorts before
 * its extension.
 *
 * **3. Every field is tagged and every variable value length-prefixed.** Without
 * it, `"AB" || "C"` and `"A" || "BC"` collide and one transcript describes two
 * different pairings.
 *
 * ## Why the digits must never be "fixed" to match
 *
 * If the phone shows 12345 and the browser shows 67890, the tempting repair is
 * to weaken the transcript until they agree — drop a key from the set, drop the
 * modeByte, hash only the epk. Every one of those turns a verification code into
 * decoration while leaving the UI looking identical. The correct repair is
 * always to find which side departed from this layout. The vectors exist so that
 * question has an answer.
 */
object E2eSas {

    /** The HKDF info string. Frozen. */
    const val INFO = "cc-sas-v1"

    private const val DIGIT_MODULUS = 100000
    /**
     * Frozen at 5 by E2E-SPEC §13.3 ("mod 100000, zero-padded to 5").
     *
     * Visible (was private) so the SAS UI can source the count from the frozen
     * implementation instead of restating it. P5b's first cut hardcoded 6 from
     * the brief and nothing caught it: a UI that repeats a frozen number is a
     * second place for that number to be wrong, and the display is exactly
     * where being wrong is invisible to every crypto test.
     */
    const val DIGIT_LENGTH = 5

    /** Bytes of OKM the digits are taken from. Four — `be32`, then mod. */
    private const val OKM_BYTES = 4

    /** Thrown when a SAS input cannot produce a well-defined transcript. */
    class SasException(message: String) : IllegalArgumentException(message)

    /**
     * Unsigned lexicographic byte comparison; a prefix sorts before its
     * extension. The `and 0xff` is load-bearing — see rule 2 in the class doc.
     */
    fun compareBytes(a: ByteArray, b: ByteArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            val x = a[i].toInt() and 0xff
            val y = b[i].toInt() and 0xff
            if (x != y) return if (x < y) -1 else 1
        }
        return a.size.compareTo(b.size)
    }

    /**
     * The canonical key set: deduplicated, then sorted by unsigned byte order.
     *
     * Public because the SAS is only reproducible if every party derives the
     * same set — P1's `PAIRING_ACTIVE` / `PAIR_STATE` frames carry `recipKeys`
     * as the FULL list precisely so this can be computed identically on each
     * side.
     */
    fun canonicalKeySet(keys: List<ByteArray>): List<ByteArray> {
        val seen = LinkedHashMap<String, ByteArray>()
        for (k in keys) {
            if (k.isEmpty()) throw SasException("a static public key may not be empty")
            if (k.size > 255) throw SasException("key too long to u8-length-prefix (${k.size})")
            seen.putIfAbsent(E2eKdf.toHex(k), k)
        }
        if (seen.isEmpty()) throw SasException("the key set may not be empty")
        if (seen.size > 255) throw SasException("more keys than u8(n) can express (${seen.size})")
        return seen.values.sortedWith(::compareBytes)
    }

    /**
     * The exact IKM bytes.
     *
     * Split out from [digits] so a test can pin the transcript itself rather
     * than only the five digits it happens to hash to: five digits collide one
     * time in 100000, so a transcript bug that collides would otherwise read as
     * a pass. The vectors file carries `transcriptHex` for this reason and the
     * instrumented test asserts it.
     *
     * @param epk       the accepting device's ephemeral public key, as bytes.
     * @param keys      ALL static public keys in the pairing (see rule 1).
     * @param pairEpoch bumped at every Accept.
     * @param modeOn    the EFFECTIVE mode — the OR of both sides (C-1).
     */
    fun transcript(
        epk: ByteArray,
        keys: List<ByteArray>,
        pairEpoch: Long,
        modeOn: Boolean,
    ): ByteArray {
        if (epk.isEmpty() || epk.size > 255) {
            throw SasException("epk length must be 1..255 bytes (got ${epk.size})")
        }
        val set = canonicalKeySet(keys)
        val out = ByteArrayOutputStream(64 + set.sumOf { it.size + 1 })
        out.write(0x01)
        out.write(epk.size)
        out.write(epk)
        out.write(0x02)
        out.write(set.size)
        for (k in set) {
            out.write(k.size)
            out.write(k)
        }
        out.write(0x03)
        out.write(be64(pairEpoch))
        out.write(0x04)
        out.write(if (modeOn) 0x01 else 0x00)
        return out.toByteArray()
    }

    /**
     * The five-digit code shown to the user.
     *
     * HKDF comes from [E2eKdf] rather than a second implementation here: two
     * HKDFs in one app is two things to get wrong, and [E2eKdf]'s is the one
     * checked against the RFC 5869 vectors.
     */
    fun digits(
        pairingId: String,
        epk: ByteArray,
        keys: List<ByteArray>,
        pairEpoch: Long,
        modeOn: Boolean,
    ): String {
        if (pairingId.isEmpty()) {
            throw SasException("pairingId must be non-empty (it is the HKDF salt)")
        }
        val ikm = transcript(epk, keys, pairEpoch, modeOn)
        val okm = E2eKdf.hkdf(
            salt = pairingId.toByteArray(StandardCharsets.UTF_8),
            ikm = ikm,
            info = INFO.toByteArray(StandardCharsets.UTF_8),
            length = OKM_BYTES,
        )
        val be32 =
            ((okm[0].toLong() and 0xff) shl 24) or
                ((okm[1].toLong() and 0xff) shl 16) or
                ((okm[2].toLong() and 0xff) shl 8) or
                (okm[3].toLong() and 0xff)
        return (be32 % DIGIT_MODULUS).toString().padStart(DIGIT_LENGTH, '0')
    }

    private fun be64(v: Long): ByteArray {
        if (v < 0) throw SasException("pairEpoch must be non-negative: $v")
        val out = ByteArray(8)
        for (i in 0 until 8) out[i] = ((v ushr ((7 - i) * 8)) and 0xff).toByte()
        return out
    }
}
