package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * vc63 Amendment 1 — the app's night mode is DARK, pinned, with nothing that
 * can override it.
 *
 * Dennis, 2026-09-23 12:21Z: "default mode in android app should be dark
 * mode."
 *
 * Two halves, because the constant alone is not the claim:
 *
 *  1. [CompanionApp.NIGHT_MODE] is MODE_NIGHT_YES — a plain int comparison,
 *     which is all this can be on the JVM (this module has no Robolectric,
 *     so no Application can be created here). The ACTUAL resolution — that a
 *     launched Activity comes up night even while the DEVICE is set to light
 *     — is proved on a device by ThemeDefaultUiTest; a unit test that only
 *     read this constant would be asserting its own premise.
 *  2. Nothing else in the app sets a night mode, and no preference key
 *     carries one. That is the load-bearing half: the moment a second
 *     setDefaultNightMode call or a stored theme key exists, "pinned" stops
 *     being true and this file is where that shows up — not in a bug report
 *     about the app coming up white on someone's phone.
 */
class ThemeDefaultTest {

    private val mainSrc = File("src/main/java/com/dnkdialer/companion")

    @Test
    fun the_pinned_mode_is_dark() {
        // AppCompatDelegate.MODE_NIGHT_YES == 2, MODE_NIGHT_FOLLOW_SYSTEM == -1.
        // Spelled as literals because this source set cannot load the
        // androidx class; the constant's identity is re-checked on device.
        assertEquals("CompanionApp must pin MODE_NIGHT_YES (2)", 2, CompanionApp.NIGHT_MODE)
        assertNotEquals(
            "MODE_NIGHT_FOLLOW_SYSTEM (-1) is what Amendment 1 replaced",
            -1, CompanionApp.NIGHT_MODE
        )
    }

    @Test
    fun exactly_one_place_sets_the_night_mode() {
        val callers = kotlinSources()
            .filter { it.readText().contains("setDefaultNightMode") }
            .map { it.name }
            .sorted()
        assertEquals(
            "the night mode must be set in ONE place — a second caller is how " +
                "an app ends up in a mode nobody chose: $callers",
            listOf("CompanionApp.kt"), callers
        )
    }

    @Test
    fun no_stored_theme_preference_can_override_the_pin() {
        // Amendment 1 skipped "users with a saved choice keep it" because
        // there is no saved choice to keep. If a theme key is ever added,
        // that reasoning stops holding and the pin becomes a bug.
        val offenders = kotlinSources().filter { f ->
            val t = f.readText().lowercase()
            (t.contains("getsharedpreferences") || t.contains("putstring") || t.contains("putint")) &&
                (Regex("\"[a-z_]*(theme|night_mode|dark_mode)[a-z_]*\"").containsMatchIn(t))
        }.map { it.name }
        assertTrue(
            "a stored theme/night-mode preference appeared in $offenders — the " +
                "pin in CompanionApp is only honest while nothing can override it",
            offenders.isEmpty()
        )
    }

    /**
     * Fail loudly if the source tree cannot be read rather than passing on an
     * empty list: a scan that finds nothing because it looked nowhere is the
     * classic green-for-the-wrong-reason.
     */
    private fun kotlinSources(): List<File> {
        val files = mainSrc.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(
            "no Kotlin sources found under ${mainSrc.absolutePath} — this test " +
                "would pass by finding nothing",
            files.size > 20
        )
        return files
    }
}
