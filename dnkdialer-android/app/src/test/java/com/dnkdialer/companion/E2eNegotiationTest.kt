package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E P4 Part 2 (d) — negotiation, local enforcement at Accept, downgrade latch.
 *
 * Every wire shape here is taken from P1's merged server.js (`96042d0`), not
 * from the spec prose.
 */
class E2eNegotiationTest {

    private fun validPub(): ByteArray {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toSec1(g.generateKeyPair().public)
    }

    private fun b64(b: ByteArray) = E2eKeyEncoding.toBase64Url(b)

    private fun offerJson(
        v: Int? = 1,
        mode: Int? = 1,
        recips: List<Triple<String, String, String>>? = null,
    ): JsonObject {
        val o = JsonObject()
        if (v != null) o.addProperty("v", v)
        if (mode != null) o.addProperty("mode", mode)
        val arr = com.google.gson.JsonArray()
        val list = recips ?: listOf(
            Triple("web", "dev-web", b64(validPub())),
            Triple("extension", "dev-sw", b64(validPub())),
        )
        for ((kind, id, pub) in list) {
            val r = JsonObject()
            r.addProperty("kind", kind)
            r.addProperty("deviceId", id)
            r.addProperty("pub", pub)
            arr.add(r)
        }
        o.add("recips", arr)
        return o
    }

    // ------------------------------------------------------------ parsing

    @Test
    fun `a well formed block parses to ON with both recipients`() {
        val offer = E2eNegotiation.parsePeerOffer(offerJson())
        assertEquals(E2eSettings.PeerAdvertisement.ON, offer.advertisement)
        assertEquals(2, offer.recipients.size)
        assertEquals(setOf("web", "extension"), offer.recipients.map { it.kind }.toSet())
        assertNull(offer.absentReason)
        offer.recipients.forEach { E2eKeyEncoding.validate(it.publicKey) }
    }

    @Test
    fun `mode 0 parses to OFF not ABSENT`() {
        val offer = E2eNegotiation.parsePeerOffer(offerJson(mode = 0))
        assertEquals(
            "a capable peer that chose not to is OFF; collapsing it to ABSENT " +
                "would downgrade a mode-ON user (matrix rows 3 vs 5)",
            E2eSettings.PeerAdvertisement.OFF,
            offer.advertisement
        )
        assertEquals(2, offer.recipients.size)
    }

    /**
     * P1 drops a block with no `v` to plaintext. If the phone accepted one, the
     * two sides would disagree about whether the pairing is encrypted.
     */
    @Test
    fun `a block without v or with a future v is ABSENT`() {
        for (bad in listOf(offerJson(v = null), offerJson(v = 2), offerJson(v = 0))) {
            val offer = E2eNegotiation.parsePeerOffer(bad)
            assertEquals(E2eSettings.PeerAdvertisement.ABSENT, offer.advertisement)
            assertTrue(offer.absentReason!!, offer.absentReason!!.contains("v"))
        }
    }

    @Test
    fun `every malformed shape degrades to ABSENT and never throws`() {
        val cases = mapOf(
            "null block" to null,
            "no mode" to offerJson(mode = null),
            "mode 7" to offerJson(mode = 7),
            "no recips" to offerJson(recips = emptyList()),
            "unknown kind" to offerJson(recips = listOf(Triple("toaster", "d", b64(validPub())))),
            "phone as recipient" to offerJson(recips = listOf(Triple("phone", "d", b64(validPub())))),
            "bad base64" to offerJson(recips = listOf(Triple("web", "d", "!!!not base64!!!"))),
            "off-curve pub" to offerJson(
                recips = listOf(Triple("web", "d", b64(ByteArray(65).also { it[0] = 0x04 })))
            ),
            "SPKI-length pub" to offerJson(
                recips = listOf(Triple("web", "d", b64(ByteArray(91))))
            ),
            "duplicate deviceId" to offerJson(
                recips = listOf(
                    Triple("web", "same", b64(validPub())),
                    Triple("extension", "same", b64(validPub())),
                )
            ),
        )
        for ((label, block) in cases) {
            val offer = E2eNegotiation.parsePeerOffer(block)
            assertEquals(
                "$label must degrade to ABSENT",
                E2eSettings.PeerAdvertisement.ABSENT, offer.advertisement
            )
            assertTrue("$label must record WHY", !offer.absentReason.isNullOrBlank())
            assertTrue("$label must yield no recipients", offer.recipients.isEmpty())
        }
    }

