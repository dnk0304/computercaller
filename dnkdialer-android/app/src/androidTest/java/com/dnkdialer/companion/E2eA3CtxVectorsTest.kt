package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E P4 (w1) — **GATE1 Addendum A3's vector I**, asserted against the
 * canonical `tests/kdf-vectors.json` frozen on `e2e/integration` at `46e3084`
 * (P1.1), byte-identically copied into this module's androidTest resources.
 *
 * A3 ratified (A): the phone carries
 * `ctx:{pairingId, phoneDeviceId, peerDeviceId, pairEpoch}` inside the `e2e`
 * block, `pairEpoch` as a DECIMAL STRING, and `userId` is NOT transmitted —
 * each side supplies its own authenticated one, so a session-identity mismatch
 * fails closed instead of the derivation agreeing with the relay.
 *
 * Vector I's assertion is one sentence: **wire ctx + local userId == the frozen
 * local context, byte for byte.** A3 assigns P4 the ENCODE side of it and
 * P2/P3 the DECODE side — "that pairing is what makes the vector
 * cross-implementation rather than two copies of one belief". This class does
 * both halves, because a round trip is the only way an encoder can show its
 * output is *readable* rather than merely stable, and then pins the result
 * against Security's independently computed bytes, which is the half P4 could
 * not fake.
 *
 * Note the file's own shape: I.2 and I.3 do NOT carry their own `ctxWire`.
 * They are I.1's wire form with exactly one thing changed — the epoch on the
 * wire for I.2, the LOCAL userId for I.3 — which is what makes each of them a
 * one-variable experiment rather than two unrelated fixtures.
 */
@RunWith(AndroidJUnit4::class)
class E2eA3CtxVectorsTest {

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("kdf-vectors.json")
            ?: throw AssertionError("kdf-vectors.json is not on the androidTest classpath")
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun sk(root: JsonObject) =
        E2eKdf.fromHex(root.getAsJsonObject("traffic").get("sessionKeyHex").asString)

    private fun section(root: JsonObject) = root.getAsJsonObject("ctxWire")

    private fun i1(root: JsonObject) = section(root).getAsJsonObject("positiveI1")

    /** I.1's wire form — the base every other case varies by one field. */
    private fun baseWire(root: JsonObject): JsonObject =
        i1(root).getAsJsonObject("ctxWire").deepCopy()

    private fun localUserId(root: JsonObject) = i1(root).get("localUserId").asString

    // ------------------------------------------------------------ I.1

