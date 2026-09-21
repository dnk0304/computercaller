package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * P6.1c 1b — [E2eSasGate] driven by REAL broadcasts, which is the half the
 * unit suite cannot reach.
 *
 * This stands in for MainActivity: it listens for
 * [E2eSasContract.ACTION_E2E_SAS_REQUIRED] exactly as
 * `pairingForegroundReceiver` does, and answers with
 * [E2eSasContract.ACTION_E2E_SAS_RESULT] exactly as `dispatchSasVerdict` does.
 * If the gate's filter, extras or `setPackage` are wrong, these fail — and
 * P6.1b Part B's finding A6-P61B-3 was precisely that nobody had ever put
 * these two actions end to end.
 */
@RunWith(AndroidJUnit4::class)
class E2eSasGateBroadcastTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairingId = "pair-instr-1"
    private val digits = "41290"

    /** Set when the fake UI sees the prompt; carries what it was given. */
    private val prompted = CountDownLatch(1)
    @Volatile private var promptedId: String? = null
    @Volatile private var promptedDigits: String? = null

    /** Answered from the fake UI when non-null. */
    @Volatile private var answerWith: Boolean? = null

    private lateinit var fakeUi: BroadcastReceiver

    @Before
    fun listen() {
        fakeUi = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                if (i?.action != E2eSasContract.ACTION_E2E_SAS_REQUIRED) return
                promptedId = i.getStringExtra(PhoneService.EXTRA_PAIRING_ID)
                promptedDigits = i.getStringExtra(E2eSasContract.EXTRA_SAS_DIGITS)
                prompted.countDown()
                answerWith?.let { matched ->
                    ctx.sendBroadcast(
                        Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
                            setPackage(ctx.packageName)
                            putExtra(PhoneService.EXTRA_PAIRING_ID, promptedId)
                            putExtra(E2eSasContract.EXTRA_SAS_MATCHED, matched)
                        }
                    )
                }
            }
        }
        val filter = IntentFilter(E2eSasContract.ACTION_E2E_SAS_REQUIRED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(fakeUi, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(fakeUi, filter)
        }
    }

    @After
    fun stopListening() {
        runCatching { ctx.unregisterReceiver(fakeUi) }
    }

    private fun await(timeoutMs: Long = 15_000): E2eSasGate.Verdict =
        E2eSasGate.await(ctx, pairingId, modeOn = true, digits = digits, timeoutMs = timeoutMs)

    @Test
    fun matches_lets_the_accept_proceed() {
        answerWith = true
        val verdict = await()
        assertTrue(prompted.await(5, TimeUnit.SECONDS))
        assertEquals(pairingId, promptedId)
        // §13.3's five digits reach the UI unmangled — a SAS the user compares
        // against a different string verifies nothing.
        assertEquals(digits, promptedDigits)
        assertEquals(E2eSasGate.Verdict.MATCHED, verdict)
        assertTrue(E2eSasGate.mayProceed(verdict))
    }

    @Test
    fun doesnt_match_refuses() {
        answerWith = false
        val verdict = await()
        assertEquals(E2eSasGate.Verdict.REFUSED, verdict)
        assertFalse(E2eSasGate.mayProceed(verdict))
    }

    @Test
    fun an_absent_matched_extra_is_read_as_false() {
        // E2eSasContract: "Absent must be read as false." An intent that lost
        // the extra is not an approval.
        val done = CountDownLatch(1)
        val out = arrayOfNulls<E2eSasGate.Verdict>(1)
        Thread {
            out[0] = await(15_000)
            done.countDown()
        }.start()
        assertTrue(prompted.await(5, TimeUnit.SECONDS))
        ctx.sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
                // deliberately no EXTRA_SAS_MATCHED
            }
        )
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(E2eSasGate.Verdict.REFUSED, out[0])
    }

    @Test
    fun an_answer_for_a_different_pairing_does_not_release_the_wait() {
        val done = CountDownLatch(1)
        val out = arrayOfNulls<E2eSasGate.Verdict>(1)
        Thread {
            out[0] = await(3_000)
            done.countDown()
        }.start()
        assertTrue(prompted.await(5, TimeUnit.SECONDS))
        ctx.sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, "some-other-pairing")
                putExtra(E2eSasContract.EXTRA_SAS_MATCHED, true)
            }
        )
        assertTrue(done.await(15, TimeUnit.SECONDS))
        // Fails CLOSED. A stale approval from a pairing the user already dealt
        // with must never carry the next one.
        assertEquals(E2eSasGate.Verdict.TIMED_OUT, out[0])
    }

    @Test
    fun nobody_answering_fails_closed_at_the_deadline() {
        val started = System.currentTimeMillis()
        val verdict = E2eSasGate.await(ctx, pairingId, modeOn = true, digits = digits, timeoutMs = 1_500)
        val elapsed = System.currentTimeMillis() - started
        assertEquals(E2eSasGate.Verdict.TIMED_OUT, verdict)
        assertFalse(E2eSasGate.mayProceed(verdict))
        assertTrue("waited only ${elapsed}ms", elapsed >= 1_400)
    }

    @Test
    fun a_teardown_cancels_the_wait_instead_of_holding_the_accept_worker() {
        val done = CountDownLatch(1)
        val out = arrayOfNulls<E2eSasGate.Verdict>(1)
        val held = arrayOfNulls<E2eSasGate.Pending>(1)
        val armed = CountDownLatch(1)
        Thread {
            out[0] = E2eSasGate.await(
                ctx, pairingId, modeOn = true, digits = digits, timeoutMs = 60_000,
                onArmed = { p -> if (p != null) { held[0] = p; armed.countDown() } },
            )
            done.countDown()
        }.start()
        assertTrue(armed.await(5, TimeUnit.SECONDS))
        held[0]!!.cancel()   // what PhoneService.tearDownE2e does
        assertTrue("a cancel must not wait for the deadline", done.await(5, TimeUnit.SECONDS))
        assertEquals(E2eSasGate.Verdict.CANCELLED, out[0])
        assertFalse(E2eSasGate.mayProceed(out[0]!!))
    }

    @Test
    fun mode_off_never_broadcasts_a_prompt() {
        val verdict = E2eSasGate.await(ctx, pairingId, modeOn = false, digits = digits, timeoutMs = 1)
        assertEquals(E2eSasGate.Verdict.NOT_REQUIRED, verdict)
        assertFalse("no prompt may be shown when the mode is off", prompted.await(1, TimeUnit.SECONDS))
    }
}
