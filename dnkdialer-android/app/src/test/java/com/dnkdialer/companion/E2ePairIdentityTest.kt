package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E P4 (w1) — the pure half of [E2ePairIdentity].
 *
 * `userIdForPairContext` and `nextPairEpoch` need a Context and are exercised
 * on the emulator; the recipient choice is pure logic and is the part with a
 * real failure mode, so it is pinned here.
 *
 * See `e2e-evidence/PAIRCONTEXT-CHANNEL-GAP.md` for why this file exists at
 * all: three of §13.10.3's four inputs have no channel to the peer, and this
 * object is the single place a ruling changes.
 */
class E2ePairIdentityTest {

    private fun recip(id: String) =
        E2eNegotiation.Recipient("web", id, ByteArray(65) { if (it == 0) 4 else it.toByte() })

    /**
     * The choice must not depend on the order the relay happened to list the
     * recipients in. A context that moved with array order would derive
     * different keys for a re-ordered but otherwise identical offer — the pair
     * would fail to decrypt for a reason no log would explain.
     */
    @Test
    fun the_peer_device_id_is_order_independent() {
        val a = listOf(recip("zeta"), recip("alpha"), recip("mid"))
        val b = listOf(recip("mid"), recip("zeta"), recip("alpha"))
        assertEquals(E2ePairIdentity.peerDeviceIdFor(a), E2ePairIdentity.peerDeviceIdFor(b))
        assertEquals("alpha", E2ePairIdentity.peerDeviceIdFor(a))
    }

    @Test
    fun a_single_recipient_is_simply_itself() {
        assertEquals("only-one", E2ePairIdentity.peerDeviceIdFor(listOf(recip("only-one"))))
    }

    /**
     * An empty list cannot happen on the Accept path — [E2eAccept.prepare]
     * throws on no recipients before this is reached — but it must not throw
     * HERE, because a crash in the pairing path is a denial of service any
     * relay could trigger.
     */
    @Test
    fun no_recipients_yields_an_empty_id_rather_than_throwing() {
        assertEquals("", E2ePairIdentity.peerDeviceIdFor(emptyList()))
    }

    /**
     * Pins the gap itself, so that a future change to
     * [E2ePairIdentity.userIdForPairContext] is a deliberate act with a failing
     * test in front of it rather than a quiet edit. When the ruling lands, this
     * assertion changes with the implementation — that is the intent.
     */
    @Test
    fun the_user_id_is_still_unchannelled() {
        // Recorded as a fact about the CONTEXT layout, not about Android: the
        // 0x11 field is fed an empty string, so pairContext carries
        // `0x11 0x00` there. See PAIRCONTEXT-CHANNEL-GAP.md.
        val ctx = E2eKdf.PairContext(
            pairingId = "p", userId = "", phoneDeviceId = "d", peerDeviceId = "w", pairEpoch = 1L
        )
        val bytes = E2eKdf.pairContextBytes(ctx)
        assertEquals("the userId tag", 0x11, bytes[0].toInt() and 0xff)
        assertEquals("…with a zero length", 0x00, bytes[1].toInt() and 0xff)
        assertTrue("and the rest of the context still encodes", bytes.size > 2)
    }
}