    @Test
    fun vector_I1_wire_ctx_plus_local_userid_rebuilds_the_frozen_context() {
        val root = load()
        val v = i1(root)
        val ctx = E2ePairIdentity.contextFromWire(baseWire(root), localUserId(root))

        assertEquals(
            "the context bytes must be IDENTICAL to the frozen local context",
            v.get("contextBytesHex").asString,
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx))
        )
        // …and identical to the file's OWN top-level context, which is the
        // property A3 states: the wire form is not a second description of the
        // pairing, it reconstructs the one already frozen here.
        assertEquals(
            root.get("contextBytesHex").asString,
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx))
        )

        val keys = E2eKdf.deriveTrafficKeys(sk(root), ctx)
        assertEquals(v.get("phoneToComputerKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))
        assertEquals(v.get("computerToPhoneKeyHex").asString, E2eKdf.toHex(keys.computerToPhone))

        val prefixes = E2eKdf.deriveNoncePrefixes(sk(root), ctx)
        assertEquals(v.get("np2cHex").asString, E2eKdf.toHex(prefixes.phoneToComputer))
        assertEquals(v.get("nc2pHex").asString, E2eKdf.toHex(prefixes.computerToPhone))
    }

    /**
     * A2 vector F's ciphertext must OPEN under the key and prefix derived from
     * the wire form. The file asserts it with `opensVectorF: true`; this is the
     * end-to-end statement that a peer holding only `ctx` and its own userId
     * can read what the phone sealed.
     */
    @Test
    fun vector_I1_opens_the_frozen_aead_vector() {
        val root = load()
        val v = i1(root)
        val ctx = E2ePairIdentity.contextFromWire(baseWire(root), localUserId(root))
        val f = root.getAsJsonObject("aead").getAsJsonObject("vectorF")

        val opened = E2eEnvelope.open(
            key = E2eKdf.deriveTrafficKeys(sk(root), ctx).phoneToComputer,
            envelope = E2eEnvelope.Sealed(
                E2eEnvelope.VERSION, f.get("kid").asString, f.get("seq").asLong,
                E2eKdf.fromHex(f.get("ciphertextHex").asString)
            ),
            direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
            pairEpoch = ctx.pairEpoch,
            sessionPrefix = E2eKdf.deriveNoncePrefixes(sk(root), ctx).phoneToComputer,
            frameType = f.get("frameType").asString,
        )
        assertEquals(
            "the file says vector F opens under the wire-derived material",
            true, v.get("opensVectorF").asBoolean
        )
        assertNotEquals("but it did not open", null, opened)
        // The file's `openedPlaintextHex` is the PADDED block (§13.4:
        // be32(len) ‖ "hi" ‖ zero fill to the 64-byte bucket), which is what
        // GCM returns before unpadding. E2eEnvelope.open unpads, so the two are
        // compared at the layer each actually describes rather than by
        // trusting the field name.
        assertEquals(
            v.get("openedPlaintextHex").asString,
            E2eKdf.toHex(E2ePadding.pad(f.get("frameType").asString, opened!!))
        )
        assertEquals(
            "and unpadded it is the vector's plaintext",
            f.get("plaintextUtf8").asString, String(opened, Charsets.UTF_8)
        )
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
        val ctx = E2ePairIdentity.contextFromWire(baseWire(root), localUserId(root))
        val emitted = E2ePairIdentity.ctxBlockFor(ctx)

        assertEquals("the emitted ctx must equal the vector's wire form", baseWire(root), emitted)
        assertEquals(
            "pairEpoch must be emitted as a decimal STRING, never a JSON number",
            "42", emitted.get("pairEpoch").asString
        )
        // Round trip: what we emit, a peer can read back to the same context.
        assertEquals(
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx)),
            E2eKdf.toHex(
                E2eKdf.pairContextBytes(
                    E2ePairIdentity.contextFromWire(emitted, localUserId(root))
                )
            )
        )
    }

    // ------------------------------------------------------------ I.2

    /**
     * A3-M2's replay case. ONE field of the wire form moves — the epoch — and
     * the key must diverge totally, so a frame sealed under the real epoch
     * fails to authenticate. That failure is what makes the receiver's refusal
     * floor meaningful rather than merely polite.
     */
    @Test
    fun vector_I2_one_epoch_of_drift_diverges_the_key_and_breaks_authentication() {
        val root = load()
        val v = section(root).getAsJsonObject("negativeI2EpochDrift")

        val wire = baseWire(root)
        wire.addProperty("pairEpoch", v.get("pairEpoch").asString)
        val ctx = E2ePairIdentity.contextFromWire(wire, localUserId(root))

        assertEquals(v.get("contextBytesHex").asString, E2eKdf.toHex(E2eKdf.pairContextBytes(ctx)))
        val keys = E2eKdf.deriveTrafficKeys(sk(root), ctx)
        assertEquals(v.get("phoneToComputerKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))
        val prefixes = E2eKdf.deriveNoncePrefixes(sk(root), ctx)
        assertEquals(v.get("np2cHex").asString, E2eKdf.toHex(prefixes.phoneToComputer))

        val f = root.getAsJsonObject("aead").getAsJsonObject("vectorF")
        assertFalse("the file's own expectation", v.get("opensVectorF").asBoolean)
        assertNull(
            "a frame sealed at epoch 42 opened under an epoch-43 key — the epoch is not " +
                "actually binding the traffic keys, and A3-M2's floor would protect nothing",
            E2eEnvelope.open(
                key = keys.phoneToComputer,
                envelope = E2eEnvelope.Sealed(
                    E2eEnvelope.VERSION, f.get("kid").asString, f.get("seq").asLong,
                    E2eKdf.fromHex(f.get("ciphertextHex").asString)
                ),
                direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairEpoch = ctx.pairEpoch,
                sessionPrefix = prefixes.phoneToComputer,
                frameType = f.get("frameType").asString,
            )
        )
    }

    // ------------------------------------------------------------ I.3

    /**
     * The point of the whole design: `userId` is never transmitted, so it can
     * only come from each side's own authenticated session. The WIRE BYTES are
     * identical to I.1 — only the local identity differs, by one character —
     * and the key must diverge completely. That is what makes a
     * session-identity mismatch fail closed instead of quietly working.
     */
    @Test
    fun vector_I3_an_untransmitted_userid_is_load_bearing() {
        val root = load()
        val v = section(root).getAsJsonObject("negativeI3UserIdDrift")

        // Same wire form, different LOCAL userId. Nothing an attacker on the
        // relay could influence has changed.
        val drifted = E2ePairIdentity.contextFromWire(baseWire(root), v.get("localUserId").asString)
        val honest = E2ePairIdentity.contextFromWire(baseWire(root), localUserId(root))

        val driftedKey = E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk(root), drifted).phoneToComputer)
        assertEquals(v.get("phoneToComputerKeyHex").asString, driftedKey)

        assertNotEquals(v.get("localUserId").asString, localUserId(root))
        assertEquals("the file's own expectation", true, v.get("mustDifferFromI1").asBoolean)
        assertNotEquals(
            "a one-character userId difference did not move the key",
            E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk(root), honest).phoneToComputer),
            driftedKey
        )
    }

    // ------------------------------------------------------------ I.4

    @Test
    fun vector_I4_every_malformed_pair_epoch_is_refused_never_coerced() {
        val root = load()
        val neg = section(root).getAsJsonObject("negativeI4Parser")

        for (bad in neg.getAsJsonArray("badPairEpoch")) {
            val wire = baseWire(root)
            wire.remove("pairEpoch")
            wire.add("pairEpoch", bad) // may be the JSON NUMBER 42, deliberately
            try {
                E2ePairIdentity.contextFromWire(wire, localUserId(root))
                fail(
                    "ctx.pairEpoch=$bad was ACCEPTED — A3 I.4 requires a refusal, not a " +
                        "coercion. The JSON-number case is the one the decimal-string rule " +
                        "exists for: JSON.parse yields a double and A1 forbids rounding above 2^53."
                )
            } catch (e: E2ePairIdentity.CtxException) {
                // expected
            }
        }

        if (neg.get("missingPairEpoch").asBoolean) {
            val wire = baseWire(root)
            wire.remove("pairEpoch")
            try {
                E2ePairIdentity.contextFromWire(wire, localUserId(root))
                fail("an absent ctx.pairEpoch was accepted")
            } catch (e: E2ePairIdentity.CtxException) {
                // expected
            }
        }
    }

    @Test
    fun vector_I4_an_absent_ctx_is_refused_never_guessed() {
        val neg = section(load()).getAsJsonObject("negativeI4Parser")
        assertEquals(true, neg.get("missingCtxOnMode1").asBoolean)
        try {
            E2ePairIdentity.contextFromWire(null, "user-0191aa")
            fail(
                "A3-M4: a mode=1 block with no ctx must be REFUSED, never derived from local — " +
                    "a guess is the silent divergence A3 exists to kill, and it would let a " +
                    "stripping relay force both sides into one"
            )
        } catch (e: E2ePairIdentity.CtxException) {
            // expected
        }
    }

    @Test
    fun vector_I4_a_ctx_for_another_pairing_is_refused() {
        val root = load()
        val m = section(root).getAsJsonObject("negativeI4Parser")
            .getAsJsonObject("pairingIdMismatch")

        val wire = baseWire(root)
        wire.addProperty("pairingId", m.get("ctxPairingId").asString)
        try {
            E2ePairIdentity.contextFromWire(
                wire, localUserId(root), expectedPairingId = m.get("ownPairingId").asString
            )
            fail("A3-M3: a ctx naming a different pairingId must be refused")
        } catch (e: E2ePairIdentity.CtxException) {
            // expected
        }
        // …and the matching one is accepted, so the check is not simply "throw".
        E2ePairIdentity.contextFromWire(
            baseWire(root), localUserId(root),
            expectedPairingId = m.get("ownPairingId").asString
        )
    }

    @Test
    fun vector_I4_an_oversized_id_is_refused_on_the_decode_side_too() {
        val root = load()
        val neg = section(root).getAsJsonObject("negativeI4Parser")
        val size = neg.get("oversizeFieldBytes").asInt

        // The file names userId too, which the phone supplies locally rather
        // than reading off the wire — so only the transmitted ones are decoded
        // here. userId's cap is enforced at encode by E2eKdf's u8 writer and is
        // covered by the frozen negativeOversizeIds vectors.
        for (field in neg.getAsJsonArray("oversizeFields").map { it.asString }) {
            if (field == "userId") continue
            val wire = baseWire(root)
            wire.addProperty(field, "x".repeat(size))
            try {
                E2ePairIdentity.contextFromWire(wire, localUserId(root))
                fail(
                    "$field of $size bytes was accepted — A1's u8 cap must hold on DECODE too, " +
                        "or an oversized id is truncated to len and 0xff and two sides hash " +
                        "different bytes"
                )
            } catch (e: E2ePairIdentity.CtxException) {
                // expected
            }
        }
    }
}
