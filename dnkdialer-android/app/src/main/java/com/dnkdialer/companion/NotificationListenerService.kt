package com.dnkdialer.companion

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Forwards ALL notifications (title + body) from any installed app to the
 * web client. Previously restricted to a hardcoded MESSAGING_PACKAGES set —
 * we now ship every notification (except our own) so the UI can act as a
 * Phone-Link-style universal notification mirror.
 *
 * For notifications that carry a RemoteInput reply action, we surface the
 * RemoteInput resultKey + the StatusBarNotification key so the web client
 * can fire a NOTIFICATION_REPLY back through PhoneService and trigger the
 * native reply PendingIntent.
 *
 * User must grant "Notification access" in Android Settings once.
 */
class DnkNotificationListenerService : NotificationListenerService() {

    companion object {
        private var instance: DnkNotificationListenerService? = null
        fun getInstance(): DnkNotificationListenerService? = instance

        // Categories we forward to the web client. Anything outside this set
        // is dropped unless the package is in ALWAYS_ALLOW_PACKAGES — keeps
        // the notification strip focused on communication and silences the
        // long tail of system/promo/transactional noise.
        private val ALLOWED_CATEGORIES = setOf(
            Notification.CATEGORY_MESSAGE,   // WhatsApp, Telegram, SMS, RCS, Discord, Messenger
            Notification.CATEGORY_SOCIAL,    // Instagram, Twitter/X, Snapchat, LinkedIn
            Notification.CATEGORY_EMAIL,     // Gmail, Outlook
            Notification.CATEGORY_CALL,      // Call notifications from any app
        )

        // Package allowlist for apps that frequently post messaging-style
        // notifications without setting a CATEGORY_* value. Bypasses the
        // category filter — if the package matches, we forward regardless.
        private val ALWAYS_ALLOW_PACKAGES = setOf(
            "com.whatsapp",
            "org.telegram.messenger",
            "com.viber.voip",
            "com.discord",
            "com.facebook.orca",                  // Messenger
            "com.instagram.android",              // Instagram DMs
            "com.google.android.apps.messaging",  // Google Messages (SMS/RCS)
            "com.samsung.android.messaging",      // Samsung Messages
        )

        // Per-package icon cache. Keyed by packageName; value is a base64-encoded
        // PNG of the app's launcher icon scaled to 48x48. Lives for the process
        // lifetime — drawables don't change without a reinstall, so caching here
        // avoids re-encoding on every notification.
        private val iconCache = java.util.concurrent.ConcurrentHashMap<String, String>() // packageName → base64 PNG

        // Callback set by PhoneService so it can forward intercepted notifications.
        // Includes the full set of fields the web client needs to render and
        // optionally reply: app name, package, title, body, RemoteInput presence,
        // RemoteInput result key, sbn key (for matching back on reply), the
        // notification post timestamp, and the captured app icon (base64 PNG)
        // when available.
        var onMessageNotification: (
            (
                appName: String,
                packageName: String,
                title: String,
                body: String,
                hasReply: Boolean,
                replyKey: String,
                notificationKey: String,
                timestamp: Long,
                icon: String?
            ) -> Unit
        )? = null

        // Fired when the user (or the source app) dismisses a notification.
        // PhoneService wires this to a NOTIFICATION_REMOVED frame so the web
        // client's notification strip can drop the matching row. Mirrors the
        // onMessageNotification callback shape — set by PhoneService.startServer
        // and cleared on Service destroy to avoid leaking the Service instance.
        var onNotificationRemovedCb: ((notificationKey: String) -> Unit)? = null
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return // never forward our own notifications

        val notification = sbn.notification ?: return
        val extras: Bundle = notification.extras ?: return

        // Skip ongoing/persistent notifications (progress bars, media players,
        // navigation, downloads, foreground-service stickies). These are state
        // displays, not events — forwarding them would spam the web client
        // every time the player updates a progress tick.
        if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return

        // Only forward communication-relevant notifications. Either the
        // category is one we care about, OR the package is on the allowlist
        // for apps that don't reliably set a category.
        val category = notification.category
        val isAllowedCategory = category in ALLOWED_CATEGORIES
        val isAllowedPackage = pkg in ALWAYS_ALLOW_PACKAGES
        if (!isAllowedCategory && !isAllowedPackage) return

        val title = extractTitle(extras) ?: return
        val body = extractBody(extras)
        if (title.isBlank() && body.isBlank()) return // skip empty

        // Get app name from package manager
        val appName = try {
            packageManager.getApplicationLabel(
                packageManager.getApplicationInfo(pkg, 0)
            ).toString()
        } catch (e: Exception) { pkg }

        // Detect if notification has a reply RemoteInput action
        var hasReply = false
        var replyKey = ""
        val actions = notification.actions ?: emptyArray()
        for (action in actions) {
            val remoteInputs = action.remoteInputs
            if (!remoteInputs.isNullOrEmpty()) {
                hasReply = true
                replyKey = remoteInputs[0].resultKey ?: ""
                break
            }
        }

        val notificationKey = sbn.key ?: "${pkg}_${sbn.id}"

        // Capture the app icon (cached after first encode) so the web client
        // can render proper per-app branding instead of a generic placeholder.
        val icon = captureAppIcon(pkg)

        onMessageNotification?.invoke(
            appName, pkg, title, body, hasReply, replyKey, notificationKey, sbn.postTime, icon
        )
    }

