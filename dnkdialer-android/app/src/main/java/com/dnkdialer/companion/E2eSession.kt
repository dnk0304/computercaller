package com.dnkdialer.companion

import android.content.Context

/**
 * E2E programme, phase P4 Part 2 (c2) — the only sealing API production code
 * may use.
 *
 * GATE1 Addendum A1, item 2, mandatory consequence for implementers:
 *
 * > each side holds exactly one *send* key and one *receive* key and MUST NOT
 * > be able to name the other — no "get the key for this direction" helper that
 * > can be called with the wrong argument. **Directional separation enforced by
 * > a naming convention is directional separation that will be violated.**
 *
 * So this class exposes [seal] and [open] and nothing else. There is no
 * `keyFor(direction)`, no public `sendKey`, and no way to pass a direction in.
 * On the phone, send is always `p2c` and receive is always `c2p`; those two
 * facts are baked in at [forPhone] and are not parameters anywhere afterwards.
 *
 * It also owns the two things a caller must not be trusted to do by hand:
 *  - the sequence number, which comes from [E2eSeqStore] (persist-before-emit,
 *    fail closed — A1 item 3);
 *  - the replay window, which is [E2eDedupe] per §13.5.
 *
 * ## Lifecycle
 *
 * One session per (pair, kid). [forPhone] is called at Accept. A new Accept
 * mints a new SK and a new kid, and therefore a NEW session — never a reset of
 * this one, because a reset is indistinguishable at the type level from
 * resuming, and resuming a counter is the failure A1 spends a page on.
 *
 * [close] zeroes both keys (§13.8: SK dropped on Reset, sign-out, LEAVE_ACTIVE).
 */
