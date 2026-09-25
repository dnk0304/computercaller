package com.dnkdialer.companion

import android.net.Uri
import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.progressindicator.LinearProgressIndicator
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasComponent
import androidx.test.espresso.intent.matcher.IntentMatchers.hasExtra
import org.hamcrest.Matchers.allOf
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * vc69 — the in-app transfer card, on a device, driven by a REAL
 * [FileTransferManager] over a scripted relay peer (the same loopback shape as
 * [FileTransferLoopbackTest]).
 *
 * The manager's listener here forwards to [PhoneService.fileTransferUiModel]
 * exactly as PhoneService.setUpFileTransfer does (one line per event, beside
 * the notifier call). What is proved is the half this lane owns: that real
 * manager events reach the card, the card shows the numbers the model holds,
 * and the card's Cancel goes through [FileTransferActionReceiver.handler] - the
 * notification's cancel path - and actually ends the transfer.
 */
@RunWith(AndroidJUnit4::class)
class FileTransferCardUiTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private lateinit var dir: File
    private val model get() = PhoneService.fileTransferUiModel

    @Before
    fun setUp() {
        TokenStore.save(ctx, "ft-card-test-not-a-real-token", "dennis@example.com")
        dir = File(ctx.cacheDir, "ft-card-test").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        FileTransferStore.clear(ctx)
        model.reset()
    }

    @After
    fun tearDown() {
        model.reset()
        dir.listFiles()?.forEach { it.delete() }
        FileTransferStore.clear(ctx)
        TokenStore.clear(ctx)
    }

    /** Frames the device emitted, and a responder standing in for the relay. */
    internal class Peer {
        val sent = ConcurrentLinkedQueue<Pair<String, Map<String, Any?>>>()
        var respond: ((String, Map<String, Any?>) -> Unit)? = null
        fun record(type: String, payload: Map<String, Any?>) {
            sent.add(type to if (type == FileTransfer.CHUNK) payload - "data" else payload)
            respond?.invoke(type, payload)
        }
        fun last(type: String) = sent.lastOrNull { it.first == type }?.second
    }

    /** PhoneService's listener, card half: one call per event. */
    internal class Forwarder(private val model: FileTransferUiModel) : FileTransferManager.Listener {
        override fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean) {
            model.onProgress(id, name, sent, total, outgoing)
        }
        override fun onOfferReceived(id: String, name: String, size: Long, mime: String?) {
            model.onOffer(id, name, size)
        }
        override fun onComplete(id: String, name: String, uri: Uri?, outgoing: Boolean) {
            model.onComplete(id, name, uri?.toString(), outgoing)
        }
        override fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean) {
            model.onFailed(id, name, reason, outgoing)
        }
        override fun onIdle() = model.onIdle()
        override fun onOfferWithdrawn(id: String, reason: String) = model.onOfferWithdrawn(id)
    }

    @Test(timeout = 120_000)
    fun a_running_send_shows_the_card_and_its_cancel_ends_the_transfer() {
        val src = File(dir, "holiday-video.mp4")
        // 8 MB of non-repeating bytes: enough chunks that the peer can stall
        // the sender mid-file with the bar visibly part-way.
        src.outputStream().buffered().use { out ->
            for (i in 0 until 8 * 1024 * 1024) out.write((i * 31 % 251))
        }
        val peer = Peer()
        val acker = Executors.newSingleThreadExecutor()
        lateinit var mgr: FileTransferManager
        // The relay stand-in: accept the offer, ACK the first 20 chunks, then
        // go quiet. The sender fills its ACK window and waits - a transfer
        // that is genuinely RUNNING, not finished, when Cancel is pressed.
        peer.respond = { type, p ->
            when (type) {
                FileTransfer.OFFER -> acker.execute {
                    mgr.onFrame(FileTransfer.ACCEPT, mapOf("id" to p["id"]))
                }
                FileTransfer.CHUNK -> {
                    val seq = (p["seq"] as Number).toInt()
                    if (seq < 20) acker.execute {
                        mgr.onFrame(FileTransfer.ACK, mapOf("id" to p["id"], "upTo" to seq))
                    }
                }
            }
        }
        mgr = FileTransferManager(
            context = ctx,
            send = { t, p -> peer.record(t, p) },
            isOpen = { true },
            queuedBytes = { 0L },
            listener = Forwarder(model),
        )

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            mgr.startSend(Uri.fromFile(src))

            val running = waitFor {
                (model.state.value as? FileTransferUi.Running)?.takeIf { it.sent > 0 }
            }
            assertNotNull("the send never reported progress", running)
            // Let the throttle publish the stalled position, then read it.
            Thread.sleep(400)
            instr.waitForIdleSync()
            val shown = model.state.value as FileTransferUi.Running
            assertTrue("stalled mid-file, not finished: ${shown.percent}%", shown.percent in 1..99)

            scenario.onActivity { a ->
                val card = a.findViewById<View>(R.id.ftCard)
                assertEquals("card must be visible while a transfer runs", View.VISIBLE, card.visibility)
                assertEquals(
                    ctx.getString(R.string.ft_card_to_computer),
                    a.findViewById<TextView>(R.id.ftCardHeading).text.toString(),
                )
                assertEquals("holiday-video.mp4", a.findViewById<TextView>(R.id.ftCardName).text.toString())
                assertEquals(
                    ctx.getString(R.string.ft_card_percent, shown.percent),
                    a.findViewById<TextView>(R.id.ftCardPercent).text.toString(),
                )
                assertEquals(
                    shown.percent,
                    a.findViewById<LinearProgressIndicator>(R.id.ftCardProgress).progress,
                )
                assertEquals(
                    ctx.getString(
                        R.string.ft_progress_plain,
                        FileTransfer.humanSize(shown.sent), FileTransfer.humanSize(shown.total),
                    ),
                    a.findViewById<TextView>(R.id.ftCardBytes).text.toString(),
                )
                val cancel = a.findViewById<TextView>(R.id.ftCardSecondary)
                assertEquals(ctx.getString(R.string.ft_cancel), cancel.text.toString())
                assertEquals(View.VISIBLE, cancel.visibility)
            }

            // The notification's Cancel broadcast lands in this handler; the
            // card must call the same one. Installed right before the tap so
            // a PhoneService started by MainActivity cannot have replaced it.
            val previousHandler = FileTransferActionReceiver.handler
            FileTransferActionReceiver.handler = { cancelRunning ->
                if (cancelRunning) mgr.cancel() else mgr.rejectOffer()
            }
            try {
                scenario.onActivity { a -> a.findViewById<View>(R.id.ftCardSecondary).performClick() }

                val failed = waitFor { peer.last(FileTransfer.FAILED) }
                assertNotNull("Cancel must put FILE_FAILED on the wire", failed)
                assertEquals(FileTransfer.Reason.CANCELLED, failed!!["reason"])
                val terminal = waitFor { model.state.value as? FileTransferUi.Failed }
                assertNotNull("the card must move to its failed state", terminal)
                assertEquals(FileTransfer.Reason.CANCELLED, terminal!!.reason)
                assertFalse("nothing may be left running", mgr.isBusy)

                instr.waitForIdleSync()
                scenario.onActivity { a ->
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftCard).visibility)
                    assertEquals(
                        failureCopy(ctx, FileTransfer.Reason.CANCELLED),
                        a.findViewById<TextView>(R.id.ftCardMessage).text.toString(),
                    )
                    assertEquals(View.GONE, a.findViewById<View>(R.id.ftCardProgress).visibility)
                }
            } finally {
                FileTransferActionReceiver.handler = previousHandler
                acker.shutdownNow()
            }
        }
    }

    /**
     * FT incident 2, item 2: an offer that arrived while NO Activity was in
     * front (so the in-app dialog never opened) must still be answerable
     * in-app: open the app, the card shows Accept, Accept fires the
     * notification's own Accept intent, and the transfer then runs on the card.
     *
     * The save picker is a system UI this test cannot drive, so the Accept
     * intent is stubbed and asserted, and the picker's result is delivered
     * the way FileTransferActivity delivers it - acceptOffer(uri) on the
     * manager. Everything after that is the real receive path.
     */
    @Test(timeout = 120_000)
    fun an_offer_that_arrived_backgrounded_shows_accept_when_the_app_is_opened() {
        val size = 2L * 1024 * 1024 + 77
        val src = File(dir, "src-offer.bin")
        val md = MessageDigest.getInstance("SHA-256")
        src.outputStream().buffered().use { out ->
            for (i in 0 until size.toInt()) {
                val b = (i * 31 % 251)
                out.write(b)
                md.update(b.toByte())
            }
        }
        val sha = FileTransfer.hex(md.digest())
        val id = "b".repeat(32)
        val peer = Peer()
        val mgr = FileTransferManager(
            context = ctx,
            send = { t, p -> peer.record(t, p) },
            isOpen = { true },
            queuedBytes = { 0L },
            listener = Forwarder(model),
        )

        // Backgrounded: no Activity of ours exists when the offer lands.
        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf(
                "id" to id, "name" to "report.pdf", "size" to size,
                "mime" to "application/pdf", "sha256" to sha, "from" to "browser",
            ),
        )
        assertTrue(mgr.isBusy)
        assertEquals(FileTransferUi.Offer(id, "report.pdf", size), model.state.value)

        Intents.init()
        try {
            Intents.intending(hasComponent(FileTransferActivity::class.java.name))
                .respondWith(android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_OK, null))

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                instr.waitForIdleSync()
                scenario.onActivity { a ->
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftCard).visibility)
                    assertEquals(
                        ctx.getString(R.string.ft_card_offer_heading),
                        a.findViewById<TextView>(R.id.ftCardHeading).text.toString(),
                    )
                    assertEquals("report.pdf", a.findViewById<TextView>(R.id.ftCardName).text.toString())
                    assertEquals(
                        FileTransfer.humanSize(size),
                        a.findViewById<TextView>(R.id.ftCardBytes).text.toString(),
                    )
                    assertEquals(
                        ctx.getString(R.string.ft_offer_trust),
                        a.findViewById<TextView>(R.id.ftCardMessage).text.toString(),
                    )
                    val accept = a.findViewById<TextView>(R.id.ftCardPrimary)
                    assertEquals(View.VISIBLE, accept.visibility)
                    assertEquals(ctx.getString(R.string.ft_accept), accept.text.toString())
                    assertEquals(
                        ctx.getString(R.string.ft_reject),
                        a.findViewById<TextView>(R.id.ftCardSecondary).text.toString(),
                    )
                    accept.performClick()
                }
                instr.waitForIdleSync()
                Intents.intended(
                    allOf(
                        hasComponent(FileTransferActivity::class.java.name),
                        hasAction(FileTransferActivity.ACTION_SHOW_OFFER),
                        hasExtra(FileTransferActivity.EXTRA_AUTO_ACCEPT, true),
                    )
                )

                // The picker's answer, delivered as FileTransferActivity does.
                val part = File(dir, FileTransfer.partNameFor("report.pdf"))
                mgr.acceptOffer(Uri.fromFile(part))
                assertNotNull("FILE_ACCEPT must go out", waitFor { peer.last(FileTransfer.ACCEPT) })
                val running = waitFor { model.state.value as? FileTransferUi.Running }
                assertNotNull("the accepted offer must become the running receive", running)
                assertFalse(running!!.outgoing)
                instr.waitForIdleSync()
                scenario.onActivity { a ->
                    assertEquals(
                        ctx.getString(R.string.ft_card_from_computer),
                        a.findViewById<TextView>(R.id.ftCardHeading).text.toString(),
                    )
                }

                feedChunks(mgr, src, size, id)
                mgr.onFrame(FileTransfer.DONE, mapOf("id" to id, "sha256" to sha))
                val done = waitFor { model.state.value as? FileTransferUi.Done }
                assertNotNull("the receive must finish on the card", done)
                assertEquals("report.pdf", done!!.name)
                instr.waitForIdleSync()
                scenario.onActivity { a ->
                    assertEquals(
                        ctx.getString(R.string.ft_received, "report.pdf"),
                        a.findViewById<TextView>(R.id.ftCardName).text.toString(),
                    )
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftCardPrimary).visibility)
                    assertEquals(
                        ctx.getString(R.string.ft_card_open),
                        a.findViewById<TextView>(R.id.ftCardPrimary).text.toString(),
                    )
                }
            }
        } finally {
            Intents.release()
        }
    }

    private fun feedChunks(mgr: FileTransferManager, src: File, size: Long, id: String) {
        val n = FileTransfer.chunkCount(size)
        RandomAccessFile(src, "r").use { raf ->
            val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
            for (seq in 0 until n) {
                val want = FileTransfer.lengthOf(seq, size)
                raf.seek(FileTransfer.offsetOf(seq))
                raf.readFully(buf, 0, want)
                mgr.onFrame(
                    FileTransfer.CHUNK,
                    mapOf(
                        "id" to id, "seq" to seq, "n" to n,
                        "data" to android.util.Base64.encodeToString(buf, 0, want, android.util.Base64.NO_WRAP),
                    ),
                )
            }
        }
    }

    private fun <T> waitFor(timeoutMs: Long = 20_000, f: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            f()?.let { return it }
            Thread.sleep(25)
        }
        return null
    }
}
