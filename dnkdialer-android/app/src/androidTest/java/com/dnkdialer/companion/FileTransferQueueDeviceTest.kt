package com.dnkdialer.companion

import android.content.Context
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * FILE-QUEUE — the queue on a device, over a REAL [FileTransferManager] and a
 * scripted relay peer (the loopback shape of [FileTransferCardUiTest]).
 *
 * The manager's listener forwards to the queue exactly as
 * PhoneService.setUpFileTransfer does, and the queue's Sender is the same
 * adapter (isBusy / startSend / cancel). What the peer SAW - the FILE_OFFER
 * names in order, and which files were never offered - is the evidence, not
 * the queue's own view of itself.
 *
 * Restart (kill mid-queue) is a two-process proof: [restartPhase1_leaveAQueueMidSend]
 * persists a real mid-send queue into PhoneService's prefs; the host kills the
 * process (`am force-stop`); [restartPhase2_restoredRowsAfterProcessDeath]
 * runs in a fresh process, starts the real service and reads what it restored.
 * Phase 2 is skipped (not failed) unless phase 1's marker is present, so a
 * plain full-suite run does not depend on the order.
 */
@RunWith(AndroidJUnit4::class)
class FileTransferQueueDeviceTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = File(ctx.filesDir, "ft-queue-test").apply { mkdirs() }
        FileTransferStore.clear(ctx)
    }

    @After
    fun tearDown() {
        FileTransferStore.clear(ctx)
    }

    private class Peer {
        val sent = ConcurrentLinkedQueue<Pair<String, Map<String, Any?>>>()
        @Volatile var respond: ((String, Map<String, Any?>) -> Unit)? = null
        fun record(type: String, payload: Map<String, Any?>) {
            sent.add(type to if (type == FileTransfer.CHUNK) payload - "data" else payload)
            respond?.invoke(type, payload)
        }
        fun offeredNames(): List<String> =
            sent.filter { it.first == FileTransfer.OFFER }.map { it.second["name"] as String }
    }

    /** PhoneService's wiring, queue half: manager events -> queue, queue -> manager. */
    private class Rig(ctx: Context, val peer: Peer, persist: ((String) -> Unit)? = null) {
        lateinit var q: FileTransferQueue
        val mgr: FileTransferManager = FileTransferManager(
            context = ctx,
            send = { t, p -> peer.record(t, p) },
            isOpen = { true },
            queuedBytes = { 0L },
            listener = object : FileTransferManager.Listener {
                override fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean) =
                    q.onProgress(id, name, sent, total, outgoing)
                override fun onOfferReceived(id: String, name: String, size: Long, mime: String?) {}
                override fun onComplete(id: String, name: String, uri: Uri?, outgoing: Boolean) =
                    q.onComplete(id, name, uri?.toString(), outgoing)
                override fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean) =
                    q.onFailed(id, name, reason, outgoing)
                override fun onIdle() = q.onIdle()
            },
        )

        init {
            q = FileTransferQueue(
                sender = object : FileTransferQueue.Sender {
                    override val isBusy get() = mgr.isBusy
                    override val isConnected get() = true
                    override fun start(uri: String) = mgr.startSend(Uri.parse(uri))
                    override fun cancelActive() = mgr.cancel()
                    override fun canRead(uri: String) = try {
                        ctx.contentResolver.openInputStream(Uri.parse(uri))?.use { true } ?: false
                    } catch (e: Exception) { false }
                },
                onChange = { snap -> persist?.invoke(q.encodeSnapshot(snap)) },
            )
        }

        fun key(name: String) = q.snapshot().items.last { it.name == name }.key
        fun states() = q.snapshot().items.map { "${it.name}:${it.state.wire}" + (it.reason?.let { r -> ":$r" } ?: "") }
    }

    private fun fixture(name: String, size: Int): File {
        val f = File(dir, name)
        f.outputStream().buffered().use { out -> for (i in 0 until size) out.write((i * 31 + name.length) % 251) }
        return f
    }

    private fun queued(f: File, persistable: Boolean = false) =
        FileTransferQueue.NewFile(Uri.fromFile(f).toString(), f.name, f.length(), f.lastModified(), persistable)

    /** A relay stand-in that accepts every offer and ACKs every chunk. */
    private fun acceptEverything(peer: Peer, mgr: () -> FileTransferManager, hold: Set<String> = emptySet()) {
        val io = Executors.newSingleThreadExecutor()
        peer.respond = { type, p ->
            when (type) {
                FileTransfer.OFFER -> if ((p["name"] as String) !in hold) io.execute {
                    mgr().onFrame(FileTransfer.ACCEPT, mapOf("id" to p["id"]))
                }
                FileTransfer.CHUNK -> {
                    val seq = (p["seq"] as Number).toInt()
                    val n = (p["n"] as Number).toInt()
                    if (FileTransfer.shouldAck(seq, n)) io.execute {
                        mgr().onFrame(FileTransfer.ACK, mapOf("id" to p["id"], "upTo" to seq))
                    }
                }
            }
        }
    }

    private fun <T> waitFor(ms: Long = 60_000, probe: () -> T?): T? {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            probe()?.let { return it }
            Thread.sleep(50)
        }
        return null
    }

    @Test(timeout = 180_000)
    fun three_shared_files_are_sent_in_order_one_at_a_time() {
        val peer = Peer()
        lateinit var rig: Rig
        acceptEverything(peer, { rig.mgr })
        rig = Rig(ctx, peer)
        val files = listOf(fixture("one.jpg", 300_000), fixture("two.jpg", 200_000), fixture("three.jpg", 100_000))

        // Offers must never overlap: count FILE_OFFERs whose transfer has
        // not ended when the next one goes out.
        rig.q.enqueue(files.map { queued(it) })

        val done = waitFor { rig.q.snapshot().items.takeIf { l -> l.all { it.state == FileTransferQueue.State.DONE } } }
        assertNotNull("not all three finished: ${rig.states()}", done)
        assertEquals("offered in the order shared", listOf("one.jpg", "two.jpg", "three.jpg"), peer.offeredNames())
        // One at a time: each FILE_DONE precedes the next FILE_OFFER on the wire.
        val kinds = peer.sent.map { it.first }.filter { it == FileTransfer.OFFER || it == FileTransfer.DONE }
        assertEquals(
            listOf(FileTransfer.OFFER, FileTransfer.DONE, FileTransfer.OFFER, FileTransfer.DONE, FileTransfer.OFFER, FileTransfer.DONE),
            kinds,
        )
    }

    @Test(timeout = 180_000)
    fun a_removed_queued_file_is_never_offered() {
        val peer = Peer()
        lateinit var rig: Rig
        // Hold the first offer so the other two are still queued when Remove lands.
        acceptEverything(peer, { rig.mgr }, hold = setOf("first.jpg"))
        rig = Rig(ctx, peer)
        rig.q.enqueue(listOf(fixture("first.jpg", 50_000), fixture("second.jpg", 50_000), fixture("third.jpg", 50_000)).map { queued(it) })
        assertNotNull(waitFor { peer.offeredNames().takeIf { it.isNotEmpty() } })

        rig.q.remove(rig.key("second.jpg"))
        assertEquals(listOf("first.jpg:offering", "third.jpg:queued"), rig.states())

        // Release the held offer.
        val id = peer.sent.first { it.first == FileTransfer.OFFER }.second["id"]
        rig.mgr.onFrame(FileTransfer.ACCEPT, mapOf("id" to id))

        assertNotNull(
            "did not finish: ${rig.states()}",
            waitFor { rig.states().takeIf { it == listOf("first.jpg:done", "third.jpg:done") } },
        )
        assertEquals(listOf("first.jpg", "third.jpg"), peer.offeredNames())
    }

    @Test(timeout = 180_000)
    fun cancelling_the_active_file_lets_the_next_one_proceed() {
        val peer = Peer()
        lateinit var rig: Rig
        val io = Executors.newSingleThreadExecutor()
        // Accept everything; ACK only the first 10 chunks of big.bin so it is
        // genuinely mid-send (window full, waiting) when Cancel is pressed.
        peer.respond = { type, p ->
            when (type) {
                FileTransfer.OFFER -> io.execute { rig.mgr.onFrame(FileTransfer.ACCEPT, mapOf("id" to p["id"])) }
                FileTransfer.CHUNK -> {
                    val seq = (p["seq"] as Number).toInt()
                    val n = (p["n"] as Number).toInt()
                    val big = peer.offeredNames().last() == "big.bin"
                    if ((!big || seq < 10) && (big || FileTransfer.shouldAck(seq, n))) io.execute {
                        rig.mgr.onFrame(FileTransfer.ACK, mapOf("id" to p["id"], "upTo" to seq))
                    }
                }
            }
        }
        rig = Rig(ctx, peer)
        rig.q.enqueue(listOf(fixture("big.bin", 6 * 1024 * 1024), fixture("small.jpg", 120_000)).map { queued(it) })

        assertNotNull(
            "big.bin never started sending: ${rig.states()}",
            waitFor { rig.states().takeIf { it.first() == "big.bin:sending" } },
        )
        // The card's / notification's cancel path.
        rig.q.cancel(rig.key("big.bin"))

        assertNotNull(
            "next did not proceed: ${rig.states()}",
            waitFor { rig.states().takeIf { it == listOf("big.bin:failed:cancelled", "small.jpg:done") } },
        )
        assertEquals(listOf("big.bin", "small.jpg"), peer.offeredNames())
        assertTrue(
            "the peer was told big.bin is cancelled",
            peer.sent.any { it.first == FileTransfer.FAILED && it.second["reason"] == FileTransfer.Reason.CANCELLED },
        )
    }

    // ------------------------------------------------------------- restart

    private val marker get() = File(ctx.filesDir, "ft-queue-restart-phase1.marker")

    @Test(timeout = 120_000)
    fun restartPhase1_leaveAQueueMidSend() {
        val prefs = ctx.getSharedPreferences(PhoneService.FT_QUEUE_PREFS, Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val peer = Peer()
        lateinit var rig: Rig
        // Accept, then never ACK: the first file stays mid-send forever.
        val io = Executors.newSingleThreadExecutor()
        peer.respond = { type, p ->
            if (type == FileTransfer.OFFER) io.execute { rig.mgr.onFrame(FileTransfer.ACCEPT, mapOf("id" to p["id"])) }
        }
        rig = Rig(ctx, peer) { json -> prefs.edit().putString(PhoneService.FT_QUEUE_KEY, json).commit() }
        val sending = fixture("sending.mp4", 4 * 1024 * 1024)
        val withGrant = fixture("still-here.jpg", 50_000)
        val shared = fixture("shared.jpg", 50_000)
        // still-here.jpg stands in for a picker file with a persisted grant
        // (file:// in our own dir stays readable after a restart); shared.jpg
        // for a share-sheet grant that did not persist.
        rig.q.enqueue(listOf(queued(sending, true), queued(withGrant, true), queued(shared, false)))
        assertNotNull(
            "never got mid-send: ${rig.states()}",
            waitFor { rig.states().takeIf { it.first() == "sending.mp4:sending" } },
        )
        val saved = prefs.getString(PhoneService.FT_QUEUE_KEY, null)
        assertNotNull(saved)
        assertTrue("persisted mid-send", saved!!.contains("\"state\":\"sending\""))
        marker.writeText("phase1")
        // The host now force-stops the process: nothing here runs teardown.
    }

    @Test(timeout = 120_000)
    fun restartPhase2_restoredRowsAfterProcessDeath() {
        org.junit.Assume.assumeTrue("phase 1 did not run in an earlier process", marker.exists())
        marker.delete()
        TokenStore.save(ctx, "ft-queue-restart-not-a-real-token", "dennis@example.com")
        // In front, so the foreground-service start below is allowed.
        val scenario = androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
        try {
            // The real service, restoring from its own prefs.
            val intent = android.content.Intent(ctx, PhoneService::class.java).apply { action = PhoneService.ACTION_START }
            if (android.os.Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
            val q = waitFor(30_000) { PhoneService.fileTransferQueue }
            assertNotNull("PhoneService never built its queue", q)
            val states = q!!.snapshot().items.map { "${it.name}:${it.state.wire}" + (it.reason?.let { r -> ":$r" } ?: "") }
            // No socket in this process: the readable queued file is due, the
            // link is down, so the queue PAUSES rather than failing it.
            assertEquals(
                listOf("sending.mp4:failed:connection_lost", "still-here.jpg:queued", "shared.jpg:needs-file"),
                states,
            )
            val rows = PhoneService.fileTransferUiModel.queue.value
            assertEquals(
                "what the card draws",
                listOf(
                    "sending.mp4" to listOf(QueueRowAction.RETRY, QueueRowAction.REMOVE),
                    "still-here.jpg" to listOf(QueueRowAction.REMOVE),
                    "shared.jpg" to listOf(QueueRowAction.REPICK, QueueRowAction.REMOVE),
                ),
                rows.map { it.name to it.actions },
            )
        } finally {
            scenario.close()
            ctx.stopService(android.content.Intent(ctx, PhoneService::class.java))
            ctx.getSharedPreferences(PhoneService.FT_QUEUE_PREFS, Context.MODE_PRIVATE).edit().clear().commit()
            TokenStore.clear(ctx)
        }
    }
}
