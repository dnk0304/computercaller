package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

/**
 * P6.1c 1a. The unit half of [E2eDeviceKeyRegistrar] — every branch of the
 * decision, and every branch of the one write, with the network injected.
 *
 * The thing under test is the one the live run needed and did not have: that
 * the phone's row REACHES the registry, and that getting it there never
 * silently displaces a key a peer has already pinned (M-A6-2).
 *
 * Plain JVM. No Robolectric, no `returnDefaultValues` — nothing under test
 * here touches an Android API, which is exactly why the decision was split out
 * of [E2eDeviceKeyRegistrar.ensureForThisDevice].
 */
class E2eDeviceKeyRegistrarTest {

    private val deviceId = "dev-phone-1"
    private val token = "phone-token"

    /** A real P-256 point, so `publicKeyBytes()`'s validation actually passes. */
    private fun freshKey(): ByteArray {
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toSec1(gen.generateKeyPair().public)
    }

    private fun row(
        id: String = deviceId,
        kind: String = "phone",
        key: ByteArray,
        revokedAt: String? = null,
    ) = E2eDeviceKeyClient.DeviceKeyRow(
        deviceId = id,
        kind = kind,
        publicKey = E2eKeyEncoding.toBase64Url(key),
        label = null,
        revokedAt = revokedAt,
    )

    /** Records what the registrar actually did to the outside world. */
    private class Wire(
        val listed: E2eDeviceKeyClient.Result<List<E2eDeviceKeyClient.DeviceKeyRow>>,
        val written: E2eDeviceKeyClient.Result<Pair<E2eDeviceKeyClient.DeviceKeyRow, Boolean>> =
            E2eDeviceKeyClient.Result.Unavailable("the test did not expect a write"),
    ) {
        var lists = 0
        var writes = 0
        var wroteKey: ByteArray? = null
        var wroteLabel: String? = null

        val lister: (String) -> E2eDeviceKeyClient.Result<List<E2eDeviceKeyClient.DeviceKeyRow>> =
            { lists++; listed }

        val registrar: (String, String, ByteArray, String?)
        -> E2eDeviceKeyClient.Result<Pair<E2eDeviceKeyClient.DeviceKeyRow, Boolean>> =
            { _, _, k, l -> writes++; wroteKey = k; wroteLabel = l; written }
    }

    private fun run(
        wire: Wire,
        key: ByteArray,
        phoneToken: String? = token,
        label: String? = "Pixel",
    ) = E2eDeviceKeyRegistrar.ensureRegistered(
        phoneToken = phoneToken,
        deviceId = deviceId,
        publicKeySec1 = key,
        label = label,
        lister = wire.lister,
        registrar = wire.registrar,
    )

    // ------------------------------------------------------------ plan only

    @Test
    fun `no rows at all means register`() {
        val mine = freshKey()
        assertEquals(
            E2eDeviceKeyRegistrar.Plan.Register(null),
            E2eDeviceKeyRegistrar.plan(emptyList(), deviceId, mine),
        )
    }

    @Test
    fun `a live row holding our exact key is up to date`() {
        val mine = freshKey()
        assertSame(
            E2eDeviceKeyRegistrar.Plan.UpToDate,
            E2eDeviceKeyRegistrar.plan(listOf(row(key = mine)), deviceId, mine),
        )
    }

    @Test
    fun `only a revoked row for us still means register`() {
        val mine = freshKey()
        val plan = E2eDeviceKeyRegistrar.plan(
            listOf(row(key = mine, revokedAt = "2026-01-01T00:00:00Z")), deviceId, mine,
        )
        // Not UpToDate: the key matches, but a revoked row is not a row the
        // page's C-2 pin will accept, so we must write a live one.
        assertEquals(E2eDeviceKeyRegistrar.Plan.Register(null), plan)
    }

    @Test
    fun `rows for other devices and other kinds are not ours`() {
        val mine = freshKey()
        val rows = listOf(
            row(id = "someone-else", key = mine),
            row(kind = "browser", key = mine),
        )
        assertEquals(E2eDeviceKeyRegistrar.Plan.Register(null),
            E2eDeviceKeyRegistrar.plan(rows, deviceId, mine))
    }

