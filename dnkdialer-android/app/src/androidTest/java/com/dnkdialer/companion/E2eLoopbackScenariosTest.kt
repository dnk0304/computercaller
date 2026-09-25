package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 (w5) — the scenario suite that replaces (g) **for the android side**.
 *
 * ## What these are, and what they are NOT
 *
 * These are **same-implementation loopbacks**. The "computer" is a Kotlin peer
 * built from the same `E2e*` classes the phone uses, running in the same
 * process. They prove the phone's own state machine: that negotiation refuses
 * what it must, that the chokepoint seals and opens across a real
 * Keystore-backed session, that a resume re-sends under the same `kid`, that a
 * RESET mints a new one, and that a thousand replayed frames cost nothing.
 *
 * They do **not** prove interoperability, and they cannot: a bug in the shared
 * understanding — a mis-framed AAD, a misread field — is invisible when both
 * halves make the same mistake. That is exactly why the frozen vectors exist
 * (A1 vector A, A2 E–H, A3 I, all computed independently by Security and
 * asserted elsewhere in this module), and why cross-implementation (g) belongs
 * to P2's node harness driving the `lib/e2e` modules against the relay, with real devices
 * repeating it at P6. Ken's ruling R-L assigns it there; P4 owns android only
 * and must not create a web worktree.
 *
 * No relay is involved here either. The relay is a byte carrier for these
 * frames — it forwards the `e2e` block verbatim and never inspects an envelope
 * — so putting one in the loop would add a hop without adding an assertion.
 */
