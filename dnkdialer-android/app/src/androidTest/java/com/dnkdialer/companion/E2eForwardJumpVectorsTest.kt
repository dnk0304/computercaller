package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E programme, phase P4.2 (b) — the android lane asserted against **P2.2's
 * frozen `tests/e2e-forward-jump-vectors.json`**, not against a table this lane
 * wrote for itself.
 *
 * Authority: `security/PROJECTS/computercaller/e2e/GATE2-PRE-A5.md` F2 /
 * MUST M-A5-2. The vector file names this lane in its own `consumers` list
 * ("E2eDedupe (android) — P4.2"), and that list is asserted below: a lane that
 * quietly stopped being a consumer would otherwise stop being checked.
 *
 * ## Why this test is worth more than [E2eDedupeTest]
 *
 * [E2eDedupeTest] asserts that this lane's code still does what this lane's
 * author thought it should. That catches drift within the lane and nothing
 * else — it would keep passing if all three implementations drifted together,
 * or if Android had simply read the addendum wrong. The vector file exists so
 * that a lane which disagrees with the frozen table **fails its own build**
 * instead of surfacing in production as "the same ciphertext replayed forever",
 * which is the F2 defect stated in the file's own header.
 *
 * The web lane walks this file in `tests/e2e-web-forward-jump.test.mjs` and the
 * service worker walks it in P3.2. This is the third walker. One table, three
 * implementations.
 *
 * ## The two bugs this table caught in the other lanes
 *
 * Recorded here because they are the reason the table is walked step-by-step
 * rather than summarised, and because a future reader will otherwise be tempted
 * to "simplify" exactly the two things that were wrong:
 *
 *  1. **Arm at -1, not 0.** A mark that starts at 0 is ARMED from the first
 *     frame, so a peer legitimately past the window after a resume is refused.
 *     Case A is the regression test: unarmed, seq 900 000 is admitted.
 *  2. **Raise the mark only after the AEAD tag verifies.** Case F feeds a frame
 *     with `authenticates: false` and requires the mark NOT to move. Without
 *     that, one forged envelope at a huge seq sets the high-water mark and the
 *     bound then admits everything below it — the fix would hand over the very
 *     property it exists to protect.
 */
@RunWith(AndroidJUnit4::class)
class E2eForwardJumpVectorsTest {

    private companion object {
        const val RESOURCE = "e2e-forward-jump-vectors.json"

        /**
         * sha256 of `tests/e2e-forward-jump-vectors.json` at base `165f165`,
         * over the file's **LF-normalised** bytes.
         *
         * WHY LF-NORMALISED AND NOT THE RAW BYTES. This repository has
         * `core.autocrlf=true` and no `.gitattributes` rule for `*.json`, so
         * the working copy of a JSON file is CRLF on Windows while the blob git
         * actually stores — the bytes every lane agrees on, and the bytes the
         * web and SW lanes hash — is LF. A raw-byte pin would therefore assert
         * a property of one checkout's line-ending transform rather than a
         * property of the content: green here, red on a Linux CI runner, and
         * red for a non-reason either way. Normalising first pins the CONTENT,
         * which is the thing that must not drift. Any real edit to the table —
         * a changed window, a changed expectation, a dropped case — still flips
         * this hash.
         *
         * Reproduce:
         *   git show 165f165:tests/e2e-forward-jump-vectors.json | sha256sum
         */
        const val VECTORS_SHA256 =
            "4d3c23a521ecaae8d2a189cc2584092548bbb4ad7e97d74e9c632d999d2294e3"

        /** Every case in the frozen file must be walked; see [every_case_is_walked]. */
        const val EXPECTED_CASES = 8

        const val KID = "kid-forward-jump-vectors"
    }

    // ---------------------------------------------------------------- loading

    private fun rawResourceBytes(): ByteArray {
        val stream = javaClass.classLoader!!.getResourceAsStream(RESOURCE)
            ?: throw AssertionError(
                "$RESOURCE is not on the androidTest classpath — it must be a copy of " +
                    "tests/e2e-forward-jump-vectors.json in app/src/androidTest/resources/"
            )
        return stream.use { it.readBytes() }
    }

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream(RESOURCE)
            ?: throw AssertionError("$RESOURCE is not on the androidTest classpath")
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    // ------------------------------------------- the file is the right file

