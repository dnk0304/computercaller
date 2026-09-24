package com.dnkdialer.companion

import android.graphics.Bitmap
import android.widget.LinearLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * vc65 evidence fixture for T-ANDROID-PERMISSIONS-SCREEN — NOT a product
 * test. The assertions live in [PermissionsActivityTest]; this only puts
 * pixels on disk for the brief's evidence folder.
 *
 * It runs as instrumentation for the same two reasons
 * [SettingsScreenshotHelper] does: SettingsActivity bounces to
 * SignInActivity without a stored phoneToken, and neither it nor
 * PermissionsActivity is exported, so `am start` from the shell uid is a
 * Permission Denial. Instrumentation runs with the app's own identity.
 *
 * The throwaway token is cleared in a finally, and none of this is in any
 * shipped APK.
 *
 * Light/dark is driven from outside (`adb shell cmd uimode night yes|no`)
 * rather than from here: forcing the mode in-process restarts the Activity
 * mid-capture, which is how you get a screenshot of a half-drawn screen.
 */
@RunWith(AndroidJUnit4::class)
class PermissionsScreenshots {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    /** Suffix so a light and a dark run do not overwrite each other. */
    private val suffix: String
        get() = InstrumentationRegistry.getArguments().getString("shotSuffix") ?: "light"

    @Test
    fun captureSettingsRowAndPermissionsScreen() {
        TokenStore.save(ctx, "screenshot-fixture-not-a-real-token", "dennis@example.com")
        assertTrue("fixture token did not persist", TokenStore.hasToken(ctx))
        try {
            ActivityScenario.launch(SettingsActivity::class.java).use {
                instr.waitForIdleSync()
                Thread.sleep(700)
                capture("vc65-settings-row-$suffix.png")
            }

            ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    val list = activity.findViewById<LinearLayout>(R.id.permissionsList)
                    assertTrue("no rows rendered — nothing to photograph", list.childCount > 0)
                }
                instr.waitForIdleSync()
                Thread.sleep(700)
                capture("vc65-permissions-$suffix.png")
            }
        } finally {
            TokenStore.clear(ctx)
            assertFalse("fixture token was not cleared", TokenStore.hasToken(ctx))
        }
    }

    /**
     * Tap the row named by the `tapId` runner argument and photograph
     * wherever the phone actually went. No Intents stubbing here on
     * purpose: the point of the shot is the REAL OS page, so the intent
     * must be allowed to leave.
     */
    @Test
    fun captureDeepLinkDestination() {
        val id = InstrumentationRegistry.getArguments().getString("tapId") ?: return
        TokenStore.save(ctx, "screenshot-fixture-not-a-real-token", "dennis@example.com")
        try {
            val index = PermissionChecker.checkAllWithStatus(ctx).indexOfFirst { it.id == id }
            assertTrue("row $id is not emitted on this device", index >= 0)
            ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<LinearLayout>(R.id.permissionsList)
                        .getChildAt(index).performClick()
                }
                Thread.sleep(3500) // let the Settings page draw
                capture("vc65-deeplink-$id.png")
            }
        } finally {
            TokenStore.clear(ctx)
        }
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
