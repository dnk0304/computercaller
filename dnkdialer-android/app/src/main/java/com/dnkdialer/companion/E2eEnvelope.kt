package com.dnkdialer.companion

import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * E2E programme, phase P4 Part 2 (c) — the sealed-frame envelope.
 *
 * ```
 *   { "e": 1, "kid": "<key id>", "s": <sequence>, "c": "<base64url ciphertext>" }
 * ```
 *
 * `e` is the envelope version, `kid` names the key, `s` is the per-direction
 * sequence number the dedupe window ([E2eDedupe]) keys on, and `c` is
 * AES-256-GCM over the PADDED plaintext ([E2ePadding]).
 *
 * ## Status of the bytes — PROPOSAL, same standing as [E2eKdf]
 *
 * §13 freezes the padding, the dedupe parameters and the SAS. It freezes the
 * envelope's *field names* (the brief gives `{e:1,kid,s,c}`) but not the nonce
 * construction or the AAD, and there is no reference `.mjs` for either. Both are
 * specified here and pinned by vectors, and both are flagged for P2/P3
 * agreement — see `e2e-evidence/KDF-LAYOUT-P4-PROPOSAL.md`.
 *
 * ```
 *   nonce = 0x00 0x00 0x00 0x00 || be64(s)              (12 bytes)
 *   aad   = "cc-e2e-v1" || 0x01 || u8(len(kid)) || kid || be64(s)
 * ```
 *
 * **Why the nonce is just the sequence.** GCM's one unforgivable failure is
 * nonce reuse under the same key, which leaks the authentication key outright.
 * The traffic keys are already DIRECTIONAL ([E2eKdf.deriveTrafficKeys]), so
 * within one key there is exactly one sender and one monotonically increasing
 * `s`. Deriving the nonce from `s` alone therefore makes reuse impossible by
 * construction rather than by discipline — there is no random nonce to collide
 * and no counter that two senders could both advance. [Sender] owns that counter
 * so no call site can choose a sequence at all; the bare [seal] takes one
 * explicitly and exists for tests and vectors.
 *
 * **Why the AAD binds `kid` and `s`.** Without it, the relay can move a valid
 * ciphertext to a different sequence number or a different key id and it still
 * authenticates. Binding them means a relay that reorders or relabels frames
 * produces a decrypt failure, which §13.5 turns into a dropped frame — not a
 * silently accepted, reordered one.
 *
 * ## What an open failure must NOT do
 *
 * [open] returns null rather than throwing on a bad tag. §13.5: a decrypt
 * failure drops the frame and never closes the socket; three failures in ten
 * seconds request a re-pair. An exception here would tempt a caller into a
 * reconnect loop, which is the behaviour the spec explicitly forbids.
 */
object E2eEnvelope {

