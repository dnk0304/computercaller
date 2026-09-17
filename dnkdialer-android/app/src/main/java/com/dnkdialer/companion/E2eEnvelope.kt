package com.dnkdialer.companion

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * E2E programme, phase P4 Part 2 (c2) — the sealed-frame envelope, re-derived
 * against **GATE1.md Addendum A1 (AMENDED, 2026-09-17T22:34Z)**.
 *
 * ```
 *   { "e": 1, "kid": "<key id>", "s": <sequence>, "c": "<base64url ciphertext>" }
 * ```
 *
 * ## What A1 changed from P4's original (c) proposal
 *
 * A1 ratified the KDF (items 1, 2, 4) byte for byte and **newly specified the
 * AEAD**, which P4 had proposed differently. Both of P4's AEAD bytes are now
 * replaced — this file is the amended version:
 *
 * | | P4 (c) proposal — WRONG | A1 ratified — implemented here |
 * |---|---|---|
 * | nonce | `0x00*4 ‖ be64(seq)` | `sessionPrefix(4 B random) ‖ be64(seq)` |
 * | AAD | `"cc-e2e-v1" ‖ 0x01 ‖ u8(len) kid ‖ be64(seq)` | tags `0x21..0x25`, below |
 *
 * ```
 *   nonce (12 B) = sessionPrefix(4 B, random, per (kid,direction)) ‖ be64(seq)
 *
 *   AAD = 0x21 u8(len) frameType     (ASCII, e.g. "SMS_RECEIVED")
 *       ‖ 0x22 u8(len) kid           (ASCII)
 *       ‖ 0x23 be64(seq)             (the SAME seq as the nonce)
 *       ‖ 0x24 u8 direction          (0x01 = p2c, 0x02 = c2p)
 *       ‖ 0x25 be64(pairEpoch)
 * ```
 *
 * ## The four rules A1 attaches to these bytes, and where each one lives
 *
 * 1. **Uniqueness comes from the COUNTER, not the prefix.** The 4-byte random
 *    `sessionPrefix` is defence in depth against a state-restore bug and must
 *    never be treated as what makes nonces unique. Reasoning "the prefix is
 *    random so a counter collision is fine" reintroduces the bug. The counter
 *    is owned by [E2eSeqStore]; nothing here can choose a sequence.
 * 2. **Persist-before-emit, fail closed.** [E2eSeqStore] — see that file.
 * 3. **AAD is NOT the JSON header bytes.** JSON key order, spacing and number
 *    formatting are not canonical across Kotlin and JS, so authenticating the
 *    serializer's output would make a whitespace difference present as a
 *    decryption failure. Both sides parse the header and RE-ENCODE the five
 *    tagged fields above. [aad] is that re-encoding.
 * 4. **Pad first, then seal.** The plaintext fed to GCM is the §13.4 padded
 *    block. Sealing first would put the real length in the clear, which is the
 *    entire leak padding exists to close.
 *
 * ## The u8 cap is enforced, not assumed (A1 item 4)
 *
 * `kid` and `frameType` are `u8`-length-prefixed. A1 ratified `u8` over `u16`
 * *on condition* that anything exceeding 255 bytes **throws at encode time**.
 * Silent truncation to `len and 0xFF` would re-create the framing collision the
 * addendum exists to kill, in the one code path nobody tests. [requireTagged]
 * is that throw.
 *
 * ## Why this is the low-level API
 *
 * [seal] takes a key, a direction and a sequence explicitly, which is exactly
 * what a vectors test needs and exactly what production code must never do. A1:
 * *"each side holds exactly one send key and one receive key and MUST NOT be
 * able to name the other — directional separation enforced by a naming
 * convention is directional separation that will be violated."* Production code
 * uses [E2eSession], which exposes only `seal`/`open` and holds the directions
 * privately.
 */
object E2eEnvelope {

    /** Envelope version. `e` in the JSON. */
    const val VERSION = 1

    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    const val NONCE_BYTES = 12

    /** Random per-(kid,direction) nonce prefix. Defence in depth, NOT uniqueness. */
    const val SESSION_PREFIX_BYTES = 4

