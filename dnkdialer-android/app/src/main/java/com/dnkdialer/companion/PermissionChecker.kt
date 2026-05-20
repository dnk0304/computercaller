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
 * Ordering inside [checkAll] is intentional: the list is rendered in
 * order, and the user sees the most-critical-to-app-function items at
 * the top of the scroll. Anything that breaks the core call-bridge flow
 * (Phone, Contacts, Notifications, Notification Listener, Battery)
 * comes before secondary surfaces (SMS, Camera).
 */
object PermissionChecker {

    /**
     * One missing-permission row, fully described so the UI layer doesn't
     * have to know the difference between a runtime permission and a
     * special-access grant.
     *
     *  - [id]: stable string id, used as the View tag in the list so the
     *    Grant button click handler can build the right Intent.
     *  - [displayName]: human-readable title shown on the card. NEVER the
     *    raw Manifest constant — the user shouldn't have to translate
     *    "android.permission.READ_CALL_LOG" in their head.
     *  - [why]: one-line plain-English explainer. Short. No marketing.
     *  - [intent]: the deep-link Intent to drop the user exactly where
     *    they can grant this. Already pre-constructed against the calling
     *    Context — fire-and-forget from the UI.
     */
    data class MissingPermission(
        val id: String,
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
        //    Top of the list — first thing they should fix.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !isGranted(context, Manifest.permission.POST_NOTIFICATIONS)
        ) {
            missing += MissingPermission(
                id = "post_notifications",
                displayName = context.getString(R.string.perm_name_notifications),
                why = context.getString(R.string.perm_why_notifications),
                intent = appDetailsIntent(context),
            )
        }

        // 2. Notification Listener access — special-access grant, not a
        //    runtime permission. Checked via Settings.Secure because the
        //    OS doesn't expose a checkSelfPermission path for this.
        //    Without it, the webapp can't mirror messaging notifications.
        if (!isNotificationListenerEnabled(context)) {
            missing += MissingPermission(
                id = "notification_listener",
                displayName = context.getString(R.string.perm_name_notif_listener),
                why = context.getString(R.string.perm_why_notif_listener),
                intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
            )
        }

        // 3. CALL_PHONE — core. Webapp dials out via this.
        if (!isGranted(context, Manifest.permission.CALL_PHONE)) {
            missing += MissingPermission(
                id = "call_phone",
                displayName = context.getString(R.string.perm_name_phone),
                why = context.getString(R.string.perm_why_phone),
                intent = appDetailsIntent(context),
            )
        }

        // 4. READ_PHONE_STATE — required to observe call state changes
        //    so we know when a call connects/ends.
        if (!isGranted(context, Manifest.permission.READ_PHONE_STATE)) {
            missing += MissingPermission(
                id = "read_phone_state",
                displayName = context.getString(R.string.perm_name_phone_state),
                why = context.getString(R.string.perm_why_phone_state),
                intent = appDetailsIntent(context),
            )
        }

        // 5. ANSWER_PHONE_CALLS — accept incoming calls from the webapp UI.
        if (!isGranted(context, Manifest.permission.ANSWER_PHONE_CALLS)) {
            missing += MissingPermission(
                id = "answer_phone_calls",
                displayName = context.getString(R.string.perm_name_answer),
                why = context.getString(R.string.perm_why_answer),
                intent = appDetailsIntent(context),
            )
        }

        // 6. READ_CONTACTS — match incoming caller IDs to saved names.
        if (!isGranted(context, Manifest.permission.READ_CONTACTS)) {
            missing += MissingPermission(
                id = "read_contacts",
                displayName = context.getString(R.string.perm_name_contacts),
                why = context.getString(R.string.perm_why_contacts),
                intent = appDetailsIntent(context),
            )
        }

        // 7. READ_CALL_LOG — sync recents to the webapp.
        if (!isGranted(context, Manifest.permission.READ_CALL_LOG)) {
            missing += MissingPermission(
                id = "read_call_log",
                displayName = context.getString(R.string.perm_name_call_log),
                why = context.getString(R.string.perm_why_call_log),
                intent = appDetailsIntent(context),
            )
        }

        // 8. SMS triplet — grouped because they're the same surface in
        //    the user's mental model ("SMS access"). Each is checked
        //    individually but presented in the order Read → Send → Receive
        //    so the user can grant them as a logical block.
        if (!isGranted(context, Manifest.permission.READ_SMS)) {
            missing += MissingPermission(
                id = "read_sms",
                displayName = context.getString(R.string.perm_name_read_sms),
                why = context.getString(R.string.perm_why_read_sms),
                intent = appDetailsIntent(context),
            )
        }
        if (!isGranted(context, Manifest.permission.SEND_SMS)) {
            missing += MissingPermission(
                id = "send_sms",
                displayName = context.getString(R.string.perm_name_send_sms),
                why = context.getString(R.string.perm_why_send_sms),
                intent = appDetailsIntent(context),
            )
        }
        if (!isGranted(context, Manifest.permission.RECEIVE_SMS)) {
            missing += MissingPermission(
                id = "receive_sms",
                displayName = context.getString(R.string.perm_name_receive_sms),
                why = context.getString(R.string.perm_why_receive_sms),
                intent = appDetailsIntent(context),
            )
        }

        // 9. CAMERA — QR scanning. Less critical (the user can type the
        //    pairing URL manually) but still in the manifest, so audited.
        if (!isGranted(context, Manifest.permission.CAMERA)) {
            missing += MissingPermission(
                id = "camera",
                displayName = context.getString(R.string.perm_name_camera),
                why = context.getString(R.string.perm_why_camera),
                intent = appDetailsIntent(context),
            )
        }

        // 10. Battery optimization ignore — Samsung-specific framing in the
        //     copy because it's not a standard permission; it's a "don't
        //     optimize" toggle the OEM exposes. Bottom of the list because
        //     missing this degrades reliability rather than killing
        //     features outright (the service still functions, it just
        //     gets killed sooner under memory pressure).
        if (!isBatteryOptimizationIgnored(context)) {
            missing += MissingPermission(
                id = "battery_optimization",
                displayName = context.getString(R.string.perm_name_battery),
                why = context.getString(R.string.perm_why_battery),
                intent = batteryOptimizationIntent(context),
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
        // Match both the short and flattened forms — some Android builds
        // store the short form (pkg/.Class), some the long (pkg/pkg.Class).
        return enabled.contains(component.flattenToString()) ||
            enabled.contains(component.flattenToShortString())
    }

    private fun isBatteryOptimizationIgnored(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * The standard app-details intent for any runtime permission. Drops
     * the user on the App Info screen, which is the only reliable surface
     * for re-granting a runtime permission they previously denied — the
     * runtime requestPermissions dialog won't re-show after a "Don't ask
     * again" tap.
     */
    private fun appDetailsIntent(context: Context): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            // FLAG_ACTIVITY_NEW_TASK is required when launching from a
            // non-Activity context. We're called from an Activity, but
            // setting it costs nothing and makes the helper safe to reuse
            // from a Service later if needed.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun batteryOptimizationIntent(context: Context): Intent {
        return Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }
}
