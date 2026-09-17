package com.dnkdialer.companion

import com.dnkdialer.companion.E2eSettings.EffectiveMode
import com.dnkdialer.companion.E2eSettings.PeerAdvertisement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM unit tests for [E2eSettings.effectiveMode] (P4 Part 1, (s4)).
 *
 * The decision table is the security-relevant part of the mixed-mode design:
 * every "device has mode ON but the pair completed in plaintext" bug is a
 * wrong cell in here. The whole 2x3 space is asserted, not just the rows the
 * brief names, because a table with untested cells is not frozen.
 *
 * Matrix reference: AUDIT-SECURITY-v2 Part 2, as resolved by C-1.
 */
class E2eSettingsTest {

    // --------------------------------------------- the rows the brief names

    /**
     * Row 8 — phone ON, computer capable but OFF. Undefined before C-1.
     * Must be ENCRYPTED_VERIFIED: the OR means the phone's ON wins and the
     * SAS is blocking on BOTH ends, including the end that never asked.
     */
    @Test
    fun row8_phoneOn_computerOff_isVerifiedEncrypted() {
        assertEquals(
            EffectiveMode.ENCRYPTED_VERIFIED,
            E2eSettings.effectiveMode(localEnabled = true, peer = PeerAdvertisement.OFF)
        )
    }

    /** Row 9 — phone OFF, computer ON. Symmetric to row 8; the peer's ON wins. */
    @Test
    fun row9_phoneOff_computerOn_isVerifiedEncrypted() {
        assertEquals(
            EffectiveMode.ENCRYPTED_VERIFIED,
            E2eSettings.effectiveMode(localEnabled = false, peer = PeerAdvertisement.ON)
        )
    }

    /**
     * Row 10 — one computer, two sub-devices: web OFF, extension SW ON. The
     * computer advertises the OR of its own settings, so the phone sees ON
     * and the pair is verified-encrypted even though the web half is OFF.
     */
    @Test
    fun row10_computerAdvertisesOrOfItsOwnSubDevices() {
        val computerSaysOn = E2eSettings.advertisementOf(listOf(false, true)) // web OFF, ext ON
        assertEquals(PeerAdvertisement.ON, computerSaysOn)
        assertEquals(
            EffectiveMode.ENCRYPTED_VERIFIED,
            E2eSettings.effectiveMode(localEnabled = true, peer = computerSaysOn)
        )
        // ...and the same computer with BOTH halves off advertises OFF, not ABSENT.
        assertEquals(PeerAdvertisement.OFF, E2eSettings.advertisementOf(listOf(false, false)))
    }

    // ------------------------------------------------- the rest of the table

    /** Row 1 — both ON. */
    @Test
    fun row1_bothOn_isVerifiedEncrypted() {
        assertEquals(
            EffectiveMode.ENCRYPTED_VERIFIED,
            E2eSettings.effectiveMode(true, PeerAdvertisement.ON)
        )
    }

    /** Row 4 — both capable, both OFF: still sealed, but no SAS is shown. */
    @Test
    fun row4_bothOff_isUnverifiedEncrypted() {
        assertEquals(
            EffectiveMode.ENCRYPTED_UNVERIFIED,
            E2eSettings.effectiveMode(false, PeerAdvertisement.OFF)
        )
    }

    /**
     * Row 3 — this device wants encryption, the peer has no `e2e` block at
     * all. The ONLY correct answer is to refuse. A silent downgrade here is
     * precisely the BLOCKER shape the audit named.
     */
    @Test
    fun row3_localOn_peerCannotEncrypt_aborts() {
        assertEquals(
            EffectiveMode.ABORT,
            E2eSettings.effectiveMode(true, PeerAdvertisement.ABSENT)
        )
    }

    /** Row 5 — nobody asked for encryption and the peer is old: plaintext. */
    @Test
    fun row5_localOff_peerCannotEncrypt_isPlaintext() {
        assertEquals(
            EffectiveMode.PLAINTEXT,
            E2eSettings.effectiveMode(false, PeerAdvertisement.ABSENT)
        )
    }

