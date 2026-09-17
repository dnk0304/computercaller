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

        /**
         * Cancel a real notification on the handset by its sbn.key — the
         * phone-side half of web→phone dismissal sync (NOTIFICATION_DISMISS).
         *
         * Returns false (and logs) when the listener is not connected, when the
         * key is blank, or when the platform throws — a stale key from the web
         * mirror is entirely expected and must never crash the service. The
         * cancel, when it lands, fires onNotificationRemoved, which echoes a
         * NOTIFICATION_REMOVED frame back to the web. The web has already
         * dropped that row, so the echo is a harmless no-op.
         */
        fun dismissByKey(notificationKey: String): Boolean {
            if (notificationKey.isBlank()) {
                android.util.Log.w("NotifListener", "dismissByKey: blank key")
                return false
            }
            val svc = instance
            if (svc == null) {
                android.util.Log.w("NotifListener", "dismissByKey: listener not connected")
                return false
            }
            return try {
                svc.cancelNotification(notificationKey)
                true
            } catch (e: Exception) {
                android.util.Log.e("NotifListener", "dismissByKey failed: ${e.message}", e)
                false
            }
        }

        // The category/package filter and the ongoing exclusion moved to
        // NotificationBackfill so the live path, the removal path and the
        // backfill sweep share ONE predicate. Two copies of a notification
        // filter drift within a release, and they drift silently: the symptom
        // is a notification that appears on one path and not the other, and
        // nobody can say which behaviour was intended.

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
        /**
         * Everything the web client needs to render and optionally reply to a
         * notification.
         *
         * A data class rather than the eleven positional parameters this became
         * once (i) added `backfill`: `replyKey` and `notificationKey` are
         * adjacent Strings, and so are `title` and `body`. Transposing a pair
         * of those compiles, ships, and shows the wrong text on someone's
         * desktop.
         */
        data class Payload(
            val appName: String,
            val packageName: String,
            val title: String,
            val body: String,
            val hasReply: Boolean,
            val replyKey: String,
            val notificationKey: String,
            /** `StatusBarNotification.postTime`, ms epoch. */
            val timestamp: Long,
            val icon: String?,
            val senderPersonUri: String?,
            /**
             * True for a shade sweep, false for a live post. The web reads
             * `payload.backfill === true` and merges by `postedAt` instead of
             * notifying, badging or playing a sound (Forge-T).
             */
            val backfill: Boolean,
        )

        // Callback set by PhoneService so it can forward intercepted
        // notifications.
        var onMessageNotification: ((Payload) -> Unit)? = null

        // Fired when the user (or the source app) dismisses a notification.
        // PhoneService wires this to a NOTIFICATION_REMOVED frame so the web
        // client's notification strip can drop the matching row. Mirrors the
        // onMessageNotification callback shape — set by PhoneService.startServer
        // and cleared on Service destroy to avoid leaking the Service instance.
        var onNotificationRemovedCb: ((notificationKey: String) -> Unit)? = null

        // Cache of recently seen StatusBarNotifications keyed by sbn.key.
        // PhoneService falls back to this when activeNotifications no longer
        // has the entry (notification dismissed before user replied via webapp).
        val replyCache: LinkedHashMap<String, android.service.notification.StatusBarNotification> =
            object : LinkedHashMap<String, android.service.notification.StatusBarNotification>(64, 0.75f, false) {
                override fun removeEldestEntry(
                    eldest: MutableMap.MutableEntry<String, android.service.notification.StatusBarNotification>?
                ) = size > 50
            }
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
        val payload = buildPayload(sbn, backfill = false) ?: return
        onMessageNotification?.invoke(payload)
    }

    /**
     * Turn one [StatusBarNotification] into a [Payload], or null when it must
     * not be forwarded.
     *
     * THE one serializer. The live path and the backfill sweep both come
     * through here, differing in exactly one boolean, so a change to what a
     * notification looks like on the wire cannot reach one path and miss the
     * other.
     */
    private fun buildPayload(sbn: StatusBarNotification, backfill: Boolean): Payload? {
        val pkg = sbn.packageName ?: return null
        val notification = sbn.notification ?: return null
        val extras: Bundle = notification.extras ?: return null

        if (!NotificationBackfill.isForwardable(
                packageName = pkg,
                category = notification.category,
                flags = notification.flags,
                isSelf = pkg == packageName,
            )
        ) {
            return null
        }

        val title = extractTitle(extras) ?: return null
        val body = extractBody(extras)
        if (title.isBlank() && body.isBlank()) return null // skip empty

        val appName = try {
            packageManager.getApplicationLabel(
                packageManager.getApplicationInfo(pkg, 0)
            ).toString()
        } catch (e: Exception) { pkg }

        // Detect if the notification carries a reply RemoteInput action.
        var hasReply = false
        var replyKey = ""
        for (action in notification.actions ?: emptyArray()) {
            val remoteInputs = action.remoteInputs
            if (!remoteInputs.isNullOrEmpty()) {
                hasReply = true
                replyKey = remoteInputs[0].resultKey ?: ""
                break
            }
        }

        val notificationKey = sbn.key ?: "${pkg}_${sbn.id}"
        // Cached for BOTH paths: a backfilled notification the user replies to
        // must resolve the same way a live one does, and the shade entry can be
        // dismissed between the backfill and the reply.
        replyCache[notificationKey] = sbn

        return Payload(
            appName = appName,
            packageName = pkg,
            title = title,
            body = body,
            hasReply = hasReply,
            replyKey = replyKey,
            notificationKey = notificationKey,
            timestamp = sbn.postTime,
            icon = captureAppIcon(pkg),
            senderPersonUri = extractSenderPersonUri(extras),
            backfill = backfill,
        )
    }

    /**
     * P4 (i): the notifications currently visible on the phone, newest first,
     * capped, as backfill payloads.
     *
     * Returns an empty list rather than throwing when the listener is not
     * connected — `getActiveNotifications()` throws if the service has been
     * unbound, and a pairing must not fail because the shade could not be read.
     */
    fun activeNotificationPayloads(): List<Payload> {
        val active = try {
            activeNotifications ?: return emptyList()
        } catch (t: Throwable) {
            android.util.Log.w("NotifListener", "getActiveNotifications failed: ${t.message}")
            return emptyList()
        }
        // Filter FIRST, then sort and cap. Capping before the filter would let
        // 50 ongoing notifications crowd out every real one.
        val payloads = active.mapNotNull { buildPayload(it, backfill = true) }
        return NotificationBackfill.selectNewest(payloads) { it.timestamp }
    }

    /**
     * Extracts the canonical sender URI from a MessagingStyle notification's
     * last message. On API 28+ each EXTRA_MESSAGES entry carries a Person under
     * the "sender_person" key whose `uri` is typically "tel:+<number>" for
     * SMS/RCS apps. Returns the raw uri (caller strips the scheme), or null when
     * the notification is not MessagingStyle, carries no Person, or the Person
     * has no uri. Never throws — a malformed extras Bundle yields null.
     */
    private fun extractSenderPersonUri(extras: Bundle): String? {
        return try {
            val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES) ?: return null
            if (messages.isEmpty()) return null
            val lastMsg = messages.last() as? Bundle ?: return null
            // API 28+: MessagingStyle.Message stores the sender as a Person
            // parcelable under "sender_person". Older builds only have the
            // legacy "sender" CharSequence (a display name, never a number).
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                val person = lastMsg.getParcelable<android.app.Person>("sender_person")
                val uri = person?.uri
                if (!uri.isNullOrBlank()) return uri
            }
            null
        } catch (t: Throwable) {
            // Defensive: a vendor ROM with a non-standard extras layout must not
            // crash the listener. Fall through to the title/contacts resolution.
            android.util.Log.w("DnkNotificationListener", "extractSenderPersonUri failed: ${t.message}")
            null
        }
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
        // Apply the same filter as onNotificationPosted — only forward removals
        // for apps we actually posted to the web client. Background/system apps
        // (e.g. ongoing notification updaters) fire onNotificationRemoved
        // repeatedly and cause unnecessary relay churn if not filtered.
        val pkg = sbn.packageName ?: return
        val notification = sbn.notification ?: return
        // The SAME predicate the post path used, so a removal is forwarded for
        // exactly the notifications that were forwarded — including backfilled
        // ones, since the shade is the source for both.
        if (!NotificationBackfill.isForwardable(
                packageName = pkg,
                category = notification.category,
                flags = notification.flags,
                isSelf = pkg == packageName,
            )
        ) {
            return
        }

        val key = sbn.key ?: return
        onNotificationRemovedCb?.invoke(key)
    }
}