    @Test
    fun `a recipient missing a field is ABSENT`() {
        val o = offerJson()
        o.getAsJsonArray("recips")[0].asJsonObject.remove("pub")
        assertEquals(
            E2eSettings.PeerAdvertisement.ABSENT,
            E2eNegotiation.parsePeerOffer(o).advertisement
        )
    }

    @Test
    fun `a garbage JSON shape is ABSENT rather than a crash`() {
        val o = JsonParser.parseString("""{"v":"one","mode":[],"recips":"nope"}""").asJsonObject
        assertEquals(
            E2eSettings.PeerAdvertisement.ABSENT,
            E2eNegotiation.parsePeerOffer(o).advertisement
        )
    }

    // ----------------------------------------------------------- decision

    @Test
    fun `local ON with no peer block ABORTS with the specified copy`() {
        val d = E2eNegotiation.decide(localEnabled = true, offer = E2eNegotiation.parsePeerOffer(null))
        assertTrue(d is E2eNegotiation.Decision.Abort)
        assertEquals(
            "Couldn't set up encrypted pairing — try again",
            (d as E2eNegotiation.Decision.Abort).userMessage
        )
        assertTrue("the log reason must be diagnosable", d.logReason.contains("peer offered nothing"))
    }

    @Test
    fun `local OFF with no peer block is plaintext not an abort`() {
        assertEquals(
            E2eNegotiation.Decision.Plaintext,
            E2eNegotiation.decide(false, E2eNegotiation.parsePeerOffer(null))
        )
    }

    /** Matrix rows 8-10: either side ON means effective ON and a blocking SAS. */
    @Test
    fun `the OR rule decides the effective mode`() {
        val on = E2eNegotiation.parsePeerOffer(offerJson(mode = 1))
        val off = E2eNegotiation.parsePeerOffer(offerJson(mode = 0))

        // row 1 / 8 / 9: any ON -> verified
        for ((local, peer) in listOf(true to on, true to off, false to on)) {
            val d = E2eNegotiation.decide(local, peer)
            assertTrue("$local/$peer", d is E2eNegotiation.Decision.Encrypted)
            assertTrue(
                "either side ON must make the SAS blocking",
                (d as E2eNegotiation.Decision.Encrypted).modeOn
            )
        }
        // row 4: both OFF -> sealed but unverified, no SAS
        val d = E2eNegotiation.decide(false, off)
        assertTrue(d is E2eNegotiation.Decision.Encrypted)
        assertTrue(!(d as E2eNegotiation.Decision.Encrypted).modeOn)
        assertEquals(2, d.recipients.size)
    }

    // -------------------------------------------------------------- latch

    /**
     * A peer told "no" must not be able to walk the pair down by retrying with
     * a weaker offer — each refusal looks like a transient failure to the user,
     * which is exactly what makes attrition work.
     */
    @Test
    fun `the downgrade latch survives a retry with a weaker offer`() {
        val latch = E2eNegotiation.DowngradeLatch()
        assertTrue(!latch.isLatched)

        // Attempt 1: mode ON locally, peer offers nothing -> abort, latch set.
        val first = E2eNegotiation.decide(true, E2eNegotiation.parsePeerOffer(null), latch)
        assertTrue(first is E2eNegotiation.Decision.Abort)
        assertTrue("the abort must latch", latch.isLatched)

        // Attempt 2: the user has since turned mode OFF. Without the latch this
        // would now be a plain, cheerful plaintext pairing — the downgrade the
        // attacker wanted.
        val second = E2eNegotiation.decide(false, E2eNegotiation.parsePeerOffer(null), latch)
        assertTrue("a latched pair must not fall back to plaintext", second is E2eNegotiation.Decision.Abort)
        assertTrue((second as E2eNegotiation.Decision.Abort).logReason.contains("latch"))

        // Attempt 3: a genuine encrypting offer is still accepted — the latch
        // blocks downgrades, it does not brick the pair.
        val third = E2eNegotiation.decide(
            false, E2eNegotiation.parsePeerOffer(offerJson(mode = 1)), latch
        )
        assertTrue("a latched pair must still accept a FULL offer", third is E2eNegotiation.Decision.Encrypted)

        // And a real Reset clears it.
        latch.clear()
        assertEquals(
            E2eNegotiation.Decision.Plaintext,
            E2eNegotiation.decide(false, E2eNegotiation.parsePeerOffer(null), latch)
        )
    }

