package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * vc65, T-ANDROID-PERMISSIONS-SCREEN — the deep-link table, pinned.
 *
 * [PermissionDeepLinks.specs] is the part of the feature that can be
 * silently wrong: a chain that lands on the wrong Settings page still
 * opens SOMETHING, so an emulator run reads as a pass while the user is
 * dropped on a page that has nothing to do with the row they tapped.
 * These rows pin the destination per id, so a future edit to the when()
 * has to say so out loud.
 *
 * The ids are transcribed from PermissionChecker.checkAllWithStatus in
 * ITS order, not read back out of PermissionDeepLinks — a proof built
 * from the subject's own list proves the parser, not the list. [IDS]
 * doubling as the order assertion is deliberate for the same reason.
 *
 * Pure JVM: specs() takes an Int, not a Context, so no android.jar and
 * no device are on this classpath.
 */
class PermissionDeepLinksTest {

    /**
     * Every id checkAllWithStatus can emit, in its emission order.
     * Transcribed from PermissionChecker, not generated.
     */
    private val IDS = listOf(
        "post_notifications",
        "notification_listener",
        "call_phone",
        "read_phone_state",
        "answer_phone_calls",
        "read_contacts",
        "read_call_log",
        "read_sms",
        "send_sms",
        "receive_sms",
        "bluetooth_connect",
        "battery_optimization",
        "auto_revoke",
    )

    /** The API levels the app ships on: minSdk .. targetSdk, plus the hinges. */
    private val SDKS = listOf(26, 29, 30, 31, 33, 34, 36)

    private val APP_INFO = PermissionDeepLinks.ACTION_APP_DETAILS

    // ── invariants that must hold for EVERY id on EVERY shipped API ──────

    @Test
    fun everyIdHasANonEmptyChainOnEveryApi() {
        for (sdk in SDKS) for (id in IDS) {
            assertTrue(
                "$id on API $sdk has no candidates",
                PermissionDeepLinks.specs(id, sdk).isNotEmpty()
            )
        }
    }

    @Test
    fun lastRungIsAlwaysAppInfoWithPackageUri() {
        for (sdk in SDKS) for (id in IDS) {
            val last = PermissionDeepLinks.specs(id, sdk).last()
            assertEquals("$id on API $sdk last action", APP_INFO, last.action)
            assertEquals(
                "$id on API $sdk last payload",
                PermissionDeepLinks.Payload.PACKAGE_URI,
                last.payload,
            )
        }
    }

    @Test
    fun noChainRepeatsAnAction() {
        for (sdk in SDKS) for (id in IDS) {
            val actions = PermissionDeepLinks.specs(id, sdk).map { it.action }
            assertEquals(
                "$id on API $sdk repeats an action: $actions",
                actions.size, actions.distinct().size,
            )
        }
    }

    /**
     * An id we have not tabled must still land somewhere real rather
     * than returning an empty list the launcher would toast on.
     */
    @Test
    fun unknownIdFallsBackToAppInfo() {
        val chain = PermissionDeepLinks.specs("some_future_permission", 34)
        assertEquals(1, chain.size)
        assertEquals(APP_INFO, chain[0].action)
    }

    // ── the per-id table (the part a wrong edit would change) ────────────

    /**
     * Primary (first) action per id on API 34 — the AVD the gate runs.
     * Transcribed from the brief's chain table.
     */
    @Test
    fun primaryActionPerIdOnApi34() {
        val expected = mapOf(
            "post_notifications" to PermissionDeepLinks.ACTION_APP_NOTIFICATION,
            "notification_listener" to PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER_DETAIL,
            "call_phone" to APP_INFO,
            "read_phone_state" to APP_INFO,
            "answer_phone_calls" to APP_INFO,
            "read_contacts" to APP_INFO,
            "read_call_log" to APP_INFO,
            "read_sms" to APP_INFO,
            "send_sms" to APP_INFO,
            "receive_sms" to APP_INFO,
            "bluetooth_connect" to APP_INFO,
            "battery_optimization" to PermissionDeepLinks.ACTION_REQUEST_IGNORE_BATTERY,
            "auto_revoke" to PermissionDeepLinks.ACTION_AUTO_REVOKE,
        )
        // Guards against the map drifting out of step with the id list.
        assertEquals(IDS.toSet(), expected.keys)
        for ((id, action) in expected) {
            assertEquals(
                "$id primary action on API 34",
                action,
                PermissionDeepLinks.specs(id, 34).first().action,
            )
        }
    }

