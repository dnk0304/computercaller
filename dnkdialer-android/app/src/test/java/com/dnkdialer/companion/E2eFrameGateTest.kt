package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E P4 (w3) — the routing half of the chokepoint, on the JVM.
 *
 * The crypto half needs a Keystore-backed [E2eSession] and is exercised on the
 * emulator in (w5). What is testable here is the part most likely to be got
 * wrong quietly: which frames are sealed, which are mandatorily plaintext, and
 * what happens to a §13.7 frame that cannot be sealed.
 */
class E2eFrameGateTest {

    /** A gate with no session. [latched] is what the tests vary. */
    private fun gate(latched: Boolean) = E2eFrameGate({ null }, { latched })

    // ------------------------------------------------------- the §13.7 list

    /**
     * §13.7 is explicit that these three stay plaintext: `gateBrowserSyncFrame`
     * clamps `since` and drops `GET_CONTACTS` below Plus, so sealing them would
     * move billing enforcement to the client, which is the same as deleting it.
     *
     * Asserted as its own test rather than left implicit in "not on the sealed
     * list", so that adding one of them to [E2eFrameGate.SEALED_TYPES] fails
     * here instead of silently turning off tier enforcement.
     */
    @Test
    fun the_mandatory_plaintext_frames_are_never_sealed() {
        for (t in E2eFrameGate.MANDATORY_PLAINTEXT) {
            assertFalse("$t must never be sealed", E2eFrameGate.isSealedType(t))
            assertEquals(
                "$t must pass through untouched even under the latch",
                "{\"since\":1}", gate(latched = true).outbound(t, "{\"since\":1}")
            )
        }
        assertTrue(
            "the trio must be exactly §13.7's",
            E2eFrameGate.MANDATORY_PLAINTEXT ==
                setOf("GET_MESSAGES", "GET_CALL_LOGS", "GET_CONTACTS")
        )
    }

    @Test
    fun the_content_frames_are_on_the_sealed_list() {
        for (t in listOf(
            "PHONE_NOTIFICATION", "SMS_RECEIVED", "MESSAGES_CHUNK", "CONTACTS_CHUNK",
            "CALL_LOGS_CHUNK", "CALL_LOG_ENTRY", "CALL_INCOMING", "SIM_LIST",
            "SMS_SEND_STATUS", "SYNC_ESTIMATE", "NOTIFICATION_REMOVED",
        )) {
            assertTrue("$t is content and must be sealed", E2eFrameGate.isSealedType(t))
        }
    }

    /**
     * Pairing, lobby, presence and heartbeat frames must stay clear — the
     * pairing handshake is how a session comes to exist, so sealing it would
     * require the key it negotiates.
     */
    @Test
    fun control_frames_stay_plaintext() {
        for (t in listOf(
            "PAIRING_REQUEST", "ACCEPT_PAIRING", "DECLINE_PAIRING", "PAIRING_ACTIVE",
            "PAIRING_TERMINATED", "LEAVE_ACTIVE", "DEVICE_INFO", "PING", "PONG",
            "APP_PING", "APP_PONG", "HELLO", "BROWSER_STATUS", "AUDIO_STATUS",
        )) {
            assertFalse("$t must not be sealed", E2eFrameGate.isSealedType(t))
            assertEquals("{}", gate(latched = true).outbound(t, "{}"))
        }
    }

    // ---------------------------------------------------------- the latch

    /**
     * The load-bearing behaviour of the whole letter. With the latch on and no
     * usable session, a §13.7 frame is DROPPED. The user has been told this
     * pair is encrypted; a silent plaintext fallback on the one frame that
     * failed is worse than losing it, because nothing on either side would show
     * that it happened.
     */
    @Test
    fun a_sealed_frame_with_no_session_is_dropped_not_downgraded() {
        val g = gate(latched = true)
        assertNull(
            "a content frame went out in the CLEAR on an encrypted pair",
            g.outbound("SMS_RECEIVED", "{\"body\":\"secret\"}")
        )
        assertEquals(1, g.droppedOutbound)
    }

    /** Before any Accept there is no latch, so the pair is simply in the clear. */
    @Test
    fun an_unlatched_pair_sends_content_in_the_clear() {
        val g = gate(latched = false)
        assertEquals("{\"body\":\"hi\"}", g.outbound("SMS_RECEIVED", "{\"body\":\"hi\"}"))
        assertEquals(0, g.droppedOutbound)
    }

    /**
     * The inbound mirror: a stripping relay that forwards a content frame in
     * the clear on an encrypted pair must not be believed.
     */
    @Test
    fun inbound_plaintext_under_the_latch_is_dropped() {
        val g = gate(latched = true)
        val v = g.inbound("SEND_SMS", "{\"to\":\"+47\"}")
        assertTrue("a stripped frame was accepted", v is E2eFrameGate.Inbound.Drop)
        assertEquals(1, g.droppedInbound)

        // …while a control frame in the clear is normal and must pass.
        assertTrue(
            g.inbound("PAIRING_ACTIVE", "{\"ua\":\"x\"}") is E2eFrameGate.Inbound.Deliver
        )
    }

    @Test
    fun inbound_passes_through_when_the_pair_is_in_the_clear() {
        val g = gate(latched = false)
        val v = g.inbound("SEND_SMS", "{\"to\":\"+47\"}")
        assertEquals(
            "{\"to\":\"+47\"}", (v as E2eFrameGate.Inbound.Deliver).json
        )
    }

    /** A sealed frame arriving with no session is dropped, never guessed at. */
    @Test
    fun a_sealed_frame_with_no_session_is_dropped_inbound() {
        val g = gate(latched = true)
        val envelope = "{\"e\":1,\"kid\":\"k\",\"s\":0,\"c\":\"AAAA\"}"
        assertTrue(g.inbound("SEND_SMS", envelope) is E2eFrameGate.Inbound.Drop)
    }

    // ------------------------------------------------------ envelope sniff

    @Test
    fun an_envelope_is_recognised_and_a_payload_is_not() {
        assertTrue(E2eFrameGate.looksSealed("{\"e\":1,\"kid\":\"k\",\"s\":0,\"c\":\"AA\"}"))
        assertTrue(
            "leading whitespace must not defeat the sniff",
            E2eFrameGate.looksSealed("  {\"e\":1,\"kid\":\"k\",\"s\":0,\"c\":\"AA\"}")
        )
        assertFalse(E2eFrameGate.looksSealed("{\"body\":\"hello\"}"))
        assertFalse(E2eFrameGate.looksSealed(""))
        // A payload with an "e" field but no envelope shape is NOT an envelope.
        assertFalse(E2eFrameGate.looksSealed("{\"e\":\"east\"}"))
    }

    /**
     * A chunked frame carries its own `_CHUNK` type, and §13.4 exempts that
     * suffix from padding — but NOT from sealing. Both halves of the pair must
     * be on the list or a chunked sync leaks in the clear while its opener
     * does not.
     */
    @Test
    fun both_the_chunk_type_and_its_base_are_sealed() {
        for (base in listOf("MESSAGES", "CONTACTS", "CALL_LOGS")) {
            assertTrue(base, E2eFrameGate.isSealedType(base))
            assertTrue("${base}_CHUNK", E2eFrameGate.isSealedType("${base}_CHUNK"))
        }
    }
}
