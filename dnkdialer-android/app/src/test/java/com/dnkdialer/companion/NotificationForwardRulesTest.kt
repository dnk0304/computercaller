package com.dnkdialer.companion

import android.app.Notification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** vc70 NOTIF-FORWARDING T1/T2/T4 — drop reasons, title fallback, log hygiene. */
class NotificationForwardRulesTest {

    private fun reason(pkg: String?, cat: String?, flags: Int = 0, self: Boolean = false) =
        NotificationBackfill.dropReason(NotificationBackfill.Facts(pkg, cat, flags, self))

    @Test
    fun each_drop_names_its_reason() {
        assertEquals(NotificationBackfill.DropReason.OWN_PACKAGE, reason("x", null, self = true))
        assertEquals(NotificationBackfill.DropReason.ONGOING, reason("x", null, Notification.FLAG_ONGOING_EVENT))
        assertEquals(NotificationBackfill.DropReason.GROUP_SUMMARY, reason("x", null, Notification.FLAG_GROUP_SUMMARY))
        assertEquals(NotificationBackfill.DropReason.CATEGORY_PROGRESS, reason("x", Notification.CATEGORY_PROGRESS))
        assertEquals(NotificationBackfill.DropReason.CATEGORY_TRANSPORT, reason("x", Notification.CATEGORY_TRANSPORT))
        assertEquals(NotificationBackfill.DropReason.CATEGORY_SERVICE, reason("x", Notification.CATEGORY_SERVICE))
        assertEquals(NotificationBackfill.DropReason.CATEGORY_SYSTEM, reason("x", Notification.CATEGORY_SYSTEM))
        assertEquals(NotificationBackfill.DropReason.NO_PACKAGE, reason(null, null))
        assertNull(reason("no.bank.mobile", null))
    }

    // ---------------------------------------------- sec C2 profile + secret

    private fun facts(sameUser: Boolean = true, visibility: Int = Notification.VISIBILITY_PRIVATE) =
        NotificationBackfill.Facts("no.bank.mobile", null, 0, false, sameUser, visibility)

    @Test
    fun work_profile_bank_alert_drops_as_other_profile() {
        assertEquals(
            NotificationBackfill.DropReason.OTHER_PROFILE,
            NotificationBackfill.dropReason(facts(sameUser = false)),
        )
    }

    @Test
    fun own_profile_bank_alert_forwards() {
        assertNull(NotificationBackfill.dropReason(facts(sameUser = true)))
    }

    @Test
    fun visibility_secret_drops_as_secret() {
        assertEquals(
            NotificationBackfill.DropReason.SECRET,
            NotificationBackfill.dropReason(facts(visibility = Notification.VISIBILITY_SECRET)),
        )
    }

    /** Lockscreen-PRIVATE hides the content on the lock screen only; it is not secret. */
    @Test
    fun visibility_private_and_public_forward() {
        assertNull(NotificationBackfill.dropReason(facts(visibility = Notification.VISIBILITY_PRIVATE)))
        assertNull(NotificationBackfill.dropReason(facts(visibility = Notification.VISIBILITY_PUBLIC)))
    }

    @Test
    fun new_reasons_log_under_their_own_keys() {
        assertEquals("other_profile", NotificationBackfill.DropReason.OTHER_PROFILE.key)
        assertEquals("secret", NotificationBackfill.DropReason.SECRET.key)
    }

    /** The 4-arg vectors signature stays own-profile/non-secret: old behaviour unchanged. */
    @Test
    fun facts_defaults_are_own_profile_and_private() {
        val f = NotificationBackfill.Facts("no.bank.mobile", null, 0, false)
        assertTrue(f.sameUser)
        assertEquals(Notification.VISIBILITY_PRIVATE, f.visibility)
        assertTrue(NotificationBackfill.isForwardable("no.bank.mobile", null, 0, false))
    }

    @Test
    fun counter_keys_are_unique_snake_case() {
        val keys = NotificationBackfill.DropReason.values().map { it.key }.toSet()
        assertEquals(NotificationBackfill.DropReason.values().size, keys.size)
        for (k in keys) assertTrue(k, k.matches(Regex("[a-z_]+")))
    }

    // ---------------------------------------------------------- T2 title

