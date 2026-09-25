package com.dnkdialer.companion

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * vc69 T-E2E-ACCOUNT-PREF step 2 — the Kotlin twin of step 1's
 * `resolveE2ePref` / `decideSet` / `decideSeed` (lib/e2ePref-core.js), run
 * against step 1's `tests/e2e-pref-vectors.json` — the SAME file the node
 * contract test and the relay proof read, never a copy. RULE 30.
 */
class E2ePrefResolveTwinTest {

    private val file = File("../../tests/e2e-pref-vectors.json")

    private fun root(): JsonObject {
        assertTrue("step-1 vector file missing at " + file.absolutePath, file.exists())
        return JsonParser.parseString(file.readText()).asJsonObject
    }

    private fun stored(row: JsonObject): Boolean? =
        row.get("e2ePref").let { if (it == null || it.isJsonNull) null else it.asBoolean }

    private fun onOff(b: Boolean) = if (b) "on" else "off"

    private fun JsonElement.nullableBool(): Boolean? = if (isJsonNull) null else asBoolean

    @Test
    fun resolve_rows() {
        val rows = root().getAsJsonArray("resolve").map { it.asJsonObject }
        assertEquals("resolve row count", 12, rows.size)
        for (r in rows) {
            val row = r.getAsJsonObject("row")
            val got = E2eAccountPref.resolve(
                stored(row), row.get("rev").asInt,
                r.get("masterEnabled").asBoolean, r.get("defaultOn").asBoolean,
            )
            val e = r.getAsJsonObject("expect")
            val id = r.get("id").asString
            assertEquals("$id preference", e.get("preference").asString, onOff(got.preference))
            assertEquals("$id effective", e.get("effective").asString, onOff(got.effective))
            assertEquals("$id pausedByServer", e.get("pausedByServer").asBoolean, got.pausedByServer)
            assertEquals("$id rev", e.get("rev").asInt, got.rev)
        }
    }

    @Test
    fun change_rows() {
        val rows = root().getAsJsonArray("change").map { it.asJsonObject }
        assertEquals("change row count", 24, rows.size)
        for (r in rows) {
            val id = r.get("id").asString
            val row = r.getAsJsonObject("row")
            val value = r.get("value").asString == "on"
            val defaultOn = r.get("defaultOn").asBoolean
            val e = r.getAsJsonObject("expect")
            val changed = E2eAccountPref.decideSet(stored(row), value, defaultOn)
            assertEquals("$id changed", e.get("changed").asBoolean, changed)
            val after = e.getAsJsonObject("after")
            assertNotNull("$id after", after)
            val storedAfter = after.get("storedAfter").nullableBool()
            val res = E2eAccountPref.resolve(storedAfter, 0, r.get("masterEnabled").asBoolean, defaultOn)
            assertEquals("$id after.preference", after.get("preference").asString, onOff(res.preference))
            assertEquals("$id after.effective", after.get("effective").asString, onOff(res.effective))
        }
    }

    @Test
    fun seed_rows() {
        val rows = root().getAsJsonArray("seed").map { it.asJsonObject }
        assertEquals("seed row count", 5, rows.size)
        for (r in rows) {
            val id = r.get("id").asString
            val (refused, applied) = E2eAccountPref.decideSeed(
                stored(r.getAsJsonObject("row")), r.get("value").asString == "on",
            )
            val e = r.getAsJsonObject("expect")
            assertEquals("$id refused", e.get("refused").asBoolean, refused)
            assertEquals("$id applied", e.get("applied").asBoolean, applied)
        }
    }
}