    @Test
    fun `a live row with a DIFFERENT key is a displacement, not a fresh write`() {
        val mine = freshKey()
        val theirs = row(key = freshKey())
        val plan = E2eDeviceKeyRegistrar.plan(listOf(theirs), deviceId, mine)
        assertEquals(E2eDeviceKeyRegistrar.Plan.Register(theirs), plan)
    }

    @Test
    fun `a live row whose key does not decode counts as displacing`() {
        val mine = freshKey()
        val junk = E2eDeviceKeyClient.DeviceKeyRow(
            deviceId, "phone", "!!!not base64url!!!", null, null,
        )
        val plan = E2eDeviceKeyRegistrar.plan(listOf(junk), deviceId, mine)
        assertEquals(E2eDeviceKeyRegistrar.Plan.Register(junk), plan)
    }

    // ------------------------------------------------------- idempotence

    @Test
    fun `an already-live key issues NO write at all`() {
        val mine = freshKey()
        val wire = Wire(E2eDeviceKeyClient.Result.Ok(listOf(row(key = mine))))
        val out = run(wire, mine)

        assertEquals(E2eDeviceKeyRegistrar.Status.ALREADY_LIVE, out.status)
        assertFalse(out.wrote)
        assertEquals(1, wire.lists)
        // This is the whole idempotence claim: app start, login and every
        // Accept can all call this, and the steady state costs one GET.
        assertEquals(0, wire.writes)
    }

    // ------------------------------------------------------ the happy write

    @Test
    fun `a missing row is registered and folded into the registry the pin reads`() {
        val mine = freshKey()
        val written = row(key = mine)
        val wire = Wire(
            listed = E2eDeviceKeyClient.Result.Ok(listOf(row(id = "other", key = freshKey()))),
            written = E2eDeviceKeyClient.Result.Ok(written to false),
        )
        val out = run(wire, mine)

        assertEquals(E2eDeviceKeyRegistrar.Status.REGISTERED, out.status)
        assertTrue(out.wrote)
        assertEquals(1, wire.writes)
        assertTrue(mine.contentEquals(wire.wroteKey!!))
        assertEquals("Pixel", wire.wroteLabel)

        // The Accept path pins off exactly this value — one round trip, not
        // two — so our own fresh row has to be in it.
        val rows = (out.registry as E2eDeviceKeyClient.Result.Ok).value
        assertEquals(2, rows.size)
        assertTrue(rows.any { it.deviceId == deviceId && !it.isRevoked })
    }

    // -------------------------------------------------------------- M-A6-2

    @Test
    fun `displacing a live key is ROTATED and names both keys — never a silent overwrite`() {
        val mine = freshKey()
        val old = row(key = freshKey())
        val wire = Wire(
            listed = E2eDeviceKeyClient.Result.Ok(listOf(old)),
            written = E2eDeviceKeyClient.Result.Ok(row(key = mine) to true),
        )
        val out = run(wire, mine)

        assertEquals(E2eDeviceKeyRegistrar.Status.ROTATED, out.status)
        // M-A6-2: the displaced key must be identifiable from the outcome
        // alone. A `rotated` boolean nobody prints is the silent overwrite.
        assertTrue(out.detail, out.detail.contains(old.publicKey.take(12)))
        assertTrue(out.detail, out.detail.contains(E2eKeyEncoding.toBase64Url(mine).take(12)))

        // The displaced live row is gone from what the pin will read: the
        // server revoked it in the same transaction, so serving it on would
        // hand the pin a row the registry no longer has.
        val rows = (out.registry as E2eDeviceKeyClient.Result.Ok).value
        assertEquals(1, rows.size)
        assertEquals(E2eKeyEncoding.toBase64Url(mine), rows.single().publicKey)
    }

