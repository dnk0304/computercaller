package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E programme, phase P4.2 (c) — the BACKWARD-COMPAT assertion for VECTOR M.
 *
 * Authority: `tests/kdf-vectors.json` → `modeVectorM`, frozen by E2E-P2.2 from
 * `security/PROJECTS/computercaller/e2e/GATE2-PRE-A5.md` F5 / MUST M-A5-5.
 *
 * ## What this test is, and what it deliberately is NOT
 *
 * F5's wire-byte correction — "the `mode` byte on the wire is the SENDER'S OWN
 * LOCAL SETTING, an advertisement" — is **OR-absorbed on vc58/59** and is NOT
 * being applied here. The frozen file says why in its own `absorption` note:
 *
 * > `OR(a, OR(a, b)) == OR(a, b)` for every `(a, b)`. Android's shipped accept
 * > byte carries the already-ORed effective value, so a receiver computing
 * > `OR(ownLocal, peerByte)` reaches the SAME effective mode either way.
 *
 * So the shipped semantics are not wrong, they are redundant, and a signed
 * build does not need rebuilding for them. What DOES need proving is the thing
 * absorption claims: that a vc58/59-semantics phone paired with a P2.2 computer
 * still lands on exactly vector M's cells. This test is that proof and nothing
 * more. **It fixes nothing.** If a cell below differs, that is a Security
 * finding to be reported, not a line of Kotlin to be edited — the frozen table
 * is the authority and this lane is downstream of it.
 *
 * The four rows, verbatim from `modeVectorM.cases`. Reproduce with:
 *
 *   node -e "console.log(JSON.stringify(require('./tests/kdf-vectors.json').modeVectorM.cases,null,1))"
 *
 * They are pinned as literals rather than loaded from a fifth frozen resource
 * on purpose: this is a four-row backward-compat check, and a second sha-pinned
 * copy of a file that [E2eFrozenKdfVectorsTest] already guards would be a
 * maintenance surface bought for nothing. A change to these cells is a Security
 * decision, and a Security decision SHOULD break this build loudly.
 */
@RunWith(AndroidJUnit4::class)
class E2eModeVectorMBackCompatTest {

    private data class Row(
        val id: String,
        val phoneLocal: Boolean,
        val computerLocal: Boolean,
        val sasModeByte: Int,
        val digits: String,
        val effective: Boolean,
        val sealed: Boolean,
        val sasBlocking: Boolean,
    )

    private companion object {
        val PAIRING_ID = "pair-M-0000000000000001"
        const val PAIR_EPOCH = 7L

        const val PHONE_KEY =
            "0411111111111111111111111111111111111111111111111111111111111111" +
                "111111111111111111111111111111111111111111111111111111111111111111"
        const val WEB_KEY =
            "0422222222222222222222222222222222222222222222222222222222222222" +
                "222222222222222222222222222222222222222222222222222222222222222222"
        const val SW_KEY =
            "0433333333333333333333333333333333333333333333333333333333333333" +
                "333333333333333333333333333333333333333333333333333333333333333333"
        const val EPK =
            "04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

        val ROWS = listOf(
            Row("M1-off-off", false, false, 0, "02024", false, true, false),
            Row("M2-phone-on-computer-off", true, false, 1, "30087", true, true, true),
            Row("M3-phone-off-computer-on", false, true, 1, "30087", true, true, true),
            Row("M4-on-on", true, true, 1, "30087", true, true, true),
        )
    }

    private fun hex(s: String): ByteArray =
        ByteArray(s.length / 2) { ((s[it * 2].digitToInt(16) shl 4) or s[it * 2 + 1].digitToInt(16)).toByte() }

    /**
     * The whole of (c). Every differing cell is collected and reported together
     * rather than failing on the first one — a partial picture of a
     * compatibility break is worse than none when the output is going to
     * Security as a finding.
     */
    @Test
    fun vc59_semantics_still_land_on_vector_M() {
        val keys = listOf(hex(PHONE_KEY), hex(WEB_KEY), hex(SW_KEY))
        val epk = hex(EPK)
        val findings = mutableListOf<String>()
        var checked = 0

        for (row in ROWS) {
            // The computer is web + extension SW behind one peer identity; in
            // vector M both sub-devices carry the one `computerLocal` setting.
            val peer = E2eSettings.advertisementOf(listOf(row.computerLocal, row.computerLocal))
            val mode = E2eSettings.effectiveMode(row.phoneLocal, peer)

            val effective = mode == E2eSettings.EffectiveMode.ENCRYPTED_VERIFIED
            if (effective != row.effective) {
                findings += "${row.id}: effective expected ${row.effective} got $effective (mode=$mode)"
            }
            if (E2eSettings.isSealed(mode) != row.sealed) {
                findings += "${row.id}: sealed expected ${row.sealed} got ${E2eSettings.isSealed(mode)}"
            }
            if (E2eSettings.requiresSas(mode) != row.sasBlocking) {
                findings += "${row.id}: sasBlocking expected ${row.sasBlocking} got ${E2eSettings.requiresSas(mode)}"
            }

            // The SAS input is the EFFECTIVE mode, never a local setting — that
            // is what makes the digits agree across three implementations whose
            // wire bytes differ per sender.
            val modeOn = row.sasModeByte == 1
            if (modeOn != effective) {
                findings += "${row.id}: sasModeByte ${row.sasModeByte} disagrees with the effective mode $effective"
            }

            val digits = E2eSas.digits(PAIRING_ID, epk, keys, PAIR_EPOCH, modeOn)
            if (digits != row.digits) {
                findings += "${row.id}: SAS digits expected ${row.digits} got $digits"
            }
            checked++
        }

        assertEquals("every vector M row must have been exercised", ROWS.size, checked)
        assertTrue(
            "VECTOR M BACK-COMPAT BREAK — report to Security as a finding, do NOT patch this " +
                "lane to match: the frozen table in tests/kdf-vectors.json modeVectorM is the " +
                "authority.\n" + findings.joinToString("\n"),
            findings.isEmpty()
        )
    }

    /**
     * The headline cells the brief names, asserted directly so a reader does
     * not have to reconstruct them from the loop: M1 off/off is mode byte 0x00
     * and SAS 02024; M2/M3/M4 are 0x01 and SAS 30087; all four SEAL.
     *
     * Mode 0/0 sealing is A5 row 4 and is the easiest cell to get wrong: it is
     * Encrypted (unverified), never plaintext.
     */
    @Test
    fun the_two_headline_codes_are_unchanged() {
        val keys = listOf(hex(PHONE_KEY), hex(WEB_KEY), hex(SW_KEY))
        val epk = hex(EPK)

        assertEquals("M1 off/off", "02024", E2eSas.digits(PAIRING_ID, epk, keys, PAIR_EPOCH, false))
        assertEquals("M2/M3/M4", "30087", E2eSas.digits(PAIRING_ID, epk, keys, PAIR_EPOCH, true))

        for (row in ROWS) {
            val peer = E2eSettings.advertisementOf(listOf(row.computerLocal, row.computerLocal))
            val mode = E2eSettings.effectiveMode(row.phoneLocal, peer)
            assertTrue(
                "${row.id} must SEAL — a usable block on both sides always seals, and mode 0/0 " +
                    "is Encrypted (unverified), never plaintext (A5 row 4)",
                E2eSettings.isSealed(mode)
            )
        }
    }
}
