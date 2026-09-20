package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E P4 Part 2 (c) — the anti-replay window, against E2E-SPEC §13.5.
 *
 * The scenario the brief names explicitly is [replaying_1000_buffered_frames_drops_no_legitimate_frame]:
 * `frameBuffer` re-sends on every resume, so a window that treated a re-send as
 * an attack would turn every reconnect into a failure. That test is the reason
 * this class exists in the shape it does.
 */
class E2eDedupeTest {

    private fun window(epoch: Long = 1) =
        E2eDedupe("kid-1", E2eDedupe.Direction.COMPUTER_TO_PHONE, epoch, E2eDedupe.ForwardJumpCounter())

    @Test
    fun `fresh sequences are accepted and exact duplicates dropped`() {
        val w = window()
        for (s in 0L until 100L) assertEquals(E2eDedupe.Verdict.FRESH, w.observe(s, authenticates = true))
        assertEquals(100, w.acceptedTotal)
        assertEquals(0, w.droppedTotal)

        for (s in 0L until 100L) assertEquals(E2eDedupe.Verdict.DUPLICATE, w.observe(s, authenticates = true))
        assertEquals("the drop counter must be exported and must move", 100, w.droppedTotal)
        assertEquals("no extra accepts", 100, w.acceptedTotal)
    }

    @Test
    fun `out of order delivery inside the window is fine`() {
        val w = window()
        val order = (0L until 1024L).shuffled(java.util.Random(7).let { r ->
            kotlin.random.Random(r.nextLong())
        })
        for (s in order) assertEquals(E2eDedupe.Verdict.FRESH, w.observe(s, authenticates = true))
        assertEquals(1024, w.acceptedTotal)
        assertEquals(0, w.droppedTotal)
        // Every one of them is now a duplicate.
        for (s in order) assertEquals(E2eDedupe.Verdict.DUPLICATE, w.observe(s, authenticates = true))
        assertEquals(1024, w.droppedTotal)
    }

    /**
     * The brief's scenario (g): a resume re-sends up to 1,000 buffered frames.
     * ZERO legitimate frames may be dropped, and every re-send must be dropped.
     */
    @Test
    fun replaying_1000_buffered_frames_drops_no_legitimate_frame() {
        val w = window()
        var legitimateDrops = 0
        for (s in 0L until 1000L) {
            if (w.observe(s, authenticates = true) != E2eDedupe.Verdict.FRESH) legitimateDrops++
        }
        assertEquals("a legitimate first delivery was dropped", 0, legitimateDrops)

        // The resume re-sends the same 1,000 frames.
        var resendAccepted = 0
        for (s in 0L until 1000L) {
            if (w.observe(s, authenticates = true) == E2eDedupe.Verdict.FRESH) resendAccepted++
        }
        assertEquals("a re-sent frame was processed twice", 0, resendAccepted)
        assertEquals(1000, w.acceptedTotal)
        assertEquals(1000, w.droppedTotal)
    }

    /**
     * The cap is the control that stops a one-packet denial of service. Without
     * it, a single forged sequence of 2^31 slides the floor past every genuine
     * in-flight frame and they all then look like replays.
     */
    @Test
    fun `a forged high sequence cannot jump the floor past pending frames`() {
        val w = window()
        assertEquals(0, w.floor)

        // One frame claiming an absurd sequence.
        assertEquals(E2eDedupe.Verdict.FRESH, w.observe(Long.MAX_VALUE / 2, authenticates = true))
        assertEquals(
            "the floor moved by more than the cap on a single frame",
            E2eDedupe.MAX_FLOOR_ADVANCE.toLong(),
            w.floor
        )
        assertEquals("the case must be observable, not silent", 1, w.beyondWindowTotal)

        // Frames at or above the new floor still arrive normally.
        var accepted = 0
        for (s in w.floor until w.floor + 500) {
            if (w.observe(s, authenticates = true) == E2eDedupe.Verdict.FRESH) accepted++
        }
        assertEquals("genuine frames above the floor must still be accepted", 500, accepted)

        // Repeating the forgery advances only 256 at a time, so an attacker
        // needs one frame per 256 and every one is counted.
        val before = w.floor
        w.observe(Long.MAX_VALUE / 2, authenticates = true)
        assertEquals(before + E2eDedupe.MAX_FLOOR_ADVANCE, w.floor)
    }

