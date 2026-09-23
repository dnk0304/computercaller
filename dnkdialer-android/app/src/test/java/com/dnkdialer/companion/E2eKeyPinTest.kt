package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * E2E P4 Part 2 (e) — the C-2 pin, against E2E-SPEC §13.6.
 *
 * §13.6 opens by naming the failure this file exists to avoid: *"an unspecified
 * failure mode gets implemented fail-open, at which point the pin is
 * decorative."* So every branch of the table is asserted, in BOTH modes, and
 * each assertion carries a control proving it is not passing vacuously.
 */
class E2eKeyPinTest {

    private fun pub(): ByteArray {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toSec1(g.generateKeyPair().public)
    }

    private fun recipient(kind: String, id: String, key: ByteArray) =
        E2eNegotiation.Recipient(kind, id, key)

    private fun row(
        id: String,
        kind: String,
        key: ByteArray,
        revoked: String? = null,
    ) = E2eDeviceKeyClient.DeviceKeyRow(
        deviceId = id,
        kind = kind,
        publicKey = E2eKeyEncoding.toBase64Url(key),
        label = null,
        revokedAt = revoked,
    )

    private fun ok(rows: List<E2eDeviceKeyClient.DeviceKeyRow>) =
        E2eDeviceKeyClient.Result.Ok(rows)

    // ------------------------------------------------------------- the happy path

    @Test
    fun `matching keys verify in both modes`() {
        val webKey = pub()
        val swKey = pub()
        val recips = listOf(recipient("web", "w", webKey), recipient("extension", "s", swKey))
        val rows = ok(listOf(row("w", "web", webKey), row("s", "extension", swKey)))

        for (mode in listOf(true, false)) {
            val v = E2eKeyPin.verify(recips, rows, modeOn = mode)
            assertTrue("mode=$mode should verify, got $v", v is E2eKeyPin.Verdict.Verified)
            assertEquals(2, (v as E2eKeyPin.Verdict.Verified).checked)
            assertTrue(E2eKeyPin.mayProceed(v))
            assertTrue(E2eKeyPin.isVerified(v))
        }
    }

    // ------------------------------------------ mismatch: refuse in BOTH modes

    /**
     * §13.6 softens only the UNREACHABLE case. A key that actively disagrees
     * with the registry is the substitution the pin exists to catch, and "the
     * user had encryption off" is not a reason to accept a device key that is
     * demonstrably not the one on record.
     */
    @Test
    fun `a substituted key is refused in BOTH modes`() {
        val realKey = pub()
        val attackerKey = pub()
        val recips = listOf(recipient("web", "w", attackerKey))
        val rows = ok(listOf(row("w", "web", realKey)))

        for (mode in listOf(true, false)) {
            val v = E2eKeyPin.verify(recips, rows, modeOn = mode)
            assertTrue("mode=$mode must refuse a substituted key, got $v",
                v is E2eKeyPin.Verdict.Mismatch)
            assertEquals("Unexpected device key", (v as E2eKeyPin.Verdict.Mismatch).userMessage)
            assertTrue(v.logReason, v.logReason.contains("NOT the one on record"))
            assertTrue("a mismatch must never proceed", !E2eKeyPin.mayProceed(v))
            assertTrue(!E2eKeyPin.isVerified(v))
        }
        // CONTROL: the real key verifies, so the refusals above are about the
        // substitution and not about the fixture being broken.
        assertTrue(
            E2eKeyPin.verify(listOf(recipient("web", "w", realKey)), rows, true)
                is E2eKeyPin.Verdict.Verified
        )
    }

    /**
     * N-4 rotates by inserting a NEW row and setting revokedAt on the old one.
     * Accepting a revoked row would trust a retired key forever — the exact
     * hole revocation exists to close.
     */
    @Test
    fun `a revoked row does not satisfy a pin`() {
        val oldKey = pub()
        val newKey = pub()
        val rows = ok(
            listOf(
                row("w", "web", oldKey, revoked = "2026-09-17T00:00:00.000Z"),
                row("w2", "web", newKey),
            )
        )
        val v = E2eKeyPin.verify(listOf(recipient("web", "w", oldKey)), rows, true)
        assertTrue(v is E2eKeyPin.Verdict.Mismatch)
        assertTrue(
            "the reason should say the row is revoked, not merely 'missing'",
            (v as E2eKeyPin.Verdict.Mismatch).logReason.contains("REVOKED")
        )
        // CONTROL: the replacement row verifies.
        assertTrue(
            E2eKeyPin.verify(listOf(recipient("web", "w2", newKey)), rows, true)
                is E2eKeyPin.Verdict.Verified
        )
    }

    // -------------------------------------------- INC-0923: absent vs revoked
    //
    // The four conditions lane C made binding. Absent means the registry told
    // us NOTHING about the device, which is the same epistemic state as
    // unreachable; revoked means it told us the key is retired.

