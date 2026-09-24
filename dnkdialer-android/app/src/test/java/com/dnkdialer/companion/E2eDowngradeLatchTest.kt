package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * vc67 — the phone half of `tests/e2e-sas-latch-vectors.json`
 * (RESUME-PROTOCOL v3.0 RULE 30). The node twin is
 * `tests/e2e-sas-latch-contract.test.mjs`, over the same file.
 *
 * ## What is under test, and with which instrument
 *
 *  1. **The rule** — [E2eNegotiation.DowngradeLatch.latchesOnRefusal], the pure
 *     function, row by row. The table IS the security property: a reader cannot
 *     tell a correct row from an incorrect one by looking at a call site, which
 *     is exactly how `TIMED_OUT` came to blind a room for the life of a process.
 *  2. **The consequence** — the REAL [E2eNegotiation.DowngradeLatch] driven
 *     through [E2eNegotiation.decide], because "does not latch" only matters if
 *     the next mode0 offer is then ACCEPTED. That is the user-visible half of
 *     the incident and it is asserted on the product object, not restated.
 *  3. **The call sites** — read out of `PhoneService.kt`. The accept path needs
 *     a relay socket, the Keystore and a bound Activity, so it has no JVM seam;
 *     and the defect class here is "a call site decided for itself", which only
 *     a source assertion can see.
 *  4. **The deadline** — the real [E2eSasGate.Pending] on real threads, with
 *     the millisecond values scaled down. The two-phase wait is a concurrency
 *     object and a re-implementation of it would prove nothing.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eDowngradeLatch*'`
 */
