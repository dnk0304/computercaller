package com.dnkdialer.companion

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E programme, phase P4.1 — the Encrypted-mode toggle's reachability.
 *
 * ## What this file exists to stop happening again
 *
 * P4 Part 1 shipped [E2ePeerCapability.current] as a stub with ONE branch.
 * P5b then built the Settings row on it and proved the enabled branch with a
 * test-only override. Both lanes were green, and between them the product had
 * a toggle that could not be switched on by any user on any device. Nothing
 * failed, because nothing asserted the stub's answer against a real
 * advertisement.
 *
 * So these tests start from the WIRE — an actual `e2e` JsonObject of the shape
 * P1 forwards — and run it through the real parser, the real record logic and
 * the real evaluator, ending on the State the Settings screen paints. No
 * override, no stub, no Context: the whole chain is pure, which is why it can
 * be asserted here at all.
 *
 * The Context-dependent half (does the record actually survive process death?)
 * is not fakeable on the JVM and is proved separately, on a device, by
 * [E2ePeerCapabilityProcessDeathTest].
 */
class E2ePeerCapabilityTest {

    private val PHONE = "phone-device-id"
    private val PAIRING = "pairing-abc"

    private fun validPub(): ByteArray {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toSec1(g.generateKeyPair().public)
    }

    /** A PAIRING_REQUEST `e2e` block, exactly as P1 forwards it. */
    private fun block(v: Int?, mode: Int, kinds: List<Pair<String, String>>): JsonObject {
        val o = JsonObject()
        if (v != null) o.addProperty("v", v)
        o.addProperty("mode", mode)
        val arr = JsonArray()
        for ((kind, deviceId) in kinds) {
            val r = JsonObject()
            r.addProperty("kind", kind)
            r.addProperty("deviceId", deviceId)
            r.addProperty("pub", E2eKeyEncoding.toBase64Url(validPub()))
            arr.add(r)
        }
        o.add("recips", arr)
        return o
    }

    /**
     * The whole production chain, minus the two I/O ends: parse the block the
     * relay forwarded, decide what to persist, round-trip it through the SAME
     * encoder the store uses, and evaluate. The round-trip is deliberate — a
     * record that evaluates correctly in memory but cannot be read back is the
     * process-death bug, and testing only the in-memory object would miss it.
     */
    private fun stateFor(
        rawBlock: JsonObject?,
        deviceSupported: Boolean = true,
    ): E2ePeerCapability.State {
        val offer = E2eNegotiation.parsePeerOffer(rawBlock)
        val record = E2eSettings.recordFor(PHONE, PAIRING, offer)
        val reread = E2eSettings.decodePeerAdvertisement(
            E2eSettings.encodePeerAdvertisement(record)
        )
        assertNotNull("the record this build just wrote must be readable by it", reread)
        return E2ePeerCapability.evaluate(deviceSupported, reread)
    }

    // ------------------------------------------------- the six brief cases

    /**
     * A computer that advertised v:1 with a `web` recipient. THE case P4 Part 1
     * could never reach and the whole reason v58 would have shipped a dead
     * control.
     */
    @Test
    fun `v1 with a web recipient is PEER_SUPPORTED`() {
        assertEquals(
            E2ePeerCapability.State.PEER_SUPPORTED,
            stateFor(block(1, 1, listOf("web" to "dev-web")))
        )
    }

    /**
     * An `extension` recipient alone is equally sufficient. §12 names web and
     * extension as the two kinds that count; requiring BOTH would make an
     * extension-only computer look incapable, and a computer is one peer with
     * two possible sub-devices, not two peers.
     */
    @Test
    fun `v1 with only an extension recipient is PEER_SUPPORTED`() {
        assertEquals(
            E2ePeerCapability.State.PEER_SUPPORTED,
            stateFor(block(1, 1, listOf("extension" to "dev-sw")))
        )
    }

