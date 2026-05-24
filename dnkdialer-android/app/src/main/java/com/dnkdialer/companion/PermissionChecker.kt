package com.dnkdialer.companion

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * Runtime + special-access grant checker. The fix for Samsung One UI (and
 * other aggressive OEMs — OnePlus, Xiaomi, Huawei) silently revoking
 * permissions in the background even with "Don't optimize" + auto-launch
 * + lock-it-in-recents all configured.
 *
 * Strategy: don't try to outsmart the OEM. Detect when it has fought us,
 * and route the user to the fix immediately on app open. MainActivity
 * calls [checkAll] in onCreate AND onResume; if the list is non-empty,
 * the main pane is hidden and a blocking permissions-required pane is
 * shown until every entry resolves.
 *
 * Round 8 — each [MissingPermission] now carries a [kind] that lets the
 * UI distinguish between standard runtime grants (re-requestable via the
 * OS-native popup) and special-access grants (Notification Listener,
 * Battery optimization — only re-grantable via a Settings deep-link).
 * MainActivity's "Grant All" flow uses this to batch all RUNTIME entries
 * into one ActivityCompat.requestPermissions() call and then walk the
 * user sequentially through the SPECIAL entries via Settings.
 *
 * Ordering inside [checkAll] is intentional: the list is rendered in
 * order, and the user sees the most-critical-to-app-function items at
 * the top of the scroll. Anything that breaks the core call-bridge flow
 * (Phone, Contacts, Notifications, Notification Listener, Battery)
 * comes before secondary surfaces (SMS, Camera).
 */
object PermissionChecker {

    /**
     * Distinguishes a standard Android runtime permission (can be granted
     * via the OS-native runtime popup) from a special-access grant (can
     * ONLY be granted via a Settings deep-link — Notification Listener
     * and Battery optimization fall into this category). MainActivity's
     * Grant All flow needs to know which is which so it can batch
     * runtime requests into a single popup and handle special grants
     * separately.
     */
    enum class Kind { RUNTIME, SPECIAL }

    /**
     * One missing-permission row, fully described so the UI layer doesn't
     * have to know the difference between a runtime permission and a
     * special-access grant.
     *
     *  - [id]: stable string id, used for diagnostics + debugging.
     *  - [kind]: see [Kind] kdoc.
     *  - [manifestPermission]: for RUNTIME entries, the Manifest constant
     *    that ActivityCompat.requestPermissions accepts. Null for SPECIAL
     *    entries (no runtime constant exists for them).
     *  - [displayName]: human-readable title shown in the details panel.
     *  - [why]: one-line plain-English explainer. Short. No marketing.
     *  - [intent]: the deep-link Intent to drop the user exactly where
     *    they can grant this. Used for SPECIAL grants (the Grant All
     *    flow calls startActivity(intent)) and as a fallback for any
     *    RUNTIME entry whose popup gets "Don't ask again"'d.
     */
    data class MissingPermission(
        val id: String,
        val kind: Kind,
        val manifestPermission: String?,
        val displayName: String,
        val why: String,
        val intent: Intent,
    )

    /**
     * The full audit. Returns an EMPTY list when everything is granted —
     * MainActivity uses `list.isEmpty()` to decide whether to render the
     * main pane or the blocking pane. Order matters; see class kdoc.
     */
    fun checkAll(context: Context): List<MissingPermission> {
        val missing = mutableListOf<MissingPermission>()

        // 1. POST_NOTIFICATIONS (API 33+). Without this, incoming-call
        //    heads-up banners + Connection requests never reach the user.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !isGranted(context, Manifest.permission.POST_NOTIFICATIONS)
        ) {
            missing += MissingPermission(
                id = "post_notifications",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.POST_NOTIFICATIONS,
                displayName = context.getString(R.string.perm_name_notifications),
                why = context.getString(R.string.perm_why_notifications),
                intent = appDetailsIntent(context),
            )
        }