    @Test
    fun `a mode OFF offer does not latch a mode OFF device`() {
        val latch = E2eNegotiation.DowngradeLatch()
        E2eNegotiation.decide(false, E2eNegotiation.parsePeerOffer(offerJson(mode = 0)), latch)
        assertTrue("an ordinary unverified pairing is not a downgrade", !latch.isLatched)
    }

    // ------------------------------------------------------ accept block

    @Test
    fun `the accept block carries v1 and the FULL canonical key set`() {
        val phone = validPub()
        val web = E2eNegotiation.Recipient("web", "dev-web", validPub())
        val sw = E2eNegotiation.Recipient("extension", "dev-sw", validPub())
        val block = E2eNegotiation.buildAcceptBlock(
            modeOn = true,
            kid = "kid-1",
            epkSec1 = validPub(),
            phonePublicSec1 = phone,
            recipients = listOf(web, sw),
            wraps = listOf("dev-web" to ByteArray(48) { 1 }, "dev-sw" to ByteArray(48) { 2 }),
        )
        assertNotNull(block)
        assertEquals(
            "v:1 is mandatory — P1 drops a block without it to PLAINTEXT",
            1, block!!.get("v").asInt
        )
        assertEquals(1, block.get("mode").asInt)
        assertEquals("kid-1", block.get("kid").asString)

        val keys = block.getAsJsonArray("recipKeys").map { it.asString }
        assertEquals("phone + web + sw — the SAS covers the WHOLE set", 3, keys.size)
        assertTrue("the phone's own key must be in the set", keys.contains(b64(phone)))
        assertTrue(keys.contains(b64(web.publicKey)))
        assertTrue(keys.contains(b64(sw.publicKey)))

        // Canonical order, so both sides compute the same SAS transcript.
        val expected = E2eSas.canonicalKeySet(listOf(phone, web.publicKey, sw.publicKey))
            .map { b64(it) }
        assertEquals("recipKeys must be canonically ordered", expected, keys)

        assertEquals(2, block.getAsJsonArray("wraps").size())
    }

    @Test
    fun `the key set is deduplicated and order independent`() {
        val phone = validPub()
        val web = validPub()
        val a = E2eNegotiation.buildAcceptBlock(
            true, "k", validPub(), phone,
            listOf(
                E2eNegotiation.Recipient("web", "w", web),
                E2eNegotiation.Recipient("extension", "s", web), // same key twice
            ),
            emptyList()
        )!!
        assertEquals(
            "a duplicated key must collapse — the SAS set is a SET",
            2, a.getAsJsonArray("recipKeys").size()
        )
    }

    /**
     * The relay silently DROPS an `e2e` block over 4 KB and lets the pairing
     * continue in plaintext. Building one would turn a mode-ON pairing into a
     * quiet unencrypted one, so we refuse to build it and the caller aborts.
     */
    @Test
    fun `an oversized block is refused rather than silently dropped by the relay`() {
        val many = (0 until 60).map {
            E2eNegotiation.Recipient("web", "dev-$it", validPub())
        }
        val wraps = many.map { it.deviceId to ByteArray(64) }
        val block = E2eNegotiation.buildAcceptBlock(
            true, "kid-1", validPub(), validPub(), many, wraps
        )
        assertNull("a >4KB block must not be built", block)

        // Control: a realistic two-recipient block is comfortably under.
        val ok = E2eNegotiation.buildAcceptBlock(
            true, "kid-1", validPub(), validPub(),
            listOf(E2eNegotiation.Recipient("web", "w", validPub())),
            listOf("w" to ByteArray(48))
        )
        assertNotNull(ok)
        assertTrue(ok!!.toString().toByteArray(Charsets.UTF_8).size < E2eNegotiation.MAX_BLOCK_BYTES)
    }

