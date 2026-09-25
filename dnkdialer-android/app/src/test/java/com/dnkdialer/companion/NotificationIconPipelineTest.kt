package com.dnkdialer.companion

import com.dnkdialer.companion.NotificationIconPipeline.Source
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * ALERT-ICONS (vc69): the rules behind the icon the phone sends — size cap,
 * source chain (extras appInfo -> PackageManager -> null), cache key, byte cap.
 */
class NotificationIconPipelineTest {

    private fun str(n: Int) = "A".repeat(n)
    private val CAP = NotificationIconPipeline.MAX_ENCODED_BYTES

    // ------------------------------------------------------------- size cap

    @Test
    fun size_cap_96_fits_is_used_and_64_never_rendered() {
        val asked = mutableListOf<Int>()
        val out = NotificationIconPipeline.encodeCapped { px -> asked += px; str(CAP) }
        assertEquals(CAP, out.length)
        assertEquals(listOf(96), asked)
    }

    @Test
    fun size_cap_96_too_big_falls_back_to_64() {
        val asked = mutableListOf<Int>()
        val out = NotificationIconPipeline.encodeCapped { px ->
            asked += px; if (px == 96) str(CAP + 1) else "small64"
        }
        assertEquals("small64", out)
        assertEquals(listOf(96, 64), asked)
    }

    @Test
    fun size_cap_both_too_big_is_no_icon() {
        try {
            NotificationIconPipeline.encodeCapped { str(CAP + 1) }
            fail("expected IconTooLargeException")
        } catch (e: NotificationIconPipeline.IconTooLargeException) { /* ok */ }
        // Through the chain, that becomes null + a failure naming the class.
        val failures = mutableListOf<String>()
        val icon = NotificationIconPipeline.resolve(
            listOf(Source.EXTRAS to { NotificationIconPipeline.encodeCapped { str(CAP + 1) } }),
        ) { s, t -> failures += NotificationIconPipeline.failureLine("p", s, t) }
        assertNull(icon)
        assertEquals(listOf("Failed to capture icon pkg=p source=extras cause=IconTooLargeException"), failures)
    }

    // ------------------------------------------------------------- source chain

    @Test
    fun extras_present_is_used_and_pm_not_called() {
        var pmCalled = false
        val icon = NotificationIconPipeline.resolve(
            listOf(
                Source.EXTRAS to { "fromExtras" },
                Source.PM to { pmCalled = true; "fromPm" },
            ),
        ) { _, _ -> fail("no failure expected") }
        assertEquals("fromExtras", icon)
        assertFalse(pmCalled)
    }

    @Test
    fun extras_absent_falls_through_to_pm_without_a_failure() {
        val icon = NotificationIconPipeline.resolve(
            listOf(Source.EXTRAS to { null }, Source.PM to { "fromPm" }),
        ) { _, _ -> fail("absent extras is not a failure") }
        assertEquals("fromPm", icon)
    }

    @Test
    fun extras_throws_then_pm_succeeds_is_not_logged() {
        val icon = NotificationIconPipeline.resolve(
            listOf(Source.EXTRAS to { throw OutOfMemoryError() }, Source.PM to { "fromPm" }),
        ) { _, _ -> fail("an icon was produced") }
        assertEquals("fromPm", icon)
    }

    @Test
    fun success_callback_reports_the_winning_source_once() {
        val wins = mutableListOf<String>()
        val icon = NotificationIconPipeline.resolve(
            listOf(Source.EXTRAS to { null }, Source.PM to { "ABCD" }),
            onSuccess = { s, b64 -> wins += NotificationIconPipeline.successLine("com.discord", s, b64) },
        ) { _, _ -> fail("an icon was produced") }
        assertEquals("ABCD", icon)
        assertEquals(listOf("Captured icon pkg=com.discord source=pm bytes=4"), wins)
    }

    // Stand-in for PackageManager.NameNotFoundException (not loadable on the JVM).
    private class NameNotFoundException : Exception()

    @Test
    fun both_fail_returns_null_and_exactly_one_log_line() {
        val lines = mutableListOf<String>()
        val once = NotificationIconPipeline.OncePerKey()
        repeat(3) {
            val icon = NotificationIconPipeline.resolve(
                listOf(
                    Source.EXTRAS to { throw IllegalStateException() },
                    Source.PM to { throw NameNotFoundException() },
                ),
            ) { s, t -> if (once.first("com.whatsapp")) lines += NotificationIconPipeline.failureLine("com.whatsapp", s, t) }
            assertNull(icon)
        }
        assertEquals(
            listOf("Failed to capture icon pkg=com.whatsapp source=pm cause=NameNotFoundException"),
            lines,
        )
    }

    @Test
    fun once_per_key_is_per_package() {
        val once = NotificationIconPipeline.OncePerKey()
        assertTrue(once.first("a"))
        assertFalse(once.first("a"))
        assertTrue(once.first("b"))
    }

    // ------------------------------------------------------------- cache

    @Test
    fun cache_key_includes_user() {
        val personal = NotificationIconPipeline.cacheKey("com.whatsapp", "UserHandle{0}")
        val work = NotificationIconPipeline.cacheKey("com.whatsapp", "UserHandle{10}")
        assertNotEquals(personal, work)
        val cache = ByteCappedIconCache(1_000)
        cache.put(personal, "P")
        assertNull("work profile must not hit the personal entry", cache.get(work))
        assertEquals("P", cache.get(personal))
    }

    @Test
    fun cache_is_capped_by_bytes_evicting_least_recent() {
        val cache = ByteCappedIconCache(100)
        cache.put("a", str(40))
        cache.put("b", str(40))
        cache.get("a") // a is now most recent
        cache.put("c", str(40)) // 120 > 100 -> evict b
        assertNull(cache.get("b"))
        assertEquals(40, cache.get("a")?.length)
        assertEquals(40, cache.get("c")?.length)
        assertEquals(80, cache.totalBytes())
        cache.put("huge", str(101))
        assertNull("entry larger than the cap is not stored", cache.get("huge"))
        assertEquals(80, cache.totalBytes())
        cache.put("a", str(10)) // replace updates the byte count
        assertEquals(50, cache.totalBytes())
    }

    @Test
    fun cache_cap_default_is_about_1_5_mb() {
        assertEquals(1_500_000L, NotificationIconPipeline.CACHE_MAX_BYTES)
    }
}
