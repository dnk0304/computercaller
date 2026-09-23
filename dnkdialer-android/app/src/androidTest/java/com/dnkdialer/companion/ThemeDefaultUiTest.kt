package com.dnkdialer.companion

import android.content.res.Configuration
import android.content.res.Resources
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * vc63 Amendment 1 — the app comes up DARK, and comes up dark BECAUSE IT
 * SAYS SO, not because the device happened to agree.
 *
 * That distinction is the whole test. An assertion that only checked "the
 * Activity is in night mode" would pass on a dark emulator with the pin
 * removed — it would be measuring the device. So this asserts both halves
 * at once: the DEVICE's own configuration is light, and the ACTIVITY's is
 * night. Only an override can produce that pair.
 *
 * [Resources.getSystem] is the device's configuration, untouched by
 * AppCompatDelegate; the Activity's resources carry the override. If the AVD
 * is ever left on dark the test says so and skips the comparison rather than
 * quietly asserting nothing — a test that cannot tell the two apart must not
 * report success.
 */
@RunWith(AndroidJUnit4::class)
class ThemeDefaultUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun signIn() {
        TokenStore.save(ctx, "theme-default-test-not-a-real-token", "dennis@example.com")
    }

    @Test
    fun the_delegate_is_pinned_to_dark() {
        assertEquals(
            "CompanionApp.onCreate must leave the delegate on MODE_NIGHT_YES",
            AppCompatDelegate.MODE_NIGHT_YES,
            AppCompatDelegate.getDefaultNightMode()
        )
        assertEquals(
            "the constant the Application passes must be MODE_NIGHT_YES",
            AppCompatDelegate.MODE_NIGHT_YES, CompanionApp.NIGHT_MODE
        )
    }

    @Test
    fun home_resolves_to_night_even_though_the_device_is_light() {
        val deviceNight = Resources.getSystem().configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK
        assertEquals(
            "PRECONDITION: this AVD must be on the LIGHT system theme, or this " +
                "test cannot tell an override from agreement. Set it with " +
                "`adb shell cmd uimode night no` before the run.",
            Configuration.UI_MODE_NIGHT_NO, deviceNight
        )

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            scenario.onActivity { activity ->
                val appNight = activity.resources.configuration.uiMode and
                    Configuration.UI_MODE_NIGHT_MASK
                assertEquals(
                    "the app must override a light device and render dark",
                    Configuration.UI_MODE_NIGHT_YES, appNight
                )
                // And the RESOURCES follow the configuration, not just the
                // flag. A uiMode that said night while values/ still resolved
                // would be a theme-parent break, and the user would see a
                // white page under a "dark" app.
                val surface = activity.resources.getColor(R.color.surface_base, activity.theme)
                assertEquals(
                    "surface_base must resolve to the values-night token",
                    0xFF0B0B0D.toInt(), surface
                )
                assertTrue(
                    "surface_base must not be the light token #FAFAFA",
                    surface != 0xFFFAFAFA.toInt()
                )
            }
        }
    }
}
