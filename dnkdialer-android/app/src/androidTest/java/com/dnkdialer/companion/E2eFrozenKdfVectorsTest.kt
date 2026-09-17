package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E P4 Part 2 (c2) — the android lane asserted against **P0.2's frozen
 * `tests/kdf-vectors.json`**, not against P4's own copy.
 *
 * `app/src/androidTest/resources/kdf-vectors.json` is a byte-identical copy of
 * `tests/kdf-vectors.json` at P0.2 `ee511c7` on `e2e/p0.2-kdf-freeze`
 * (sha256 fff11ceb33f4dc3f44b141a493eb36f692748c19e934c60dc764417a7fa294bb).
 *
 * ## Why this file exists when [E2eKdfVectorsTest] already pins the layout
 *
 * They pin different things, and only one of them is a cross-lane check.
 * [E2eKdfVectorsTest] asserts P4's own generated file still matches P4's own
 * code — that catches drift, but it would keep passing if every lane drifted
 * together, or if P4 had simply read the addendum wrong. GATE1 Addendum A1 is
 * explicit about the difference:
 *
 * > `E2eKdfVectorsTest` already fails the Android build on drift; the same
 * > assertion must exist in the web/SW lane **against the same file**, or the
 * > file only constrains one of the three implementations.
 *
 * P0.2's file is that same file, and its header names this test as one of its
 * two asserters. This is the android half of that requirement: the values were
 * frozen by Security, reproduced independently by P0.2 in node, and are
 * reproduced here in Kotlin. Three implementations, one set of bytes.
 */
@RunWith(AndroidJUnit4::class)
class E2eFrozenKdfVectorsTest {

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("kdf-vectors.json")
            ?: throw AssertionError(
                "kdf-vectors.json is not on the androidTest classpath — it must be a " +
                    "byte-identical copy of tests/kdf-vectors.json from e2e/p0.2-kdf-freeze"
            )
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun ctxOf(root: JsonObject): E2eKdf.PairContext {
        val c = root.getAsJsonObject("context")
        return E2eKdf.PairContext(
            pairingId = c.get("pairingId").asString,
            userId = c.get("userId").asString,
            phoneDeviceId = c.get("phoneDeviceId").asString,
            peerDeviceId = c.get("peerDeviceId").asString,
            pairEpoch = c.get("pairEpoch").asLong,
        )
    }

    // ------------------------------------------- the file is the right file

    @Test
    fun the_frozen_file_is_the_one_we_think_it_is() {
        val root = load()
        assertEquals("cc-e2e-v1", root.get("version").asString)
        assertEquals("HKDF-SHA-256", root.get("hash").asString)
        assertTrue(
            "the file must name GATE1 Addendum A1 as its authority",
            root.get("_authority").asString.contains("Addendum A1")
        )
        for (section in listOf("context", "contextBytesHex", "labels", "traffic", "kek", "aead")) {
            assertTrue("missing section '$section'", root.has(section))
        }
        val aead = root.getAsJsonObject("aead")
        for (section in listOf("vectorA", "negativeOversizeIds", "tamper", "crossDirection")) {
            assertTrue("missing aead.$section", aead.has(section))
        }
    }

    // ---------------------------------------------- item (1): the schedule

