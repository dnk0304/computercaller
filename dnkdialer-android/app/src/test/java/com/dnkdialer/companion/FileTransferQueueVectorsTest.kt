package com.dnkdialer.companion

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * FILE-QUEUE — RULE 30 vector suite for [FileTransferQueue] (every scheduler
 * rule row of Ken's ADDENDUM 2) and for the queue -> card-row mapping
 * [rowsOf] / [FileTransferUiModel.onQueue], pinned to
 * `tests/ft-queue-vectors.json`.
 *
 * The whole queue is compared after EVERY step, including the cumulative list
 * of Sender.start calls - so "the next file must NOT be offered yet" is an
 * assertion, not an absence.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*FileTransferQueue*'`
 */
class FileTransferQueueVectorsTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/ft-queue-vectors.json")

    private fun root(): JsonObject {
        assertTrue("the vector file is missing at " + file.absolutePath, file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        return root
    }

    private fun JsonObject.str(k: String): String? =
        get(k)?.takeUnless { it.isJsonNull }?.asString

    /** Scripted manager. */
    private class FakeSender : FileTransferQueue.Sender {
        override var isBusy = false
        override var isConnected = true
        val readable = HashMap<String, Boolean>()
        val starts = ArrayList<String>()
        var cancels = 0
        override fun start(uri: String) { starts.add(uri) }
        override fun cancelActive() { cancels++ }
        override fun canRead(uri: String): Boolean = readable[uri] ?: true
    }

    private class Rig(json: String? = null, raw: Boolean = false, setup: (FakeSender) -> Unit = {}) {
        var now = 0L
        var n = 0
        val sender = FakeSender().also(setup)
        val published = ArrayList<FileTransferQueue.Snapshot>()
        val q = FileTransferQueue(sender, { now }, { "k" + (++n) }) { published.add(it) }

        init {
            if (json != null || raw) q.restore(json)
        }

        fun key(name: String): String =
            q.snapshot().items.lastOrNull { it.name == name }?.key ?: error("no item named $name")
    }

    private fun newFile(o: JsonObject) = FileTransferQueue.NewFile(
        uri = o.str("uri")!!, name = o.str("name")!!, size = o.get("size").asLong,
        persistable = o.get("persistable")?.asBoolean ?: false,
    )

    private fun apply(r: Rig, s: JsonObject) {
        r.now = s.get("t").asLong
        val q = r.q
        when (val ev = s.get("ev").asString) {
            "enqueue" -> q.enqueue(s.getAsJsonArray("files").map { newFile(it.asJsonObject) })
            "set" -> {
                s.get("busy")?.let { r.sender.isBusy = it.asBoolean }
                s.get("connected")?.let { r.sender.isConnected = it.asBoolean }
                s.getAsJsonObject("readable")?.entrySet()?.forEach { (k, v) -> r.sender.readable[k] = v.asBoolean }
            }
            "progress" -> q.onProgress(
                s.str("id")!!, s.str("name")!!, s.get("sent").asLong, s.get("total").asLong, s.get("out").asBoolean,
            )
            "complete" -> q.onComplete(s.str("id")!!, s.str("name")!!, s.str("uri"), s.get("out").asBoolean)
            "failed" -> q.onFailed(s.str("id")!!, s.str("name"), s.str("reason")!!, s.get("out").asBoolean)
            "idle" -> q.onIdle()
            "remove" -> q.remove(r.key(s.str("name")!!))
            "cancel" -> q.cancel(r.key(s.str("name")!!))
            "retry" -> q.retry(r.key(s.str("name")!!))
            "repick" -> q.repick(r.key(s.str("name")!!), newFile(s.getAsJsonObject("file")))
            "resume" -> q.resume()
            "linkUp" -> q.onLinkUp()
            "tick" -> q.tick()
            else -> fail("unknown event $ev")
        }
    }

    private fun compact(it: FileTransferQueue.Item): String {
        val base = "${it.name}:${it.state.wire}"
        return when {
            it.state == FileTransferQueue.State.FAILED -> "$base:${it.reason}"
            it.removing -> "$base:removing"
            else -> base
        }
    }

    private fun check(where: String, r: Rig, e: JsonObject) {
        val snap = r.q.snapshot()
        assertEquals("$where items", e.getAsJsonArray("items").map { it.asString }, snap.items.map { compact(it) })
        val p = e.str("paused")
        assertEquals("$where paused", p, snap.paused?.let { "${it.kind.wire}:${it.reason}" })
        assertEquals("$where starts", e.getAsJsonArray("starts").map { it.asString }, r.sender.starts)
        assertEquals("$where cancels", e.get("cancels").asInt, r.sender.cancels)
        e.getAsJsonObject("retries")?.entrySet()?.forEach { (name, v) ->
            assertEquals("$where retries of $name", v.asInt, snap.items.last { it.name == name }.busyRetries)
        }
        // The published stream must end on the state we just read.
        r.published.lastOrNull()?.let {
            assertEquals("$where last published == snapshot", snap, it)
        }
    }

    @Test
    fun the_file_pins_the_constants_the_queue_uses() {
        val c = root().getAsJsonObject("constants")
        assertEquals(FileTransferQueue.MAX_BUSY_RETRIES, c.get("maxBusyRetries").asInt)
        assertEquals(FileTransferQueue.BUSY_RETRY_DELAY_MS, c.get("busyRetryDelayMs").asLong)
        assertEquals(FileTransferQueue.MAX_DONE_ROWS, c.get("maxDoneRows").asInt)
    }

    @Test
    fun every_reason_is_classified_as_pinned() {
        val rows = root().getAsJsonArray("classify").map { it.asJsonObject }
        val pinned = rows.map { it.str("reason")!! }.toSet()
        // Every reason the wire can carry must have a row: a new reason with
        // no row would silently default to LINK and nobody would decide it.
        for (r in FileTransfer.Reason.ALL) assertTrue("no classify row for reason '$r'", r in pinned)
        for (row in rows) {
            assertEquals(
                "class of ${row.str("reason")}",
                row.str("class"), FileTransferQueue.classify(row.str("reason")!!).name,
            )
        }
    }

    @Test
    fun every_step_of_every_scenario_matches() {
        val scenarios = root().getAsJsonArray("scenarios").map { it.asJsonObject }
        assertTrue("expected at least 19 scenarios, got ${scenarios.size}", scenarios.size >= 19)
        var steps = 0
        val events = HashSet<String>()
        for (sc in scenarios) {
            val sid = sc.get("id").asString
            val r = Rig()
            sc.getAsJsonArray("steps").forEachIndexed { i, el ->
                val s = el.asJsonObject
                events.add(s.get("ev").asString)
                apply(r, s)
                check("$sid step $i (${s.get("ev").asString})", r, s.getAsJsonObject("expect"))
                steps++
            }
        }
        assertTrue("expected at least 80 steps, got $steps", steps >= 80)
        val all = setOf(
            "enqueue", "set", "progress", "complete", "failed", "idle", "remove", "cancel",
            "retry", "repick", "resume", "linkUp", "tick",
        )
        assertEquals("every event kind is exercised", all, events)
    }

    @Test
    fun every_restore_case_matches() {
        val cases = root().getAsJsonArray("restore").map { it.asJsonObject }
        assertTrue("expected at least 3 restore cases", cases.size >= 3)
        for (c in cases) {
            val sid = c.get("id").asString
            val blob = c.getAsJsonObject("persisted")?.toString() ?: c.str("persistedRaw")
            val r = Rig(blob, raw = true) { s ->
                s.isConnected = c.get("connected").asBoolean
                s.isBusy = c.get("busy").asBoolean
                c.getAsJsonObject("readable").entrySet().forEach { (k, v) -> s.readable[k] = v.asBoolean }
            }
            check("$sid restored", r, c.getAsJsonObject("expect"))
            (c.get("then") as? JsonArray)?.forEachIndexed { i, el ->
                val s = el.asJsonObject
                apply(r, s)
                check("$sid then $i", r, s.getAsJsonObject("expect"))
            }
        }
    }

    @Test
    fun every_row_mapping_matches_and_the_ui_model_publishes_it() {
        val cases = root().getAsJsonArray("rows").map { it.asJsonObject }
        assertTrue("expected at least 2 row cases", cases.size >= 2)
        val actionsSeen = HashSet<QueueRowAction>()
        for (c in cases) {
            val sid = c.get("id").asString
            val items = c.getAsJsonArray("items").mapIndexed { i, el ->
                val o = el.asJsonObject
                FileTransferQueue.Item(
                    key = "k$i", uri = "u:$i", name = o.str("name")!!, size = 1L, lastModified = 0L,
                    outgoing = o.str("dir") != "in",
                    state = FileTransferQueue.State.of(o.str("state"))!!,
                    reason = o.str("reason"), resultUri = o.str("resultUri"),
                    removing = o.get("removing")?.asBoolean ?: false,
                )
            }
            val model = FileTransferUiModel { 0L }
            model.onQueue(FileTransferQueue.Snapshot(items, FileTransferQueue.Pause(FileTransferQueue.PauseKind.LINK, "timeout")))
            val rows = model.queue.value
            assertEquals("$sid paused published", "timeout", model.queuePaused.value)
            assertEquals("$sid rows == rowsOf", rowsOf(items), rows)
            val want = c.getAsJsonArray("expect").map { it.asJsonObject }
            assertEquals("$sid row count", want.size, rows.size)
            for ((i, w) in want.withIndex()) {
                val row = rows[i]
                assertEquals("$sid row $i name", w.str("name"), row.name)
                assertEquals("$sid row $i state", w.str("state"), row.state.wire)
                assertEquals("$sid row $i reason", w.str("reason"), row.reason)
                assertEquals("$sid row $i actions", w.getAsJsonArray("actions").map { it.asString }, row.actions.map { it.name })
                actionsSeen.addAll(row.actions)
            }
            model.reset()
            assertTrue("$sid reset clears rows", model.queue.value.isEmpty())
            assertNull("$sid reset clears pause", model.queuePaused.value)
        }
        assertEquals("every row action is exercised", QueueRowAction.values().toSet(), actionsSeen)
    }
}
