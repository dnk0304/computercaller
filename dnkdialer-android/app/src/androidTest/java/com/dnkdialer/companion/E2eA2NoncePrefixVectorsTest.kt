package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E P4 Part 2 (a2) — **GATE1 Addendum A2's vectors E–H**, the independent
 * check on the derived nonce prefix.
 *
 * A2 ratified option (A): both prefixes are derived from `SK` under their own
 * HKDF labels and nothing is transmitted.
 *
 * ```
 *   np2c = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
 *                       info = "cc-e2e-v1/np2c" ‖ pairContext)   L = 4
 *   nc2p = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
 *                       info = "cc-e2e-v1/nc2p" ‖ pairContext)   L = 4
 *   nonce (12 B) = prefix ‖ be64(seq)
 * ```
 *
 * ## Why these vectors matter more than the ones P4 generated
 *
 * P4 proposed this construction, so P4 reproducing it proves only that P4 is
 * self-consistent. Security computed E–H in an independent HKDF/GCM
 * implementation. These are the only assertions in this lane that a
 * self-consistently *wrong* implementation could not pass, which is exactly the
 * role A1 vector A played for the AEAD.
 *
 * F is deliberately A1 vector A with one input changed — the prefix `11223344`
 * becomes the derived `6fa67348` — so a divergence localises to the derivation
 * rather than to the cipher, the AAD or the padding.
 *
 * ## Why a second resource file
 *
 * A2 says to ADD E–H to `tests/kdf-vectors.json`. That file belongs to the web
 * lane (P0.2), and `androidTest/resources/kdf-vectors.json` is a byte-identical
 * copy of it whose sha256 IS the (c3) cross-lane proof — appending rows there
 * would destroy the property it exists to demonstrate. E–H therefore live in
 * `kdf-vectors-a2.json`, transcribed verbatim from GATE1.md, until P0.2 lands
 * them in the canonical file. Flagged to Ken.
 */
@RunWith(AndroidJUnit4::class)
class E2eA2NoncePrefixVectorsTest {

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("kdf-vectors-a2.json")
            ?: throw AssertionError("kdf-vectors-a2.json is not on the androidTest classpath")
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun context(root: JsonObject): E2eKdf.PairContext {
        val c = root.getAsJsonObject("context")
        return E2eKdf.PairContext(
            pairingId = c.get("pairingId").asString,
            userId = c.get("userId").asString,
            phoneDeviceId = c.get("phoneDeviceId").asString,
            peerDeviceId = c.get("peerDeviceId").asString,
            pairEpoch = c.get("pairEpoch").asLong,
        )
    }

    private fun sessionKey(root: JsonObject): ByteArray =
        E2eKdf.fromHex(root.getAsJsonObject("context").get("sessionKeyHex").asString)

    /**
     * The file has to describe the SAME pairing the frozen file describes, or
     * E–H are vectors for a context nothing else in the programme uses and they
     * prove nothing about the shipped key schedule.
     */
    @Test
    fun the_a2_file_shares_the_frozen_context() {
        val a2 = context(load())
        val frozenStream = javaClass.classLoader!!.getResourceAsStream("kdf-vectors.json")!!
        val frozen = InputStreamReader(frozenStream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }.getAsJsonObject("context")

        assertEquals(frozen.get("pairingId").asString, a2.pairingId)
        assertEquals(frozen.get("userId").asString, a2.userId)
        assertEquals(frozen.get("phoneDeviceId").asString, a2.phoneDeviceId)
        assertEquals(frozen.get("peerDeviceId").asString, a2.peerDeviceId)
        assertEquals(frozen.get("pairEpoch").asLong, a2.pairEpoch)
    }

    // ------------------------------------------------------------ vector E