    // ----------------------------------------------------------- invariants

    /**
     * The load-bearing invariant, stated independently of the table: if THIS
     * device has encrypted mode ON, the pair is NEVER silently plaintext. It
     * either seals, or it aborts loudly. Asserted over the whole peer space
     * so a future PeerAdvertisement value cannot quietly open a downgrade.
     */
    @Test
    fun localOnNeverSilentlyDowngradesToPlaintext() {
        for (peer in PeerAdvertisement.entries) {
            val mode = E2eSettings.effectiveMode(localEnabled = true, peer = peer)
            assertTrue(
                "mode ON + peer=$peer produced $mode — a silent plaintext downgrade",
                mode != EffectiveMode.PLAINTEXT
            )
            assertTrue(
                "mode ON + peer=$peer produced $mode — expected sealed or abort",
                E2eSettings.isSealed(mode) || mode == EffectiveMode.ABORT
            )
        }
    }

    /** ABORT is reachable ONLY from a local-ON device; never punish an OFF user. */
    @Test
    fun localOffNeverAborts() {
        for (peer in PeerAdvertisement.entries) {
            assertTrue(
                "mode OFF + peer=$peer aborted the pairing",
                E2eSettings.effectiveMode(localEnabled = false, peer = peer) != EffectiveMode.ABORT
            )
        }
    }

    /** The OR is symmetric: swapping which side is ON cannot change the outcome. */
    @Test
    fun theOrIsSymmetric() {
        assertEquals(
            E2eSettings.effectiveMode(true, PeerAdvertisement.OFF),
            E2eSettings.effectiveMode(false, PeerAdvertisement.ON)
        )
    }

    /** The table is total — every cell is asserted above, none throws. */
    @Test
    fun everyCellIsDefined() {
        var cells = 0
        for (local in listOf(true, false)) {
            for (peer in PeerAdvertisement.entries) {
                E2eSettings.effectiveMode(local, peer)
                cells++
            }
        }
        assertEquals("the decision table changed shape", 6, cells)
    }

    /** SAS is blocking exactly when the mode is verified-encrypted. */
    @Test
    fun requiresSasOnlyForVerifiedEncrypted() {
        assertTrue(E2eSettings.requiresSas(EffectiveMode.ENCRYPTED_VERIFIED))
        assertFalse(E2eSettings.requiresSas(EffectiveMode.ENCRYPTED_UNVERIFIED))
        assertFalse(E2eSettings.requiresSas(EffectiveMode.PLAINTEXT))
        assertFalse(E2eSettings.requiresSas(EffectiveMode.ABORT))
    }

    /** Frames are sealed under both encrypted modes and neither other one. */
    @Test
    fun isSealedCoversBothEncryptedModes() {
        assertTrue(E2eSettings.isSealed(EffectiveMode.ENCRYPTED_VERIFIED))
        assertTrue(E2eSettings.isSealed(EffectiveMode.ENCRYPTED_UNVERIFIED))
        assertFalse(E2eSettings.isSealed(EffectiveMode.PLAINTEXT))
        assertFalse(E2eSettings.isSealed(EffectiveMode.ABORT))
    }

    /** An empty sub-device list is ABSENT, not OFF — they are not interchangeable. */
    @Test
    fun emptyAdvertisementIsAbsentNotOff() {
        assertEquals(PeerAdvertisement.ABSENT, E2eSettings.advertisementOf(emptyList()))
        // and that distinction is what makes a mode-ON pairing abort:
        assertEquals(
            EffectiveMode.ABORT,
            E2eSettings.effectiveMode(true, E2eSettings.advertisementOf(emptyList()))
        )
    }

    /** Ships dark: the user opts in. */
    @Test
    fun defaultIsOff() {
        assertFalse(E2eSettings.DEFAULT_ENCRYPTED_MODE)
    }
}
