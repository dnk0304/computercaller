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

    // ------------------------------------------- vector K (COUNTERSIGNED)

    /*
     * Vector K, Security-countersigned 2026-09-17T19:07:20Z, verifier
     * a4-vector-k-verify.mjs (imports nothing from lib/e2e). Fixtures are J's,
     * unchanged — only wraps[].deviceId differs, so K isolates the
     * canonical-order rule.
     *
     * TWO vectors, both mandatory, because ONE CANNOT PIN BOTH BUGS. The two
     * divergences have mutually exclusive preconditions at the first differing
     * byte:
     *
     *   signed-vs-unsigned diverges only when it is ASCII vs non-ASCII;
     *   UTF-16-vs-code-point diverges only when the first differing CHARACTER
     *   is BMP >= U+E000 vs supplementary — and both of THOSE lead bytes are
     *   non-ASCII (EE/EF vs F0-F4), so signed and unsigned agree there.
     *
     * Measured here, not assumed:
     *   K1  0xEF vs 0xF0 (signed -17 vs -16): unsigned A, signed A, UTF-16 B
     *       -> catches UTF-16 only. A signed-Byte implementation PASSES K1.
     *   K2  0x7A vs 0xF0 (signed 122 vs -16): unsigned A, signed B, UTF-16 A
     *       -> catches signed only.
     *
     * My own first pinning attempt used K1's pair alone and would therefore
     * have left the signed-byte half unpinned. Security caught that.
     *
     * Also binding, correcting the premise that reached me: U+FFFD sorts BELOW
     * U+10000 under unsigned UTF-8 (0xEF < 0xF0) — unsigned UTF-8 byte order
     * IS Unicode code-point order. It is UTF-16 that inverts it.
     */

    /** `6465762defbfbd2d3031` */
    private val idFffd = "dev-�-01"

    /** `6465762df09080802d3031`, U+10000 as a surrogate pair. */
    private val idSupp = "dev-𐀀-01"

    /** `6465762d7a2d3031` */
    private val idZ = "dev-z-01"

    /** Both negatives land on id B — the context a wrong comparator picks. */
    private val negativeKp2c =
        "4270886523cebaf18986ac82a8ed7197e3e5ecb5adce9a436d1c981bd8cb797d"

    private fun assertKeys(
        peer: String,
        ctxHex: String,
        p2c: String,
        c2p: String,
        np: String,
        nc: String,
    ) {
        val ctx = contextWith(peer)
        assertEquals("contextBytes", ctxHex, E2eKdf.toHex(E2eKdf.pairContextBytes(ctx)))
        val k = E2eKdf.deriveTrafficKeys(sk, ctx)
        assertEquals("k_p2c", p2c, E2eKdf.toHex(k.phoneToComputer))
        assertEquals("k_c2p", c2p, E2eKdf.toHex(k.computerToPhone))
        val n = E2eKdf.deriveNoncePrefixes(sk, ctx)
        assertEquals("np2c", np, E2eKdf.toHex(n.phoneToComputer))
        assertEquals("nc2p", nc, E2eKdf.toHex(n.computerToPhone))
    }

    /**
     * K1 — catches UTF-16 code-unit order (Kotlin `String.minOrNull`, JS `<`).
     * Vacuous against the signed-byte bug; that is K2's job.
     */
    @Test
    fun vector_K1_utf16_code_unit_order_is_not_used() {
        assertEquals("6465762defbfbd2d3031", E2eKdf.toHex(idFffd.toByteArray(Charsets.UTF_8)))
        assertEquals("6465762df09080802d3031", E2eKdf.toHex(idSupp.toByteArray(Charsets.UTF_8)))

        for (order in listOf(listOf(idFffd, idSupp), listOf(idSupp, idFffd))) {
            assertEquals(
                "canonical must be order-independent and must be the U+FFFD id",
                idFffd, E2ePairIdentity.canonicalPeerDeviceId(order)
            )
        }
        assertKeys(
            idFffd,
            "110b757365722d303139316161120c6465762d70686f6e652d3031130a6465762defbfbd2d" +
                "303114000000000000002a",
            "b165af0da430efc2434848b1ca7d677e86374d38d0e73a83fa17c28ab69125f7",
            "de6e80ee1e2fff3c719fdf71d6b18a8ff528fc2729ed7abd2da39dfee8896625",
            "20cc1730", "cfc3334b"
        )

        // K1.2 negative: UTF-16 order picks id B and a DIFFERENT key set.
        assertEquals(
            "the premise — Kotlin's own String order really does disagree here",
            idSupp, listOf(idFffd, idSupp).minOrNull()
        )
        assertNotEquals(idSupp, E2ePairIdentity.canonicalPeerDeviceId(listOf(idFffd, idSupp)))
        assertEquals(
            negativeKp2c,
            E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, contextWith(idSupp)).phoneToComputer)
        )
    }

    /**
     * K2 — catches SIGNED byte comparison: ASCII vs non-ASCII at the first
     * differing byte (0x7A vs 0xF0), the only shape where signed and unsigned
     * diverge. Vacuous against the UTF-16 bug.
     */
    @Test
    fun vector_K2_the_byte_comparison_is_unsigned() {
        assertEquals("6465762d7a2d3031", E2eKdf.toHex(idZ.toByteArray(Charsets.UTF_8)))

        for (order in listOf(listOf(idZ, idSupp), listOf(idSupp, idZ))) {
            assertEquals(
                "0x7A < 0xF0 UNSIGNED; a signed Byte compare makes 0xF0 = -16 the lower " +
                    "and picks the other id",
                idZ, E2ePairIdentity.canonicalPeerDeviceId(order)
            )
        }
        assertKeys(
            idZ,
            "110b757365722d303139316161120c6465762d70686f6e652d303113086465762d7a2d" +
                "303114000000000000002a",
            "f73869c32db8cabde77474e244e27eb226fb2854ca1e836af4aae4ad6cb9366f",
            "da329d3d68736a28bd292a7cbcdfa64ddca96faf169fac133d7633fbb7e98c7b",
            "704de086", "b9739822"
        )

        // K2.3 negative: signed order picks id B — and UTF-16 order would NOT,
        // which is exactly why K1 cannot stand in for this vector.
        assertEquals(
            "K2 is vacuous for the UTF-16 bug: String order agrees with the right answer",
            idZ, listOf(idZ, idSupp).minOrNull()
        )
        assertEquals(
            negativeKp2c,
            E2eKdf.toHex(E2eKdf.deriveTrafficKeys(sk, contextWith(idSupp)).phoneToComputer)
        )
    }

    @Test
    fun a_prefix_sorts_below_its_own_extension() {
        assertEquals("dev", E2ePairIdentity.canonicalPeerDeviceId(listOf("dev-x", "dev")))
    }
}