    @Test
    fun vector_E_the_info_strings_are_byte_exact() {
        val root = load()
        val e = root.getAsJsonObject("E_noncePrefixes")
        val ctx = context(root)

        assertEquals("cc-e2e-v1/np2c", E2eKdf.LABEL_NONCE_P2C)
        assertEquals("cc-e2e-v1/nc2p", E2eKdf.LABEL_NONCE_C2P)
        assertEquals(
            e.get("infoNp2cHex").asString,
            E2eKdf.toHex(E2eKdf.infoFor(E2eKdf.LABEL_NONCE_P2C, ctx))
        )
        assertEquals(
            e.get("infoNc2pHex").asString,
            E2eKdf.toHex(E2eKdf.infoFor(E2eKdf.LABEL_NONCE_C2P, ctx))
        )
    }

    @Test
    fun vector_E_the_derived_prefixes_reproduce() {
        val root = load()
        val e = root.getAsJsonObject("E_noncePrefixes")
        val p = E2eKdf.deriveNoncePrefixes(sessionKey(root), context(root))

        assertEquals(4, e.get("L").asInt)
        assertEquals(E2eEnvelope.SESSION_PREFIX_BYTES, p.phoneToComputer.size)
        assertEquals(E2eEnvelope.SESSION_PREFIX_BYTES, p.computerToPhone.size)
        assertEquals(
            "np2c does not match Security's independently computed value",
            e.get("np2cHex").asString, E2eKdf.toHex(p.phoneToComputer)
        )
        assertEquals(
            "nc2p does not match Security's independently computed value",
            e.get("nc2pHex").asString, E2eKdf.toHex(p.computerToPhone)
        )
    }

    // --------------------------------------------------------- vectors F/G

    /**
     * Seals F and G with the DERIVED prefix and requires the exact ciphertext.
     * Every byte of the construction is covered at once: the derivation, the
     * `prefix ‖ be64(seq)` nonce, the canonical AAD, §13.4's padding and the
     * traffic key for that direction.
     */
    @Test
    fun vectors_F_and_G_seal_to_the_frozen_ciphertexts() {
        val root = load()
        val ctx = context(root)
        val prefixes = E2eKdf.deriveNoncePrefixes(sessionKey(root), ctx)
        val keys = E2eKdf.deriveTrafficKeys(sessionKey(root), ctx)

        for (name in listOf("F_aead_p2c_with_derived_prefix", "G_aead_c2p_with_derived_prefix")) {
            val v = root.getAsJsonObject(name)
            val p2c = v.get("directionName").asString == "p2c"
            val direction = if (p2c) {
                E2eEnvelope.Direction.PHONE_TO_COMPUTER
            } else {
                E2eEnvelope.Direction.COMPUTER_TO_PHONE
            }
            // The BYTE is what enters the AAD, so assert the file's numeric
            // direction and its name agree with our own enum — the (c3) trap.
            assertEquals(
                "$name: direction byte disagrees with directionName",
                v.get("direction").asInt, direction.wireByte.toInt()
            )

            val key = if (p2c) keys.phoneToComputer else keys.computerToPhone
            val prefix = if (p2c) prefixes.phoneToComputer else prefixes.computerToPhone
            assertEquals(
                "$name: prefix", v.get("noncePrefixHex").asString, E2eKdf.toHex(prefix)
            )
            assertEquals("$name: key", v.get("keyHex").asString, E2eKdf.toHex(key))
            assertEquals(
                "$name: nonce",
                v.get("nonceHex").asString,
                E2eKdf.toHex(E2eEnvelope.nonceFor(prefix, v.get("seq").asLong))
            )
            assertEquals(
                "$name: aad",
                v.get("aadHex").asString,
                E2eKdf.toHex(
                    E2eEnvelope.aad(
                        v.get("frameType").asString, v.get("kid").asString,
                        v.get("seq").asLong, direction, v.get("pairEpoch").asLong
                    )
                )
            )

            val sealed = E2eEnvelope.seal(
                key = key,
                kid = v.get("kid").asString,
                seq = v.get("seq").asLong,
                direction = direction,
                pairEpoch = v.get("pairEpoch").asLong,
                sessionPrefix = prefix,
                frameType = v.get("frameType").asString,
                plaintext = "hi".toByteArray(Charsets.UTF_8),
            )
            assertEquals(
                "$name: the padded block does not match §13.4",
                v.get("plaintextHex").asString,
                E2eKdf.toHex(E2ePadding.pad(v.get("frameType").asString, "hi".toByteArray(Charsets.UTF_8)))
            )
            assertEquals(
                "$name: CIPHERTEXT — this is the assertion a self-consistently wrong " +
                    "implementation cannot pass",
                v.get("ciphertextHex").asString, E2eKdf.toHex(sealed.ciphertext)
            )

            // And it opens back, under that direction only.
            assertArrayEquals(
                "hi".toByteArray(Charsets.UTF_8),
                E2eEnvelope.open(key, sealed, direction, v.get("pairEpoch").asLong, prefix, v.get("frameType").asString)
            )
        }
    }