        // 2. Notification Listener access — SPECIAL. Checked via
        //    Settings.Secure; the OS doesn't expose a checkSelfPermission
        //    path for this. Without it, the webapp can't mirror messaging
        //    notifications.
        if (!isNotificationListenerEnabled(context)) {
            missing += MissingPermission(
                id = "notification_listener",
                kind = Kind.SPECIAL,
                manifestPermission = null,
                displayName = context.getString(R.string.perm_name_notif_listener),
                why = context.getString(R.string.perm_why_notif_listener),
                intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                },
            )
        }

        // 3. CALL_PHONE — core. Webapp dials out via this.
        if (!isGranted(context, Manifest.permission.CALL_PHONE)) {
            missing += MissingPermission(
                id = "call_phone",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.CALL_PHONE,
                displayName = context.getString(R.string.perm_name_phone),
                why = context.getString(R.string.perm_why_phone),
                intent = appDetailsIntent(context),
            )
        }

        // 4. READ_PHONE_STATE.
        if (!isGranted(context, Manifest.permission.READ_PHONE_STATE)) {
            missing += MissingPermission(
                id = "read_phone_state",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.READ_PHONE_STATE,
                displayName = context.getString(R.string.perm_name_phone_state),
                why = context.getString(R.string.perm_why_phone_state),
                intent = appDetailsIntent(context),
            )
        }

        // 5. ANSWER_PHONE_CALLS.
        if (!isGranted(context, Manifest.permission.ANSWER_PHONE_CALLS)) {
            missing += MissingPermission(
                id = "answer_phone_calls",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.ANSWER_PHONE_CALLS,
                displayName = context.getString(R.string.perm_name_answer),
                why = context.getString(R.string.perm_why_answer),
                intent = appDetailsIntent(context),
            )
        }

        // 6. READ_CONTACTS.
        if (!isGranted(context, Manifest.permission.READ_CONTACTS)) {
            missing += MissingPermission(
                id = "read_contacts",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.READ_CONTACTS,
                displayName = context.getString(R.string.perm_name_contacts),
                why = context.getString(R.string.perm_why_contacts),
                intent = appDetailsIntent(context),
            )
        }

        // 7. READ_CALL_LOG.
        if (!isGranted(context, Manifest.permission.READ_CALL_LOG)) {
            missing += MissingPermission(
                id = "read_call_log",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.READ_CALL_LOG,
                displayName = context.getString(R.string.perm_name_call_log),
                why = context.getString(R.string.perm_why_call_log),
                intent = appDetailsIntent(context),
            )
        }

        // 8. SMS triplet.
        if (!isGranted(context, Manifest.permission.READ_SMS)) {
            missing += MissingPermission(
                id = "read_sms",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.READ_SMS,
                displayName = context.getString(R.string.perm_name_read_sms),
                why = context.getString(R.string.perm_why_read_sms),
                intent = appDetailsIntent(context),
            )
        }
        if (!isGranted(context, Manifest.permission.SEND_SMS)) {
            missing += MissingPermission(
                id = "send_sms",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.SEND_SMS,
                displayName = context.getString(R.string.perm_name_send_sms),
                why = context.getString(R.string.perm_why_send_sms),
                intent = appDetailsIntent(context),
            )
        }
        if (!isGranted(context, Manifest.permission.RECEIVE_SMS)) {
            missing += MissingPermission(
                id = "receive_sms",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.RECEIVE_SMS,
                displayName = context.getString(R.string.perm_name_receive_sms),
                why = context.getString(R.string.perm_why_receive_sms),
                intent = appDetailsIntent(context),
            )
        }

        // 9. CAMERA.
        if (!isGranted(context, Manifest.permission.CAMERA)) {
            missing += MissingPermission(
                id = "camera",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.CAMERA,
                displayName = context.getString(R.string.perm_name_camera),
                why = context.getString(R.string.perm_why_camera),
                intent = appDetailsIntent(context),
            )
        }

        // 10. Battery optimization ignore — SPECIAL. Samsung-specific framing.
        if (!isBatteryOptimizationIgnored(context)) {
            missing += MissingPermission(
                id = "battery_optimization",
                kind = Kind.SPECIAL,
                manifestPermission = null,
                displayName = context.getString(R.string.perm_name_battery),
                why = context.getString(R.string.perm_why_battery),
                intent = batteryOptimizationIntent(context),
            )
        }

        // 11. Auto-revoke whitelist — SPECIAL. API 30+ (Android 11) added
        //     a background "hibernation" pass that revokes runtime permissions
        //     for apps the user hasn't foregrounded "recently". For a phone-
        //     bridge background service that's a silent killer: user grants
        //     everything once, never opens the app for a week (the whole
        //     point — it just runs), comes back to find calls/SMS broken
        //     with no error. AndroidManifest.xml application tag now sets
        //     android:autoRevokePermissions="disallowed" (Bug #3 dispatch
        //     #23) but the OS can still opt us back in on a setting change
        //     or per-OEM policy; check at runtime and route the user to the
        //     auto-revoke settings deep-link if so. Inverted: the OS API
        //     returns TRUE when the app IS whitelisted (i.e. auto-revoke is
        //     OFF for us = healthy). When it returns FALSE we surface the
        //     fix to the user.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            !isAutoRevokeWhitelisted(context)
        ) {
            missing += MissingPermission(
                id = "auto_revoke",
                kind = Kind.SPECIAL,
                manifestPermission = null,
                displayName = context.getString(R.string.perm_name_auto_revoke),
                why = context.getString(R.string.perm_why_auto_revoke),
                intent = autoRevokeIntent(context),
            )
        }

        return missing
    }

    // ---------- internals ----------

    private fun isGranted(context: Context, permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * Notification Listener access has no checkSelfPermission equivalent.
     * The OS stores the colon-separated list of enabled ComponentNames in
     * Settings.Secure. We check whether our service's flattened component
     * appears in that string.
     *
     * Defensive: getString can return null on rare OEM forks — coerce to
     * "" so contains() never NPEs.
     */
    private fun isNotificationListenerEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners"
        ) ?: ""
        val component = ComponentName(context, DnkNotificationListenerService::class.java)
        return enabled.contains(component.flattenToString()) ||
            enabled.contains(component.flattenToShortString())
    }

    private fun isBatteryOptimizationIgnored(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun appDetailsIntent(context: Context): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun batteryOptimizationIntent(context: Context): Intent {
        return Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * API 30+ — returns true when the app is whitelisted from background
     * permission auto-revoke (i.e. the user has explicitly set
     * "Remove permissions if app isn't used" to OFF for us, OR the OS has
     * honored our manifest android:autoRevokePermissions="disallowed" and
     * not flipped us back).
     *
     * On API < 30 there's no auto-revoke flow at all, so we return true
     * (whitelisted == "no auto-revoke threat exists") and the caller
     * already gates this with a Build.VERSION_CODES.R check.
     *
     * Defensive: PackageManager.isAutoRevokeWhitelisted() throws on rare
     * OEM forks that haven't fully wired the API; treat any throw as
     * "assume whitelisted" so we don't spam the user with a fix they
     * can't action on their device.
     */
    private fun isAutoRevokeWhitelisted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true
        return try {
            context.packageManager.isAutoRevokeWhitelisted
        } catch (e: Exception) {
            android.util.Log.w(
                "PermissionChecker",
                "isAutoRevokeWhitelisted threw on this OEM build — assuming healthy: ${e.message}"
            )
            true
        }
    }

    /**
     * Deep-link to the Auto-revoke settings page for this app. Uses
     * Intent.ACTION_AUTO_REVOKE_PERMISSIONS (constant value
     * "android.intent.action.AUTO_REVOKE_PERMISSIONS") which the framework
     * maps to the per-app "Pause app activity if unused" / "Remove
     * permissions if app isn't used" toggle.
     *
     * On API < 30 this constant doesn't exist; we fall back to the standard
     * app-details settings screen so the user can find the toggle there.
     * (Caller gates with VERSION check so this branch is defensive only.)
     */
    private fun autoRevokeIntent(context: Context): Intent {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent(Intent.ACTION_AUTO_REVOKE_PERMISSIONS).apply {
                data = Uri.fromParts("package", context.packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } else {
            appDetailsIntent(context)
        }
    }
}
