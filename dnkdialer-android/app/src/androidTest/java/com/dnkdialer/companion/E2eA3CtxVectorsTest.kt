package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E P4 (w1) — **GATE1 Addendum A3's vector I**, the pairContext channel.
 *
 * A3 ratified (A): the phone carries
 * `ctx:{pairingId, phoneDeviceId, peerDeviceId, pairEpoch}` inside the `e2e`
 * block, `pairEpoch` as a DECIMAL STRING, and `userId` is NOT transmitted —
 * each side supplies its own authenticated one, so a session-identity mismatch
 * fails closed instead of agreeing with the relay.
 *
 * Vector I's assertion is one sentence: **wire ctx + local userId == the frozen
 * local context, byte for byte.** A3 assigns P4 the ENCODE side of it and
 * P2/P3 the DECODE side, "that pairing is what makes the vector
 * cross-implementation rather than two copies of one belief". This class does
 * both halves locally, because a round trip is the only way an encoder can
 * demonstrate its output is *readable* rather than merely stable — and then
 * pins the result against Security's independently computed bytes, which is
 * the half P4 could not fake.
 */
@RunWith(AndroidJUnit4::class)
class E2eA3CtxVectorsTest {

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("kdf-vectors-a3.json")
            ?: throw AssertionError("kdf-vectors-a3.json is not on the androidTest classpath")
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun sk(root: JsonObject) = E2eKdf.fromHex(root.get("sessionKeyHex").asString)

    private fun wireOf(v: JsonObject): JsonObject = v.getAsJsonObject("ctxWire")

    /** Decode a vector's wire ctx exactly as a peer would. */
    private fun decoded(v: JsonObject): E2eKdf.PairContext =
        E2ePairIdentity.contextFromWire(wireOf(v), v.get("localUserId").asString)

    // ------------------------------------------------------------ I.1

