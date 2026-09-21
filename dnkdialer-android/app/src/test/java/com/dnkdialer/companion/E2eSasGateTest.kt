package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * P6.1c 1b. The unit half of [E2eSasGate].
 *
 * The claim the brief asks for is `ACCEPT is NOT sent before SAS_RESULT when
 * modeOn`, and it is a claim about ORDER, so these tests record a transcript
 * and assert the sequence rather than asserting a return value and hoping.
 *
 * Plain JVM: nothing above [E2eSasGate]'s "Android binding" heading touches an
 * Android API, deliberately.
 */
class E2eSasGateTest {

    private val pairingId = "pair-1"
    private val digits = "41290"

    /** Thread-safe, because half of these tests answer from another thread. */
    private val transcript: MutableList<String> = Collections.synchronizedList(ArrayList())

    private fun armed(): E2eSasGate.Pending =
        E2eSasGate.Pending(pairingId).also {
            transcript += "ARM"
            it.onClose { transcript += "RELEASE" }
        }

    private fun broadcast(d: String) {
        transcript += "SAS_REQUIRED:$d"
    }

    // --------------------------------------------------------- verdict table

    @Test
    fun `only MATCHED and NOT_REQUIRED may proceed`() {
        assertTrue(E2eSasGate.mayProceed(E2eSasGate.Verdict.MATCHED))
        assertTrue(E2eSasGate.mayProceed(E2eSasGate.Verdict.NOT_REQUIRED))
        // Every one of these must take the EXISTING refusal path.
        assertFalse(E2eSasGate.mayProceed(E2eSasGate.Verdict.REFUSED))
        assertFalse(E2eSasGate.mayProceed(E2eSasGate.Verdict.TIMED_OUT))
        assertFalse(E2eSasGate.mayProceed(E2eSasGate.Verdict.CANCELLED))
        assertFalse(E2eSasGate.mayProceed(E2eSasGate.Verdict.MALFORMED))
    }

    // ------------------------------------------------------- no prompt cases

    @Test
    fun `mode OFF prompts nothing and proceeds — unchanged behaviour`() {
        val v = E2eSasGate.await(
            modeOn = false, digits = digits, timeoutMs = 1,
            arm = { throw AssertionError("must not arm when the mode is off") },
            broadcast = { throw AssertionError("must not prompt when the mode is off") },
        )
        assertEquals(E2eSasGate.Verdict.NOT_REQUIRED, v)
        assertTrue(transcript.isEmpty())
    }

    @Test
    fun `mode ON with no digits REFUSES and never prompts`() {
        val v = E2eSasGate.await(
            modeOn = true, digits = null, timeoutMs = 1,
            arm = { throw AssertionError("must not arm") },
            broadcast = { throw AssertionError("must not prompt") },
        )
        assertEquals(E2eSasGate.Verdict.MALFORMED, v)
        assertFalse(E2eSasGate.mayProceed(v))
    }

    @Test
    fun `mode ON with a malformed payload REFUSES and never prompts`() {
        for (bad in listOf("", "1234", "123456", "4129x", " 4129")) {
            val v = E2eSasGate.await(
                modeOn = true, digits = bad, timeoutMs = 1,
                arm = { throw AssertionError("must not arm for '$bad'") },
                broadcast = { throw AssertionError("must not prompt for '$bad'") },
            )
            assertEquals("payload '$bad'", E2eSasGate.Verdict.MALFORMED, v)
        }
    }

    // -------------------------------------------------------------- ordering

    @Test
    fun `the result receiver is ARMED BEFORE the prompt is broadcast`() {
        E2eSasGate.await(
            modeOn = true, digits = digits, timeoutMs = 1,
            arm = { armed() }, broadcast = { broadcast(it) },
        )
        // Broadcasting first is a real race: MainActivity answers from the
        // main thread and can beat a receiver registered afterwards.
        assertEquals(listOf("ARM", "SAS_REQUIRED:$digits", "RELEASE"), transcript.toList())
    }

    @Test
    fun `the receiver is released even when nobody answers`() {
        val v = E2eSasGate.await(
            modeOn = true, digits = digits, timeoutMs = 1,
            arm = { armed() }, broadcast = { broadcast(it) },
        )
        assertEquals(E2eSasGate.Verdict.TIMED_OUT, v)
        assertTrue(transcript.contains("RELEASE"))
    }