    /**
     * F and G differ in direction alone, so crossing the two must fail. This is
     * A2's reason for asking for G at all: it proves the direction byte, the
     * directional key and the directional prefix all move together, rather than
     * one of the three being wired to a constant.
     */
    @Test
    fun the_c2p_material_cannot_open_the_p2c_vector() {
        val root = load()
        val ctx = context(root)
        val prefixes = E2eKdf.deriveNoncePrefixes(sessionKey(root), ctx)
        val keys = E2eKdf.deriveTrafficKeys(sessionKey(root), ctx)
        val f = root.getAsJsonObject("F_aead_p2c_with_derived_prefix")

        val envelope = E2eEnvelope.Sealed(
            E2eEnvelope.VERSION, f.get("kid").asString, f.get("seq").asLong,
            E2eKdf.fromHex(f.get("ciphertextHex").asString)
        )
        assertNull(
            "the c2p key opened a p2c frame",
            E2eEnvelope.open(
                keys.computerToPhone, envelope, E2eEnvelope.Direction.COMPUTER_TO_PHONE,
                f.get("pairEpoch").asLong, prefixes.computerToPhone, f.get("frameType").asString
            )
        )
        // …and the right key with the WRONG prefix is also refused, which is
        // what makes the prefix load-bearing input rather than decoration.
        assertNull(
            "the p2c key opened its own frame under the c2p prefix",
            E2eEnvelope.open(
                keys.phoneToComputer, envelope, E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                f.get("pairEpoch").asLong, prefixes.computerToPhone, f.get("frameType").asString
            )
        )
    }

    // ------------------------------------------------------------ vector H

    @Test
    fun vector_H_the_two_prefixes_differ_and_neither_is_zero() {
        val root = load()
        val p = E2eKdf.deriveNoncePrefixes(sessionKey(root), context(root))
        assertFalse(
            "np2c == nc2p — the same label was almost certainly fed twice",
            p.phoneToComputer.contentEquals(p.computerToPhone)
        )
        val zero = ByteArray(E2eEnvelope.SESSION_PREFIX_BYTES)
        assertFalse("np2c is all-zero", p.phoneToComputer.contentEquals(zero))
        assertFalse("nc2p is all-zero", p.computerToPhone.contentEquals(zero))
    }

    /**
     * A2 MUST (2), at the level the derivation controls: the prefix is a pure
     * function of SK and pairContext, so two constructions of the same session
     * agree and a different epoch moves them. Anything that made the prefix
     * stateful — a cached field, a persisted record — would break one of these.
     */
    @Test
    fun the_prefix_is_a_pure_function_of_sk_and_context() {
        val root = load()
        val ctx = context(root)
        val sk = sessionKey(root)
        assertArrayEquals(
            E2eKdf.deriveNoncePrefixes(sk, ctx).phoneToComputer,
            E2eKdf.deriveNoncePrefixes(sk, ctx).phoneToComputer
        )
        val nextEpoch = ctx.copy(pairEpoch = ctx.pairEpoch + 1)
        assertFalse(
            "a new epoch must move the prefix — pairEpoch is inside pairContext",
            E2eKdf.deriveNoncePrefixes(sk, ctx).phoneToComputer
                .contentEquals(E2eKdf.deriveNoncePrefixes(sk, nextEpoch).phoneToComputer)
        )
        assertTrue(true)
    }
}
