package com.dnkdialer.companion

import androidx.test.core.app.ActivityScenario
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
 * E2E programme P5b (b) — the "Encrypted mode" row, now that it is OPERABLE.
 *
 * P4 (s5) shipped the row inert and [SettingsScreenshotHelper] proved it was
 * inert. That proof is still correct and still runs; this class proves the
 * other four things (b) asks for, which the inert row could not have:
 *
 *  1. DEFAULT OFF — an unwritten preference reads false, not "whatever the
 *     switch happened to render".
 *  2. The disabled states carry the PEER-SPECIFIC reason, one per capability
 *     state, and the four reasons are four different strings. A single shared
 *     "can't do that" would pass a weaker test and tell the user nothing.
 *  3. The ENABLED state persists through the EXISTING store — asserted by
 *     reading [E2eSettings] back, never by reading the switch, because a
 *     switch that renders checked without writing is exactly the bug.
 *  4. A repaint is NOT a tap: onResume assigns isChecked, and that assignment
 *     must not rewrite the preference.
 *
 * The enabled branch is reached through SettingsActivity.capabilityOverride
 * because [E2ePeerCapability.current] is still the P4 Part 1 stub and cannot
 * return PEER_SUPPORTED on any device. Without the seam the enabled row would
 * ship with no test at all — see the résumé's one-line request to Forge.
 */
@RunWith(AndroidJUnit4::class)
class E2eSettingsToggleUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun signInAndClearPreference() {
        // SettingsActivity bounces to SignInActivity without a stored token.
        TokenStore.save(ctx, "settings-toggle-test-not-a-real-token", "dennis@example.com")
        E2eSettings.setEncryptedModeEnabled(ctx, false)
    }

    @After
    fun tearDown() {
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        TokenStore.clear(ctx)
    }

    @Test
    fun default_is_off() {
        // The store, not the view: the default is a property of the setting.
        assertFalse(
            "Encrypted mode must default OFF — §12 is opt-in",
            E2eSettings.isEncryptedModeEnabled(ctx)
        )
        assertEquals(false, E2eSettings.DEFAULT_ENCRYPTED_MODE)
    }

    @Test
    fun every_incapable_state_greys_the_toggle_with_its_own_reason() {
        val reasons = mutableMapOf<E2ePeerCapability.State, String>()

        for (state in E2ePeerCapability.State.values()) {
            launchWith(state) { activity, toggle, reason ->
                val shouldBeOperable = state == E2ePeerCapability.State.PEER_SUPPORTED
                assertEquals(
                    "$state must ${if (shouldBeOperable) "enable" else "disable"} the switch",
                    shouldBeOperable, toggle.isEnabled
                )
                if (!shouldBeOperable) {
                    // The custom switch tints have no disabled state, so the
                    // dimmed row IS the disabled affordance. If this alpha ever
                    // goes back to 1f the control becomes pixel-identical to an
                    // operable one that is merely off.
                    assertEquals("a greyed row must be dimmed", 0.45f, toggle.alpha, 0.001f)
                }
                val text = reason.text.toString()
                assertTrue("$state left the reason line empty", text.isNotBlank())
                reasons[state] = text

                // A disabled control must explain itself wherever TalkBack
                // focus lands, not only on the separate reason node.
                val a11y = toggle.contentDescription?.toString().orEmpty()
                assertTrue(
                    "$state: switch contentDescription must carry the reason, was '$a11y'",
                    a11y.contains(text)
                )
                assertTrue(
                    "$state: switch contentDescription must name the control",
                    a11y.contains(activity.getString(R.string.row_encrypted_mode_title))
                )
            }
        }

        assertEquals(
            "each capability state must have its OWN reason — a shared string " +
                "tells the user nothing about what to do next",
            E2ePeerCapability.State.values().size, reasons.values.toSet().size
        )
    }

    @Test
    fun turning_it_on_persists_through_the_existing_store() {
        launchWith(E2ePeerCapability.State.PEER_SUPPORTED) { _, toggle, _ ->
            assertTrue("PEER_SUPPORTED must make the switch operable", toggle.isEnabled)
            assertFalse("must open unchecked from the default", toggle.isChecked)
            toggle.isChecked = true
        }
        assertTrue(
            "the tap must reach E2eSettings — a switch that renders ON without " +
                "storing is the exact failure this asserts against",
            E2eSettings.isEncryptedModeEnabled(ctx)
        )

        // …and back off again, so the listener is not a one-way latch.
        launchWith(E2ePeerCapability.State.PEER_SUPPORTED) { _, toggle, _ ->
            assertTrue("must reopen checked from the stored preference", toggle.isChecked)
            toggle.isChecked = false
        }
        assertFalse(E2eSettings.isEncryptedModeEnabled(ctx))
    }

    @Test
    fun a_repaint_is_not_a_tap() {
        E2eSettings.setEncryptedModeEnabled(ctx, true)
        // Opening Settings repaints the switch from the store. If the repaint
        // were read as a tap the preference would be rewritten on every
        // onResume — harmless today, a real bug the moment the write has a
        // side effect (re-pair, wire renegotiation).
        launchWith(E2ePeerCapability.State.PEER_SUPPORTED) { _, toggle, _ ->
            assertTrue(toggle.isChecked)
        }
        assertTrue(
            "merely opening Settings must not rewrite the preference",
            E2eSettings.isEncryptedModeEnabled(ctx)
        )
    }

    @Test
    fun the_row_never_claims_end_to_end_in_any_state() {
        for (state in E2ePeerCapability.State.values()) {
            launchWith(state) { activity, _, _ ->
                CopyRules.assertNoEndToEndClaim(activity.window.decorView)
            }
        }
    }

    /**
     * Launch Settings with the capability provider forced to [state].
     *
     * The override is applied inside onActivity and followed by an explicit
     * refresh, because the Activity has already painted itself from the real
     * provider by the time the test can touch it.
     */
    private fun launchWith(
        state: E2ePeerCapability.State,
        body: (SettingsActivity, SwitchMaterial, android.widget.TextView) -> Unit,
    ) {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.capabilityOverride = state
                activity.refreshEncryptedModeRowForTest()
                body(
                    activity,
                    activity.findViewById(R.id.settingsEncryptedModeToggle),
                    activity.findViewById(R.id.settingsEncryptedModeReason),
                )
            }
            instr.waitForIdleSync()
        }
    }
}