    /**
     * `mode: 0` is a capable computer whose own setting is OFF. It is still
     * PEER_SUPPORTED: the toggle asks "CAN this pair encrypt", and the OR rule
     * (E2eSettings row 8) means the phone turning it on is enough. Reading
     * mode 0 as "unsupported" would grey out the toggle for every user whose
     * computer had simply not opted in — i.e. all of them, at launch.
     */
    @Test
    fun `mode 0 is still PEER_SUPPORTED — the toggle asks can, not will`() {
        assertEquals(
            E2ePeerCapability.State.PEER_SUPPORTED,
            stateFor(block(1, 0, listOf("web" to "dev-web")))
        )
    }

    /** A computer that paired with no `e2e` block at all — pre-feature build. */
    @Test
    fun `no block at all is PEER_UNSUPPORTED`() {
        assertEquals(E2ePeerCapability.State.PEER_UNSUPPORTED, stateFor(null))
    }

    /**
     * v:2 — a computer speaking a protocol version this build does not.
     * PEER_UNSUPPORTED, not PEER_SUPPORTED: we cannot seal to a block we cannot
     * read, and claiming otherwise would enable a toggle whose pairing then
     * aborts.
     */
    @Test
    fun `an unknown block version is PEER_UNSUPPORTED`() {
        assertEquals(
            E2ePeerCapability.State.PEER_UNSUPPORTED,
            stateFor(block(2, 1, listOf("web" to "dev-web")))
        )
    }

    /** Nothing paired and nothing pending: no record exists. */
    @Test
    fun `nothing paired is UNKNOWN`() {
        assertEquals(
            E2ePeerCapability.State.UNKNOWN,
            E2ePeerCapability.evaluate(deviceSupported = true, record = null)
        )
    }

    /**
     * After a reset the store clears the record, so the evaluator sees null
     * again. Asserted as its own case because "cleared" and "never paired" must
     * produce the SAME state — if a reset left PEER_SUPPORTED standing, the
     * toggle would stay operable for a computer that is no longer there.
     */
    @Test
    fun `cleared on reset returns to UNKNOWN, not to the last peer state`() {
        val supported = E2eSettings.decodePeerAdvertisement(
            E2eSettings.encodePeerAdvertisement(
                E2eSettings.recordFor(
                    PHONE, PAIRING,
                    E2eNegotiation.parsePeerOffer(block(1, 1, listOf("web" to "dev-web")))
                )
            )
        )
        assertEquals(
            E2ePeerCapability.State.PEER_SUPPORTED,
            E2ePeerCapability.evaluate(true, supported)
        )
        // What clearPeerAdvertisement leaves behind is the absence of a record.
        assertEquals(E2ePeerCapability.State.UNKNOWN, E2ePeerCapability.evaluate(true, null))
    }

    // ------------------------------------------------ the device's own half

    /**
     * The phone's own incapability outranks everything. A user on API 26–30
     * must be told to update their PHONE; "waiting for your computer" and
     * "update your computer" are both false there and both send them to fix
     * the wrong machine.
     */
    @Test
    fun `DEVICE_UNSUPPORTED outranks every peer state`() {
        for (b in listOf<JsonObject?>(
            block(1, 1, listOf("web" to "dev-web")),
            block(2, 1, listOf("web" to "dev-web")),
            null,
        )) {
            assertEquals(
                E2ePeerCapability.State.DEVICE_UNSUPPORTED,
                stateFor(b, deviceSupported = false)
            )
        }
        assertEquals(
            E2ePeerCapability.State.DEVICE_UNSUPPORTED,
            E2ePeerCapability.evaluate(deviceSupported = false, record = null)
        )
    }

    // ------------------------------------------------------ the toggle gate

