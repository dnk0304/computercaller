package com.dnkdialer.companion

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * E2E programme, phase P4 Part 2 (a3) — HKDF-SHA-256 and the pairing's key
 * schedule.
 *
 * ## Status of the byte layouts in this file — READ BEFORE CHANGING
 *
 * E2E-SPEC-v1.0 §13 freezes the SAS transcript (13.3), the padding (13.4), the
 * dedupe parameters (13.5) and the key lifecycle (13.8). It does **not** freeze
 * the KDF. The brief gives the schedule as prose:
 *
 *     HKDF-SHA-256(info = "cc-e2e-v1" ‖ userId ‖ phoneDeviceId ‖ peerDeviceId
 *                         ‖ pairEpoch,  salt = pairingId)
 *
 * That `‖` is bare concatenation, and bare concatenation of variable-length
 * strings is ambiguous: a user whose id ends "ab" paired with device "cd"
 * produces the same info bytes as user "a" with device "bcd". Two different
 * pairings deriving one key is a real, if narrow, cross-pairing key-reuse bug,
 * and it is invisible in every test that uses fixed-width ids.
 *
 * So this file implements the same schedule with the **framing the frozen SAS
 * transcript already uses** — a one-byte field tag plus a u8 length prefix on
 * every variable-length value (E2E-SPEC §13.3). It is byte-compatible with the
 * prose in the sense that the same inputs appear in the same order; it is not
 * byte-identical to a naive reading.
 *
 * **This is P4's PROPOSAL, not a freeze.** P2 (web) and P3 (service worker) must
 * derive the identical bytes or no pairing completes, and no reference `.mjs`
 * for the KDF exists yet — `lib/e2e/sas.mjs` and `lib/e2e/padding.mjs` were the
 * only two P0 published. Rather than freeze a cross-lane layout from one side,
 * [E2eKdfVectors] emits a vectors file in the same shape as
 * `tests/sas-vectors.json` so the web lane can be pinned against these exact
 * bytes — or so Ken can rule the other way before anything ships. Flagged in the
 * (a) résumé as an OPEN cross-lane item.
 *
 * ## The schedule
 *
 * ```
 *   ephemeral P-256 keypair (epk)  minted by the accepting device
 *   Z_i   = ECDH(epk_priv, static_pub_i)        one per recipient
 *   KEK_i = HKDF(salt = pairingId, ikm = Z_i,
 *                info = LABEL_KEK ‖ pairContext ‖ 0x05 ‖ u8(len) ‖ static_pub_i)
 *   SK    = 32 random bytes                      minted once per Accept
 *   wrap_i = AES-256-GCM(KEK_i, SK)              one per recipient  (P1 e2e block)
 *   k_p2c = HKDF(salt = pairingId, ikm = SK, info = LABEL_P2C ‖ pairContext)
 *   k_c2p = HKDF(salt = pairingId, ikm = SK, info = LABEL_C2P ‖ pairContext)
 * ```
 *
 * The per-recipient KEK binds the recipient's own static key, so a wrap made for
 * the web page cannot be opened by the service worker even though both were
 * produced from the same ephemeral. One SK shared by all recipients is what lets
 * the phone seal a notification once instead of once per surface, and it is what
 * the single per-pairing SAS (13.3) authenticates.
 *
 * `k_p2c` and `k_c2p` are distinct so a reflected frame cannot be decrypted by
 * the party that sent it — without direction separation, replaying the phone's
 * own ciphertext back at it is a valid frame.
 *
 * Pure JCE (`javax.crypto.Mac`), no Android imports: every rule here is unit
 * tested on the JVM, and the same code runs on API 26 and API 36 alike.
 */
object E2eKdf {

    private const val HMAC = "HmacSHA256"

    /** SHA-256 output size; also the HKDF PRK size and every derived key size. */
    const val KEY_BYTES = 32

    /** Protocol version tag that opens every info string. */
    const val PROTOCOL_LABEL = "cc-e2e-v1"

    /** Info label for a per-recipient key-encryption key. */
    const val LABEL_KEK = "cc-e2e-v1/kek"