    /**
     * (1) Unregistered recipient + mode OFF ⇒ proceed, UNVERIFIED, no
     * Mismatch. This is INC-0923 itself: the extension's service worker
     * registers best-effort and gives up silently with no token, so an
     * advertised-but-unregistered SW is a routine client fault. v62 called it
     * Mismatch and hard-failed every pairing with "Unexpected device key".
     */
    @Test
    fun `an unregistered recipient fails OPEN and UNVERIFIED with the mode off`() {
        val web = pub()
        val sw = pub()
        val v = E2eKeyPin.verify(
            listOf(recipient("web", "w", web), recipient("extension", "sw", sw)),
            ok(listOf(row("w", "web", web))),
            modeOn = false,
        )
        assertTrue("absent row + mode OFF must NOT be a Mismatch", v is E2eKeyPin.Verdict.FailOpenUnverified)
        assertTrue(
            "the reason must name the recipient AND its kind",
            (v as E2eKeyPin.Verdict.FailOpenUnverified).logReason.contains("sw (extension) unregistered")
        )
        assertTrue("the pair proceeds", E2eKeyPin.mayProceed(v))
        assertTrue("and is NEVER badged verified", !E2eKeyPin.isVerified(v))
    }

    /**
     * (2) Unregistered recipient + mode ON ⇒ FailClosed, with the
     * try-again copy, not the substitution copy.
     */
    @Test
    fun `an unregistered recipient fails CLOSED with the mode on`() {
        val web = pub()
        val sw = pub()
        val v = E2eKeyPin.verify(
            listOf(recipient("web", "w", web), recipient("extension", "sw", sw)),
            ok(listOf(row("w", "web", web))),
            modeOn = true,
        )
        assertTrue(v is E2eKeyPin.Verdict.FailClosed)
        assertEquals(E2eKeyPin.FAIL_CLOSED_MESSAGE, (v as E2eKeyPin.Verdict.FailClosed).userMessage)
        assertTrue(v.logReason.contains("sw (extension) unregistered"))
        assertTrue("it must not proceed", !E2eKeyPin.mayProceed(v))
        // CONTROL: the same set with the SW row present verifies in mode ON,
        // so the failure above is the missing row and nothing else.
        assertTrue(
            E2eKeyPin.verify(
                listOf(recipient("web", "w", web), recipient("extension", "sw", sw)),
                ok(listOf(row("w", "web", web), row("sw", "extension", sw))),
                modeOn = true,
            ) is E2eKeyPin.Verdict.Verified
        )
    }

    /**
     * (3) A REVOKED row + mode OFF stays a Mismatch. The softening covers
     * "no answer", never "the answer is: retired". If revocation fell back to
     * fail-open whenever the user had the toggle off, a revoked key would be
     * unrevocable for exactly the users least protected.
     */
    @Test
    fun `a revoked row is still a Mismatch with the mode OFF`() {
        val k = pub()
        val v = E2eKeyPin.verify(
            listOf(recipient("web", "w", k)),
            ok(listOf(row("w", "web", k, revoked = "2026-09-23T00:00:00.000Z"))),
            modeOn = false,
        )
        assertTrue("revoked must never fail open", v is E2eKeyPin.Verdict.Mismatch)
        assertEquals(E2eKeyPin.MISMATCH_MESSAGE, (v as E2eKeyPin.Verdict.Mismatch).userMessage)
        assertTrue(v.logReason.contains("REVOKED"))
        assertTrue(!E2eKeyPin.mayProceed(v))
    }

    /**
     * An unregistered leg must not SHORT-CIRCUIT the rest of the set. If
     * `verify` returned FailOpenUnverified the moment it saw the missing SW
     * row, a substituted `web` key later in the same list would never be
     * examined — the softening would become the hole §13.6 warns about.
     */
    @Test
    fun `an unregistered leg does not mask a substituted one`() {
        val real = pub()
        val attacker = pub()
        val sw = pub()
        val v = E2eKeyPin.verify(
            // unregistered FIRST, substituted SECOND — the ordering that fails
            // if the implementation returns early.
            listOf(recipient("extension", "sw", sw), recipient("web", "w", attacker)),
            ok(listOf(row("w", "web", real))),
            modeOn = false,
        )
        assertTrue("the substitution must win over the soft verdict", v is E2eKeyPin.Verdict.Mismatch)
        assertTrue(
            (v as E2eKeyPin.Verdict.Mismatch).logReason.contains("NOT the one")
        )
    }

    @Test
    fun `an unknown deviceId with the mode on is refused`() {
        val k = pub()
        val v = E2eKeyPin.verify(
            listOf(recipient("web", "stranger", k)), ok(listOf(row("w", "web", k))), true
        )
        assertTrue(v is E2eKeyPin.Verdict.FailClosed)
        assertTrue((v as E2eKeyPin.Verdict.FailClosed).logReason.contains("unregistered"))
        assertTrue(!E2eKeyPin.mayProceed(v))
    }

    /**
     * §13.6 names `kind='extension'` explicitly, because the service worker is
     * the recipient whose code the user never sees and therefore the leg an
     * attacker would swap. A row registered as 'web' must not satisfy an
     * 'extension' recipient.
     */
    @Test
    fun `a kind mismatch is refused`() {
        val k = pub()
        val v = E2eKeyPin.verify(
            listOf(recipient("extension", "s", k)), ok(listOf(row("s", "web", k))), true
        )
        assertTrue(v is E2eKeyPin.Verdict.Mismatch)
        assertTrue((v as E2eKeyPin.Verdict.Mismatch).logReason.contains("kind"))
    }

