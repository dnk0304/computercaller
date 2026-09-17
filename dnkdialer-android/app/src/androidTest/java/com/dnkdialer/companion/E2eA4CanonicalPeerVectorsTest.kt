package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 (a3) — **GATE1 Addendum A4's vector J**, the canonical peer.
 *
 * A4-R1/R2 ratify what P4 already emitted but had not frozen: there is ONE
 * `ctx`, ONE `pairContext` and ONE traffic-key set per pairing, and
 * `ctx.peerDeviceId` is the **byte-wise lexicographically lowest** of
 * `wraps[].deviceId` compared as **raw UTF-8 bytes**. Per-recipient separation
 * lives in the KEK, which binds each recipient's own static key on top of the
 * shared context — not in the traffic keys.
 *
 * A4 assigns P4 the ENCODE half of J: it builds `wraps[]` and picks the peer.
 * P2 asserts the decode half with the full set, P3 the `PAIR_STATE` path
 * without it.
 *
 * The values are transcribed from `GATE1-ADDENDUM-A4.md`, computed by Security
 * in a clean-room implementation importing nothing from `lib/e2e`. J.1 and J.3
 * were also re-derived here in python before being committed, as with A2 and
 * A3. They are asserted inline until P1.2 lands J in the canonical
 * `tests/kdf-vectors.json`, at which point this class re-points the way (c4)
 * re-pointed the A2/A3 suites.
 */
@RunWith(AndroidJUnit4::class)
class E2eA4CanonicalPeerVectorsTest {

    // A3/A4 shared fixtures.
    private val sk = E2eKdf.fromHex(
        "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
    )
    private val pairingId = "pair-7f3a9c21"
    private val userId = "user-0191aa"
    private val phoneDeviceId = "dev-phone-01"

    /** Deliberately ordered so the canonical lowest is NOT first. */
    private val wrapDeviceIds = listOf("dev-web-01", "dev-ext-02")

    private fun contextWith(peer: String) = E2eKdf.PairContext(
        pairingId = pairingId,
        userId = userId,
        phoneDeviceId = phoneDeviceId,
        peerDeviceId = peer,
        pairEpoch = 42L,
    )

    private fun recipients(ids: List<String>) = ids.map {
        val e = E2eKeyAgreement.mintEphemeral()
        try {
            E2eNegotiation.Recipient("web", it, e.publicSec1)
        } finally {
            e.close()
        }
    }

    // ------------------------------------------------------------- J.1

    /**
     * The selection itself, through the ENCODE path A4-M2 names — and with a
     * set whose lowest is not first in array order, which is the only way this
     * can fail on a wrong implementation.
     */
    @Test
    fun vector_J1_the_canonical_peer_is_the_byte_wise_lowest() {
        assertEquals("dev-ext-02", E2ePairIdentity.canonicalPeerDeviceId(wrapDeviceIds))
        assertEquals(
            "the Recipient overload must agree with the raw-id one",
            "dev-ext-02", E2ePairIdentity.peerDeviceIdFor(recipients(wrapDeviceIds))
        )
        // Order-independence: a re-ordered but otherwise identical offer must
        // derive the same keys, so the same peer must come out.
        assertEquals(
            "dev-ext-02", E2ePairIdentity.canonicalPeerDeviceId(wrapDeviceIds.reversed())
        )
    }

    @Test
    fun vector_J1_one_context_and_one_key_set_for_the_whole_pairing() {
        val ctx = contextWith(E2ePairIdentity.canonicalPeerDeviceId(wrapDeviceIds))

        assertEquals(
            "110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d657874" +
                "2d303214000000000000002a",
            E2eKdf.toHex(E2eKdf.pairContextBytes(ctx))
        )

        val keys = E2eKdf.deriveTrafficKeys(sk, ctx)
        assertEquals(
            "01de194d76408bb67774e73b673a4153b4bfcda2eff1b183ddb4a13a60e6e0f9",
            E2eKdf.toHex(keys.phoneToComputer)
        )
        assertEquals(
            "84217963288dbd103a6720a5f94c4e7403e02bebd21212d6ba64a2fe364b3021",
            E2eKdf.toHex(keys.computerToPhone)
        )

        val p = E2eKdf.deriveNoncePrefixes(sk, ctx)
        assertEquals("bb33f7f1", E2eKdf.toHex(p.phoneToComputer))
        assertEquals("17d7abbc", E2eKdf.toHex(p.computerToPhone))

        // And the ctx the phone would actually emit carries that peer.
        assertEquals("dev-ext-02", E2ePairIdentity.ctxBlockFor(ctx).get("peerDeviceId").asString)
    }

    // ------------------------------------------------------------- J.3

