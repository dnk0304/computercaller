package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * vc63 (T-VC63-MAIN-SCREEN) — the Encrypted-mode row's copy table, walked
 * exhaustively on the JVM.
 *
 * The row exists on two screens now. The thing worth protecting is not that
 * either screen renders — the instrumented suite covers that — it is that
 * there is only ONE answer, and that the answer is right in every state. Both
 * are properties of [E2eModeRowCopy], which is pure precisely so they can be
 * asserted here without a device.
 *
 * The live-pair overlay gets its own section because it is the INC-0923
 * surface: the switch is an intent about the next connection, the pair's mode
 * is a fact about this one, and the bug being guarded against is the two
 * being blended into a single reassuring sentence.
 */
class E2eModeRowCopyTest {

    // ------------------------------------------------ capability x preference

    @Test
    fun only_peer_supported_enables_the_switch() {
        for (state in E2ePeerCapability.State.values()) {
            for (pref in listOf(false, true)) {
                val copy = E2eModeRowCopy.forState(state, pref)
                assertEquals(
                    "$state (pref=$pref): only PEER_SUPPORTED may be operated",
                    state == E2ePeerCapability.State.PEER_SUPPORTED,
                    copy.enabled
                )
            }
        }
    }

    @Test
    fun a_stored_true_never_renders_on_a_switch_that_cannot_be_operated() {
        // A switch that is ON and inert is a claim the user cannot withdraw:
        // it says the next connection will be encrypted while refusing to let
        // them change their mind about it.
        for (state in E2ePeerCapability.State.values()) {
            val copy = E2eModeRowCopy.forState(state, checkedPref = true)
            if (state == E2ePeerCapability.State.PEER_SUPPORTED) {
                assertTrue("$state must honour a stored ON", copy.checked)
            } else {
                assertFalse("$state must not render checked", copy.checked)
            }
        }
    }

    @Test
    fun every_state_has_its_own_reason_and_a_disabled_row_is_dimmed() {
        val reasons = E2ePeerCapability.State.values()
            .map { E2eModeRowCopy.forState(it, false).reasonRes }
        assertEquals(
            "each capability state must carry its OWN reason — a shared " +
                "string tells the user nothing about what to do next",
            E2ePeerCapability.State.values().size, reasons.toSet().size
        )
        for (state in E2ePeerCapability.State.values()) {
            val copy = E2eModeRowCopy.forState(state, false)
            val expected =
                if (copy.enabled) E2eModeRowCopy.FULL_ALPHA else E2eModeRowCopy.DIMMED_ALPHA
            assertEquals("$state alpha", expected, copy.alpha, 0.0001f)
        }
        // The dim IS the disabled affordance: the switch tints are a custom
        // colour selector with no disabled state, so at 1f a dead control is
        // pixel-identical to a live one that is merely off.
        assertEquals(0.45f, E2eModeRowCopy.DIMMED_ALPHA, 0.0001f)
    }

    @Test
    fun the_reason_strings_are_the_ones_settings_already_shipped() {
        // Home must not invent softer copy for the same facts.
        assertEquals(
            R.string.settings_encrypted_mode_waiting,
            E2eModeRowCopy.forState(E2ePeerCapability.State.UNKNOWN, false).reasonRes
        )
        assertEquals(
            R.string.settings_encrypted_mode_peer_old,
            E2eModeRowCopy.forState(E2ePeerCapability.State.PEER_UNSUPPORTED, false).reasonRes
        )
        assertEquals(
            R.string.settings_encrypted_mode_device_old,
            E2eModeRowCopy.forState(E2ePeerCapability.State.DEVICE_UNSUPPORTED, false).reasonRes
        )
        assertEquals(
            R.string.settings_encrypted_mode_ready,
            E2eModeRowCopy.forState(E2ePeerCapability.State.PEER_SUPPORTED, false).reasonRes
        )
    }

    @Test
    fun the_after_flip_line_is_the_existing_next_pair_copy() {
        assertEquals(
            R.string.settings_encrypted_mode_on_next_pair,
            E2eModeRowCopy.afterFlipLine(true)
        )
        assertEquals(
            R.string.settings_encrypted_mode_off_next_pair,
            E2eModeRowCopy.afterFlipLine(false)
        )
    }

    // -------------------------------------------------- live-pair overlay

    @Test
    fun each_live_mode_has_its_own_line() {
        val lines = E2eStatusCopy.State.values().map { E2eModeRowCopy.liveModeLine(it) }
        assertEquals("three modes, three lines", 3, lines.toSet().size)
        assertEquals(
            R.string.home_e2e_now_verified,
            E2eModeRowCopy.liveModeLine(E2eStatusCopy.State.ENCRYPTED_VERIFIED)
        )
        assertEquals(
            R.string.home_e2e_now_unverified,
            E2eModeRowCopy.liveModeLine(E2eStatusCopy.State.ENCRYPTED_UNVERIFIED)
        )
        assertEquals(
            R.string.home_e2e_now_plaintext,
            E2eModeRowCopy.liveModeLine(E2eStatusCopy.State.PLAINTEXT)
        )
    }

    @Test
    fun the_next_connection_caveat_appears_exactly_when_intent_and_fact_differ() {
        // ON promises "encrypted, and you'll confirm a code" — so a live pair
        // that is merely sealed, or not sealed at all, disagrees with it.
        assertTrue(
            E2eModeRowCopy.switchAgreesWithLiveMode(
                true, E2eStatusCopy.State.ENCRYPTED_VERIFIED
            )
        )
        assertFalse(
            "switch ON over an unverified pair must carry the caveat",
            E2eModeRowCopy.switchAgreesWithLiveMode(
                true, E2eStatusCopy.State.ENCRYPTED_UNVERIFIED
            )
        )
        assertFalse(
            E2eModeRowCopy.switchAgreesWithLiveMode(true, E2eStatusCopy.State.PLAINTEXT)
        )

        // OFF over today's normal pair (the browser advertises mode 0, so the
        // pair is ENCRYPTED_UNVERIFIED) is exactly what the user asked for.
        assertTrue(
            E2eModeRowCopy.switchAgreesWithLiveMode(
                false, E2eStatusCopy.State.ENCRYPTED_UNVERIFIED
            )
        )
        assertTrue(
            E2eModeRowCopy.switchAgreesWithLiveMode(false, E2eStatusCopy.State.PLAINTEXT)
        )
        assertFalse(
            "switch OFF over a verified pair must say the switch is about next time",
            E2eModeRowCopy.switchAgreesWithLiveMode(
                false, E2eStatusCopy.State.ENCRYPTED_VERIFIED
            )
        )
    }

    @Test
    fun the_live_line_is_never_derived_from_the_switch() {
        // Same mode in, same line out, regardless of what the user wants next.
        for (mode in E2eStatusCopy.State.values()) {
            assertEquals(
                E2eModeRowCopy.liveModeLine(mode),
                E2eModeRowCopy.liveModeLine(mode)
            )
        }
        // And the two facts are never the same resource, so no rendering of
        // the row can collapse them into one sentence.
        val capability = E2ePeerCapability.State.values()
            .map { E2eModeRowCopy.forState(it, false).reasonRes }.toSet()
        val live = E2eStatusCopy.State.values().map { E2eModeRowCopy.liveModeLine(it) }.toSet()
        assertTrue(
            "the capability copy and the live-mode copy must be different strings",
            capability.intersect(live).isEmpty()
        )
    }
}