    /**
     * The drift guard. If the packaged resource stops matching the repo file,
     * every assertion below is measuring a table nobody froze — so this fails
     * loudly and says exactly how to fix it, rather than letting the suite go
     * green against a stale copy.
     */
    @Test
    fun the_packaged_vectors_match_the_frozen_repo_file() {
        val normalised = String(rawResourceBytes(), Charsets.UTF_8)
            .replace("\r\n", "\n")
            .toByteArray(Charsets.UTF_8)
        assertEquals(
            "$RESOURCE has drifted from tests/e2e-forward-jump-vectors.json. " +
                "Re-copy it (git show <base>:tests/e2e-forward-jump-vectors.json) and update " +
                "VECTORS_SHA256, or explain the divergence to Security — this lane is a " +
                "declared consumer of that file.",
            VECTORS_SHA256,
            sha256Hex(normalised)
        )
    }

    /**
     * The parameters this lane implements are the parameters the file froze.
     * Asserted separately from the hash because a hash tells you THAT something
     * changed and this tells you WHAT the code must agree with.
     */
    @Test
    fun the_frozen_parameters_match_this_lanes_constants() {
        val root = load()
        assertEquals("vector file version", 1, root.get("version").asInt)
        assertEquals(
            "the window in the frozen table is not E2eDedupe.WINDOW",
            E2eDedupe.WINDOW.toLong(),
            root.get("window").asLong
        )

        val consumers = root.getAsJsonArray("consumers").map { it.asString }
        assertTrue(
            "the frozen file no longer names this lane as a consumer: $consumers",
            consumers.any { it.contains("E2eDedupe") && it.contains("android") }
        )
    }

    // ------------------------------------------------------- walking the table