    /**
     * Resolves the app's launcher icon to a base64-encoded 48x48 PNG suitable
     * for the web client. Result is memoised in iconCache so we encode each
     * package at most once per process lifetime. Returns null if the package
     * has no resolvable icon or rendering fails — caller treats null as
     * "no icon, fall back to placeholder".
     */
    private fun captureAppIcon(packageName: String): String? {
        // Return cached icon if available
        iconCache[packageName]?.let { return it }

        // Catch Throwable (not just Exception) so OutOfMemoryError — which can
        // fire on packageManager.getApplicationIcon for adaptive icons with
        // huge backing drawables — never crashes the notification listener.
        // SecurityException, NameNotFoundException, NPE from a malformed
        // drawable, OOM during bitmap alloc — all funnel into a null return.
        // Canvas.draw() correctly rasterises AdaptiveIconDrawable (API 26+)
        // without special-casing, so no explicit instanceof branch needed.
        return try {
            val drawable = packageManager.getApplicationIcon(packageName)
            val bitmap = android.graphics.Bitmap.createBitmap(48, 48, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bitmap)
            drawable.setBounds(0, 0, 48, 48)
            drawable.draw(canvas)

            val out = java.io.ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 85, out)
            bitmap.recycle()

            val base64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
            // Cap the cache at 100 entries — the most-frequently-seen 100 apps
            // (which is the realistic ceiling on any phone) stay cached for
            // the process lifetime. Anything past that is re-encoded on demand
            // each time; cheap relative to the ~5-15ms encode cost and avoids
            // unbounded native memory growth on devices with thousands of apps.
            if (iconCache.size < 100) {
                iconCache[packageName] = base64
            }
            base64
        } catch (t: Throwable) {
            android.util.Log.w("DnkNotificationListener", "Failed to capture icon for $packageName: ${t.message}")
            null
        }
    }

    private fun extractTitle(extras: Bundle): String? {
        // MessagingStyle: sender name is in last message
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!messages.isNullOrEmpty()) {
            val lastMsg = messages.last()
            if (lastMsg is Bundle) {
                val person = lastMsg.getCharSequence("sender")?.toString()
                if (!person.isNullOrBlank()) {
                    // Full title = app title + sender if available
                    val appTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
                    return if (appTitle != null && appTitle != person) "$appTitle · $person" else person
                }
            }
        }
        return extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    }

    private fun extractBody(extras: Bundle): String {
        // MessagingStyle: body is in last message's text
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!messages.isNullOrEmpty()) {
            val lastMsg = messages.last()
            if (lastMsg is Bundle) {
                val text = lastMsg.getCharSequence("text")?.toString()
                if (!text.isNullOrBlank()) return text
            }
        }
        // Fallback: EXTRA_TEXT or EXTRA_BIG_TEXT
        return extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: ""
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // Forward dismissals to the web client so the in-app notification strip
        // stays in sync with the actual Android state — e.g. user swipes the
        // notification away on the phone, the webapp row also disappears.
        val key = sbn.key ?: return
        onNotificationRemovedCb?.invoke(key)
    }
}
