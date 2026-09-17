package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 Part 2 (d) — the Accept handshake end to end, with the computer's two
 * recipients simulated locally.
 *
 * Instrumented because the phone's static key lives in AndroidKeyStore and the
 * session's counter is sealed under a Keystore key; neither exists on the JVM
 * test classpath.
 *
 * The load-bearing test is [each_recipient_opens_its_own_wrap_and_only_its_own]:
 * multi-recipient sealing is only correct if every recipient can open its wrap
 * AND cannot open anybody else's. A single-recipient test would pass against an
 * implementation that ignored the recipient key entirely.
 */
@RunWith(AndroidJUnit4::class)
class E2eAcceptTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairingId = "pair-accept-test"
    private val userId = "user-a"
    private val phoneDeviceId = "phone-a"
    private val peerDeviceId = "web-a"
    private val epoch = 3L

    /** A simulated recipient: a keypair we hold both halves of. */
    private class Peer(val kind: String, val deviceId: String) {
        val kp = java.security.KeyPairGenerator.getInstance("EC").apply {
            initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val pub: ByteArray = E2eKeyEncoding.toSec1(kp.public)
        fun recipient() = E2eNegotiation.Recipient(kind, deviceId, pub)
    }

    private lateinit var web: Peer
    private lateinit var sw: Peer

    @Before
    fun setUp() {
        E2eSeqStore.clearAll(ctx)
        web = Peer("web", "dev-web")
        sw = Peer("extension", "dev-sw")
    }

    private fun pairContext(ep: Long = epoch) = E2eKdf.PairContext(
        pairingId, userId, phoneDeviceId, peerDeviceId, ep
    )

    private fun prepare(modeOn: Boolean = true): E2eAccept.Prepared =
        E2eAccept.prepare(
            ctx,
            E2eNegotiation.Decision.Encrypted(modeOn, listOf(web.recipient(), sw.recipient())),
            pairingId, userId, phoneDeviceId, peerDeviceId, epoch,
        )

    /** What a recipient does to recover SK from its wrap. */
    private fun openWrapAs(
        peer: Peer,
        block: com.google.gson.JsonObject,
        ep: Long = epoch,
    ): ByteArray? {
        val kid = block.get("kid").asString
        val epk = E2eKeyEncoding.fromBase64Url(block.get("epk").asString)
        val wrap = block.getAsJsonArray("wraps")
            .map { it.asJsonObject }
            .firstOrNull { it.get("deviceId").asString == peer.deviceId }
            ?.get("wrap")?.asString
            ?: return null

        val ka = javax.crypto.KeyAgreement.getInstance("ECDH")
        ka.init(peer.kp.private)
        ka.doPhase(E2eKeyEncoding.fromSec1(epk), true)
        val z = ka.generateSecret()
        // pairEpoch is bound into the KEK info, so opening with the wrong epoch
        // fails — which is the point, and is why this takes `ep`.
        val kek = E2eKdf.deriveKek(z, pairContext(ep), peer.pub)
        val prefix = java.security.MessageDigest.getInstance("SHA-256")
            .digest(peer.deviceId.toByteArray(Charsets.UTF_8))
            .copyOf(E2eEnvelope.SESSION_PREFIX_BYTES)
        return E2eEnvelope.open(
            kek,
            E2eEnvelope.Sealed(1, kid, 0, E2eKeyEncoding.fromBase64Url(wrap)),
            E2eEnvelope.Direction.PHONE_TO_COMPUTER,
            ep, prefix, E2eAccept.WRAP_FRAME_TYPE,
        )
    }

    // ------------------------------------------------------ the handshake

    @Test
    fun the_block_has_the_shape_P1_expects() {
        prepare().use { p ->
            val b = p.block
            assertEquals("v:1 or P1 drops the block to plaintext", 1, b.get("v").asInt)
            assertEquals(1, b.get("mode").asInt)
            assertTrue(b.get("kid").asString.isNotEmpty())

            val epk = E2eKeyEncoding.fromBase64Url(b.get("epk").asString)
            assertEquals("epk is a 65-byte SEC1 point", 65, epk.size)
            E2eKeyEncoding.validate(epk)

            // recipKeys is the FULL set: phone + web + sw.
            val keys = b.getAsJsonArray("recipKeys").map { it.asString }
            assertEquals(3, keys.size)
            assertTrue(keys.contains(E2eKeyEncoding.toBase64Url(E2eKeyAgreement.devicePublicSec1(ctx))))
            assertTrue(keys.contains(E2eKeyEncoding.toBase64Url(web.pub)))
            assertTrue(keys.contains(E2eKeyEncoding.toBase64Url(sw.pub)))

            assertEquals("one wrap per recipient", 2, b.getAsJsonArray("wraps").size())
            assertTrue(
                "the block must fit the relay's 4 KB cap",
                b.toString().toByteArray(Charsets.UTF_8).size < E2eNegotiation.MAX_BLOCK_BYTES
            )
        }
    }

    /**
     * Multi-recipient sealing is only correct if each recipient opens ITS OWN
     * wrap and nobody else's. A single-recipient test would pass against an
     * implementation that ignored the recipient key entirely.
     */
    @Test
    fun each_recipient_opens_its_own_wrap_and_only_its_own() {
        prepare().use { p ->
            val skWeb = openWrapAs(web, p.block)
            val skSw = openWrapAs(sw, p.block)
            assertNotNull("the web page could not open its wrap", skWeb)
            assertNotNull("the service worker could not open its wrap", skSw)
            assertEquals(32, skWeb!!.size)
            assertArrayEquals("both recipients must recover the SAME SK", skWeb, skSw)

            // Cross-open: the web page's KEK against the SW's wrap must fail.
            val swWrap = p.block.getAsJsonArray("wraps").map { it.asJsonObject }
                .first { it.get("deviceId").asString == sw.deviceId }
            val crossed = p.block.deepCopy()
            crossed.getAsJsonArray("wraps").removeAll { true }
            val relabelled = swWrap.deepCopy()
            relabelled.addProperty("deviceId", web.deviceId)
            crossed.getAsJsonArray("wraps").add(relabelled)
            assertNull(
                "the web page opened the service worker's wrap — the KEK does not bind K_i",
                openWrapAs(web, crossed)
            )
        }
    }

    /** The recovered SK must actually drive the session the phone kept. */
    @Test
    fun the_recovered_SK_decrypts_what_the_phone_seals() {
        prepare().use { p ->
            val sk = openWrapAs(web, p.block)!!
            val keys = E2eKdf.deriveTrafficKeys(sk, pairContext())
            val prefixes = E2eKdf.deriveNoncePrefixes(sk, pairContext())

            val sealed = p.session.seal("SMS_RECEIVED", "hello".toByteArray(Charsets.UTF_8))
            assertArrayEquals(
                "the recipient must open what the phone sealed",
                "hello".toByteArray(Charsets.UTF_8),
                E2eEnvelope.open(
                    keys.phoneToComputer, sealed,
                    E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                    epoch, prefixes.phoneToComputer, "SMS_RECEIVED"
                )
            )
        }
    }

    // ------------------------------------------------------------- the SAS

    @Test
    fun the_sas_is_shown_only_when_the_mode_is_on_and_both_sides_agree() {
        prepare(modeOn = true).use { p ->
            // A local val: `sasDigits` is a public property of another module,
            // so Kotlin refuses to smart-cast it after the null check.
            val digits = p.sasDigits
            assertNotNull("mode ON must produce SAS digits", digits)
            assertEquals(5, digits!!.length)
            assertTrue(digits.all { it.isDigit() })

            // The recipient computes the same digits from the block alone.
            val keys = p.block.getAsJsonArray("recipKeys")
                .map { E2eKeyEncoding.fromBase64Url(it.asString) }
            val peerDigits = E2eSas.digits(
                pairingId = pairingId,
                epk = E2eKeyEncoding.fromBase64Url(p.block.get("epk").asString),
                keys = keys,
                pairEpoch = epoch,
                modeOn = true,
            )
            assertEquals("the two sides must show the SAME code", digits, peerDigits)
        }
        prepare(modeOn = false).use { p ->
            assertNull("mode OFF shows no SAS — Encrypted (unverified)", p.sasDigits)
            assertEquals(0, p.block.get("mode").asInt)
        }
    }

    /**
     * §13.3 / matrix row 11: swapping the service worker's key must move the
     * digits, because the SAS covers the WHOLE key set. This is the property
     * that makes a swapped SW key visible to the user, and the SW has no UI of
     * its own to show a per-recipient code on.
     */
    @Test
    fun swapping_the_service_worker_key_moves_the_digits() {
        val a = prepare().use { it.sasDigits!! }
        sw = Peer("extension", "dev-sw") // a different SW key, same deviceId
        val b = prepare().use { it.sasDigits!! }
        assertNotEquals("a swapped SW key must change the code the user reads", a, b)
    }

    // ---------------------------------------------------------- lifecycle

    @Test
    fun every_accept_mints_a_new_kid_and_a_new_SK() {
        val first = prepare()
        val firstKid = first.block.get("kid").asString
        val firstSk = openWrapAs(web, first.block)!!
        first.close()

        val second = E2eAccept.prepare(
            ctx,
            E2eNegotiation.Decision.Encrypted(true, listOf(web.recipient(), sw.recipient())),
            pairingId, userId, phoneDeviceId, peerDeviceId, epoch + 1,
        )
        try {
            assertNotEquals("a new Accept must mint a new kid", firstKid, second.block.get("kid").asString)
            assertNotEquals(
                "a new Accept must mint a new SK",
                E2eKdf.toHex(firstSk),
                E2eKdf.toHex(openWrapAs(web, second.block, epoch + 1)!!)
            )
            // The epoch is bound into the KEK: opening the new wrap with the OLD
            // epoch must fail. This is what stops a wrap being replayed into
            // another epoch (§13.8).
            assertNull(
                "a wrap opened under the wrong pairEpoch — the epoch is not bound",
                openWrapAs(web, second.block, epoch)
            )
        } finally {
            second.close()
        }
    }

    @Test
    fun an_accept_with_no_recipients_is_refused() {
        try {
            E2eAccept.prepare(
                ctx, E2eNegotiation.Decision.Encrypted(true, emptyList()),
                pairingId, userId, phoneDeviceId, peerDeviceId, epoch,
            )
            org.junit.Assert.fail("prepared an Accept with nothing to seal to")
        } catch (e: E2eAccept.AcceptException) {
            assertTrue(e.message!!.contains("recipients"))
        }
    }

    private inline fun <R> E2eAccept.Prepared.use(body: (E2eAccept.Prepared) -> R): R =
        try { body(this) } finally { session.close() }

    private fun E2eAccept.Prepared.close() = session.close()
}
