package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * T-FT-WEB-CHUNK-SEQ-RACE — the PHONE half of the cross-surface contract
 * (RESUME-PROTOCOL v3.0 RULE 30).
 *
 * ## One file, two implementations
 *
 * `tests/e2e-ft-chunk-seq-vectors.json` at the repo root is the SINGLE source
 * of truth. The web lane asserts it in `tests/e2e-ft-chunk-seq-contract.test.mjs`
 * (the REAL `createFailClosedSender`, driven with N seals in flight together
 * the way `lib/fileTransfer/sender.ts` `pump()` drives it); this file asserts
 * the SAME rows against the shipped [E2eDedupe].
 *
 * ## The defect this exists for
 *
 * On PROD 8e0c035 the browser sealed three FILE_CHUNKs within 7 ms. Its send
 * counter read the sequence, awaited the durability commit, and only then
 * advanced — so all three frames went out under ONE `s`. This side did exactly
 * what it is supposed to do: chunk 0 FRESH, chunk 1 DUPLICATE, and
 * `FileTransfer` then refused chunk 2 as out-of-order. The transfer died with
 * no FILE_COMPLETE and the browser timed out after 30 s.
 *
 * That is why the BUG rows are in the vector file and asserted here. The fix is
 * web-side, but "the phone drops the second frame under a repeated `s`" is the
 * behaviour the fix is written against, and a change to it would silently make
 * the web suite's green meaningless. Pinning it on this side is the only place
 * that can fail.
 *
 * ## No Kotlin product code changes on this lane
 *
 * Ken's brief: web + extension + Kotlin TEST files. Nothing under
 * `app/src/main` is touched here.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eFtChunkSeq*'`
 */
class E2eFtChunkSeqContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-ft-chunk-seq-vectors.json")

    private fun root(): JsonObject {
        assertTrue(
            "the shared vector file is missing at " + file.absolutePath +
                " — the web lane and this one must read the SAME file",
            file.exists()
        )
        return JsonParser.parseString(file.readText()).asJsonObject
    }

    private fun rows(): List<JsonObject> =
        root().getAsJsonArray("rows").map { it.asJsonObject }

    /** A dedupe with its OWN refusal counter, so rows cannot contaminate each other. */
    private fun dedupe() = E2eDedupe(
        kid = "kid-ft-chunk-seq",
        direction = E2eDedupe.Direction.COMPUTER_TO_PHONE,
        pairEpoch = 1L,
        refusals = E2eDedupe.ForwardJumpCounter()
    )

    @Test
    fun `the vector file is the one the web lane reads`() {
        val r = root()
        assertEquals(1, r.get("version").asInt)
        // The window is a shared constant, not a number each side chose.
        assertEquals(E2eDedupe.WINDOW.toLong(), r.get("dedupeWindow").asLong)
        assertTrue(
            "a vectors suite with no rows passes vacuously",
            rows().size >= 6
        )
        assertTrue(
            "THE defect row must survive",
            rows().any { it.get("id").asString == "three-chunks-in-flight" }
        )
        assertTrue(
            "and so must the bug shape it replaced",
            rows().any { it.get("id").asString == "three-chunks-in-flight-BUG" }
        )
    }

    /**
     * Every row: feed the emitted `s` values to the SHIPPED dedupe, in order,
     * and require the verdict the vector names.
     *
     * `authenticates = true` on every call because that is what production
     * does: [E2eSession.open] authenticates BEFORE it deduplicates, so a frame
     * only reaches [E2eDedupe.observe] with a verified tag.
     */
    @Test
    fun `each row's emitted sequences produce the recorded verdicts`() {
        for (row in rows()) {
            val id = row.get("id").asString
            val emitted = row.getAsJsonArray("emitted").map { it.asLong }
            val want = row.getAsJsonArray("verdicts").map { it.asString }
            assertEquals("$id: one verdict per emitted s", emitted.size, want.size)

            val d = dedupe()
            val got = emitted.map { d.observe(it, authenticates = true).name }
            assertEquals("$id: verdicts", want, got)

            val delivered = got.count { it == E2eDedupe.Verdict.FRESH.name }
            assertEquals("$id: chunks actually delivered", row.get("delivered").asInt, delivered)
        }
    }

    /**
     * The contract stated as one sentence: N chunks sealed back-to-back with
     * strictly increasing `s` are ALL delivered. This is what the web fix buys
     * and what the pre-fix browser could not produce.
     */
    @Test
    fun `strictly increasing sequences are all delivered`() {
        for (row in rows()) {
            if (row.has("bug") && row.get("bug").asBoolean) continue
            if (!row.has("concurrent")) continue
            val id = row.get("id").asString
            val emitted = row.getAsJsonArray("emitted").map { it.asLong }
            assertTrue(
                "$id: the vector itself must be strictly increasing",
                emitted.zipWithNext().all { (a, b) -> b > a }
            )
            val d = dedupe()
            val verdicts = emitted.map { d.observe(it, authenticates = true) }
            assertTrue(
                "$id: every chunk must be FRESH",
                verdicts.all { it == E2eDedupe.Verdict.FRESH }
            )
            assertEquals("$id: nothing dropped", 0L, d.droppedTotal)
            assertEquals("$id: nothing refused", 0L, d.refusedForwardJump)
            assertEquals("$id: all accepted", emitted.size.toLong(), d.acceptedTotal)
        }
    }

    /**
     * The BUG row, asserted as a DROP and not as a refusal.
     *
     * A repeated sequence is what the relay's frameBuffer legitimately replays
     * on resume, so it must stay DUPLICATE: folding it into
     * REFUSED_FORWARD_JUMP would turn every reconnect into a refusal, and
     * folding a refusal into a drop would hide M-A5-2's counter. The web defect
     * produced exactly this shape and this side handled it correctly — the
     * evidence for that is here, not in a log.
     */
    @Test
    fun `a repeated sequence is dropped, never refused`() {
        val bug = rows().first { it.get("id").asString == "three-chunks-in-flight-BUG" }
        val d = dedupe()
        val verdicts = bug.getAsJsonArray("emitted").map { d.observe(it.asLong, true) }
        assertEquals(E2eDedupe.Verdict.FRESH, verdicts[0])
        assertEquals(E2eDedupe.Verdict.DUPLICATE, verdicts[1])
        assertEquals(E2eDedupe.Verdict.DUPLICATE, verdicts[2])
        assertEquals("two frames dropped", 2L, d.droppedTotal)
        assertEquals("and none refused", 0L, d.refusedForwardJump)
        assertEquals("one chunk delivered out of three", 1, bug.get("delivered").asInt)
    }
}
