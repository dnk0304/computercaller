package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * CP3-C — the PC-selection ladder in [PhoneService.pickPcCandidate].
 *
 * The regression these tests exist for: through v55 the SCO route was pinned
 * to `availableCommunicationDevices.firstOrNull { SCO || BLE_HEADSET }`, so
 * earbuds listed ahead of the PC silently stole the user's call audio.
 */
class PcCandidateSelectionTest {

    private fun sco(name: String) = PhoneService.PcCandidate(name, isSco = true)
    private fun ble(name: String) = PhoneService.PcCandidate(name, isSco = false)

    @Test
    fun `empty candidate list yields null`() {
        assertNull(PhoneService.pickPcCandidate(emptyList(), "DESKTOP-D", listOf("desktop-d")))
    }

    @Test
    fun `persisted PC wins even when listed last`() {
        val devices = listOf(ble("Galaxy Buds"), sco("Soundcore Q30"), sco("DESKTOP-D"))
        val pick = PhoneService.pickPcCandidate(devices, "DESKTOP-D", emptyList())
        assertEquals(2 to "persisted", pick)
    }

    @Test
    fun `persisted match is case and whitespace insensitive`() {
        val devices = listOf(ble("Galaxy Buds"), sco("  DESKTOP-D "))
        assertEquals(1 to "persisted", PhoneService.pickPcCandidate(devices, "desktop-d", emptyList()))
    }

    @Test
    fun `persisted name that is absent falls through to the next rung`() {
        val devices = listOf(ble("Galaxy Buds"), sco("DESKTOP-D"))
        // The PC the user saved is not available right now; do not return it
        // by accident, and do not give up — fall to the HFP cross-check.
        val pick = PhoneService.pickPcCandidate(devices, "OLD-LAPTOP", listOf("desktop-d"))
        assertEquals(1 to "hfp_match", pick)
    }

    @Test
    fun `blank persisted name is ignored`() {
        val devices = listOf(ble("Galaxy Buds"), sco("DESKTOP-D"))
        assertEquals(1 to "sco_first", PhoneService.pickPcCandidate(devices, "   ", emptyList()))
    }

    @Test
    fun `hfp cross-check beats list order`() {
        val devices = listOf(sco("Galaxy Buds"), sco("DESKTOP-D"))
        // Only the PC holds a live HFP link — the earbuds are merely available.
        assertEquals(1 to "hfp_match", PhoneService.pickPcCandidate(devices, null, listOf("desktop-d")))
    }

    @Test
    fun `among hfp matches classic SCO beats LE`() {
        val devices = listOf(ble("Pixel Buds Pro"), sco("DESKTOP-D"))
        val pick = PhoneService.pickPcCandidate(devices, null, listOf("pixel buds pro", "desktop-d"))
        assertEquals(1 to "hfp_match", pick)
    }

    @Test
    fun `hfp match falls back to LE when no classic match exists`() {
        val devices = listOf(sco("Soundcore Q30"), ble("Pixel Buds Pro"))
        // Only the LE device is actually HFP-connected.
        assertEquals(1 to "hfp_match", PhoneService.pickPcCandidate(devices, null, listOf("pixel buds pro")))
    }

    @Test
    fun `unnamed candidates never match an empty hfp name`() {
        val devices = listOf(PhoneService.PcCandidate("", isSco = true), sco("DESKTOP-D"))
        // A productName-less device must not be matched by a blank-vs-blank
        // comparison; the ladder should skip to sco_first on index 0 only
        // because nothing matched, not because "" == "".
        val pick = PhoneService.pickPcCandidate(devices, null, listOf(""))
        assertEquals(0 to "sco_first", pick)
    }

    @Test
    fun `no persisted and no hfp prefers classic SCO over LE`() {
        val devices = listOf(ble("Galaxy Buds"), sco("DESKTOP-D"))
        assertEquals(1 to "sco_first", PhoneService.pickPcCandidate(devices, null, emptyList()))
    }

    @Test
    fun `all LE devices fall back to first with ble_first basis`() {
        val devices = listOf(ble("Pixel Buds Pro"), ble("Galaxy Buds"))
        assertEquals(0 to "ble_first", PhoneService.pickPcCandidate(devices, null, emptyList()))
    }

    @Test
    fun `the v55 regression - earbuds first no longer win`() {
        // Exact shape of the bug: earbuds enumerate first, PC second, both
        // classic SCO, PC is the live HFP link. firstOrNull would return 0.
        val devices = listOf(sco("Galaxy Buds3"), sco("DESKTOP-D"))
        val pick = PhoneService.pickPcCandidate(devices, null, listOf("desktop-d"))
        assertEquals("PC must win over earbuds listed first", 1, pick!!.first)
    }
}