class E2eDowngradeLatchTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-sas-latch-vectors.json")

    private val service = File("src/main/java/com/dnkdialer/companion/PhoneService.kt")

    private val activity = File("src/main/java/com/dnkdialer/companion/MainActivity.kt")

    private fun root(): JsonObject {
        assertTrue("the shared vector file is missing at " + file.absolutePath, file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun latchRows(): List<JsonObject> {
        val rows = root().getAsJsonObject("latch").getAsJsonArray("rows").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously.
        assertEquals("the refusal reasons", 7, rows.size)
        return rows
    }

    /**
     * CRLF-safe source. A fresh checkout on Windows is CRLF and every regex
     * below would otherwise be reading prose it thinks is code.
     */
    private fun src(f: File): String {
        assertTrue(f.name + " not found at " + f.absolutePath, f.exists())
        return f.readText().replace("\r\n", "\n")
    }

    // ------------------------------------------------------------ (1) RULE

    @Test
    fun `every refusal reason latches exactly as the vector file says`() {
        for (row in latchRows()) {
            val id = row.get("id").asString
            val reason = E2eNegotiation.DowngradeLatch.RefusalReason
                .valueOf(row.get("reason").asString)
            assertEquals(
                "row $id: latchesOnRefusal($reason)",
                row.get("latches").asBoolean,
                E2eNegotiation.DowngradeLatch.latchesOnRefusal(reason),
            )
        }
    }

    /**
     * A reason added to the enum and not to the file would otherwise be
     * un-pinned — and un-pinned is how a new refusal path quietly inherits
     * "latch" because that is what the neighbouring line did.
     */
    @Test
    fun `the enum and the vector file name the same reasons`() {
        val inCode = E2eNegotiation.DowngradeLatch.RefusalReason.values().map { it.name }.toSet()
        val inFile = latchRows().map { it.get("reason").asString }.toSet()
        assertEquals("every RefusalReason must be pinned by a row", inCode, inFile)
    }

    /** Only a PEER weakening the pair latches. Stated once, as an invariant. */
    @Test
    fun `only the two peer-evidence reasons latch`() {
        val latching = E2eNegotiation.DowngradeLatch.RefusalReason.values()
            .filter { E2eNegotiation.DowngradeLatch.latchesOnRefusal(it) }
            .map { it.name }
            .toSet()
        assertEquals(setOf("PEER_OFFERED_NOTHING", "KEY_PIN_MISMATCH"), latching)
    }

    /** The key-pin door still latches a Mismatch, and still not a FailClosed. */
    @Test
    fun `latchesOn(verdict) agrees with the reason table`() {
        assertTrue(
            E2eNegotiation.DowngradeLatch.latchesOn(
                E2eKeyPin.Verdict.Mismatch("user", "substituted key")
            )
        )
        assertFalse(
            E2eNegotiation.DowngradeLatch.latchesOn(
                E2eKeyPin.Verdict.FailClosed("user", "registry unreachable")
            )
        )
    }

    // ----------------------------------------------------- (2) CONSEQUENCE

    /**
     * The real latch object: `latch(reason)` is a no-op for every reason the
     * rule rejects, so there is no way to set it by naming the wrong one.
     */
    @Test
    fun `latch(reason) sets the latch only for latching reasons`() {
        for (row in latchRows()) {
            val id = row.get("id").asString
            val reason = E2eNegotiation.DowngradeLatch.RefusalReason
                .valueOf(row.get("reason").asString)
            val latch = E2eNegotiation.DowngradeLatch()
            val set = latch.latch(reason)
            assertEquals("row $id: latch($reason) return", row.get("latches").asBoolean, set)
            assertEquals("row $id: isLatched after", row.get("latches").asBoolean, latch.isLatched)
        }
    }

    /**
     * THE INCIDENT, end to end on the product object: after each refusal, what
     * happens to the NEXT mode0 offer from the same peer.
     *
     * This is the assertion that would have gone red on vc66: `own-sas-timed-out`
     * expects the next offer ACCEPTED, and under the old behaviour
     * (`latch()` on TIMED_OUT) `decide` returns Abort with "downgrade latch is
     * set for this pair".
     */
    @Test
    fun `the next mode0 offer is accepted after a non-latching refusal`() {
        val mode0 = E2eNegotiation.parsePeerOffer(offerJson(mode = 0))
        for (row in latchRows()) {
            val id = row.get("id").asString
            val reason = E2eNegotiation.DowngradeLatch.RefusalReason
                .valueOf(row.get("reason").asString)
            val latch = E2eNegotiation.DowngradeLatch()
            latch.latch(reason)
            val next = E2eNegotiation.decide(localEnabled = false, offer = mode0, latch = latch)
            val accepted = next is E2eNegotiation.Decision.Encrypted
            assertEquals(
                "row $id: the next mode0 offer",
                row.get("nextOfferAccepted").asBoolean,
                accepted,
            )
            if (accepted) {
                // Accepted UNVERIFIED, which is SPEC 13.1's row for a pairing
                // neither side required — never silently plaintext.
                assertFalse(
                    "row $id: a 0/0 pair is sealed-but-unverified",
                    (next as E2eNegotiation.Decision.Encrypted).modeOn,
                )
            }
        }
    }

    /**
     * The REFUSED ruling's other half: the user compares FRESH digits next
     * time. Asserted where the freshness actually comes from — an Accept always
     * mints a new kid — rather than by trusting the vector row's prose.
     */
    @Test
    fun `a refused pair cannot be resumed and the next accept mints fresh digits`() {
        val row = latchRows().first { it.get("id").asString == "own-sas-refused" }
        assertTrue("the row must claim fresh digits", row.get("freshDigits").asBoolean)

        val accept = src(File("src/main/java/com/dnkdialer/companion/E2eAccept.kt"))
        assertTrue(
            "E2eAccept must mint a fresh kid on every Accept (freshEpoch = true)",
            Regex("freshEpoch\\s*=\\s*true").containsMatchIn(accept),
        )
        assertTrue(
            "E2eAccept must derive the kid from fresh randomness",
            Regex("val kid = newKid\\(\\)").containsMatchIn(accept),
        )
        // And the refused pair is genuinely gone: tearDownE2e nulls the session,
        // so there is no object a resume could carry forward.
        val tearDown = src(service).substringAfter("private fun tearDownE2e(")
            .substringBefore("\n    /**")
        assertTrue(
            "tearDownE2e must drop the session",
            Regex("e2eSession = null").containsMatchIn(tearDown),
        )
    }

    /** Unchanged by vc67: a latch that IS set clears only on local events. */
    @Test
    fun `the clear table is unchanged`() {
        val clear = root().getAsJsonObject("latch").getAsJsonObject("clear")
        for (event in E2eNegotiation.DowngradeLatch.Event.values()) {
            assertTrue(
                "the vector file must pin ${event.name}",
                clear.has(event.name),
            )
            assertEquals(
                "clearsLatch(${event.name})",
                clear.get(event.name).asBoolean,
                E2eNegotiation.DowngradeLatch.clearsLatch(event),
            )
        }
    }

    // ------------------------------------------------------ (3) CALL SITES

    /**
     * Every latch in PhoneService goes through `latchForRefusal`, which applies
     * the rule. A bare `e2eDowngradeLatch.latch(...)` is a call site that
     * decided for itself, and that is the defect class, not an instance of it.
     */
    @Test
    fun `no call site latches without going through the rule`() {
        val sites = root().getAsJsonObject("latch").getAsJsonObject("callSites")
        val s = src(service)
        val bare = Regex("e2eDowngradeLatch\\.latch\\(").findAll(s).count()
        // The one legitimate occurrence is INSIDE latchForRefusal itself.
        val door = sites.get("door").asString
        val doorBody = s.substringAfter("private fun $door(").substringBefore("\n    /**")
        assertEquals(
            "the only e2eDowngradeLatch.latch( call must be inside $door",
            1,
            bare,
        )
        assertTrue(
            "$door must be the one that calls it",
            Regex("e2eDowngradeLatch\\.latch\\(reason\\)").containsMatchIn(doorBody),
        )
        assertEquals(
            "the vector file pins zero bare latch calls outside the door",
            sites.get("bareLatchCalls").asInt,
            bare - 1,
        )
        // And the refusal paths actually use it: pin + malformed + SAS + the
        // two crypto-failure arms.
        assertTrue(
            "every refusal path must name a reason",
            Regex("$door\\(").findAll(s).count() >= 5,
        )
    }

    /** The SAS refusal path must map the VERDICT, never latch unconditionally. */
    @Test
    fun `the sas refusal path latches by verdict`() {
        val s = src(service)
        assertTrue(
            "the SAS refusal must go through refusalReasonFor(sas)",
            Regex("latchForRefusal\\(refusalReasonFor\\(sas\\)\\)").containsMatchIn(s),
        )
        // The mapping itself, on the real function's outputs.
        val map = mapOf(
            E2eSasGate.Verdict.TIMED_OUT to "SAS_TIMED_OUT",
            E2eSasGate.Verdict.REFUSED to "SAS_REFUSED",
            E2eSasGate.Verdict.CANCELLED to "SAS_NOT_SHOWN",
            E2eSasGate.Verdict.MALFORMED to "SAS_MALFORMED",
        )
        val body = s.substringAfter("private fun refusalReasonFor(").substringBefore("\n    /**")
        for ((verdict, reason) in map) {
            assertTrue(
                "refusalReasonFor must map $verdict to $reason",
                Regex("Verdict\\.${verdict.name}\\s*->[\\s\\S]{0,120}$reason")
                    .containsMatchIn(body),
            )
            assertFalse(
                "$verdict must not latch",
                E2eNegotiation.DowngradeLatch.latchesOnRefusal(
                    E2eNegotiation.DowngradeLatch.RefusalReason.valueOf(reason)
                ),
            )
        }
    }

    // --------------------------------------------------------- (4) DEADLINE

    @Test
    fun `the two deadlines are the values the vector file pins`() {
        val t = root().getAsJsonObject("timeout")
        val s = src(service)
        val pending = Regex("PENDING_REQUEST_TIMEOUT_MS = ([0-9_]+)L").find(s)
        val surfaced = Regex("SAS_SURFACED_TIMEOUT_MS = ([0-9_]+)L").find(s)
        assertTrue("PENDING_REQUEST_TIMEOUT_MS not found", pending != null)
        assertTrue("SAS_SURFACED_TIMEOUT_MS not found", surfaced != null)
        assertEquals(
            "the unacked deadline",
            t.get("unsurfacedMs").asLong,
            pending!!.groupValues[1].replace("_", "").toLong(),
        )
        assertEquals(
            "the acked deadline",
            t.get("surfacedMs").asLong,
            surfaced!!.groupValues[1].replace("_", "").toLong(),
        )
        // And the accept path passes BOTH — a constant nobody reads is not a
        // deadline, it is a comment.
        assertTrue(
            "the SAS await must be given the long deadline",
            Regex("surfacedTimeoutMs = SAS_SURFACED_TIMEOUT_MS").containsMatchIn(s),
        )
    }

    /**
     * Row `surface-acked-long-window`: an answer AFTER the short deadline is
     * honoured once the UI acked. Scaled to milliseconds — the subject is the
     * two-phase wait, not the constants, which the test above pins.
     */
    @Test
    fun `an acked prompt is answered after the short deadline`() {
        val pending = E2eSasGate.Pending("pair-1")
        val pool = Executors.newSingleThreadExecutor()
        try {
            assertTrue(pending.markSurfaced("pair-1"))
            assertTrue(pending.isSurfaced)
            pool.execute {
                Thread.sleep(150)
                pending.answer("pair-1", matched = true)
            }
            assertEquals(
                E2eSasGate.Verdict.MATCHED,
                pending.await(unsurfacedMs = 40, surfacedMs = 2_000),
            )
        } finally {
            pool.shutdownNow()
            pool.awaitTermination(2, TimeUnit.SECONDS)
        }
    }

    /** Row `surface-acked-still-bounded`: the long window is still a window. */
    @Test
    fun `an acked prompt nobody answers still times out`() {
        val pending = E2eSasGate.Pending("pair-1")
        pending.markSurfaced("pair-1")
        val t0 = System.nanoTime()
        assertEquals(
            E2eSasGate.Verdict.TIMED_OUT,
            pending.await(unsurfacedMs = 30, surfacedMs = 120),
        )
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("it must have waited past the short deadline, waited ${ms}ms", ms >= 100)
    }

    /** Row `activity-absent-fails-closed-30s`: no ack, no extension. */
    @Test
    fun `an unacked prompt fails closed on the short deadline`() {
        val pending = E2eSasGate.Pending("pair-1")
        val t0 = System.nanoTime()
        assertEquals(
            E2eSasGate.Verdict.TIMED_OUT,
            pending.await(unsurfacedMs = 60, surfacedMs = 5_000),
        )
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("it must NOT have taken the long deadline, waited ${ms}ms", ms < 2_000)
        assertFalse(pending.isSurfaced)
    }

    /** Row `ack-for-another-pairing-ignored`. */
    @Test
    fun `an ack for another pairing extends nothing`() {
        val pending = E2eSasGate.Pending("pair-1")
        assertFalse(pending.markSurfaced("some-other-pairing"))
        assertFalse(pending.isSurfaced)
        val t0 = System.nanoTime()
        assertEquals(
            E2eSasGate.Verdict.TIMED_OUT,
            pending.await(unsurfacedMs = 60, surfacedMs = 5_000),
        )
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 2_000)
    }

    /** An ack can only EXTEND: it never decides and never approves. */
    @Test
    fun `an ack cannot approve a pairing`() {
        val pending = E2eSasGate.Pending("pair-1")
        pending.markSurfaced("pair-1")
        assertEquals(
            E2eSasGate.Verdict.TIMED_OUT,
            pending.await(unsurfacedMs = 20, surfacedMs = 40),
        )
    }

    /** A cancel still beats both deadlines — teardown is never blocked. */
    @Test
    fun `a cancel resolves an acked wait immediately`() {
        val pending = E2eSasGate.Pending("pair-1")
        pending.markSurfaced("pair-1")
        val pool = Executors.newSingleThreadExecutor()
        try {
            pool.execute {
                Thread.sleep(30)
                pending.cancel()
            }
            assertEquals(
                E2eSasGate.Verdict.CANCELLED,
                pending.await(unsurfacedMs = 20, surfacedMs = 10_000),
            )
        } finally {
            pool.shutdownNow()
            pool.awaitTermination(2, TimeUnit.SECONDS)
        }
    }

    // ------------------------------------------------- (4b) the ack's wiring

    @Test
    fun `the ack action is the contract constant and carries no digits`() {
        val t = root().getAsJsonObject("timeout")
        assertEquals(
            "the vector file and the contract must name one action",
            t.get("ackAction").asString,
            E2eSasContract.ACTION_E2E_SAS_SHOWN,
        )
        assertFalse("the ack must not carry digits", t.get("ackCarriesDigits").asBoolean)

        // Sliced from showSasConfirm only, so a match elsewhere in a 5,000-line
        // Activity cannot satisfy it.
        val show = src(activity).substringAfter("private fun showSasConfirm")
            .substringBefore("private fun hideSasConfirm")
        assertTrue("showSasConfirm not found", show.isNotEmpty())
        assertTrue(
            "showSasConfirm must ack once the digits are on screen",
            Regex("ACTION_E2E_SAS_SHOWN").containsMatchIn(show),
        )
        assertFalse(
            "the ack must not put the digits back on a broadcast",
            Regex("ACTION_E2E_SAS_SHOWN[\\s\\S]{0,400}EXTRA_SAS_DIGITS").containsMatchIn(show),
        )
        // It must be sent AFTER the malformed-payload refusal, or a payload the
        // Activity refused would still buy the long deadline.
        assertTrue(
            "the malformed refusal must precede the ack",
            show.indexOf("dispatchSasVerdict(matched = false") <
                show.indexOf("ACTION_E2E_SAS_SHOWN"),
        )
    }

    /** Expiry: the existing LEAVE_ACTIVE funnel, and copy that tells the truth. */
    @Test
    fun `expiry tears the pair down and says what happened`() {
        val t = root().getAsJsonObject("timeout")
        assertEquals(
            "the expiry verdict",
            t.get("expiryVerdict").asString,
            E2eSasGate.Verdict.TIMED_OUT.name,
        )
        assertEquals(
            "the expiry copy",
            t.get("expiryCopy").asString,
            E2eNegotiation.SAS_TIMEOUT_MESSAGE,
        )
        val s = src(service)
        val refusal = s.substringAfter("if (!E2eSasGate.mayProceed(sas)) {")
            .substringBefore("// Verified. Open the data plane")
        assertTrue("the SAS refusal arm not found", refusal.isNotEmpty())
        assertTrue(
            "expiry must use the existing ${t.get("expiryTeardown").asString} funnel",
            refusal.contains("leaveActivePair("),
        )
        assertTrue(
            "a timed-out SAS must not be reported as a failed setup",
            Regex("Verdict\\.TIMED_OUT[\\s\\S]{0,120}SAS_TIMEOUT_MESSAGE").containsMatchIn(refusal),
        )
        assertTrue("the pair is still torn down", refusal.contains("tearDownE2e("))
    }

    // --------------------------------------------------------------- helpers

    private fun validPub(): ByteArray {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return E2eKeyEncoding.toSec1(g.generateKeyPair().public)
    }

    private fun offerJson(mode: Int): JsonObject {
        val o = JsonObject()
        o.addProperty("v", 1)
        o.addProperty("mode", mode)
        val arr = com.google.gson.JsonArray()
        for ((kind, id) in listOf("web" to "dev-web", "extension" to "dev-sw")) {
            val r = JsonObject()
            r.addProperty("kind", kind)
            r.addProperty("deviceId", id)
            r.addProperty("pub", E2eKeyEncoding.toBase64Url(validPub()))
            arr.add(r)
        }
        o.add("recips", arr)
        return o
    }
}
