package com.dnkdialer.companion

import android.graphics.Bitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.switchmaterial.SwitchMaterial
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * P4 (s5) screenshot fixture — NOT a product test.
 *
 * Two reasons this runs as instrumentation rather than from adb:
 *  - SettingsActivity bounces to SignInActivity without a stored phoneToken,
 *    so the device has to look signed in. A throwaway token is seeded into
 *    [TokenStore] and cleared again at the end.
 *  - SettingsActivity is not exported, so `am start` from the shell uid is a
 *    Permission Denial. Instrumentation runs with the app's own identity.
 *
 * Lives in androidTest, so none of this is in any shipped APK, and the token
 * is obvious junk that authenticates nothing.
 *
 * The screenshot is evidence, but it is not the ASSERTION: the facts a
 * reviewer would have to squint at a PNG for are checked directly against the
 * live view tree — the switch is disabled, it is unchecked, the reason line
 * is the "waiting" copy, and no visible string says "end-to-end".
 */
@RunWith(AndroidJUnit4::class)
class SettingsScreenshotHelper {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Test
    fun captureEncryptedModeRow() {
        TokenStore.save(ctx, "screenshot-fixture-not-a-real-token", "dennis@example.com")
        assertTrue("fixture token did not persist", TokenStore.hasToken(ctx))

        // Part 1 must never offer the toggle: there is no crypto behind it.
        val state = E2ePeerCapability.current(ctx)
        assertEquals(
            "Part 1 stub must report UNKNOWN on a capable device",
            E2ePeerCapability.State.UNKNOWN, state
        )
        assertFalse(E2ePeerCapability.isToggleEnabled(state))

        try {
            ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    val toggle =
                        activity.findViewById<SwitchMaterial>(R.id.settingsEncryptedModeToggle)
                    val reason =
                        activity.findViewById<android.widget.TextView>(R.id.settingsEncryptedModeReason)

                    assertFalse("the Encrypted mode switch must be DISABLED", toggle.isEnabled)
                    assertFalse("the Encrypted mode switch must be UNCHECKED", toggle.isChecked)
                    assertEquals(
                        "greyed control must carry the waiting reason",
                        activity.getString(R.string.settings_encrypted_mode_waiting),
                        reason.text.toString()
                    )
                    // The copy rule, checked against what is actually on screen.
                    assertNoEndToEndClaim(activity.window.decorView)
                }
                instr.waitForIdleSync()
                Thread.sleep(500) // let the switch settle before the capture
                capture("v58-settings-encrypted-mode.png")
            }
        } finally {
            TokenStore.clear(ctx)
            assertFalse("fixture token was not cleared", TokenStore.hasToken(ctx))
        }
    }

    /**
     * Walk the live view tree and fail on any visible text claiming
     * "end-to-end". A grep over strings.xml would not prove this — the string
     * could be built at runtime, and an unused resource would false-positive.
     */
    private fun assertNoEndToEndClaim(root: android.view.View) {
        if (root is android.view.ViewGroup) {
            for (i in 0 until root.childCount) assertNoEndToEndClaim(root.getChildAt(i))
        }
        if (root is android.widget.TextView) {
            val text = root.text?.toString()?.lowercase().orEmpty()
            assertFalse(
                "user-visible copy claims end-to-end: '${root.text}'",
                text.contains("end-to-end") || text.contains("end to end")
            )
        }
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
