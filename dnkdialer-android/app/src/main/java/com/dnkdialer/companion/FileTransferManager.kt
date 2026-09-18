package com.dnkdialer.companion

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * FT-2 — the file-transfer state machine for the phone, both directions.
 *
 * One transfer at a time, by construction: [active] is a single nullable slot
 * guarded by [lock]. The spec's ACK window, the receiver's disk bound and the
 * relay's abort-on-backpressure all reason about a single in-flight stream,
 * and a second concurrent stream is where each of those arguments stops being
 * true.
 *
 * ## Memory
 *
 * Nothing here ever holds the file. The sender reads [FileTransfer.CHUNK_RAW_BYTES]
 * at a time into ONE reused buffer and base64s that slice; the receiver decodes
 * one chunk and writes it straight to a file descriptor. Peak heap attributable
 * to a transfer is ~2 chunks of bytes plus ~1 chunk of base64 String — about
 * 200 KB — whether the file is 2 MB or 1 GB. That invariant is what the 200 MB
 * instrumented run exists to prove.
 *
 * ## Threading
 *
 * The transfer body runs on [worker], a single thread. Inbound frames arrive on
 * the WebSocket reader thread and do nothing but mutate volatile state and
 * `lock.notifyAll()`. No frame handler blocks, because the reader thread is
 * also how the ACK that unblocks the sender gets delivered — a handler that
 * waited on the sender would deadlock the socket against itself.
 */
