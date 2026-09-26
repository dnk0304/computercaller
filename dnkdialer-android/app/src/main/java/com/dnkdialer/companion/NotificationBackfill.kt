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
 * which behaviour was intended. So the noise denylist (vc70 item 7) lives
 * HERE, and `onNotificationPosted`,
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
     * vc70 item 7 — the forwarding filter is a NOISE DENYLIST.
     *
     * It used to be an allowlist (4 categories + 8 packages). A bank alert
     * carries no category and its package was on no list, so it was dropped
     * silently — which contradicted the mirror's own promise ("forward EVERY
     * notification", PhoneService) and nothing on the phone said why. Now
     * everything forwards unless it is one of the few shapes that are state
     * displays or plumbing rather than events.
     */
    val NOISE_CATEGORIES: Map<String, DropReason> = mapOf(
        Notification.CATEGORY_PROGRESS to DropReason.CATEGORY_PROGRESS,
        Notification.CATEGORY_TRANSPORT to DropReason.CATEGORY_TRANSPORT,
        Notification.CATEGORY_SERVICE to DropReason.CATEGORY_SERVICE,
        Notification.CATEGORY_SYSTEM to DropReason.CATEGORY_SYSTEM,
    )

    /**
     * Why a notification was not forwarded. [key] is the DiagLog counter
     * suffix (`notif.drop.<key>`) — an enum name, never notification content.
     */
    enum class DropReason(val key: String) {
        NO_PACKAGE("no_package"),
        OWN_PACKAGE("own_pkg"),
        ONGOING("ongoing"),
        GROUP_SUMMARY("group_summary"),
        CATEGORY_PROGRESS("category_progress"),
        CATEGORY_TRANSPORT("category_transport"),
        CATEGORY_SERVICE("category_service"),
        CATEGORY_SYSTEM("category_system"),
        /** No title AND no body — nothing to show. Logged, never silent. */
        EMPTY("empty"),
        /** The platform handed us an sbn with no Notification / extras. */
        MALFORMED("malformed"),
    }

    /** The only facts the filter reads. No Android types, so it runs on the JVM. */
    data class Facts(
        val packageName: String?,
        val category: String?,
        val flags: Int,
        val isSelf: Boolean,
    )

    /**
     * The whole filter, in one place: null = forward, else the drop reason.
     *
     * Drop = own package | FLAG_ONGOING_EVENT | FLAG_GROUP_SUMMARY | category in
     * [NOISE_CATEGORIES]. Everything else forwards, including no category and
     * packages nobody has heard of.
     *
     * Ongoing: progress bars, media players, navigation and foreground-service
     * stickies — on the live path they spam every tick; on the backfill they
     * are the entries that are always present. Group summary: the bundle
     * header an app posts NEXT TO the real child notification; forwarding it
     * put a second card beside every grouped message.
     */
    @JvmStatic
    fun dropReason(f: Facts): DropReason? {
        if (f.packageName == null) return DropReason.NO_PACKAGE
        if (f.isSelf) return DropReason.OWN_PACKAGE
        if (f.flags and Notification.FLAG_ONGOING_EVENT != 0) return DropReason.ONGOING
        if (f.flags and Notification.FLAG_GROUP_SUMMARY != 0) return DropReason.GROUP_SUMMARY
        return f.category?.let { NOISE_CATEGORIES[it] }
    }

    /** Boolean form of [dropReason]; the signature the RULE 30 vectors pin. */
    @JvmStatic
    fun isForwardable(
        packageName: String?,
        category: String?,
        flags: Int,
        isSelf: Boolean,
    ): Boolean = dropReason(Facts(packageName, category, flags, isSelf)) == null

    /**
     * T2 — the title a forwarded notification is shown under. A null or blank
     * title is never a reason to drop (a bank alert may carry only a body):
     * fall back to the app label, then to the package name. Returns null only
     * when title AND body are both empty — the caller drops that as [DropReason.EMPTY].
     */
    @JvmStatic
    fun resolveTitle(
        rawTitle: String?,
        body: String,
        packageName: String,
        appLabel: () -> String?,
    ): String? {
        if (!rawTitle.isNullOrBlank()) return rawTitle
        if (body.isBlank()) return null
        val label = try { appLabel() } catch (t: Throwable) { null }
        return if (label.isNullOrBlank()) packageName else label
    }

    /**
     * SHA-256(packageName), first 8 hex, printed as `xxxx_xxxx`. The package
     * name itself is never logged (a bank's package is a fact about the user).
     *
     * Why the underscore: [Redact] rewrites any run of 7+ digits into
     * `num:<hash>`, and 8 hex characters are all-digit or hold a 7-digit run
     * for ~5 % of packages. Splitting at 4 keeps every digit run under 7, so
     * the handle Ken matches against survives the export for every package.
     */
    @JvmStatic
    fun pkgHash(packageName: String): String {
        val d = java.security.MessageDigest.getInstance("SHA-256")
            .digest(packageName.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(8)
        for (i in 0 until 4) hex.append(String.format("%02x", d[i]))
        return hex.substring(0, 4) + "_" + hex.substring(4, 8)
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
