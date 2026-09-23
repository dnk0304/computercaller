package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * T-PHONE-STATUS-MODE0 — the phone status LINE half of the cross-surface
 * contract (RESUME-PROTOCOL v3.0 RULE 30), reading the SAME
 * `tests/e2e-sas-blocking-vectors.json` the web lane reads.
 *
 * [E2eSasBlockingContractTest] pins the decision TABLE
 * ([E2eSettings.effectiveMode] -> [E2eStatusCopy.stateOf]). That table was
 * already right on row 4 and the phone STILL said "Connected · Not
 * encrypted", because the bug was in the WIRING above the table:
 * `E2eTofuContract.ACTION_E2E_STATE` was registered and consumed by
 * MainActivity but had NO SENDER anywhere in app/src/main, so `e2eState`
 * could only leave its PLAINTEXT initialiser via the optimistic set on a
 * CONFIRMED SAS — which on a row-4 (0/0) pair never happens, because row 4
 * asks for no SAS. Same pair, two stories: the extension said "Encrypted,
 * but nobody confirmed the code".
 *
 * So this file asserts two things a pure table test structurally cannot:
 *
 *  1. the PRODUCTION inputs — "is there a live session" and "is it verified",
 *     which is exactly what `PhoneService.currentE2eState()` passes — map to
 *     each vector row's `statusLineKey`; and
 *  2. the wiring itself exists in the source: PhoneService SENDS
 *     ACTION_E2E_STATE, and MainActivity reads `currentE2eState()` on its
 *     status tick rather than trusting it caught the broadcast edge.
 *
 * (2) is a source-text assertion on purpose. A unit test cannot instantiate a
 * Service, and every behavioural test that could be written here would pass
 * against the broken build too — the table it exercises was never wrong.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*StatusCopyContract*' --rerun-tasks`
 */
class E2eStatusCopyContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`. */
    private val vectors = File("../../tests/e2e-sas-blocking-vectors.json")
    private val mainSrc = File("src/main/java/com/dnkdialer/companion")

    private fun rows(): List<JsonObject> {
        assertTrue(
            "shared vector file missing at ${vectors.absolutePath}",
            vectors.exists(),
        )
        val root = JsonParser.parseString(vectors.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        val rows = root.getAsJsonArray("rows").map { it.asJsonObject }
        assertEquals("the §13.2 matrix is 2x2x2", 8, rows.size)
        return rows
    }

    private fun source(name: String): String {
        val f = File(mainSrc, name)
        assertTrue(
            "product source missing at ${f.absolutePath} — this test must be " +
                "run with cwd = dnkdialer-android/app",
            f.exists(),
        )
        return f.readText()
    }

    // ---- (1) the production mapping, per vector row -----------------------

    @Test
    fun production_inputs_map_to_every_row_status_line() {
        var sealedUnverified = 0
        for (row in rows()) {
            val id = row.get("id").asString
            val phone = row.getAsJsonObject("phone")
            val key = phone.get("statusLineKey")
            // ABORT rows show no status line at all — nothing to map.
            if (key.isJsonNull) continue

            // Exactly what PhoneService.currentE2eState() passes:
            //   encrypted = e2eSession != null   (a session exists iff sealed)
            //   verified  = e2eVerified          (the pin verdict)
            val sessionPresent = phone.get("sealed").asBoolean
            val verified = phone.get("effectiveMode").asString == "ENCRYPTED_VERIFIED"

            val state = E2eStatusCopy.stateOf(sessionPresent, verified)
            assertEquals("$id: state", phone.get("state").asString, state.name)

            val expected = when (key.asString) {
                "status_connected_encrypted" -> R.string.status_connected_encrypted
                "status_connected_encrypted_unverified" ->
                    R.string.status_connected_encrypted_unverified
                "status_connected_unencrypted" -> R.string.status_connected_unencrypted
                else -> throw AssertionError("$id: unknown statusLineKey ${key.asString}")
            }
            assertEquals("$id: statusLine", expected, E2eStatusCopy.statusLine(state))
            if (state == E2eStatusCopy.State.ENCRYPTED_UNVERIFIED) sealedUnverified++
        }
        // row-4-M1 is the row this whole ticket exists for. If the vector file
        // ever loses it, this test must fail rather than pass on the easy rows.
        assertEquals("row-4-M1 (0/0 sealed) must be present", 1, sealedUnverified)
    }

    @Test
    fun a_sealed_unverified_pair_is_never_called_unencrypted() {
        val state = E2eStatusCopy.stateOf(encrypted = true, verified = false)
        assertEquals(E2eStatusCopy.State.ENCRYPTED_UNVERIFIED, state)
        assertTrue(
            "the 0/0 line must not collapse onto the plaintext string",
            E2eStatusCopy.statusLine(state) != R.string.status_connected_unencrypted,
        )
    }

    // ---- (2) the wiring that was actually missing --------------------------

    @Test
    fun phone_service_sends_the_state_broadcast() {
        val src = source("PhoneService.kt")
        assertTrue(
            "PhoneService must SEND E2eTofuContract.ACTION_E2E_STATE — it had " +
                "no sender at 8df35c6, which is the whole bug",
            src.contains("Intent(E2eTofuContract.ACTION_E2E_STATE)"),
        )
        assertTrue(
            "PhoneService must expose the live state to the bound Activity",
            src.contains("fun currentE2eState()"),
        )
        assertTrue(
            "the state must be broadcast when a session is armed",
            src.contains("broadcastE2eState()"),
        )
    }

    @Test
    fun main_activity_reads_the_live_state_not_only_the_edge() {
        val src = source("MainActivity.kt")
        assertTrue(
            "MainActivity must read PhoneService.currentE2eState() on its " +
                "status tick; a broadcast edge alone is missed by an Activity " +
                "that bound after the Accept or was recreated",
            src.contains("phoneService?.currentE2eState()"),
        )
        assertTrue(
            "the ACTION_E2E_STATE receiver stays — it makes the line correct " +
                "immediately rather than on the next 2 s tick",
            src.contains("E2eTofuContract.ACTION_E2E_STATE"),
        )
    }

    @Test
    fun the_wiring_assertions_can_fail() {
        // Detector control (memory: an assertion that cannot fire is not
        // evidence). Prove the same predicate goes RED on text that lacks the
        // wiring, so a green above means the source really carries it.
        val notWired = "class PhoneService { fun onStartCommand() {} }"
        assertTrue(
            "control: the predicate must reject unwired source",
            !notWired.contains("Intent(E2eTofuContract.ACTION_E2E_STATE)") &&
                !notWired.contains("phoneService?.currentE2eState()"),
        )
    }
}
