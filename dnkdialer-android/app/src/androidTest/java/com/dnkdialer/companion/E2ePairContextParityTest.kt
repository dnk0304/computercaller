package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader
import java.security.MessageDigest

/**
 * E2E P4.4 — **the one function the vector suites never pinned.**
 *
 * ## Why this file exists
 *
 * P6.1c part 0's "why nothing caught it". Both the android and the web vector
 * suites build a [E2eKdf.PairContext] **directly from the frozen vectors**, so
 * they constrain the KDF and not its runtime inputs. The only place the
 * production inputs are assembled is [E2ePairIdentity.contextFor], and nothing
 * anywhere asserted against it — so `userIdForPairContext()` could return a
 * hard-coded `""` through P4, P4.1, P4.2, P6, P6.1a and P6.1b with every suite
 * green, while no wrap the phone sealed could open on the page (A6-P61B-8).
 *
 * This test closes that hole the only way it can be closed: it drives the
 * **production path**, `E2ePairIdentity.contextFor(ctx, ...)`, with the four
 * inputs of the frozen `/context` vector supplied through the channels a real
 * Accept uses — the account id via [TokenStore] (R-BH), the phone device id via
 * [E2eLifecycle]'s prefs, the peer via a recipient list, the epoch as an
 * argument — and asserts the bytes and their sha-256 against the frozen file.
 *
 * A hand-built `PairContext` here would prove nothing. That is exactly what the
 * suites this one supplements already do.
 *
 * ## The vectors are untouched
 *
 * `app/src/androidTest/resources/kdf-vectors.json` is the same byte-identical
 * P0.2 copy [E2eFrozenKdfVectorsTest] reads. No vector was edited, regenerated
 * or added for R-BH: every one of A–M already carries a NON-EMPTY `userId`, and
 * the whole of this lane is about making the production path able to produce
 * one.
 */
@RunWith(AndroidJUnit4::class)
class E2ePairContextParityTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    /** The frozen `/context` vector's sha-256, over `contextBytesHex`. */
    private val frozenContextDigest =
        "a6e367eb60ce550e943f47b818b4684e59d3ff897be873e59aa4e3f4588f6025"

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

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun sha256(b: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(b))

    /** A recipient list whose canonical-lowest deviceId is [id]. */
    private fun recipients(id: String): List<E2eNegotiation.Recipient> {
        val peer = E2eKeyAgreement.mintEphemeral()
        return try {
            listOf(E2eNegotiation.Recipient("web", id, peer.publicSec1))
        } finally {
            peer.close()
        }
    }

    /** Force [E2eLifecycle.deviceId] to the vector's phone id. */
    private fun seedPhoneDeviceId(id: String) {
        ctx.applicationContext
            .getSharedPreferences("computercaller_e2e_identity", Context.MODE_PRIVATE)
            .edit().putString("device_id", id).commit()
    }

    @Before
    fun wipe() {
        TokenStore.clear(ctx)
    }

    // ------------------------------------------------------------ parity

    /**
     * THE assertion. Same inputs, same bytes, same digest — through the code a
     * real Accept runs, not through a constructor call.
     */
    @Test
    fun the_production_context_reproduces_the_frozen_vector() {
        val v = load().getAsJsonObject("context")
        val expectedHex = load().get("contextBytesHex").asString

        // Sanity: the vector is the one we think it is, and it carries a REAL
        // account id. A vector with an empty userId would make this test pass
        // for the wrong reason.
        assertEquals("user-0191aa", v.get("userId").asString)
        assertTrue("the vector's userId must be non-empty", v.get("userId").asString.isNotEmpty())

        // ---- feed the four inputs through their PRODUCTION channels ----
        assertEquals(
            TokenStore.UserIdWrite.STORED,
            TokenStore.putUserId(ctx, v.get("userId").asString),
        )
        seedPhoneDeviceId(v.get("phoneDeviceId").asString)

        val produced = E2ePairIdentity.contextFor(
            ctx,
            pairingId = v.get("pairingId").asString,
            recipients = recipients(v.get("peerDeviceId").asString),
            pairEpoch = v.get("pairEpoch").asLong,
        )

        // Every field came from the channel, not from the vector object.
        assertEquals(v.get("pairingId").asString, produced.pairingId)
        assertEquals(v.get("userId").asString, produced.userId)
        assertEquals(v.get("phoneDeviceId").asString, produced.phoneDeviceId)
        assertEquals(v.get("peerDeviceId").asString, produced.peerDeviceId)
        assertEquals(v.get("pairEpoch").asLong, produced.pairEpoch)

        val bytes = E2eKdf.pairContextBytes(produced)
        assertEquals("contextBytesHex", expectedHex, hex(bytes))
        assertArrayEquals(
            "the production context must equal the frozen bytes",
            hexToBytes(expectedHex),
            bytes,
        )
        assertEquals("sha-256 of the context bytes", frozenContextDigest, sha256(bytes))
    }

    /**
     * The digest is pinned as a LITERAL as well as recomputed, so that an edit
     * to the vectors file cannot quietly move both sides of the comparison at
     * once. [E2eFrozenKdfVectorsTest] guards the file's identity; this guards
     * the one value this test turns on.
     */
    @Test
    fun the_frozen_digest_literal_still_describes_the_vector_file() {
        val expectedHex = load().get("contextBytesHex").asString
        assertEquals(frozenContextDigest, sha256(hexToBytes(expectedHex)))
    }

    // ------------------------------------------------------- fail closed

    /**
     * R-BH's fail-closed half, mirroring the page (`useE2e.ts:147`, a null
     * session userId refuses). With no account id learned, [contextFor] MUST
     * throw — never fall back to `""`, which is the bug.
     *
     * The exception is a [RuntimeException], which is what lets PhoneService's
     * existing Accept catch turn it into a DECLINE under mode ON without a
     * second refusal implementation.
     */
    @Test
    fun contextFor_refuses_when_the_account_id_is_unknown() {
        TokenStore.clear(ctx)
        seedPhoneDeviceId("dev-phone-01")

        try {
            E2ePairIdentity.contextFor(
                ctx,
                pairingId = "pair-7f3a9c21",
                recipients = recipients("dev-web-01"),
                pairEpoch = 42L,
            )
            fail("contextFor must refuse when the account id is unknown, never derive under \"\"")
        } catch (e: E2ePairIdentity.PairContextUnavailableException) {
            assertTrue(
                "the refusal must say why: ${e.message}",
                e.message!!.contains("account id"),
            )
            assertTrue("it must be catchable as a RuntimeException", e is RuntimeException)
        }
    }

    /**
     * And it refuses for the right REASON: the id is genuinely absent, not
     * merely unreadable. A test that passed because the Keystore was broken
     * would be worthless.
     */
    @Test
    fun the_refusal_is_because_the_id_is_absent_not_because_the_store_is_broken() {
        TokenStore.clear(ctx)
        assertEquals(TokenStore.UserIdWrite.STORED, TokenStore.putUserId(ctx, "probe"))
        assertEquals("probe", TokenStore.getUserId(ctx))
        TokenStore.clear(ctx)
        assertNotNull("the store works", TokenStore.putUserId(ctx, "probe2"))
        assertEquals("probe2", TokenStore.getUserId(ctx))
    }

    private fun hexToBytes(s: String) = ByteArray(s.length / 2) {
        ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte()
    }
}
