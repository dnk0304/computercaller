package com.dnkdialer.companion

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * E2E P4 Part 2 (c2) — GATE1 Addendum A1's amended AEAD vectors, A through D.
 *
 * These are the highest-value assertions in the Android crypto lane, because
 * **Security computed vector A's ciphertext independently** — against the
 * ratified `traffic.phoneToComputerKeyHex` from the vectors file, not against
 * this code. Reproducing it proves the nonce construction, the canonical AAD,
 * the pad-then-seal order and the key schedule all agree with the specification
 * as a third party read it. Nothing else in this lane has that property: every
 * other test could pass against a self-consistently wrong implementation.
 *
 * Vector A is also what P4's ORIGINAL (c) proposal would have failed. That
 * proposal used `0x00*4 ‖ be64(seq)` as the nonce and a different AAD; A1
 * replaced both. If someone reverts either, this test is what stops it.
 */
class E2eAeadVectorsTest {

    // ---- Addendum A1, vector A (verbatim from GATE1.md) ---------------------

    private val frameType = "SMS_RECEIVED"
    private val kid = "kid-01"
    private val seq = 7L
    private val direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER
    private val pairEpoch = 42L

    private val aadHex =
        "210c534d535f524543454956454422066b69642d3031" +
            "230000000000000007240125000000000000002a"

    private val sessionPrefixHex = "11223344"
    private val nonceHex = "112233440000000000000007"

    /** = traffic.phoneToComputerKeyHex in the ratified vectors file. */
    private val keyHex = "b12f964e487f7bf39a0b37df9715ca9e606c642c28bdf430f51b2051a4e0e060"

    /** The §13.4 padded "hi": be32(2) ‖ "hi" ‖ 0x00*58 — the 64-byte bucket. */
    private val plaintextHex = "00000002" + "6869" + "00".repeat(58)

    /** 80 bytes = 64 ciphertext ‖ 16 tag. */
    private val ciphertextHex =
        "da4a121115561b5ef08a85a603cf5c2b2e4f76ab190c81e772792a8e92946deb" +
            "77c8aa340f06853f925fc2311d563e16a3697670b33ae2bb09a4ddf28757603a" +
            "ce75eef4c121a283ff4c9e85f6c95dbf"

    private fun key() = E2eKdf.fromHex(keyHex)
    private fun prefix() = E2eKdf.fromHex(sessionPrefixHex)

    // ------------------------------------------------------------- vector A

    @Test
    fun `A1 vector A - the padded plaintext is the frozen 13_4 block`() {
        val padded = E2ePadding.pad(frameType, "hi".toByteArray(Charsets.UTF_8))
        assertEquals("the 64-byte bucket", 64, padded.size)
        assertEquals(
            "pad-then-seal: this is the block that goes INTO the AEAD",
            plaintextHex,
            E2eKdf.toHex(padded)
        )
    }

    @Test
    fun `A1 vector A - the canonical AAD reproduces byte for byte`() {
        assertEquals(
            "AAD mismatch — the tags are 0x21..0x25 and it is RE-ENCODED from " +
                "parsed fields, never taken from the JSON header bytes",
            aadHex,
            E2eKdf.toHex(E2eEnvelope.aad(frameType, kid, seq, direction, pairEpoch))
        )
    }

    @Test
    fun `A1 vector A - the nonce is sessionPrefix then be64 seq`() {
        assertEquals(
            nonceHex,
            E2eKdf.toHex(E2eEnvelope.nonceFor(prefix(), seq))
        )
        // The prefix is the FIRST four bytes, not the last — a swap would still
        // be 12 bytes and still be unique, and would still be wrong.
        assertTrue(nonceHex.startsWith(sessionPrefixHex))
    }

    /**
     * The one that matters. Security produced `ciphertextHex` independently
     * from the specification; this asserts the Android implementation lands on
     * the same 80 bytes.
     */
    @Test
    fun `A1 vector A - the ciphertext reproduces byte for byte`() {
        val sealed = E2eEnvelope.seal(
            key = key(),
            kid = kid,
            seq = seq,
            direction = direction,
            pairEpoch = pairEpoch,
            sessionPrefix = prefix(),
            frameType = frameType,
            plaintext = "hi".toByteArray(Charsets.UTF_8),
        )
        assertEquals("80 bytes = 64 ciphertext + 16 tag", 80, sealed.ciphertext.size)
        assertEquals(
            "CIPHERTEXT MISMATCH against Security's independently computed vector A. " +
                "Do not adjust the vector — find which of nonce / AAD / padding / key " +
                "schedule departed from GATE1 Addendum A1.",
            ciphertextHex,
            E2eKdf.toHex(sealed.ciphertext)
        )
        assertEquals(kid, sealed.kid)
        assertEquals(seq, sealed.seq)
    }

    @Test
    fun `A1 vector A - it opens again to the original plaintext`() {
        val sealed = E2eEnvelope.Sealed(1, kid, seq, E2eKdf.fromHex(ciphertextHex))
        assertArrayEquals(
            "hi".toByteArray(Charsets.UTF_8),
            E2eEnvelope.open(key(), sealed, direction, pairEpoch, prefix(), frameType)
        )
    }

    // ------------------------------------------- vector B: the u8 cap throws

