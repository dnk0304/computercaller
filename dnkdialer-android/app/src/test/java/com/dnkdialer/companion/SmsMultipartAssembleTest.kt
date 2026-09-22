package com.dnkdialer.companion

import org.junit.Assert.assertEquals
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
}
