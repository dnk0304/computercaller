package com.dnkdialer.companion

import com.google.gson.JsonObject

/**
 * E2E programme, phase P4 Part 2 (d) — negotiation and local mode enforcement
 * at Accept, plus the downgrade latch.
 *
 * ## The wire shapes this parses (P1, merged at `96042d0`, Ken-reviewed)
 *
 * Inbound, inside `PAIRING_REQUEST`:
 * ```
 *   e2e: { v: 1, mode: 0|1, recips: [ { kind: 'web'|'extension', deviceId, pub } ] }
 * ```
 * `pub` is a P-256 uncompressed SEC1 point, 65 bytes, `0x04`-prefixed,
 * base64url. The relay forwards the block VERBATIM and drops it entirely if it
 * exceeds 4 KB — so an absent block can mean "old computer", "kill switch", or
 * "oversized block", and the phone cannot tell which. All three are the same
 * thing to us: **the peer is not offering encryption**, which is
 * [E2eSettings.PeerAdvertisement.ABSENT] and M-B row semantics.
 *
 * Outbound, inside `ACCEPT_PAIRING`:
 * ```
 *   e2e: { v: 1, mode, kid, epk, recipKeys: [ …all static pubkeys incl. the SW… ],
 *          wraps: [ { deviceId, wrap } ] }
 * ```
 *
 * **`v: 1` is mandatory on both.** P1 drops a block with no `v` to plaintext, so
 * omitting it silently downgrades the pairing — the failure looks like "the
 * computer doesn't support encryption" and nothing logs an error.
 *
 * ## The enforcement rule (§13.1 C-1, matrix rows 3/5 and 8–10)
 *
 * Enforcement is **local and at Accept**, using only state this device holds.
 * The relay's downgrade refusal and the DeviceKey pin are defence in depth — if
 * enforcement depended on the relay, a hostile relay could turn it off.
 *
 * - Local mode ON + peer block absent or non-encrypting → **ABORT**. Never a
 *   silent downgrade: a device that asked for verification must never get less
 *   than it asked for.
 * - Local mode OFF + peer absent → plaintext, `Unencrypted` badge.
 * - Either side ON → effective ON, SAS blocking on both (the OR of §13.1).
 *
 * ## The downgrade latch
 *
 * [DowngradeLatch] remembers, for the life of a pair, that this pairing was ever
 * refused for a downgrade. A peer that is told "no" and then retries with a
 * weaker offer must not be able to walk the pair down by attrition — which is
 * exactly what an attacker with relay access would try, because each individual
 * refusal looks like a transient failure to the user.
 *
 * Pure logic: no Context, no socket, no crypto. Everything here is unit-tested
 * on the JVM, and [PhoneService] does nothing but call it and act on the result.
 */
object E2eNegotiation {

    /** The `v` every block must carry. A block without it is dropped to plaintext by P1. */
    const val BLOCK_VERSION = 1

    /** The relay drops an `e2e` block larger than this; mirrored so we never build one. */
    const val MAX_BLOCK_BYTES = 4096

    /** Recipient kinds P1's schema allows. `phone` is us and never a recipient. */
    val RECIPIENT_KINDS = setOf("web", "extension")

    /** One recipient advertised by the computer. */
    data class Recipient(val kind: String, val deviceId: String, val publicKey: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is Recipient && kind == other.kind && deviceId == other.deviceId &&
                publicKey.contentEquals(other.publicKey)

        override fun hashCode(): Int =
            (kind.hashCode() * 31 + deviceId.hashCode()) * 31 + publicKey.contentHashCode()
    }

    /** What the computer offered, after parsing. */
    data class PeerOffer(
        val advertisement: E2eSettings.PeerAdvertisement,
        val recipients: List<Recipient>,
        /** Why the block was treated as ABSENT, for logs. Null when it parsed. */
        val absentReason: String? = null,
    )

    /** What to do with this Accept. */
    sealed interface Decision {
        /**
         * Complete the pairing sealed. [modeOn] is the EFFECTIVE mode (the OR),
         * and therefore whether the SAS is blocking.
         */
        data class Encrypted(
            val modeOn: Boolean,
            val recipients: List<Recipient>,
        ) : Decision

        /** Complete the pairing in the clear. Badge: Unencrypted. */
        data object Plaintext : Decision

        /**
         * Refuse. [userMessage] is the exact copy the brief specifies; it is
         * deliberately not a technical description, because the user cannot act
         * on "the peer advertised mode 0".
         */
        data class Abort(val userMessage: String, val logReason: String) : Decision
    }

    /** The copy shown when a mode-ON device cannot get an encrypted pairing. */
    const val ABORT_MESSAGE = "Couldn't set up encrypted pairing — try again"

    // ------------------------------------------------------------- parsing