    /** Only PEER_SUPPORTED may be operated — asserted over the whole enum. */
    @Test
    fun `exactly one state enables the toggle`() {
        val enabled = E2ePeerCapability.State.values()
            .filter { E2ePeerCapability.isToggleEnabled(it) }
        assertEquals(listOf(E2ePeerCapability.State.PEER_SUPPORTED), enabled)
    }

    // ------------------------------------------------------- record shaping

    /**
     * An unusable recipient kind cannot make a peer supported, even inside an
     * otherwise valid v:1 block. Asserted at [E2eSettings.recordFor] directly
     * because the parser rejects unknown kinds today — this is the guard for
     * the day it stops doing so, and the reason the kind check is duplicated
     * there rather than inherited.
     */
    @Test
    fun `a recipient of an unusable kind does not count as support`() {
        val offer = E2eNegotiation.PeerOffer(
            advertisement = E2eSettings.PeerAdvertisement.ON,
            recipients = listOf(
                E2eNegotiation.Recipient("desktop-app", "dev-x", validPub())
            ),
        )
        val record = E2eSettings.recordFor(PHONE, PAIRING, offer)
        assertFalse(record.supported)
        assertEquals(E2eSettings.NO_PEER_DEVICE_ID, record.peerDeviceId)
        assertEquals(
            E2ePeerCapability.State.PEER_UNSUPPORTED,
            E2ePeerCapability.evaluate(true, record)
        )
    }

    /**
     * The record is keyed to the peer's canonical deviceId — the same choice
     * E2ePairIdentity makes for the KDF context, so the two cannot disagree
     * about which sub-device identifies the computer.
     */
    @Test
    fun `the record keys on the canonical peer deviceId`() {
        val offer = E2eNegotiation.parsePeerOffer(
            block(1, 1, listOf("web" to "zzz-web", "extension" to "aaa-sw"))
        )
        val record = E2eSettings.recordFor(PHONE, PAIRING, offer)
        assertEquals(
            E2ePairIdentity.canonicalPeerDeviceId(listOf("zzz-web", "aaa-sw")),
            record.peerDeviceId
        )
        assertEquals(listOf("extension", "web"), record.kinds)
        assertTrue(record.supported)
        assertNull(record.absentReason)
    }

    // --------------------------------------------------- the version guard

    /**
     * A record written by a FUTURE build is unreadable, and unreadable must
     * mean UNKNOWN. Landing on PEER_UNSUPPORTED instead would make a
     * downgraded app tell the user their computer is too old on the basis of
     * evidence about the app itself.
     */
    @Test
    fun `a record of an unknown version reads as no record`() {
        val future = JsonObject().apply {
            addProperty("v", E2eSettings.PEER_ADVERTISEMENT_RECORD_VERSION + 1)
            addProperty("phoneDeviceId", PHONE)
            addProperty("peerDeviceId", "dev-web")
            addProperty("pairingId", PAIRING)
            addProperty("supported", true)
        }
        assertNull(E2eSettings.decodePeerAdvertisement(future.toString()))
        assertEquals(
            E2ePeerCapability.State.UNKNOWN,
            E2ePeerCapability.evaluate(true, E2eSettings.decodePeerAdvertisement(future.toString()))
        )
    }

    /** Garbage on disk is not a crash and not a capability claim. */
    @Test
    fun `malformed records decode to null rather than throwing`() {
        for (raw in listOf(null, "", "   ", "not json", "[]", "{}", "{\"v\":1}")) {
            assertNull("raw=$raw", E2eSettings.decodePeerAdvertisement(raw))
        }
    }

    /** Every field survives the round trip the store performs. */
    @Test
    fun `a record round trips through the store encoding`() {
        val record = E2eSettings.recordFor(
            PHONE, PAIRING,
            E2eNegotiation.parsePeerOffer(block(1, 1, listOf("web" to "dev-web", "extension" to "dev-sw")))
        )
        assertEquals(
            record,
            E2eSettings.decodePeerAdvertisement(E2eSettings.encodePeerAdvertisement(record))
        )
    }
}
