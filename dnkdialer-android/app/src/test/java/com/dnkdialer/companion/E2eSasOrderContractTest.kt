package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * INC-0924 — the phone half of `tests/e2e-sas-order-vectors.json`
 * (RESUME-PROTOCOL v3.0 RULE 30).
 *
 * The web half is `tests/e2e-sas-order-contract.test.mjs`, reading the same
 * file. Two surfaces implement one ordering, and the only thing that catches
 * them disagreeing is a fixture neither of them authored alone.
 *
 * ## Three different instruments, on purpose
 *
 *  1. **The ORDER** is read out of `PhoneService.kt` itself. The accept path
 *     needs a relay socket, the Keystore and a bound Activity, so it has no
 *     JVM seam — and the defect was not a wrong value, it was two correct
 *     statements in the wrong order. A source assertion is the only instrument
 *     that can see that, and it goes red the moment they are swapped back.
 *  2. **The WINDOW** is asserted against a REAL [E2eFrameGate], constructed
 *     the way [PhoneService] constructs it. Not a re-implementation of the
 *     rule: the product object, told it is mid-SAS, asked what it does with a
 *     §13.7 frame.
 *  3. **The VERDICTS** go through the real [E2eSasGate.mayProceed].
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eSasOrderContract*'`
 */
class E2eSasOrderContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-sas-order-vectors.json")

    private val service = File("src/main/java/com/dnkdialer/companion/PhoneService.kt")

    private fun root(): JsonObject {
        assertTrue("the shared vector file is missing at " + file.absolutePath, file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun rows(): List<JsonObject> {
        val rows = root().getAsJsonArray("rows").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously.
        assertEquals("the ordering scenarios", 8, rows.size)
        return rows
    }

    private fun row(id: String): JsonObject =
        rows().firstOrNull { it.get("id").asString == id }
            ?: throw AssertionError("the vector file no longer carries row $id")

    private fun phone(row: JsonObject): JsonObject? =
        row.getAsJsonObject("phone")

    // ------------------------------------------------------------ (1) ORDER

    /**
     * The fix itself: `ACCEPT_PAIRING` leaves BEFORE the user is prompted.
     *
     * Sliced from the accept function only, so a match anywhere else in this
     * 4,000-line file cannot satisfy it.
     */
    @Test
    fun the_accept_is_sent_before_the_user_is_prompted() {
        val ordering = root().getAsJsonObject("ordering")
        assertTrue(
            "the vector file must demand the ACCEPT-first order",
            ordering.get("acceptBeforePrompt").asBoolean
        )
        assertTrue("PhoneService.kt not found at " + service.absolutePath, service.exists())
        // CRLF-safe: a fresh checkout on Windows is CRLF and every regex below
        // would otherwise be reading prose it thinks is code.
        val src = service.readText().replace("\r\n", "\n")

        val fnStart = src.indexOf("private fun completeEncryptedAccept(")
        assertTrue("completeEncryptedAccept has been renamed or removed", fnStart >= 0)
        val fnEnd = src.indexOf("\n    private fun broadcastE2eRefusal", fnStart)
        assertTrue("could not find the end of the accept path", fnEnd > fnStart)
        val body = src.substring(fnStart, fnEnd)
        // A slice that silently came back empty passes every assertion below
        // for free, so prove it is the real body first.
        assertTrue("the accept body did not slice (got ${body.length} chars)", body.length > 2000)

        val accept = body.indexOf(ordering.get("acceptCall").asString)
        val prompt = body.indexOf(ordering.get("promptCall").asString)
        assertTrue("the ACCEPT send is gone from the accept path", accept >= 0)
        assertTrue("the SAS prompt is gone from the accept path", prompt >= 0)
        assertTrue(
            "INC-0924: ACCEPT_PAIRING must be sent BEFORE E2eSasGate.await — the computer " +
                "derives its digits from that ACCEPT, so prompting first asks the user to " +
                "compare a code against a blank screen (accept@$accept prompt@$prompt)",
            accept < prompt
        )

        // And the refusal after an ACCEPT must end the ACTIVE pair, not answer
        // a request the relay has already resolved.
        val refusal = row("phone-mismatch-abort").getAsJsonObject("phone")
            .get("teardownFrame").asString
        assertTrue(
            "a SAS refusal after the ACCEPT must tear the pair down with $refusal",
            body.contains("leaveActivePair(\"SAS not confirmed\")")
        )
        assertTrue(
            "$refusal must be the frame leaveActivePair sends",
            src.contains("sendResponse(\"$refusal\"")
        )
    }

    /**
     * The window has to be ARMED before the ACCEPT leaves, not after: the peer
     * may answer the instant it lands, and a gate armed one statement later
     * would have let that first frame through.
     */
    @Test
    fun the_frame_window_is_armed_before_the_accept_leaves() {
        val src = service.readText().replace("\r\n", "\n")
        val fnStart = src.indexOf("private fun completeEncryptedAccept(")
        val fnEnd = src.indexOf("\n    private fun broadcastE2eRefusal", fnStart)
        val body = src.substring(fnStart, fnEnd)
        assertTrue("the accept body did not slice", body.length > 2000)

        val arm = body.indexOf("e2eSasPending = prepared.modeOn")
        val accept = body.indexOf("sendPairingDecision(\"ACCEPT_PAIRING\"")
        assertTrue("the SAS window is never armed", arm >= 0)
        assertTrue(
            "e2eSasPending must be set BEFORE the ACCEPT leaves (arm@$arm accept@$accept)",
            arm in 0 until accept
        )
        assertTrue(
            "the gate must read the window",
            src.contains("E2eFrameGate({ e2eSession }, { e2eLatchedOn }, { e2eSasPending })")
        )
    }

    // ----------------------------------------------------------- (2) WINDOW

    /**
     * The gate, told it is mid-SAS, over every row that states an expectation.
     *
     * `PHONE_NOTIFICATION` is the §13.7 type the phone actually emits and
     * `SEND_SMS` the one it actually receives, so the two directions are
     * exercised with frames the product really carries rather than a
     * hand-picked easy case.
     */
    @Test
    fun the_frame_gate_matches_every_row_that_states_one() {
        var checked = 0
        for (r in rows()) {
            val id = r.get("id").asString
            val p = phone(r) ?: continue
            val pending = p.get("sasPending")?.asBoolean ?: false
            // The gate as PhoneService builds it: a live session, latched, and
            // the window's flag. A null session would make every answer a drop
            // for the wrong reason, so the sealed path has to be reachable.
            val gate = E2eFrameGate(
                sessionProvider = { null },
                latchedProvider = { true },
                sasPendingProvider = { pending },
            )

            p.get("sealedOutbound")?.let { want ->
                checked++
                val out = gate.outbound("PHONE_NOTIFICATION", "{\"title\":\"x\"}")
                when (want.asString) {
                    "drop" -> {
                        assertEquals("$id: a sealed frame must be DROPPED, never downgraded", null, out)
                        assertTrue(
                            "$id: the drop must name the SAS window, not the latch",
                            gate.lastDropReason?.contains("sas pending") == true
                        )
                    }
                    // "send" cannot be asserted against a null session (there
                    // is nothing to seal with); what it asserts is that the
                    // WINDOW is not what stops it. The reason proves which
                    // arm refused.
                    "send" -> assertFalse(
                        "$id: the SAS window must be open after a MATCH",
                        gate.lastDropReason?.contains("sas pending") == true
                    )
                    else -> throw AssertionError("$id: unknown sealedOutbound ${want.asString}")
                }
            }

            p.get("sealedInbound")?.let { want ->
                checked++
                val gateIn = E2eFrameGate(
                    sessionProvider = { null },
                    latchedProvider = { true },
                    sasPendingProvider = { pending },
                )
                val res = gateIn.inbound("SEND_SMS", "{\"to\":\"x\"}")
                if (want.asString == "drop") {
                    assertTrue("$id: inbound must be dropped", res is E2eFrameGate.Inbound.Drop)
                    assertTrue(
                        "$id: dropped for the SAS window",
                        (res as E2eFrameGate.Inbound.Drop).reason.contains("sas pending")
                    )
                } else {
                    // Not the window's doing, whatever else happens to it.
                    val reason = (res as? E2eFrameGate.Inbound.Drop)?.reason ?: ""
                    assertFalse("$id: the window must be open", reason.contains("sas pending"))
                }
            }
        }
        assertTrue("no row stated a frame expectation — the file lost its rows", checked >= 8)
    }

    /**
     * A frame type §13.7 leaves in the clear is untouched by the window. The
     * window withholds USER DATA; it is not a general mute, and muting
     * `GET_MESSAGES` would move tier enforcement off the relay.
     */
    @Test
    fun the_window_never_touches_a_plaintext_type() {
        val gate = E2eFrameGate({ null }, { true }, { true })
        assertEquals("{}", gate.outbound("GET_MESSAGES", "{}"))
        val res = gate.inbound("GET_MESSAGES", "{}")
        assertTrue(res is E2eFrameGate.Inbound.Deliver)
        assertEquals(0L, gate.droppedOutbound)
    }

    // --------------------------------------------------------- (3) VERDICTS

    @Test
    fun every_verdict_in_the_file_matches_may_proceed() {
        var checked = 0
        for (r in rows()) {
            val id = r.get("id").asString
            val p = phone(r) ?: continue
            val v = p.get("verdict") ?: continue
            if (v.isJsonNull) continue
            val want = p.get("mayProceed")?.asBoolean ?: continue
            checked++
            assertEquals(
                "$id: ${E2eSasGate.Verdict.valueOf(v.asString)}",
                want,
                E2eSasGate.mayProceed(E2eSasGate.Verdict.valueOf(v.asString))
            )
        }
        assertTrue("no verdict rows survived in the file", checked >= 4)
        // MATCHED and NOT_REQUIRED are the ONLY two. Silence, a cancel and a
        // "doesn't match" are one outcome downstream by design.
        for (verdict in E2eSasGate.Verdict.values()) {
            val expected = verdict == E2eSasGate.Verdict.MATCHED ||
                verdict == E2eSasGate.Verdict.NOT_REQUIRED
            assertEquals("$verdict", expected, E2eSasGate.mayProceed(verdict))
        }
    }

    /**
     * The forbidden row. It has no value to compare — what it pins is that the
     * product no longer contains the old shape, which the ordering test above
     * asserts positively. This case exists so that DELETING that row from the
     * file is a failure rather than a quiet loss of the incident's memory.
     */
    @Test
    fun the_old_phone_first_ordering_is_still_recorded_as_forbidden() {
        val old = row("phone-first-confirm")
        assertTrue("the phone-first row must stay marked forbidden", old.get("forbidden").asBoolean)
        val p = old.getAsJsonObject("phone")
        assertFalse("the old order sent no ACCEPT before prompting", p.get("acceptSent").asBoolean)
        assertTrue("the old order prompted", p.get("sasPrompted").asBoolean)
        assertFalse(
            "and the computer had no digits to compare against",
            old.getAsJsonObject("browser").get("hasDigits").asBoolean
        )
    }

    /**
     * The kill-switch row is recorded, NOT endorsed. Whether a phone with a
     * local ON should still force a SAS-blocking pair while
     * `E2E_PAIRING_ENABLED=0` is a Security question, and this lane's job is
     * to make the current answer visible rather than to change it.
     */
    @Test
    fun the_kill_switch_row_is_documented_not_endorsed() {
        val r = row("killswitch-off-phone-on")
        assertTrue(r.get("documentedNotEndorsed").asBoolean)
        val p = r.getAsJsonObject("phone")
        // The behaviour itself, through the real decision table: the phone's
        // own ON is enough, whatever the relay's switch says.
        assertEquals(
            E2eSettings.EffectiveMode.valueOf(p.get("effectiveMode").asString),
            E2eSettings.effectiveMode(
                localEnabled = true,
                peer = E2eSettings.PeerAdvertisement.OFF,
            )
        )
        assertEquals(
            p.get("requiresSas").asBoolean,
            E2eSettings.requiresSas(E2eSettings.EffectiveMode.ENCRYPTED_VERIFIED)
        )
    }

    // ------------------------------------------- (4) THE STATUS THE PHONE SHOWS

    /**
     * INC-0924 Security F-1 (C1). What the phone TELLS ITS OWN USER while the
     * SAS dialog is unanswered.
     *
     * `e2eVerified` is the key-pin verdict alone. Against a TOFU-pinned peer
     * it is already `true` when `broadcastE2eState()` runs one line above
     * `sendPairingDecision("ACCEPT_PAIRING", ...)` — i.e. at the TOP of the
     * window — so the un-amended predicate badged the pair "Encrypted and
     * verified" at the exact moment it was asking the user to verify it. That
     * is a tap-through prime, and a tap-through is the only thing that defeats
     * this SAS.
     *
     * Two instruments, because [E2eStatusCopy.stateOf] is unchanged and a value
     * test alone would pass over the old one-arg call:
     *  - the VALUE, through the real `stateOf`, over every row that states a
     *    `statusState` (`accept-then-both-confirm` is the control: a predicate
     *    that answered UNVERIFIED unconditionally passes the window row and
     *    fails that one);
     *  - the PREDICATE, read out of `PhoneService.currentE2eState` itself,
     *    which is the only instrument that sees `&& !e2eSasPending` go missing.
     */
    @Test
    fun the_phone_reports_unverified_for_the_whole_sas_window() {
        var checked = 0
        for (r in rows()) {
            val id = r.get("id").asString
            val p = phone(r) ?: continue
            val want = p.get("statusState")?.asString ?: continue
            val pinned = p.get("keyPinVerified").asBoolean
            val pending = p.get("sasPending").asBoolean
            checked++
            assertEquals(
                "$id: keyPinVerified=$pinned sasPending=$pending",
                E2eStatusCopy.State.valueOf(want),
                E2eStatusCopy.stateOf(encrypted = true, verified = pinned && !pending),
            )
        }
        assertEquals("both status rows must survive in the file", 2, checked)

        val src = service.readText().replace("\r\n", "\n")
        val fnStart = src.indexOf("fun currentE2eState()")
        assertTrue("currentE2eState has been renamed or removed", fnStart >= 0)
        val fnEnd = src.indexOf("private fun broadcastE2eState", fnStart)
        assertTrue("could not find the end of currentE2eState", fnEnd > fnStart)
        val body = src.substring(fnStart, fnEnd)
        assertTrue("currentE2eState did not slice (got ${body.length} chars)", body.length > 120)
        assertTrue(
            "Security F-1: currentE2eState must report UNVERIFIED while the phone's own " +
                "SAS dialog is unanswered — verified = e2eVerified && !e2eSasPending",
            body.contains("verified = e2eVerified && !e2eSasPending"),
        )
    }

    /**
     * C2 (Security F-3). The refusal counters are the ONLY forensic trace of
     * this window — a field MITM attempt leaves nothing else behind. There is
     * no allowlist to add them to: `DiagLog.counter` is an open registry and
     * every name it is given is persisted to `counters.json` and shipped
     * verbatim in the export zip. So what needs pinning is that the two call
     * sites still exist, spelled the way a field zip will be grepped for.
     */
    @Test
    fun the_window_refusals_leave_a_counter_behind() {
        val src = service.readText().replace("\r\n", "\n")
        for (name in listOf("e2e.sas.refused-after-accept", "e2e.sas.malformed")) {
            assertTrue(
                "the only forensic trace of a refused SAS is DiagLog.counter(\"$name\")",
                src.contains("DiagLog.counter(\"$name\")"),
            )
        }
    }
}
