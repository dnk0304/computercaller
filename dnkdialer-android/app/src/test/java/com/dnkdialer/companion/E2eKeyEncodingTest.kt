package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * E2E P4 Part 2 (a1) — the encoding tests.
 *
 * These exist because a wrong public-key encoding is not a crash. It is five
 * digits that never match the browser's five digits, with every log line
 * reporting success. Both directions are asserted, and the naive-encoding
 * failure mode (a coordinate whose big-endian form is not exactly 32 bytes) is
 * hunted down explicitly rather than left to luck.
 */
class E2eKeyEncodingTest {

    private fun p256KeyPair(): KeyPair {
        val g = KeyPairGenerator.getInstance("EC")
        g.initialize(ECGenParameterSpec("secp256r1"))
        return g.generateKeyPair()
    }

    // ------------------------------------------------------- round trip

    @Test
    fun `sec1 round trips through the JCE and back to identical bytes`() {
        repeat(200) {
            val pub = p256KeyPair().public as ECPublicKey
            val sec1 = E2eKeyEncoding.toSec1(pub)
            assertEquals("SEC1 length", 65, sec1.size)
            assertEquals("SEC1 tag", 0x04.toByte(), sec1[0])

            val decoded = E2eKeyEncoding.fromSec1(sec1)
            assertEquals("X survives the round trip", pub.w.affineX, decoded.w.affineX)
            assertEquals("Y survives the round trip", pub.w.affineY, decoded.w.affineY)
            assertArrayEquals("re-encoding is byte-identical", sec1, E2eKeyEncoding.toSec1(decoded))
        }
    }

    /**
     * The whole reason [E2eKeyEncoding] does not call `BigInteger.toByteArray()`
     * directly. Two distinct hazards, both hunted to a hit rather than assumed:
     *
     *  - high bit set  -> toByteArray() returns 33 bytes (leading 0x00 sign byte)
     *  - value < 2^248 -> toByteArray() returns 31 bytes or fewer
     *
     * The first happens for ~half of all keys, the second for ~1 coordinate in
     * 256. Over 4000 coordinates the chance of never seeing a short one is about
     * e^-15. If it somehow does not appear the test FAILS rather than passing
     * quietly, because a property test that never met its property proved
     * nothing.
     */
    @Test
    fun `fixed width padding survives both naive-toByteArray hazards`() {
        var sawSignByte = false
        var sawShort = false
        var checked = 0
        for (i in 0 until 2000) {
            val pub = p256KeyPair().public as ECPublicKey
            val sec1 = E2eKeyEncoding.toSec1(pub)
            for (coord in listOf(pub.w.affineX, pub.w.affineY)) {
                val raw = coord.toByteArray()
                if (raw.size == 33 && raw[0] == 0.toByte()) sawSignByte = true
                if (raw.size < 32) sawShort = true
                checked++
            }
            // Regardless of the coordinate's natural width the encoding is fixed.
            assertEquals("SEC1 stays 65 bytes for key #$i", 65, sec1.size)
            assertEquals(pub.w.affineX, BigInteger(1, sec1.copyOfRange(1, 33)))
            assertEquals(pub.w.affineY, BigInteger(1, sec1.copyOfRange(33, 65)))
            if (sawSignByte && sawShort) break
        }
        assertTrue("checked $checked coordinates", checked > 0)
        assertTrue("never met a high-bit coordinate — the test proved nothing", sawSignByte)
        assertTrue("never met a sub-32-byte coordinate — the test proved nothing", sawShort)
    }

    /**
     * Pins the exact confusion this file exists to prevent: Part 1 published
     * `PublicKey.getEncoded()`, and that is a 91-byte X.509 SubjectPublicKeyInfo,
     * not the 65-byte point the Gate 1 ruling puts on the wire.
     */
    @Test
    fun `x509 getEncoded is NOT the wire format`() {
        val pub = p256KeyPair().public
        val spki = pub.encoded
        val sec1 = E2eKeyEncoding.toSec1(pub)
        assertEquals("a P-256 SPKI is 91 bytes", 91, spki.size)
        assertEquals(65, sec1.size)
        assertNotEquals("SPKI and SEC1 must not be confusable", spki.size, sec1.size)
        // The SEC1 point is a SUFFIX of the SPKI — which is precisely why the
        // mistake is easy to make and impossible to see in a hex dump glance.
        assertArrayEquals(sec1, spki.copyOfRange(spki.size - 65, spki.size))
        assertTrue("SPKI must be rejected as a wire key", !E2eKeyEncoding.isValid(spki))
    }

