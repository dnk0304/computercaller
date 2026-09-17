package com.dnkdialer.companion

import android.app.Notification

/**
 * P4 (i) / Notification-backfill Half A — **the one predicate and the one
 * selection rule**, shared by the live path and the backfill path.
 *
 * Dennis, 2026-09-17: "when we sync phone, it should fetch all notifications
 * that currently are visible on the phone as well."
 *
 * The brief's constraint is the interesting part: *reuse the live path's
 * builder — one serializer, not two.* Two copies of a notification filter drift
 * within a release, and they drift silently, because the symptom is a
 * notification that appears on one path and not the other and nobody can say
 * which behaviour was intended. So the category/package rule and the
 * ongoing-exclusion live HERE, and `onNotificationPosted`,
 * `onNotificationRemoved` and the backfill sweep all call [isForwardable].
 *
 * Everything in this file is pure: no Context, no framework lookup, no
 * `StatusBarNotification`. That is what lets the cap, the ordering and the
 * filter be unit-tested on the JVM rather than needing three real
 * notifications on an emulator to check an off-by-one in a `take()`.
 */
object NotificationBackfill {

    /**
     * Newest-first, and at most this many. §"cap 50" from the brief.
     *
     * The cap exists because the shade can hold hundreds on a busy phone and
     * the backfill is sent as individual frames — an uncapped sweep would be a
     * self-inflicted flood on the socket the moment a pair goes active.
     */
    const val CAP = 50

    /**
     * Categories forwarded to the web client. Anything outside this set is
     * dropped unless the package is in [ALWAYS_ALLOW_PACKAGES] — keeps the
     * strip focused on communication and silences the long tail of
     * system/promo/transactional noise.
     */
    val ALLOWED_CATEGORIES: Set<String> = setOf(
        Notification.CATEGORY_MESSAGE,   // WhatsApp, Telegram, SMS, RCS, Discord, Messenger
        Notification.CATEGORY_SOCIAL,    // Instagram, Twitter/X, Snapchat, LinkedIn
        Notification.CATEGORY_EMAIL,     // Gmail, Outlook
        Notification.CATEGORY_CALL,      // Call notifications from any app
    )

    /**
     * Packages that post messaging-style notifications without setting a
     * CATEGORY_* value. Bypasses the category filter.
     */
    val ALWAYS_ALLOW_PACKAGES: Set<String> = setOf(
        "com.whatsapp",
        "org.telegram.messenger",
        "com.viber.voip",
        "com.discord",
        "com.facebook.orca",                  // Messenger
        "com.instagram.android",              // Instagram DMs
        "com.google.android.apps.messaging",  // Google Messages (SMS/RCS)
        "com.samsung.android.messaging",      // Samsung Messages
    )

    /**
     * The whole filter, in one place.
     *
     * @param flags `notification.flags`; FLAG_ONGOING_EVENT is excluded.
     *        Ongoing notifications are progress bars, media players, navigation
     *        and foreground-service stickies — state displays, not events. On
     *        the LIVE path forwarding them spams the client on every progress
     *        tick; on the BACKFILL path they are exactly the entries that would
     *        make a freshly-paired shade look like junk, since they are the
     *        ones that are always present.
     * @param isSelf true for our own package, which is never forwarded.
     */
    @JvmStatic
    fun isForwardable(
        packageName: String?,
        category: String?,
        flags: Int,
        isSelf: Boolean,
    ): Boolean {
        if (packageName == null || isSelf) return false
        if (flags and Notification.FLAG_ONGOING_EVENT != 0) return false
        return category in ALLOWED_CATEGORIES || packageName in ALWAYS_ALLOW_PACKAGES
    }

    /**
     * Order and cap a set of already-filtered candidates.
     *
     * Sorted by `postedAt` DESCENDING — newest first, as the brief specifies —
     * and the cap is applied AFTER the sort, so what survives is the newest 50
     * rather than the first 50 the platform happened to hand back.
     * `getActiveNotifications()` does not promise an order, so a cap applied
     * before sorting would silently keep an arbitrary subset.
     *
     * The sort is stable, so two notifications posted in the same millisecond
     * keep their relative platform order rather than swapping between runs.
     */
    @JvmStatic
    @JvmOverloads
    fun <T> selectNewest(
        candidates: List<T>,
        cap: Int = CAP,
        postedAt: (T) -> Long,
    ): List<T> = candidates.sortedByDescending(postedAt).take(cap)
}
