package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * SMSMP — `SmsReceiver.assemble` (2026-09-22).
 *
 * Regression: a concatenated (multipart) SMS reached the web client as N
 * fragment frames — one per PDU part, in framework order — followed by the
 * assembled copy from the ContentObserver. `assemble` collapses the parts of
 * one broadcast into exactly one emit.
 *
 * Fixture text is lorem-style on purpose; no real message content lives here.
 */
class SmsMultipartAssembleTest {

    private fun part(body: String?, time: Long = 1_000L, from: String? = "+15551234567") =
        SmsReceiver.SmsPart(from, body, time)

    @Test
    fun `single part passes through unchanged`() {
        val out = SmsReceiver.assemble(listOf(part("Lorem ipsum dolor sit amet.")))!!
        assertEquals("Lorem ipsum dolor sit amet.", out.body)
        assertEquals("+15551234567", out.from)
        assertEquals(1_000L, out.time)
    }

    @Test
    fun `three parts concatenate in array order`() {
        val out = SmsReceiver.assemble(
            listOf(
                part("Lorem ipsum dolor sit amet, ", time = 3_000L),
                part("consectetur adipiscing elit, ", time = 4_000L),
                part("sed do eiusmod tempor.", time = 5_000L),
            )
        )!!
        assertEquals(
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
            out.body
        )
        assertEquals("+15551234567", out.from)
        // MIN over parts — earliest, and order-independent.
        assertEquals(3_000L, out.time)
    }

    @Test
    fun `array order is preserved even when timestamps descend`() {
        // Guards against anyone "fixing" ordering by sorting on timestampMillis:
        // SMSC times have 1 s granularity and are not a reliable sequence key.
        val out = SmsReceiver.assemble(
            listOf(
                part("alpha ", time = 9_000L),
                part("beta ", time = 2_000L),
                part("gamma", time = 7_000L),
            )
        )!!
        assertEquals("alpha beta gamma", out.body)
        assertEquals(2_000L, out.time)
    }

    @Test
    fun `empty part list yields null so nothing is emitted`() {
        assertNull(SmsReceiver.assemble(emptyList()))
    }

    @Test
    fun `null bodies contribute nothing and never crash`() {
        val out = SmsReceiver.assemble(listOf(part(null), part("tail", time = 2_000L)))!!
        assertEquals("tail", out.body)
        assertEquals(1_000L, out.time)
    }

    @Test
    fun `first non-blank originating address wins`() {
        val out = SmsReceiver.assemble(
            listOf(part("a", from = null), part("b", from = ""), part("c", from = "+15559876543"))
        )!!
        assertEquals("+15559876543", out.from)
        assertEquals("abc", out.body)
    }

    @Test
    fun `all addresses null falls back to Unknown`() {
        val out = SmsReceiver.assemble(listOf(part("a", from = null), part("b", from = null)))!!
        assertEquals("Unknown", out.from)
    }

    // --- SMSMP-2: the EMITTED frame is stamped with the receiver's wall clock ---

    @Test
    fun `emitted time is the injected now, not the part minimum`() {
        val now = 1_700_000_000_000L
        val out = SmsReceiver.assembleForEmit(
            listOf(
                part("Lorem ipsum ", time = 3_000L),
                part("dolor sit amet.", time = 4_000L),
            ),
            now,
        )!!
        // The whole point: NOT 3_000L (min over parts), NOT 4_000L.
        assertEquals(now, out.time)
        assertNotEquals(3_000L, out.time)
        // Body/from still come from assemble() unchanged.
        assertEquals("Lorem ipsum dolor sit amet.", out.body)
        assertEquals("+15551234567", out.from)
    }

    @Test
    fun `single part is also stamped with now`() {
        val now = 1_700_000_042_000L
        val out = SmsReceiver.assembleForEmit(listOf(part("Lorem ipsum.", time = 1_000L)), now)!!
        assertEquals(now, out.time)
        assertEquals("Lorem ipsum.", out.body)
    }

    @Test
    fun `assemble still reports the SMSC minimum for diagnostics`() {
        // assembleForEmit must not mutate assemble()'s contract — the min-over-
        // parts time stays available for the smscSkewMs diagnostic log.
        val parts = listOf(part("a", time = 9_000L), part("b", time = 2_000L))
        assertEquals(2_000L, SmsReceiver.assemble(parts)!!.time)
        assertEquals(5L, SmsReceiver.assembleForEmit(parts, 5L)!!.time)
    }

    @Test
    fun `empty part list yields null from assembleForEmit too`() {
        assertNull(SmsReceiver.assembleForEmit(emptyList(), 1_700_000_000_000L))
    }
}
