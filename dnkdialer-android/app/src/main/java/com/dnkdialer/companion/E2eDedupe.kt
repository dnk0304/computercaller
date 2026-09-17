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
) {

    enum class Direction { PHONE_TO_COMPUTER, COMPUTER_TO_PHONE }

    /** What the caller must do with the frame. */
    enum class Verdict {
        /** Not seen before. Process it. */
        FRESH,

        /** Seen before, or below the window. DROP it — do not close the socket. */
        DUPLICATE,
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
     * Record [seq] and say what to do with the frame.
     *
     * @throws IllegalArgumentException a negative sequence number, which is a
     *         caller bug rather than a wire condition — the wire value is
     *         unsigned and must be range-checked before it gets here.
     */
    fun observe(seq: Long): Verdict {
        require(seq >= 0) { "sequence number must be non-negative: $seq" }

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
            "dropped=$droppedTotal beyondWindow=$beyondWindowTotal"

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
