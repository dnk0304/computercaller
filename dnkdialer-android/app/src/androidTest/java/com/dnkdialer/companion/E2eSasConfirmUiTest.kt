package com.dnkdialer.companion

import android.content.Intent
import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * E2E programme P5b (c) — the SAS confirm on the Home hero card.
 *
 * The tests drive the REAL broadcast contract ([E2eSasContract]) rather than
 * calling private methods, so what is exercised here is exactly what
 * PhoneService will exercise once Forge wires the two call sites. The UI half
 * is therefore proven before the service half exists, and the contract is the
 * thing under test rather than an internal shortcut that would pass whatever
 * the wiring turned out to be.
 *
 * What is asserted, and why each one matters:
 *
 *  * the digits are shown UNGROUPED and verbatim (SPEC 13.3 "Rendering —
 *    FROZEN (R-BK)", M-A6-5): this face used to group 3+2 while the page
 *    dialog grouped 2+3, so one live code read "316 44" on the phone and
 *    "31 644" on the computer. The SAS is a human exact-string compare, and a
 *    user taught that the two screens legitimately differ is a user taught to
 *    accept the substitution the SAS exists to catch;
 *  * the spoken description is the SAME digits SPELLED OUT one at a time —
 *    TalkBack reads "41290" as "forty-one thousand two hundred and ninety"
 *    and "412 90" as two numbers, and neither is what a sighted user is
 *    comparing; only digit-by-digit is;
 *  * BLOCKING: no dismiss, Back swallowed, and the default face stays covered
 *    even if something calls the request-teardown path underneath;
 *  * "Matches" and "Doesn't match" both emit the contract broadcast with the
 *    right boolean, so the service sees a real answer and not silence;
 *  * "Doesn't match" surfaces the refusal copy immediately, because a tap
 *    that visibly does nothing gets repeated — and repeating is what an
 *    attacker needs;
 *  * a malformed payload is REFUSED rather than rendered: showing an
 *    arbitrary string to compare teaches users to confirm whatever they see.
 */
@RunWith(AndroidJUnit4::class)
class E2eSasConfirmUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    private companion object {
        const val PAIRING_ID = "sas-ui-test-pairing"
        const val DIGITS = "41290"

        /** SPEC 13.3 R-BK: the visible code IS the digits, ungrouped. */
        const val RENDERED = DIGITS

        /** What TalkBack must say: the same digits, one at a time. */
        const val SPOKEN = "4 1 2 9 0"
    }

    @Before
    fun signIn() {
        TokenStore.save(ctx, "sas-ui-test-not-a-real-token", "dennis@example.com")
    }

    @After
    fun tearDown() {
        TokenStore.clear(ctx)
    }

    @Test
    fun the_code_is_shown_ungrouped_and_spelled_out_when_spoken() {
        withSasShowing { activity ->
            val code = activity.findViewById<TextView>(R.id.homeSasCode)
            assertEquals(
                "SPEC 13.3 R-BK: the visible code is the five digits verbatim, " +
                    "byte-identical to what the page dialog shows",
                RENDERED, code.text.toString()
            )
            assertFalse(
                "no separator of any kind may reach the visible code",
                code.text.toString().any { !it.isDigit() }
            )
            val spoken = code.contentDescription?.toString().orEmpty()
            assertTrue(
                "the spoken code must spell the digits out, was '$spoken'",
                spoken.contains(SPOKEN)
            )
            assertEquals(
                "what is spoken must be what is shown, only spaced",
                RENDERED, SPOKEN.replace(" ", "")
            )
            // Parity with the web/extension surface, which asks the same
            // question in the other direction.
            assertEquals(
                "Same code on your computer?",
                activity.findViewById<TextView>(R.id.homeSasPrompt).text.toString()
            )
        }
    }

    @Test
    fun it_is_blocking_while_it_is_up() {
        withSasShowing { activity ->
            assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.homeHeroSas).visibility)
            assertEquals(
                "the default face must stay covered — an uncovered card is a " +
                    "dismissable prompt",
                View.GONE, activity.findViewById<View>(R.id.homeHeroDefault).visibility
            )
            assertEquals(
                View.GONE, activity.findViewById<View>(R.id.homeHeroRequest).visibility
            )

            // Back must not be an escape hatch out of a security prompt.
            activity.onBackPressedDispatcher.onBackPressed()
            assertEquals(
                "Back dismissed the SAS — it must be swallowed while it is up",
                View.VISIBLE, activity.findViewById<View>(R.id.homeHeroSas).visibility
            )
            assertEquals(
                View.GONE, activity.findViewById<View>(R.id.homeHeroDefault).visibility
            )
        }
    }

    @Test
    fun matches_sends_true_on_the_contract_broadcast() {
        val answer = captureVerdict {
            withSasShowing { activity ->
                activity.findViewById<View>(R.id.sasMatchesButton).performClick()
            }
        }
        assertEquals(PAIRING_ID, answer.first)
        assertEquals(true, answer.second)
    }

    @Test
    fun no_match_sends_false_and_says_so_without_waiting_for_the_service() {
        var errorText = ""
        val answer = captureVerdict {
            withSasShowing { activity ->
                activity.findViewById<View>(R.id.sasNoMatchButton).performClick()
                val error = activity.findViewById<TextView>(R.id.connectionErrorText)
                assertEquals(
                    "a tap that visibly does nothing gets repeated — and " +
                        "repeating is exactly what an attacker needs",
                    View.VISIBLE, error.visibility
                )
                errorText = error.text.toString()
            }
        }
        assertEquals(PAIRING_ID, answer.first)
        assertEquals(false, answer.second)
        assertEquals(ctx.getString(R.string.e2e_sas_refused), errorText)
        // The refusal must not read as a plain disconnect: the phone is fine,
        // the relay is fine, and this pairing was refused on purpose.
        assertFalse(errorText.contains("disconnect", true))
        assertFalse(errorText.contains("signed out", true))
    }

    @Test
    fun a_malformed_payload_is_refused_not_rendered() {
        for (bad in listOf("", "4129", "412908", "4129x", "abcde")) {
            val answer = captureVerdict {
                withHome { scenario ->
                    sendSasRequired(bad)
                    scenario.onActivity { activity ->
                        assertNotEquals(
                            "a malformed SAS '$bad' was RENDERED — showing an " +
                                "arbitrary string to compare teaches users to " +
                                "confirm whatever they are shown",
                            View.VISIBLE,
                            activity.findViewById<View>(R.id.homeHeroSas).visibility
                        )
                    }
                }
            }
            assertEquals("malformed '$bad' must fail closed", false, answer.second)
        }
    }

    @Test
    fun the_sas_face_never_claims_end_to_end() {
        withSasShowing { activity ->
            CopyRules.assertNoEndToEndClaim(activity.window.decorView)
        }
    }

    // ------------------------------------------------------------- helpers

    /** Launch Home, deliver a well-formed SAS, then run [body] on it. */
    private fun withSasShowing(body: (MainActivity) -> Unit) {
        withHome { scenario ->
            sendSasRequired(DIGITS)
            scenario.onActivity { activity ->
                assertEquals(
                    "the SAS face did not appear — is the receiver registered?",
                    View.VISIBLE, activity.findViewById<View>(R.id.homeHeroSas).visibility
                )
                body(activity)
            }
            instr.waitForIdleSync()
        }
    }

    /**
     * Hold the Activity open and hand the SCENARIO to [body], not the
     * Activity.
     *
     * The difference is load-bearing: a broadcast is dispatched on the main
     * looper, so it can only be sent — and waited for — from the TEST thread.
     * Sending it from inside onActivity both throws (runOnMainSync from the
     * main thread) and could never work anyway, because sleeping on the main
     * thread is sleeping on the very looper that has to deliver it.
     */
    private fun withHome(body: (ActivityScenario<MainActivity>) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            body(scenario)
        }
    }

    /**
     * Send the service→UI broadcast exactly as PhoneService will, from the
     * TEST thread. Package-scoped, matching the RECEIVER_NOT_EXPORTED
     * registration: a SAS prompt any app could raise would be the whole
     * ballgame.
     */
    private fun sendSasRequired(digits: String) {
        ctx.sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_REQUIRED).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, PAIRING_ID)
                putExtra(E2eSasContract.EXTRA_SAS_DIGITS, digits)
            }
        )
        // Broadcast dispatch is asynchronous on the main looper; asserting
        // without waiting would race a delivery that has not happened yet.
        Thread.sleep(400)
        instr.waitForIdleSync()
    }

    /**
     * Run [body] with a receiver listening for the UI→service answer, and
     * return (pairingId, matched). `matched` defaults to FALSE when nothing
     * arrives, because silence must never read as "the user said it matched".
     */
    private fun captureVerdict(body: () -> Unit): Pair<String?, Boolean> {
        var id: String? = null
        var matched = false
        val latch = CountDownLatch(1)
        val receiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(c: android.content.Context?, i: Intent?) {
                id = i?.getStringExtra(PhoneService.EXTRA_PAIRING_ID)
                matched = i?.getBooleanExtra(E2eSasContract.EXTRA_SAS_MATCHED, false) ?: false
                latch.countDown()
            }
        }
        val filter = android.content.IntentFilter(E2eSasContract.ACTION_E2E_SAS_RESULT)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, android.content.Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        try {
            body()
            latch.await(5, TimeUnit.SECONDS)
        } finally {
            ctx.unregisterReceiver(receiver)
        }
        return id to matched
    }
}
