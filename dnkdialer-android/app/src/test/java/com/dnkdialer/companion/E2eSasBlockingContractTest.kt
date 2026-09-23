package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SAS-MODE0 — the phone half of the cross-surface contract
 * (RESUME-PROTOCOL v3.0 RULE 30).
 *
 * ## One file, two implementations
 *
 * `tests/e2e-sas-blocking-vectors.json` at the repo root is the SINGLE source
 * of truth for the SPEC §13.2 cells. The web lane asserts it in
 * `tests/e2e-sas-blocking-contract.test.mjs` (decideAccept -> the view useE2e
 * publishes -> sasIsBlocking); this file asserts the SAME rows against
 * [E2eSettings.effectiveMode] / [E2eSettings.isSealed] /
 * [E2eSettings.requiresSas] and [E2eStatusCopy.stateOf] /
 * [E2eStatusCopy.statusLine]. Same pattern as [E2eKdfVectorsTest]: a shared
 * vector file is the only thing that can catch the two sides quietly
 * disagreeing, because each side's own tests agree with it by construction.
 *
 * ## The row this exists for
 *
 * `row-4-M1`: phone encrypted mode OFF, computer encrypted mode OFF, a usable
 * e2e block on both sides. The pair SEALS at modeByte 0x00, the EFFECTIVE mode
 * stays OFF, SAS digits are computed (frozen transcript + coverage) and NOBODY
 * is asked to confirm them. Both surfaces must read "Encrypted, unverified"
 * and NEITHER may block on a code.
 *
 * Live acceptance of web 3e466fd (2026-09-23) found the browser opening the
 * blocking SAS modal on exactly this pair while the phone showed no code. That
 * was a web reader bug (`sasIsBlocking` keyed on the SEALING flag) and it is
 * fixed in the web lane. The decision table on THIS side was already right,
 * and this test pins it so it stays right.
 *
 * ## What this test does not cover — see [E2eStatusCopyContractTest]
 *
 * The phone's live status line read "Connected · Not encrypted" on row 4. That
 * was NOT this table: it was the WIRING above it. `E2eTofuContract.ACTION_E2E_STATE`
 * — the broadcast MainActivity listens for to move `e2eState` off its PLAINTEXT
 * default — had no sender anywhere in `app/src/main`, so the line could only
 * leave PLAINTEXT via the optimistic set on a CONFIRMED SAS, which by
 * definition never happens on row 4.
 *
 * That was ticket T-PHONE-STATUS-MODE0, FIXED in the vc64 android lane
 * (PhoneService.currentE2eState / broadcastE2eState + MainActivity reading it
 * on the status tick). [E2eStatusCopyContractTest] reads these same vectors
 * and pins the wiring, because this table cannot.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*SasBlockingContract*'`
 */
