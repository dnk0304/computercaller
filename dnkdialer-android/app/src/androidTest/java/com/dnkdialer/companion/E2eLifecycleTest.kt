package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 Part 2 (f) — key lifecycle, §13.8.
 *
 * Instrumented: rotation deletes an AndroidKeyStore key and clears the
 * Keystore-sealed counter records, neither of which exists on the JVM.
 *
 * The remote revoke is injected so every branch (ok / failed / threw / skipped)
 * runs without a network. A lifecycle test that only covered the happy path
 * would miss the asymmetry that matters: the LOCAL delete must happen even when
 * the remote revoke fails.
 */
@RunWith(AndroidJUnit4::class)
class E2eLifecycleTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val pairContext = E2eKdf.PairContext("pair-lc", "u", "p", "w", 2L)
    private val sk = ByteArray(32) { (it + 3).toByte() }

    private val revokeOk: (String, String) -> E2eDeviceKeyClient.Result<*> =
        { _, _ -> E2eDeviceKeyClient.Result.Ok(Unit) }
    private val revokeDown: (String, String) -> E2eDeviceKeyClient.Result<*> =
        { _, _ -> E2eDeviceKeyClient.Result.Unavailable("no route to host") }
    private val revokeThrows: (String, String) -> E2eDeviceKeyClient.Result<*> =
        { _, _ -> throw java.io.IOException("socket closed") }

    @Before
    fun clean() {
        E2eSeqStore.clearAll(ctx)
    }

    private fun session(kid: String) =
        E2eSession.forPhone(ctx, sk, pairContext, kid, freshEpoch = true)

    // ---------------------------------------------------------- device id

    @Test
    fun the_device_id_is_stable_and_matches_the_registry_pattern() {
        val a = E2eLifecycle.deviceId(ctx)
        val b = E2eLifecycle.deviceId(ctx)
        assertEquals("the id must not change per call", a, b)
        assertTrue("must match P1's DEVICE_ID_PATTERN: $a", Regex("^[A-Za-z0-9_-]{1,128}$").matches(a))
        assertTrue(E2eLifecycle.hasDeviceId(ctx))
    }

    // ----------------------------------------- Reset / LEAVE_ACTIVE (§13.8)

    /**
     * Leaving a room drops the SK and KEEPS the device key. Rotating here would
     * invalidate every other pairing and force the user to re-verify each one,
     * for an event that is not a compromise.
     */
    @Test
    fun leaving_a_pair_drops_the_SK_but_keeps_the_device_key() {
        val before = E2eKeyAgreement.devicePublicSec1(ctx)
        val s = session("kid-leave")
        val sealedBefore = s.seal("SMS_RECEIVED", "x".toByteArray(Charsets.UTF_8))

        val out = E2eLifecycle.onPairEnded(s)
        assertTrue(out.sessionClosed)
        assertTrue("leaving must NOT rotate the device key", !out.deviceKeyRotated)

        assertEquals(
            "the device key must survive leaving a room",
            E2eKdf.toHex(before), E2eKdf.toHex(E2eKeyAgreement.devicePublicSec1(ctx))
        )
        // The SK really is gone: a frame sealed after close cannot be opened
        // with the real traffic key.
        val keys = E2eKdf.deriveTrafficKeys(sk, pairContext)
        val prefixes = E2eKdf.deriveNoncePrefixes(sk, pairContext)
        assertNull(
            "the SK was not dropped",
            E2eEnvelope.open(
                keys.phoneToComputer, s.seal("SMS_RECEIVED", "y".toByteArray(Charsets.UTF_8)),
                E2eEnvelope.Direction.PHONE_TO_COMPUTER, pairContext.pairEpoch,
                prefixes.phoneToComputer, "SMS_RECEIVED"
            )
        )
        // Control: the pre-close frame did open under that key.
        assertTrue(
            E2eEnvelope.open(
                keys.phoneToComputer, sealedBefore, E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                pairContext.pairEpoch, prefixes.phoneToComputer, "SMS_RECEIVED"
            ) != null
        )
    }

    // ------------------------------------------------------------ sign-out

    @Test
    fun sign_out_deletes_the_device_key_clears_counters_and_drops_the_id() {
        E2eLifecycle.deviceId(ctx)
        val before = E2eKeyAgreement.devicePublicSec1(ctx)
        val s = session("kid-signout")

        val out = E2eLifecycle.onSignOut(ctx, s, "dev-1", "token", revokeOk)

        assertTrue(out.sessionClosed)
        assertTrue(out.deviceKeyRotated)
        assertTrue(out.countersCleared)
        assertEquals(true, out.remoteRevokeOk)
        assertNotEquals(
            "sign-out must delete the device key",
            E2eKdf.toHex(before), E2eKdf.toHex(E2eKeyAgreement.devicePublicSec1(ctx))
        )
        assertTrue("the device id must be dropped", !E2eLifecycle.hasDeviceId(ctx))

        // Counters gone: resuming the old kid must now fail closed.
        try {
            E2eSeqStore.open(
                ctx, "kid-signout", E2eEnvelope.Direction.PHONE_TO_COMPUTER,
                freshEpoch = false, ByteArray(4)
            )
            org.junit.Assert.fail("a counter survived sign-out")
        } catch (e: E2eSeqStore.CounterUnsafeException) {
            assertTrue(e.message!!.contains("rekey"))
        }
    }

    /**
     * The asymmetry that matters. A key deleted locally but still live in the
     * registry is a stale row the next register supersedes (N-4). A key KEPT
     * locally after the user asked to sign out is the thing they explicitly
     * asked us not to do. So the local delete happens regardless.
     */
    @Test
    fun sign_out_deletes_locally_even_when_the_remote_revoke_fails_or_throws() {
        for ((label, revoker) in listOf("down" to revokeDown, "threw" to revokeThrows)) {
            E2eLifecycle.deviceId(ctx)
            val before = E2eKeyAgreement.devicePublicSec1(ctx)
            val out = E2eLifecycle.onSignOut(ctx, session("kid-$label"), "dev-1", "token", revoker)

            assertEquals("revoke $label must be reported honestly", false, out.remoteRevokeOk)
            assertTrue("$label: the local delete must still happen", out.deviceKeyRotated)
            assertNotEquals(
                "$label: the device key survived a failed revoke",
                E2eKdf.toHex(before), E2eKdf.toHex(E2eKeyAgreement.devicePublicSec1(ctx))
            )
            assertTrue("$label: the outcome must say what happened",
                out.notes.any { it.contains("local delete") || it.contains("supersedes") })
        }
    }

    @Test
    fun sign_out_with_no_token_skips_the_remote_call_but_still_deletes() {
        E2eLifecycle.deviceId(ctx)
        val before = E2eKeyAgreement.devicePublicSec1(ctx)
        val out = E2eLifecycle.onSignOut(ctx, null, null, null)
        assertNull("no revoke was attempted", out.remoteRevokeOk)
        assertTrue(out.deviceKeyRotated)
        assertNotEquals(E2eKdf.toHex(before), E2eKdf.toHex(E2eKeyAgreement.devicePublicSec1(ctx)))
    }

    // ------------------------------------------------------------ rotation

    /**
     * §13.8 / N-4: rotation mints a NEW deviceId, because publicKey is
     * immutable per (userId, deviceId). Reusing the id would mean updating a
     * key in place, which erases the evidence that a substitution happened.
     */
    @Test
    fun rotation_mints_a_new_device_id_and_a_new_key() {
        val oldId = E2eLifecycle.deviceId(ctx)
        val oldKey = E2eKeyAgreement.devicePublicSec1(ctx)

        val out = E2eLifecycle.rotateDeviceKey(ctx, session("kid-rot"), oldId, "token", revokeOk)

        assertNotEquals("rotation must mint a new deviceId", oldId, out.newDeviceId)
        assertEquals("…and persist it", out.newDeviceId, E2eLifecycle.deviceId(ctx))
        assertNotEquals(
            "rotation must mint a new key",
            E2eKdf.toHex(oldKey), E2eKdf.toHex(E2eKeyAgreement.devicePublicSec1(ctx))
        )
        assertEquals(true, out.remoteRevokeOk)
        assertTrue(out.notes.any { it.contains("immutable") })
    }

    // ----------------------------------------------------------- reinstall

    /**
     * A reinstall takes the prefs AND the Keystore keys, so the phone comes back
     * with a new id and a new key and the computer's TOFU warning fires. That
     * warning is CORRECT — the computer genuinely cannot tell a reinstall from a
     * substitution. M-C's copy gives the benign causes without asserting one.
     */
    @Test
    fun reinstall_looks_like_a_new_device_and_the_copy_does_not_overclaim() {
        val idBefore = E2eLifecycle.deviceId(ctx)

        // The reinstall: identity prefs gone, Keystore key gone.
        E2eLifecycle.onSignOut(ctx, null, null, null)

        val idAfter = E2eLifecycle.deviceId(ctx)
        assertNotEquals("a reinstall must present as a new device", idBefore, idAfter)

        val copy = E2eLifecycle.REINSTALL_CAUSE_COPY
        assertTrue("must offer the benign causes", copy.contains("reinstalling"))
        assertTrue("must tell the user what to do otherwise", copy.contains("check the code"))
        // It must NOT assert the cause — a confident "this is just a reinstall"
        // would train users straight through a real substitution.
        for (overclaim in listOf("this is just", "nothing to worry", "safe to continue", "ignore")) {
            assertTrue(
                "the copy must not assert a benign cause: found '$overclaim'",
                !copy.lowercase().contains(overclaim)
            )
        }
        assertTrue("no user-facing 'end-to-end' wording", !copy.lowercase().contains("end-to-end"))
    }
}