    // Canonical AAD tags. A1 reserves 0x21..0x25 for this structure; 0x01..0x04
    // are the SAS transcript (§13.3) and 0x11..0x15 the KDF pair context. The
    // ranges are disjoint by construction and MUST stay disjoint, so no
    // structure can be replayed as another.
    private const val TAG_FRAME_TYPE: Byte = 0x21
    private const val TAG_KID: Byte = 0x22
    private const val TAG_SEQ: Byte = 0x23
    private const val TAG_DIRECTION: Byte = 0x24
    private const val TAG_PAIR_EPOCH: Byte = 0x25

    /** Which way a frame travels. The byte is authenticated in the AAD. */
    enum class Direction(val wireByte: Byte) {
        PHONE_TO_COMPUTER(0x01),
        COMPUTER_TO_PHONE(0x02),
    }

    /** Thrown when an envelope cannot be built or parsed. Never on a bad tag. */
    class EnvelopeException(message: String) : IllegalArgumentException(message)

    /** A parsed envelope. `c` is held decoded. */
    data class Sealed(val version: Int, val kid: String, val seq: Long, val ciphertext: ByteArray) {

        /** The JSON body that goes on the wire, field order `e,kid,s,c`. */
        fun toJson(): String =
            """{"e":$version,"kid":"${escape(kid)}","s":$seq,"c":"${E2eKeyEncoding.toBase64Url(ciphertext)}"}"""

        override fun equals(other: Any?): Boolean =
            other is Sealed && version == other.version && kid == other.kid &&
                seq == other.seq && ciphertext.contentEquals(other.ciphertext)

        override fun hashCode(): Int =
            (version * 31 + kid.hashCode()) * 31 + seq.hashCode() * 31 + ciphertext.contentHashCode()
    }

