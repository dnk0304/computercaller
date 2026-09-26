package com.dnkdialer.companion

import android.app.Notification
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * vc70 NOTIF-FORWARDING — RULE 30 vectors for the forwarding filter.
 *
 * Deliberately written against ONLY the boolean
 * `NotificationBackfill.isForwardable(pkg, category, flags, isSelf)` signature,
 * which the old allowlist (307e28a) also had: this exact file compiles against
 * the old code, and there the bank/no-category row goes RED. That is the
 * regression proof for item 7.
 */
class NotificationForwardVectorsTest {

    private data class V(
        val name: String,
        val pkg: String?,
        val category: String?,
        val flags: Int,
        val isSelf: Boolean,
        val expect: Boolean,
    )

    private val vectors = listOf(
        V("bank pkg, no category -> forward", "no.bank.mobile", null, 0, false, true),
        V("unknown pkg + CATEGORY_MESSAGE -> forward", "org.unknown.chat", Notification.CATEGORY_MESSAGE, 0, false, true),
        V("unknown pkg + CATEGORY_EMAIL -> forward", "org.unknown.mail", Notification.CATEGORY_EMAIL, 0, false, true),
        V("ongoing -> drop", "no.bank.mobile", null, Notification.FLAG_ONGOING_EVENT, false, false),
        V("group summary -> drop", "com.whatsapp", Notification.CATEGORY_MESSAGE, Notification.FLAG_GROUP_SUMMARY, false, false),
        V("own pkg -> drop", "com.dnkdialer.companion", Notification.CATEGORY_MESSAGE, 0, true, false),
        V("CATEGORY_PROGRESS -> drop", "org.unknown.dl", Notification.CATEGORY_PROGRESS, 0, false, false),
        V("CATEGORY_TRANSPORT -> drop", "org.unknown.music", Notification.CATEGORY_TRANSPORT, 0, false, false),
        V("CATEGORY_SERVICE -> drop", "org.unknown.vpn", Notification.CATEGORY_SERVICE, 0, false, false),
        V("CATEGORY_SYSTEM -> drop", "android", Notification.CATEGORY_SYSTEM, 0, false, false),
        V("null package -> drop", null, Notification.CATEGORY_MESSAGE, 0, false, false),
    )

    @Test
    fun forwarding_filter_vectors() {
        val failures = vectors.filter {
            NotificationBackfill.isForwardable(it.pkg, it.category, it.flags, it.isSelf) != it.expect
        }.map { it.name }
        assertEquals("failing vectors: $failures", emptyList<String>(), failures)
    }

    /** The load-bearing row on its own, so a red names it directly. */
    @Test
    fun bank_alert_with_no_category_forwards() {
        assertEquals(true, NotificationBackfill.isForwardable("no.bank.mobile", null, 0, false))
    }
}
