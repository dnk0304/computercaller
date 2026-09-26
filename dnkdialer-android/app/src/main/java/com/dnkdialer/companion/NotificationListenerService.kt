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
        private const val TAG = "DnkNotificationListener"
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

        // Per-(package, user) icon cache. Value is a base64-encoded PNG of the
        // app's unbadged icon (96px, 64px fallback — see NotificationIconPipeline).
        // Keyed by user too: a work-profile WhatsApp and the personal one are
        // separate entries. Capped by encoded bytes, not entry count.
        private val iconCache = ByteCappedIconCache(NotificationIconPipeline.CACHE_MAX_BYTES)

        // Failure lines are logged once per package per process.
        private val iconFailureLogged = NotificationIconPipeline.OncePerKey()
        private val iconSuccessLogged = NotificationIconPipeline.OncePerKey()

        // vc70 T2: app label per package, for the null-title fallback and the
        // appName field. Labels do not change under a running listener, and the
        // lookup is a binder call, so it is done once per package.
        private val labelCache = java.util.concurrent.ConcurrentHashMap<String, String>()

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
        // vc70 T4: every refusal below is counted and logged (reason + package
        // hash). A silent `return null` here is how a bank alert went missing.
        val pkg = sbn.packageName
        val notification = sbn.notification
        val extras: Bundle? = notification?.extras
        if (pkg == null) {
            ForwardDiag.notifDrop(NotificationBackfill.DropReason.NO_PACKAGE, null, backfill)
            return null
        }
        if (notification == null || extras == null) {
            ForwardDiag.notifDrop(NotificationBackfill.DropReason.MALFORMED, pkg, backfill)
            return null
        }

        NotificationBackfill.dropReason(
            NotificationBackfill.Facts(
                packageName = pkg,
                category = notification.category,
                flags = notification.flags,
                isSelf = pkg == packageName,
            )
        )?.let { reason ->
            ForwardDiag.notifDrop(reason, pkg, backfill)
            return null
        }

        val body = extractBody(extras)
        // vc70 T2: a null/blank title is NOT a reason to drop — fall back to the
        // app label, then the package name. Only title AND body empty drops.
        val title = NotificationBackfill.resolveTitle(extractTitle(extras), body, pkg) {
            appLabel(pkg, extras)
        }
        if (title == null) {
            ForwardDiag.notifDrop(NotificationBackfill.DropReason.EMPTY, pkg, backfill)
            return null
        }

        val appName = appLabel(pkg, extras) ?: pkg

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
            icon = captureAppIcon(sbn, extras),
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
     * Resolves the posting app's icon to a base64 PNG (96px, 64px fallback,
     * <= 16 KB encoded) for the web client, or null ("no icon, placeholder").
     *
     * Source chain, first hit wins:
     *  1. extras: the ApplicationInfo that Notification.Builder stamps into
     *     every notification's extras ("android.appInfo"). Loading an icon
     *     from an ApplicationInfo does not depend on package visibility, so
     *     it needs no <queries> and no QUERY_ALL_PACKAGES.
     *  2. pm: packageManager.getApplicationIcon(packageName) — the old path.
     *     Resolves by package name, so it is subject to package-visibility
     *     filtering (NameNotFoundException when the package is not visible);
     *     kept as a fallback.
     *
     * Catches Throwable (OOM on a huge adaptive-icon bitmap must never crash
     * the listener). No stack traces are logged.
     */
    private fun captureAppIcon(sbn: StatusBarNotification, extras: Bundle): String? {
        val pkg = sbn.packageName ?: return null
        val key = NotificationIconPipeline.cacheKey(pkg, sbn.user?.toString() ?: "")
        iconCache.get(key)?.let { return it }

        val pm = packageManager
        val icon = NotificationIconPipeline.resolve(
            listOf(
                NotificationIconPipeline.Source.EXTRAS to {
                    extrasAppInfo(extras)?.let { ai -> renderCapped(ai.loadUnbadgedIcon(pm)) }
                },
                NotificationIconPipeline.Source.PM to {
                    renderCapped(pm.getApplicationIcon(pkg))
                },
            ),
            onSuccess = { source, b64 ->
                if (iconSuccessLogged.first(pkg)) {
                    android.util.Log.i(TAG, NotificationIconPipeline.successLine(pkg, source, b64))
                }
            },
        ) { source, cause ->
            if (iconFailureLogged.first(pkg)) {
                android.util.Log.w(TAG, NotificationIconPipeline.failureLine(pkg, source, cause))
            }
        }
        if (icon != null) iconCache.put(key, icon)
        return icon
    }

    /**
     * The app's user-visible label, cached per package, or null.
     *
     * The ApplicationInfo stamped into the notification's extras is tried
     * first: loading a label from it does not depend on package visibility,
     * so no <queries> entry and no QUERY_ALL_PACKAGES is needed (same reason
     * as [captureAppIcon]). `getApplicationInfo(pkg)` is the fallback.
     */
    private fun appLabel(pkg: String, extras: Bundle): String? {
        labelCache[pkg]?.let { return it }
        val pm = packageManager
        val label = try {
            val ai = extrasAppInfo(extras) ?: pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(ai).toString().takeIf { it.isNotBlank() }
        } catch (t: Throwable) {
            null
        }
        if (label != null) labelCache[pkg] = label
        return label
    }

    private fun extrasAppInfo(extras: Bundle): android.content.pm.ApplicationInfo? {
        val k = NotificationIconPipeline.EXTRA_APP_INFO
        return if (android.os.Build.VERSION.SDK_INT >= 33) {
            extras.getParcelable(k, android.content.pm.ApplicationInfo::class.java)
        } else {
            @Suppress("DEPRECATION")
            extras.getParcelable<android.os.Parcelable>(k) as? android.content.pm.ApplicationInfo
        }
    }

    /** 96px -> 64px -> IconTooLargeException, per NotificationIconPipeline.encodeCapped. */
    private fun renderCapped(drawable: android.graphics.drawable.Drawable): String =
        NotificationIconPipeline.encodeCapped { px -> renderPngBase64(drawable, px) }

    private fun renderPngBase64(drawable: android.graphics.drawable.Drawable, px: Int): String {
        // Full bounds, no transparent-bounds crop: an AdaptiveIconDrawable is
        // drawn with all its layers exactly as the launcher masks it.
        val bitmap = android.graphics.Bitmap.createBitmap(px, px, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            val canvas = android.graphics.Canvas(bitmap)
            drawable.setBounds(0, 0, px, px)
            drawable.draw(canvas)
            val out = java.io.ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
            return android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
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

/**
 * The framework-free half of icon capture: source chain, size cap, cache key,
 * failure line. Pure Kotlin so the rules are unit-testable on the JVM.
 */
internal object NotificationIconPipeline {
    /** Notification.EXTRA_BUILDER_APPLICATION_INFO — @hide in the SDK, stable literal. */
    const val EXTRA_APP_INFO = "android.appInfo"
    const val PRIMARY_PX = 96
    const val FALLBACK_PX = 64
    const val MAX_ENCODED_BYTES = 16 * 1024
    const val CACHE_MAX_BYTES = 1_500_000L

    enum class Source(val label: String) { EXTRAS("extras"), PM("pm") }

    /** Both sizes exceed MAX_ENCODED_BYTES: send no icon rather than a huge frame. */
    class IconTooLargeException : RuntimeException()

    fun cacheKey(packageName: String, user: String): String = "$packageName#$user"

    /**
     * Encodes at PRIMARY_PX; if the base64 (ASCII, so chars == bytes) exceeds
     * MAX_ENCODED_BYTES, re-encodes at FALLBACK_PX; if that is still too big,
     * throws IconTooLargeException so the chain records it as the cause.
     */
    fun encodeCapped(encode: (Int) -> String): String {
        val big = encode(PRIMARY_PX)
        if (big.length <= MAX_ENCODED_BYTES) return big
        val small = encode(FALLBACK_PX)
        if (small.length <= MAX_ENCODED_BYTES) return small
        throw IconTooLargeException()
    }

    /**
     * Tries each source in order; the first non-null result wins. A source
     * returning null means "not available" (e.g. no appInfo in extras) and is
     * not a failure. If nothing produced an icon and at least one source
     * threw, [onFailure] is called exactly once with the LAST failing source.
     */
    fun resolve(
        sources: List<Pair<Source, () -> String?>>,
        onSuccess: (Source, String) -> Unit = { _, _ -> },
        onFailure: (Source, Throwable) -> Unit,
    ): String? {
        var lastFailure: Pair<Source, Throwable>? = null
        for ((source, load) in sources) {
            try {
                val icon = load()
                if (icon != null) {
                    onSuccess(source, icon)
                    return icon
                }
            } catch (t: Throwable) {
                lastFailure = source to t
            }
        }
        lastFailure?.let { (source, cause) -> onFailure(source, cause) }
        return null
    }

    /** Once-per-package proof line: which source won and the encoded size sent. */
    fun successLine(packageName: String, source: Source, base64: String): String =
        "Captured icon pkg=$packageName source=${source.label} bytes=${base64.length}"

    fun failureLine(packageName: String, source: Source, cause: Throwable): String =
        "Failed to capture icon pkg=$packageName source=${source.label} cause=${cause.javaClass.simpleName}"

    /** true the first time a key is seen in this process, false after. */
    class OncePerKey {
        private val seen = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        fun first(key: String): Boolean = seen.add(key)
    }
}

/**
 * LRU cache of base64 icons bounded by total encoded bytes (ASCII, so string
 * length == bytes). An entry larger than the whole cap is not stored.
 */
internal class ByteCappedIconCache(private val maxBytes: Long) {
    private val map = LinkedHashMap<String, String>(16, 0.75f, true)
    private var bytes = 0L

    @Synchronized fun get(key: String): String? = map[key]

    @Synchronized fun put(key: String, value: String) {
        val size = value.length.toLong()
        if (size > maxBytes) return
        map.remove(key)?.let { bytes -= it.length }
        map[key] = value
        bytes += size
        val it = map.entries.iterator()
        while (bytes > maxBytes && it.hasNext()) {
            val eldest = it.next()
            bytes -= eldest.value.length
            it.remove()
        }
    }

    @Synchronized fun totalBytes(): Long = bytes
    @Synchronized fun size(): Int = map.size
}
