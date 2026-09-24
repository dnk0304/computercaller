package com.dnkdialer.companion

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

/**
 * vc65, T-ANDROID-PERMISSIONS-SCREEN — where a permission row goes when
 * the user taps it.
 *
 * ONE place decides, for a [PermissionChecker.PermissionStatusItem.id],
 * which OS page to open and what to fall back to when the device does
 * not have that page. [PermissionsActivity] is the only caller today;
 * the first-run pane keeps its own (narrower) behaviour so that screen
 * is unchanged by this lane.
 *
 * WHY A DESCRIPTOR LAYER
 * ----------------------
 * The decision — "notification_listener goes to the per-app listener
 * detail page on API 30+, else the listener list, else app info" — is
 * the part that can be wrong, and it is the part an emulator is the
 * worst place to check. So it lives in [specs], which is pure: it takes
 * an id and an SDK int and returns a list of [Spec] with no Context, no
 * android.jar and no device. `app/src/test` pins the whole table on the
 * JVM (PermissionDeepLinksTest).
 *
 * [candidates] is the thin half: it turns each [Spec] into a real
 * [Intent] for this package. It has the signature the brief locked
 * (`candidates(context, id): List<Intent>`); everything it knows beyond
 * the package name and the listener ComponentName comes from [specs].
 *
 * INVARIANT (asserted by the unit test for every id): the chain is
 * never empty, and its LAST entry is always app-info with a
 * `package:` URI. Android has no per-permission settings page for a
 * runtime grant — app info IS the correct destination — so every chain
 * has a destination that exists on every device since API 26.
 *
 * Out of scope on purpose (brief §3): RoleManager / default-app
 * prompts, and any runtime permission REQUEST. This screen navigates;
 * it never asks.
 */
object PermissionDeepLinks {

    /** What, if anything, gets attached to a [Spec]'s Intent. */
    enum class Payload {
        /** No data, no extras — a global Settings page. */
        NONE,

        /** `data = package:<pkg>` (the form Settings' per-app pages expect). */
        PACKAGE_URI,

        /** `EXTRA_APP_PACKAGE = <pkg>` (app notification settings, API 26+). */
        APP_PACKAGE_EXTRA,

        /** `EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME = <our listener>`. */
        LISTENER_COMPONENT,
    }

    /** One rung of a fallback chain: an action plus how to address it. */
    data class Spec(val action: String, val payload: Payload)

    /**
     * API 30+ per-app notification-listener page. Referenced as a
     * literal rather than `Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS`
     * so [specs] stays a pure JVM function with no android.jar on the
     * unit-test classpath. Value is the platform constant verbatim.
     */
    const val ACTION_NOTIFICATION_LISTENER_DETAIL =
        "android.settings.NOTIFICATION_LISTENER_DETAIL_SETTINGS"

    /** Companion extra for [ACTION_NOTIFICATION_LISTENER_DETAIL]. */
    const val EXTRA_NOTIFICATION_LISTENER_COMPONENT =
        "android.provider.extra.NOTIFICATION_LISTENER_COMPONENT_NAME"

    const val ACTION_APP_DETAILS = "android.settings.APPLICATION_DETAILS_SETTINGS"
    const val ACTION_APP_NOTIFICATION = "android.settings.APP_NOTIFICATION_SETTINGS"
    const val ACTION_NOTIFICATION_LISTENER = "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"
    const val ACTION_REQUEST_IGNORE_BATTERY = "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"
    const val ACTION_IGNORE_BATTERY_SETTINGS = "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"
    const val ACTION_AUTO_REVOKE = "android.intent.action.AUTO_REVOKE_PERMISSIONS"

    /** The terminal rung of every chain. */
    private val APP_INFO = Spec(ACTION_APP_DETAILS, Payload.PACKAGE_URI)