    @Test
    fun the_pair_context_and_labels_reproduce() {
        val root = load()
        val ctx = ctxOf(root)
        assertEquals(
            "pairContext framing drifted from the frozen file",
            root.get("contextBytesHex").asString,
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx))
        )
        val labels = root.getAsJsonObject("labels")
        assertEquals(labels.get("kek").asString, E2eKdf.LABEL_KEK)
        assertEquals(labels.get("phoneToComputer").asString, E2eKdf.LABEL_PHONE_TO_COMPUTER)
        assertEquals(labels.get("computerToPhone").asString, E2eKdf.LABEL_COMPUTER_TO_PHONE)
    }

    @Test
    fun the_traffic_keys_reproduce() {
        val root = load()
        val ctx = ctxOf(root)
        val t = root.getAsJsonObject("traffic")
        val sk = E2eKdf.fromHex(t.get("sessionKeyHex").asString)

        assertEquals(
            t.get("infoP2cHex").asString,
            E2eKdf.toHex(E2eKdf.infoFor(E2eKdf.LABEL_PHONE_TO_COMPUTER, ctx))
        )
        assertEquals(
            t.get("infoC2pHex").asString,
            E2eKdf.toHex(E2eKdf.infoFor(E2eKdf.LABEL_COMPUTER_TO_PHONE, ctx))
        )

        val keys = E2eKdf.deriveTrafficKeys(sk, ctx)
        assertEquals(t.get("phoneToComputerKeyHex").asString, E2eKdf.toHex(keys.phoneToComputer))
        assertEquals(t.get("computerToPhoneKeyHex").asString, E2eKdf.toHex(keys.computerToPhone))
    }

    @Test
    fun every_recipient_KEK_reproduces() {
        val root = load()
        val ctx = ctxOf(root)
        val kek = root.getAsJsonObject("kek")
        val z = E2eKdf.fromHex(kek.get("sharedSecretHex").asString)
        val recipients = kek.getAsJsonArray("recipients")
        assertTrue("the file must carry more than one recipient", recipients.size() >= 2)

        val seen = mutableSetOf<String>()
        for (e in recipients) {
            val r = e.asJsonObject
            val pub = E2eKdf.fromHex(r.get("publicKeySec1Hex").asString)
            E2eKeyEncoding.validate(pub) // the fixed points must be real points
            assertEquals(
                "kekInfo drifted for ${r.get("kind").asString}",
                r.get("kekInfoHex").asString,
                E2eKdf.toHex(E2eKdf.kekInfo(ctx, pub))
            )
            val derived = E2eKdf.toHex(E2eKdf.deriveKek(z, ctx, pub))
            assertEquals(
                "KEK drifted for ${r.get("kind").asString}",
                r.get("kekHex").asString, derived
            )
            assertTrue("two recipients must not share a KEK", seen.add(derived))
        }
    }

    // ------------------------------------------------ item (3): the AEAD

    /**
     * The one that proves three independent implementations agree: Security
     * computed this ciphertext from the specification, P0.2 reproduced it in
     * node, and this reproduces it in Kotlin on a real Android runtime.
     */
    @Test
    fun A1_vectorA_reproduces_byte_for_byte() {
        val v = load().getAsJsonObject("aead").getAsJsonObject("vectorA")
        val frameType = v.get("frameType").asString
        val kid = v.get("kid").asString
        val seq = v.get("seq").asLong
        val epoch = v.get("pairEpoch").asLong
        val dir = directionOf(v)
        val prefix = E2eKdf.fromHex(v.get("sessionPrefixHex").asString)
        val key = E2eKdf.fromHex(v.get("keyHex").asString)
        val plain = v.get("plaintextUtf8").asString.toByteArray(Charsets.UTF_8)

        assertEquals(
            "padded block drifted — pad per §13.4 FIRST, then seal",
            v.get("paddedPlaintextHex").asString,
            E2eKdf.toHex(E2ePadding.pad(frameType, plain))
        )
        assertEquals(
            "AAD drifted — tags 0x21..0x25, RE-ENCODED from parsed fields",
            v.get("aadHex").asString,
            E2eKdf.toHex(E2eEnvelope.aad(frameType, kid, seq, dir, epoch))
        )
        assertEquals(
            "nonce drifted — sessionPrefix ‖ be64(seq)",
            v.get("nonceHex").asString,
            E2eKdf.toHex(E2eEnvelope.nonceFor(prefix, seq))
        )

        val sealed = E2eEnvelope.seal(key, kid, seq, dir, epoch, prefix, frameType, plain)
        assertEquals(
            "CIPHERTEXT MISMATCH against the FROZEN file. Do not adjust the file — " +
                "find which of nonce / AAD / padding / key schedule departed from A1.",
            v.get("ciphertextHex").asString,
            E2eKdf.toHex(sealed.ciphertext)
        )
        assertArrayEquals(
            plain,
            E2eEnvelope.open(key, sealed, dir, epoch, prefix, frameType)
        )
    }

    /** A1 item 4: the u8 cap must THROW at encode, on every platform. */
    @Test
    fun the_oversize_id_cases_all_throw() {
        val neg = load().getAsJsonObject("aead").getAsJsonObject("negativeOversizeIds")
        val max = neg.get("maxBytes")?.asInt ?: 255
        assertEquals(255, max)
        val long = "a".repeat(max + 1)

        var thrown = 0
        for (probe in listOf<() -> Any>(
            { E2eKdf.pairContextBytes(E2eKdf.PairContext("p", long, "d", "w", 1)) },
            { E2eKdf.pairContextBytes(E2eKdf.PairContext("p", "u", long, "w", 1)) },
            { E2eKdf.pairContextBytes(E2eKdf.PairContext("p", "u", "d", long, 1)) },
            { E2eEnvelope.aad("SMS_RECEIVED", long, 1, E2eEnvelope.Direction.PHONE_TO_COMPUTER, 1) },
            { E2eEnvelope.aad(long, "kid", 1, E2eEnvelope.Direction.PHONE_TO_COMPUTER, 1) },
        )) {
            try {
                probe()
                fail("an over-long id was accepted — the u8 cap is not enforced")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("255"))
                thrown++
            }
        }
        assertEquals("all five cases must throw", 5, thrown)
    }

    /** A1 item C: changing any AAD field must fail the tag check. */
    @Test
    fun the_tamper_cases_all_fail_the_tag_check() {
        val root = load()
        val v = root.getAsJsonObject("aead").getAsJsonObject("vectorA")
        val frameType = v.get("frameType").asString
        val kid = v.get("kid").asString
        val seq = v.get("seq").asLong
        val epoch = v.get("pairEpoch").asLong
        val dir = directionOf(v)
        val prefix = E2eKdf.fromHex(v.get("sessionPrefixHex").asString)
        val key = E2eKdf.fromHex(v.get("keyHex").asString)
        val sealed = E2eEnvelope.Sealed(1, kid, seq, E2eKdf.fromHex(v.get("ciphertextHex").asString))

        assertNull("frameType not bound", E2eEnvelope.open(key, sealed, dir, epoch, prefix, "CALL_STATUS"))
        assertNull("kid not bound", E2eEnvelope.open(
            key, sealed.copy(kid = "kid-99"), dir, epoch, prefix, frameType))
        assertNull("seq not bound", E2eEnvelope.open(
            key, sealed.copy(seq = seq + 1), dir, epoch, prefix, frameType))
        assertNull("direction not bound", E2eEnvelope.open(
            key, sealed, E2eEnvelope.Direction.COMPUTER_TO_PHONE, epoch, prefix, frameType))
        assertNull("pairEpoch not bound", E2eEnvelope.open(
            key, sealed, dir, epoch + 1, prefix, frameType))
        // Control: untouched, it opens — so every null above means something.
        assertTrue(E2eEnvelope.open(key, sealed, dir, epoch, prefix, frameType) != null)
    }

    /** A1 item D: k_c2p must not open a p2c frame. */
    @Test
    fun the_cross_direction_key_does_not_open_vectorA() {
        val root = load()
        val v = root.getAsJsonObject("aead").getAsJsonObject("vectorA")
        val c2p = E2eKdf.fromHex(root.getAsJsonObject("traffic").get("computerToPhoneKeyHex").asString)
        val sealed = E2eEnvelope.Sealed(
            1, v.get("kid").asString, v.get("seq").asLong,
            E2eKdf.fromHex(v.get("ciphertextHex").asString)
        )
        assertNull(
            "the c2p key opened a p2c frame — directional separation is broken",
            E2eEnvelope.open(
                c2p, sealed, directionOf(v), v.get("pairEpoch").asLong,
                E2eKdf.fromHex(v.get("sessionPrefixHex").asString),
                v.get("frameType").asString
            )
        )
    }

    /**
     * The frozen file carries the direction TWICE: `direction` is the numeric
     * wire byte (0x01 / 0x02) and `directionName` is the label. Both are read
     * and cross-checked, because they are the value that actually goes into the
     * AAD — trusting the label while the byte says something else would be a
     * silent disagreement with the other two lanes.
     */
    private fun directionOf(v: JsonObject): E2eEnvelope.Direction {
        val byte = v.get("direction").asInt
        val name = v.get("directionName").asString
        val d = when (byte) {
            1 -> E2eEnvelope.Direction.PHONE_TO_COMPUTER
            2 -> E2eEnvelope.Direction.COMPUTER_TO_PHONE
            else -> throw AssertionError("unknown direction byte $byte in the frozen file")
        }
        assertEquals("direction byte $byte disagrees with directionName '$name'",
            if (d == E2eEnvelope.Direction.PHONE_TO_COMPUTER) "p2c" else "c2p", name)
        assertEquals("our wire byte must match the frozen one",
            byte, d.wireByte.toInt())
        return d
    }
}
