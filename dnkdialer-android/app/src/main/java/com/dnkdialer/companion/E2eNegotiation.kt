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

    /**
     * vc67 — what the phone says when the SAS deadline ran out.
     *
     * Deliberately NOT [ABORT_MESSAGE]: nothing failed and nobody refused, the
     * code simply was not confirmed in time, and a user told "couldn't set up
     * encrypted pairing" for their own slow comparison learns that the security
     * prompt is flaky. It also does not offer a one-tap retry — retry-on-
     * refusal is what an attacker needs — it names the next step instead.
     */
    const val SAS_TIMEOUT_MESSAGE = "Code not confirmed — pair again"

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
                latch?.latch(DowngradeLatch.RefusalReason.PEER_OFFERED_NOTHING)
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
     * SET by a genuine downgrade only, and the rule is the pure function
     * [DowngradeLatch.latchesOnRefusal] over [DowngradeLatch.RefusalReason] —
     * every `latch(...)` call site goes through it, so the table is the
     * security property and there is nowhere else to get it wrong.
     *
     * LATCHES: [Decision.Abort] from [E2eSettings.EffectiveMode.ABORT] (local
     * mode ON, peer offered nothing) and a pin [E2eKeyPin.Verdict.Mismatch] —
     * a key the registry actively contradicts. Both are a PEER weakening or
     * substituting into the pair.
     *
     * DOES NOT LATCH: a pin [E2eKeyPin.Verdict.FailClosed] (registry
     * unreachable, or the recipient simply unregistered), an account-id
     * mismatch, and — vc67 — every outcome this device produced: a SAS that
     * timed out, a SAS the user refused, a SAS that never surfaced, malformed
     * digits, and a local crypto failure. Those are faults or answers, not
     * offers. Latching on FailClosed made one missing service-worker row abort
     * every later pairing attempt for the life of the process (INC-0923);
     * latching on TIMED_OUT did the same to anyone who read two screens
     * slowly (vc66 live acceptance).
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

        /**
         * Latch, but only when [latchesOnRefusal] says this refusal is EVIDENCE
         * of a peer weakening the pair. Every call site goes through this door,
         * which is why [latchesOnRefusal] is the whole rule and this is the
         * whole enforcement.
         *
         * @return true when the latch is now set BY THIS CALL.
         */
        fun latch(reason: RefusalReason): Boolean {
            if (!latchesOnRefusal(reason)) return false
            isLatched = true
            return true
        }

        /**
         * Clear the latch. Callers MUST gate this on [clearsLatch] so the
         * "only locally-originated events" rule lives in one testable place
         * rather than in the reader's memory of which frame came from where.
         */
        fun clear() { isLatched = false }

        /**
         * Why a pairing was refused — the input to the one rule that decides
         * whether the DOWNGRADE latch is the right response (vc67, T-SAS-LATCH).
         *
         * ## The rule, in one sentence
         *
         * The latch exists for a PEER that tries to weaken a pair (SPEC 13.1).
         * It is not a general "this pairing failed" flag, and our OWN outcomes
         * must never set it — because the latch lives for the whole process and
         * refuses every later offer, so setting it on an outcome the user (or a
         * clock) produced turns a normal non-answer into an un-pairable phone
         * until the app is force-stopped.
         *
         * ## What the live run showed (live-acceptance-vc66-20260924T1630Z)
         *
         * A SAS left unanswered for 30 s produced `TIMED_OUT` -> `latch()`, and
         * the next Connect 9 s later was refused with "downgrade latch is set
         * for this pair" — for the rest of the process. That is the "fast
         * declines" report, reachable by nothing more hostile than reading two
         * screens slowly.
         *
         * ## Why REFUSED does not latch either (Security ruling, INC-0924)
         *
         * "Doesn't match" IS evidence of interference, so it is tempting. But
         * the correct response to that evidence is to END THE PAIR, not to
         * blind the room: the refused pair is torn down, its session closed and
         * its `kid` dropped, and — because an Accept always mints a fresh `kid`
         * and therefore FRESH DIGITS ([E2eAccept.prepare], `freshEpoch = true`)
         * — the next pairing is a new comparison the user performs again, with
         * a code the refused peer cannot have seen. Latching instead would mean
         * a user who mis-reads one digit, or an attacker who can provoke one
         * refusal, has disabled encrypted pairing on that phone until it is
         * force-stopped. There is no resume path that could carry the refused
         * pair forward: `tearDownE2e` nulls the session, and a reconnect
         * re-Accepts from scratch.
         */
        enum class RefusalReason {
            /**
             * Local mode ON and the peer advertised nothing — the original
             * 13.1 downgrade. LATCHES.
             */
            PEER_OFFERED_NOTHING,

            /**
             * [E2eKeyPin.Verdict.Mismatch]: the registry actively contradicts
             * the advertised key (substituted, wrong kind, REVOKED row). A
             * substitution signature. LATCHES.
             */
            KEY_PIN_MISMATCH,

            /** Nobody answered the SAS inside the deadline. Ours, not theirs. */
            SAS_TIMED_OUT,

            /** The user tapped "Doesn't match". Tear down; do not blind the room. */
            SAS_REFUSED,

            /** The pair ended underneath the prompt, or it never surfaced. */
            SAS_NOT_SHOWN,

            /** Mode ON but the digits were not a 13.3 SAS. A local fault. */
            SAS_MALFORMED,

            /** We could not seal this pairing (Keystore, counter, kid reuse). */
            LOCAL_CRYPTO_FAILURE,
        }

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
             * **The rule.** True only for refusals that are EVIDENCE of a peer
             * weakening or substituting into this pair; false for every outcome
             * this device (or its clock, or its user) produced.
             *
             * Pinned row-by-row by `tests/e2e-sas-latch-vectors.json` in both
             * the Kotlin and the node twin (RULE 30), because the table IS the
             * security property — a reader cannot tell a correct row from an
             * incorrect one by looking at the call site.
             */
            @JvmStatic
            fun latchesOnRefusal(reason: RefusalReason): Boolean = when (reason) {
                RefusalReason.PEER_OFFERED_NOTHING,
                RefusalReason.KEY_PIN_MISMATCH -> true
                RefusalReason.SAS_TIMED_OUT,
                RefusalReason.SAS_REFUSED,
                RefusalReason.SAS_NOT_SHOWN,
                RefusalReason.SAS_MALFORMED,
                RefusalReason.LOCAL_CRYPTO_FAILURE -> false
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
                verdict is E2eKeyPin.Verdict.Mismatch &&
                    latchesOnRefusal(RefusalReason.KEY_PIN_MISMATCH)
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