    @Test
    fun vector_I1_wire_ctx_plus_local_userid_rebuilds_the_frozen_context() {
        val root = load()
        val v = root.getAsJsonObject("I1_positive")
        val ctx = decoded(v)

        assertEquals(
            "the context bytes must be IDENTICAL to the frozen local context",
            v.get("contextBytesHex").asString,
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx))
        )

        val keys = E2eKdf.deriveTrafficKeys(sk(root), ctx)
        assertEquals(v.get("p2cKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))
        assertEquals(v.get("c2pKeyHex").asString, E2eKdf.toHex(keys.computerToPhone))

        val prefixes = E2eKdf.deriveNoncePrefixes(sk(root), ctx)
        assertEquals(v.get("np2cHex").asString, E2eKdf.toHex(prefixes.phoneToComputer))
        assertEquals(v.get("nc2pHex").asString, E2eKdf.toHex(prefixes.computerToPhone))
    }

    /**
     * The ENCODE half A3 assigns to P4: what [E2ePairIdentity.ctxBlockFor]
     * emits must be exactly the wire form the vector specifies — same fields,
     * same values, and `pairEpoch` a STRING.
     *
     * A test that only decoded the vector's own ctx would never notice that the
     * phone emits something else entirely.
     */
    @Test
    fun vector_I1_is_what_this_phone_actually_emits() {
        val root = load()
        val v = root.getAsJsonObject("I1_positive")
        val emitted = E2ePairIdentity.ctxBlockFor(decoded(v))

        assertEquals("the emitted ctx must equal the vector's wire form", wireOf(v), emitted)
        assertEquals(
            "pairEpoch must be emitted as a decimal STRING, never a JSON number",
            "42", emitted.get("pairEpoch").asString
        )
        // Round trip: what we emit, a peer can read back to the same context.
        assertEquals(
            E2eKdf.toHex(E2eKdf.pairContextBytes(decoded(v))),
            E2eKdf.toHex(
                E2eKdf.pairContextBytes(
                    E2ePairIdentity.contextFromWire(emitted, v.get("localUserId").asString)
                )
            )
        )
    }

    // ------------------------------------------------------------ I.2

    /**
     * A3-M2's replay case. One epoch of drift must diverge the key totally and
     * a frame sealed under the real epoch must FAIL to authenticate — that
     * failure is what makes the receiver's refusal floor meaningful rather than
     * merely polite.
     */
    @Test
    fun vector_I2_one_epoch_of_drift_diverges_the_key_and_breaks_authentication() {
        val root = load()
        val v = root.getAsJsonObject("I2_negative_epoch_drift")
        val ctx = decoded(v)

        assertEquals(v.get("contextBytesHex").asString, E2eKdf.toHex(E2eKdf.pairContextBytes(ctx)))
        val keys = E2eKdf.deriveTrafficKeys(sk(root), ctx)
        assertEquals(v.get("p2cKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))
        val prefixes = E2eKdf.deriveNoncePrefixes(sk(root), ctx)
        assertEquals(v.get("np2cHex").asString, E2eKdf.toHex(prefixes.phoneToComputer))

        // A2 vector F's ciphertext, under this drifted key/prefix.
        val a2 = javaClass.classLoader!!.getResourceAsStream("kdf-vectors-a2.json")!!
        val f = InputStreamReader(a2, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }.getAsJsonObject("F_aead_p2c_with_derived_prefix")

        assertNull(
            "a frame sealed at epoch 42 opened under an epoch-43 key — the epoch is " +
                "not actually binding the traffic keys",
            E2eEnvelope.open(
                key = keys.phoneToComputer,
                envelope = E2eEnvelope.Sealed(
                    E2eEnvelope.VERSION, f.get("kid").asString, f.get("seq").asLong,
                    E2eKdf.fromHex(f.get("ciphertextHex").asString)
                ),
                direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairEpoch = 43L,
                sessionPrefix = prefixes.phoneToComputer,
                frameType = f.get("frameType").asString,
            )
        )
    }

    // ------------------------------------------------------------ I.3

    /**
     * The point of the whole design: `userId` is never transmitted, so it can
     * only come from each side's own authenticated session. One character of
     * difference must diverge the key completely — that is what makes a
     * session-identity mismatch fail closed instead of quietly working.
     */
    @Test
    fun vector_I3_an_untransmitted_userid_is_load_bearing() {
        val root = load()
        val v = root.getAsJsonObject("I3_negative_userid_drift")
        val keys = E2eKdf.deriveTrafficKeys(sk(root), decoded(v))
        assertEquals(v.get("p2cKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))

        val honest = root.getAsJsonObject("I1_positive")
        assertNotEquals(
            "a one-character userId difference did not move the key",
            E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk(root), decoded(honest)).phoneToComputer),
            E2eKdf.toHex(keys.phoneToComputer)
        )
        // The wire bytes were IDENTICAL in both cases. That is the property.
        assertEquals(wireOf(honest), wireOf(v))
    }

    // ------------------------------------------------------------ I.4

    @Test
    fun vector_I4_every_malformed_pair_epoch_is_refused_never_coerced() {
        val root = load()
        val neg = root.getAsJsonObject("I4_parser_negatives")
        val base = wireOf(root.getAsJsonObject("I1_positive"))

        for (bad in neg.getAsJsonArray("pairEpochRejected")) {
            val ctx = base.deepCopy()
            ctx.remove("pairEpoch")
            ctx.add("pairEpoch", bad)
            try {
                E2ePairIdentity.contextFromWire(ctx, "user-0191aa")
                fail("ctx.pairEpoch=$bad was ACCEPTED — A3 I.4 requires a refusal, not a coercion")
            } catch (e: E2ePairIdentity.CtxException) {
                // expected
            }
        }

        for (good in neg.getAsJsonArray("pairEpochAccepted")) {
            val ctx = base.deepCopy()
            ctx.addProperty("pairEpoch", good.asString)
            assertEquals(
                good.asString,
                E2ePairIdentity.contextFromWire(ctx, "user-0191aa").pairEpoch.toString()
            )
        }
    }

    @Test
    fun vector_I4_an_absent_ctx_is_refused_never_guessed() {
        try {
            E2ePairIdentity.contextFromWire(null, "user-0191aa")
            fail("A3-M4: a mode=1 block with no ctx must be REFUSED, never derived from local")
        } catch (e: E2ePairIdentity.CtxException) {
            // expected
        }
    }

    @Test
    fun vector_I4_a_ctx_for_another_pairing_is_refused() {
        val base = wireOf(load().getAsJsonObject("I1_positive"))
        try {
            E2ePairIdentity.contextFromWire(base, "user-0191aa", expectedPairingId = "pair-other")
            fail("A3-M3: a ctx naming a different pairingId must be refused")
        } catch (e: E2ePairIdentity.CtxException) {
            // expected
        }
        // …and the matching one is accepted, so the check is not simply "throw".
        E2ePairIdentity.contextFromWire(base, "user-0191aa", expectedPairingId = "pair-7f3a9c21")
    }

    @Test
    fun vector_I4_an_oversized_id_is_refused_on_the_decode_side_too() {
        for (field in listOf("pairingId", "phoneDeviceId", "peerDeviceId")) {
            val ctx = wireOf(load().getAsJsonObject("I1_positive")).deepCopy()
            ctx.addProperty(field, "x".repeat(256))
            try {
                E2ePairIdentity.contextFromWire(ctx, "user-0191aa")
                fail("$field of 256 bytes was accepted — A1's u8 cap must hold on decode too")
            } catch (e: E2ePairIdentity.CtxException) {
                // expected
            }
        }
    }
}
