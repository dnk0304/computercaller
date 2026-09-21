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
     * The ruling landed (R-BH). This is what changed and, just as importantly,
     * what did NOT.
     *
     * The LAYOUT is untouched: field 0x11 is still `u8(len) ‖ userId`, and the
     * frozen vectors A–M still reproduce byte-for-byte, because the gap was
     * never in the encoding — it was in what the production path fed the
     * encoder. The old `the_user_id_is_still_unchannelled` case pinned that
     * gap so a change to it would be deliberate; this is the deliberate
     * change, and it pins the replacement property instead.
     *
     * The refusal itself needs a real [android.content.Context] (TokenStore is
     * Keystore-backed), so it is asserted in E2ePairContextParityTest, which
     * also proves the production path reproduces the frozen `/context` vector.
     */
    @Test
    fun the_user_id_field_is_length_prefixed_and_carries_a_real_account_id() {
        val ctx = E2eKdf.PairContext(
            pairingId = "p", userId = "user-0191aa",
            phoneDeviceId = "d", peerDeviceId = "w", pairEpoch = 1L
        )
        val bytes = E2eKdf.pairContextBytes(ctx)
        assertEquals("the userId tag", 0x11, bytes[0].toInt() and 0xff)
        assertEquals("…with the id's UTF-8 length", 11, bytes[1].toInt() and 0xff)
        assertEquals(
            "…and the id itself",
            "user-0191aa",
            String(bytes, 2, 11, Charsets.UTF_8),
        )
        assertTrue("and the rest of the context still encodes", bytes.size > 13)
    }

    /**
     * The encoding a zero-length id WOULD produce, kept as the negative half:
     * `0x11 0x00`, which is a context the page's frozen `lib/e2e/kdf.mjs`
     * refuses outright (`userId may not be empty`). This is the state the phone
     * shipped in for the whole of P4–P6.1b, and no wrap it sealed could open.
     * It is recorded here so the two encodings are visibly different — the
     * reason the fix had to be a channel and not a cast.
     */
    @Test
    fun an_empty_account_id_encodes_to_a_context_the_page_cannot_represent() {
        val empty = E2eKdf.pairContextBytes(
            E2eKdf.PairContext("p", "", "d", "w", 1L)
        )
        val real = E2eKdf.pairContextBytes(
            E2eKdf.PairContext("p", "user-0191aa", "d", "w", 1L)
        )
        assertEquals("the empty id is a zero-length field", 0x00, empty[1].toInt() and 0xff)
        assertTrue(
            "the two contexts must differ — that difference is A6-P61B-8",
            !empty.contentEquals(real),
        )
    }
}