    /**
     * A1 item 4 ratified `u8` over `u16` ON CONDITION that an over-long field
     * throws at encode time on every platform. Silent truncation to
     * `len and 0xFF` would re-create the framing collision the addendum exists
     * to kill, in the one code path nobody tests.
     */
    @Test
    fun `A1 vector B - a 256 byte userId peerDeviceId or kid throws at encode`() {
        val long = "a".repeat(256)
        val ok = "a".repeat(255)

        // userId and peerDeviceId live in the KDF pair context.
        for ((field, ctx) in listOf(
            "userId" to E2eKdf.PairContext("pair", long, "phone", "web", 1),
            "phoneDeviceId" to E2eKdf.PairContext("pair", "u", long, "web", 1),
            "peerDeviceId" to E2eKdf.PairContext("pair", "u", "phone", long, 1),
        )) {
            try {
                E2eKdf.pairContextBytes(ctx)
                fail("$field of 256 bytes was accepted — the u8 cap is not enforced")
            } catch (e: E2eKdf.KdfException) {
                assertTrue(e.message!!, e.message!!.contains("255"))
            }
        }

        // kid and frameType live in the AEAD's AAD.
        try {
            E2eEnvelope.aad(frameType, long, 1, direction, 1)
            fail("a 256-byte kid was accepted")
        } catch (e: E2eEnvelope.EnvelopeException) {
            assertTrue(e.message!!, e.message!!.contains("255"))
        }
        try {
            E2eEnvelope.aad(long, kid, 1, direction, 1)
            fail("a 256-byte frameType was accepted")
        } catch (e: E2eEnvelope.EnvelopeException) {
            assertTrue(e.message!!, e.message!!.contains("255"))
        }

        // CONTROL: exactly 255 is legal, so the cases above are catching the
        // boundary rather than rejecting anything merely long. The 255-byte kid
        // must appear with a 0xff length prefix, not a truncated one.
        val aadAt255 = E2eEnvelope.aad(frameType, ok, 1, direction, 1)
        assertTrue(
            "a 255-byte kid must be length-prefixed 0xff",
            E2eKdf.toHex(aadAt255).contains("22ff" + E2eKdf.toHex(ok.toByteArray(Charsets.UTF_8)))
        )
        E2eKdf.pairContextBytes(E2eKdf.PairContext("pair", ok, "phone", "web", 1))
    }

    // ------------------------------------------ vector C: AAD tamper is caught

    /**
     * Proves the AAD is actually PASSED to the cipher. A silently-dropped AAD is
     * indistinguishable from a working one on the happy path — vector A alone
     * would still pass if `updateAAD` were deleted from both seal and open.
     */
    @Test
    fun `A1 vector C - flipping one AAD byte fails the tag check`() {
        val sealed = E2eEnvelope.Sealed(1, kid, seq, E2eKdf.fromHex(ciphertextHex))

        // Each of these changes exactly one AAD field.
        assertNull(
            "frameType is not bound into the AAD — a relay could relabel a " +
                "CALL_STATUS as an SMS_RECEIVED",
            E2eEnvelope.open(key(), sealed, direction, pairEpoch, prefix(), "CALL_STATUS")
        )
        assertNull(
            "direction is not bound — a reflected frame would decrypt",
            E2eEnvelope.open(
                key(), sealed, E2eEnvelope.Direction.COMPUTER_TO_PHONE,
                pairEpoch, prefix(), frameType
            )
        )
        assertNull(
            "pairEpoch is not bound — a frame would replay across epochs",
            E2eEnvelope.open(key(), sealed, direction, pairEpoch + 1, prefix(), frameType)
        )
        assertNull(
            "seq is not bound — a frame could be moved to slip the dedupe window",
            E2eEnvelope.open(
                key(), E2eEnvelope.Sealed(1, kid, seq + 1, sealed.ciphertext),
                direction, pairEpoch, prefix(), frameType
            )
        )
        assertNull(
            "kid is not bound",
            E2eEnvelope.open(
                key(), E2eEnvelope.Sealed(1, "kid-02", seq, sealed.ciphertext),
                direction, pairEpoch, prefix(), frameType
            )
        )
        // A changed nonce prefix must also fail.
        assertNull(
            E2eEnvelope.open(
                key(), sealed, direction, pairEpoch, E2eKdf.fromHex("11223345"), frameType
            )
        )
        // CONTROL: unmodified, it still opens — so every null above means
        // something.
        assertArrayEquals(
            "hi".toByteArray(Charsets.UTF_8),
            E2eEnvelope.open(key(), sealed, direction, pairEpoch, prefix(), frameType)
        )
    }

    // ---------------------------------- vector D: the other direction's key

    /**
     * `k_c2p` must not open a `p2c` frame. This is what makes a reflection
     * attack inert — a frame bounced back at its sender cannot decrypt under
     * the sender's own receive key.
     */
    @Test
    fun `A1 vector D - the c2p key does not open the p2c ciphertext`() {
        val ctx = E2eKdf.PairContext(
            pairingId = "pair-7f3a9c21",
            userId = "user-0191aa",
            phoneDeviceId = "dev-phone-01",
            peerDeviceId = "dev-web-01",
            pairEpoch = 42L,
        )
        val sk = ByteArray(32) { (0xA0 + it).toByte() }
        val keys = E2eKdf.deriveTrafficKeys(sk, ctx)

        // The vectors file's p2c key IS the vector-A key: confirms this test is
        // deriving the same schedule the vector was computed under.
        assertEquals(keyHex, E2eKdf.toHex(keys.phoneToComputer))

        val sealed = E2eEnvelope.Sealed(1, kid, seq, E2eKdf.fromHex(ciphertextHex))
        assertNull(
            "the c2p key opened a p2c frame — directional separation is broken",
            E2eEnvelope.open(
                keys.computerToPhone, sealed, direction, pairEpoch, prefix(), frameType
            )
        )
        // CONTROL: the p2c key does open it.
        assertArrayEquals(
            "hi".toByteArray(Charsets.UTF_8),
            E2eEnvelope.open(keys.phoneToComputer, sealed, direction, pairEpoch, prefix(), frameType)
        )
    }
}