    /**
     * Relay steering: the same pairing with `peerDeviceId` forced to the
     * non-canonical `dev-web-01`. A receiver holding `wraps[]` must refuse
     * BEFORE deriving.
     *
     * The cross-check A4 asks to keep: that steered context's `k_p2c` is
     * byte-identical to A3 vector I.1's frozen `traffic.phoneToComputerKeyHex`.
     * That is the single-recipient invariance proof — a one-recipient pairing's
     * canonical peer IS that recipient, so A4 rekeys nothing already shipped.
     */
    @Test
    fun vector_J3_steering_to_a_non_canonical_peer_is_refused_and_pins_invariance() {
        val steered = contextWith("dev-web-01")
        assertEquals(
            "110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762d776562" +
                "2d303114000000000000002a",
            E2eKdf.toHex(E2eKdf.pairContextBytes(steered))
        )
        val steeredKey = E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, steered).phoneToComputer)
        assertEquals(
            "A4's invariance cross-check: this must be A3 vector I.1's frozen " +
                "phoneToComputerKeyHex, or the single-recipient path moved under A4",
            "b12f964e487f7bf39a0b37df9715ca9e606c642c28bdf430f51b2051a4e0e060",
            steeredKey
        )
        assertNotEquals(
            "and it must differ from J.1 — otherwise steering would be harmless and " +
                "the refusal pointless",
            E2eKdf.toHex(
                E2eKdf.deriveTrafficKeys(sk, contextWith("dev-ext-02")).phoneToComputer
            ),
            steeredKey
        )

        // The decoder half: with the set in hand, refuse before deriving.
        val wire = E2ePairIdentity.ctxBlockFor(steered)
        try {
            E2ePairIdentity.contextFromWire(
                wire, userId, expectedPairingId = pairingId,
                recipientDeviceIds = wrapDeviceIds
            )
            fail("A4-M1: a ctx steered to a non-canonical peer must be REFUSED")
        } catch (e: E2ePairIdentity.CtxException) {
            assertTrue(e.message!!.contains("canonical"))
        }

        // …and the canonical one is accepted, so the check is not simply "throw".
        E2ePairIdentity.contextFromWire(
            E2ePairIdentity.ctxBlockFor(contextWith("dev-ext-02")), userId,
            expectedPairingId = pairingId, recipientDeviceIds = wrapDeviceIds
        )
    }

    /**
     * A4-M1's other half, and the reason A3-M3's old clause had to be DELETED
     * rather than relaxed: a receiver that does not hold `wraps[]` — the
     * extension SW, whose PAIR_STATE carries only its own wrap — must perform
     * NO peer check at all. It must not substitute its own deviceId, which
     * would refuse every recipient except the canonical one and make
     * multi-recipient pairing impossible.
     */
    @Test
    fun a_receiver_without_the_device_id_set_performs_no_peer_check() {
        val canonical = E2ePairIdentity.ctxBlockFor(contextWith("dev-ext-02"))
        // dev-web-01's SW would hold no set; it must still derive successfully
        // from a ctx naming dev-ext-02 as the canonical peer.
        val ctx = E2ePairIdentity.contextFromWire(
            canonical, userId, expectedPairingId = pairingId, recipientDeviceIds = null
        )
        assertEquals("dev-ext-02", ctx.peerDeviceId)
        assertEquals(
            "01de194d76408bb67774e73b673a4153b4bfcda2eff1b183ddb4a13a60e6e0f9",
            E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, ctx).phoneToComputer)
        )
    }

    // -------------------------------------------- the bug A4 actually caught

    /**
     * **The pinning case.** J's own ids are pure ASCII, where UTF-16 and UTF-8
     * ordering agree — so J.1 alone would pass against the `minOrNull()` this
     * letter replaces, and the fix would be unpinned. A4's own J.5 makes the
     * same argument about its regression assertion.
     *
     * `U+FFFD` vs `U+10000` is where the two orderings disagree, and they
     * disagree in OPPOSITE directions:
     *
     * ```
     *   UTF-8   efbfbd   <  f0908080     -> U+FFFD  is lowest   (correct)
     *   UTF-16  d800dc00 <  fffd         -> U+10000 is lowest   (minOrNull)
     * ```
     *
     * A supplementary character is a surrogate pair starting 0xD800 in UTF-16
     * but 0xF0 in UTF-8, while U+E000..U+FFFF sit above 0xD800 in UTF-16 and
     * below 0xF0 in UTF-8. Two sides picking different canonical peers derive
     * different traffic keys, and every frame fails to authenticate for a
     * reason no log explains.
     */
    @Test
    fun the_ordering_is_utf8_bytes_and_not_utf16_code_units() {
        val replacement = "id-�"          // efbfbd
        val supplementary = "id-𐀀"  // f0908080, U+10000

        assertEquals(
            "efbfbd", E2eKdf.toHex(replacement.substring(3).toByteArray(Charsets.UTF_8))
        )
        assertEquals(
            "f0908080", E2eKdf.toHex(supplementary.substring(3).toByteArray(Charsets.UTF_8))
        )

        val ids = listOf(supplementary, replacement)
        assertEquals(
            "A4-R2 is byte-wise UTF-8: U+FFFD (efbfbd) is lower than U+10000 (f0908080)",
            replacement, E2ePairIdentity.canonicalPeerDeviceId(ids)
        )
        assertNotEquals(
            "Kotlin's String.minOrNull() compares UTF-16 code units and picks the OTHER " +
                "one here — that is the bug this letter fixes, and this assertion is what " +
                "keeps it fixed",
            ids.minOrNull(), E2ePairIdentity.canonicalPeerDeviceId(ids)
        )
        assertEquals("the premise: minOrNull really does disagree", supplementary, ids.minOrNull())
    }

    /**
     * `Byte` is signed in Kotlin, so a comparator written as `a[i] - b[i]`
     * orders every byte >= 0x80 BELOW ASCII — the same class of bug as UTF-16
     * ordering, reached by a different route. Any non-ASCII id must therefore
     * sort ABOVE a pure-ASCII one.
     */
    @Test
    fun the_byte_comparison_is_unsigned() {
        assertEquals(
            "dev-a", E2ePairIdentity.canonicalPeerDeviceId(listOf("dev-ÿ", "dev-a"))
        )
        assertEquals(
            "a prefix must sort below its own extension",
            "dev", E2ePairIdentity.canonicalPeerDeviceId(listOf("dev-x", "dev"))
        )
    }
}