    @Test
    fun `the server calling it a rotation is ROTATED even when we saw no live row`() {
        val mine = freshKey()
        val wire = Wire(
            listed = E2eDeviceKeyClient.Result.Ok(emptyList()),
            // A row landed between our GET and our POST. The server saw the
            // displacement even though we did not, and it still must not pass
            // as a routine "registered".
            written = E2eDeviceKeyClient.Result.Ok(row(key = mine) to true),
        )
        assertEquals(E2eDeviceKeyRegistrar.Status.ROTATED, run(wire, mine).status)
    }

    // ------------------------------------------------------------- failures

    @Test
    fun `no token skips without touching the network`() {
        val mine = freshKey()
        val wire = Wire(E2eDeviceKeyClient.Result.Ok(emptyList()))
        val out = run(wire, mine, phoneToken = null)

        assertEquals(E2eDeviceKeyRegistrar.Status.SKIPPED, out.status)
        assertEquals(0, wire.lists)
        assertEquals(0, wire.writes)
    }

    @Test
    fun `a blank token skips too`() {
        val wire = Wire(E2eDeviceKeyClient.Result.Ok(emptyList()))
        assertEquals(
            E2eDeviceKeyRegistrar.Status.SKIPPED,
            run(wire, freshKey(), phoneToken = "   ").status,
        )
    }

    @Test
    fun `an unreachable registry is DEFERRED and passed through UNCHANGED`() {
        val listed = E2eDeviceKeyClient.Result.Unavailable("SocketTimeoutException")
        val wire = Wire(listed)
        val out = run(wire, freshKey())

        assertEquals(E2eDeviceKeyRegistrar.Status.DEFERRED, out.status)
        assertEquals(0, wire.writes)
        // §13.6 gives "unreachable" and "no row" opposite handling. Collapsing
        // them here would make the pin fail closed for the wrong reason (or
        // fail open for the wrong reason), so the Result travels untouched.
        assertSame(listed, out.registry)
    }

    @Test
    fun `409 pairing_in_flight is DEFERRED, not an error, and retried later`() {
        val mine = freshKey()
        val listed = E2eDeviceKeyClient.Result.Ok(emptyList<E2eDeviceKeyClient.DeviceKeyRow>())
        val wire = Wire(listed, E2eDeviceKeyClient.Result.PairingInFlight)
        val out = run(wire, mine)

        assertEquals(E2eDeviceKeyRegistrar.Status.DEFERRED, out.status)
        assertTrue(out.detail, out.detail.contains("pairing_in_flight"))
        assertFalse(out.wrote)
        // The listing still stands; it just has no row for us yet, and the pin
        // is entitled to see that truthfully.
        assertSame(listed, out.registry)
    }

    @Test
    fun `a 403 from the registry is DEFERRED and surfaces the server's own message`() {
        val wire = Wire(
            E2eDeviceKeyClient.Result.Ok(emptyList()),
            E2eDeviceKeyClient.Result.Forbidden(403, "CSRF check failed"),
        )
        val out = run(wire, freshKey())
        assertEquals(E2eDeviceKeyRegistrar.Status.DEFERRED, out.status)
        assertTrue(out.detail, out.detail.contains("CSRF check failed"))
    }

    @Test
    fun `a network failure on the write is DEFERRED`() {
        val wire = Wire(
            E2eDeviceKeyClient.Result.Ok(emptyList()),
            E2eDeviceKeyClient.Result.Unavailable("HTTP 500"),
        )
        val out = run(wire, freshKey())
        assertEquals(E2eDeviceKeyRegistrar.Status.DEFERRED, out.status)
        assertTrue(out.detail, out.detail.contains("HTTP 500"))
    }

    @Test
    fun `a blank device id skips`() {
        val out = E2eDeviceKeyRegistrar.ensureRegistered(
            phoneToken = token,
            deviceId = "",
            publicKeySec1 = freshKey(),
            lister = { throw AssertionError("must not list") },
            registrar = { _, _, _, _ -> throw AssertionError("must not write") },
        )
        assertEquals(E2eDeviceKeyRegistrar.Status.SKIPPED, out.status)
        assertNull((out.registry as? E2eDeviceKeyClient.Result.Ok)?.value)
    }
}