    @Test
    fun `sliding retains membership for sequences still inside the window`() {
        val w = window()
        w.observe(10, authenticates = true)
        w.observe(300, authenticates = true)
        // Push the floor forward by exactly the cap.
        w.observe(E2eDedupe.WINDOW + E2eDedupe.MAX_FLOOR_ADVANCE - 1L, authenticates = true)
        assertEquals(E2eDedupe.MAX_FLOOR_ADVANCE.toLong(), w.floor)

        // 10 has fallen BELOW the floor -> duplicate by position.
        assertEquals(E2eDedupe.Verdict.DUPLICATE, w.observe(10, authenticates = true))
        // 300 is still inside the window and must still be remembered — this is
        // the assertion a bitset shifted the wrong way fails.
        assertEquals(E2eDedupe.Verdict.DUPLICATE, w.observe(300, authenticates = true))
        // A never-seen sequence inside the window is still fresh: the test is
        // not passing because everything became a duplicate.
        assertEquals(E2eDedupe.Verdict.FRESH, w.observe(301, authenticates = true))
    }

    @Test
    fun `a new epoch means a new window not a reset one`() {
        val a = window(epoch = 1)
        for (s in 0L until 50L) a.observe(s, authenticates = true)
        assertEquals(50, a.acceptedTotal)

        // §13.8: Accept mints a fresh SK and bumps the epoch; §13.5: the window
        // resets. Modelled as a NEW object rather than a reset() method, so a
        // window can never outlive the key it belongs to.
        val b = window(epoch = 2)
        assertEquals(2, b.pairEpoch)
        assertEquals(0, b.floor)
        var accepted = 0
        for (s in 0L until 50L) if (b.observe(s, authenticates = true) == E2eDedupe.Verdict.FRESH) accepted++
        assertEquals(
            "after an Accept the same sequence numbers must be legitimate again",
            50, accepted
        )
    }

    @Test
    fun `windows are independent per kid and direction`() {
        val p2c = E2eDedupe("kid-1", E2eDedupe.Direction.PHONE_TO_COMPUTER, 1, E2eDedupe.ForwardJumpCounter())
        val c2p = E2eDedupe("kid-1", E2eDedupe.Direction.COMPUTER_TO_PHONE, 1, E2eDedupe.ForwardJumpCounter())
        val other = E2eDedupe("kid-2", E2eDedupe.Direction.COMPUTER_TO_PHONE, 1, E2eDedupe.ForwardJumpCounter())
        for (s in 0L until 20L) p2c.observe(s, authenticates = true)
        for (s in 0L until 20L) {
            assertEquals("directions must not share a window",
                E2eDedupe.Verdict.FRESH, c2p.observe(s, authenticates = true))
            assertEquals("key ids must not share a window",
                E2eDedupe.Verdict.FRESH, other.observe(s, authenticates = true))
        }
    }

    @Test
    fun `a negative sequence is a caller bug`() {
        val w = window()
        try {
            w.observe(-1, authenticates = true)
            org.junit.Assert.fail("accepted a negative sequence")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("non-negative"))
        }
    }

    @Test
    fun `stats carry no plaintext and do carry the counters`() {
        val w = window()
        w.observe(0, authenticates = true); w.observe(0, authenticates = true)
        val s = w.stats()
        assertTrue(s, s.contains("dropped=1"))
        assertTrue(s, s.contains("accepted=1"))
        assertTrue(s, s.contains("kid=kid-1"))
    }

    // ------------------------------------------------- decrypt failures

    @Test
    fun `three decrypt failures in ten seconds request a re-pair`() {
        var now = 1_000_000L
        val t = E2eDedupe.FailureTracker { now }
        assertTrue(!t.recordFailure())
        assertTrue(!t.recordFailure())
        assertTrue("the third failure within the window must trip", t.recordFailure())
    }

    @Test
    fun `failures outside the window do not accumulate into a re-pair`() {
        var now = 1_000_000L
        val t = E2eDedupe.FailureTracker { now }
        t.recordFailure()
        now += E2eDedupe.FAILURE_WINDOW_MS + 1
        t.recordFailure()
        now += E2eDedupe.FAILURE_WINDOW_MS + 1
        assertTrue(
            "three failures spread over 30s must NOT request a re-pair — that would " +
                "be a reconnect loop on a flaky link",
            !t.recordFailure()
        )
        assertEquals(1, t.recentFailures)
    }
}
