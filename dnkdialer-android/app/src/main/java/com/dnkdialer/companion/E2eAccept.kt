package com.dnkdialer.companion

import android.content.Context
import com.google.gson.JsonObject
import java.security.SecureRandom

/**
 * E2E programme, phase P4 Part 2 (d) — the Accept handshake, assembled.
 *
 * This is the one place the phone turns "the user tapped Accept" into the
 * `e2e` block that goes out on `ACCEPT_PAIRING`, plus the live [E2eSession] it
 * will seal with. Everything it needs is already built and tested:
 * [E2eNegotiation] decided, [E2eKeyAgreement] does the ECDH, [E2eKdf] derives,
 * [E2eEnvelope] wraps, [E2eSession] seals.
 *
 * ## The handshake
 *
 * ```
 *   SK        = 32 random bytes                       (minted once, here)
 *   kid       = 16 random bytes, base64url            (names this SK)
 *   epk       = fresh ephemeral P-256 keypair         (the SAS's `epk`)
 *   for each recipient i:
 *       Z_i   = ECDH(epk_priv, K_i)
 *       KEK_i = HKDF(salt=pairingId, ikm=Z_i, info="cc-e2e-v1/kek" ‖ ctx ‖ 0x15 K_i)
 *       wrap_i= AES-256-GCM(KEK_i, SK)                one per recipient
 *   block     = { v:1, mode, kid, epk, recipKeys[…all…], wraps[…] }
 * ```
 *
 * The ephemeral is closed and every intermediate secret is zeroed in a
 * `finally`, including on the throw path — which is the path that gets
 * forgotten.
 *
 * ## Why the wrap reuses [E2eEnvelope]
 *
 * A wrap is AES-256-GCM over 32 bytes of key material with an authenticated
 * context, which is exactly what the envelope already does correctly, including
 * the canonical AAD and the u8 caps. A second, bespoke AEAD here would be a
 * second thing to get wrong. The wrap's `frameType` is the literal
 * `"cc-e2e-wrap"` and its `seq` is 0 — safe because each `KEK_i` is used for
 * exactly ONE wrap and then discarded, so there is no counter to collide with.
 * That is stated rather than assumed because reusing a KEK for a second wrap
 * would be a nonce reuse.
 *
 * ## What this does NOT do
 *
 * It does not pin recipient keys against the DeviceKey registry — that is (e),
 * and per §13.6 its failure mode differs by mode (ON fails closed, OFF fails
 * open with an unverified badge). The pin is a *check* layered on top of this;
 * the seal still only ever goes to keys advertised in the pairing frame.
 */
object E2eAccept {

    /** `frameType` used for a key wrap. Distinct from every real frame type. */
    const val WRAP_FRAME_TYPE = "cc-e2e-wrap"

    /** Bytes of randomness in a `kid`. */
    private const val KID_BYTES = 16

    /** The result of a successful Accept. */
    class Prepared(
        /** The `e2e` block to attach to `ACCEPT_PAIRING`. */
        val block: JsonObject,
        /** The live session. The caller owns it and must [E2eSession.close] it. */
        val session: E2eSession,
        /** The effective mode — whether the SAS is blocking. */
        val modeOn: Boolean,
        /** The SAS digits to show, or null when the mode is OFF (no SAS). */
        val sasDigits: String?,
    )

    /** Thrown when the handshake cannot be completed. The caller must abort. */
    class AcceptException(message: String, cause: Throwable? = null) :
        RuntimeException(message, cause)