    /**
     * The ordered fallback chain for [id] on an API-[sdkInt] device.
     *
     * Pure. No Context, no device, no framework. An unknown id resolves
     * to app info rather than to an empty list — a row we forgot to
     * table still lands somewhere useful instead of toasting at the
     * user.
     */
    fun specs(id: String, sdkInt: Int): List<Spec> = when (id) {
        // Android exposes no per-permission page for a runtime grant.
        // App info is the page that lists them, so it is both the
        // primary target and the terminal rung.
        "call_phone", "read_phone_state", "answer_phone_calls",
        "read_contacts", "read_call_log",
        "read_sms", "send_sms", "receive_sms",
        "bluetooth_connect" -> listOf(APP_INFO)

        // API 26+ has a dedicated per-app notification page. minSdk is
        // 26, so the branch below is defensive rather than reachable —
        // it is kept because the table is read as a table.
        "post_notifications" ->
            if (sdkInt >= 26) { // Build.VERSION_CODES.O
                listOf(Spec(ACTION_APP_NOTIFICATION, Payload.APP_PACKAGE_EXTRA), APP_INFO)
            } else {
                listOf(APP_INFO)
            }

        // API 30+ can open OUR listener's own page. Below that (and on
        // devices that ship no such page) the global listener list is
        // the next best thing: it is where the toggle lives.
        "notification_listener" ->
            if (sdkInt >= 30) { // Build.VERSION_CODES.R
                listOf(
                    Spec(ACTION_NOTIFICATION_LISTENER_DETAIL, Payload.LISTENER_COMPONENT),
                    Spec(ACTION_NOTIFICATION_LISTENER, Payload.NONE),
                    APP_INFO,
                )
            } else {
                listOf(Spec(ACTION_NOTIFICATION_LISTENER, Payload.NONE), APP_INFO)
            }

        // The REQUEST_ variant is the one-tap system dialog and is what
        // PermissionChecker already fires; the IGNORE_ variant is the
        // full list, which some OEMs ship when the dialog is absent.
        "battery_optimization" -> listOf(
            Spec(ACTION_REQUEST_IGNORE_BATTERY, Payload.PACKAGE_URI),
            Spec(ACTION_IGNORE_BATTERY_SETTINGS, Payload.NONE),
            APP_INFO,
        )

        // Hibernation / auto-revoke is an API 30 concept. The row is
        // only emitted on 30+, so the else branch is defensive.
        "auto_revoke" ->
            if (sdkInt >= 30) { // Build.VERSION_CODES.R
                listOf(Spec(ACTION_AUTO_REVOKE, Payload.PACKAGE_URI), APP_INFO)
            } else {
                listOf(APP_INFO)
            }

        else -> listOf(APP_INFO)
    }

    /**
     * The ordered Intent chain for [id] on this device. Never empty;
     * the last entry is always app info (see the class header).
     */
    fun candidates(context: Context, id: String): List<Intent> =
        specs(id, Build.VERSION.SDK_INT).map { intentFor(context, it) }

    /** Materializes one [Spec] against this package. */
    private fun intentFor(context: Context, spec: Spec): Intent {
        val pkg = context.packageName
        return Intent(spec.action).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            when (spec.payload) {
                Payload.NONE -> Unit
                Payload.PACKAGE_URI -> data = Uri.fromParts("package", pkg, null)
                Payload.APP_PACKAGE_EXTRA -> {
                    putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                    // Some OEM builds read the legacy pair instead.
                    putExtra("app_package", pkg)
                    putExtra("app_uid", context.applicationInfo.uid)
                }
                Payload.LISTENER_COMPONENT -> putExtra(
                    EXTRA_NOTIFICATION_LISTENER_COMPONENT,
                    ComponentName(pkg, DnkNotificationListenerService::class.java.name)
                        .flattenToString(),
                )
            }
        }
    }

    /**
     * Walk [candidates] and start the first one the device can resolve.
     *
     * `resolveActivity` is the cheap check; the try/catch is the honest
     * one, because a page can resolve and still refuse us (a
     * SecurityException from a locked-down OEM Settings, or a race
     * where the component goes away between the two calls). Either way
     * we drop to the next rung rather than crash the screen.
     *
     * Returns the action that was launched, or null if nothing
     * resolved — in which case the user has been toasted.
     *
     * QueryPermissionsNeeded is suppressed rather than answered with a
     * <queries> element or QUERY_ALL_PACKAGES. API 30 package visibility
     * does not filter platform/system components, and every action in
     * every chain resolves to the Settings app — so resolveActivity
     * cannot be blinded here. It is also only the CHEAP check: the
     * try/catch below is what actually decides, and it would be correct
     * even if visibility filtering did apply.
     */
    @SuppressLint("QueryPermissionsNeeded")
    fun launch(activity: Activity, id: String): String? {
        for (intent in candidates(activity, id)) {
            if (intent.resolveActivity(activity.packageManager) == null) continue
            try {
                activity.startActivity(intent)
                DiagLog.d("PermissionDeepLinks", "$id -> ${intent.action}")
                return intent.action
            } catch (e: ActivityNotFoundException) {
                DiagLog.d("PermissionDeepLinks", "$id ${intent.action} not found: ${e.message}")
            } catch (e: SecurityException) {
                DiagLog.d("PermissionDeepLinks", "$id ${intent.action} denied: ${e.message}")
            }
        }
        Toast.makeText(activity, R.string.perms_deeplink_unavailable, Toast.LENGTH_LONG).show()
        return null
    }
}
