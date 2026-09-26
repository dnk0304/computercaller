package com.dnkdialer.companion

import android.app.Notification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P4 (i) — the backfill builder's rules: cap, ordering, and the shared filter.
 *
 * All of it on the JVM, because [NotificationBackfill] deliberately takes no
 * framework type. Checking an off-by-one in a `take()` should not require three
 * real notifications on an emulator.
 */
class NotificationBackfillTest {

    private val ONGOING = Notification.FLAG_ONGOING_EVENT

    // ------------------------------------------------------------- filter

    @Test
    fun ongoing_notifications_are_excluded() {
        assertFalse(
            "a media player / progress / foreground-service sticky is a STATE display, " +
                "not an event — and on a backfill it is exactly the entry that is always " +
                "present, so it would make a fresh pair's shade look like junk",
            NotificationBackfill.isForwardable(
                "com.whatsapp", Notification.CATEGORY_MESSAGE, ONGOING, isSelf = false
            )
        )
    }

    @Test
    fun our_own_notifications_are_never_forwarded() {
        assertFalse(
            NotificationBackfill.isForwardable(
                "com.dnkdialer.companion", Notification.CATEGORY_MESSAGE, 0, isSelf = true
            )
        )
    }

    /**
     * vc70 item 7: the filter is a noise DENYLIST now. Only the noise
     * categories drop; everything else — promo, email, no category at all —
     * forwards on any package. (The old allowlist tests pinned the bug.)
     */
    @Test
    fun only_the_noise_categories_drop() {
        for (c in NotificationBackfill.NOISE_CATEGORIES.keys) {
            assertFalse(c, NotificationBackfill.isForwardable("com.example.app", c, 0, false))
        }
        for (c in listOf(Notification.CATEGORY_PROMO, Notification.CATEGORY_EMAIL, null)) {
            assertTrue(
                "category $c must forward on an unlisted package",
                NotificationBackfill.isForwardable("com.example.app", c, 0, false)
            )
        }
    }

    /** Ongoing outranks everything, including a messaging category. */
    @Test
    fun ongoing_outranks_a_messaging_category() {
        assertFalse(
            NotificationBackfill.isForwardable("com.whatsapp", null, ONGOING, false)
        )
    }

    @Test
    fun a_null_package_is_not_forwardable() {
        assertFalse(NotificationBackfill.isForwardable(null, Notification.CATEGORY_MESSAGE, 0, false))
    }

    // ------------------------------------------------------ cap + ordering

    @Test
    fun the_selection_is_newest_first() {
        val out = NotificationBackfill.selectNewest(listOf(30L, 10L, 50L, 20L)) { it }
        assertEquals(listOf(50L, 30L, 20L, 10L), out)
    }

    @Test
    fun the_cap_is_fifty() {
        assertEquals(50, NotificationBackfill.CAP)
        assertEquals(50, NotificationBackfill.selectNewest((1L..200L).toList()) { it }.size)
    }

    /**
     * The trap this test exists for: `getActiveNotifications()` promises no
     * order, so a cap applied BEFORE the sort keeps an arbitrary 50 rather than
     * the newest 50 — and it would look right on any emulator where the
     * platform happens to return them in order.
     */
    @Test
    fun the_cap_keeps_the_newest_not_the_first_returned() {
        // Oldest first, which is the order a platform may well hand back.
        val oldestFirst = (1L..200L).toList()
        val out = NotificationBackfill.selectNewest(oldestFirst) { it }
        assertEquals("the newest entry must survive the cap", 200L, out.first())
        assertEquals("and the 50th-newest must be the last kept", 151L, out.last())
        assertFalse("nothing old may survive", out.contains(1L))
    }

    @Test
    fun fewer_than_the_cap_are_all_kept() {
        assertEquals(3, NotificationBackfill.selectNewest(listOf(1L, 2L, 3L)) { it }.size)
        assertEquals(0, NotificationBackfill.selectNewest(emptyList<Long>()) { it }.size)
    }

    /** Ties keep platform order rather than shuffling between runs. */
    @Test
    fun equal_timestamps_are_ordered_stably() {
        val items = listOf("a" to 5L, "b" to 5L, "c" to 5L)
        assertEquals(
            listOf("a", "b", "c"),
            NotificationBackfill.selectNewest(items) { it.second }.map { it.first }
        )
    }
}