    /** Info label for the phone -> computer traffic key. */
    const val LABEL_PHONE_TO_COMPUTER = "cc-e2e-v1/p2c"

    /** Info label for the computer -> phone traffic key. */
    const val LABEL_COMPUTER_TO_PHONE = "cc-e2e-v1/c2p"

    // Field tags. Distinct from the SAS's 0x01..0x04 on purpose: a transcript
    // byte string must never be usable as a KDF info string or vice versa.
    private const val TAG_USER_ID: Byte = 0x11
    private const val TAG_PHONE_DEVICE_ID: Byte = 0x12
    private const val TAG_PEER_DEVICE_ID: Byte = 0x13
    private const val TAG_PAIR_EPOCH: Byte = 0x14
    private const val TAG_RECIPIENT_KEY: Byte = 0x15

    /** Thrown when a derivation input is unusable. Never returns a weak key. */
    class KdfException(message: String) : IllegalArgumentException(message)

    /**
     * Everything that identifies ONE pairing, and therefore everything that must
     * appear in the info string. Two pairings that differ in any field derive
     * unrelated keys.
     *
     * @param pairingId     the HKDF salt. A per-pairing random id from the relay.
     * @param userId        the account both devices belong to.
     * @param phoneDeviceId this phone's device id.
     * @param peerDeviceId  the computer's device id.
     * @param pairEpoch     bumped at every Accept (§13.8); what makes a rekey a
     *                      genuinely new key rather than the same key re-derived.
     */
    data class PairContext(
        val pairingId: String,
        val userId: String,
        val phoneDeviceId: String,
        val peerDeviceId: String,
        val pairEpoch: Long,
    ) {
        init {
            require(pairingId.isNotEmpty()) { "pairingId is the HKDF salt and may not be empty" }
        }
    }

    /** The two directional traffic keys for one pairing. */
    class TrafficKeys(
        /** Key this phone SEALS with. */
        val phoneToComputer: ByteArray,
        /** Key this phone OPENS with. */
        val computerToPhone: ByteArray,
    ) {
        /** Overwrite both keys. Call when the pair ends (§13.8 Reset / sign-out). */
        fun zeroize() {
            phoneToComputer.fill(0)
            computerToPhone.fill(0)
        }
    }

    // ------------------------------------------------------------ RFC 5869

