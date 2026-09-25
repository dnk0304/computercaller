package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * vc69 — RULE 30 vector suite for the in-app transfer card's StateFlow
 * mapping, pinned to `tests/ft-progress-card-vectors.json`.
 *
 * Every scenario replays [FileTransferManager.Listener]-shaped events into a
 * fresh [FileTransferUiModel] on a scripted clock and checks the published
 * [FileTransferUi] after EVERY step: progress -> percent + byte labels,
 * the ~5/s throttle (and that the final 100 % is never throttled), and the
 * terminal Done / Failed states with their hold tokens, and (FT incident 2)
 * the pending offer exposed in the flow until it is answered or withdrawn.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*FileTransferUiVectors*'`
 */
class FileTransferUiVectorsTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/ft-progress-card-vectors.json")

    private fun root(): JsonObject {
        assertTrue("the vector file is missing at " + file.absolutePath, file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun JsonObject.str(k: String): String? =
        get(k)?.takeUnless { it.isJsonNull }?.asString

    @Test
    fun the_file_pins_the_constants_the_model_uses() {
        val c = root().getAsJsonObject("constants")
        assertEquals(FileTransferUiModel.MIN_PROGRESS_INTERVAL_MS, c.get("minProgressIntervalMs").asLong)
        assertEquals(FileTransferUiModel.TERMINAL_HOLD_MS, c.get("terminalHoldMs").asLong)
    }

    @Test
    fun every_step_of_every_scenario_matches() {
        val scenarios = root().getAsJsonArray("scenarios").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously.
        assertTrue("expected at least 14 scenarios, got ${scenarios.size}", scenarios.size >= 14)
        var steps = 0
        val kindsSeen = HashSet<String>()
        for (sc in scenarios) {
            val sid = sc.get("id").asString
            var now = 0L
            val model = FileTransferUiModel { now }
            val tokens = HashMap<Int, Long>()
            sc.getAsJsonArray("steps").forEachIndexed { i, el ->
                val s = el.asJsonObject
                val where = "$sid step $i"
                now = s.get("t").asLong
                when (val ev = s.get("ev").asString) {
                    "progress" -> {
                        val published = model.onProgress(
                            s.str("id")!!, s.str("name")!!,
                            s.get("sent").asLong, s.get("total").asLong, s.get("out").asBoolean,
                        )
                        assertEquals("$where published", s.get("published").asBoolean, published)
                    }
                    "complete" -> tokens[i] = model.onComplete(
                        s.str("id")!!, s.str("name")!!, s.str("uri"), s.get("out").asBoolean,
                    )
                    "failed" -> tokens[i] = model.onFailed(
                        s.str("id")!!, s.str("name"), s.str("reason")!!, s.get("out").asBoolean,
                    )
                    "idle" -> model.onIdle()
                    "offer" -> model.onOffer(s.str("id")!!, s.str("name")!!, s.get("size").asLong)
                    "withdrawn" -> model.onOfferWithdrawn(s.str("id")!!)
                    "dismiss" -> {
                        val from = s.get("tokenFrom").asInt
                        val token = tokens[from] ?: throw AssertionError("$where: step $from issued no token")
                        assertEquals("$where dismissed", s.get("dismissed").asBoolean, model.dismissTerminal(token))
                    }
                    else -> fail("$where: unknown event $ev")
                }
                val expect = s.getAsJsonObject("expect")
                kindsSeen.add(expect.get("kind").asString)
                check(where, expect, model.state.value)
                steps++
            }
        }
        assertTrue("expected at least 43 checked steps, got $steps", steps >= 43)
        assertEquals(
            "the file must exercise every card state the card draws",
            setOf("Idle", "Offer", "Running", "Done", "Failed"), kindsSeen,
        )
    }

    private fun check(where: String, e: JsonObject, got: FileTransferUi) {
        val kind = e.get("kind").asString
        assertEquals("$where kind", kind, got.javaClass.simpleName)
        fun has(k: String) = e.has(k)
        fun eqStr(k: String, v: String?) {
            if (has(k)) assertEquals("$where $k", e.str(k), v)
        }
        fun eqLong(k: String, v: Long) {
            if (has(k)) assertEquals("$where $k", e.get(k).asLong, v)
        }
        fun eqBool(k: String, v: Boolean) {
            if (has(k)) assertEquals("$where $k", e.get(k).asBoolean, v)
        }
        when (got) {
            is FileTransferUi.Idle -> Unit
            is FileTransferUi.Running -> {
                eqStr("id", got.id); eqStr("name", got.name); eqBool("out", got.outgoing)
                eqLong("sent", got.sent); eqLong("total", got.total)
                eqLong("percent", got.percent.toLong())
                eqStr("sentLabel", FileTransfer.humanSize(got.sent))
                eqStr("totalLabel", FileTransfer.humanSize(got.total))
            }
            is FileTransferUi.Done -> {
                eqStr("id", got.id); eqStr("name", got.name); eqBool("out", got.outgoing)
                eqStr("uri", got.uri)
            }
            is FileTransferUi.Failed -> {
                eqStr("id", got.id); eqStr("name", got.name); eqBool("out", got.outgoing)
                eqStr("reason", got.reason)
            }
            is FileTransferUi.Offer -> {
                eqStr("id", got.id); eqStr("name", got.name); eqLong("size", got.size)
            }
        }
        // A key the checker does not know is a typo that would silently check nothing.
        val known = setOf(
            "kind", "id", "name", "out", "sent", "total", "percent", "sentLabel", "totalLabel",
            "uri", "reason", "size",
        )
        val unknown = e.keySet() - known
        assertTrue("$where: unknown expect keys $unknown", unknown.isEmpty())
    }

    /**
     * The card's percent and the notification's percent are one function.
     * Pinned independently of the file so a refactor that gives the card its
     * own formula is caught even if someone regenerates the vectors.
     */
    @Test
    fun running_percent_is_the_notification_formula() {
        for ((sent, total) in listOf(0L to 0L, 1L to 3L, 2L to 3L, 99L to 100L, 5L to 3L, 212L to 432L)) {
            val r = FileTransferUi.Running("x", "n", true, sent, total)
            assertEquals("$sent/$total", FileTransfer.percent(sent, total), r.percent)
        }
    }
}