    /**
     * Assemble the Accept.
     *
     * @param decision the [E2eNegotiation.Decision.Encrypted] that got us here.
     * @param pairEpoch the epoch for this Accept; must be strictly greater than
     *        the previous one for this pair (§13.8).
     */
    @JvmStatic
    fun prepare(
        ctx: Context,
        decision: E2eNegotiation.Decision.Encrypted,
        pairingId: String,
        userId: String,
        phoneDeviceId: String,
        peerDeviceId: String,
        pairEpoch: Long,
    ): Prepared {
        if (decision.recipients.isEmpty()) {
            throw AcceptException("no recipients to seal to")
        }
        val pairContext = E2eKdf.PairContext(
            pairingId = pairingId,
            userId = userId,
            phoneDeviceId = phoneDeviceId,
            peerDeviceId = peerDeviceId,
            pairEpoch = pairEpoch,
        )

        val phonePub = E2eKeyAgreement.devicePublicSec1(ctx)
        val sk = E2eSessionKey.mint()
        val kid = newKid()

        val wraps = ArrayList<Pair<String, ByteArray>>(decision.recipients.size)
        val ephemeral = E2eKeyAgreement.mintEphemeral()
        try {
            for (r in decision.recipients) {
                var z: ByteArray? = null
                var kek: ByteArray? = null
                try {
                    z = ephemeral.agreeWith(r.publicKey)
                    kek = E2eKdf.deriveKek(z, pairContext, r.publicKey)
                    // One wrap per KEK, seq 0, then the KEK is discarded — see
                    // the class doc on why that is not a nonce reuse.
                    val wrap = E2eEnvelope.seal(
                        key = kek,
                        kid = kid,
                        seq = 0,
                        direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                        pairEpoch = pairEpoch,
                        sessionPrefix = wrapPrefix(r.deviceId),
                        frameType = WRAP_FRAME_TYPE,
                        plaintext = sk,
                    )
                    wraps.add(r.deviceId to wrap.ciphertext)
                } finally {
                    z?.fill(0)
                    kek?.fill(0)
                }
            }

            val block = E2eNegotiation.buildAcceptBlock(
                modeOn = decision.modeOn,
                kid = kid,
                epkSec1 = ephemeral.publicSec1,
                phonePublicSec1 = phonePub,
                recipients = decision.recipients,
                wraps = wraps,
            ) ?: throw AcceptException(
                "the e2e block exceeds ${E2eNegotiation.MAX_BLOCK_BYTES} bytes; the relay " +
                    "would DROP it and the pairing would silently continue in plaintext"
            )

            // The SAS covers the whole static key set plus the epk (§13.3). It
            // is computed here, from the same values that went into the block,
            // so the digits describe exactly the pairing being approved.
            val sas = if (decision.modeOn) {
                E2eSas.digits(
                    pairingId = pairingId,
                    epk = ephemeral.publicSec1,
                    keys = listOf(phonePub) + decision.recipients.map { it.publicKey },
                    pairEpoch = pairEpoch,
                    modeOn = true,
                )
            } else {
                null
            }

            val session = E2eSession.forPhone(
                ctx = ctx,
                sessionKey = sk,
                pairContext = pairContext,
                kid = kid,
                freshEpoch = true, // an Accept always mints a new kid
            )
            return Prepared(block, session, decision.modeOn, sas)
        } finally {
            ephemeral.close()
            sk.fill(0)
        }
    }

    /** A fresh key id: 16 random bytes, base64url. */
    private fun newKid(): String =
        E2eKeyEncoding.toBase64Url(ByteArray(KID_BYTES).also { SecureRandom().nextBytes(it) })

    /**
     * The nonce prefix for a wrap. Derived from the recipient's deviceId so two
     * recipients never share one, though it could not collide anyway: each KEK
     * seals exactly one wrap.
     */
    private fun wrapPrefix(deviceId: String): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(deviceId.toByteArray(Charsets.UTF_8))
            .copyOf(E2eEnvelope.SESSION_PREFIX_BYTES)

    /**
     * Open a wrap addressed to THIS phone. The mirror of [prepare]'s inner loop,
     * used when the computer is the accepting party.
     *
     * @return the session key, or null when the wrap does not authenticate.
     */
    @JvmStatic
    fun openWrap(
        ctx: Context,
        wrap: ByteArray,
        kid: String,
        epkSec1: ByteArray,
        pairContext: E2eKdf.PairContext,
        ourDeviceId: String,
    ): ByteArray? {
        var z: ByteArray? = null
        var kek: ByteArray? = null
        return try {
            val ourPub = E2eKeyAgreement.devicePublicSec1(ctx)
            z = E2eKeyAgreement.agreeWithDeviceKey(ctx, epkSec1)
            kek = E2eKdf.deriveKek(z, pairContext, ourPub)
            E2eEnvelope.open(
                key = kek,
                envelope = E2eEnvelope.Sealed(E2eEnvelope.VERSION, kid, 0, wrap),
                direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairEpoch = pairContext.pairEpoch,
                sessionPrefix = wrapPrefix(ourDeviceId),
                frameType = WRAP_FRAME_TYPE,
            )
        } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
            null
        } catch (e: E2eKeyAgreement.AgreementException) {
            null
        } catch (e: E2eKdf.KdfException) {
            null
        } finally {
            z?.fill(0)
            kek?.fill(0)
        }
    }
}