class FileTransferManager(
    private val context: Context,
    /** Emit a frame. Goes through PhoneClient's single seal chokepoint. */
    private val send: (String, Map<String, Any?>) -> Unit,
    /** Is the relay socket open right now? */
    private val isOpen: () -> Boolean,
    /** Bytes queued on the socket but not yet written — the §1 watermark input. */
    private val queuedBytes: () -> Long,
    private val listener: Listener,
) {

    /** What the notification/UI layer needs to know. It is told, it does not poll. */
    interface Listener {
        /** A transfer is running. [sent]/[total] are raw file bytes. */
        fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean)

        /** A peer offered us a file and we need an Accept/Reject decision. */
        fun onOfferReceived(id: String, name: String, size: Long, mime: String?)

        /** Terminal success. [uri] is the finished document when incoming. */
        fun onComplete(id: String, name: String, uri: Uri?, outgoing: Boolean)

        /** Terminal failure. [reason] is a [FileTransfer.Reason] value. */
        fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean)

        /** Nothing is running; tear down any ongoing notification. */
        fun onIdle()
    }

    // ------------------------------------------------------------ the slot

    private val lock = Object()
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "file-transfer").apply { isDaemon = true }
    }

    private sealed class Active {
        abstract val id: String
        abstract val name: String
        abstract val size: Long

        class Send(
            override val id: String,
            override val name: String,
            override val size: Long,
            val uri: Uri,
            val sha256: String,
            val mime: String?,
        ) : Active() {
            @Volatile var accepted = false
            @Volatile var ackedUpTo: Int = FileTransfer.NOTHING_RECEIVED
            /** Set by an inbound FILE_RESUME; the streaming loop restarts here. */
            @Volatile var restartFrom: Int? = null
            @Volatile var sentBytes: Long = 0
        }

        class Receive(
            override val id: String,
            override val name: String,
            override val size: Long,
            val sha256: String,
            val mime: String?,
            val partUri: Uri,
        ) : Active() {
            var pfd: ParcelFileDescriptor? = null
            var out: FileOutputStream? = null
            var digest: MessageDigest = MessageDigest.getInstance("SHA-256")
            @Volatile var upTo: Int = FileTransfer.NOTHING_RECEIVED
            @Volatile var written: Long = 0
            @Volatile var n: Int = FileTransfer.chunkCount(size)
        }
    }

    /** An offer we have shown but not yet answered. Not yet a transfer. */
    private data class PendingOffer(
        val id: String,
        val name: String,
        val size: Long,
        val sha256: String,
        val mime: String?,
        val offeredAtMs: Long,
    )

    @Volatile private var active: Active? = null
    @Volatile private var pendingOffer: PendingOffer? = null
    @Volatile private var lastActivityMs: Long = 0
    private val cancelled = AtomicBoolean(false)

    /** True while anything is in flight — the UI's "busy" and the busy-reject test. */
    val isBusy: Boolean get() = active != null || pendingOffer != null

    // =====================================================================
    //                              SENDING
    // =====================================================================

    /**
     * Begin sending the SAF document at [uri].
     *
     * Two passes over the file. The first hashes it, the second sends it.
     *
     * The second pass is not an oversight: `FILE_OFFER` carries `sha256`, and a
     * hash the receiver learns only at the end cannot be shown before Accept —
     * which is the whole protection this feature offers, since we do not scan
     * files (spec §6). Hashing while sending would let us skip a read and would
     * make the offer a promise we compute afterwards.
     */
    fun startSend(uri: Uri) {
        synchronized(lock) {
            if (isBusy) {
                listener.onFailed(
                    "", null, FileTransfer.Reason.CANCELLED, true
                )
                return
            }
        }
        worker.execute { runSend(uri) }
    }

    private fun runSend(uri: Uri) {
        var name = "file"
        var id = ""
        try {
            cancelled.set(false)
            val meta = queryMeta(uri)
            name = FileTransfer.sanitizeName(meta.first)
            val size = meta.second

            if (size < 0) {
                listener.onFailed("", name, FileTransfer.Reason.CANCELLED, true)
                return
            }
            // (d) Local refusal above 1 GB, with the SAME copy the server sends
            // back. The client's cap is UX, never enforcement — the relay
            // checks `size` at the FILE_OFFER gate and it is the only enforcer.
            if (size > FileTransfer.MAX_FILE_BYTES) {
                listener.onFailed("", name, FileTransfer.Reason.TOO_LARGE, true)
                return
            }

            val mime = context.contentResolver.getType(uri)
            val sha = hashFile(uri) ?: run {
                listener.onFailed("", name, FileTransfer.Reason.CANCELLED, true)
                return
            }
            if (cancelled.get()) {
                listener.onFailed("", name, FileTransfer.Reason.CANCELLED, true)
                return
            }

            id = FileTransfer.newTransferId()
            val s = Active.Send(id, name, size, uri, sha, mime)
            synchronized(lock) {
                if (isBusy) {
                    listener.onFailed(id, name, FileTransfer.Reason.CANCELLED, true)
                    return
                }
                active = s
            }
            touch()

            send(
                FileTransfer.OFFER,
                mapOf(
                    "id" to id,
                    "name" to name,
                    "size" to size,
                    "mime" to (mime ?: "application/octet-stream"),
                    "sha256" to sha,
                    "from" to FileTransfer.FROM_PHONE,
                )
            )

            // Wait for FILE_ACCEPT. A FILE_FAILED (quota / tier / too_large)
            // from the relay lands in onFrame and clears `active`, which is
            // how this loop learns it was refused rather than ignored.
            val deadline = System.currentTimeMillis() + FileTransfer.OFFER_EXPIRY_MS
            synchronized(lock) {
                while (active === s && !s.accepted && System.currentTimeMillis() < deadline) {
                    lock.wait(250)
                }
            }
            if (active !== s) return // failed/cancelled by a frame; already reported
            if (!s.accepted) {
                fail(s, FileTransfer.Reason.CANCELLED, true)
                return
            }

            streamChunks(s)
        } catch (e: OutOfMemoryError) {
            android.util.Log.e("FileTransfer", "OOM sending", e)
            (active as? Active.Send)?.let { fail(it, FileTransfer.Reason.OOM, true) }
                ?: listener.onFailed(id, name, FileTransfer.Reason.OOM, true)
        } catch (e: Exception) {
            android.util.Log.e("FileTransfer", "send failed: ${e.message}", e)
            (active as? Active.Send)?.let { fail(it, FileTransfer.Reason.CONNECTION_LOST, true) }
                ?: listener.onFailed(id, name, FileTransfer.Reason.CONNECTION_LOST, true)
        }
    }

    /**
     * The streaming loop. Re-entrant on resume: [Active.Send.restartFrom] set
     * by an inbound FILE_RESUME makes it seek and continue rather than start
     * a second transfer.
     */
    private fun streamChunks(s: Active.Send) {
        val n = FileTransfer.chunkCount(s.size)
        var seq = 0
        val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
        val startedMs = System.currentTimeMillis()

        while (seq < n) {
            if (cancelled.get()) {
                fail(s, FileTransfer.Reason.CANCELLED, true); return
            }
            if (active !== s) return
            if (!isOpen()) {
                // Do NOT fail immediately: a resume may re-attach within the
                // window, and the receiver keeps its .part. Wait out the stall
                // timeout and let that decide.
                if (!awaitReconnect(s)) return
            }

            // A resume repositions the loop. Read the volatile once — two
            // reads could straddle the arrival of a second FILE_RESUME and
            // leave the digest and the seek disagreeing about where we are.
            s.restartFrom?.let { from ->
                s.restartFrom = null
                seq = from
                s.ackedUpTo = from - 1
                s.sentBytes = FileTransfer.bytesThrough(from - 1, s.size)
                android.util.Log.i("FileTransfer", "resuming send ${s.id} from seq $from")
            }

            // §1 backpressure, both halves. The ACK window bounds the PEER;
            // the socket watermark bounds US. Either alone is insufficient:
            // a peer that ACKs eagerly still lets our outbound queue grow, and
            // a drained queue says nothing about whether the peer is keeping up.
            var waited = 0L
            while (seq - s.ackedUpTo > FileTransfer.ACK_WINDOW_CHUNKS ||
                queuedBytes() > FileTransfer.OUTBOUND_WATERMARK_BYTES
            ) {
                if (cancelled.get() || active !== s) {
                    if (cancelled.get()) fail(s, FileTransfer.Reason.CANCELLED, true)
                    return
                }
                synchronized(lock) { lock.wait(25) }
                waited += 25
                if (waited > FileTransfer.STALL_TIMEOUT_MS) {
                    fail(s, FileTransfer.Reason.TIMEOUT, true); return
                }
            }

            val want = FileTransfer.lengthOf(seq, s.size)
            val read = readSlice(s.uri, FileTransfer.offsetOf(seq), buf, want)
            if (read != want) {
                // The SAF handle died or the file changed under us. The spec's
                // answer for "sender no longer holds the file" is cancelled.
                fail(s, FileTransfer.Reason.CANCELLED, true); return
            }

            val data = Base64.encodeToString(buf, 0, want, Base64.NO_WRAP)
            send(
                FileTransfer.CHUNK,
                mapOf("id" to s.id, "seq" to seq, "n" to n, "data" to data)
            )
            s.sentBytes = FileTransfer.offsetOf(seq) + want
            touch()
            if (seq % 16 == 0 || seq == n - 1) {
                listener.onProgress(s.id, s.name, s.sentBytes, s.size, true)
            }
            seq++
        }

        // Every chunk is out; wait for the final ACK before declaring done, so
        // a transfer that the receiver never finished writing is not reported
        // to the user as delivered.
        val deadline = System.currentTimeMillis() + FileTransfer.STALL_TIMEOUT_MS
        synchronized(lock) {
            while (active === s && s.ackedUpTo < n - 1 && System.currentTimeMillis() < deadline) {
                lock.wait(100)
            }
        }
        if (active !== s) return
        if (n > 0 && s.ackedUpTo < n - 1) {
            fail(s, FileTransfer.Reason.TIMEOUT, true); return
        }

        send(FileTransfer.DONE, mapOf("id" to s.id, "sha256" to s.sha256))
        android.util.Log.i(
            "FileTransfer",
            "sent ${s.size} B in $n chunks in ${System.currentTimeMillis() - startedMs} ms"
        )
        finishActive(s)
        listener.onComplete(s.id, s.name, null, true)
    }

    /** Wait out a socket drop; false means we gave up and already reported it. */
    private fun awaitReconnect(s: Active.Send): Boolean {
        val deadline = System.currentTimeMillis() + FileTransfer.STALL_TIMEOUT_MS
        synchronized(lock) {
            while (!isOpen() && active === s && System.currentTimeMillis() < deadline) {
                lock.wait(250)
            }
        }
        if (active !== s) return false
        if (!isOpen()) {
            fail(s, FileTransfer.Reason.CONNECTION_LOST, true)
            return false
        }
        return true
    }

    // =====================================================================
    //                             RECEIVING
    // =====================================================================

    /**
     * The user accepted; [partUri] is the SAF document to stream into.
     *
     * The document is created by [FileTransferActivity] via ACTION_CREATE_DOCUMENT
     * and is named `<name>.part`. It is renamed to the real name only after the
     * sha256 verifies, so a half-file is never mistakable for the real thing and
     * a failure has exactly one thing to delete.
     */
    fun acceptOffer(partUri: Uri) {
        val offer = pendingOffer ?: return
        worker.execute {
            try {
                val r = Active.Receive(
                    offer.id, offer.name, offer.size, offer.sha256, offer.mime, partUri
                )
                val pfd = context.contentResolver.openFileDescriptor(partUri, "rw")
                    ?: throw IllegalStateException("no descriptor for $partUri")
                r.pfd = pfd
                // ONE stream over this descriptor, and the truncate goes
                // through it. A second FileOutputStream built from the same
                // FileDescriptor would own the same fd, and whichever one the
                // GC reached first would close the descriptor out from under
                // the other — mid-transfer, with no error that names the cause.
                //
                // Truncating at all: a document provider may hand back a file
                // that already has bytes in it, and appending to those produces
                // a file whose hash can only fail at the very end of a 1 GB
                // transfer.
                val out = FileOutputStream(pfd.fileDescriptor)
                out.channel.truncate(0)
                r.out = out
                synchronized(lock) {
                    active = r
                    pendingOffer = null
                }
                touch()
                send(FileTransfer.ACCEPT, mapOf("id" to offer.id))
                listener.onProgress(r.id, r.name, 0, r.size, false)
                persistResume(r)
                // A zero-byte file has no chunks; FILE_DONE will arrive next.
            } catch (e: Exception) {
                android.util.Log.e("FileTransfer", "accept failed: ${e.message}", e)
                pendingOffer = null
                send(
                    FileTransfer.FAILED,
                    mapOf("id" to offer.id, "reason" to FileTransfer.Reason.CANCELLED)
                )
                listener.onFailed(offer.id, offer.name, FileTransfer.Reason.CANCELLED, false)
                listener.onIdle()
            }
        }
    }

    /** The user said no. */
    fun rejectOffer() {
        val offer = pendingOffer ?: return
        pendingOffer = null
        send(FileTransfer.REJECT, mapOf("id" to offer.id))
        listener.onIdle()
    }

    /** The pending offer's metadata, for the dialog. */
    fun pendingOfferInfo(): Triple<String, String, Long>? =
        pendingOffer?.let { Triple(it.id, it.name, it.size) }

    private fun onChunk(payload: Map<String, Any?>) {
        val r = active as? Active.Receive ?: return
        val id = payload["id"] as? String ?: return
        if (id != r.id) return
        val seq = (payload["seq"] as? Number)?.toInt() ?: return
        val data = payload["data"] as? String ?: return

        // The sender is strictly ordered, so anything but the next chunk is a
        // duplicate from a resume overlap or a forgery. Dropping is right for
        // both; buffering out-of-order chunks would mean holding them, which
        // is the memory bound this design exists to avoid.
        if (seq != r.upTo + 1) {
            android.util.Log.d("FileTransfer", "ignoring out-of-order chunk $seq (have ${r.upTo})")
            return
        }

        try {
            val bytes = Base64.decode(data, Base64.NO_WRAP)
            val out = r.out ?: return
            out.write(bytes)
            r.digest.update(bytes)
            r.upTo = seq
            r.written += bytes.size
            touch()

            if (FileTransfer.shouldAck(seq, r.n)) {
                // Sync BEFORE persisting the resume point and before ACKing.
                // An ACK is a promise that these bytes survive a crash; making
                // it before the sync turns a crash into a silently truncated
                // file that resumes from the wrong place.
                out.flush()
                r.pfd?.fileDescriptor?.sync()
                persistResume(r)
                send(FileTransfer.ACK, mapOf("id" to r.id, "upTo" to r.upTo))
            }
            if (seq % 16 == 0 || seq == r.n - 1) {
                listener.onProgress(r.id, r.name, r.written, r.size, false)
            }
        } catch (e: OutOfMemoryError) {
            fail(r, FileTransfer.Reason.OOM, false)
        } catch (e: Exception) {
            android.util.Log.e("FileTransfer", "chunk write failed: ${e.message}", e)
            fail(r, FileTransfer.Reason.CONNECTION_LOST, false)
        }
    }

    private fun onDone(payload: Map<String, Any?>) {
        val r = active as? Active.Receive ?: return
        if (payload["id"] as? String != r.id) return
        worker.execute { finishReceive(r, payload["sha256"] as? String) }
    }

    private fun finishReceive(r: Active.Receive, declared: String?) {
        try {
            r.out?.flush()
            r.pfd?.fileDescriptor?.sync()
            val got = FileTransfer.hex(r.digest.digest())
            // Check against BOTH the offer's hash and FILE_DONE's. They are the
            // same value on an honest sender; a mismatch between them is a
            // sender that changed its mind about what it sent, which is exactly
            // the case the pre-Accept hash display exists to make detectable.
            val want = declared ?: r.sha256
            if (!got.equals(want, ignoreCase = true) || !got.equals(r.sha256, ignoreCase = true)) {
                android.util.Log.e("FileTransfer", "hash mismatch: got $got want $want/${r.sha256}")
                closeReceive(r)
                deleteDoc(r.partUri)
                FileTransferStore.clear(context)
                send(
                    FileTransfer.FAILED,
                    mapOf("id" to r.id, "reason" to FileTransfer.Reason.HASH_MISMATCH)
                )
                finishActive(r)
                listener.onFailed(r.id, r.name, FileTransfer.Reason.HASH_MISMATCH, false)
                return
            }
            closeReceive(r)
            val finalUri = renameOffPart(r.partUri, r.name)
            FileTransferStore.clear(context)
            finishActive(r)
            listener.onComplete(r.id, r.name, finalUri ?: r.partUri, false)
        } catch (e: Exception) {
            android.util.Log.e("FileTransfer", "finish failed: ${e.message}", e)
            closeReceive(r)
            deleteDoc(r.partUri)
            FileTransferStore.clear(context)
            finishActive(r)
            listener.onFailed(r.id, r.name, FileTransfer.Reason.CONNECTION_LOST, false)
        }
    }

    // =====================================================================
    //                        FRAME DISPATCH + RESUME
    // =====================================================================

    /** Every FILE_* frame from the relay lands here. Never blocks. */
    fun onFrame(type: String, payload: Map<String, Any?>?) {
        val p = payload ?: emptyMap()
        when (type) {
            FileTransfer.OFFER -> onOffer(p)
            FileTransfer.ACCEPT -> {
                val s = active as? Active.Send ?: return
                if (p["id"] as? String != s.id) return
                s.accepted = true
                touch()
                synchronized(lock) { lock.notifyAll() }
            }
            FileTransfer.REJECT -> {
                val s = active as? Active.Send ?: return
                if (p["id"] as? String != s.id) return
                fail(s, FileTransfer.Reason.CANCELLED, true)
            }
            FileTransfer.CHUNK -> onChunk(p)
            FileTransfer.ACK -> {
                val s = active as? Active.Send ?: return
                if (p["id"] as? String != s.id) return
                val upTo = (p["upTo"] as? Number)?.toInt() ?: return
                if (upTo > s.ackedUpTo) s.ackedUpTo = upTo
                touch()
                synchronized(lock) { lock.notifyAll() }
            }
            FileTransfer.RESUME -> {
                val s = active as? Active.Send ?: return
                if (p["id"] as? String != s.id) return
                val upTo = (p["upTo"] as? Number)?.toInt() ?: FileTransfer.NOTHING_RECEIVED
                s.restartFrom = FileTransfer.resumeFrom(upTo)
                s.accepted = true
                touch()
                synchronized(lock) { lock.notifyAll() }
            }
            FileTransfer.DONE -> onDone(p)
            FileTransfer.FAILED -> {
                val a = active ?: return
                if (p["id"] as? String != a.id) return
                val reason = (p["reason"] as? String)?.takeIf { it in FileTransfer.Reason.ALL }
                    ?: FileTransfer.Reason.CONNECTION_LOST
                fail(a, reason, a is Active.Send)
            }
        }
    }

    private fun onOffer(p: Map<String, Any?>) {
        val id = p["id"] as? String ?: return
        val size = (p["size"] as? Number)?.toLong() ?: return
        if (isBusy) {
            // One transfer at a time. Rejecting is the honest answer; queueing
            // would mean holding an offer whose sender has a 60 s expiry.
            send(FileTransfer.REJECT, mapOf("id" to id))
            return
        }
        if (size > FileTransfer.MAX_FILE_BYTES) {
            send(
                FileTransfer.FAILED,
                mapOf("id" to id, "reason" to FileTransfer.Reason.TOO_LARGE)
            )
            return
        }
        val name = FileTransfer.sanitizeName(p["name"] as? String)
        val offer = PendingOffer(
            id = id,
            name = name,
            size = size,
            sha256 = (p["sha256"] as? String).orEmpty(),
            mime = p["mime"] as? String,
            offeredAtMs = System.currentTimeMillis(),
        )
        pendingOffer = offer
        touch()
        listener.onOfferReceived(id, name, size, offer.mime)
    }

    /**
     * (c) On reconnect, re-attach to a half-written receive.
     *
     * Rebuilds the digest by re-reading what is on disk. A MessageDigest is not
     * serialisable and there is no incremental-state API, so the choice is
     * re-read or re-transfer; re-reading 200 MB off local storage costs about a
     * second and re-transferring costs minutes of somebody's uplink.
     */
    fun onReconnected() {
        worker.execute {
            if (active != null) return@execute
            val p = FileTransferStore.load(context, System.currentTimeMillis()) ?: run {
                // Unknown version, unparseable, or expired: the .part is
                // unreachable garbage, so delete it rather than leave it.
                FileTransferStore.loadUriForCleanup(context)?.let { deleteDoc(Uri.parse(it)) }
                FileTransferStore.clear(context)
                return@execute
            }
            try {
                val uri = Uri.parse(p.uri)
                val pfd = context.contentResolver.openFileDescriptor(uri, "rw") ?: return@execute
                // Discard any tail written after the last sync: the ACK we sent
                // covers exactly p.bytesWritten, and anything past it is bytes
                // the sender will send again. Same fd-ownership rule as in
                // acceptOffer — this is the ONE output stream on the descriptor.
                val out = FileOutputStream(pfd.fileDescriptor)
                out.channel.truncate(p.bytesWritten)
                val digest = MessageDigest.getInstance("SHA-256")
                FileInputStream(pfd.fileDescriptor).use { fis ->
                    val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
                    var remaining = p.bytesWritten
                    while (remaining > 0) {
                        val want = minOf(buf.size.toLong(), remaining).toInt()
                        val got = fis.read(buf, 0, want)
                        if (got <= 0) break
                        digest.update(buf, 0, got)
                        remaining -= got
                    }
                }
                val r = Active.Receive(p.id, p.name, p.size, p.sha256, null, uri)
                r.pfd = pfd
                out.channel.position(p.bytesWritten)
                r.out = out
                r.digest = digest
                r.upTo = p.upTo
                r.written = p.bytesWritten
                synchronized(lock) { active = r }
                touch()
                send(FileTransfer.RESUME, mapOf("id" to p.id, "upTo" to p.upTo))
                listener.onProgress(r.id, r.name, r.written, r.size, false)
                android.util.Log.i("FileTransfer", "resuming receive ${p.id} from upTo=${p.upTo}")
            } catch (e: Exception) {
                android.util.Log.w("FileTransfer", "resume failed: ${e.message}")
                deleteDoc(Uri.parse(p.uri))
                FileTransferStore.clear(context)
            }
        }
    }

    /** The socket went away. A send waits it out; a receive keeps its .part. */
    fun onDisconnected() {
        synchronized(lock) { lock.notifyAll() }
    }

    /** User pressed Cancel. */
    fun cancel() {
        cancelled.set(true)
        val a = active
        synchronized(lock) { lock.notifyAll() }
        if (a != null) {
            send(
                FileTransfer.FAILED,
                mapOf("id" to a.id, "reason" to FileTransfer.Reason.CANCELLED)
            )
            if (a is Active.Receive) {
                closeReceive(a)
                deleteDoc(a.partUri)
                FileTransferStore.clear(context)
                finishActive(a)
                listener.onFailed(a.id, a.name, FileTransfer.Reason.CANCELLED, false)
            }
            // A send unwinds through its own loop on the `cancelled` flag, so
            // that the failure is reported once, from one place.
        } else {
            pendingOffer?.let { rejectOffer() }
        }
    }

    /**
     * The 30 s stall watchdog. Driven by whoever owns a ticker (PhoneService's
     * existing loop) rather than by a timer of our own — one more scheduled
     * executor in a service that already has several is a lifecycle bug
     * waiting for a process death to expose it.
     */
    fun tick() {
        val a = active ?: run {
            val o = pendingOffer ?: return
            if (System.currentTimeMillis() - o.offeredAtMs > FileTransfer.OFFER_EXPIRY_MS) {
                pendingOffer = null
                send(FileTransfer.REJECT, mapOf("id" to o.id))
                listener.onIdle()
            }
            return
        }
        if (lastActivityMs != 0L &&
            System.currentTimeMillis() - lastActivityMs > FileTransfer.STALL_TIMEOUT_MS
        ) {
            // A receive whose socket is merely down is NOT stalled — it is
            // resumable, and killing it here would delete a .part the peer is
            // about to continue into.
            if (a is Active.Receive && !isOpen()) return
            fail(a, FileTransfer.Reason.TIMEOUT, a is Active.Send)
        }
    }

    // =====================================================================
    //                              PLUMBING
    // =====================================================================

    private fun touch() {
        lastActivityMs = System.currentTimeMillis()
    }

    private fun fail(a: Active, reason: String, outgoing: Boolean) {
        if (active !== a) return
        send(FileTransfer.FAILED, mapOf("id" to a.id, "reason" to reason))
        if (a is Active.Receive) {
            closeReceive(a)
            deleteDoc(a.partUri)   // .part deleted on ANY failure, spec §c
            FileTransferStore.clear(context)
        }
        finishActive(a)
        listener.onFailed(a.id, a.name, reason, outgoing)
    }

    private fun finishActive(a: Active) {
        // Release the sender's read handle on EVERY terminal path, success
        // included. A leaked InputStream on a SAF document keeps a descriptor
        // and, on some providers, a wake lock on the backing storage.
        try { seqStream?.close() } catch (e: Exception) { /* terminal anyway */ }
        seqStream = null
        seqPos = -1
        synchronized(lock) {
            if (active === a) active = null
            lock.notifyAll()
        }
        lastActivityMs = 0
        listener.onIdle()
    }

    private fun persistResume(r: Active.Receive) {
        FileTransferStore.save(
            context,
            FileTransferStore.Pending(
                id = r.id, sha256 = r.sha256, name = r.name, size = r.size,
                upTo = r.upTo, bytesWritten = r.written,
                uri = r.partUri.toString(), savedAtMs = System.currentTimeMillis(),
            )
        )
    }

    private fun closeReceive(r: Active.Receive) {
        try { r.out?.flush() } catch (e: Exception) { /* closing anyway */ }
        try { r.out?.close() } catch (e: Exception) { /* closing anyway */ }
        try { r.pfd?.close() } catch (e: Exception) { /* closing anyway */ }
        r.out = null
        r.pfd = null
    }

    private fun deleteDoc(uri: Uri) {
        try {
            if (uri.scheme == "file") {
                uri.path?.let { java.io.File(it).delete() }
                return
            }
            DocumentsContract.deleteDocument(context.contentResolver, uri)
        } catch (e: Exception) {
            android.util.Log.w("FileTransfer", "could not delete ${uri.lastPathSegment}: ${e.message}")
        }
    }

    /**
     * `file://` handling exists so the instrumented loopback can drive these
     * exact code paths without a FileProvider in the production manifest — a
     * test-only provider is production surface, and the alternative (a mocked
     * rename) would prove nothing about the rename.
     *
     * It is not dead weight in production either: a document provider that
     * hands back a file URI gets correct behaviour instead of a stuck `.part`.
     */
    private fun renameOffPart(uri: Uri, finalName: String): Uri? = try {
        if (uri.scheme == "file") {
            renameLocalFile(uri, finalName)
        } else {
            // SAF de-duplicates for us: renaming onto an existing name yields
            // "holiday (1).jpg" from the provider, which is the collision
            // suffix the spec asks for, produced by the component that can
            // actually see what else is in the directory.
            DocumentsContract.renameDocument(context.contentResolver, uri, finalName)
        }
    } catch (e: Exception) {
        android.util.Log.w("FileTransfer", "rename failed, file stays .part: ${e.message}")
        null
    }

    /**
     * The collision suffix, applied by us because a plain filesystem will
     * happily let one transfer overwrite the last one's result.
     */
    private fun renameLocalFile(uri: Uri, finalName: String): Uri? {
        val part = java.io.File(uri.path ?: return null)
        val dir = part.parentFile ?: return null
        var attempt = 0
        while (attempt < 1000) {
            val candidate = java.io.File(dir, FileTransfer.collisionName(finalName, attempt))
            if (!candidate.exists()) {
                return if (part.renameTo(candidate)) Uri.fromFile(candidate) else null
            }
            attempt++
        }
        return null
    }

    /** (name, size) from the document provider; size -1 when unknown. */
    private fun queryMeta(uri: Uri): Pair<String?, Long> {
        var name: String? = null
        var size = -1L
        // A file:// URI has no provider to query. Reading it directly is what
        // lets the instrumented loopback exercise the real send path; it is
        // also simply correct for any provider that hands one back.
        if (uri.scheme == "file") {
            val f = java.io.File(uri.path ?: "")
            if (f.isFile) return f.name to f.length()
        }
        try {
            context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("FileTransfer", "meta query failed: ${e.message}")
        }
        return name to size
    }

    /** Streamed SHA-256. One reused buffer; the file is never resident. */
    private fun hashFile(uri: Uri): String? {
        return try {
            val md = MessageDigest.getInstance("SHA-256")
            var aborted = false
            val opened = context.contentResolver.openInputStream(uri)?.use { ins ->
                val buf = ByteArray(FileTransfer.CHUNK_RAW_BYTES)
                while (true) {
                    if (cancelled.get()) { aborted = true; break }
                    val got = ins.read(buf)
                    if (got <= 0) break
                    md.update(buf, 0, got)
                }
                true
            }
            if (opened != true || aborted) null else FileTransfer.hex(md.digest())
        } catch (e: Exception) {
            android.util.Log.e("FileTransfer", "hash failed: ${e.message}", e)
            null
        }
    }

    /**
     * Read exactly [want] bytes at [offset] into [buf].
     *
     * Re-opens the stream per chunk and skips. That is O(n²) on a provider
     * that cannot seek — but [ContentResolver.openInputStream] on a local
     * document returns a FileInputStream whose `skip` is a real lseek, and the
     * alternative (one long-lived stream) cannot serve a resume, which has to
     * start from an arbitrary offset in a stream the previous attempt closed.
     * Sequential reads keep the common case to one open per chunk with a
     * seek of zero cost.
     */
    private var seqStream: InputStream? = null
    private var seqPos: Long = -1

    private fun readSlice(uri: Uri, offset: Long, buf: ByteArray, want: Int): Int {
        try {
            if (seqStream == null || seqPos != offset) {
                try { seqStream?.close() } catch (e: Exception) { /* replacing it */ }
                seqStream = context.contentResolver.openInputStream(uri) ?: return -1
                var toSkip = offset
                while (toSkip > 0) {
                    val skipped = seqStream!!.skip(toSkip)
                    if (skipped <= 0) return -1
                    toSkip -= skipped
                }
                seqPos = offset
            }
            var got = 0
            while (got < want) {
                val r = seqStream!!.read(buf, got, want - got)
                if (r <= 0) break
                got += r
            }
            seqPos += got
            if (got < want) {
                try { seqStream?.close() } catch (e: Exception) { /* done with it */ }
                seqStream = null
                seqPos = -1
            }
            return got
        } catch (e: Exception) {
            android.util.Log.e("FileTransfer", "read failed: ${e.message}", e)
            try { seqStream?.close() } catch (e2: Exception) { /* done with it */ }
            seqStream = null
            seqPos = -1
            return -1
        }
    }
}
