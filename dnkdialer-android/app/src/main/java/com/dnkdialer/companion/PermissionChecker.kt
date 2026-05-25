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
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import java.util.concurrent.TimeUnit

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
     * Live status of a single permission row in the checklist UI (v18).
     *
     * Unlike [MissingPermission] (which only describes things the user
     * hasn't granted yet), [PermissionStatusItem] is emitted for EVERY
     * permission the app cares about so the UI can render a complete
     * checklist where granted rows stay visible as a ✓ green badge.
     *
     *  - [GRANTED]          — the OS reports the permission as granted.
     *                          Renders ✓ green.
     *  - [MISSING_REQUIRED] — missing and load-bearing for core call /
     *                          contacts / SMS flows. Renders ✗ red.
     *                          Blocks the "Continue" button.
     *  - [MISSING_SOFT]     — missing but tolerable (battery /
     *                          auto-revoke / notification listener — OEM
     *                          reliability hardening, not core function).
     *                          Renders ⚠ amber. Does NOT block Continue.
     *
     * "REQUIRED" here means "Continue can't proceed without it". The
     * triage matches the v18 spec: Phone, Contacts, SMS triplet are the
     * real blockers; everything else (battery exemption, notification
     * listener, notification post permission, auto-revoke whitelist,
     * camera) is SOFT.
     */
    enum class Status { GRANTED, MISSING_REQUIRED, MISSING_SOFT }

    /**
     * One row in the live-status checklist. Mirrors [MissingPermission]'s
     * shape but adds [status] so the UI can render granted rows too.
     *
     * [intent] is null for GRANTED entries (nothing to tap into) and the
     * deep-link Intent for missing entries so the UI can still offer a
     * "fix this" tap target if the user wants to revisit it.
     */
    data class PermissionStatusItem(
        val id: String,
        val status: Status,
        val displayName: String,
        val why: String,
        val intent: Intent?,
    )

    /**
     * Audit ALL permissions the app cares about, regardless of grant
     * status. Used by the v18 checklist UI in MainActivity so the user
     * can see green ticks for what's done as well as red/amber for what
     * isn't.
     *
     * Ordering matches [checkAll] — most-critical-first — so granted and
     * missing rows interleave in the natural reading order.
     *
     * REQUIRED set (blocks "Continue" button when missing): CALL_PHONE,
     * READ_PHONE_STATE, ANSWER_PHONE_CALLS, READ_CONTACTS, READ_CALL_LOG,
     * READ_SMS, SEND_SMS, RECEIVE_SMS. Everything else is SOFT.
     */
    fun checkAllWithStatus(context: Context): List<PermissionStatusItem> {
        val items = mutableListOf<PermissionStatusItem>()

        // 1. POST_NOTIFICATIONS (API 33+) — SOFT. The app technically
        //    still functions without it (notifications just don't show),
        //    so it doesn't block Continue.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            items += statusItem(
                context,
                id = "post_notifications",
                granted = isGranted(context, Manifest.permission.POST_NOTIFICATIONS),
                requiredWhenMissing = false,
                displayNameRes = R.string.perm_name_notifications,
                whyRes = R.string.perm_why_notifications,
                missingIntent = appDetailsIntent(context),
            )
        }

        // 2. Notification Listener — SOFT. RCS / messenger mirroring
        //    breaks without it but core SMS / call still works.
        items += statusItem(
            context,
            id = "notification_listener",
            granted = isNotificationListenerEnabled(context),
            requiredWhenMissing = false,
            displayNameRes = R.string.perm_name_notif_listener,
            whyRes = R.string.perm_why_notif_listener,
            missingIntent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )

        // 3-5. Phone triplet — REQUIRED.
        items += statusItem(
            context,
            id = "call_phone",
            granted = isGranted(context, Manifest.permission.CALL_PHONE),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_phone,
            whyRes = R.string.perm_why_phone,
            missingIntent = appDetailsIntent(context),
        )
        items += statusItem(
            context,
            id = "read_phone_state",
            granted = isGranted(context, Manifest.permission.READ_PHONE_STATE),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_phone_state,
            whyRes = R.string.perm_why_phone_state,
            missingIntent = appDetailsIntent(context),
        )
        items += statusItem(
            context,
            id = "answer_phone_calls",
            granted = isGranted(context, Manifest.permission.ANSWER_PHONE_CALLS),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_answer,
            whyRes = R.string.perm_why_answer,
            missingIntent = appDetailsIntent(context),
        )

        // 6. Contacts — REQUIRED.
        items += statusItem(
            context,
            id = "read_contacts",
            granted = isGranted(context, Manifest.permission.READ_CONTACTS),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_contacts,
            whyRes = R.string.perm_why_contacts,
            missingIntent = appDetailsIntent(context),
        )

        // 7. Call log — REQUIRED.
        items += statusItem(
            context,
            id = "read_call_log",
            granted = isGranted(context, Manifest.permission.READ_CALL_LOG),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_call_log,
            whyRes = R.string.perm_why_call_log,
            missingIntent = appDetailsIntent(context),
        )

        // 8. SMS triplet — REQUIRED.
        items += statusItem(
            context,
            id = "read_sms",
            granted = isGranted(context, Manifest.permission.READ_SMS),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_read_sms,
            whyRes = R.string.perm_why_read_sms,
            missingIntent = appDetailsIntent(context),
        )
        items += statusItem(
            context,
            id = "send_sms",
            granted = isGranted(context, Manifest.permission.SEND_SMS),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_send_sms,
            whyRes = R.string.perm_why_send_sms,
            missingIntent = appDetailsIntent(context),
        )
        items += statusItem(
            context,
            id = "receive_sms",
            granted = isGranted(context, Manifest.permission.RECEIVE_SMS),
            requiredWhenMissing = true,
            displayNameRes = R.string.perm_name_receive_sms,
            whyRes = R.string.perm_why_receive_sms,
            missingIntent = appDetailsIntent(context),
        )

        // 9. Camera — SOFT. Used to be required for the LAN-QR pairing
        //    flow but the app no longer scans QRs (post-dispatch #29
        //    cookie-token auth). Kept as informational.
        items += statusItem(
            context,
            id = "camera",
            granted = isGranted(context, Manifest.permission.CAMERA),
            requiredWhenMissing = false,
            displayNameRes = R.string.perm_name_camera,
            whyRes = R.string.perm_why_camera,
            missingIntent = appDetailsIntent(context),
        )

        // 9b. Bluetooth Connect — SOFT (API 31+ runtime grant only).
        //     Gates the "Speak through PC" call-audio mode. Without it we
        //     can't read BT-HFP profile state or device names. The earpiece
        //     and phone-speaker modes work regardless of this grant, so the
        //     app remains usable — the PC-audio toggle just stays disabled
        //     with a helper telling the user to grant Nearby devices in
        //     Settings if they want to use it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            items += statusItem(
                context,
                id = "bluetooth_connect",
                granted = isGranted(context, Manifest.permission.BLUETOOTH_CONNECT),
                requiredWhenMissing = false,
                displayNameRes = R.string.perm_name_bluetooth_connect,
                whyRes = R.string.perm_why_bluetooth_connect,
                missingIntent = appDetailsIntent(context),
            )
        }

        // 10. Battery optimization — SOFT (Samsung-soft per v18 spec).
        items += statusItem(
            context,
            id = "battery_optimization",
            granted = isBatteryOptimizationIgnored(context),
            requiredWhenMissing = false,
            displayNameRes = R.string.perm_name_battery,
            whyRes = R.string.perm_why_battery,
            missingIntent = batteryOptimizationIntent(context),
        )

        // 11. Auto-revoke whitelist — SOFT (API 30+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // shouldShowAutoRevokeWarning returns true when the OS has
            // auto-revoke ENABLED for us — i.e. the user has NOT
            // whitelisted. Granted = NOT whitelisted? No — granted here
            // means whitelisted (auto-revoke OFF). The helper returns
            // true when we should SURFACE the warning (auto-revoke ON);
            // therefore granted = !shouldShowAutoRevokeWarning.
            val whitelisted = !shouldShowAutoRevokeWarning(context)
            items += statusItem(
                context,
                id = "auto_revoke",
                granted = whitelisted,
                requiredWhenMissing = false,
                displayNameRes = R.string.perm_name_auto_revoke,
                whyRes = R.string.perm_why_auto_revoke,
                missingIntent = autoRevokeIntent(context),
            )
        }

        return items
    }

    /**
     * Builds a [PermissionStatusItem] from the granted boolean +
     * required-when-missing classification. Centralizes the GRANTED vs
     * MISSING_REQUIRED vs MISSING_SOFT decision so [checkAllWithStatus]
     * stays readable.
     */
    private fun statusItem(
        context: Context,
        id: String,
        granted: Boolean,
        requiredWhenMissing: Boolean,
        displayNameRes: Int,
        whyRes: Int,
        missingIntent: Intent,
    ): PermissionStatusItem {
        val status = when {
            granted -> Status.GRANTED
            requiredWhenMissing -> Status.MISSING_REQUIRED
            else -> Status.MISSING_SOFT
        }
        return PermissionStatusItem(
            id = id,
            status = status,
            displayName = context.getString(displayNameRes),
            why = context.getString(whyRes),
            intent = if (granted) null else missingIntent,
        )
    }

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

        // 9b. BLUETOOTH_CONNECT — API 31+ runtime, soft. Surfaced when the
        //     user hasn't granted Nearby devices and "Speak through PC"
        //     would otherwise stay greyed out with no explanation. Soft
        //     classification — earpiece/speaker modes still work.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            !isGranted(context, Manifest.permission.BLUETOOTH_CONNECT)
        ) {
            missing += MissingPermission(
                id = "bluetooth_connect",
                kind = Kind.RUNTIME,
                manifestPermission = Manifest.permission.BLUETOOTH_CONNECT,
                displayName = context.getString(R.string.perm_name_bluetooth_connect),
                why = context.getString(R.string.perm_why_bluetooth_connect),
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
        //     with no error.
        //
        //     Dispatch #25 (v15) — moved from the deprecated
        //     PackageManager.isAutoRevokeWhitelisted (which Dennis's v14
        //     report showed never surfaces the row + ate the "Manage app
        //     if unused" intent on Samsung) to the AndroidX-Jetpack
        //     forward-compatible API: PackageManagerCompat
        //     .getUnusedAppRestrictionsStatus(). The Compat API returns a
        //     ListenableFuture<Integer> that the framework resolves on a
        //     worker thread; we .get(1500, MILLISECONDS) it so the
        //     permission-pane render stays a single sync pass. Treat the
        //     three positive enum values (API_30_BACKPORT / API_30 /
        //     API_31) as "auto-revoke ENABLED for our app → surface the
        //     row"; treat DISABLED / FEATURE_NOT_AVAILABLE / ERROR /
        //     timeout as "no row needed" (defensive — better to under-
        //     surface than to gate on a heuristic that throws or stalls).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            shouldShowAutoRevokeWarning(context)
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
     * Returns true when we should SURFACE the auto-revoke warning row in
     * the permissions pane — i.e. the OS has auto-revoke ENABLED for this
     * app (so our grants are at risk of background hibernation).
     *
     * Dispatch #25 (v15) — replaces the v14 implementation that called
     * the platform PackageManager.isAutoRevokeWhitelisted. Dennis reported
     * on v14 that the row never surfaced at all AND that the "Manage app
     * if unused" Settings entry stopped opening — strongly suggesting the
     * platform API's behavior on his Samsung One UI build is not what the
     * docs imply (likely returning the wrong sense, or the throw branch
     * silently swallowing a real signal).
     *
     * The replacement uses androidx.core.content.PackageManagerCompat
     * .getUnusedAppRestrictionsStatus(context), which is the Jetpack
     * forward-compatible call that maps to the right under-the-hood API
     * on each platform version (App-Hibernation on 31+, Permission-Revoke
     * on 30, backport on 23-29). It returns a ListenableFuture<Integer>
     * resolved off the calling thread, so we block on .get with a 1500ms
     * timeout — well inside the budget for the permissions-pane render
     * which already does dozens of sync PackageManager calls.
     *
     * Returned status semantics (per UnusedAppRestrictionsConstants):
     *   - API_30_BACKPORT, API_30, API_31 → auto-revoke ENABLED → SHOW
     *   - DISABLED                        → user already opted out → HIDE
     *   - FEATURE_NOT_AVAILABLE           → pre-API-30 device → HIDE
     *   - ERROR                           → defensive HIDE (avoid spamming
     *                                       a row the user can't action)
     *   - timeout / exception             → defensive HIDE
     *
     * On API < 30 the caller already gates with a VERSION_CODES.R check,
     * so this fn returns false defensively in that branch too.
     */
    private fun shouldShowAutoRevokeWarning(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return try {
            val future = PackageManagerCompat.getUnusedAppRestrictionsStatus(context)
            val status = future.get(1500, TimeUnit.MILLISECONDS)
            when (status) {
                UnusedAppRestrictionsConstants.API_30_BACKPORT,
                UnusedAppRestrictionsConstants.API_30,
                UnusedAppRestrictionsConstants.API_31 -> true
                else -> false
            }
        } catch (e: Exception) {
            android.util.Log.w(
                "PermissionChecker",
                "getUnusedAppRestrictionsStatus failed (${e.javaClass.simpleName}: ${e.message}) — hiding row defensively"
            )
            false
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
