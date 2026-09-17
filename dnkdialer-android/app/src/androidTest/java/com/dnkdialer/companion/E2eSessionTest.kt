package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 Part 2 (c2) — [E2eSession], the only sealing API production code may
 * use, and the directional separation GATE1 Addendum A1 item 2 requires.
 *
 * The peer is simulated with the low-level [E2eEnvelope] API, which is exactly
 * what the (g) node harness will do on the web side: derive the same schedule,
 * seal c2p, and check the phone opens it.
 */
@RunWith(AndroidJUnit4::class)
class E2eSessionTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairContext = E2eKdf.PairContext(
        pairingId = "pair-session-test",
        userId = "user-s",
        phoneDeviceId = "phone-s",
        peerDeviceId = "web-s",
        pairEpoch = 11L,
    )

    private val sk = ByteArray(32) { (it * 11 + 5).toByte() }

    @Before
    fun clean() {
        E2eSeqStore.clearAll(ctx)
        // A2 MUST (1)'s kid<->SK binding is process-lifetime, and every test in
        // this class deliberately reuses one `sk` fixture. Without this, the
        // first test to bind a kid poisons every later one — and because JUnit
        // does not guarantee method order, it would poison a DIFFERENT set on
        // each run. Production never needs it: an SK is minted fresh at every
        // Accept and zeroed at close, so no two pairings share one.
        E2eSession.clearKidBindingsForTest()
    }

    private fun session(kid: String = "kid-s", fresh: Boolean = true) =
        E2eSession.forPhone(ctx, sk, pairContext, kid, freshEpoch = fresh)

    /** What the computer would hold: the mirror image of the phone's keys. */
    private fun peerKeys() = E2eKdf.deriveTrafficKeys(sk, pairContext)

    @Test
    fun the_phone_seals_p2c_and_the_peer_opens_it() {
        session().use { s ->
            val sealed = s.seal("SMS_RECEIVED", "hello".toByteArray(Charsets.UTF_8))
            assertEquals(0, sealed.seq)

            // The peer opens with the p2c key and the p2c direction.
            val opened = E2eEnvelope.open(
                key = peerKeys().phoneToComputer,
                envelope = sealed,
                direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairEpoch = pairContext.pairEpoch,
                sessionPrefix = prefixOf(s),
                frameType = "SMS_RECEIVED",
            )
            assertArrayEquals("hello".toByteArray(Charsets.UTF_8), opened)
        }
    }

    @Test
    fun the_phone_opens_a_c2p_frame_from_the_peer() {
        session().use { s ->
            val peerPrefix = E2eKdf.deriveNoncePrefixes(sk, pairContext).computerToPhone
            val fromPeer = E2eEnvelope.seal(
                key = peerKeys().computerToPhone,
                kid = "kid-s",
                seq = 0,
                direction = E2eEnvelope.Direction.COMPUTER_TO_PHONE,
                pairEpoch = pairContext.pairEpoch,
                sessionPrefix = peerPrefix,
                frameType = "SEND_SMS",
                plaintext = "reply".toByteArray(Charsets.UTF_8),
            )
            val r = s.open(fromPeer, "SEND_SMS")
            assertTrue("expected a Frame, got $r", r is E2eSession.Opened.Frame)
            assertArrayEquals(
                "reply".toByteArray(Charsets.UTF_8),
                (r as E2eSession.Opened.Frame).plaintext
            )
        }
    }

    /**
     * A1 item 2: a frame bounced back at its sender must be inert. The phone's
     * OWN p2c frame must not open under its receive key — and [E2eSession] has
     * no API that would let a caller try the other key by mistake.
     */
    @Test
    fun a_reflected_frame_is_inert() {
        session().use { s ->
            val mine = s.seal("SMS_RECEIVED", "secret".toByteArray(Charsets.UTF_8))
            val r = s.open(mine, "SMS_RECEIVED")
            assertTrue(
                "the phone opened its own outbound frame — direction separation is broken",
                r is E2eSession.Opened.Undecryptable
            )
        }
    }

    /**
     * §13.5: a resume legitimately re-sends buffered frames. The first delivery
     * is a Frame, the re-send is a Duplicate, and neither is an error.
     */
    @Test
    fun a_resend_is_a_duplicate_not_a_failure() {
        session().use { s ->
            val peerPrefix = E2eKdf.deriveNoncePrefixes(sk, pairContext).computerToPhone
            val frames = (0 until 20).map { i ->
                E2eEnvelope.seal(
                    peerKeys().computerToPhone, "kid-s", i.toLong(),
                    E2eEnvelope.Direction.COMPUTER_TO_PHONE, pairContext.pairEpoch,
                    peerPrefix, "SEND_SMS", "m$i".toByteArray(Charsets.UTF_8)
                )
            }
            assertEquals(20, frames.count { s.open(it, "SEND_SMS") is E2eSession.Opened.Frame })
            assertEquals(
                "every re-send must be a Duplicate, not an Undecryptable",
                20,
                frames.count { s.open(it, "SEND_SMS") is E2eSession.Opened.Duplicate }
            )
            assertEquals(20, s.droppedFrames)
        }
    }

    /**
     * Authenticate FIRST, then dedupe. If the order were reversed an
     * unauthenticated attacker could burn sequence slots and make genuine
     * frames drop as duplicates — a denial of service costing one forged frame.
     */
    @Test
    fun a_forged_frame_does_not_consume_a_dedupe_slot() {
        session().use { s ->
            val peerPrefix = E2eKdf.deriveNoncePrefixes(sk, pairContext).computerToPhone
            val forged = E2eEnvelope.Sealed(1, "kid-s", 5, ByteArray(80) { 0x41 })
            assertTrue(s.open(forged, "SEND_SMS") is E2eSession.Opened.Undecryptable)

            // The genuine frame at sequence 5 must still be accepted.
            val real = E2eEnvelope.seal(
                peerKeys().computerToPhone, "kid-s", 5,
                E2eEnvelope.Direction.COMPUTER_TO_PHONE, pairContext.pairEpoch,
                peerPrefix, "SEND_SMS", "real".toByteArray(Charsets.UTF_8)
            )
            assertTrue(
                "a forged frame consumed the dedupe slot for a genuine one",
                s.open(real, "SEND_SMS") is E2eSession.Opened.Frame
            )
        }
    }

    @Test
    fun three_decrypt_failures_in_ten_seconds_request_a_repair() {
        session().use { s ->
            val bad = E2eEnvelope.Sealed(1, "kid-s", 1, ByteArray(80))
            val verdicts = (0 until 3).map { s.open(bad, "SEND_SMS") }
            val last = verdicts.last()
            assertTrue(last is E2eSession.Opened.Undecryptable)
            assertTrue(
                "§13.5: 3 failures in 10 s requests a re-pair — and NEVER closes the socket",
                (last as E2eSession.Opened.Undecryptable).requestRepair
            )
        }
    }

    @Test
    fun a_frame_for_another_kid_is_refused() {
        session().use { s ->
            val other = E2eEnvelope.Sealed(1, "kid-other", 0, ByteArray(80))
            assertTrue(s.open(other, "SEND_SMS") is E2eSession.Opened.Undecryptable)
        }
    }

    @Test
    fun sequences_are_monotonic_across_a_session() {
        session().use { s ->
            val seqs = (0 until 200).map { s.seal("SMS_RECEIVED", ByteArray(4)).seq }
            assertEquals("no sequence may repeat", 200, seqs.toSet().size)
            assertEquals("and they must be ordered", seqs.sorted(), seqs)
        }
    }

    @Test
    fun close_zeroes_the_keys_so_sealing_after_close_cannot_produce_a_valid_frame() {
        val s = session()
        val before = s.seal("SMS_RECEIVED", "x".toByteArray(Charsets.UTF_8))
        s.close()
        val after = s.seal("SMS_RECEIVED", "x".toByteArray(Charsets.UTF_8))
        // Sealed under an all-zero key: the peer's real key must not open it.
        assertTrue(
            "a frame sealed after close() opened under the real key",
            E2eEnvelope.open(
                peerKeys().phoneToComputer, after, E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairContext.pairEpoch, prefixOf(s), "SMS_RECEIVED"
            ) == null
        )
        // Control: the pre-close frame did open.
        assertArrayEquals(
            "x".toByteArray(Charsets.UTF_8),
            E2eEnvelope.open(
                peerKeys().phoneToComputer, before, E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairContext.pairEpoch, prefixOf(s), "SMS_RECEIVED"
            )
        )
    }

    @Test
    fun stats_carry_no_key_material() {
        session().use { s ->
            s.seal("SMS_RECEIVED", "topsecret".toByteArray(Charsets.UTF_8))
            val stats = s.stats()
            assertTrue(stats, stats.contains("kid=kid-s"))
            assertTrue(stats, stats.contains("nextSeq="))
            assertTrue("no plaintext in stats", !stats.contains("topsecret"))
            assertTrue("no key material in stats", !stats.contains(E2eKdf.toHex(sk)))
        }
    }

    /**
     * GATE1 Addendum A2 MUST (1): **one `SK` names exactly one `kid`.**
     *
     * A second `kid` under the same `SK` would open a counter that restarts at
     * 0 against the identical traffic key and the identical derived prefix —
     * `pairContext` does not bind `kid`, so nothing in the key schedule moves.
     * That is a GCM nonce reuse: both plaintexts leak and the GHASH key falls
     * out with them, which is forgery for every frame under that key.
     *
     * A2 requires this enforced "where `kid` is minted, not by convention", so
     * the assertion is that the construction THROWS, not that a reviewer would
     * have noticed.
     */
    @Test
    fun a_second_kid_under_one_session_key_is_refused() {
        session("kid-a2-first").use {
            try {
                E2eSession.forPhone(ctx, sk, pairContext, "kid-a2-second", freshEpoch = true)
                fail(
                    "A2 MUST (1): a second kid was minted under one SK — its counter " +
                        "restarts at 0 against the same key and prefix (nonce reuse)"
                )
            } catch (e: E2eSession.Companion.KidReuseException) {
                assertTrue(
                    "the refusal must name the kid already bound",
                    e.message!!.contains("kid-a2-first")
                )
            }
        }
    }

    /**
     * The same `kid` with the same `SK` is NOT a reuse — it is a resume, and
     * refusing it would break every reconnect. Guards against an enforcement
     * that is merely "throw on the second call".
     */
    @Test
    fun the_same_kid_under_the_same_session_key_is_allowed() {
        session("kid-a2-resume").use { it.seal("SMS_RECEIVED", byteArrayOf(1)) }
        E2eSession.forPhone(ctx, sk, pairContext, "kid-a2-resume", freshEpoch = false)
            .use { assertTrue("a resume must still seal", it.seal("SMS_RECEIVED", byteArrayOf(2)).seq > 0) }
    }

    private fun prefixOf(s: E2eSession): ByteArray = s.sendNoncePrefix
}
