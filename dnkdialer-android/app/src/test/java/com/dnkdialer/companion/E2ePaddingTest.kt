package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * E2E P4 Part 2 (c) — padding, against E2E-SPEC §13.4 and `lib/e2e/padding.mjs`.
 *
 * Mirrors the web lane's `tests/padding-property.test.mjs`: 500 plaintexts
 * including 1 B and 100 KB, plus a discrimination check — a bucket ladder that
 * mapped everything to one length would pass a naive round-trip test while
 * hiding nothing at all.
 */
class E2ePaddingTest {

    @Test
    fun `the bucket ladder matches the frozen table`() {
        // Below the top bucket: exactly the six fixed sizes, with the 4-byte
        // prefix counted IN (so 60 bytes fits 64, but 61 does not).
        assertEquals(64, E2ePadding.bucketFor(0))
        assertEquals(64, E2ePadding.bucketFor(60))
        assertEquals(128, E2ePadding.bucketFor(61))
        assertEquals(128, E2ePadding.bucketFor(124))
        assertEquals(256, E2ePadding.bucketFor(125))
        assertEquals(2048, E2ePadding.bucketFor(2044))
        // Gap (i): above the top bucket, round UP to the next whole step —
        // never an unpadded tail.
        assertEquals(4096, E2ePadding.bucketFor(2045))
        assertEquals(4096, E2ePadding.bucketFor(4092))
        assertEquals(6144, E2ePadding.bucketFor(4093))
        assertEquals(102400, E2ePadding.bucketFor(100 * 1024 - 4))
    }

    @Test
    fun `every padded length is a legal bucket and nothing is left unpadded`() {
        val legal = mutableSetOf(64, 128, 256, 512, 1024, 2048)
        var n = 4096
        while (n <= 200_000) { legal.add(n); n += 2048 }
        for (len in listOf(0, 1, 59, 60, 61, 2044, 2045, 5000, 100 * 1024)) {
            val padded = E2ePadding.pad("SMS_RECEIVED", ByteArray(len))
            assertTrue("length $len -> ${padded.size} is not a legal bucket",
                legal.contains(padded.size))
            assertEquals(0, padded.size % if (padded.size > 2048) 2048 else padded.size)
        }
    }

    @Test
    fun `500 plaintexts round trip including 1B and 100KB`() {
        val rnd = java.util.Random(0xBADC0DE)
        val sizes = mutableListOf(0, 1, 2, 3, 4, 59, 60, 61, 2043, 2044, 2045, 100 * 1024)
        while (sizes.size < 500) sizes.add(rnd.nextInt(5000))
        val bucketsSeen = mutableSetOf<Int>()
        for (len in sizes) {
            val plain = ByteArray(len).also { rnd.nextBytes(it) }
            val padded = E2ePadding.pad("PHONE_NOTIFICATION", plain)
            bucketsSeen.add(padded.size)
            assertEquals("padded size must be the bucket", E2ePadding.bucketFor(len), padded.size)
            assertArrayEquals(
                "round trip at len=$len",
                plain,
                E2ePadding.unpad("PHONE_NOTIFICATION", padded)
            )
        }
        // Discrimination: a ladder that collapsed everything to one length would
        // round-trip perfectly and hide nothing.
        assertTrue("only ${bucketsSeen.size} distinct buckets — the ladder is not discriminating",
            bucketsSeen.size >= 5)
    }

    /**
     * The reason the length prefix exists. 0x00 is legal plaintext, so a
     * "strip trailing zeros" unpadder corrupts any payload ending in one — and
     * the corruption is silent.
     */
    @Test
    fun `a plaintext ending in zero bytes survives`() {
        for (trailing in 1..40) {
            val plain = ByteArray(50).also { it.fill(0x41, 0, 50 - trailing) }
            val back = E2ePadding.unpad("SMS_RECEIVED", E2ePadding.pad("SMS_RECEIVED", plain))
            assertArrayEquals("lost $trailing trailing zero bytes", plain, back)
            assertEquals(50, back.size)
        }
        // An all-zero plaintext is the extreme case.
        assertEquals(17, E2ePadding.unpad("SMS_RECEIVED", E2ePadding.pad("SMS_RECEIVED", ByteArray(17))).size)
    }

    @Test
    fun `CHUNK frames are exempt by suffix and everything else pads`() {
        val body = ByteArray(10) { 7 }
        for (t in listOf("MESSAGES_CHUNK", "CONTACTS_CHUNK", "CALL_LOGS_CHUNK",
            "MMS_MEDIA_CHUNK", "SOME_FUTURE_CHUNK")) {
            assertTrue("$t must be exempt", E2ePadding.isExempt(t))
            assertArrayEquals("$t must pass through untouched", body, E2ePadding.pad(t, body))
            assertArrayEquals(body, E2ePadding.unpad(t, body))
        }
        // M7 gap (ii): the call frames pad. A caller's number length is exactly
        // the kind of short secret buckets exist to hide.
        for (t in listOf("CALL_INCOMING", "CALL_WAITING", "CALL_STATUS",
            "PHONE_NOTIFICATION", "SMS_RECEIVED", "MESSAGES", null)) {
            assertTrue("$t must NOT be exempt", !E2ePadding.isExempt(t))
            assertEquals("$t must pad to a bucket", 64, E2ePadding.pad(t, body).size)
        }
    }

    /**
     * A tampered frame must fail loudly. The one thing it must never do is
     * return a truncated payload that looks like a short message.
     */
    @Test
    fun `malformed padded frames are refused not truncated`() {
        val good = E2ePadding.pad("SMS_RECEIVED", ByteArray(20) { 3 })
        assertEquals(64, good.size)

        val cases = mapOf(
            "prefix claims more than the bucket holds" to good.copyOf().also {
                it[2] = 0xff.toByte(); it[3] = 0xff.toByte()
            },
            "not a legal bucket length" to good.copyOf(63),
            "shorter than the prefix" to good.copyOf(3),
            "prefix claims a negative length" to good.copyOf().also { it[0] = 0xff.toByte() },
        )
        for ((label, bad) in cases) {
            try {
                E2ePadding.unpad("SMS_RECEIVED", bad)
                fail("accepted a frame that $label")
            } catch (e: E2ePadding.PaddingException) {
                assertTrue(label, e.message!!.isNotEmpty())
            }
        }
        // Control: the untampered frame still opens.
        assertEquals(20, E2ePadding.unpad("SMS_RECEIVED", good).size)
    }

    @Test
    fun `a negative length is refused`() {
        try {
            E2ePadding.bucketFor(-1)
            fail("accepted a negative length")
        } catch (e: E2ePadding.PaddingException) {
            assertTrue(e.message!!.contains("non-negative"))
        }
    }
}
