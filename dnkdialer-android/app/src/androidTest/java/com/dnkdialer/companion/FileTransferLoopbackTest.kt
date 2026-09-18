package com.dnkdialer.companion

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * FT-2 (f) — instrumented proof, driven by a **scripted relay peer**.
 *
 * ## What this is, and what it is NOT
 *
 * [ScriptedPeer] below is a Kotlin loopback that speaks the frozen FILE_*
 * frames. It is **not the relay**: it does not enforce accept-before-chunks,
 * declared-size, quota, tier or backpressure — those are FT-1's, tested there.
 * What it proves is the phone half: that a 200 MB file leaves this device in
 * correct, exactly-tiling chunks with a bounded heap, that a resume after a
 * socket kill produces a byte-identical file, that a corrupted stream is
 * caught by the hash and the `.part` deleted, and that a cancel is clean.
 *
 * Labelling that boundary matters: a loopback that both sides of a protocol
 * are written by the same author agrees with itself, so the assertions here
 * are all against **independently computed** values — a SHA-256 of the fixture
 * taken before the transfer starts, and a byte count taken from the
 * filesystem, never from the manager's own counters.
 */
@RunWith(AndroidJUnit4::class)
class FileTransferLoopbackTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var dir: File
    private val toClean = mutableListOf<File>()

    @Before
    fun setUp() {
        dir = File(ctx.cacheDir, "ft-test").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        FileTransferStore.clear(ctx)
    }

    @After
    fun tearDown() {
        toClean.forEach { it.delete() }
        dir.listFiles()?.forEach { it.delete() }
        FileTransferStore.clear(ctx)
    }

    // =====================================================================
    //                          the scripted peer
    // =====================================================================

    /**
     * The other end of the wire. Single-threaded delivery off a queue so that
     * frame ordering is deterministic and a failure is reproducible.
     */
    private class ScriptedPeer {
        /** Frames the device emitted, in order. */
        val sent = ConcurrentLinkedQueue<Pair<String, Map<String, Any?>>>()

        /** Set this to route the device's frames into a responder. */
        var onFrame: ((String, Map<String, Any?>) -> Unit)? = null

        val open = AtomicBoolean(true)

        /** Queued bytes we pretend the socket holds — drives the watermark. */
        @Volatile var queued: Long = 0

        /**
         * Record the frame, then deliver it.
         *
         * `data` is STRIPPED from what we retain. The recorder keeps every
         * frame for the assertions, and a 200 MB transfer is 4,267 chunks of
         * 64 KB of base64 - so retaining payloads means the HARNESS holds
         * ~273 MB of the file while the test asserts that nothing holds the
         * file. The first run of this test failed on exactly that: "heap grew
         * 294MB", all of it this queue.
         *
         * Delivery still gets the full payload, so the receiving side is
         * unaffected; only what survives the call is trimmed.
         */
        fun record(type: String, payload: Map<String, Any?>) {
            sent.add(type to if (type == FileTransfer.CHUNK) payload - "data" else payload)
            onFrame?.invoke(type, payload)
        }

        fun countOf(type: String) = sent.count { it.first == type }
        fun first(type: String) = sent.firstOrNull { it.first == type }?.second
        fun last(type: String) = sent.lastOrNull { it.first == type }?.second
    }

    private class Recorder : FileTransferManager.Listener {
        val done = CountDownLatch(1)
        @Volatile var completedUri: Uri? = null
        @Volatile var completedName: String? = null
        @Volatile var failedReason: String? = null
        @Volatile var offered: Triple<String, String, Long>? = null
        @Volatile var lastSent: Long = 0
        /** Peak of (total - free) observed while the transfer ran. */
        @Volatile var peakUsedBytes: Long = 0

        override fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean) {
            lastSent = sent
            val rt = Runtime.getRuntime()
            val used = rt.totalMemory() - rt.freeMemory()
            if (used > peakUsedBytes) peakUsedBytes = used
        }

        override fun onOfferReceived(id: String, name: String, size: Long, mime: String?) {
            offered = Triple(id, name, size)
        }

        override fun onComplete(id: String, name: String, uri: Uri?, outgoing: Boolean) {
            completedUri = uri; completedName = name; done.countDown()
        }

        override fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean) {
            failedReason = reason; done.countDown()
        }

        override fun onIdle() = Unit
    }

    private fun manager(peer: ScriptedPeer, rec: Recorder) = FileTransferManager(
        context = ctx,
        send = { type, payload -> peer.record(type, payload) },
        isOpen = { peer.open.get() },
        queuedBytes = { peer.queued },
        listener = rec,
    )

    // =====================================================================
    //                              fixtures
    // =====================================================================

    /**
     * A file of [size] bytes with **non-repeating** content.
     *
     * Deliberately not zeros: a transfer that dropped or duplicated a chunk of
     * zeros still hashes correctly against a zeroed expectation, so a zero
     * fixture cannot fail the test it exists to run. The counter pattern makes
     * every 48 KiB slice distinct.
     */
    private fun fixture(name: String, size: Long): Pair<File, String> {
        val f = File(dir, name)
        toClean.add(f)
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
        f.outputStream().buffered().use { out ->
            var written = 0L
            var counter = 0
            while (written < size) {
                val want = minOf(buf.size.toLong(), size - written).toInt()
                for (i in 0 until want) {
                    buf[i] = ((counter + i) * 31 % 251).toByte()
                }
                counter += want
                out.write(buf, 0, want)
                md.update(buf, 0, want)
                written += want
            }
        }
        return f to FileTransfer.hex(md.digest())
    }

    private fun sha256Of(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val got = ins.read(buf)
                if (got <= 0) break
                md.update(buf, 0, got)
            }
        }
        return FileTransfer.hex(md.digest())
    }

    // =====================================================================
    //                          (a) 200 MB send
    // =====================================================================

    /**
     * The memory proof. 200 MB out of this device with a bounded heap.
     *
     * The assertion is on GROWTH from a baseline taken after the fixture is
     * written, not on absolute heap: the process already holds the test
     * runner, the app and whatever the framework felt like keeping, and an
     * absolute bound would be measuring those.
     */
    @Test(timeout = 600_000)
    fun sends_200MB_without_ever_holding_the_file() {
        val size = 200L * 1024 * 1024
        val (file, expectedSha) = fixture("send-200mb.bin", size)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        val received = MessageDigest.getInstance("SHA-256")
        var bytesSeen = 0L
        var nextSeq = 0
        var declaredN = -1

        peer.onFrame = { type, p ->
            when (type) {
                FileTransfer.OFFER -> mgr.onFrame(
                    FileTransfer.ACCEPT, mapOf("id" to p["id"])
                )
                FileTransfer.CHUNK -> {
                    val seq = (p["seq"] as Number).toInt()
                    // Ordering is part of the contract: the receiver writes
                    // straight to disk and cannot reorder.
                    assertEquals("chunks must arrive in order", nextSeq, seq)
                    nextSeq++
                    declaredN = (p["n"] as Number).toInt()
                    val bytes = android.util.Base64.decode(
                        p["data"] as String, android.util.Base64.NO_WRAP
                    )
                    received.update(bytes)
                    bytesSeen += bytes.size
                    if (FileTransfer.shouldAck(seq, declaredN)) {
                        mgr.onFrame(FileTransfer.ACK, mapOf("id" to p["id"], "upTo" to seq))
                    }
                }
            }
        }

        System.gc()
        val rt = Runtime.getRuntime()
        val baseline = rt.totalMemory() - rt.freeMemory()

        mgr.startSend(Uri.fromFile(file))
        assertTrue("transfer did not finish", rec.done.await(500, TimeUnit.SECONDS))
        assertEquals(null, rec.failedReason)

        // Independently computed, both sides.
        assertEquals("every byte arrived exactly once", size, bytesSeen)
        assertEquals("the stream reassembles to the fixture", expectedSha, FileTransfer.hex(received.digest()))
        assertEquals(FileTransfer.chunkCount(size), declaredN)
        assertEquals(FileTransfer.chunkCount(size), peer.countOf(FileTransfer.CHUNK))

        // The offer declared the truth, before a byte moved.
        val offer = peer.first(FileTransfer.OFFER)!!
        assertEquals(expectedSha, offer["sha256"])
        assertEquals(size, (offer["size"] as Number).toLong())
        assertEquals("phone", offer["from"])
        assertEquals("send-200mb.bin", offer["name"])
        assertEquals(32, (offer["id"] as String).length)
        // FILE_DONE repeats the hash the offer promised.
        assertEquals(expectedSha, peer.last(FileTransfer.DONE)!!["sha256"])

        val growth = rec.peakUsedBytes - baseline
        android.util.Log.i(
            "FT2-MEM",
            "200MB send: baseline=${baseline / 1024 / 1024}MB peak=${rec.peakUsedBytes / 1024 / 1024}MB " +
                "growth=${growth / 1024}KB chunks=$declaredN"
        )
        // 8 MB is ~40x the theoretical working set (2 chunks of bytes + one
        // base64 String) and still 25x below the file. A design that buffered
        // the file would blow this by two orders of magnitude.
        assertTrue(
            "heap grew ${growth / 1024 / 1024}MB sending a 200MB file - it is being buffered",
            growth < 8L * 1024 * 1024
        )
    }

    // =====================================================================
    //                          (b) receive
    // =====================================================================

    @Test(timeout = 300_000)
    fun receives_a_file_verifies_the_hash_and_renames_off_part() {
        val size = 5L * 1024 * 1024 + 123
        val (src, sha) = fixture("src-recv.bin", size)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf(
                "id" to "a".repeat(32), "name" to "holiday.jpg", "size" to size,
                "mime" to "image/jpeg", "sha256" to sha, "from" to "browser"
            )
        )
        assertNotNull("the offer must reach the UI", waitFor { rec.offered })
        assertEquals("holiday.jpg", rec.offered!!.second)

        val part = File(dir, FileTransfer.partNameFor("holiday.jpg"))
        toClean.add(part)
        mgr.acceptOffer(Uri.fromFile(part))
        assertNotNull("FILE_ACCEPT must be emitted", waitFor { peer.first(FileTransfer.ACCEPT) })

        feedChunks(mgr, src, size, "a".repeat(32))
        mgr.onFrame(FileTransfer.DONE, mapOf("id" to "a".repeat(32), "sha256" to sha))

        assertTrue(rec.done.await(120, TimeUnit.SECONDS))
        assertEquals(null, rec.failedReason)

        val out = File(dir, "holiday.jpg")
        toClean.add(out)
        assertTrue("renamed off .part", out.isFile)
        assertFalse(".part must be gone", part.exists())
        assertEquals("byte-identical", sha, sha256Of(out))
        assertEquals(size, out.length())

        // ACK cadence is the contract the sender's window depends on.
        val n = FileTransfer.chunkCount(size)
        assertEquals(
            (0 until n).count { FileTransfer.shouldAck(it, n) },
            peer.countOf(FileTransfer.ACK)
        )
        assertEquals(n - 1, (peer.last(FileTransfer.ACK)!!["upTo"] as Number).toInt())
    }

    // =====================================================================
    //                          (c) resume
    // =====================================================================

    /**
     * Kill the socket mid-transfer, reconnect, finish — byte-identical.
     *
     * The interesting part is not that it completes; it is that the digest
     * survives. The receiver cannot serialise a MessageDigest, so on resume it
     * rebuilds one by re-reading the `.part`. If that rebuild were wrong the
     * transfer would still complete, still have the right byte count, and fail
     * only at the final hash — which is exactly the shape of bug that a test
     * asserting "the file is the right size" would pass.
     */
    @Test(timeout = 300_000)
    fun resumes_after_a_socket_kill_and_the_hash_still_matches() {
        val size = 3L * 1024 * 1024 + 7
        val (src, sha) = fixture("src-resume.bin", size)
        val id = "b".repeat(32)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf("id" to id, "name" to "doc.pdf", "size" to size,
                "mime" to "application/pdf", "sha256" to sha, "from" to "browser")
        )
        assertNotNull(waitFor { rec.offered })
        val part = File(dir, FileTransfer.partNameFor("doc.pdf"))
        toClean.add(part)
        mgr.acceptOffer(Uri.fromFile(part))
        assertNotNull(waitFor { peer.first(FileTransfer.ACCEPT) })

        val n = FileTransfer.chunkCount(size)
        val cut = 20                       // land mid-file, past several ACKs
        feedChunks(mgr, src, size, id, from = 0, until = cut)

        // The socket dies. The .part and its resume record must survive.
        peer.open.set(false)
        mgr.onDisconnected()
        val persisted = FileTransferStore.load(ctx, System.currentTimeMillis())
        assertNotNull("a resume record must exist", persisted)
        // Only ACKed chunks are claimed — the last un-ACKed ones are not.
        val lastAck = (peer.last(FileTransfer.ACK)!!["upTo"] as Number).toInt()
        assertEquals("upTo is the last ACK, never more", lastAck, persisted!!.upTo)
        assertEquals(FileTransfer.bytesThrough(lastAck, size), persisted.bytesWritten)

        // A fresh manager: this is a process-death resume, not a paused one.
        val peer2 = ScriptedPeer()
        val rec2 = Recorder()
        val mgr2 = manager(peer2, rec2)
        mgr2.onReconnected()
        val resume = waitFor { peer2.first(FileTransfer.RESUME) }
        assertNotNull("FILE_RESUME must be sent on reconnect", resume)
        assertEquals(id, resume!!["id"])
        assertEquals(lastAck, (resume["upTo"] as Number).toInt())

        feedChunks(mgr2, src, size, id, from = FileTransfer.resumeFrom(lastAck), until = n)
        mgr2.onFrame(FileTransfer.DONE, mapOf("id" to id, "sha256" to sha))

        assertTrue(rec2.done.await(120, TimeUnit.SECONDS))
        assertEquals(null, rec2.failedReason)
        val out = File(dir, "doc.pdf")
        toClean.add(out)
        assertTrue(out.isFile)
        assertEquals("resumed file must be byte-identical", sha, sha256Of(out))
        assertEquals(size, out.length())
    }

    // =====================================================================
    //                       (f) hash mismatch + cancel
    // =====================================================================

    @Test(timeout = 300_000)
    fun a_corrupted_stream_fails_hash_mismatch_and_deletes_the_part() {
        val size = 512L * 1024
        val (src, sha) = fixture("src-bad.bin", size)
        val id = "c".repeat(32)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf("id" to id, "name" to "note.txt", "size" to size,
                "mime" to "text/plain", "sha256" to sha, "from" to "browser")
        )
        assertNotNull(waitFor { rec.offered })
        val part = File(dir, FileTransfer.partNameFor("note.txt"))
        toClean.add(part)
        mgr.acceptOffer(Uri.fromFile(part))
        assertNotNull(waitFor { peer.first(FileTransfer.ACCEPT) })

        // Flip one byte in one chunk. A single bit is the honest test: a
        // wholesale-garbage stream would also be caught by the byte count.
        feedChunks(mgr, src, size, id, corruptSeq = 2)
        mgr.onFrame(FileTransfer.DONE, mapOf("id" to id, "sha256" to sha))

        assertTrue(rec.done.await(60, TimeUnit.SECONDS))
        assertEquals(FileTransfer.Reason.HASH_MISMATCH, rec.failedReason)
        assertFalse("the .part must be deleted on failure", part.exists())
        assertFalse("nothing may be renamed into place", File(dir, "note.txt").exists())
        assertEquals(
            FileTransfer.Reason.HASH_MISMATCH,
            peer.last(FileTransfer.FAILED)!!["reason"]
        )
        assertEquals("no resume record may survive a failure", null,
            FileTransferStore.load(ctx, System.currentTimeMillis()))
    }

    @Test(timeout = 300_000)
    fun cancelling_a_receive_deletes_the_part_and_reports_cancelled() {
        val size = 4L * 1024 * 1024
        val (src, sha) = fixture("src-cancel.bin", size)
        val id = "d".repeat(32)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf("id" to id, "name" to "big.bin", "size" to size,
                "mime" to "application/octet-stream", "sha256" to sha, "from" to "browser")
        )
        assertNotNull(waitFor { rec.offered })
        val part = File(dir, FileTransfer.partNameFor("big.bin"))
        toClean.add(part)
        mgr.acceptOffer(Uri.fromFile(part))
        assertNotNull(waitFor { peer.first(FileTransfer.ACCEPT) })

        feedChunks(mgr, src, size, id, from = 0, until = 10)
        mgr.cancel()

        assertTrue(rec.done.await(60, TimeUnit.SECONDS))
        assertEquals(FileTransfer.Reason.CANCELLED, rec.failedReason)
        assertFalse(part.exists())
        assertEquals(FileTransfer.Reason.CANCELLED, peer.last(FileTransfer.FAILED)!!["reason"])
    }

    /** One transfer at a time: a second offer is rejected, not queued. */
    @Test(timeout = 120_000)
    fun a_second_offer_while_busy_is_rejected() {
        val size = 1L * 1024 * 1024
        val (_, sha) = fixture("src-busy.bin", size)
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf("id" to "e".repeat(32), "name" to "one.bin", "size" to size,
                "mime" to "application/octet-stream", "sha256" to sha, "from" to "browser")
        )
        assertNotNull(waitFor { rec.offered })

        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf("id" to "f".repeat(32), "name" to "two.bin", "size" to size,
                "mime" to "application/octet-stream", "sha256" to sha, "from" to "browser")
        )
        val reject = waitFor { peer.first(FileTransfer.REJECT) }
        assertNotNull("the second offer must be rejected", reject)
        assertEquals("f".repeat(32), reject!!["id"])
        // The first offer is untouched.
        assertEquals("one.bin", rec.offered!!.second)
    }

    /** An offer above the 1 GB cap is refused before any byte is written. */
    @Test(timeout = 120_000)
    fun an_oversize_offer_is_refused_with_too_large() {
        val peer = ScriptedPeer()
        val rec = Recorder()
        val mgr = manager(peer, rec)
        mgr.onFrame(
            FileTransfer.OFFER,
            mapOf(
                "id" to "0".repeat(32), "name" to "huge.bin",
                "size" to FileTransfer.MAX_FILE_BYTES + 1,
                "mime" to "application/octet-stream", "sha256" to "00", "from" to "browser"
            )
        )
        val failed = waitFor { peer.first(FileTransfer.FAILED) }
        assertNotNull(failed)
        assertEquals(FileTransfer.Reason.TOO_LARGE, failed!!["reason"])
        assertEquals("no dialog may be raised for a refused offer", null, rec.offered)
    }

    // =====================================================================
    //                      (f) sealed-mode twin
    // =====================================================================

    /**
     * Mode ON: a FILE_CHUNK must pass the E2E chokepoint SEALED, and must not
     * be silently downgraded.
     *
     * This asserts the routing, not the crypto ([E2eFrameGate] does no crypto
     * by design and [E2eSession] is proved elsewhere). The failure it guards
     * against is the one that matters: a new frame family added to the product
     * that nobody put on the §13.7 list, which ships file content in the clear
     * on a pairing the user was told is encrypted.
     */
    @Test
    fun file_chunks_are_sealed_and_control_frames_are_not() {
        assertTrue(
            "FILE_CHUNK must be on the §13.7 sealed list",
            E2eFrameGate.isSealedType(FileTransfer.CHUNK)
        )
        // *_CHUNK, so §13.4's suffix rule makes it padding-exempt with no
        // amendment — asserted here so a change to that rule fails loudly.
        assertTrue(FileTransfer.CHUNK.endsWith("_CHUNK"))

        for (t in listOf(
            FileTransfer.ACCEPT, FileTransfer.REJECT, FileTransfer.ACK,
            FileTransfer.RESUME, FileTransfer.DONE, FileTransfer.FAILED
        )) {
            assertFalse(
                "$t must stay plaintext so the relay can enforce accept-before-chunks",
                E2eFrameGate.isSealedType(t)
            )
        }

        // Latched ON with no session: a chunk must be DROPPED, never sent in
        // the clear. The twin of the sealed path, and the one that is a
        // security bug rather than a lost frame.
        val gate = E2eFrameGate(sessionProvider = { null }, latchedProvider = { true })
        assertEquals(null, gate.outbound(FileTransfer.CHUNK, """{"id":"x","seq":0,"n":1,"data":"AA"}"""))
        assertEquals(1L, gate.droppedOutbound)
        // A control frame is unaffected.
        assertNotNull(gate.outbound(FileTransfer.ACK, """{"id":"x","upTo":0}"""))
    }

    // =====================================================================
    //                              helpers
    // =====================================================================

    /** Feed [src] into [mgr] as FILE_CHUNK frames, optionally corrupting one. */
    private fun feedChunks(
        mgr: FileTransferManager,
        src: File,
        size: Long,
        id: String,
        from: Int = 0,
        until: Int = FileTransfer.chunkCount(size),
        corruptSeq: Int = -1,
    ) {
        val n = FileTransfer.chunkCount(size)
        RandomAccessFile(src, "r").use { raf ->
            val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
            for (seq in from until until) {
                val want = FileTransfer.lengthOf(seq, size)
                raf.seek(FileTransfer.offsetOf(seq))
                raf.readFully(buf, 0, want)
                if (seq == corruptSeq) buf[0] = (buf[0].toInt() xor 0x01).toByte()
                mgr.onFrame(
                    FileTransfer.CHUNK,
                    mapOf(
                        "id" to id, "seq" to seq, "n" to n,
                        "data" to android.util.Base64.encodeToString(
                            buf, 0, want, android.util.Base64.NO_WRAP
                        )
                    )
                )
            }
        }
    }

    /** Poll for a value the worker thread produces. Null means it never came. */
    private fun <T> waitFor(timeoutMs: Long = 20_000, f: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            f()?.let { return it }
            Thread.sleep(25)
        }
        return null
    }
}
