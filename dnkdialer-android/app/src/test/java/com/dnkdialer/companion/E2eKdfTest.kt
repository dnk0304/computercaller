package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * E2E P4 Part 2 (a3) — HKDF and the key schedule.
 *
 * The HKDF primitive is checked against the RFC 5869 appendix-A vectors rather
 * than against itself. A self-consistent HKDF is trivially achievable and
 * trivially wrong: expand with the counter appended in the wrong place, or T(0)
 * seeded to 32 zero bytes instead of empty, and every round-trip test in the
 * suite still passes while the browser derives different keys.
 */
class E2eKdfTest {

    private fun hex(s: String) = E2eKdf.fromHex(s)

    private fun ctx(
        pairingId: String = "pair-0001",
        userId: String = "user-abc",
        phoneDeviceId: String = "phone-1",
        peerDeviceId: String = "web-1",
        pairEpoch: Long = 7,
    ) = E2eKdf.PairContext(pairingId, userId, phoneDeviceId, peerDeviceId, pairEpoch)

    // ----------------------------------------------- RFC 5869 appendix A

    @Test
    fun `RFC 5869 test case 1 SHA-256`() {
        val ikm = hex("0b".repeat(22))
        val salt = hex("000102030405060708090a0b0c")
        val info = hex("f0f1f2f3f4f5f6f7f8f9")
        assertEquals(
            "077709362c2e32df0ddc3f0dc47bba63" +
                "90b6c73bb50f9c3122ec844ad7c2b3e5",
            E2eKdf.toHex(E2eKdf.extract(salt, ikm))
        )
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a" +
                "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
                "34007208d5b887185865",
            E2eKdf.toHex(E2eKdf.hkdf(salt, ikm, info, 42))
        )
    }

    @Test
    fun `RFC 5869 test case 2 SHA-256 long inputs multi-block expand`() {
        val ikm = E2eKdf.fromHex((0..79).joinToString("") { "%02x".format(it) })
        val salt = E2eKdf.fromHex((0x60..0xaf).joinToString("") { "%02x".format(it) })
        val info = E2eKdf.fromHex((0xb0..0xff).joinToString("") { "%02x".format(it) })
        assertEquals(
            "06a6b88c5853361a06104c9ceb35b45c" +
                "ef760014904671014a193f40c15fc244",
            E2eKdf.toHex(E2eKdf.extract(salt, ikm))
        )
        assertEquals(
            "b11e398dc80327a1c8e7f78c596a4934" +
                "4f012eda2d4efad8a050cc4c19afa97c" +
                "59045a99cac7827271cb41c65e590e09" +
                "da3275600c2f09b8367793a9aca3db71" +
                "cc30c58179ec3e87c14c01d5c1f3434f" +
                "1d87",
            E2eKdf.toHex(E2eKdf.hkdf(salt, ikm, info, 82))
        )
    }

    @Test
    fun `RFC 5869 test case 3 SHA-256 empty salt and info`() {
        val ikm = hex("0b".repeat(22))
        assertEquals(
            "19ef24a32c717b167f33a91d6f648bdf" +
                "96596776afdb6377ac434c1c293ccb04",
            E2eKdf.toHex(E2eKdf.extract(ByteArray(0), ikm))
        )
        assertEquals(
            "8da4e775a563c18f715f802a063c5a31" +
                "b8a11f5c5ee1879ec3454e5f3c738d2d" +
                "9d201395faa4b61a96c8",
            E2eKdf.toHex(E2eKdf.hkdf(ByteArray(0), ikm, ByteArray(0), 42))
        )
    }

    @Test
    fun `expand refuses a length HKDF cannot produce`() {
        val prk = ByteArray(32) { 1 }
        for (bad in listOf(0, -1, 255 * 32 + 1)) {
            try {
                E2eKdf.expand(prk, ByteArray(0), bad)
                fail("accepted length $bad")
            } catch (e: E2eKdf.KdfException) {
                assertTrue(e.message!!.contains("length"))
            }
        }
        assertEquals(255 * 32, E2eKdf.expand(prk, ByteArray(0), 255 * 32).size)
    }

    // ------------------------------------------------------ info framing

    /**
     * The reason this file does not implement the brief's bare `‖`
     * concatenation. Without length prefixes these two DIFFERENT pairings
     * produce the SAME info bytes, and therefore the same traffic keys.
     */
    @Test
    fun `framing is unambiguous across a field boundary`() {
        val a = ctx(userId = "ab", phoneDeviceId = "cd")
        val b = ctx(userId = "a", phoneDeviceId = "bcd")

        // Sanity: the naive concatenation really does collide.
        assertEquals(
            "control — the naive encoding collides, which is why framing exists",
            "ab" + "cd",
            "a" + "bcd"
        )

        assertTrue(
            "framed context bytes must differ",
            !E2eKdf.pairContextBytes(a).contentEquals(E2eKdf.pairContextBytes(b))
        )
        val ka = E2eKdf.deriveTrafficKeys(ByteArray(32) { 9 }, a)
        val kb = E2eKdf.deriveTrafficKeys(ByteArray(32) { 9 }, b)
        assertTrue(
            "the two pairings must not share a traffic key",
            !ka.phoneToComputer.contentEquals(kb.phoneToComputer)
        )
    }

    @Test
    fun `every context field is bound into the traffic keys`() {
        val base = ctx()
        val sk = ByteArray(32) { it.toByte() }
        val baseline = E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, base).phoneToComputer)

        val variants = mapOf(
            "pairingId" to base.copy(pairingId = "pair-0002"),
            "userId" to base.copy(userId = "user-abd"),
            "phoneDeviceId" to base.copy(phoneDeviceId = "phone-2"),
            "peerDeviceId" to base.copy(peerDeviceId = "web-2"),
            "pairEpoch" to base.copy(pairEpoch = 8),
        )
        for ((field, v) in variants) {
            assertNotEquals(
                "$field is not bound into the key schedule",
                baseline,
                E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, v).phoneToComputer)
            )
        }
    }

    @Test
    fun `the two directions are different keys`() {
        val keys = E2eKdf.deriveTrafficKeys(ByteArray(32) { 3 }, ctx())
        assertEquals(32, keys.phoneToComputer.size)
        assertEquals(32, keys.computerToPhone.size)
        assertTrue(
            "a reflected frame must not decrypt under the sender's own key",
            !keys.phoneToComputer.contentEquals(keys.computerToPhone)
        )
    }

    @Test
    fun `zeroize actually clears both directions`() {
        val keys = E2eKdf.deriveTrafficKeys(ByteArray(32) { 3 }, ctx())
        keys.zeroize()
        assertArrayEquals(ByteArray(32), keys.phoneToComputer)
        assertArrayEquals(ByteArray(32), keys.computerToPhone)
    }

    @Test
    fun `pairEpoch is encoded big-endian over the full 64 bits`() {
        val big = ctx(pairEpoch = 0x0102030405060708L)
        val bytes = E2eKdf.pairContextBytes(big)
        val idx = bytes.size - 8
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8),
            bytes.copyOfRange(idx, bytes.size)
        )
        // A value above 2^53 must not round — the reason this is a Long, not a
        // Double coming out of JSON on the web side.
        val huge = ctx(pairEpoch = Long.MAX_VALUE)
        assertNotEquals(
            E2eKdf.toHex(E2eKdf.pairContextBytes(big)),
            E2eKdf.toHex(E2eKdf.pairContextBytes(huge))
        )
    }

    @Test
    fun `a negative pairEpoch is refused`() {
        try {
            E2eKdf.pairContextBytes(ctx(pairEpoch = -1))
            fail("accepted a negative epoch")
        } catch (e: E2eKdf.KdfException) {
            assertTrue(e.message!!.contains("pairEpoch"))
        }
    }

    // -------------------------------------------------------------- KEK

    @Test
    fun `each recipient gets a different KEK from the same shared secret`() {
        val z = ByteArray(32) { 0x5a }
        val c = ctx()
        val r1 = validSec1(1)
        val r2 = validSec1(2)
        val k1 = E2eKdf.deriveKek(z, c, r1)
        val k2 = E2eKdf.deriveKek(z, c, r2)
        assertEquals(32, k1.size)
        assertTrue(
            "a wrap made for the web page must not open in the service worker",
            !k1.contentEquals(k2)
        )
        assertArrayEquals("derivation is deterministic for one recipient", k1, E2eKdf.deriveKek(z, c, r1))
    }

    @Test
    fun `an invalid recipient key cannot reach the KDF`() {
        try {
            // 0x04 tag present, coordinates all zero: passes length and prefix,
            // and must then be stopped by the identity rule specifically.
            E2eKdf.deriveKek(ByteArray(32) { 1 }, ctx(), ByteArray(65).also { it[0] = 0x04 })
            fail("derived a KEK for the identity point")
        } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
            assertTrue(e.message!!.contains("identity"))
        }
    }

    // --------------------------------------------------- all-zero refusal

    @Test
    fun `an all-zero shared secret is refused`() {
        try {
            E2eKdf.requireNonZeroSharedSecret(ByteArray(32))
            fail("accepted an all-zero shared secret")
        } catch (e: E2eKdf.KdfException) {
            assertTrue(e.message!!.contains("ALL-ZERO"))
        }
        try {
            E2eKdf.requireNonZeroSharedSecret(ByteArray(0))
            fail("accepted an empty shared secret")
        } catch (e: E2eKdf.KdfException) {
            assertTrue(e.message!!.contains("empty"))
        }
        // Control: a secret with a single set bit anywhere is accepted.
        for (i in 0 until 32) {
            val z = ByteArray(32)
            z[i] = 1
            E2eKdf.requireNonZeroSharedSecret(z)
        }
    }

    @Test
    fun `an all-zero session key is refused and a wrong size is named`() {
        try {
            E2eKdf.deriveTrafficKeys(ByteArray(32), ctx())
            fail("derived traffic keys from an all-zero session key")
        } catch (e: E2eKdf.KdfException) {
            assertTrue(e.message!!.contains("ALL-ZERO"))
        }
        for (n in listOf(0, 16, 31, 33, 64)) {
            try {
                E2eKdf.deriveTrafficKeys(ByteArray(n) { 1 }, ctx())
                fail("accepted a $n-byte session key")
            } catch (e: E2eKdf.KdfException) {
                assertTrue(e.message!!.contains("session key"))
            }
        }
    }

    @Test
    fun `an empty pairingId is refused because it is the salt`() {
        try {
            E2eKdf.PairContext("", "u", "p", "w", 1)
            fail("accepted an empty pairingId")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("salt"))
        }
    }

    // ------------------------------------------------------------- hex

    @Test
    fun `hex round trips including high bytes`() {
        val bytes = ByteArray(256) { it.toByte() }
        assertArrayEquals(bytes, E2eKdf.fromHex(E2eKdf.toHex(bytes)))
        assertTrue(E2eKdf.toHex(byteArrayOf(0, 1, 15, 16, -1)) == "00010f10ff")
    }

    /** A distinct, genuinely on-curve P-256 point for KEK tests. */
    private fun validSec1(seed: Int): ByteArray {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"), java.security.SecureRandom(
            byteArrayOf(seed.toByte(), 0, 0, 0, 0, 0, 0, 0)
        ))
        return E2eKeyEncoding.toSec1(g.generateKeyPair().public)
    }
}
