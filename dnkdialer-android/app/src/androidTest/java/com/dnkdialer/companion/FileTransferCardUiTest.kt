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
import java.io.File
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

    private fun <T> waitFor(timeoutMs: Long = 20_000, f: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            f()?.let { return it }
            Thread.sleep(25)
        }
        return null
    }
}