    @Test
    fun null_title_forwards_under_the_app_label() {
        assertEquals("DNB", NotificationBackfill.resolveTitle(null, "Payment received", "no.dnb") { "DNB" })
        assertEquals("DNB", NotificationBackfill.resolveTitle("  ", "Payment received", "no.dnb") { "DNB" })
    }

    @Test
    fun label_failure_falls_back_to_the_package_name() {
        assertEquals("no.dnb", NotificationBackfill.resolveTitle(null, "b", "no.dnb") { throw SecurityException() })
        assertEquals("no.dnb", NotificationBackfill.resolveTitle(null, "b", "no.dnb") { null })
        assertEquals("no.dnb", NotificationBackfill.resolveTitle(null, "b", "no.dnb") { "" })
    }

    @Test
    fun a_real_title_wins_and_empty_title_and_body_drops() {
        assertEquals("Hi", NotificationBackfill.resolveTitle("Hi", "", "p") { "L" })
        assertNull(NotificationBackfill.resolveTitle(null, "", "p") { "L" })
        assertNull(NotificationBackfill.resolveTitle("", "  ", "p") { "L" })
    }

    @Test
    fun label_is_only_looked_up_when_needed() {
        var calls = 0
        NotificationBackfill.resolveTitle("Title", "b", "p") { calls++; "L" }
        assertEquals(0, calls)
    }

    // ---------------------------------------------------------- T4 hygiene

    // sec C4: fixed test keys; production uses 32 random bytes per install (PkgHashKey).
    private val keyA = ByteArray(32) { it.toByte() }
    private val keyB = ByteArray(32) { (it + 1).toByte() }

    private fun split(d: ByteArray): String {
        val hex = d.take(4).joinToString("") { String.format("%02x", it) }
        return hex.substring(0, 4) + "_" + hex.substring(4)
    }

    @Test
    fun pkg_hash_is_8_hex_split_and_never_names_the_package() {
        val h = NotificationBackfill.pkgHash("no.dnb.mobilbank", keyA)
        assertTrue(h, h.matches(Regex("[0-9a-f]{4}_[0-9a-f]{4}")))
        assertFalse(h.contains("dnb"))
    }

    @Test
    fun pkg_hash_is_deterministic_under_the_same_key() {
        assertEquals(
            NotificationBackfill.pkgHash("no.dnb.mobilbank", keyA),
            NotificationBackfill.pkgHash("no.dnb.mobilbank", keyA.copyOf()),
        )
    }

    /** Pinned to an independent HMAC-SHA256, and NOT the old unsalted SHA-256. */
    @Test
    fun pkg_hash_is_hmac_sha256_not_the_unsalted_digest() {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(keyA, "HmacSHA256"))
        val expected = split(mac.doFinal("com.whatsapp".toByteArray()))
        assertEquals(expected, NotificationBackfill.pkgHash("com.whatsapp", keyA))
        val unsalted = split(java.security.MessageDigest.getInstance("SHA-256").digest("com.whatsapp".toByteArray()))
        assertFalse(unsalted == NotificationBackfill.pkgHash("com.whatsapp", keyA))
    }

    /** Another install (another key) gets unrelated handles: no cross-install dictionary. */
    @Test
    fun pkg_hash_differs_under_another_key() {
        var same = 0
        for (i in 0 until 200) {
            val p = "com.example.app$i"
            if (NotificationBackfill.pkgHash(p, keyA) == NotificationBackfill.pkgHash(p, keyB)) same++
        }
        assertEquals(0, same)
    }

    /** The redactor eats 7+ digit runs; the split keeps every handle intact. */
    @Test
    fun pkg_hash_survives_the_redactor_for_every_package() {
        for (i in 0 until 5000) {
            val h = NotificationBackfill.pkgHash("com.example.app$i", keyA)
            assertEquals(h, Redact.line(h))
        }
    }

    @Test
    fun rate_limiter_allows_20_per_minute_then_refuses() {
        var now = 1_000L
        val rl = DiagRateLimiter(clock = { now })
        repeat(20) { assertTrue(rl.tryAcquire()) }
        assertFalse(rl.tryAcquire())
        now += 59_999L
        assertFalse(rl.tryAcquire())
        now += 1L
        assertTrue(rl.tryAcquire())
    }
}
