package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * INC-0924 — the Encrypted-mode row and its preference migration, pinned to
 * `tests/e2e-mode-row-vectors.json`.
 *
 * ## Why a vector file for a one-surface table
 *
 * [E2eModeRowCopyTest] already walks this function, and it walked it while the
 * bug was in it: its `a_stored_true_never_renders_on_a_switch_that_cannot_be_
 * operated` case asserted the masking that caused the incident, and passed
 * every time. A test written from the same reading as the code agrees with the
 * code by construction.
 *
 * So the table is written out CELL BY CELL in a file, as data, with the
 * expected value spelled next to the input — `checked` is `checkedPref` in all
 * eight rows, visibly, rather than being derived by a loop that could be given
 * the same wrong rule twice. The migration rows are here for the same reason:
 * "reset a stored ON" and "never overwrite a deliberate choice" are two claims
 * that are easy to state and easy to implement as one.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eModeRowVectors*'`
 */
class E2eModeRowVectorsTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-mode-row-vectors.json")

    private fun root(): JsonObject {
        assertTrue(
            "the vector file is missing at " + file.absolutePath,
            file.exists()
        )
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun rows(): List<JsonObject> {
        val rows = root().getAsJsonArray("rows").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously. It must not:
        // the table is {4 capability states} x {pref OFF, ON}, exhaustively.
        assertEquals(
            "4 capability states x 2 preference values",
            E2ePeerCapability.State.values().size * 2,
            rows.size
        )
        return rows
    }

    private fun migrationRows(): List<JsonObject> {
        val rows = root().getAsJsonArray("migration").map { it.asJsonObject }
        assertEquals("{enabled} x {userSet}, exhaustively", 4, rows.size)
        return rows
    }

    /**
     * The string names in the vector file, resolved to the ids the copy table
     * returns.
     *
     * Written out rather than resolved reflectively on purpose: a lookup by
     * name would happily resolve a string this row was never meant to name,
     * and the whole point of spelling the key in the file is that a human can
     * read which sentence a cell promises.
     */
    private fun stringId(key: String): Int = when (key) {
        "settings_encrypted_mode_waiting" -> R.string.settings_encrypted_mode_waiting
        "settings_encrypted_mode_peer_old" -> R.string.settings_encrypted_mode_peer_old
        "settings_encrypted_mode_device_old" -> R.string.settings_encrypted_mode_device_old
        "settings_encrypted_mode_ready" -> R.string.settings_encrypted_mode_ready
        "settings_encrypted_mode_on_while_disabled" ->
            R.string.settings_encrypted_mode_on_while_disabled
        else -> throw AssertionError("the vector file names an unknown string: $key")
    }

    @Test
    fun every_cell_matches_the_vector_file() {
        val seen = HashSet<String>()
        for (row in rows()) {
            val id = row.get("id").asString
            val state = E2ePeerCapability.State.valueOf(row.get("capability").asString)
            val pref = row.get("checkedPref").asBoolean
            seen.add("$state:$pref")

            val copy = E2eModeRowCopy.forState(state, pref)
            assertEquals("$id enabled", row.get("enabled").asBoolean, copy.enabled)
            assertEquals("$id checked", row.get("checked").asBoolean, copy.checked)
            assertEquals("$id reason", stringId(row.get("reasonKey").asString), copy.reasonRes)

            val sub = row.get("subLine")
            if (sub == null || sub.isJsonNull) {
                assertNull("$id must carry no extra sub-line", copy.onWhileDisabledRes)
            } else {
                assertNotNull("$id must carry a sub-line", copy.onWhileDisabledRes)
                assertEquals("$id sub-line", stringId(sub.asString), copy.onWhileDisabledRes)
            }
        }
        // The file could name the same cell twice and still have eight rows.
        assertEquals("every (capability, preference) cell appears exactly once", 8, seen.size)
    }

    /**
     * THE incident assertion, stated once on its own so it cannot be lost in a
     * refactor of the loop above: the switch shows the stored preference, in
     * every capability state, with no masking. This is the value
     * `E2eNegotiation.decide()` reads at Accept, and the two disagreeing is
     * what made a phone pair encrypted while every screen said it was off.
     */
    @Test
    fun the_switch_shows_the_stored_preference_in_every_state() {
        for (state in E2ePeerCapability.State.values()) {
            for (pref in listOf(false, true)) {
                assertEquals(
                    "$state (pref=$pref): the switch must show the stored preference",
                    pref,
                    E2eModeRowCopy.forState(state, pref).checked
                )
            }
        }
    }

    /**
     * An un-masked ON on an inoperable control must always be explained. A
     * switch that is on, grey and silent is read as broken — and the user's
     * next move is to keep tapping it.
     */
    @Test
    fun a_stored_on_under_a_disabled_row_always_says_so() {
        for (state in E2ePeerCapability.State.values()) {
            val copy = E2eModeRowCopy.forState(state, checkedPref = true)
            if (copy.enabled) {
                assertNull("$state is operable — the sub-line would be noise", copy.onWhileDisabledRes)
            } else {
                assertEquals(
                    "$state: an ON pref on a disabled row must be explained",
                    R.string.settings_encrypted_mode_on_while_disabled,
                    copy.onWhileDisabledRes
                )
            }
            assertNull(
                "$state: an OFF pref needs no sub-line",
                E2eModeRowCopy.forState(state, checkedPref = false).onWhileDisabledRes
            )
        }
    }

    // ------------------------------------------------------------- migration

    @Test
    fun the_migration_matches_the_vector_file() {
        for (row in migrationRows()) {
            val id = row.get("id").asString
            val decision = E2eSettings.legacyPrefMigration(
                row.get("enabled").asBoolean,
                row.get("userSet").asBoolean,
            )
            assertEquals(
                "$id: ${row.get("label")?.asString ?: ""}",
                E2eSettings.LegacyPrefMigration.valueOf(row.get("decision").asString),
                decision
            )
        }
    }

    /**
     * The migration runs ONCE. After a reset the stored value is OFF, so the
     * decision on the next service start is NONE — without this, a device
     * would be re-reset on every boot and a user who turned the mode back on
     * between two boots would silently lose it.
     */
    @Test
    fun the_migration_is_idempotent() {
        assertEquals(
            E2eSettings.LegacyPrefMigration.RESET_TO_OFF,
            E2eSettings.legacyPrefMigration(enabled = true, userSet = false)
        )
        // what the device looks like immediately afterwards
        assertEquals(
            E2eSettings.LegacyPrefMigration.NONE,
            E2eSettings.legacyPrefMigration(enabled = false, userSet = false)
        )
        // and after the user flips it back on (the flip writes the marker)
        assertEquals(
            E2eSettings.LegacyPrefMigration.NONE,
            E2eSettings.legacyPrefMigration(enabled = true, userSet = true)
        )
    }
}
