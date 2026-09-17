package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * E2E P4 Part 2 (c2) — the envelope, against GATE1 Addendum A1.
 *
 * The A1 vectors themselves live in [E2eAeadVectorsTest]; this file covers the
 * behaviour around them.
 */
class E2eEnvelopeTest {

    private val key = ByteArray(32) { (it * 3 + 1).toByte() }
    private val other = ByteArray(32) { (it * 5 + 2).toByte() }
    private val kid = "k-0001"
    private val prefix = byteArrayOf(0x0a, 0x0b, 0x0c, 0x0d)
    private val p2c = E2eEnvelope.Direction.PHONE_TO_COMPUTER
    private val epoch = 5L

    private fun body(s: String) = s.toByteArray(Charsets.UTF_8)

    private fun seal(seq: Long, frameType: String, plaintext: ByteArray) =
        E2eEnvelope.seal(key, kid, seq, p2c, epoch, prefix, frameType, plaintext)

    private fun open(sealed: E2eEnvelope.Sealed, frameType: String) =
        E2eEnvelope.open(key, sealed, p2c, epoch, prefix, frameType)

    @Test
    fun `seal then open round trips through the wire JSON`() {
        val plain = body("""{"title":"Bank","text":"Your code is 448120"}""")
        val sealed = seal(7, "PHONE_NOTIFICATION", plain)
        assertEquals(1, sealed.version)
        assertEquals(kid, sealed.kid)
        assertEquals(7, sealed.seq)

        val json = sealed.toJson()
        assertTrue(json, json.startsWith("""{"e":1,"kid":"k-0001","s":7,"c":""""))
        val parsed = E2eEnvelope.parse(json)
        assertEquals(sealed, parsed)
        assertArrayEquals(plain, open(parsed, "PHONE_NOTIFICATION"))
    }

    /**
     * The length leak the padding layer exists to close. A 6-digit OTP and a
     * sentence must seal to the same ciphertext length.
     */
    @Test
    fun `ciphertext length does not track plaintext length inside a bucket`() {
        val otp = seal(1, "PHONE_NOTIFICATION", body("448120"))
        val sentence = seal(
            2, "PHONE_NOTIFICATION",
            body("are you free for a call this afternoon about the thing")
        )
        assertEquals(otp.ciphertext.size, sentence.ciphertext.size)
        // Control: a genuinely large payload lands in a bigger bucket, so this
        // is not passing because everything is one size.
        assertTrue(seal(3, "MESSAGES", ByteArray(3000)).ciphertext.size > otp.ciphertext.size)
    }

    // -------------------------------------------------------------- nonce

    @Test
    fun `the nonce is prefix then be64 seq and never repeats under one prefix`() {
        val seen = mutableSetOf<String>()
        for (s in listOf(0L, 1L, 255L, 256L, 65535L, 1L shl 32, Long.MAX_VALUE)) {
            val n = E2eEnvelope.nonceFor(prefix, s)
            assertEquals(12, n.size)
            assertTrue("nonce collision at s=$s", seen.add(E2eKdf.toHex(n)))
            assertTrue(E2eKdf.toHex(n).startsWith("0a0b0c0d"))
        }
        assertEquals("0a0b0c0d0000000000000000", E2eKdf.toHex(E2eEnvelope.nonceFor(prefix, 0)))
    }

    @Test
    fun `a wrong-size session prefix is refused`() {
        for (n in listOf(0, 3, 5, 12)) {
            try {
                E2eEnvelope.nonceFor(ByteArray(n), 1)
                fail("accepted a $n-byte session prefix")
            } catch (e: E2eEnvelope.EnvelopeException) {
                assertTrue(e.message!!.contains("sessionPrefix"))
            }
        }
    }

    /**
     * Two sessions with different prefixes produce different ciphertexts for
     * the same (key, seq, plaintext). The prefix is defence in depth against a
     * state-restore bug — A1 is explicit that it is NOT what makes nonces
     * unique, but it must still actually reach the nonce.
     */
    @Test
    fun `the session prefix reaches the nonce`() {
        val a = E2eEnvelope.seal(key, kid, 1, p2c, epoch, byteArrayOf(1, 1, 1, 1), "SMS_RECEIVED", body("x"))
        val b = E2eEnvelope.seal(key, kid, 1, p2c, epoch, byteArrayOf(2, 2, 2, 2), "SMS_RECEIVED", body("x"))
        assertNotEquals(E2eKdf.toHex(a.ciphertext), E2eKdf.toHex(b.ciphertext))
    }

    // ------------------------------------------------------- authentication

    @Test
    fun `every single-bit flip in the ciphertext is caught`() {
        val sealed = seal(1, "SMS_RECEIVED", body("x"))
        var flips = 0
        for (i in sealed.ciphertext.indices) {
            for (bit in 0 until 8) {
                val bad = sealed.copy(
                    ciphertext = sealed.ciphertext.copyOf()
                        .also { it[i] = (it[i].toInt() xor (1 shl bit)).toByte() }
                )
                assertNull("flip byte $i bit $bit opened", open(bad, "SMS_RECEIVED"))
                flips++
            }
        }
        assertEquals(sealed.ciphertext.size * 8, flips)
        assertTrue("nothing was exercised", flips > 0)
    }

    @Test
    fun `the wrong key and an unknown version do not open`() {
        val sealed = seal(5, "SMS_RECEIVED", body("hello"))
        assertNull(E2eEnvelope.open(other, sealed, p2c, epoch, prefix, "SMS_RECEIVED"))
        assertNull(open(sealed.copy(version = 2), "SMS_RECEIVED"))
        // Control.
        assertArrayEquals(body("hello"), open(sealed, "SMS_RECEIVED"))
    }

    /**
     * An over-long kid arriving from the wire is a hostile or corrupt frame, not
     * a local bug: [E2eEnvelope.open] must DROP it (null) rather than throw, per
     * §13.5. Sealing one is a local bug and must throw.
     */
    @Test
    fun `an over-long kid drops on receive but throws on send`() {
        val long = "k".repeat(256)
        assertNull(
            E2eEnvelope.open(
                key, E2eEnvelope.Sealed(1, long, 1, ByteArray(80)), p2c, epoch, prefix, "SMS_RECEIVED"
            )
        )
        try {
            E2eEnvelope.seal(key, long, 1, p2c, epoch, prefix, "SMS_RECEIVED", body("x"))
            fail("sealed under a 256-byte kid")
        } catch (e: E2eEnvelope.EnvelopeException) {
            assertTrue(e.message!!.contains("255"))
        }
    }

    // -------------------------------------------------------- malformed

    @Test
    fun `malformed envelopes are refused at parse`() {
        for (bad in listOf(
            "not json",
            "[]",
            """{"kid":"k","s":1,"c":"AA"}""",
            """{"e":1,"s":1,"c":"AA"}""",
            """{"e":1,"kid":"k","c":"AA"}""",
            """{"e":1,"kid":"k","s":1}""",
            """{"e":1,"kid":"","s":1,"c":"AA"}""",
            """{"e":1,"kid":"k","s":-1,"c":"AA"}""",
        )) {
            try {
                E2eEnvelope.parse(bad)
                fail("accepted: $bad")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
        // Tolerant of an unknown ADDITIVE field so a newer peer does not break
        // an older phone.
        assertEquals("k", E2eEnvelope.parse("""{"e":1,"kid":"k","s":1,"c":"AA","future":true}""").kid)
    }

    @Test
    fun `a wrong-size key is refused rather than silently padded`() {
        for (n in listOf(0, 16, 31, 33, 64)) {
            try {
                E2eEnvelope.seal(ByteArray(n), kid, 1, p2c, epoch, prefix, "SMS_RECEIVED", body("x"))
                fail("accepted a $n-byte key")
            } catch (e: E2eEnvelope.EnvelopeException) {
                assertTrue(e.message!!.contains("AES-256"))
            }
        }
    }

    @Test
    fun `a CHUNK frame is sealed without padding`() {
        val payload = ByteArray(1000) { 9 }
        val sealed = seal(1, "MESSAGES_CHUNK", payload)
        // Unpadded: plaintext length plus the 16-byte GCM tag.
        assertEquals(1000 + 16, sealed.ciphertext.size)
        assertArrayEquals(payload, open(sealed, "MESSAGES_CHUNK"))
        assertTrue(seal(2, "MESSAGES", payload).ciphertext.size > sealed.ciphertext.size)
    }

    /**
     * frameType is bound in the AAD (A1), so unlike P4's original proposal a
     * mismatched frame type no longer returns the padded block — it fails to
     * authenticate outright. That is strictly better: the relay cannot relabel
     * a sealed CALL_STATUS as an SMS_RECEIVED.
     */
    @Test
    fun `a mismatched frame type fails authentication`() {
        val sealed = seal(1, "SMS_RECEIVED", body("abc"))
        assertNull(open(sealed, "SMS_RECEIVED_CHUNK"))
        assertNull(open(sealed, "CALL_STATUS"))
        assertArrayEquals(body("abc"), open(sealed, "SMS_RECEIVED"))
    }
}