    /**
     * The nine runtime grants have exactly ONE rung: Android has no
     * per-permission page, so app info is both primary and terminal.
     * A future edit that bolts a RoleManager prompt onto one of these
     * (explicitly out of scope) fails here.
     */
    @Test
    fun runtimeGrantsAreAppInfoOnly() {
        val runtime = listOf(
            "call_phone", "read_phone_state", "answer_phone_calls",
            "read_contacts", "read_call_log",
            "read_sms", "send_sms", "receive_sms", "bluetooth_connect",
        )
        for (sdk in SDKS) for (id in runtime) {
            val chain = PermissionDeepLinks.specs(id, sdk)
            assertEquals("$id on API $sdk", 1, chain.size)
            assertEquals(APP_INFO, chain[0].action)
        }
    }

    @Test
    fun postNotificationsCarriesTheAppPackageExtraNotAPackageUri() {
        val first = PermissionDeepLinks.specs("post_notifications", 33).first()
        assertEquals(PermissionDeepLinks.ACTION_APP_NOTIFICATION, first.action)
        assertEquals(PermissionDeepLinks.Payload.APP_PACKAGE_EXTRA, first.payload)
    }

    @Test
    fun notificationListenerPrefersTheDetailPageFromApi30() {
        val below = PermissionDeepLinks.specs("notification_listener", 29).map { it.action }
        assertEquals(
            listOf(PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER, APP_INFO),
            below,
        )
        assertFalse(below.contains(PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER_DETAIL))

        val at30 = PermissionDeepLinks.specs("notification_listener", 30)
        assertEquals(
            listOf(
                PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER_DETAIL,
                PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER,
                APP_INFO,
            ),
            at30.map { it.action },
        )
        assertEquals(PermissionDeepLinks.Payload.LISTENER_COMPONENT, at30[0].payload)
    }

    @Test
    fun batteryChainIsRequestThenListThenAppInfo() {
        for (sdk in SDKS) {
            assertEquals(
                "API $sdk",
                listOf(
                    PermissionDeepLinks.ACTION_REQUEST_IGNORE_BATTERY,
                    PermissionDeepLinks.ACTION_IGNORE_BATTERY_SETTINGS,
                    APP_INFO,
                ),
                PermissionDeepLinks.specs("battery_optimization", sdk).map { it.action },
            )
        }
        assertEquals(
            PermissionDeepLinks.Payload.PACKAGE_URI,
            PermissionDeepLinks.specs("battery_optimization", 34).first().payload,
        )
    }

    @Test
    fun autoRevokeIsApi30Plus() {
        assertEquals(
            listOf(APP_INFO),
            PermissionDeepLinks.specs("auto_revoke", 29).map { it.action },
        )
        assertEquals(
            listOf(PermissionDeepLinks.ACTION_AUTO_REVOKE, APP_INFO),
            PermissionDeepLinks.specs("auto_revoke", 30).map { it.action },
        )
    }

    /**
     * The platform constants these literals stand in for. Transcribed
     * from the Android SDK, not read back from the object — if someone
     * "tidies" one of the strings, this fails rather than the phone
     * silently opening nothing.
     */
    @Test
    fun actionStringsMatchThePlatformConstants() {
        assertEquals(
            "android.settings.APPLICATION_DETAILS_SETTINGS",
            PermissionDeepLinks.ACTION_APP_DETAILS,
        )
        assertEquals(
            "android.settings.APP_NOTIFICATION_SETTINGS",
            PermissionDeepLinks.ACTION_APP_NOTIFICATION,
        )
        assertEquals(
            "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS",
            PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER,
        )
        assertEquals(
            "android.settings.NOTIFICATION_LISTENER_DETAIL_SETTINGS",
            PermissionDeepLinks.ACTION_NOTIFICATION_LISTENER_DETAIL,
        )
        assertEquals(
            "android.provider.extra.NOTIFICATION_LISTENER_COMPONENT_NAME",
            PermissionDeepLinks.EXTRA_NOTIFICATION_LISTENER_COMPONENT,
        )
        assertEquals(
            "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
            PermissionDeepLinks.ACTION_REQUEST_IGNORE_BATTERY,
        )
        assertEquals(
            "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
            PermissionDeepLinks.ACTION_IGNORE_BATTERY_SETTINGS,
        )
        assertEquals(
            "android.intent.action.AUTO_REVOKE_PERMISSIONS",
            PermissionDeepLinks.ACTION_AUTO_REVOKE,
        )
    }
}