class E2eSasBlockingContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-sas-blocking-vectors.json")

    private fun rows(): List<JsonObject> {
        assertTrue(
            "the shared vector file is missing at " + file.absolutePath +
                " — the web lane and this one must read the SAME file",
            file.exists()
        )
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        val rows = root.getAsJsonArray("rows").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously. It must not.
        assertEquals("the §13.2 matrix is 2x2x2 — every cell is present", 8, rows.size)
        return rows
    }

    /** The peer the PHONE sees: the computer, through its advertised block. */
    private fun peerOf(row: JsonObject): E2eSettings.PeerAdvertisement =
        if (!row.get("blockPresent").asBoolean) E2eSettings.PeerAdvertisement.ABSENT
        else if (row.get("computerEncryptedMode").asString == "on") E2eSettings.PeerAdvertisement.ON
        else E2eSettings.PeerAdvertisement.OFF

    @Test
    fun every_matrix_cell_matches_the_shared_vectors() {
        var sealedRows = 0
        for (row in rows()) {
            val id = row.get("id").asString
            val phone = row.getAsJsonObject("phone")
            val localEnabled = row.get("phoneEncryptedMode").asString == "on"

            val mode = E2eSettings.effectiveMode(localEnabled, peerOf(row))
            assertEquals("$id: effectiveMode", phone.get("effectiveMode").asString, mode.name)
            assertEquals("$id: isSealed", phone.get("sealed").asBoolean, E2eSettings.isSealed(mode))
            assertEquals(
                "$id: requiresSas", phone.get("requiresSas").asBoolean,
                E2eSettings.requiresSas(mode)
            )

            // The SAS is blocking on this side exactly when the effective mode
            // requires it AND the pair actually sealed — the phone never shows
            // a code for a pair it is not encrypting.
            val blocking = E2eSettings.isSealed(mode) && E2eSettings.requiresSas(mode)
            assertEquals("$id: sasBlocking", phone.get("sasBlocking").asBoolean, blocking)

            if (!E2eSettings.isSealed(mode)) {
                // ABORT has no status line at all; PLAINTEXT has the unencrypted one.
                if (mode == E2eSettings.EffectiveMode.ABORT) {
                    assertTrue("$id: an aborted pair has no status line", phone.get("state").isJsonNull)
                } else {
                    assertEquals(
                        "$id: statusLine", R.string.status_connected_unencrypted,
                        E2eStatusCopy.statusLine(E2eStatusCopy.stateOf(false, false))
                    )
                }
                continue
            }

            sealedRows++
            val state = E2eStatusCopy.stateOf(
                encrypted = true,
                verified = E2eSettings.requiresSas(mode),
            )
            assertEquals("$id: E2eStatusCopy state", phone.get("state").asString, state.name)
            val expectedRes = when (phone.get("statusLineKey").asString) {
                "status_connected_encrypted" -> R.string.status_connected_encrypted
                "status_connected_encrypted_unverified" -> R.string.status_connected_encrypted_unverified
                "status_connected_unencrypted" -> R.string.status_connected_unencrypted
                else -> throw AssertionError("$id: unknown statusLineKey")
            }
            assertEquals("$id: statusLine", expectedRes, E2eStatusCopy.statusLine(state))
            // Never colour-only, and never silently the same string for two states.
            assertTrue(
                "$id: verified and unverified must not collapse to one string",
                R.string.status_connected_encrypted != R.string.status_connected_encrypted_unverified
            )
        }
        assertEquals("four of the eight cells seal", 4, sealedRows)
    }

    /**
     * Row 4 again, spelled out by hand rather than driven from the file.
     *
     * A loop over vectors proves the implementation matches the file. It does
     * not prove the FILE still says the thing the row exists to say — deleting
     * row 4 would leave the loop green. So the claim is also written here, in
     * Kotlin, where a vector-file edit cannot reach it.
     */
    @Test
    fun row_four_seals_with_the_sas_not_blocking_on_this_side() {
        val mode = E2eSettings.effectiveMode(
            localEnabled = false,
            peer = E2eSettings.PeerAdvertisement.OFF,
        )
        assertEquals(E2eSettings.EffectiveMode.ENCRYPTED_UNVERIFIED, mode)
        assertTrue("a 0/0 pair with a capable peer SEALS", E2eSettings.isSealed(mode))
        assertFalse("and nobody is asked to confirm a code", E2eSettings.requiresSas(mode))
        assertEquals(
            "the phone must say Encrypted, unverified — not Not encrypted",
            R.string.status_connected_encrypted_unverified,
            E2eStatusCopy.statusLine(E2eStatusCopy.stateOf(encrypted = true, verified = false)),
        )
        // The control: if either side had asked, this same cell WOULD block.
        // If this stops holding, the assertion above has stopped measuring.
        val asked = E2eSettings.effectiveMode(false, E2eSettings.PeerAdvertisement.ON)
        assertTrue("row 8 control: a peer that asked makes the SAS blocking",
            E2eSettings.requiresSas(asked))
    }

    /**
     * T-PHONE-STATUS-MODE0 — FIXED in the vc64 android lane. This replaces the
     * earlier OBSERVATION test, which asserted that NO production sender for
     * ACTION_E2E_STATE existed and instructed its own deletion the moment one
     * did. It went red on the fix, exactly as designed.
     *
     * Kept as the inverse: the sender must exist and must stay. Deeper wiring
     * (the binder read on the status tick, the per-row production mapping)
     * lives in [E2eStatusCopyContractTest].
     */
    @Test
    fun production_broadcasts_the_e2e_state() {
        val main = File("src/main/java/com/dnkdialer/companion")
        assertTrue("main sources not found at " + main.absolutePath, main.isDirectory)
        val senders = main.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            // The only shape that can SEND it: an Intent built on the action.
            // Matching the bare constant would count MainActivity's RECEIVER
            // (the IntentFilter) as a sender.
            .filter { f -> f.readText().contains("Intent(E2eTofuContract.ACTION_E2E_STATE)") }
            .map { it.name }
            .toList()
        assertEquals(
            "T-PHONE-STATUS-MODE0: PhoneService must be the (single) production " +
                "sender of ACTION_E2E_STATE. Without it the status line can never " +
                "leave PLAINTEXT on a row-4 (0/0) pair, which asks no SAS.",
            listOf("PhoneService.kt"), senders
        )
    }
}