    /**
     * Parse the `e2e` block out of a PAIRING_REQUEST payload.
     *
     * Never throws. Every malformed shape degrades to ABSENT with a reason,
     * because a parse failure and an old computer are indistinguishable from
     * here and both mean "no encryption on offer" — and a crash in the pairing
     * path would be a denial of service triggerable by any relay.
     */
    @JvmStatic
    fun parsePeerOffer(block: JsonObject?): PeerOffer {
        if (block == null) return absent("no e2e block (old computer, kill switch, or >4KB)")

        val v = runCatching { block.get("v")?.asInt }.getOrNull()
        if (v == null) return absent("e2e block has no v")
        if (v != BLOCK_VERSION) return absent("e2e block is v$v, this build speaks v$BLOCK_VERSION")

        val mode = runCatching { block.get("mode")?.asInt }.getOrNull()
        if (mode == null || (mode != 0 && mode != 1)) {
            return absent("e2e block has no usable mode")
        }

        val recipsJson = runCatching { block.getAsJsonArray("recips") }.getOrNull()
        if (recipsJson == null || recipsJson.size() == 0) {
            return absent("e2e block has no recipients")
        }

        val recipients = ArrayList<Recipient>(recipsJson.size())
        for (e in recipsJson) {
            val o = runCatching { e.asJsonObject }.getOrNull()
                ?: return absent("a recipient is not an object")
            val kind = runCatching { o.get("kind")?.asString }.getOrNull()
            val deviceId = runCatching { o.get("deviceId")?.asString }.getOrNull()
            val pub = runCatching { o.get("pub")?.asString }.getOrNull()
            if (kind == null || deviceId == null || pub == null) {
                return absent("a recipient is missing kind/deviceId/pub")
            }
            if (kind !in RECIPIENT_KINDS) return absent("unknown recipient kind '$kind'")

            // Decode and VALIDATE the point here, not later. A recipient we
            // cannot seal to is not a recipient, and an invalid point must never
            // reach KeyAgreement (invalid-curve attack).
            val bytes = runCatching { E2eKeyEncoding.fromBase64Url(pub) }.getOrNull()
                ?: return absent("recipient $deviceId has a non-base64url pub")
            if (!E2eKeyEncoding.isValid(bytes)) {
                return absent("recipient $deviceId has an invalid P-256 point")
            }
            recipients.add(Recipient(kind, deviceId, bytes))
        }

        if (recipients.map { it.deviceId }.toSet().size != recipients.size) {
            return absent("duplicate recipient deviceId")
        }

        return PeerOffer(
            advertisement = if (mode == 1) {
                E2eSettings.PeerAdvertisement.ON
            } else {
                E2eSettings.PeerAdvertisement.OFF
            },
            recipients = recipients,
        )
    }

    private fun absent(reason: String) =
        PeerOffer(E2eSettings.PeerAdvertisement.ABSENT, emptyList(), reason)

    // ------------------------------------------------------------ decision

    /**
     * The Accept-time decision. [localEnabled] is this device's own stored
     * setting (C-1: local truth, never read back from the server).
     */
    @JvmStatic
    fun decide(
        localEnabled: Boolean,
        offer: PeerOffer,
        latch: DowngradeLatch? = null,
    ): Decision {
        // The latch outranks everything: once this pair has been refused for a
        // downgrade, a later weaker offer is not a fresh negotiation, it is the
        // second step of the same attack.
        if (latch?.isLatched == true && offer.advertisement != E2eSettings.PeerAdvertisement.ON) {
            return Decision.Abort(
                ABORT_MESSAGE,
                "downgrade latch is set for this pair; refusing a non-encrypting offer"
            )
        }

        return when (E2eSettings.effectiveMode(localEnabled, offer.advertisement)) {
            E2eSettings.EffectiveMode.ABORT -> {
                latch?.latch()
                Decision.Abort(
                    ABORT_MESSAGE,
                    "local mode ON but peer offered nothing: ${offer.absentReason ?: "absent"}"
                )
            }

            E2eSettings.EffectiveMode.PLAINTEXT -> Decision.Plaintext

            // Both sealed cases; the OR decides only whether the SAS blocks.
            E2eSettings.EffectiveMode.ENCRYPTED_VERIFIED -> Decision.Encrypted(
                modeOn = true, recipients = offer.recipients
            )

            E2eSettings.EffectiveMode.ENCRYPTED_UNVERIFIED -> Decision.Encrypted(
                modeOn = false, recipients = offer.recipients
            )
        }
    }

    /**
     * Remembers that a pair was refused for a downgrade, for the life of the
     * pair. In-memory by design: the latch protects one pairing attempt series,
     * and a fresh Accept after a genuine Reset is a new pair.
     *
     * ## What may set it, and what may clear it (INC-0923)
     *
     * SET by a genuine downgrade only: [Decision.Abort] from
     * [E2eSettings.EffectiveMode.ABORT] (local mode ON, peer offered nothing),
     * a SAS the user refused, and a pin [E2eKeyPin.Verdict.Mismatch] — a key
     * the registry actively contradicts. It is NOT set by a pin
     * [E2eKeyPin.Verdict.FailClosed] (registry unreachable, or the recipient
     * simply unregistered) or by an account-id mismatch: those are faults, not
     * offers, and latching on them made one missing service-worker row abort
     * every later pairing attempt for the life of the process.
     *
     * CLEARED only by events this device originates: the user disconnecting
     * from the lobby, and a service restart. Never by a relay-delivered frame
     * (RESET_ROOM, PAIRING_TERMINATED) or a socket flap — a peer that can make
     * the pair end could otherwise clear the latch at will, which is the whole
     * attack the latch exists to stop.
     */
    class DowngradeLatch {
        var isLatched: Boolean = false
            private set