class E2eSession private constructor(
    /** The key id both sides name this session by. */
    val kid: String,
    /** The epoch this session belongs to. Bumped at every Accept (§13.8). */
    val pairEpoch: Long,
    private val sendKey: ByteArray,
    private val recvKey: ByteArray,
    private val sendDirection: E2eEnvelope.Direction,
    private val recvDirection: E2eEnvelope.Direction,
    private val seq: E2eSeqStore,
    /**
     * The peer's nonce prefix, derived from the same session key. Held here so
     * no caller has to supply it — a caller that could pass the wrong prefix
     * would see every inbound frame fail to authenticate.
     */
    private val peerNoncePrefix: ByteArray,
    private val inbound: E2eDedupe,
) : AutoCloseable {

    /** Frames dropped as replays or duplicates. Exported per §13.5. */
    val droppedFrames: Long get() = inbound.droppedTotal

    /**
     * This device's outbound nonce prefix. Exposed for the (g) harness and for
     * tests that play the peer; production code never needs it, because [seal]
     * already applies it.
     */
    val sendNoncePrefix: ByteArray get() = seq.sessionPrefix.copyOf()

    /** Decrypt failures are tracked here; §13.5's 3-in-10s re-pair request. */
    private val failures = E2eDedupe.FailureTracker()

    /** What [open] decided. Never an exception — §13.5 says drop, never close. */
    sealed interface Opened {
        /** Use it. */
        data class Frame(val plaintext: ByteArray) : Opened

        /** Already seen. Drop it silently; a resume legitimately re-sends. */
        data object Duplicate : Opened

        /**
         * Did not authenticate, or malformed. Drop the frame and NEVER close
         * the socket. [requestRepair] is true once §13.5's 3-failures-in-10s
         * threshold trips.
         */
        data class Undecryptable(val requestRepair: Boolean) : Opened
    }

    companion object {

        /**
         * GATE1 Addendum A2 MUST (1) — **`kid` ↔ `SK` is strictly 1:1**, and it
         * is enforced here rather than left to convention.
         *
         * A2's reasoning, because the consequence is total: `pairContext` does
         * NOT bind `kid`, so `k_p2c`, `k_c2p`, `np2c` and `nc2p` are scoped to
         * `(pairing, pairEpoch, direction)`, while A1 scopes the *counter* to
         * `(kid, direction)`. Those two scopes coincide only while one `kid`
         * names exactly one `SK`. Mint a second `kid` under the same `SK` and
         * its counter restarts at 0 against the same key and the same derived
         * prefix — a GCM nonce reuse, which forfeits confidentiality for both
         * frames and hands over the GHASH key, i.e. forgery for every other
         * frame under that key.
         *
         * [E2eSession] is the one place an `SK` and a `kid` meet to produce
         * traffic keys, so the check lives here and cannot be routed around by
         * a caller that mints its own id.
         *
         * Only a digest of the SK is retained — never the key itself, and the
         * map is process-lifetime only, which is sufficient: an SK never
         * survives a process (it is minted at Accept, held in memory, and
         * zeroed by [close]), so an SK reaching a second process is not a
         * scenario this can or should try to police.
         */
        private val kidBySessionKey = HashMap<String, String>()

        /** Thrown when a second, different `kid` is offered for one `SK`. */
        class KidReuseException(message: String) : RuntimeException(message)

        @Synchronized
        private fun bindKidToSessionKey(sessionKey: ByteArray, kid: String) {
            val digest = E2eKdf.toHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(sessionKey)
            )
            val existing = kidBySessionKey[digest]
            if (existing != null && existing != kid) {
                throw KidReuseException(
                    "A2 MUST (1): this session key is already bound to kid=$existing; " +
                        "refusing to mint kid=$kid under it — a second kid under one SK " +
                        "restarts the counter against the same key and reuses a GCM nonce"
                )
            }
            kidBySessionKey[digest] = kid
        }

        /** Test seam: forget the process-lifetime bindings. */
        @JvmStatic
        @androidx.annotation.VisibleForTesting
        @Synchronized
        fun clearKidBindingsForTest() = kidBySessionKey.clear()

        /**
         * Build the phone's session at Accept.
         *
         * @param freshEpoch true when this Accept minted a NEW kid. Only then
         *        may the counter legitimately start at 0 — see [E2eSeqStore].
         * @throws E2eSeqStore.CounterUnsafeException the counter cannot be
         *         proved safe. The caller MUST abandon the pairing and force a
         *         rekey rather than sealing anything.
         */
        @JvmStatic
        fun forPhone(
            ctx: Context,
            sessionKey: ByteArray,
            pairContext: E2eKdf.PairContext,
            kid: String,
            freshEpoch: Boolean,
        ): E2eSession {
            // A2 MUST (1), checked BEFORE any key is derived: a refused binding
            // must leave no derived material behind.
            bindKidToSessionKey(sessionKey, kid)
            val keys = E2eKdf.deriveTrafficKeys(sessionKey, pairContext)
            val prefixes = E2eKdf.deriveNoncePrefixes(sessionKey, pairContext)
            // The phone SENDS p2c and RECEIVES c2p. Fixed here, once. Nothing
            // downstream takes a direction argument.
            val send = E2eEnvelope.Direction.PHONE_TO_COMPUTER
            val recv = E2eEnvelope.Direction.COMPUTER_TO_PHONE
            return E2eSession(
                kid = kid,
                pairEpoch = pairContext.pairEpoch,
                sendKey = keys.phoneToComputer,
                recvKey = keys.computerToPhone,
                sendDirection = send,
                recvDirection = recv,
                seq = E2eSeqStore.open(ctx, kid, send, freshEpoch, prefixes.phoneToComputer),
                peerNoncePrefix = prefixes.computerToPhone,
                inbound = E2eDedupe(kid, E2eDedupe.Direction.COMPUTER_TO_PHONE, pairContext.pairEpoch),
            )
        }
    }

    /**
     * Seal an outbound frame.
     *
     * The sequence is reserved durably before the sealed frame is returned, so
     * a frame can never leave the device under an unrecorded sequence. If the
     * counter cannot be proved safe this THROWS rather than returning something
     * sendable — a failure to seal must be loud, unlike a failure to open.
     */
    fun seal(frameType: String, plaintext: ByteArray): E2eEnvelope.Sealed {
        val s = seq.reserve()
        return E2eEnvelope.seal(
            key = sendKey,
            kid = kid,
            seq = s,
            direction = sendDirection,
            pairEpoch = pairEpoch,
            sessionPrefix = seq.sessionPrefix,
            frameType = frameType,
            plaintext = plaintext,
        )
    }

    /**
     * Open an inbound frame and run it through the replay window.
     *
     * Order matters: AUTHENTICATE FIRST, then dedupe. Deduping first would let
     * an unauthenticated attacker burn sequence slots in our window and cause
     * genuine frames to be dropped as duplicates — a denial of service that
     * costs the attacker one forged frame.
     */
    fun open(envelope: E2eEnvelope.Sealed, frameType: String): Opened {
        if (envelope.kid != kid) return Opened.Undecryptable(failures.recordFailure())
        val plaintext = E2eEnvelope.open(
            key = recvKey,
            envelope = envelope,
            direction = recvDirection,
            pairEpoch = pairEpoch,
            sessionPrefix = peerNoncePrefix,
            frameType = frameType,
        ) ?: return Opened.Undecryptable(failures.recordFailure())

        failures.reset()
        return when (inbound.observe(envelope.seq)) {
            E2eDedupe.Verdict.FRESH -> Opened.Frame(plaintext)
            E2eDedupe.Verdict.DUPLICATE -> Opened.Duplicate
        }
    }

    /** §13.8: SK dropped on Reset / sign-out / LEAVE_ACTIVE. */
    override fun close() {
        sendKey.fill(0)
        recvKey.fill(0)
    }

    /** Diagnostics. Contains no plaintext and no key material. */
    fun stats(): String =
        "kid=$kid epoch=$pairEpoch nextSeq=${seq.nextSequence} hwm=${seq.highWaterMark} " +
            inbound.stats()
}
