package com.dnkdialer.companion

import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasComponent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.switchmaterial.SwitchMaterial
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * vc63 (T-VC63-MAIN-SCREEN) — the Home "Computer" card.
 *
 * Dennis, 2026-09-23: "there should be a send file button in the android app
 * on the main screen as well as a encrypted mode toggle, shouldnt have to go
 * into settings in the android app."
 *
 * The risk in granting that is not that the new rows fail to render. It is
 * that a control which now exists in two places starts telling two stories:
 * Home saying one thing about a stored preference while Settings says
 * another, or Home reassuring the user about encryption that the live pair
 * does not have. Every test here is about one of those two failures.
 *
 * The send-file row is proved by the INTENT it fires and nothing else — the
 * row's whole job is to hand off to FileTransferActivity, whose own guards
 * (not connected, one transfer at a time, tier, quota) are the only place
 * those refusals live. A duplicate check on Home would be a second copy that
 * drifts, and this suite would be the wrong place to notice.
 */
@RunWith(AndroidJUnit4::class)
class HomeComputerCardUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun signInAndClear() {
        TokenStore.save(ctx, "home-card-test-not-a-real-token", "dennis@example.com")
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        E2eSettings.clearPeerAdvertisement(ctx, "home card test setup")
    }

    @After
    fun tearDown() {
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        E2eSettings.clearPeerAdvertisement(ctx, "home card test teardown")
        TokenStore.clear(ctx)
    }

    // ----------------------------------------------------- (iii) send a file

    @Test
    fun tapping_send_a_file_fires_the_in_app_picker_intent() {
        // ACTION_PICK_FILE has existed in FileTransferActivity since the
        // feature shipped and NOTHING in the app ever fired it — the share
        // sheet was the only way in. This row is its first caller, so this
        // assertion is the only thing standing between "the row exists" and
        // "the row works".
        Intents.init()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                instr.waitForIdleSync()
                scenario.onActivity { it.findViewById<android.view.View>(R.id.homeSendFileButton).performClick() }
                instr.waitForIdleSync()
                Intents.intended(hasAction(FileTransferActivity.ACTION_PICK_FILE))
                Intents.intended(
                    hasComponent(FileTransferActivity::class.java.name)
                )
            }
        } finally {
            Intents.release()
        }
    }

    // ----------------------------------- (i) one preference, two surfaces

    @Test
    fun flipping_on_home_is_visible_in_settings_and_back_again() {
        seedPeerSupported()

        // Home -> store
        onHome { _, toggle, _ ->
            assertTrue("PEER_SUPPORTED must make the Home switch operable", toggle.isEnabled)
            assertFalse("must open unchecked from the default", toggle.isChecked)
            toggle.isChecked = true
        }
        assertTrue(
            "the Home tap must reach E2eSettings — a switch that renders ON " +
                "without storing is the exact failure this asserts against",
            E2eSettings.isEncryptedModeEnabled(ctx)
        )

        // store -> Settings
        onSettings { toggle ->
            assertTrue("Settings must show what Home stored", toggle.isChecked)
            toggle.isChecked = false
        }
        assertFalse(E2eSettings.isEncryptedModeEnabled(ctx))

        // …and Settings -> Home, so neither screen is a one-way mirror.
        onSettings { toggle -> toggle.isChecked = true }
        assertTrue(E2eSettings.isEncryptedModeEnabled(ctx))
        onHome { _, toggle, _ ->
            assertTrue("Home must show what Settings stored", toggle.isChecked)
        }
    }

    // ------------------------------------------- (ii) a repaint is not a tap

    @Test
    fun a_repaint_is_not_a_tap() {
        seedPeerSupported()
        E2eSettings.setEncryptedModeEnabled(ctx, true)
        // Home repaints this row in onResume AND on every updateStatus tick.
        // If a repaint were read as a tap the preference would be rewritten
        // constantly — harmless today, a real bug the moment the write has a
        // side effect (re-pair, wire renegotiation).
        onHome { activity, toggle, _ ->
            assertTrue(toggle.isChecked)
            activity.refreshEncryptedModeRowForTest()
            activity.refreshEncryptedModeRowForTest()
            assertTrue(toggle.isChecked)
        }
        assertTrue(
            "merely opening and repainting Home must not rewrite the preference",
            E2eSettings.isEncryptedModeEnabled(ctx)
        )
    }

    // ------------------------------------- (iv) the honest-state reason line

    @Test
    fun not_paired_shows_the_capability_copy() {
        // No advertisement at all: nothing paired, nothing pending. The row
        // must say "waiting", never "your computer can't" — the second is a
        // claim about the peer made from the absence of evidence.
        onHome { _, toggle, reason ->
            assertFalse("UNKNOWN must not enable the switch", toggle.isEnabled)
            assertEquals(
                ctx.getString(R.string.settings_encrypted_mode_waiting),
                reason.text.toString()
            )
            assertEquals("a greyed row must be dimmed", 0.45f, toggle.alpha, 0.001f)
        }

        seedPeerSupported()
        onHome { _, _, reason ->
            assertEquals(
                ctx.getString(R.string.settings_encrypted_mode_ready),
                reason.text.toString()
            )
        }
    }

    @Test
    fun a_live_unverified_pair_says_so_and_never_claims_end_to_end() {
        seedPeerSupported()
        onHome { activity, _, reason ->
            activity.refreshEncryptedModeRowForTest(E2eStatusCopy.State.ENCRYPTED_UNVERIFIED)
            val text = reason.text.toString()
            assertTrue(
                "the live pair's ACTUAL mode must sit next to the switch: '$text'",
                text.contains(ctx.getString(R.string.home_e2e_now_unverified))
            )
            assertTrue(
                "'unverified' must survive into the rendered line: '$text'",
                text.lowercase().contains("unverified")
            )
            // Switch OFF agrees with an unverified pair, so no caveat yet.
            assertFalse(
                "no caveat when the switch and the pair agree: '$text'",
                text.contains(ctx.getString(R.string.home_e2e_next_only))
            )
            CopyRules.assertNoEndToEndClaim(activity.window.decorView)
        }
    }

    @Test
    fun the_switch_says_it_applies_to_the_next_connection_when_it_disagrees() {
        seedPeerSupported()
        E2eSettings.setEncryptedModeEnabled(ctx, true)
        onHome { activity, toggle, reason ->
            activity.refreshEncryptedModeRowForTest(E2eStatusCopy.State.ENCRYPTED_UNVERIFIED)
            assertTrue(toggle.isChecked)
            val text = reason.text.toString()
            // This is INC-0923's surface: the user has asked for encryption
            // and is sitting in a pair that does not have it. Both facts, in
            // that order, or the switch reads as having changed this session.
            assertTrue(
                "the live mode must still be stated: '$text'",
                text.contains(ctx.getString(R.string.home_e2e_now_unverified))
            )
            assertTrue(
                "a disagreeing switch must name the NEXT connection: '$text'",
                text.contains(ctx.getString(R.string.home_e2e_next_only))
            )
            // The a11y description carries the whole line, so a TalkBack user
            // reaching the switch is not told a shorter, friendlier story.
            assertTrue(
                "switch contentDescription must carry the reason line",
                toggle.contentDescription.toString().contains(text)
            )
            CopyRules.assertNoEndToEndClaim(activity.window.decorView)
        }
    }

    @Test
    fun a_plaintext_pair_is_spelled_out() {
        seedPeerSupported()
        onHome { activity, _, reason ->
            activity.refreshEncryptedModeRowForTest(E2eStatusCopy.State.PLAINTEXT)
            assertTrue(
                reason.text.toString()
                    .contains(ctx.getString(R.string.home_e2e_now_plaintext))
            )
            CopyRules.assertNoEndToEndClaim(activity.window.decorView)
        }
    }

    // ------------------------------------------------------------- helpers

    /** Put the REAL capability provider into PEER_SUPPORTED, as production does. */
    private fun seedPeerSupported() {
        E2eSettings.clearPeerAdvertisement(ctx, "seed")
        E2eSettings.recordPeerAdvertisement(
            ctx, "home-card-pairing", E2eNegotiation.parsePeerOffer(supportedE2eBlock())
        )
        assertEquals(
            "seeding did not produce PEER_SUPPORTED",
            E2ePeerCapability.State.PEER_SUPPORTED, E2ePeerCapability.current(ctx)
        )
    }

    private fun onHome(body: (MainActivity, SwitchMaterial, TextView) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            scenario.onActivity { activity ->
                // The Activity has already painted by the time a test can
                // seed anything, so the explicit second pass is the real one.
                activity.refreshEncryptedModeRowForTest()
                body(
                    activity,
                    activity.findViewById(R.id.homeEncryptedModeToggle),
                    activity.findViewById(R.id.homeEncryptedModeReason),
                )
            }
            instr.waitForIdleSync()
        }
    }

    private fun onSettings(body: (SwitchMaterial) -> Unit) {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.refreshEncryptedModeRowForTest()
                body(activity.findViewById(R.id.settingsEncryptedModeToggle))
            }
            instr.waitForIdleSync()
        }
    }

    /** A PAIRING_REQUEST `e2e` block from a capable computer (P1 wire shape). */
    private fun supportedE2eBlock(): com.google.gson.JsonObject {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        val pub = E2eKeyEncoding.toBase64Url(E2eKeyEncoding.toSec1(g.generateKeyPair().public))
        return com.google.gson.JsonObject().apply {
            addProperty("v", 1)
            addProperty("mode", 1)
            add("recips", com.google.gson.JsonArray().apply {
                add(com.google.gson.JsonObject().apply {
                    addProperty("kind", "web")
                    addProperty("deviceId", "home-card-dev-web")
                    addProperty("pub", pub)
                })
            })
        }
    }
}
