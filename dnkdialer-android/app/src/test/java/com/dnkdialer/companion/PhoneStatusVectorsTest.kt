package com.dnkdialer.companion

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * vc70 item 10 (PHONE-STATUS) — RULE 30 vectors, `tests/phone-status-vectors.json`.
 *
 * Every scenario is walked step by step through the REAL [PhoneConnStatus]
 * (event, then observe, then expect), with the live e2e state computed by
 * [PhoneConnStatus.liveState] — the function `PhoneService.currentE2eState`
 * calls. The source check at the bottom is what ties the two: a
 * currentE2eState that went back to the key-pin verdict (the 307e28a rule,
 * which is what said "verified" on Dennis's screen) fails there even though
 * every vector here would still pass.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*PhoneStatusVectors*'`
 */
class PhoneStatusVectorsTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/phone-status-vectors.json")

    private fun root(): JsonObject {
        assertTrue("vector file missing at ${file.absolutePath}", file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun scenarios(): List<JsonObject> =
        root().getAsJsonArray("scenarios").map { it.asJsonObject }

    private fun str(o: JsonObject, k: String): String? {
        val e: JsonElement? = o.get(k)
        return if (e == null || e.isJsonNull) null else e.asString
    }

    private fun obsOf(o: JsonObject) = PhoneConnStatus.Obs(
        nowMs = o.get("t").asLong,
        socketOpen = o.get("socket").asBoolean,
        pairActive = o.get("pairActive").asBoolean,
        pairKey = str(o, "pairKey"),
        e2e = PhoneConnStatus.liveState(
            sessionPresent = o.get("session").asBoolean,
            sasConfirmedThisPair = o.get("sasConfirmed").asBoolean,
        ),
        pendingSasPairingId = str(o, "pendingSas"),
    )

    private fun apply(m: PhoneConnStatus, ev: JsonObject, obs: PhoneConnStatus.Obs) {
        when (val type = ev.get("type").asString) {
            "switchSent" -> m.onSwitchSent(ev.get("on").asBoolean, str(ev, "activePairKey"), obs.nowMs)
            "writeRefused" -> m.onSwitchWriteRefused()
            "retrySent" -> m.onRetrySent(obs.nowMs)
            "refused" -> m.onRefused(str(ev, "pairingId"), ev.get("message").asString)
            "sasShown" -> m.onSasShown(ev.get("pairingId").asString)
            else -> throw AssertionError("unknown event type $type")
        }
    }

    private fun run(s: JsonObject): Int {
        val id = s.get("id").asString
        val timeout = root().get("resetTimeoutMs").asLong
        assertEquals("the file and the code must agree on the reset timeout", PhoneConnStatus.RESET_TIMEOUT_MS, timeout)
        val m = PhoneConnStatus(timeout)
        var checks = 0
        s.getAsJsonArray("steps").forEachIndexed { i, el ->
            val step = el.asJsonObject
            val where = "$id step $i"
            val obs = obsOf(step.getAsJsonObject("obs"))
            step.getAsJsonObject("event")?.let { apply(m, it, obs) }
            val v = m.observe(obs)
            val ex = step.getAsJsonObject("expect")
            assertEquals("$where label", str(ex, "label"), v.label?.name)
            assertEquals("$where footer", ex.get("footer").asBoolean, v.footer)
            assertEquals("$where refusal", str(ex, "refusal"), v.refusal)
            assertEquals("$where code screen", str(ex, "sas"), v.sasPairingId)
            checks += 4
            if (ex.has("retryPlan")) {
                val plan = m.retryPlan(obs)
                val want = ex.get("retryPlan")
                if (want.isJsonNull) {
                    assertNull("$where retryPlan", plan)
                } else {
                    val w = want.asJsonObject
                    assertEquals("$where retryPlan", PhoneConnStatus.RetryPlan(w.get("on").asBoolean, w.get("leaveOldPair").asBoolean), plan)
                }
                checks++
            }
        }
        return checks
    }

    private fun scenario(id: String): JsonObject =
        scenarios().firstOrNull { it.get("id").asString == id }
            ?: throw AssertionError("scenario $id is missing from the vector file")

    @Test fun v1_pinned_key_no_sas_is_no_code_check() { assertTrue(run(scenario("V1")) >= 4) }
    @Test fun v1_control_codes_checked() { run(scenario("V1-control-codes-checked")) }
    @Test fun v1_control_tls() { run(scenario("V1-control-tls")) }
    @Test fun v2_switch_flip_then_new_pair() { run(scenario("V2")) }
    @Test fun v2_resume_is_not_a_new_pair() { run(scenario("V2-resume-is-not-a-new-pair")) }
    @Test fun v2_no_pair_no_transient() { run(scenario("V2-no-pair-no-transient")) }
    @Test fun v3_refusal_cleared_by_new_pair() { run(scenario("V3")) }
    @Test fun v3_code_screen_dies_with_its_pair() { run(scenario("V3-sas-screen-dies-with-its-pair")) }
    @Test fun v3_code_screen_dies_on_socket_close() { run(scenario("V3-sas-screen-dies-on-socket-close")) }
    @Test fun r1_reset_timeout_footer_and_retry() { run(scenario("R1-reset-timeout-footer-and-retry")) }
    @Test fun r2_write_refused_footer_and_retry() { run(scenario("R2-write-refused-footer-and-retry")) }
    @Test fun dennis_0821_sequence() { run(scenario("DENNIS-0821")) }

    /** A vectors test whose file lost scenarios passes vacuously; it must not. */
    @Test
    fun every_scenario_in_the_file_is_walked() {
        val all = scenarios()
        assertEquals("12 scenarios", 12, all.size)
        var checks = 0
        for (s in all) checks += run(s)
        assertTrue("expected at least 100 cell checks, got $checks", checks >= 100)
    }

    @Test
    fun label_keys_resolve_to_the_production_string_ids() {
        val keys = root().getAsJsonObject("labelKeys")
        for (label in PhoneConnStatus.Label.values()) {
            val k = keys.getAsJsonObject(label.name)
            assertEquals("${label.name} status", stringId(k.get("status").asString), PhoneConnStatus.statusLine(label))
            assertEquals("${label.name} row", stringId(k.get("row").asString), PhoneConnStatus.rowLine(label))
        }
        assertEquals(4, PhoneConnStatus.Label.values().size)
    }

    private fun stringId(key: String): Int = when (key) {
        "status_connected_encrypted" -> R.string.status_connected_encrypted
        "status_connected_encrypted_unverified" -> R.string.status_connected_encrypted_unverified
        "status_connected_unencrypted" -> R.string.status_connected_unencrypted
        "status_switching" -> R.string.status_switching
        "home_e2e_now_verified" -> R.string.home_e2e_now_verified
        "home_e2e_now_unverified" -> R.string.home_e2e_now_unverified
        "home_e2e_now_plaintext" -> R.string.home_e2e_now_plaintext
        "home_e2e_now_switching" -> R.string.home_e2e_now_switching
        else -> throw AssertionError("unknown string key $key")
    }

    /**
     * The production wiring V1 depends on: PhoneService.currentE2eState goes
     * through [PhoneConnStatus.liveState] with THIS pair's SAS flag, and the
     * key-pin verdict (`e2eVerified`) is not an input to "verified".
     */
    @Test
    fun v1_production_status_reads_the_sas_flag_not_the_key_pin() {
        val src = File("src/main/java/com/dnkdialer/companion/PhoneService.kt").readText().replace("\r\n", "\n")
        val start = src.indexOf("fun currentE2eState()")
        assertTrue("currentE2eState is missing", start >= 0)
        val end = src.indexOf("private fun broadcastE2eState", start)
        assertTrue("could not slice currentE2eState", end > start)
        // Only the code, not the comments that explain the old bug.
        val code = src.substring(start, end).lines()
            .map { it.substringBefore("//").trim() }
            .filter { it.isNotEmpty() && !it.startsWith("*") && !it.startsWith("/*") }
            .joinToString("\n")
        assertTrue("currentE2eState must call PhoneConnStatus.liveState:\n$code", code.contains("PhoneConnStatus.liveState("))
        assertTrue(
            "verified must be THIS pair's SAS flag (and not while our own SAS is open):\n$code",
            code.contains("sasConfirmedThisPair = e2eSasConfirmedThisPair && !e2eSasPending"),
        )
        assertFalse("the key-pin verdict must not decide 'verified' (307e28a bug):\n$code", code.contains("e2eVerified"))
        // The flag is set from a MATCH only, and cleared with the session.
        assertTrue(src.contains("e2eSasConfirmedThisPair = sas == E2eSasGate.Verdict.MATCHED"))
        val tear = src.substring(src.indexOf("private fun tearDownE2e("))
        assertTrue("tearDownE2e must clear the flag", tear.substring(0, 1500).contains("e2eSasConfirmedThisPair = false"))
    }
}
