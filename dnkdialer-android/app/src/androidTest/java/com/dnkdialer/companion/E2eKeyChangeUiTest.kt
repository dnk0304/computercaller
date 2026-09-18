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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * E2E programme P5b (d) — the TOFU key-change warning and the "Encrypted"
 * state in the connection status line.
 *
 * Driven through the real [E2eTofuContract] broadcasts, like (c), so the UI
 * half is proven against the contract Forge will wire rather than against an
 * internal shortcut.
 *
 * NOTE ON DEVICE STATE: this suite needs the app battery-whitelisted and its
 * runtime permissions granted. Without the exemption MainActivity raises the
 * system dialog, which pauses it, which unregisters the receiver — and every
 * broadcast below is delivered to nobody. tools/run-ui-tests.ps1 asserts both
 * preconditions; running this class by hand without it will fail in a way
 * that looks like a missing registration and is not.
 */
@RunWith(AndroidJUnit4::class)
class E2eKeyChangeUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    private companion object {
        const val PAIRING_ID = "tofu-ui-test-pairing"
    }

    @Before
    fun signIn() {
        TokenStore.save(ctx, "tofu-ui-test-not-a-real-token", "dennis@example.com")
    }

    @After
    fun tearDown() {
        TokenStore.clear(ctx)
    }

    @Test
    fun the_warning_lists_benign_causes_without_asserting_one() {
        withWarningShowing { activity ->
            val body = activity.findViewById<TextView>(R.id.homeKeyChangeBody).text.toString()
            // M-C: the phone cannot distinguish a reinstall from a
            // substitution, so it must not claim it can.
            assertFalse(
                "the warning asserts a cause it cannot know",
                body.contains("this is just", true) || body.contains("don't worry", true)
            )
            for (cause in listOf("reinstall", "reset", "sign")) {
                assertTrue("benign cause '$cause' missing", body.contains(cause, true))
            }
            assertEquals(
                ctx.getString(R.string.e2e_key_change_title),
                activity.findViewById<TextView>(R.id.homeKeyChangeTitle).text.toString()
            )
        }
    }

    @Test
    fun both_answers_are_offered_and_trust_is_not_the_easy_one() {
        withWarningShowing { activity ->
            val trust = activity.findViewById<TextView>(R.id.keyChangeTrustButton)
            val notNow = activity.findViewById<TextView>(R.id.keyChangeNotNowButton)
            assertEquals("Trust", trust.text.toString())
            assertEquals("Not now", notNow.text.toString())
            assertEquals(View.VISIBLE, trust.visibility)
            assertEquals(View.VISIBLE, notNow.visibility)

            // Trusting a new key is the consequential answer, so it must not
            // carry the primary affordance that makes a tap feel routine.
            //
            // Asserted on TEXT COLOUR rather than on the background drawable:
            // two views inflated from the same drawable resource are distinct
            // Drawable instances and do NOT reliably share a ConstantState, so
            // comparing backgrounds fails even when the styling is identical.
            // The brand pill is the only one in this layout with white label
            // text (#FFFFFFFF), which makes the label colour both observable
            // and the actual thing that distinguishes primary from secondary.
            assertEquals(
                "Trust and Not now must carry the SAME weight — Trust must not " +
                    "be styled as the primary action",
                notNow.currentTextColor, trust.currentTextColor
            )
            assertEquals(
                "neither answer may be the brand/primary pill",
                ctx.getColor(R.color.text_primary), trust.currentTextColor
            )

            // "Not now" comes first in reading order, so the safe answer is the
            // one the eye reaches first.
            val parent = notNow.parent as android.view.ViewGroup
            assertTrue(
                "\"Not now\" must precede \"Trust\" in reading order",
                parent.indexOfChild(notNow) < parent.indexOfChild(trust)
            )
        }
    }

    @Test
    fun trust_sends_true_and_not_now_sends_false() {
        val trusted = captureVerdict { clickAnswer(R.id.keyChangeTrustButton) }
        assertEquals(PAIRING_ID, trusted.first)
        assertEquals(true, trusted.second)

        val declined = captureVerdict { clickAnswer(R.id.keyChangeNotNowButton) }
        assertEquals(PAIRING_ID, declined.first)
        assertEquals(
            "\"Not now\" is a refusal — silence or true here would make the " +
                "whole prompt decorative",
            false, declined.second
        )
    }

    @Test
    fun it_is_blocking_while_it_is_up() {
        withWarningShowing { activity ->
            assertEquals(
                View.GONE, activity.findViewById<View>(R.id.homeHeroDefault).visibility
            )
            activity.onBackPressedDispatcher.onBackPressed()
            assertEquals(
                "Back dismissed the key-change warning",
                View.VISIBLE, activity.findViewById<View>(R.id.homeHeroKeyChange).visibility
            )
        }
    }

    @Test
    fun the_encrypted_state_is_carried_by_words_not_only_by_colour() {
        // The status line only names a state while a pair is ACTIVE, so this
        // asserts the copy table the line renders from rather than driving a
        // live pair, which would need a relay. The table is the thing that
        // could be colour-only, and it is what the line reads from.
        val encrypted = ctx.getString(
            E2eStatusCopy.statusLine(E2eStatusCopy.State.ENCRYPTED_VERIFIED)
        )
        val unverified = ctx.getString(
            E2eStatusCopy.statusLine(E2eStatusCopy.State.ENCRYPTED_UNVERIFIED)
        )
        val plaintext = ctx.getString(
            E2eStatusCopy.statusLine(E2eStatusCopy.State.PLAINTEXT)
        )
        assertTrue(encrypted.contains("Encrypted", true))
        assertEquals("both sealed states read as Encrypted in the line", encrypted, unverified)
        assertTrue(
            "the unencrypted state must be NAMED — a bare \"Connected\" is what " +
                "users read as safe",
            plaintext.contains("Not encrypted", true)
        )
        assertFalse("the two states must not share a string", encrypted == plaintext)

        // The shade must agree with the in-app line, or the user has a
        // contradiction they cannot resolve — and the shade is what they see
        // when the app is closed.
        val notif = ctx.getString(
            E2eStatusCopy.notificationText(E2eStatusCopy.State.ENCRYPTED_VERIFIED)
        )
        assertTrue(notif.contains("Encrypted", true))
    }

    @Test
    fun the_state_broadcast_moves_the_status_line() {
        withHome { scenario ->
            sendState(encrypted = true, verified = true)
            scenario.onActivity { activity ->
                CopyRules.assertNoEndToEndClaim(activity.window.decorView)
            }
        }
    }

    @Test
    fun the_warning_never_claims_end_to_end() {
        withWarningShowing { activity ->
            CopyRules.assertNoEndToEndClaim(activity.window.decorView)
        }
    }

    // ------------------------------------------------------------- helpers

    private fun withWarningShowing(body: (MainActivity) -> Unit) {
        withHome { scenario ->
            sendKeyChanged()
            scenario.onActivity { activity ->
                assertEquals(
                    "the key-change face did not appear — is the app " +
                        "battery-whitelisted? see the class doc",
                    View.VISIBLE,
                    activity.findViewById<View>(R.id.homeHeroKeyChange).visibility
                )
                body(activity)
            }
            instr.waitForIdleSync()
        }
    }

    private fun clickAnswer(buttonId: Int) {
        withHome { scenario ->
            sendKeyChanged()
            scenario.onActivity { it.findViewById<View>(buttonId).performClick() }
            instr.waitForIdleSync()
        }
    }

    private fun withHome(body: (ActivityScenario<MainActivity>) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            body(scenario)
        }
    }

    private fun sendKeyChanged() {
        ctx.sendBroadcast(
            Intent(E2eTofuContract.ACTION_E2E_KEY_CHANGED).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, PAIRING_ID)
            }
        )
        Thread.sleep(400)
        instr.waitForIdleSync()
    }

    private fun sendState(encrypted: Boolean, verified: Boolean) {
        ctx.sendBroadcast(
            Intent(E2eTofuContract.ACTION_E2E_STATE).apply {
                setPackage(ctx.packageName)
                putExtra(E2eTofuContract.EXTRA_ENCRYPTED, encrypted)
                putExtra(E2eTofuContract.EXTRA_VERIFIED, verified)
            }
        )
        Thread.sleep(400)
        instr.waitForIdleSync()
    }

    /** As in (c): absent must read as NOT trusted, never as trusted. */
    private fun captureVerdict(body: () -> Unit): Pair<String?, Boolean> {
        var id: String? = null
        var trusted = false
        val latch = CountDownLatch(1)
        val receiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(c: android.content.Context?, i: Intent?) {
                id = i?.getStringExtra(PhoneService.EXTRA_PAIRING_ID)
                trusted = i?.getBooleanExtra(E2eTofuContract.EXTRA_TRUSTED, false) ?: false
                latch.countDown()
            }
        }
        val filter = android.content.IntentFilter(E2eTofuContract.ACTION_E2E_KEY_CHANGE_RESULT)
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
        return id to trusted
    }
}