    @Test
    fun `the armed wait is published while it is in flight and cleared after`() {
        val seen = ArrayList<String?>()
        E2eSasGate.await(
            modeOn = true, digits = digits, timeoutMs = 1,
            arm = { armed() }, broadcast = { broadcast(it) },
            onArmed = { seen += it?.pairingId },
        )
        // Published before the prompt so a teardown can cancel it; cleared in
        // the finally so a torn-down service never cancels a stale wait.
        assertEquals(listOf(pairingId, null), seen)
    }

    // ------------------------------------------- THE claim: ACCEPT waits

    @Test
    fun `ACCEPT is not reached until SAS_RESULT arrives`() {
        val armedLatch = CountDownLatch(1)
        val held = arrayOfNulls<E2eSasGate.Pending>(1)
        val done = CountDownLatch(1)

        Thread {
            val v = E2eSasGate.await(
                modeOn = true, digits = digits, timeoutMs = 10_000,
                arm = { armed() },
                broadcast = { broadcast(it) },
                onArmed = { p -> if (p != null) { held[0] = p; armedLatch.countDown() } },
            )
            if (E2eSasGate.mayProceed(v)) transcript += "ACCEPT_PAIRING"
            done.countDown()
        }.start()

        assertTrue(armedLatch.await(5, TimeUnit.SECONDS))
        // Give the worker a moment to get it wrong if it is going to.
        Thread.sleep(150)
        assertTrue("prompt must already be out", transcript.contains("SAS_REQUIRED:$digits"))
        assertFalse(
            "ACCEPT must not be sent before the user answers",
            transcript.contains("ACCEPT_PAIRING"),
        )

        transcript += "SAS_RESULT:true"
        held[0]!!.answer(pairingId, true)
        assertTrue(done.await(5, TimeUnit.SECONDS))

        assertEquals(
            listOf("ARM", "SAS_REQUIRED:$digits", "SAS_RESULT:true", "RELEASE", "ACCEPT_PAIRING"),
            transcript.toList(),
        )
    }

    @Test
    fun `Doesn't match REFUSES, so ACCEPT is never reached`() {
        val armedLatch = CountDownLatch(1)
        val held = arrayOfNulls<E2eSasGate.Pending>(1)
        val done = CountDownLatch(1)

        Thread {
            val v = E2eSasGate.await(
                modeOn = true, digits = digits, timeoutMs = 10_000,
                arm = { armed() }, broadcast = { broadcast(it) },
                onArmed = { p -> if (p != null) { held[0] = p; armedLatch.countDown() } },
            )
            transcript += if (E2eSasGate.mayProceed(v)) "ACCEPT_PAIRING" else "REFUSE:$v"
            done.countDown()
        }.start()

        assertTrue(armedLatch.await(5, TimeUnit.SECONDS))
        held[0]!!.answer(pairingId, false)
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertTrue(transcript.contains("REFUSE:REFUSED"))
        assertFalse(transcript.contains("ACCEPT_PAIRING"))
    }

    // --------------------------------------------------------- Pending rules

    @Test
    fun `an answer for another pairing is ignored`() {
        val p = E2eSasGate.Pending(pairingId)
        assertFalse(p.answer("some-other-pairing", true))
        // Still undecided, so it times out rather than proceeding.
        assertEquals(E2eSasGate.Verdict.TIMED_OUT, p.await(1))
    }

    @Test
    fun `the first answer wins and a later one cannot overrule it`() {
        val p = E2eSasGate.Pending(pairingId)
        assertTrue(p.answer(pairingId, false))
        assertFalse(p.answer(pairingId, true))
        assertEquals(E2eSasGate.Verdict.REFUSED, p.await(1))
    }

    @Test
    fun `cancel refuses, and a late answer cannot revive it`() {
        val p = E2eSasGate.Pending(pairingId)
        assertTrue(p.cancel())
        assertFalse(p.answer(pairingId, true))
        assertEquals(E2eSasGate.Verdict.CANCELLED, p.await(1))
        assertFalse(E2eSasGate.mayProceed(E2eSasGate.Verdict.CANCELLED))
    }

    @Test
    fun `a decided wait cannot be cancelled into a different verdict`() {
        val p = E2eSasGate.Pending(pairingId)
        assertTrue(p.answer(pairingId, true))
        assertFalse(p.cancel())
        assertEquals(E2eSasGate.Verdict.MATCHED, p.await(1))
    }

    @Test
    fun `close is idempotent and releases exactly once`() {
        var releases = 0
        val p = E2eSasGate.Pending(pairingId)
        p.onClose { releases++ }
        p.close()
        p.close()
        assertEquals(1, releases)
    }
}