    /** Envelope version. `e` in the JSON. */
    const val VERSION = 1

    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val NONCE_BYTES = 12
    private const val AAD_LABEL = "cc-e2e-v1"
    private const val AAD_TAG_ENVELOPE: Byte = 0x01

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
     * Seal one frame.
     *
     * @param frameType the wire frame type, used ONLY to decide padding
     *        exemption ([E2ePadding.isExempt]). It travels in the clear anyway.
     * @param seq must be strictly greater than any sequence previously sealed
     *        under this [kid] — see the nonce note in the class doc.
     */
    fun seal(
        key: ByteArray,
        kid: String,
        seq: Long,
        frameType: String?,
        plaintext: ByteArray,
    ): Sealed {
        requireKey(key)
        requireKid(kid)
        if (seq < 0) throw EnvelopeException("sequence must be non-negative: $seq")
        val padded = E2ePadding.pad(frameType, plaintext)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, nonceFor(seq)),
        )
        cipher.updateAAD(aad(kid, seq))
        return Sealed(VERSION, kid, seq, cipher.doFinal(padded))
    }

    /**
     * Open one frame.
     *
     * @return the plaintext, or **null** when the frame does not authenticate or
     *         the padding is malformed. Null, not an exception: §13.5 says drop
     *         the frame and never close the socket.
     */
    fun open(key: ByteArray, envelope: Sealed, frameType: String?): ByteArray? {
        requireKey(key)
        if (envelope.version != VERSION) {
            // An unknown envelope version is not a decrypt failure, it is a
            // build mismatch. Still a drop, but a distinguishable one.
            return null
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(GCM_TAG_BITS, nonceFor(envelope.seq)),
            )
            cipher.updateAAD(aad(envelope.kid, envelope.seq))
            E2ePadding.unpad(frameType, cipher.doFinal(envelope.ciphertext))
        } catch (e: javax.crypto.AEADBadTagException) {
            null
        } catch (e: java.security.GeneralSecurityException) {
            null
        } catch (e: E2ePadding.PaddingException) {
            null
        }
    }

    /**
     * Parse a wire body. Deliberately strict about the four fields and
     * deliberately tolerant of unknown ones, so a future additive field does not
     * break an older phone.
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
        requireKid(kid)
        val seq = obj["s"].asLong
        if (seq < 0) throw EnvelopeException("sequence must be non-negative: $seq")
        return Sealed(
            version = obj["e"].asInt,
            kid = kid,
            seq = seq,
            ciphertext = E2eKeyEncoding.fromBase64Url(obj["c"].asString),
        )
    }

    /** The 12-byte GCM nonce for [seq]. Exported so a test can pin it. */
    fun nonceFor(seq: Long): ByteArray {
        val out = ByteArray(NONCE_BYTES)
        for (i in 0 until 8) out[4 + i] = ((seq ushr ((7 - i) * 8)) and 0xff).toByte()
        return out
    }

    /** The additional authenticated data for ([kid], [seq]). Exported for tests. */
    fun aad(kid: String, seq: Long): ByteArray {
        val k = kid.toByteArray(StandardCharsets.UTF_8)
        val label = AAD_LABEL.toByteArray(StandardCharsets.UTF_8)
        val out = ByteArray(label.size + 2 + k.size + 8)
        var p = 0
        System.arraycopy(label, 0, out, p, label.size); p += label.size
        out[p++] = AAD_TAG_ENVELOPE
        out[p++] = k.size.toByte()
        System.arraycopy(k, 0, out, p, k.size); p += k.size
        for (i in 0 until 8) out[p + i] = ((seq ushr ((7 - i) * 8)) and 0xff).toByte()
        return out
    }

    private fun requireKey(key: ByteArray) {
        if (key.size != E2eKdf.KEY_BYTES) {
            throw EnvelopeException("AES-256 key must be ${E2eKdf.KEY_BYTES} bytes, got ${key.size}")
        }
    }

    private fun requireKid(kid: String) {
        if (kid.isEmpty() || kid.length > 255) {
            throw EnvelopeException("kid must be 1..255 chars, got ${kid.length}")
        }
        // u8 length-prefixed in the AAD, so it must fit in 255 BYTES too.
        if (kid.toByteArray(StandardCharsets.UTF_8).size > 255) {
            throw EnvelopeException("kid exceeds 255 bytes when UTF-8 encoded")
        }
    }

    /**
     * The send side of one (kid, direction). Owns the sequence counter, because
     * a counter that call sites advance is a counter that will eventually be
     * advanced twice — and under GCM a repeated nonce does not corrupt one
     * frame, it leaks the authentication key for ALL of them.
     *
     * One instance per key id. A new Accept mints a new key and a new Sender
     * starting at zero, which is safe precisely because the KEY is new: the
     * (key, nonce) pair is what must never repeat, not the nonce alone.
     */
    class Sender(private val key: ByteArray, val kid: String) {

        /** The next sequence number this sender will use. */
        var nextSeq: Long = 0
            private set

        /** Seal the next frame and advance. */
        @Synchronized
        fun seal(frameType: String?, plaintext: ByteArray): Sealed {
            if (nextSeq == Long.MAX_VALUE) {
                // 2^63 frames is unreachable in practice; §13.8 rekeys at 2^32
                // or 30 days. Refusing here means that if the rekey is ever
                // missed we stop rather than wrap the counter and reuse a nonce.
                throw EnvelopeException("sequence space exhausted for kid=$kid — rekey required")
            }
            return seal(key, kid, nextSeq++, frameType, plaintext)
        }

        /** Overwrite the key. Call when the pair ends (§13.8). */
        fun zeroize() = key.fill(0)
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