    @Test
    fun `no recipients at all is a mismatch not a pass`() {
        val v = E2eKeyPin.verify(emptyList(), ok(emptyList()), true)
        assertTrue("an empty check must not read as verified", v is E2eKeyPin.Verdict.Mismatch)
    }

    @Test
    fun `an unusable registry key is a mismatch`() {
        val bad = E2eDeviceKeyClient.DeviceKeyRow("w", "web", "!!!not base64!!!", null, null)
        val v = E2eKeyPin.verify(listOf(recipient("web", "w", pub())), ok(listOf(bad)), true)
        assertTrue(v is E2eKeyPin.Verdict.Mismatch)
        assertTrue((v as E2eKeyPin.Verdict.Mismatch).logReason.contains("unusable"))
    }

    // ------------------------------- unreachable: THE branch §13.6 is about

    @Test
    fun `an unreachable registry fails CLOSED in mode ON and OPEN in mode OFF`() {
        val k = pub()
        val recips = listOf(recipient("web", "w", k))

        val failures = listOf(
            E2eDeviceKeyClient.Result.Unavailable("connect timed out"),
            E2eDeviceKeyClient.Result.PairingInFlight,
            E2eDeviceKeyClient.Result.Forbidden(403, "CSRF check failed"),
        )

        for (f in failures) {
            val on = E2eKeyPin.verify(recips, f, modeOn = true)
            assertTrue("$f in mode ON must fail CLOSED, got $on", on is E2eKeyPin.Verdict.FailClosed)
            assertEquals(
                "Couldn't verify this device — try again",
                (on as E2eKeyPin.Verdict.FailClosed).userMessage
            )
            assertTrue("fail-closed must not proceed", !E2eKeyPin.mayProceed(on))
            assertTrue(!E2eKeyPin.isVerified(on))

            val off = E2eKeyPin.verify(recips, f, modeOn = false)
            assertTrue("$f in mode OFF must fail OPEN, got $off",
                off is E2eKeyPin.Verdict.FailOpenUnverified)
            assertTrue("fail-open must proceed", E2eKeyPin.mayProceed(off))
            assertTrue(
                "…but the badge must stay UNVERIFIED — nothing was verified",
                !E2eKeyPin.isVerified(off)
            )
            assertTrue(
                "the warning must be diagnosable",
                (off as E2eKeyPin.Verdict.FailOpenUnverified).logReason.isNotBlank()
            )
        }
    }

    /**
     * The reason [E2eKeyPin.verify] takes a `Result` and not a `List`.
     *
     * Post-INC-0923 the two cases reach the SAME verdict class — both mean
     * "the registry said nothing about this device" — so the property that has
     * to hold is that they stay DISTINGUISHABLE in the log reason. An operator
     * reading logcat must be able to tell "the phone could not reach the
     * registry" from "the registry answered and the device is not in it": the
     * first is a network fault, the second is brief B's missing SW row.
     */
    @Test
    fun `an unreachable registry is not the same as an empty one`() {
        val recips = listOf(recipient("web", "w", pub()))
        val unreachable = E2eKeyPin.verify(
            recips, E2eDeviceKeyClient.Result.Unavailable("no route to host"), modeOn = false
        )
        val empty = E2eKeyPin.verify(recips, ok(emptyList()), modeOn = false)

        assertTrue(unreachable is E2eKeyPin.Verdict.FailOpenUnverified)
        assertTrue(empty is E2eKeyPin.Verdict.FailOpenUnverified)
        assertTrue(
            "an unreachable registry must say so",
            (unreachable as E2eKeyPin.Verdict.FailOpenUnverified)
                .logReason.contains("registry unreachable")
        )
        assertTrue(
            "an EMPTY registry is a real answer: this device is not registered",
            (empty as E2eKeyPin.Verdict.FailOpenUnverified)
                .logReason.contains("w (web) unregistered")
        )
        assertTrue(unreachable.logReason != empty.logReason)
        assertTrue(E2eKeyPin.mayProceed(unreachable))
        assertTrue(E2eKeyPin.mayProceed(empty))
        // CONTROL: with the mode ON neither proceeds — the softening is the
        // mode's doing, not the verdict's.
        assertTrue(
            !E2eKeyPin.mayProceed(E2eKeyPin.verify(recips, ok(emptyList()), modeOn = true))
        )
    }

    /**
     * mayProceed and isVerified must never be the same function. A fail-open
     * pairing proceeds but must not claim verification, and one method
     * answering both is how "proceeded" quietly becomes "verified".
     */
    @Test
    fun `proceeding and being verified are different questions`() {
        val open = E2eKeyPin.Verdict.FailOpenUnverified("registry down")
        assertTrue(E2eKeyPin.mayProceed(open))
        assertTrue(!E2eKeyPin.isVerified(open))
    }
}
