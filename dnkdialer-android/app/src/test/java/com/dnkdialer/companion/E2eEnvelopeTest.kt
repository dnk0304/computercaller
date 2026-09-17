package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** E2E P4 Part 2 (c) — the sealed-frame envelope. */
class E2eEnvelopeTest {

    private val key = ByteArray(32) { (it * 3 + 1).toByte() }
    private val other = ByteArray(32) { (it * 5 + 2).toByte() }
    private val kid = "k-0001"

    private fun body(s: String) = s.toByteArray(Charsets.UTF_8)

    @Test
    fun `seal then open round trips through the wire JSON`() {
        val plain = body("""{"title":"Bank","text":"Your code is 448120"}""")
        val sealed = E2eEnvelope.seal(key, kid, 7, "PHONE_NOTIFICATION", plain)
        assertEquals(1, sealed.version)
        assertEquals(kid, sealed.kid)
        assertEquals(7, sealed.seq)

        val json = sealed.toJson()
        assertTrue(json, json.startsWith("""{"e":1,"kid":"k-0001","s":7,"c":""""))
        val parsed = E2eEnvelope.parse(json)
        assertEquals(sealed, parsed)
        assertArrayEquals(plain, E2eEnvelope.open(key, parsed, "PHONE_NOTIFICATION"))
    }

    /**
     * The length leak this whole layer exists to close. A 6-digit OTP and a
     * paragraph must produce the SAME ciphertext length.
     */
    @Test
    fun `ciphertext length does not track plaintext length inside a bucket`() {
        val otp = E2eEnvelope.seal(key, kid, 1, "PHONE_NOTIFICATION", body("448120"))
        val sentence = E2eEnvelope.seal(
            key, kid, 2, "PHONE_NOTIFICATION",
            body("are you free for a call this afternoon about the thing")
        )
        assertEquals(
            "a six-digit OTP and a sentence must be indistinguishable by length",
            otp.ciphertext.size, sentence.ciphertext.size
        )
        // Control: a genuinely large payload DOES land in a bigger bucket, so
        // the test is not passing because everything is one size.
        val big = E2eEnvelope.seal(key, kid, 3, "MESSAGES", ByteArray(3000))
        assertTrue(big.ciphertext.size > otp.ciphertext.size)
    }

    // ------------------------------------------------------ nonce and AAD

    @Test
    fun `the nonce is twelve bytes and unique per sequence`() {
        val seen = mutableSetOf<String>()
        for (s in listOf(0L, 1L, 255L, 256L, 65535L, 1L shl 32, Long.MAX_VALUE)) {
            val n = E2eEnvelope.nonceFor(s)
            assertEquals(12, n.size)
            assertTrue("nonces must not collide at s=$s", seen.add(E2eKdf.toHex(n)))
        }
        assertEquals("000000000000000000000000", E2eKdf.toHex(E2eEnvelope.nonceFor(0)))
        assertEquals("000000000000000000000001", E2eKdf.toHex(E2eEnvelope.nonceFor(1)))
        assertEquals("000000000000000100000000", E2eKdf.toHex(E2eEnvelope.nonceFor(1L shl 32)))
    }

    @Test
    fun `the AAD binds both kid and sequence`() {
        assertNotEquals(E2eKdf.toHex(E2eEnvelope.aad("a", 1)), E2eKdf.toHex(E2eEnvelope.aad("b", 1)))
        assertNotEquals(E2eKdf.toHex(E2eEnvelope.aad("a", 1)), E2eKdf.toHex(E2eEnvelope.aad("a", 2)))
        // Length-prefixed, so "ab"+seq cannot collide with "a"+"b"-shaped input.
        assertNotEquals(
            E2eKdf.toHex(E2eEnvelope.aad("ab", 1)),
            E2eKdf.toHex(E2eEnvelope.aad("a", 1))
        )
    }

    /**
     * A hostile relay must not be able to move a valid ciphertext to another
     * sequence number or key id. Both are bound in the AAD, so both fail to
     * authenticate — and per §13.5 that is a DROP (null), never a throw.
     */
    @Test
    fun `a relabelled frame does not authenticate`() {
        val plain = body("hello")
        val sealed = E2eEnvelope.seal(key, kid, 5, "SMS_RECEIVED", plain)

        val movedSeq = sealed.copy(seq = 6)
        val movedKid = sealed.copy(kid = "k-0002")
        val flipped = sealed.copy(
            ciphertext = sealed.ciphertext.copyOf().also { it[3] = (it[3].toInt() xor 1).toByte() }
        )

        assertNull("a frame moved to another sequence must not open",
            E2eEnvelope.open(key, movedSeq, "SMS_RECEIVED"))
        assertNull("a frame relabelled to another kid must not open",
            E2eEnvelope.open(key, movedKid, "SMS_RECEIVED"))
        assertNull("a bit-flipped ciphertext must not open",
            E2eEnvelope.open(key, flipped, "SMS_RECEIVED"))
        assertNull("the wrong key must not open it",
            E2eEnvelope.open(other, sealed, "SMS_RECEIVED"))
        assertNull("an unknown envelope version must not open",
            E2eEnvelope.open(key, sealed.copy(version = 2), "SMS_RECEIVED"))

        // Control: the untouched frame still opens, so the nulls above mean
        // something.
        assertArrayEquals(plain, E2eEnvelope.open(key, sealed, "SMS_RECEIVED"))
    }

    @Test
    fun `every single-bit flip in the ciphertext is caught`() {
        val sealed = E2eEnvelope.seal(key, kid, 1, "SMS_RECEIVED", body("x"))
        var flips = 0
        for (i in sealed.ciphertext.indices) {
            for (bit in 0 until 8) {
                val bad = sealed.copy(
                    ciphertext = sealed.ciphertext.copyOf()
                        .also { it[i] = (it[i].toInt() xor (1 shl bit)).toByte() }
                )
                assertNull("flip byte $i bit $bit opened", E2eEnvelope.open(key, bad, "SMS_RECEIVED"))
                flips++
            }
        }
        assertEquals(sealed.ciphertext.size * 8, flips)
        assertTrue("nothing was actually exercised", flips > 0)
    }

    // ---------------------------------------------------------- the Sender

    @Test
    fun `the Sender owns the counter so a nonce cannot be reused`() {
        val s = E2eEnvelope.Sender(key.copyOf(), kid)
        assertEquals(0, s.nextSeq)
        val a = s.seal("SMS_RECEIVED", body("one"))
        val b = s.seal("SMS_RECEIVED", body("two"))
        val c = s.seal("SMS_RECEIVED", body("three"))
        assertEquals(listOf(0L, 1L, 2L), listOf(a.seq, b.seq, c.seq))
        assertEquals(3, s.nextSeq)
        // Distinct nonces mean distinct ciphertexts even for identical bodies.
        val d = s.seal("SMS_RECEIVED", body("one"))
        assertNotEquals(E2eKdf.toHex(a.ciphertext), E2eKdf.toHex(d.ciphertext))
    }

    @Test
    fun `zeroize clears the sender key`() {
        val k = key.copyOf()
        E2eEnvelope.Sender(k, kid).zeroize()
        assertArrayEquals(ByteArray(32), k)
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
        // Tolerant of an unknown ADDITIVE field, so a newer peer does not break
        // an older phone.
        val ok = E2eEnvelope.parse("""{"e":1,"kid":"k","s":1,"c":"AA","future":true}""")
        assertEquals("k", ok.kid)
    }

    @Test
    fun `a wrong-size key is refused rather than silently padded`() {
        for (n in listOf(0, 16, 31, 33, 64)) {
            try {
                E2eEnvelope.seal(ByteArray(n), kid, 1, null, body("x"))
                fail("accepted a $n-byte key")
            } catch (e: E2eEnvelope.EnvelopeException) {
                assertTrue(e.message!!.contains("AES-256"))
            }
        }
    }

    @Test
    fun `a CHUNK frame is sealed without padding`() {
        val body = ByteArray(1000) { 9 }
        val sealed = E2eEnvelope.seal(key, kid, 1, "MESSAGES_CHUNK", body)
        // Unpadded: ciphertext is the plaintext length plus the 16-byte GCM tag.
        assertEquals(1000 + 16, sealed.ciphertext.size)
        assertArrayEquals(body, E2eEnvelope.open(key, sealed, "MESSAGES_CHUNK"))
        // And a padded frame of the same size is bigger, proving the exemption
        // is actually doing something.
        assertTrue(E2eEnvelope.seal(key, kid, 2, "MESSAGES", body).ciphertext.size > sealed.ciphertext.size)
    }

    /**
     * The frame type travels in the clear and is NOT authenticated — it only
     * selects the padding rule. Opening a padded frame as if it were exempt
     * therefore returns the raw padded block, not the plaintext. That is the
     * honest behaviour (GCM still authenticated the bytes), and it is asserted
     * here so nobody later mistakes it for a decrypt oracle.
     */
    @Test
    fun `the frame type selects padding only and is not authenticated`() {
        val plain = body("abc")
        val sealed = E2eEnvelope.seal(key, kid, 1, "SMS_RECEIVED", plain)

        val correct = E2eEnvelope.open(key, sealed, "SMS_RECEIVED")
        assertArrayEquals(plain, correct)

        val asChunk = E2eEnvelope.open(key, sealed, "SMS_RECEIVED_CHUNK")
        assertTrue("the ciphertext still authenticates", asChunk != null)
        assertEquals("what comes back is the 64-byte padded block", 64, asChunk!!.size)
        assertTrue("…and it is NOT the plaintext", !asChunk.contentEquals(plain))
        // The length prefix is still there, which is what makes it recoverable.
        assertArrayEquals(plain, E2ePadding.unpad("SMS_RECEIVED", asChunk))
    }
}
