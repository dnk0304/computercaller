package com.dnkdialer.companion

/**
 * E2E programme, phase P4 Part 2 (c) — the anti-replay window.
 *
 * E2E-SPEC-v1.0 §13.5, FROZEN:
 *
 *  - Window **1024** frames wide, kept **per (kid, direction)**.
 *  - **Reset on pairEpoch** — a new epoch is a new key, so the old window is
 *    meaningless and keeping it would reject legitimate frames after every
 *    Accept.
 *  - Floor advance **capped at 256** per step, so a forged high sequence number
 *    cannot jump the floor past frames that have not arrived yet.
 *  - **It dedupes, it never rejects.** `frameBuffer` legitimately re-sends
 *    frames on resume; a receiver that treated a duplicate as an attack would
 *    turn every reconnect into a failure. A duplicate is DROPPED, silently and
 *    cheaply, and the connection is untouched.
 *  - The **drop counter is exported** — a silent dropper and a working receiver
 *    are otherwise indistinguishable, which is the failure mode that costs a day.
 *
 * ## The cap is the interesting part
 *
 * Without it, one frame claiming sequence 2^31 slides the floor past every
 * sequence number below it, and every genuine in-flight frame then looks like a
 * replay and is dropped. That is a one-packet denial of service against a
 * "security" control. With the cap, a single frame moves the floor by at most
 * 256, so an attacker needs [MAX_FLOOR_ADVANCE] forged frames to advance the
 * floor by that much — and each one is visible in [droppedTotal] and in the
 * sequence numbers the receiver sees.
 *
 * A sequence far above the window is **accepted**, because the window cannot
 * prove it is a duplicate and §13.5 says dedupe, never reject. It is counted in
 * [beyondWindowTotal] so the case is observable rather than silent.
 *
 * Not thread-safe by construction: one window belongs to one (kid, direction)
 * and is touched only on that direction's receive path. Sharing it across
 * threads would be a bug this class deliberately does not hide with a lock.
 */
