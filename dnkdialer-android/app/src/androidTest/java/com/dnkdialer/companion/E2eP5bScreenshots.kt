package com.dnkdialer.companion

import android.content.Intent
import android.graphics.Bitmap
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * E2E programme P5b — screenshot evidence for (b), (c) and (d), light and
 * dark.
 *
 * A fixture, not a product test, in the shape [SettingsScreenshotHelper]
 * established: the PNG is evidence, but the facts a reviewer would otherwise
 * have to squint at are asserted against the live view tree first. A
 * screenshot proves a screen rendered; it does not prove it said the right
 * thing, and the assertions here are what make the PNG worth keeping.
 *
 * Both themes are captured by forcing [AppCompatDelegate]'s night mode rather
 * than by changing a device setting, so the run is self-contained and does not
 * leave the emulator in a different state than it found it.
 */
@RunWith(AndroidJUnit4::class)
class E2eP5bScreenshots {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun signIn() {
        TokenStore.save(ctx, "p5b-screenshot-fixture-not-a-real-token", "dennis@example.com")
    }

    @After
    fun tearDown() {
        setNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        TokenStore.clear(ctx)
    }

    @Test
    fun captureAllFacesInBothThemes() {
        for ((suffix, mode) in listOf(
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
        )) {
            setNightMode(mode)

            // (b) the Settings row, in the state a user can actually operate.
            ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.capabilityOverride = E2ePeerCapability.State.PEER_SUPPORTED
                    activity.refreshEncryptedModeRowForTest()
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                settle()
                capture("p5b-settings-encrypted-mode-$suffix.png")
            }

            // (c) the SAS confirm and (d) the key-change warning, on Home.
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()

                broadcast(
                    Intent(E2eSasContract.ACTION_E2E_SAS_REQUIRED)
                        .putExtra(PhoneService.EXTRA_PAIRING_ID, "shot-sas")
                        .putExtra(E2eSasContract.EXTRA_SAS_DIGITS, "412908")
                )
                scenario.onActivity { activity ->
                    val shown = CopyRules.visibleText(activity.window.decorView)
                    assertTrue(
                        "the SAS face is not on screen for the $suffix capture: $shown",
                        shown.any { it.contains("412 908") }
                    )
                    assertTrue(shown.any { it == "Same code on your computer?" })
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                settle()
                capture("p5b-sas-confirm-$suffix.png")

                broadcast(
                    Intent(E2eTofuContract.ACTION_E2E_KEY_CHANGED)
                        .putExtra(PhoneService.EXTRA_PAIRING_ID, "shot-tofu")
                )
                scenario.onActivity { activity ->
                    val shown = CopyRules.visibleText(activity.window.decorView)
                    assertTrue(
                        "the key-change face is not on screen for the $suffix capture: $shown",
                        shown.any { it == ctx.getString(R.string.e2e_key_change_title) }
                    )
                    // Never colour-only: both answers must be readable words.
                    CopyRules.assertStateIsNotColourOnly(
                        activity.window.decorView, "Trust", "Not now"
                    )
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                settle()
                capture("p5b-key-change-$suffix.png")
            }
        }

        val dir = File(ctx.getExternalFilesDir(null), "screenshots")
        val shots = dir.listFiles { f -> f.name.startsWith("p5b-") }?.size ?: 0
        assertEquals("expected 6 captures (3 faces x 2 themes)", 6, shots)
    }

    private fun setNightMode(mode: Int) {
        instr.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
        instr.waitForIdleSync()
    }

    private fun broadcast(intent: Intent) {
        ctx.sendBroadcast(intent.setPackage(ctx.packageName))
        Thread.sleep(400)
        instr.waitForIdleSync()
    }

    /** Let the recreate-on-theme-change and any animation land before capture. */
    private fun settle() {
        instr.waitForIdleSync()
        Thread.sleep(600)
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