    /** HKDF-Extract. `salt` may be empty; RFC 5869 then uses 32 zero bytes. */
    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val effectiveSalt = if (salt.isEmpty()) ByteArray(KEY_BYTES) else salt
        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(effectiveSalt, HMAC))
        return mac.doFinal(ikm)
    }

    /** HKDF-Expand. */
    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        if (length <= 0 || length > 255 * KEY_BYTES) {
            throw KdfException("HKDF-Expand length out of range: $length")
        }
        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(prk, HMAC))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        t.fill(0)
        return out
    }

    /** HKDF = Extract then Expand. The PRK is zeroed before returning. */
    fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = extract(salt, ikm)
        try {
            return expand(prk, info, length)
        } finally {
            prk.fill(0)
        }
    }

    // ------------------------------------------------------- info framing

    /**
     * The tagged, length-prefixed encoding of a [PairContext]. Exported so a
     * test — and [E2eKdfVectors] — can pin the transcript itself rather than
     * only the 32 bytes it happens to hash to.
     */
    fun pairContextBytes(ctx: PairContext): ByteArray {
        val out = ByteArrayOutputStream(128)
        writeTagged(out, TAG_USER_ID, utf8(ctx.userId))
        writeTagged(out, TAG_PHONE_DEVICE_ID, utf8(ctx.phoneDeviceId))
        writeTagged(out, TAG_PEER_DEVICE_ID, utf8(ctx.peerDeviceId))
        out.write(TAG_PAIR_EPOCH.toInt())
        out.write(be64(ctx.pairEpoch))
        return out.toByteArray()
    }

    /** `label ‖ pairContext` — the info string for a traffic key. */
    fun infoFor(label: String, ctx: PairContext): ByteArray {
        val out = ByteArrayOutputStream(160)
        out.write(utf8(label))
        out.write(pairContextBytes(ctx))
        return out.toByteArray()
    }

    /** `LABEL_KEK ‖ pairContext ‖ 0x15 ‖ u8(len) ‖ recipientKey` */
    fun kekInfo(ctx: PairContext, recipientSec1: ByteArray): ByteArray {
        E2eKeyEncoding.validate(recipientSec1)
        val out = ByteArrayOutputStream(240)
        out.write(utf8(LABEL_KEK))
        out.write(pairContextBytes(ctx))
        writeTagged(out, TAG_RECIPIENT_KEY, recipientSec1)
        return out.toByteArray()
    }

    private fun writeTagged(out: ByteArrayOutputStream, tag: Byte, value: ByteArray) {
        if (value.size > 255) {
            throw KdfException("field 0x%02x is ${value.size} bytes; u8 length prefix holds 255".format(tag))
        }
        out.write(tag.toInt())
        out.write(value.size)
        out.write(value)
    }

    private fun utf8(s: String) = s.toByteArray(StandardCharsets.UTF_8)

    private fun be64(v: Long): ByteArray {
        if (v < 0) throw KdfException("pairEpoch must be non-negative: $v")
        val out = ByteArray(8)
        for (i in 7 downTo 0) out[i] = ((v ushr ((7 - i) * 8)) and 0xff).toByte()
        return out
    }

    // -------------------------------------------------------- derivations

    /**
     * Reject a shared secret that is all zeros before it is ever used as IKM.
     *
     * A P-256 ECDH result is 32 bytes of the shared point's X coordinate. An
     * all-zero result cannot arise from a valid agreement — it means the peer
     * point was the identity, a provider returned a zeroed buffer on an error it
     * swallowed, or the agreement silently produced nothing. Every one of those
     * would otherwise derive a key both an attacker and we can compute.
     *
     * The comparison is constant-time-ish (no early exit) purely out of habit;
     * the value being compared is not itself a secret comparison target.
     */
    fun requireNonZeroSharedSecret(z: ByteArray) {
        if (z.isEmpty()) throw KdfException("ECDH produced an empty shared secret")
        var acc = 0
        for (b in z) acc = acc or b.toInt()
        if (acc == 0) {
            throw KdfException(
                "ECDH produced an ALL-ZERO shared secret — refusing to derive a key from it"
            )
        }
    }

    /**
     * The key-encryption key for ONE recipient. [sharedSecret] is the raw ECDH
     * output; it is validated and then zeroed by the caller, never stored.
     */
    fun deriveKek(sharedSecret: ByteArray, ctx: PairContext, recipientSec1: ByteArray): ByteArray {
        requireNonZeroSharedSecret(sharedSecret)
        return hkdf(utf8(ctx.pairingId), sharedSecret, kekInfo(ctx, recipientSec1), KEY_BYTES)
    }

    /**
     * The two directional traffic keys, from the session key minted at Accept.
     *
     * **`internal` on purpose (GATE1 Addendum A1, item 2).** A1 requires that
     * each side hold one send key and one receive key and be UNABLE to name the
     * other — "directional separation enforced by a naming convention is
     * directional separation that will be violated." Production code therefore
     * cannot reach this: it goes through [E2eSession], which fixes send=p2c and
     * recv=c2p at construction and takes no direction argument anywhere. The
     * visibility is what makes that structural rather than advisory; the unit
     * and instrumented suites are friend modules and can still pin the bytes.
     *
     * [sessionKey] must be [KEY_BYTES] of CSPRNG output — see
     * [E2eSessionKey.mint]. An all-zero session key is rejected for the same
     * reason an all-zero ECDH result is.
     */
    internal fun deriveTrafficKeys(sessionKey: ByteArray, ctx: PairContext): TrafficKeys {
        if (sessionKey.size != KEY_BYTES) {
            throw KdfException("session key must be $KEY_BYTES bytes, got ${sessionKey.size}")
        }
        requireNonZeroSharedSecret(sessionKey)
        val salt = utf8(ctx.pairingId)
        return TrafficKeys(
            phoneToComputer = hkdf(salt, sessionKey, infoFor(LABEL_PHONE_TO_COMPUTER, ctx), KEY_BYTES),
            computerToPhone = hkdf(salt, sessionKey, infoFor(LABEL_COMPUTER_TO_PHONE, ctx), KEY_BYTES),
        )
    }

    /** Info label for the p2c AEAD nonce prefix. See [deriveNoncePrefixes]. */
    const val LABEL_NONCE_P2C = "cc-e2e-v1/np2c"

    /** Info label for the c2p AEAD nonce prefix. See [deriveNoncePrefixes]. */
    const val LABEL_NONCE_C2P = "cc-e2e-v1/nc2p"

    /** The two 4-byte AEAD nonce prefixes for one pairing. */
    class NoncePrefixes(val phoneToComputer: ByteArray, val computerToPhone: ByteArray)

    /**
     * The AEAD nonce prefixes, DERIVED rather than randomly generated.
     *
     * ## Why this deviates from A1's wording, and what Security must rule on
     *
     * GATE1 Addendum A1 specifies
     * `nonce = sessionPrefix(4 B, **random**, per (kid,direction)) ‖ be64(seq)`.
     * A randomly generated prefix has to be TRANSMITTED — the receiver cannot
     * reconstruct a random value — and there is nowhere to put it. P1's `e2e`
     * block is frozen and merged as
     * `{v, mode, kid, epk, recipKeys[], wraps[]}`, the envelope is
     * `{e, kid, s, c}`, and neither carries a nonce prefix. Taken literally,
     * A1's random prefix is undecryptable by the peer.
     *
     * Rather than invent a wire field in a frozen frame, both prefixes are
     * derived from the session key under their own HKDF labels, so each side
     * computes both without transmitting anything.
     *
     * **The security property A1 asked for is preserved.** A1's stated purpose
     * for the prefix is "defence in depth against a state-restore bug" — it is
     * explicit that uniqueness comes from the COUNTER, never the prefix. SK is
     * fresh CSPRNG output at every Accept, and `pairEpoch` is bound into
     * `pairContext`, so a new Accept yields a new SK and therefore a new,
     * unpredictable prefix. What changes is only that the value is
     * *unpredictable-but-derived* instead of *random-and-transmitted*; what
     * does not change is that a restored counter meets a different prefix
     * whenever the pairing was re-Accepted.
     *
     * It is NOT a substitute for [E2eSeqStore]'s fail-closed rule, and nothing
     * here should be read as making a counter collision tolerable.
     *
     * **FLAGGED for Security/Ken** alongside the A1 ratification: either bless
     * this derivation, or add a prefix field to the `e2e` block (a P1 change).
     * Recorded in `e2e-evidence/AEAD-NONCE-PREFIX-GAP.md`.
     */
    fun deriveNoncePrefixes(sessionKey: ByteArray, ctx: PairContext): NoncePrefixes {
        if (sessionKey.size != KEY_BYTES) {
            throw KdfException("session key must be $KEY_BYTES bytes, got ${sessionKey.size}")
        }
        requireNonZeroSharedSecret(sessionKey)
        val salt = utf8(ctx.pairingId)
        return NoncePrefixes(
            phoneToComputer = hkdf(salt, sessionKey, infoFor(LABEL_NONCE_P2C, ctx), 4),
            computerToPhone = hkdf(salt, sessionKey, infoFor(LABEL_NONCE_C2P, ctx), 4),
        )
    }

    /** Lowercase hex. Test and vector-file use only — never log a key with it. */
    fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) sb.append("%02x".format(b.toInt() and 0xff))
        return sb.toString()
    }

    /** Inverse of [toHex]. */
    fun fromHex(hex: String): ByteArray {
        if (hex.length % 2 != 0) throw KdfException("not whole bytes of hex: ${hex.length}")
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return out
    }
}