class E2eDedupe(
    /** The key id this window belongs to. Part of its identity, never mutated. */
    val kid: String,
    /** Which direction's frames it guards. */
    val direction: Direction,
    /** The pairEpoch it was built for. A different epoch needs a NEW window. */
    val pairEpoch: Long,
    /**
     * GATE1 Addendum A5, MUST M-A5-2 — the SESSION-LIFETIME refusal counter.
     *
     * Injected rather than held as a field of this window, and that is the
     * whole point. A new pairEpoch builds a NEW [E2eDedupe] (see
     * [E2eSession.forPhone]); a counter that lived on the window would be
     * reset by every epoch change. The vector file's `counterRule` is explicit
     * about why that is unacceptable: an epoch change is something an attacker
     * can provoke, and a counter an attacker can zero is not a counter.
     *
     * The default is the process-lifetime instance on [E2eLifecycle], which is
     * the owner that survives epochs. Tests inject their own so that one
     * suite's refusals are not another's.
     */
    private val refusals: ForwardJumpCounter = E2eLifecycle.forwardJumpCounter,
) {

    enum class Direction { PHONE_TO_COMPUTER, COMPUTER_TO_PHONE }

    /**
     * A refusal counter whose lifetime is the PROCESS, not the epoch.
     *
     * Atomic because [E2eDedupe] itself is deliberately single-threaded per
     * (kid, direction) but this counter is shared across every window in the
     * process — two directions can refuse concurrently, and a counter that
     * under-reports during an attack and is exact at rest converts a tamper
     * campaign into an invisible one.
     */
    class ForwardJumpCounter {
        private val n = java.util.concurrent.atomic.AtomicLong(0)

        /** Total forward-jump refusals since process start. Never decreases. */
        val value: Long get() = n.get()

        /** @return the new total, so the log line and the counter cannot disagree. */
        fun note(): Long = n.incrementAndGet()
    }

    /** What the caller must do with the frame. */
    enum class Verdict {
        /** Not seen before. Process it. */
        FRESH,

        /** Seen before, or below the window. DROP it — do not close the socket. */
        DUPLICATE,

        /**
         * GATE1 Addendum A5, MUST M-A5-2. `seq` is more than [WINDOW] above the
         * highest sequence that has AUTHENTICATED in this window, so no honest
         * sender could have produced it: `frameBuffer` resume re-sends at or
         * below the highest sequence already seen.
         *
         * REFUSED is not DUPLICATE and must never be folded into it. The frame
         * is dropped, the floor is NOT advanced, the seq is NOT recorded, and
         * [droppedTotal] is NOT touched — the refusal is counted in
         * [refusedForwardJump] instead. Not recording it is the difference from
         * a drop and it is deliberate: a refused frame must be refused AGAIN if
         * it is replayed, which is exactly what the counter proves.
         */
        REFUSED_FORWARD_JUMP,
    }

    companion object {
        /** Frames the window remembers. §13.5. */
        const val WINDOW = 1024

        /** Maximum the floor may move on any ONE frame. §13.5. */
        const val MAX_FLOOR_ADVANCE = 256

        /** Decrypt failures within [FAILURE_WINDOW_MS] that request a re-pair. */
        const val FAILURE_LIMIT = 3

        /** The window those failures are counted over. §13.5. */
        const val FAILURE_WINDOW_MS = 10_000L

        /**
         * Logcat tag for the refusal line. P6.1b's
         * `scripts/e2e-cross-impl-android.mjs` greps
         * `E2E refusedForwardJump=<n> kid=<kid> dir=<dir>` under this tag.
         */
        private const val TAG = "E2eDedupe"
    }

    /** Lowest sequence number still inside the window. */
    var floor: Long = 0
        private set

    private val seen = java.util.BitSet(WINDOW)

    /** Frames dropped as duplicates. Exported and asserted in the suite. */
    var droppedTotal: Long = 0
        private set

    /** Frames accepted that were beyond the window after a capped advance. */
    var beyondWindowTotal: Long = 0
        private set

    /** Frames accepted as fresh. The denominator for [droppedTotal]. */
    var acceptedTotal: Long = 0
        private set

    /**
     * GATE1 Addendum A5, MUST M-A5-2 — the high-water mark the bound measures
     * a forward jump against.
     *
     * **-1 means UNARMED**, and that is a distinct state rather than "zero
     * minus one". No frame has AUTHENTICATED in this window yet, so there is no
     * honest high-water mark to measure against, and the bound does not fire.
     * A fresh window is the normal state after a resume or a reattach — the
     * receive side is rebuilt from nothing while the peer may legitimately be
     * at seq 90 000 — so arming from 0 would refuse honest traffic. The vector
     * file's `armRule` and case A.
     *
     * It is raised ONLY by a frame whose AEAD tag verified, which on this lane
     * is every frame that reaches [observe] at all (see [E2eSession.open]:
     * AUTHENTICATE FIRST, then dedupe). If a merely well-shaped frame could
     * move it, one forged envelope at seq 2^40 would set the mark and the bound
     * would then admit everything below it — the fix would hand over the very
     * property it exists to protect.
     */
    var highestAccepted: Long = -1
        private set

    /**
     * Forward-jump refusals, SESSION-LIFETIME (see the [refusals] parameter).
     *
     * Distinct from [droppedTotal] and from [beyondWindowTotal] by design: a
     * silent refuser and a working receiver are otherwise indistinguishable,
     * which §13.5 makes the deliverable rather than a nicety.
     */
    val refusedForwardJump: Long get() = refusals.value

    /**
     * Record [seq] and say what to do with the frame. THE receive chokepoint.
     *
     * [authenticates] has no default on purpose. Every call site must state
     * whether this frame's AEAD tag verified, and the compiler — not a code
     * review — is what enforces it. A default of `true` would silently arm the
     * bound from unauthenticated frames the day someone moves the dedupe above
     * the open; a default of `false` would silently never arm it at all, which
     * leaves F2 open while the counter reads a reassuring 0. Both are the class
     * of failure M-A5-2 exists to close, so neither default is offered.
     *
     * On this lane the answer is always `true` in production: [E2eSession.open]
     * authenticates BEFORE it deduplicates (deduping first would let an
     * unauthenticated attacker burn sequence slots in our window). The web and
     * SW lanes admit before they open — to make a replayed frame cost no
     * crypto — and therefore need a SECOND call to raise the mark afterwards
     * (`session.mjs` `confirm`, `sw-session.js` `markAuthenticated`). Here a
     * second call would be a call the receive path could forget, so the flag
     * travels with the one call that already exists.
     *
     * @throws IllegalArgumentException a negative sequence number, which is a
     *         caller bug rather than a wire condition — the wire value is
     *         unsigned and must be range-checked before it gets here.
     */
    fun observe(seq: Long, authenticates: Boolean): Verdict {
        require(seq >= 0) { "sequence number must be non-negative: $seq" }

        // ── M-A5-2 / F2: the forward-jump bound, BEFORE any floor movement ──
        // The order is the whole fix. Checked after the slide, it would be
        // checking a floor the forgery had already moved.
        //
        // ARMED ONLY: an unarmed window (-1) admits by the ordinary rules below
        // and the first AUTHENTICATED frame sets the mark.
        if (highestAccepted >= 0 && seq > highestAccepted + WINDOW) {
            // floor, the BitSet and the mark are ALL left exactly as they were,
            // and seq is NOT recorded: the frame must be refused again if it is
            // replayed. droppedTotal is untouched so the two counts stay
            // readable apart.
            val n = refusals.note()
            android.util.Log.w(TAG, "E2E refusedForwardJump=$n kid=$kid dir=$direction")
            return Verdict.REFUSED_FORWARD_JUMP
        }

        val verdict = classify(seq)

        // Raise the mark only for a frame that authenticated. Doing it after
        // [classify] rather than inside it keeps the one rule in one place, and
        // it is a max, so a duplicate or a below-floor frame is a no-op.
        if (authenticates && seq > highestAccepted) highestAccepted = seq

        return verdict
    }

    /** The frozen §13.5 window rules, unchanged by A5. */
    private fun classify(seq: Long): Verdict {
        if (seq < floor) {
            droppedTotal++
            return Verdict.DUPLICATE
        }

        if (seq >= floor + WINDOW) {
            // Slide, but never further than the cap allows on one frame.
            val wanted = seq - (floor + WINDOW) + 1
            val advance = minOf(wanted, MAX_FLOOR_ADVANCE.toLong())
            slide(advance)
            if (seq >= floor + WINDOW) {
                // Still beyond the window. We cannot prove it is a duplicate,
                // and §13.5 says dedupe rather than reject — so accept it and
                // make the case visible instead of silent.
                beyondWindowTotal++
                acceptedTotal++
                return Verdict.FRESH
            }
        }

        val index = (seq - floor).toInt()
        if (seen.get(index)) {
            droppedTotal++
            return Verdict.DUPLICATE
        }
        seen.set(index)
        acceptedTotal++
        return Verdict.FRESH
    }

    private fun slide(by: Long) {
        if (by <= 0) return
        if (by >= WINDOW) {
            seen.clear()
        } else {
            // Shift the bitset down by `by`: everything below falls out of the
            // window and is thereafter treated as a duplicate by the seq < floor
            // branch, which is the intended behaviour.
            val n = by.toInt()
            for (i in 0 until WINDOW - n) seen.set(i, seen.get(i + n))
            seen.clear(WINDOW - n, WINDOW)
        }
        floor += by
    }

    /** Snapshot for logs and the regression suite. Contains no plaintext. */
    fun stats(): String =
        "kid=$kid dir=$direction epoch=$pairEpoch floor=$floor accepted=$acceptedTotal " +
            "dropped=$droppedTotal beyondWindow=$beyondWindowTotal " +
            "highestAccepted=$highestAccepted refusedForwardJump=$refusedForwardJump"

    /**
     * Tracks decrypt failures. Separate from the window because a decrypt
     * failure is not a replay — §13.5: drop the frame, NEVER close the socket;
     * [FAILURE_LIMIT] failures within [FAILURE_WINDOW_MS] request a re-pair.
     * Never a reconnect loop.
     */
    class FailureTracker(private val now: () -> Long = System::currentTimeMillis) {
        private val times = ArrayDeque<Long>()

        /** @return true when a re-pair should be requested. Never closes anything. */
        fun recordFailure(): Boolean {
            val t = now()
            times.addLast(t)
            while (times.isNotEmpty() && t - times.first() > FAILURE_WINDOW_MS) {
                times.removeFirst()
            }
            return times.size >= FAILURE_LIMIT
        }

        fun reset() = times.clear()

        val recentFailures: Int get() = times.size
    }
}