    /**
     * Seal one frame. LOW-LEVEL — production code uses [E2eSession].
     *
     * @param sessionPrefix exactly [SESSION_PREFIX_BYTES] random bytes, fixed
     *        for the life of this (kid, direction).
     * @param seq must never repeat under [key]. Owned by [E2eSeqStore].
     */
    fun seal(
        key: ByteArray,
        kid: String,
        seq: Long,
        direction: Direction,
        pairEpoch: Long,
        sessionPrefix: ByteArray,
        frameType: String,
        plaintext: ByteArray,
    ): Sealed {
        requireKey(key)
        requireSeq(seq)
        // A1 rule 4: pad FIRST, then seal.
        val padded = E2ePadding.pad(frameType, plaintext)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, nonceFor(sessionPrefix, seq)),
        )
        cipher.updateAAD(aad(frameType, kid, seq, direction, pairEpoch))
        return Sealed(VERSION, kid, seq, cipher.doFinal(padded))
    }

    /**
     * Open one frame. LOW-LEVEL — production code uses [E2eSession].
     *
     * @return the plaintext, or **null** when the frame does not authenticate or
     *         the padding is malformed. Null, not an exception: §13.5 says drop
     *         the frame and never close the socket, and an exception here would
     *         tempt a caller into the reconnect loop the spec forbids.
     */
    fun open(
        key: ByteArray,
        envelope: Sealed,
        direction: Direction,
        pairEpoch: Long,
        sessionPrefix: ByteArray,
        frameType: String,
    ): ByteArray? {
        requireKey(key)
        if (envelope.version != VERSION) return null
        if (envelope.seq < 0) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(GCM_TAG_BITS, nonceFor(sessionPrefix, envelope.seq)),
            )
            cipher.updateAAD(aad(frameType, envelope.kid, envelope.seq, direction, pairEpoch))
            E2ePadding.unpad(frameType, cipher.doFinal(envelope.ciphertext))
        } catch (e: javax.crypto.AEADBadTagException) {
            null
        } catch (e: java.security.GeneralSecurityException) {
            null
        } catch (e: E2ePadding.PaddingException) {
            null
        } catch (e: EnvelopeException) {
            // An over-long kid/frameType on the RECEIVE path is a hostile or
            // corrupt frame, not a local bug: drop it like any other bad frame.
            null
        }
    }

    /**
     * Parse a wire body. Strict about the four fields, tolerant of unknown
     * additive ones so a newer peer does not break an older phone.
     */
    fun parse(json: String): Sealed {
        val obj = try {
            com.google.gson.JsonParser.parseString(json).asJsonObject
        } catch (e: RuntimeException) {
            throw EnvelopeException("not a JSON object: ${e.javaClass.simpleName}")
        }
        for (f in listOf("e", "kid", "s", "c")) {
            if (!obj.has(f)) throw EnvelopeException("envelope is missing '$f'")
        }
        val kid = obj["kid"].asString
        if (kid.isEmpty()) throw EnvelopeException("kid must not be empty")
        val seq = obj["s"].asLong
        requireSeq(seq)
        return Sealed(
            version = obj["e"].asInt,
            kid = kid,
            seq = seq,
            ciphertext = E2eKeyEncoding.fromBase64Url(obj["c"].asString),
        )
    }

    /**
     * The 12-byte GCM nonce: `sessionPrefix ‖ be64(seq)`. Exported so the A1
     * vector can pin it.
     */
    fun nonceFor(sessionPrefix: ByteArray, seq: Long): ByteArray {
        if (sessionPrefix.size != SESSION_PREFIX_BYTES) {
            throw EnvelopeException(
                "sessionPrefix must be $SESSION_PREFIX_BYTES bytes, got ${sessionPrefix.size}"
            )
        }
        requireSeq(seq)
        val out = ByteArray(NONCE_BYTES)
        System.arraycopy(sessionPrefix, 0, out, 0, SESSION_PREFIX_BYTES)
        for (i in 0 until 8) {
            out[SESSION_PREFIX_BYTES + i] = ((seq ushr ((7 - i) * 8)) and 0xff).toByte()
        }
        return out
    }

    /**
     * The canonical AAD of A1. Re-encoded from parsed fields, never taken from
     * the JSON header bytes — see rule 3 in the class doc.
     */
    fun aad(
        frameType: String,
        kid: String,
        seq: Long,
        direction: Direction,
        pairEpoch: Long,
    ): ByteArray {
        requireSeq(seq)
        if (pairEpoch < 0) throw EnvelopeException("pairEpoch must be non-negative: $pairEpoch")
        val out = ByteArrayOutputStream(96)
        writeTagged(out, TAG_FRAME_TYPE, "frameType", frameType)
        writeTagged(out, TAG_KID, "kid", kid)
        out.write(TAG_SEQ.toInt())
        out.write(be64(seq))
        out.write(TAG_DIRECTION.toInt())
        out.write(direction.wireByte.toInt())
        out.write(TAG_PAIR_EPOCH.toInt())
        out.write(be64(pairEpoch))
        return out.toByteArray()
    }

    private fun writeTagged(out: ByteArrayOutputStream, tag: Byte, name: String, value: String) {
        val bytes = requireTagged(name, value)
        out.write(tag.toInt())
        out.write(bytes.size)
        out.write(bytes)
    }

    /**
     * A1 item 4: the u8 cap is ENFORCED, not assumed. Truncating to
     * `len and 0xFF` would re-create the framing collision the addendum exists
     * to kill, in the one code path nobody tests.
     */
    private fun requireTagged(name: String, value: String): ByteArray {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        if (bytes.isEmpty()) throw EnvelopeException("$name must not be empty")
        if (bytes.size > 255) {
            throw EnvelopeException(
                "$name is ${bytes.size} bytes; the u8 length prefix holds 255 " +
                    "(A1 item 4: refuse rather than truncate)"
            )
        }
        return bytes
    }

    private fun be64(v: Long): ByteArray {
        val out = ByteArray(8)
        for (i in 0 until 8) out[i] = ((v ushr ((7 - i) * 8)) and 0xff).toByte()
        return out
    }

    private fun requireKey(key: ByteArray) {
        if (key.size != E2eKdf.KEY_BYTES) {
            throw EnvelopeException("AES-256 key must be ${E2eKdf.KEY_BYTES} bytes, got ${key.size}")
        }
    }

    private fun requireSeq(seq: Long) {
        if (seq < 0) throw EnvelopeException("sequence must be non-negative: $seq")
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