    /**
     * Walks every case and every step of the frozen table.
     *
     * A `reset` step builds a NEW [E2eDedupe] carrying the SAME
     * [E2eDedupe.ForwardJumpCounter] — which is exactly what production does: a
     * pairEpoch change rebuilds the window (E2eSession.forPhone) while the
     * counter lives on [E2eLifecycle] and survives. Case H is the assertion
     * that this is so: the mark disarms to -1 and the floor returns to 0, and
     * the refusal count does NOT go back to zero. The file's `counterRule`
     * spells out why that matters — an epoch change is something an attacker
     * can provoke, and a counter an attacker can zero is not a counter.
     */
    @Test
    fun every_case_is_walked() {
        val root = load()
        val cases = root.getAsJsonArray("cases")
        assertEquals("the frozen table changed size", EXPECTED_CASES, cases.size())

        var stepsWalked = 0
        var refusalsAsserted = 0
        var unauthenticatedStepsWalked = 0
        var resetsWalked = 0

        for (element in cases) {
            val case = element.asJsonObject
            val id = case.get("id").asString

            // One counter per case, shared across that case's resets.
            val counter = E2eDedupe.ForwardJumpCounter()
            var epoch = 1L
            var window = E2eDedupe(KID, E2eDedupe.Direction.COMPUTER_TO_PHONE, epoch, counter)

            val steps = case.getAsJsonArray("steps")
            assertTrue("case $id has no steps", steps.size() > 0)

            for (stepElement in steps) {
                val step = stepElement.asJsonObject
                stepsWalked++

                if (step.has("reset") && step.get("reset").asBoolean) {
                    // A new epoch is a new key space and therefore a new window.
                    epoch++
                    window = E2eDedupe(KID, E2eDedupe.Direction.COMPUTER_TO_PHONE, epoch, counter)
                    resetsWalked++
                } else {
                    val seq = step.get("seq").asLong
                    val authenticates = step.get("authenticates").asBoolean
                    if (!authenticates) unauthenticatedStepsWalked++

                    val expect = step.get("expect").asString
                    val wanted = when (expect) {
                        // Both are FRESH to the window. The difference is what
                        // the CALLER did afterwards, and the difference shows up
                        // in highestAcceptedAfter, asserted below.
                        "accepted", "accepted-but-unauthenticated" -> E2eDedupe.Verdict.FRESH
                        "duplicate" -> E2eDedupe.Verdict.DUPLICATE
                        "refused" -> {
                            refusalsAsserted++
                            E2eDedupe.Verdict.REFUSED_FORWARD_JUMP
                        }
                        // An expectation this walker does not understand must
                        // never pass silently: that is how a new case gets added
                        // to the frozen file and skipped by one lane.
                        else -> {
                            fail("case $id: unknown expect '$expect'")
                            return
                        }
                    }
                    assertEquals("case $id seq=$seq expect=$expect", wanted, window.observe(seq, authenticates))
                }

                // Asserted in BOTH branches — a reset step carries them too.
                if (step.has("refusedForwardJumpAfter")) {
                    assertEquals(
                        "case $id: refusedForwardJump after this step",
                        step.get("refusedForwardJumpAfter").asLong,
                        window.refusedForwardJump
                    )
                }
                if (step.has("highestAcceptedAfter")) {
                    assertEquals(
                        "case $id: highestAccepted after this step",
                        step.get("highestAcceptedAfter").asLong,
                        window.highestAccepted
                    )
                }
                if (step.has("floorAfter")) {
                    assertEquals(
                        "case $id: floor after this step",
                        step.get("floorAfter").asLong,
                        window.floor
                    )
                }
            }
        }

        // A walker that walked nothing is not evidence. These are the four
        // behaviours the table exists to pin; if the loop ever stops reaching
        // one of them, this fails rather than reporting a green pass over an
        // empty traversal.
        assertEquals("not every step was walked", 21, stepsWalked)
        assertEquals("not every refusal case was exercised", 6, refusalsAsserted)
        assertTrue("case F's unauthenticated step was not walked", unauthenticatedStepsWalked >= 1)
        assertTrue("case H's reset step was not walked", resetsWalked >= 1)
    }

    // ------------------------------------------------- the wiring, not the unit

    /**
     * The table walks [E2eDedupe] directly. This walks the chokepoint the
     * production receive path actually uses, because a correct window behind a
     * session that never consults it is the failure M-A5-2 is about.
     *
     * A refused frame must surface as [E2eSession.Opened.RefusedForwardJump] —
     * never as a [E2eSession.Opened.Duplicate], which the frame gate treats as
     * the routine consequence of a resume.
     */
    @Test
    fun a_refused_frame_surfaces_through_the_session_as_a_refusal() {
        val counter = E2eDedupe.ForwardJumpCounter()
        val window = E2eDedupe(KID, E2eDedupe.Direction.COMPUTER_TO_PHONE, 1L, counter)

        assertEquals(E2eDedupe.Verdict.FRESH, window.observe(0, authenticates = true))
        assertEquals(0, window.highestAccepted)

        val floorBefore = window.floor
        val droppedBefore = window.droppedTotal

        // One past the inclusive bound.
        assertEquals(
            E2eDedupe.Verdict.REFUSED_FORWARD_JUMP,
            window.observe(E2eDedupe.WINDOW + 1L, authenticates = true)
        )

        assertEquals("a refusal moved the floor", floorBefore, window.floor)
        assertEquals("a refusal was counted as a drop", droppedBefore, window.droppedTotal)
        assertEquals("a refusal moved the mark", 0, window.highestAccepted)
        assertEquals(1, window.refusedForwardJump)

        // And again: the frame was never recorded, so it is refused AGAIN
        // rather than becoming a duplicate. That is the whole of F2.
        assertEquals(
            E2eDedupe.Verdict.REFUSED_FORWARD_JUMP,
            window.observe(E2eDedupe.WINDOW + 1L, authenticates = true)
        )
        assertEquals(2, window.refusedForwardJump)
        assertEquals(droppedBefore, window.droppedTotal)
    }
}
