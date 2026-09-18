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
 * P4.1 rewired the SETUP only. The three PEER states are now reached the way
 * production reaches them: an `e2e` advertisement is persisted through
 * [E2eSettings] and the Activity reads it back through the real
 * [E2ePeerCapability.current]. Until P4.1 that provider was a stub that could
 * only answer UNKNOWN, so this suite drove SettingsActivity.capabilityOverride
 * for every state — and passed while the shipped toggle could never enable.
 * The assertions below are unchanged; what changed is that they are now about
 * the production path.
 *
 * [E2ePeerCapability.State.DEVICE_UNSUPPORTED] still uses the override, and
 * has to: it means this phone's Keystore cannot do key agreement (API 26-30),
 * which an API 31+ emulator cannot be put into. Removing the seam would not
 * make that row tested — it would make it untested.
 */
@RunWith(AndroidJUnit4::class)
class E2eSettingsToggleUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    /**
     * The states a real device can be put into, and therefore the states whose
     * RENDERING can be asserted here.
     *
     * [E2ePeerCapability.State.DEVICE_UNSUPPORTED] is missing on purpose: it
     * means this phone's own Keystore cannot do key agreement (API 26–30), and
     * an API 31+ emulator cannot be put into that state by any input. P5b
     * reached it with a SettingsActivity override; P4.1 deleted that seam
     * because lint proved the read side of it was production code
     * (RestrictedApi), and a seam the product can reach is not a test seam.
     *
     * What is lost is the RENDER of that one row, and it is not lost silently:
     * its reason string is still asserted distinct below, its branch is
     * asserted in E2ePeerCapabilityTest, and the row's layout is the same
     * disabled row the other two greyed states exercise here. Running it on a
     * real API 26–30 image is the open item — the same open item the crypto
     * suite already carries as `api26ImageRun: false`.
     */
    private val reachableStates = listOf(
        E2ePeerCapability.State.UNKNOWN,
        E2ePeerCapability.State.PEER_SUPPORTED,
        E2ePeerCapability.State.PEER_UNSUPPORTED,
    )

    @Before
    fun signInAndClearPreference() {
        // SettingsActivity bounces to SignInActivity without a stored token.
        TokenStore.save(ctx, "settings-toggle-test-not-a-real-token", "dennis@example.com")
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        // P4.1: the capability now comes off disk, so a record left by an
        // earlier test would decide this one's starting state.
        E2eSettings.clearPeerAdvertisement(ctx, "UI test setup")
    }

    @After
    fun tearDown() {
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        E2eSettings.clearPeerAdvertisement(ctx, "UI test teardown")
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

        for (state in reachableStates) {
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

        // The fourth state's copy is asserted at the STRING level, since its
        // row cannot be rendered on this device (see [reachableStates]). The
        // claim being made — four states, four different things to do next —
        // is unchanged; only one quarter of it is proved from resources rather
        // than from a painted view.
        val allReasons = reasons.values.toMutableSet()
        allReasons.add(ctx.getString(R.string.settings_encrypted_mode_device_old))
        assertEquals(
            "each capability state must have its OWN reason — a shared string " +
                "tells the user nothing about what to do next",
            E2ePeerCapability.State.values().size, allReasons.size
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
        for (state in reachableStates) {
            launchWith(state) { activity, _, _ ->
                CopyRules.assertNoEndToEndClaim(activity.window.decorView)
            }
        }
    }

    /**
     * Put the REAL provider into [state] by writing the advertisement that
     * produces it, exactly as PhoneService does on a PAIRING_REQUEST.
     *
     * DEVICE_UNSUPPORTED is rejected outright rather than faked: it is a fact
     * about the phone's Keystore, not about any peer, and there is no longer a
     * seam that can assert it. A test that asked for it would otherwise get a
     * silently wrong row. See [reachableStates].
     */
    private fun seedRealProvider(state: E2ePeerCapability.State) {
        E2eSettings.clearPeerAdvertisement(ctx, "seed")
        when (state) {
            // No record at all: nothing paired, nothing pending.
            E2ePeerCapability.State.UNKNOWN -> Unit

            // A v:1 block with a web recipient — the production shape.
            E2ePeerCapability.State.PEER_SUPPORTED ->
                E2eSettings.recordPeerAdvertisement(
                    ctx, "ui-test-pairing",
                    E2eNegotiation.parsePeerOffer(supportedE2eBlock())
                )

            // A computer that paired with no usable block at all.
            E2ePeerCapability.State.PEER_UNSUPPORTED ->
                E2eSettings.recordPeerAdvertisement(
                    ctx, "ui-test-pairing", E2eNegotiation.parsePeerOffer(null)
                )

            E2ePeerCapability.State.DEVICE_UNSUPPORTED -> throw IllegalArgumentException(
                "DEVICE_UNSUPPORTED cannot be produced on this device — see reachableStates"
            )
        }
        // Prove the seed landed. A seed that silently produced a different
        // state would make every assertion below test the wrong row while
        // still going green — the exact failure mode P4.1 exists to close.
        assertEquals(
            "seeding did not produce $state",
            state, E2ePeerCapability.current(ctx)
        )
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
                    addProperty("deviceId", "ui-test-dev-web")
                    addProperty("pub", pub)
                })
            })
        }
    }

    /**
     * Launch Settings with the capability provider reporting [state].
     *
     * P4.1: every state here goes through the real provider (see
     * [seedRealProvider]). The explicit refresh stays, because the Activity
     * has already painted by the time a test can seed anything.
     */
    private fun launchWith(
        state: E2ePeerCapability.State,
        body: (SettingsActivity, SwitchMaterial, android.widget.TextView) -> Unit,
    ) {
        seedRealProvider(state)
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
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
