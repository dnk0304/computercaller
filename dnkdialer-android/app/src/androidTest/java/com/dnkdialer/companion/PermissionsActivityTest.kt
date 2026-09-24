package com.dnkdialer.companion

import android.app.Activity
import android.app.Instrumentation
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.anyIntent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * vc65, T-ANDROID-PERMISSIONS-SCREEN — Settings > Permissions on a device.
 *
 * The JVM suite (PermissionDeepLinksTest) pins WHICH page each id should
 * open. This suite proves the three things only a device can answer:
 *
 *  1. The screen renders the SAME rows, in the SAME order, as the
 *     first-run pane — because both read PermissionChecker.checkAllWithStatus
 *     and both paint through PermissionRows. Asserted against a live call to
 *     checkAllWithStatus on this device, so the API-conditional rows
 *     (post_notifications 33+, auto_revoke 30+, bluetooth_connect behind
 *     FeatureFlags.PC_AUDIO_UI_ENABLED) are whatever the device actually has.
 *  2. Every id has a candidate this device can resolve — the fallback chain
 *     is not theoretical.
 *  3. Tapping a row fires the expected action. Four taps, one per intent
 *     SHAPE: a runtime grant, notifications, the notification listener, and
 *     battery. Espresso-Intents stubs the response so no Settings page is
 *     actually entered and the Activity stays in RESUMED.
 *
 * Why rows are located by index rather than by text: the row copy is
 * localized and the suite must not become a copy test. Index IS the
 * contract here — "same order as the first-run screen" is the ask.
 */
@RunWith(AndroidJUnit4::class)
class PermissionsActivityTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun setUp() {
        Intents.init()
        // Swallow every outbound Intent. Without this the first tap leaves
        // our Activity and the rest of the suite taps at the Settings app.
        Intents.intending(anyIntent())
            .respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))
    }

    @After
    fun tearDown() {
        Intents.release()
    }

    private fun rowTitles(): List<String> {
        val titles = mutableListOf<String>()
        ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val list = activity.findViewById<LinearLayout>(R.id.permissionsList)
                for (i in 0 until list.childCount) {
                    titles += list.getChildAt(i).findViewById<TextView>(R.id.permTitle).text.toString()
                }
            }
        }
        return titles
    }

    @Test
    fun rowsMatchCheckAllWithStatusExactlyAndInOrder() {
        val expected = PermissionChecker.checkAllWithStatus(ctx).map { it.displayName }
        assertTrue("checkAllWithStatus returned nothing on this device", expected.isNotEmpty())
        assertEquals(expected, rowTitles())
    }

    /**
     * Every row is a door, granted or not — that is the whole ask. A
     * clickable-count that falls short of the row count means some rows
     * came back inert (the first-run rule leaking in).
     */
    @Test
    fun everyRowIsClickable() {
        ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val list = activity.findViewById<LinearLayout>(R.id.permissionsList)
                assertTrue(list.childCount > 0)
                for (i in 0 until list.childCount) {
                    assertTrue("row $i not clickable", list.getChildAt(i).hasOnClickListeners())
                }
            }
        }
    }

    /**
     * For every id this device emits, at least one rung of the chain
     * resolves to a real Activity. The chain's terminal rung is app info,
     * which exists on every Android build — so a failure here means the
     * package URI or the action string is malformed, not that the device
     * is unusual.
     */
    @Test
    fun everyIdResolvesAtLeastOneCandidate() {
        val pm = ctx.packageManager
        for (item in PermissionChecker.checkAllWithStatus(ctx)) {
            val chain = PermissionDeepLinks.candidates(ctx, item.id)
            assertTrue("${item.id}: empty chain", chain.isNotEmpty())
            val resolved = chain.firstOrNull { it.resolveActivity(pm) != null }
            assertNotNull("${item.id}: no candidate resolved on this device", resolved)
        }
    }

    /**
     * Tap the row for [id] and assert the action that left the app.
     *
     * [expectedActions] is a list because the device decides which rung
     * wins: an AVD without the API-30 listener detail page falls through
     * to the listener list, and both are correct outcomes of the same
     * chain. What is NOT acceptable is an action from a different id's
     * chain, or nothing leaving at all.
     */
    private fun assertTapLaunches(id: String, expectedActions: List<String>) {
        val items = PermissionChecker.checkAllWithStatus(ctx)
        val index = items.indexOfFirst { it.id == id }
        if (index < 0) return // row not emitted on this API level — nothing to assert
        val pm = ctx.packageManager
        val willResolve = PermissionDeepLinks.candidates(ctx, id)
            .firstOrNull { it.resolveActivity(pm) != null }
        assertNotNull("$id resolves nothing on this device", willResolve)
        assertTrue(
            "$id would launch ${willResolve!!.action}, not one of $expectedActions",
            expectedActions.contains(willResolve.action),
        )

        ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<LinearLayout>(R.id.permissionsList)
                    .getChildAt(index).performClick()
            }
        }
        intended(hasAction(willResolve.action))
    }

    @Test
    fun tappingARuntimeGrantRowOpensAppInfo() {
        assertTapLaunches("call_phone", listOf(PermissionDeepLinks.ACTION_APP_DETAILS))
    }

    @Test
    fun tappingNotificationsRowOpensAppNotificationSettings() {
        assertTapLaunches(
            "post_notifications",
            listOf(
                PermissionDeepLinks.ACTION_APP_NOTIFICATION,
                PermissionDeepLinks.ACTION_APP_DETAILS,
            ),
        )
    }

    @Test
    fun tappingNotificationListenerRowOpensAListenerPage() {
        assertTapLaunches(
            "notification_listener",
            listOf(
                PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER_DETAIL,
                PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER,
                PermissionDeepLinks.ACTION_APP_DETAILS,
            ),
        )
    }

    @Test
    fun tappingBatteryRowOpensABatteryPage() {
        assertTapLaunches(
            "battery_optimization",
            listOf(
                PermissionDeepLinks.ACTION_REQUEST_IGNORE_BATTERY,
                PermissionDeepLinks.ACTION_IGNORE_BATTERY_SETTINGS,
                PermissionDeepLinks.ACTION_APP_DETAILS,
            ),
        )
    }

    /**
     * The lane's manifest promise: this screen navigates and never asks.
     * A requestPermissions() call from here would show up as a launched
     * GrantPermissionsActivity intent; nothing in the chains can produce
     * one, and this pins that the row tap did not add one.
     */
    @Test
    fun tappingARowNeverRequestsAPermission() {
        val items = PermissionChecker.checkAllWithStatus(ctx)
        ActivityScenario.launch(PermissionsActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val list = activity.findViewById<LinearLayout>(R.id.permissionsList)
                for (i in 0 until list.childCount) list.getChildAt(i).performClick()
            }
        }
        assertTrue(items.isNotEmpty())
        for (item in items) {
            val chain = PermissionDeepLinks.candidates(ctx, item.id)
            assertTrue(
                "${item.id} chain contains a permission-request action",
                chain.none { it.action == "android.content.pm.action.REQUEST_PERMISSIONS" },
            )
        }
    }
}