    // -------------------------------------------------------- validation

    @Test
    fun `wrong length is rejected`() {
        for (n in listOf(0, 1, 32, 64, 66, 91, 33)) {
            val bytes = ByteArray(n) { if (it == 0) 0x04 else 0x01 }
            assertTrue("length $n must be rejected", !E2eKeyEncoding.isValid(bytes))
        }
    }

    @Test
    fun `compressed points are rejected not decompressed`() {
        val pub = p256KeyPair().public as ECPublicKey
        val sec1 = E2eKeyEncoding.toSec1(pub)
        for (tag in listOf(0x00, 0x02, 0x03, 0x05, 0xff)) {
            val bad = sec1.copyOf()
            bad[0] = tag.toByte()
            assertTrue("tag 0x%02x must be rejected".format(tag), !E2eKeyEncoding.isValid(bad))
        }
    }

    @Test
    fun `the identity point is rejected`() {
        val bad = ByteArray(65)
        bad[0] = 0x04
        assertTrue(!E2eKeyEncoding.isValid(bad))
        try {
            E2eKeyEncoding.validate(bad)
            fail("expected InvalidPublicKeyException")
        } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
            assertTrue(
                "the message must name the identity, not just 'invalid': ${e.message}",
                e.message!!.contains("identity")
            )
        }
    }

    @Test
    fun `coordinates at or above p are rejected`() {
        val pub = p256KeyPair().public as ECPublicKey
        val sec1 = E2eKeyEncoding.toSec1(pub)
        // p itself, and p-1 (in range but almost certainly off-curve).
        val p = BigInteger(
            "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16
        )
        val pBytes = fixed32(p)
        val xTooBig = sec1.copyOf()
        System.arraycopy(pBytes, 0, xTooBig, 1, 32)
        assertTrue("X = p must be rejected", !E2eKeyEncoding.isValid(xTooBig))

        val yTooBig = sec1.copyOf()
        System.arraycopy(pBytes, 0, yTooBig, 33, 32)
        assertTrue("Y = p must be rejected", !E2eKeyEncoding.isValid(yTooBig))

        val allFf = ByteArray(65) { 0xff.toByte() }
        allFf[0] = 0x04
        assertTrue("0xff... must be rejected", !E2eKeyEncoding.isValid(allFf))
    }

    /**
     * The invalid-curve check. Every single-bit flip in either coordinate takes
     * the point off P-256, and every one must be caught — a validator that
     * catches "most" flips is a validator an attacker searches around.
     */
    @Test
    fun `every single-bit flip is caught as off-curve`() {
        val pub = p256KeyPair().public as ECPublicKey
        val sec1 = E2eKeyEncoding.toSec1(pub)
        assertTrue("control: the unmodified key is valid", E2eKeyEncoding.isValid(sec1))
        var flips = 0
        for (byteIndex in 1 until 65) {
            for (bit in 0 until 8) {
                val bad = sec1.copyOf()
                bad[byteIndex] = (bad[byteIndex].toInt() xor (1 shl bit)).toByte()
                if (bad.contentEquals(sec1)) continue
                assertTrue(
                    "flip of byte $byteIndex bit $bit slipped through",
                    !E2eKeyEncoding.isValid(bad)
                )
                flips++
            }
        }
        assertEquals("all 512 coordinate bits exercised", 512, flips)
    }

    /**
     * A point that is genuinely on a DIFFERENT curve, not merely a corrupted
     * P-256 point. secp256k1 (y² = x³ + 7) shares P-256's coordinate width, so
     * a length-and-prefix-only validator accepts it — and handing it to ECDH is
     * the classic invalid-curve key-extraction attack. Skipped with a loud
     * message if the JDK has no secp256k1, rather than silently passing.
     */
    @Test
    fun `a valid secp256k1 point is rejected as not on P-256`() {
        val k1 = try {
            val g = KeyPairGenerator.getInstance("EC")
            g.initialize(ECGenParameterSpec("secp256k1"))
            g.generateKeyPair().public as ECPublicKey
        } catch (e: java.security.GeneralSecurityException) {
            println("SKIP: this JDK has no secp256k1 (${e.message}); bit-flip test still covers on-curve")
            return
        }
        val sec1 = ByteArray(65)
        sec1[0] = 0x04
        System.arraycopy(fixed32(k1.w.affineX), 0, sec1, 1, 32)
        System.arraycopy(fixed32(k1.w.affineY), 0, sec1, 33, 32)
        assertEquals("shape is indistinguishable from a P-256 key", 65, sec1.size)
        assertTrue("secp256k1 point must be rejected", !E2eKeyEncoding.isValid(sec1))
    }

    @Test
    fun `cofactor is one so no small-order check is needed`() {
        // Documents the reasoning as an executable assertion: if a future curve
        // change makes h != 1, this fails and forces the [n]Q check to be added.
        assertEquals(1, E2eKeyEncoding.COFACTOR)
        assertTrue("n must be prime for the argument to hold",
            E2eKeyEncoding.GROUP_ORDER.isProbablePrime(64))
    }

    // --------------------------------------------------------- base64url

    @Test
    fun `base64url round trips and is unpadded`() {
        val rnd = java.util.Random(0xC0FFEE)
        for (n in 0 until 200) {
            val bytes = ByteArray(n).also { rnd.nextBytes(it) }
            val s = E2eKeyEncoding.toBase64Url(bytes)
            assertTrue("no padding in '$s'", !s.contains("="))
            assertTrue("no + or / in '$s'", !s.contains("+") && !s.contains("/"))
            assertArrayEquals("round trip at n=$n", bytes, E2eKeyEncoding.fromBase64Url(s))
        }
    }

    @Test
    fun `base64url matches RFC 4648 vectors`() {
        // RFC 4648 §10, unpadded, with the URL alphabet.
        assertEquals("", E2eKeyEncoding.toBase64Url(ByteArray(0)))
        assertEquals("Zg", E2eKeyEncoding.toBase64Url("f".toByteArray()))
        assertEquals("Zm8", E2eKeyEncoding.toBase64Url("fo".toByteArray()))
        assertEquals("Zm9v", E2eKeyEncoding.toBase64Url("foo".toByteArray()))
        assertEquals("Zm9vYg", E2eKeyEncoding.toBase64Url("foob".toByteArray()))
        assertEquals("Zm9vYmE", E2eKeyEncoding.toBase64Url("fooba".toByteArray()))
        assertEquals("Zm9vYmFy", E2eKeyEncoding.toBase64Url("foobar".toByteArray()))
        // The URL alphabet's whole point: 0xfb 0xff encodes with - and _.
        assertEquals("-_8", E2eKeyEncoding.toBase64Url(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
        assertArrayEquals(
            byteArrayOf(0xfb.toByte(), 0xff.toByte()),
            E2eKeyEncoding.fromBase64Url("-_8")
        )
    }

    @Test
    fun `base64url rejects padding and foreign alphabets`() {
        for (bad in listOf("Zm9v=", "Zm+9", "Zm/9", "Zm 9", "Zm9v\n")) {
            try {
                E2eKeyEncoding.fromBase64Url(bad)
                fail("accepted '$bad'")
            } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
    }

    @Test
    fun `a wire key round trips through base64url`() {
        val pub = p256KeyPair().public
        val sec1 = E2eKeyEncoding.toSec1(pub)
        val wire = E2eKeyEncoding.toBase64Url(sec1)
        assertEquals("65 bytes unpadded base64url", 87, wire.length)
        assertArrayEquals(sec1, E2eKeyEncoding.fromBase64Url(wire))
        assertEquals(pub, E2eKeyEncoding.fromSec1(E2eKeyEncoding.fromBase64Url(wire)))
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(32)
        val start = if (raw.size > 32) raw.size - 32 else 0
        val len = raw.size - start
        System.arraycopy(raw, start, out, 32 - len, len)
        return out
    }
}