        fun latch() { isLatched = true }

        /**
         * Clear the latch. Callers MUST gate this on [clearsLatch] so the
         * "only locally-originated events" rule lives in one testable place
         * rather than in the reader's memory of which frame came from where.
         */
        fun clear() { isLatched = false }

        /** The events that may end a latched pair. */
        enum class Event {
            /** The user tapped Disconnect on THIS device. */
            LOCAL_USER_DISCONNECT,

            /** The service was (re)created — a genuine app restart. */
            SERVICE_RESTART,

            /** `RESET_ROOM`, delivered by the relay. */
            RELAY_RESET_ROOM,

            /** `PAIRING_TERMINATED`, delivered by the relay. */
            RELAY_PAIRING_TERMINATED,

            /** The relay socket dropped and reconnected. */
            SOCKET_FLAP,
        }

        companion object {
            /**
             * True only for events this device originated.
             *
             * A relay-delivered frame must never clear the latch: the peer that
             * set it could then clear it at will, which is the second half of
             * the downgrade attack the latch exists to stop. A socket flap is
             * weaker still — it is not even an intentional act.
             */
            @JvmStatic
            fun clearsLatch(event: Event): Boolean = when (event) {
                Event.LOCAL_USER_DISCONNECT, Event.SERVICE_RESTART -> true
                Event.RELAY_RESET_ROOM,
                Event.RELAY_PAIRING_TERMINATED,
                Event.SOCKET_FLAP -> false
            }

            /**
             * True only for a pin verdict that is EVIDENCE, not a fault.
             *
             * [E2eKeyPin.Verdict.Mismatch] means the registry actively
             * contradicts the advertised key (substituted, wrong kind, or a
             * REVOKED row) — an attack signature. [E2eKeyPin.Verdict.FailClosed]
             * means the registry said nothing (unreachable, or the recipient is
             * unregistered): INC-0923 showed that latching on it turned one
             * missing service-worker row into a permanently un-pairable phone,
             * because the latch lives for the whole process.
             */
            @JvmStatic
            fun latchesOn(verdict: E2eKeyPin.Verdict): Boolean =
                verdict is E2eKeyPin.Verdict.Mismatch
        }
    }

    // ------------------------------------------------------- accept block

    /**
     * Build the `e2e` block for `ACCEPT_PAIRING`.
     *
     * `recipKeys` is the FULL static key set — the phone plus every recipient —
     * because the SAS transcript (§13.3) covers the whole set and no party can
     * compute the digits without it. Narrowing it would DISABLE verification
     * rather than harden it.
     *
     * @return the block, or null when it would exceed [MAX_BLOCK_BYTES] — the
     *         relay would drop an oversized block and the pairing would silently
     *         continue in plaintext, so the caller must abort instead.
     */
    @JvmStatic
    fun buildAcceptBlock(
        modeOn: Boolean,
        kid: String,
        epkSec1: ByteArray,
        phonePublicSec1: ByteArray,
        recipients: List<Recipient>,
        wraps: List<Pair<String, ByteArray>>,
    ): JsonObject? {
        val block = JsonObject()
        block.addProperty("v", BLOCK_VERSION)
        block.addProperty("mode", if (modeOn) 1 else 0)
        block.addProperty("kid", kid)
        block.addProperty("epk", E2eKeyEncoding.toBase64Url(epkSec1))

        // The full set, deduplicated and canonically ordered so both sides
        // compute the same SAS transcript regardless of learning order.
        val all = E2eSas.canonicalKeySet(listOf(phonePublicSec1) + recipients.map { it.publicKey })
        val keys = com.google.gson.JsonArray()
        for (k in all) keys.add(E2eKeyEncoding.toBase64Url(k))
        block.add("recipKeys", keys)

        val wrapArray = com.google.gson.JsonArray()
        for ((deviceId, wrap) in wraps) {
            val w = JsonObject()
            w.addProperty("deviceId", deviceId)
            w.addProperty("wrap", E2eKeyEncoding.toBase64Url(wrap))
            wrapArray.add(w)
        }
        block.add("wraps", wrapArray)

        // The relay silently DROPS a block over 4 KB and lets the pairing
        // continue in plaintext. Refusing to build one is how a mode-ON pairing
        // fails loudly instead of quietly becoming unencrypted.
        if (block.toString().toByteArray(Charsets.UTF_8).size > MAX_BLOCK_BYTES) return null
        return block
    }
}
