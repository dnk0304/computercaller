package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * E2E programme, phase P4.1 — the Encrypted-mode toggle answers correctly
 * after process death.
 *
 * ## Why this test has to exist separately from the unit tests
 *
 * The unit tests prove the RULE: a v:1 block with a web/extension recipient
 * means PEER_SUPPORTED. They cannot prove the thing that actually broke the
 * feature in the field, which is that the Settings screen is opened from a
 * COLD START, minutes after the pairing frame arrived and long after the
 * process that parsed it was killed. An in-memory answer passes every unit
 * test and still greys the toggle out for every real user.
 *
 * ## Why it is split into two methods
 *
 * A test cannot outlive the process it is asserting about. Phase 1 advertises
 * and returns; `tools/run-peer-capability-test.ps1` then issues
 * `am force-stop` and starts a SECOND instrumentation run for phase 2. Running
 * the class in one go still passes, but proves only that a SharedPreferences
 * read works — the weaker claim. The driver script is what makes it a real
 * process-death proof, exactly as it is for [E2eKeyStoreTest].
 *
 * Phase 2 deliberately reads through [E2ePeerCapability.current] — the same
 * entry point `SettingsActivity.refreshEncryptedModeRow` calls — rather than
 * through the store. Asserting the store would prove the bytes survived; this
 * asserts that the SCREEN'S answer survived, which is the claim.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class E2ePeerCapabilityProcessDeathTest {

    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairingId = "p41-process-death"

    private fun validPubB64(): String {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toBase64Url(E2eKeyEncoding.toSec1(g.generateKeyPair().public))
    }

    /** The `e2e` block of a PAIRING_REQUEST from a capable computer. */
    private fun supportedBlock(): JsonObject = JsonObject().apply {
        addProperty("v", 1)
        addProperty("mode", 1)
        add("recips", JsonArray().apply {
            add(JsonObject().apply {
                addProperty("kind", "web")
                addProperty("deviceId", "p41-dev-web")
                addProperty("pub", validPubB64())
            })
        })
    }

    private fun advertise(block: JsonObject?) {
        E2eSettings.recordPeerAdvertisement(
            ctx, pairingId, E2eNegotiation.parsePeerOffer(block)
        )
    }

    // ------------------------------------------------ process-death phase 1

    /**
     * Phase 1: a capable computer advertises. Invoke alone, then
     * `am force-stop`, then [phase2_settingsReadsPeerSupportedAfterProcessDeath].
     *
     * The in-process assertion at the end is not the point of the test — it is
     * there so that a phase 1 which silently failed to write is distinguishable
     * from a phase 2 which failed to read. Without it, one red step could mean
     * either.
     */
    @Test
    fun phase1_advertiseFromACapableComputer() {
        E2eSettings.clearPeerAdvertisement(ctx, "test setup")
        assertNull(
            "setup left a record behind",
            E2eSettings.currentPeerAdvertisement(ctx)
        )

        advertise(supportedBlock())

        val record = E2eSettings.currentPeerAdvertisement(ctx)
        assertNotNull("nothing was persisted", record)
        assertTrue("the advertisement did not read as supported", record!!.supported)
        assertEquals(pairingId, record.pairingId)
        assertEquals(listOf("web"), record.kinds)
    }

    // ------------------------------------------------ process-death phase 2

    /**
     * Phase 2, in a FRESH process: Settings asks the same question the user's
     * screen asks, with no socket open and nothing in memory.
     *
     * PEER_SUPPORTED here is the whole P4.1 deliverable. Before this phase the
     * answer was UNKNOWN and the toggle was permanently inert.
     */
    @Test
    fun phase2_settingsReadsPeerSupportedAfterProcessDeath() {
        // A device that cannot hold a key answers DEVICE_UNSUPPORTED no matter
        // what the peer advertised, and that is correct — but it would make
        // this assertion meaningless, so say so rather than fail obscurely.
        val cap = E2eKeyStore.capability(ctx)
        org.junit.Assume.assumeTrue(
            "device cannot hold an E2E key: ${cap.reason}",
            cap.isSupported
        )

        val record = E2eSettings.currentPeerAdvertisement(ctx)
        assertNotNull(
            "the advertisement did not survive process death — phase 1 must run first, " +
                "in its own instrumentation run",
            record
        )

        assertEquals(
            E2ePeerCapability.State.PEER_SUPPORTED,
            E2ePeerCapability.current(ctx)
        )
        assertTrue(
            "PEER_SUPPORTED must make the toggle operable",
            E2ePeerCapability.isToggleEnabled(E2ePeerCapability.current(ctx))
        )
    }

    // ------------------------------------------------------ in-process rest

    /**
     * A computer that paired with no `e2e` block, read back through the real
     * provider. Separate from the unit tests because it goes through
     * SharedPreferences: an encoder that dropped `supported: false` would
     * round-trip correctly in memory and read back as the default on disk.
     */
    @Test
    fun z1_anAbsentBlockPersistsAsPeerUnsupported() {
        val cap = E2eKeyStore.capability(ctx)
        org.junit.Assume.assumeTrue(cap.reason, cap.isSupported)

        E2eSettings.clearPeerAdvertisement(ctx, "test setup")
        advertise(null)

        assertEquals(
            E2ePeerCapability.State.PEER_UNSUPPORTED,
            E2ePeerCapability.current(ctx)
        )
    }

    /**
     * Clearing returns the screen to UNKNOWN — "waiting", not "your computer
     * can't". A cleared pair whose toggle stayed operable would let a user
     * switch encryption on for a computer that is no longer there.
     */
    @Test
    fun z2_clearingReturnsToUnknown() {
        val cap = E2eKeyStore.capability(ctx)
        org.junit.Assume.assumeTrue(cap.reason, cap.isSupported)

        advertise(supportedBlock())
        assertEquals(E2ePeerCapability.State.PEER_SUPPORTED, E2ePeerCapability.current(ctx))

        E2eSettings.clearPeerAdvertisement(ctx, "test: reset")

        assertNull(E2eSettings.currentPeerAdvertisement(ctx))
        assertEquals(E2ePeerCapability.State.UNKNOWN, E2ePeerCapability.current(ctx))
    }

    /**
     * A clear scoped to one pairingId must not touch another pairing's record.
     * This is what keeps a cancelled or declined REQUEST from greying out the
     * toggle on a pair that is already live.
     */
    @Test
    fun z3_aScopedClearOnlyTouchesItsOwnPairing() {
        val cap = E2eKeyStore.capability(ctx)
        org.junit.Assume.assumeTrue(cap.reason, cap.isSupported)

        advertise(supportedBlock())
        E2eSettings.clearPeerAdvertisementFor(ctx, "some-other-pairing", "test")
        assertEquals(
            "a clear for a different pairing erased this one",
            E2ePeerCapability.State.PEER_SUPPORTED,
            E2ePeerCapability.current(ctx)
        )

        E2eSettings.clearPeerAdvertisementFor(ctx, pairingId, "test")
        assertEquals(E2ePeerCapability.State.UNKNOWN, E2ePeerCapability.current(ctx))
    }

    /**
     * The teardown other tests rely on. Named to sort last under
     * NAME_ASCENDING so a leftover PEER_SUPPORTED record cannot leak into the
     * UI suite, which asserts the UNKNOWN row.
     */
    @Test
    fun zz_leaveNoRecordBehind() {
        E2eSettings.clearPeerAdvertisement(ctx, "test teardown")
        assertNull(E2eSettings.currentPeerAdvertisement(ctx))
    }
}