    @Test
    fun `mode off produces mode 0 in the block`() {
        val block = E2eNegotiation.buildAcceptBlock(
            false, "k", validPub(), validPub(),
            listOf(E2eNegotiation.Recipient("web", "w", validPub())), emptyList()
        )!!
        assertEquals(0, block.get("mode").asInt)
        assertEquals(1, block.get("v").asInt)
    }
    // ------------------------------------------- INC-0923: latch lifecycle
    //
    // E2eNegotiation.kt promised "a fresh Accept after a genuine Reset is a
    // new pair" and nothing implemented it, so a latched phone stayed latched
    // until the process died — the reason INC-0923 needed a force-stop.
    // These four assertions are the contract lane C made binding.

    @Test
    fun `only locally originated events clear the downgrade latch`() {
        // Locally originated: the user acted on THIS device.
        assertTrue(E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.LOCAL_USER_DISCONNECT))
        assertTrue(E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.SERVICE_RESTART))
        // Relay-delivered: a peer that can set the latch could otherwise clear
        // it at will, which is the second step of the downgrade attack.
        assertTrue(
            "a relay RESET_ROOM must NOT clear the latch",
            !E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.RELAY_RESET_ROOM)
        )
        assertTrue(!E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.RELAY_PAIRING_TERMINATED))
        assertTrue(
            "a socket flap is not even an intentional act",
            !E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.SOCKET_FLAP)
        )
        // CONTROL: the enum is fully covered, so a new event added without a
        // decision cannot slip through as a silent `true`.
        assertEquals(5, E2eNegotiation.DowngradeLatch.Event.values().size)
    }

    /**
     * A latch set by a genuine downgrade must survive a relay-delivered reset
     * and still be clearable by the user. Stated as behaviour over a real
     * latch, not just the predicate, so the two cannot drift apart.
     */
    @Test
    fun `a relay reset does not release a latched pair but a local disconnect does`() {
        val latch = E2eNegotiation.DowngradeLatch()
        E2eNegotiation.decide(true, E2eNegotiation.parsePeerOffer(null), latch)
        assertTrue(latch.isLatched)

        if (E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.RELAY_RESET_ROOM)) latch.clear()
        assertTrue("RESET_ROOM came from the relay — still latched", latch.isLatched)

        if (E2eNegotiation.DowngradeLatch.clearsLatch(E2eNegotiation.DowngradeLatch.Event.LOCAL_USER_DISCONNECT)) latch.clear()
        assertTrue("the user disconnected on this device — released", !latch.isLatched)
    }

    /**
     * Which pin verdicts are evidence of an attack (latch) and which are merely
     * faults (do not latch). INC-0923: an unregistered service worker produced
     * a refusal that latched, so every later offer aborted instantly for the
     * life of the process — "Couldn't set up encrypted pairing — try again".
     */
    @Test
    fun `only a pin Mismatch latches`() {
        assertTrue(
            "a substituted or REVOKED key is an attack signature",
            E2eNegotiation.DowngradeLatch.latchesOn(
                E2eKeyPin.Verdict.Mismatch(E2eKeyPin.MISMATCH_MESSAGE, "substituted")
            )
        )
        assertTrue(
            "an unregistered recipient or an unreachable registry is a fault, not an offer",
            !E2eNegotiation.DowngradeLatch.latchesOn(
                E2eKeyPin.Verdict.FailClosed(E2eKeyPin.FAIL_CLOSED_MESSAGE, "sw (extension) unregistered")
            )
        )
        assertTrue(
            !E2eNegotiation.DowngradeLatch.latchesOn(E2eKeyPin.Verdict.FailOpenUnverified("unregistered"))
        )
        assertTrue(!E2eNegotiation.DowngradeLatch.latchesOn(E2eKeyPin.Verdict.Verified(2)))
    }
}