@RunWith(AndroidJUnit4::class)
class E2eLoopbackScenariosTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairingId = "pair-loopback"
    private val peerDeviceId = "dev-web-loop"

    @Before
    fun clean() {
        E2eSeqStore.clearAll(ctx)
        E2eSession.clearKidBindingsForTest()
        seedAccountId()
    }

    /**
     * R-BH: give this device the account id a signed-in phone would have
     * learned from the authenticated devicekeys API, so that
     * [E2ePairIdentity.userIdForPairContext] answers from the PRODUCTION source
     * instead of these scenarios inventing one.
     *
     * TokenStore is persist-once, so a previous run's id would otherwise stick
     * and MISMATCH. Clearing first is what makes the suite order-independent.
     */
    private fun seedAccountId() {
        TokenStore.clear(ctx)
        TokenStore.putUserId(ctx, "acct-loopback")
    }

    // ------------------------------------------------------------- helpers

    private fun recipient(id: String = peerDeviceId): E2eNegotiation.Recipient {
        // A real, valid P-256 point: the peer's own device key.
        val peer = E2eKeyAgreement.mintEphemeral()
        return try {
            E2eNegotiation.Recipient("web", id, peer.publicSec1)
        } finally {
            peer.close()
        }
    }

    private fun offer(
        advertisement: E2eSettings.PeerAdvertisement,
        recipients: List<E2eNegotiation.Recipient> = listOf(recipient()),
    ) = E2eNegotiation.PeerOffer(
        advertisement = advertisement,
        recipients = if (advertisement == E2eSettings.PeerAdvertisement.ABSENT) {
            emptyList()
        } else {
            recipients
        },
        absentReason = if (advertisement == E2eSettings.PeerAdvertisement.ABSENT) {
            "peer offered nothing"
        } else {
            null
        },
    )

    /** A phone session plus the mirrored key material the "computer" holds. */
    private class Pair(
        val session: E2eSession,
        val sk: ByteArray,
        val pairContext: E2eKdf.PairContext,
    ) {
        val peerKeys get() = E2eKdf.deriveTrafficKeys(sk, pairContext)
        val peerPrefixes get() = E2eKdf.deriveNoncePrefixes(sk, pairContext)
    }

    private fun armed(epoch: Long, kid: String): Pair {
        val sk = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        val pc = E2eKdf.PairContext(
            pairingId = pairingId,
            // R-BH: the production source. Seeded in [seedAccountId] so this
            // loopback derives under the same channel a real Accept does,
            // rather than under a constant the production path no longer has.
            userId = requireNotNull(E2ePairIdentity.userIdForPairContext(ctx)) {
                "the account id must be seeded before a pair context can be built"
            },
            phoneDeviceId = E2eLifecycle.deviceId(ctx),
            peerDeviceId = peerDeviceId,
            pairEpoch = epoch,
        )
        return Pair(E2eSession.forPhone(ctx, sk, pc, kid, freshEpoch = true), sk, pc)
    }

    /** A gate over a fixed session, as PhoneClient would hold it. */
    private fun gateOver(p: Pair?) = E2eFrameGate({ p?.session }, { true })

    /** The computer sealing a c2p frame the phone must open. */
    private fun peerSeals(p: Pair, type: String, body: String, seq: Long) =
        E2eEnvelope.seal(
            key = p.peerKeys.computerToPhone,
            kid = p.session.kid,
            seq = seq,
            direction = E2eEnvelope.Direction.COMPUTER_TO_PHONE,
            pairEpoch = p.pairContext.pairEpoch,
            sessionPrefix = p.peerPrefixes.computerToPhone,
            frameType = type,
            plaintext = body.toByteArray(Charsets.UTF_8),
        ).toJson()

    // ------------------------------------------------- 1. ON/ON round trip

    @Test
    fun scenario_ON_ON_seals_and_the_peer_opens_it_and_back() {
        val decision = E2eNegotiation.decide(
            localEnabled = true, offer = offer(E2eSettings.PeerAdvertisement.ON)
        )
        assertTrue(decision is E2eNegotiation.Decision.Encrypted)
        assertTrue(
            "either side ON means effective ON and a BLOCKING SAS (the OR of §13.1)",
            (decision as E2eNegotiation.Decision.Encrypted).modeOn
        )

        val p = armed(epoch = 1L, kid = "kid-onon")
        val gate = gateOver(p)

        // phone -> computer
        val wire = gate.outbound("SMS_RECEIVED", "{\"body\":\"hello\"}")
        assertNotEquals("a sealed pair must not emit plaintext", "{\"body\":\"hello\"}", wire)
        assertTrue("the body must be a §13.7 envelope", E2eFrameGate.looksSealed(wire!!))

        val envelope = E2eEnvelope.parse(wire)
        val opened = E2eEnvelope.open(
            key = p.peerKeys.phoneToComputer,
            envelope = envelope,
            direction = E2eEnvelope.Direction.PHONE_TO_COMPUTER,
            pairEpoch = p.pairContext.pairEpoch,
            sessionPrefix = p.peerPrefixes.phoneToComputer,
            frameType = "SMS_RECEIVED",
        )
        assertEquals("{\"body\":\"hello\"}", String(opened!!, Charsets.UTF_8))

        // computer -> phone
        val inbound = gate.inbound("SEND_SMS", peerSeals(p, "SEND_SMS", "{\"to\":\"+47\"}", 0))
        assertEquals(
            "{\"to\":\"+47\"}",
            (inbound as E2eFrameGate.Inbound.Deliver).json
        )
        assertEquals("nothing legitimate may be dropped", 0, gate.droppedInbound)
    }

    // ------------------------------------------------------ 2. ON/OFF refuse

    @Test
    fun scenario_ON_OFF_is_refused_and_never_downgraded() {
        val latch = E2eNegotiation.DowngradeLatch()
        // The phone requires encryption; the peer advertises that it will not.
        val d = E2eNegotiation.decide(
            localEnabled = true,
            offer = offer(E2eSettings.PeerAdvertisement.ABSENT),
            latch = latch,
        )
        assertTrue("a mode-ON device must ABORT, never silently downgrade", d is E2eNegotiation.Decision.Abort)
        assertEquals(E2eNegotiation.ABORT_UPDATE_COMPUTER_MESSAGE, (d as E2eNegotiation.Decision.Abort).userMessage)
        assertTrue("the refusal must latch for the life of the pair", latch.isLatched)

        // The attrition attack: retry with a weaker offer, and even with the
        // user's own setting since turned OFF. The latch outranks both.
        val retry = E2eNegotiation.decide(
            localEnabled = false,
            offer = offer(E2eSettings.PeerAdvertisement.OFF),
            latch = latch,
        )
        assertTrue(
            "a peer that is told no and retries weaker must not walk the pair down",
            retry is E2eNegotiation.Decision.Abort
        )

        // A FULL offer is still accepted — the latch refuses downgrades, not
        // the pairing itself.
        assertTrue(
            E2eNegotiation.decide(false, offer(E2eSettings.PeerAdvertisement.ON), latch)
                is E2eNegotiation.Decision.Encrypted
        )
    }

    // ---------------------------------------------------- 3. OFF/OFF plain

    @Test
    fun scenario_OFF_OFF_stays_plaintext_and_byte_identical_to_v55() {
        val d = E2eNegotiation.decide(
            localEnabled = false, offer = offer(E2eSettings.PeerAdvertisement.ABSENT)
        )
        assertTrue(d is E2eNegotiation.Decision.Plaintext)

        // No session, no latch — the gate must be a pass-through, and the frame
        // must be exactly the bytes v55 would have sent.
        val gate = E2eFrameGate({ null }, { false })
        val body = "{\"body\":\"hello\"}"
        assertEquals(body, gate.outbound("SMS_RECEIVED", body))
        assertEquals(0, gate.droppedOutbound)
        assertEquals(
            body,
            (gate.inbound("SEND_SMS", body) as E2eFrameGate.Inbound.Deliver).json
        )
    }

    // ------------------------------------------------ 4. resume, same kid

    /**
     * A resume keeps the pair, so it keeps the `kid` and the key. What it must
     * NOT do is restart the counter — §13.8 and A2's sole control.
     */
    @Test
    fun scenario_resume_re_sends_under_the_same_kid_without_reusing_a_sequence() {
        val p = armed(epoch = 1L, kid = "kid-resume")
        val gate = gateOver(p)
        val before = (0 until 5).map { E2eEnvelope.parse(gate.outbound("SMS_RECEIVED", "{\"i\":$it}")!!).seq }

        // "Reconnect": a NEW session object over the same kid and key, exactly
        // as the next process start would build it.
        val resumed = E2eSession.forPhone(
            ctx, p.sk, p.pairContext, p.session.kid, freshEpoch = false
        )
        assertEquals("the kid must not move across a resume", p.session.kid, resumed.kid)

        val gate2 = E2eFrameGate({ resumed }, { true })
        val after = (0 until 5).map { E2eEnvelope.parse(gate2.outbound("SMS_RECEIVED", "{\"i\":$it}")!!).seq }

        assertTrue(
            "a resumed session re-issued a sequence — that is a GCM nonce reuse",
            after.none { it in before }
        )
        assertTrue("and it must resume strictly forward", after.min() > before.max())
        resumed.close()
    }

    // --------------------------------------------- 5. RESET mid-epoch, new kid

    @Test
    fun scenario_reset_mid_epoch_mints_a_new_kid_and_the_old_frames_die_with_it() {
        val first = armed(epoch = 1L, kid = "kid-epoch-1")
        val staleFrame = peerSeals(first, "SEND_SMS", "{\"stale\":true}", 0)

        // RESET: the SK is dropped (§13.8) and the next Accept mints a new kid
        // under a new epoch.
        E2eLifecycle.onPairEnded(first.session)
        val second = armed(epoch = 2L, kid = "kid-epoch-2")

        assertNotEquals(first.session.kid, second.session.kid)
        assertNotEquals(
            "a new epoch must move the traffic key",
            E2eKdf.toHex(first.peerKeys.phoneToComputer),
            E2eKdf.toHex(second.peerKeys.phoneToComputer)
        )

        // A frame from the previous epoch must not open under the new session.
        val gate = gateOver(second)
        val verdict = gate.inbound("SEND_SMS", staleFrame)
        assertTrue(
            "a frame from the pre-RESET epoch was accepted after the rekey",
            verdict is E2eFrameGate.Inbound.Drop
        )
    }

    // ------------------------------------------ 6. 1,000-frame replay, 0 drops

    /**
     * §13.5: a resume legitimately re-sends buffered frames, so the replay must
     * cost nothing. "Zero legitimate drops" is the assertion — every first
     * delivery lands, and every re-delivery is a DUPLICATE, which is a distinct
     * verdict from Undecryptable precisely so this can be told apart from
     * frames being lost.
     */
    @Test
    fun scenario_one_thousand_buffered_frames_replay_with_zero_legitimate_drops() {
        val p = armed(epoch = 1L, kid = "kid-replay")
        val gate = gateOver(p)

        val n = 1_000
        val frames = (0 until n).map { peerSeals(p, "SEND_SMS", "{\"i\":$it}", it.toLong()) }

        val delivered = frames.count { gate.inbound("SEND_SMS", it) is E2eFrameGate.Inbound.Deliver }
        assertEquals("every buffered frame must be delivered exactly once", n, delivered)
        assertEquals("no legitimate frame may be dropped", 0, gate.droppedInbound)

        // Now replay the whole buffer, as a resume does.
        val verdicts = frames.map { gate.inbound("SEND_SMS", it) }
        assertTrue(
            "a replayed frame must be a DUPLICATE, never delivered twice",
            verdicts.none { it is E2eFrameGate.Inbound.Deliver }
        )
        assertEquals(
            "a replay must not register as an undecryptable failure — that would " +
                "trip §13.5's 3-in-10s re-pair request on a perfectly healthy resume",
            0, gate.droppedInbound
        )
        assertFalse("and must never ask for a re-pair", gate.repairRequested)
    }

    // ------------------------------------------------------- the latch, live

    /**
     * The one case the scenarios above cannot show, because they all have a
     * healthy session: an encrypted pair whose session has gone must DROP a
     * §13.7 frame rather than emit it in the clear.
     */
    @Test
    fun a_torn_down_session_under_the_latch_drops_rather_than_downgrades() {
        var session: E2eSession? = armed(epoch = 1L, kid = "kid-torn").session
        val gate = E2eFrameGate({ session }, { true })
        assertTrue(E2eFrameGate.looksSealed(gate.outbound("SMS_RECEIVED", "{\"a\":1}")!!))

        session = null // §13.8 teardown, latch still on
        assertNull(
            "content went out in the CLEAR on a pair the user was told is encrypted",
            gate.outbound("SMS_RECEIVED", "{\"a\":1}")
        )
        assertEquals(1, gate.droppedOutbound)

        // Control frames still flow — the pairing must be able to recover.
        assertEquals("{}", gate.outbound("PING", "{}"))
    }
}
