package com.dnkdialer.companion

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * FILE-QUEUE (Ken ADDENDUM 2, 2026-09-25) — the phone's local send queue.
 *
 * Zero wire change: the relay stays one-transfer-per-room and
 * [FileTransferManager] stays one-at-a-time. This class only decides WHEN to
 * call [Sender.start] for the next file, and records what happened to each
 * one. It is fed the SAME [FileTransferManager.Listener] events PhoneService
 * already forwards to the card and the notification - there is no second
 * progress source.
 *
 * Pure: no Android type. Clock, key minting, the manager and persistence are
 * injected, so every rule row is unit-tested on the JVM
 * (`tests/ft-queue-vectors.json`, [FileTransferQueueVectorsTest]).
 *
 * ## Scheduler rules (ADDENDUM 2, binding)
 *
 *  - Strictly one in flight. The next queued item is offered only when no
 *    queue item is offering/sending AND the manager is idle
 *    ([Sender.isBusy] false - that covers an incoming receive or an offer
 *    waiting for our answer). The queue never calls [Sender.start] while
 *    busy, so the manager's startSend busy -> onFailed(cancelled) path is
 *    not reached. One window remains inside the manager (left as is - its
 *    one-at-a-time rule is not ours to change): an incoming offer that lands
 *    while runSend is still HASHING makes runSend report `cancelled`; that
 *    item fails per-file with Retry, the queue continues.
 *  - `busy` -> back to queued at the SAME position, re-offered after
 *    [BUSY_RETRY_DELAY_MS] once idle (strict FIFO: nothing jumps it); the
 *    [MAX_BUSY_RETRIES]+1-th busy fails it.
 *  - link-level (`connection_lost`, `timeout`, `relay_backpressure`, and any
 *    reason we do not know) -> item failed + queue PAUSED(link). A link pause
 *    lifts itself on the next reconnect ([onLinkUp]) or on Resume.
 *  - account-level (`tier`, `quota`) -> item failed + PAUSED(account); only
 *    Resume / Retry lifts it.
 *  - per-file (`size_mismatch`, `hash_mismatch`, `too_large`, `cancelled`,
 *    `oom`) -> item failed, queue continues.
 *  - Not connected when an item is due -> PAUSED(link) WITHOUT failing the
 *    item: it was never offered, so there is no failure to report.
 *
 * ## Threading
 *
 * Events arrive on the file-transfer worker and the socket reader; actions on
 * the main thread. State changes are `synchronized(this)`; [Sender] calls are
 * made AFTER the lock is released, because the manager calls its listener
 * (and so this class) from inside its own lock - calling it while holding
 * ours would be a lock-order inversion.
 */
class FileTransferQueue(
    private val sender: Sender,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val newKey: () -> String = { java.util.UUID.randomUUID().toString() },
    /** Published on EVERY change, under the lock, in order. Persist + render here. */
    private val onChange: (Snapshot) -> Unit = {},
) {

    companion object {
        /** `busy` re-offers before the item is failed (ADDENDUM 2: max 3). */
        const val MAX_BUSY_RETRIES = 3

        /** Wait this long after a `busy` before re-offering (driven by [tick]). */
        const val BUSY_RETRY_DELAY_MS = 5_000L

        /** Oldest `done` rows beyond this are dropped. Failed rows are never dropped. */
        const val MAX_DONE_ROWS = 20

        const val JSON_VERSION = 1

        /** Scheduler class of a FILE_FAILED reason. */
        fun classify(reason: String): FailureClass = when (reason) {
            FileTransfer.Reason.BUSY -> FailureClass.BUSY
            FileTransfer.Reason.TIER, FileTransfer.Reason.QUOTA -> FailureClass.ACCOUNT
            FileTransfer.Reason.SIZE_MISMATCH, FileTransfer.Reason.HASH_MISMATCH,
            FileTransfer.Reason.TOO_LARGE, FileTransfer.Reason.CANCELLED,
            FileTransfer.Reason.OOM -> FailureClass.PER_FILE
            // connection_lost, timeout, relay_backpressure - and anything we
            // do not recognise: pausing is the failure mode that cannot
            // cascade into N failed rows.
            else -> FailureClass.LINK
        }
    }

    /** The manager, as the queue sees it. */
    interface Sender {
        /** [FileTransferManager.isBusy]: a transfer running or an offer pending. */
        val isBusy: Boolean

        /** Is the relay socket open? */
        val isConnected: Boolean

        /** [FileTransferManager.startSend]. */
        fun start(uri: String)

        /** [FileTransferManager.cancel] - the one cancel path. */
        fun cancelActive()

        /** Can we open [uri] right now (a live or persisted read grant)? */
        fun canRead(uri: String): Boolean
    }

    enum class FailureClass { BUSY, LINK, ACCOUNT, PER_FILE }

    enum class PauseKind(val wire: String) { LINK("link"), ACCOUNT("account") }

    data class Pause(val kind: PauseKind, val reason: String)

    enum class State(val wire: String) {
        QUEUED("queued"),
        OFFERING("offering"),
        SENDING("sending"),
        RECEIVING("receiving"),
        DONE("done"),
        FAILED("failed"),
        NEEDS_FILE("needs-file");

        companion object {
            fun of(wire: String?): State? = values().firstOrNull { it.wire == wire }
        }
    }

    /** A file the user picked or shared. */
    data class NewFile(
        val uri: String,
        val name: String,
        val size: Long,
        val lastModified: Long = 0L,
        /** We hold a persisted read grant (survives process death). */
        val persistable: Boolean = false,
    )

    data class Item(
        /** Local id. Never on the wire. */
        val key: String,
        val uri: String?,
        val name: String,
        val size: Long,
        val lastModified: Long,
        val outgoing: Boolean,
        val state: State,
        /** [FileTransfer.Reason] when [state] is FAILED. */
        val reason: String? = null,
        val busyRetries: Int = 0,
        /** Do not offer before this clock time (busy back-off). */
        val notBeforeMs: Long = 0L,
        /** The manager's transfer id, once an event has told us. */
        val transferId: String? = null,
        /** Remove was pressed while in flight: drop it on its terminal event. */
        val removing: Boolean = false,
        /** The received document (incoming DONE). */
        val resultUri: String? = null,
        val persistable: Boolean = false,
    )

    data class Snapshot(val items: List<Item>, val paused: Pause?)

    private val items = ArrayList<Item>()
    private var paused: Pause? = null

    // ============================================================ reads

    @Synchronized
    fun snapshot(): Snapshot = Snapshot(items.toList(), paused)

    // ========================================================== actions

    /** Append [files] at the tail, in order. */
    fun enqueue(files: List<NewFile>) = mutate {
        for (f in files) {
            items.add(
                Item(
                    key = newKey(), uri = f.uri, name = f.name, size = f.size,
                    lastModified = f.lastModified, outgoing = true, state = State.QUEUED,
                    persistable = f.persistable,
                )
            )
        }
    }

    /**
     * Remove a row. On the in-flight item this IS the existing cancel
     * (ADDENDUM 2); the row goes when the manager reports the transfer over.
     */
    fun remove(key: String) {
        var cancel = false
        mutate {
            val i = indexOf(key) ?: return@mutate
            val it = items[i]
            if (it.state == State.OFFERING || it.state == State.SENDING) {
                items[i] = it.copy(removing = true)
                cancel = true
            } else if (it.state == State.RECEIVING) {
                cancel = true // the incoming row turns FAILED(cancelled) via the event
            } else {
                items.removeAt(i)
            }
        }
        if (cancel) sender.cancelActive()
    }

    /** Cancel the in-flight row (offering / sending / receiving). */
    fun cancel(key: String) {
        val live = synchronized(this) {
            indexOf(key)?.let { items[it].state } in
                setOf(State.OFFERING, State.SENDING, State.RECEIVING)
        }
        if (live) sender.cancelActive()
    }

    /**
     * Retry a failed outgoing row: back to the TAIL as queued, or needs-file
     * when its file can no longer be opened. An explicit user action, so it
     * also lifts a pause.
     */
    fun retry(key: String) {
        val uri = synchronized(this) {
            indexOf(key)?.let { items[it] }?.takeIf { it.outgoing && it.state == State.FAILED }?.uri
        }
        val readable = uri != null && sender.canRead(uri)
        mutate {
            val i = indexOf(key) ?: return@mutate
            val it = items[i]
            if (!it.outgoing || it.state != State.FAILED) return@mutate
            items.removeAt(i)
            items.add(
                it.copy(
                    state = if (readable) State.QUEUED else State.NEEDS_FILE,
                    reason = null, busyRetries = 0, notBeforeMs = 0L, transferId = null,
                )
            )
            paused = null
        }
    }

    /** The user picked the file again for a needs-file (or failed) row. */
    fun repick(key: String, file: NewFile) = mutate {
        val i = indexOf(key) ?: return@mutate
        val it = items[i]
        if (!it.outgoing || (it.state != State.NEEDS_FILE && it.state != State.FAILED)) return@mutate
        items.removeAt(i)
        items.add(
            it.copy(
                uri = file.uri, name = file.name, size = file.size,
                lastModified = file.lastModified, persistable = file.persistable,
                state = State.QUEUED, reason = null, busyRetries = 0, notBeforeMs = 0L,
                transferId = null,
            )
        )
        paused = null
    }

    /** "Paused - Resume". */
    fun resume() = mutate { paused = null }

    /** The socket is back: lift a LINK pause (never an ACCOUNT one). */
    fun onLinkUp() = mutate { if (paused?.kind == PauseKind.LINK) paused = null }

    /** Periodic re-check: a busy back-off may have expired. */
    fun tick() = mutate { }

    // ==================================================== listener events

    fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean) = mutate {
        if (outgoing) {
            val i = inFlightIndex() ?: return@mutate
            val it = items[i]
            if (!sameTransfer(it, id)) return@mutate
            if (it.state != State.SENDING || it.transferId != id) {
                items[i] = it.copy(state = State.SENDING, transferId = id.ifEmpty { it.transferId })
            }
        } else {
            val i = items.indexOfFirst { !it.outgoing && it.transferId == id }
            if (i >= 0) {
                if (items[i].state != State.RECEIVING) items[i] = items[i].copy(state = State.RECEIVING)
            } else {
                items.add(
                    Item(
                        key = newKey(), uri = null, name = name, size = total,
                        lastModified = 0L, outgoing = false, state = State.RECEIVING,
                        transferId = id,
                    )
                )
            }
        }
    }

    fun onComplete(id: String, name: String, uri: String?, outgoing: Boolean) = mutate {
        if (outgoing) {
            val i = inFlightIndex() ?: return@mutate
            val it = items[i]
            if (!sameTransfer(it, id)) return@mutate
            if (it.removing) items.removeAt(i)
            else items[i] = it.copy(state = State.DONE, transferId = id.ifEmpty { it.transferId })
        } else {
            val i = items.indexOfFirst { !it.outgoing && it.transferId == id }
            val row = if (i >= 0) items[i] else null
            val done = (row ?: Item(
                key = newKey(), uri = null, name = name, size = 0L, lastModified = 0L,
                outgoing = false, state = State.DONE, transferId = id,
            )).copy(state = State.DONE, resultUri = uri, name = name)
            if (i >= 0) items[i] = done else items.add(done)
        }
        trimDone()
    }

    fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean) = mutate {
        if (!outgoing) {
            // Only a receive that had started is history; a declined or
            // withdrawn offer never became a row.
            val i = items.indexOfFirst { !it.outgoing && it.transferId == id }
            if (i >= 0) items[i] = items[i].copy(state = State.FAILED, reason = reason)
            return@mutate
        }
        val i = inFlightIndex() ?: return@mutate
        val it = items[i]
        if (!sameTransfer(it, id)) return@mutate
        if (it.removing) {
            items.removeAt(i); return@mutate
        }
        when (classify(reason)) {
            FailureClass.BUSY ->
                items[i] = if (it.busyRetries < MAX_BUSY_RETRIES) {
                    it.copy(
                        state = State.QUEUED, busyRetries = it.busyRetries + 1,
                        notBeforeMs = clock() + BUSY_RETRY_DELAY_MS, transferId = null,
                    )
                } else {
                    it.copy(state = State.FAILED, reason = reason)
                }
            FailureClass.PER_FILE -> items[i] = it.copy(state = State.FAILED, reason = reason)
            FailureClass.LINK -> {
                items[i] = it.copy(state = State.FAILED, reason = reason)
                paused = Pause(PauseKind.LINK, reason)
            }
            FailureClass.ACCOUNT -> {
                items[i] = it.copy(state = State.FAILED, reason = reason)
                paused = Pause(PauseKind.ACCOUNT, reason)
            }
        }
    }

    /** The manager is idle (an incoming transfer or offer ended): maybe offer the next one. */
    fun onIdle() = mutate { }

    // ====================================================== persistence

    @Synchronized
    fun toJson(): String = encode(items, paused)

    /** The persisted form of [s] (what [restore] reads back). */
    fun encodeSnapshot(s: Snapshot): String = encode(s.items, s.paused)

    /**
     * Process restart. Nothing that was moving is moving now:
     * offering / sending / receiving -> failed(connection_lost);
     * queued without a persisted, still-readable grant -> needs-file.
     * Never a silent stuck row.
     */
    fun restore(json: String?) {
        val decoded = decode(json) ?: return
        val readable = decoded.first.filter { it.outgoing && it.uri != null && it.persistable }
            .associate { it.key to sender.canRead(it.uri!!) }
        mutate {
            items.clear()
            for (it in decoded.first) {
                // Remove was pressed and the process died before the cancel
                // landed: the user already chose to lose this row.
                if (it.removing) continue
                items.add(
                    when (it.state) {
                        State.OFFERING, State.SENDING, State.RECEIVING -> it.copy(
                            state = State.FAILED, reason = FileTransfer.Reason.CONNECTION_LOST,
                            removing = false,
                        )
                        State.QUEUED ->
                            if (readable[it.key] == true) it.copy(notBeforeMs = 0L)
                            else it.copy(state = State.NEEDS_FILE)
                        else -> it
                    }
                )
            }
            paused = decoded.second
        }
    }

    // ========================================================= internals

    /**
     * Apply [block], pick the next item to offer, publish - all under the
     * lock - then call the manager outside it.
     */
    private fun mutate(block: () -> Unit) {
        val start: String? = synchronized(this) {
            block()
            val next = pumpLocked()
            onChange(Snapshot(items.toList(), paused))
            next
        }
        if (start != null) sender.start(start)
    }

    /** @return the uri to start, having marked its item OFFERING; null if nothing is due. */
    private fun pumpLocked(): String? {
        if (paused != null) return null
        if (inFlightIndex() != null) return null
        // The manager is the authority on "a receive / pending offer holds
        // the slot"; a row of ours could be stale, its flag cannot.
        if (sender.isBusy) return null
        // Strict FIFO: the head waits out its busy back-off and nothing
        // jumps it - the peer that answered busy is busy for the file behind
        // it too, and offering that one would only burn ITS retries.
        val i = items.indexOfFirst { it.outgoing && it.state == State.QUEUED }
        if (i < 0) return null
        val next = items[i]
        if (next.notBeforeMs > clock()) return null
        val uri = next.uri
        if (uri == null) {
            items[i] = next.copy(state = State.NEEDS_FILE)
            return null
        }
        if (!sender.isConnected) {
            paused = Pause(PauseKind.LINK, FileTransfer.Reason.CONNECTION_LOST)
            return null
        }
        items[i] = next.copy(state = State.OFFERING, notBeforeMs = 0L)
        return uri
    }

    private fun inFlightIndex(): Int? =
        items.indexOfFirst { it.outgoing && (it.state == State.OFFERING || it.state == State.SENDING) }
            .takeIf { it >= 0 }

    /** A late event for an EARLIER transfer must not land on the current item. */
    private fun sameTransfer(it: Item, id: String): Boolean =
        it.transferId == null || id.isEmpty() || it.transferId == id

    private fun indexOf(key: String): Int? = items.indexOfFirst { it.key == key }.takeIf { it >= 0 }

    private fun trimDone() {
        var excess = items.count { it.state == State.DONE } - MAX_DONE_ROWS
        val iter = items.iterator()
        while (excess > 0 && iter.hasNext()) {
            if (iter.next().state == State.DONE) { iter.remove(); excess-- }
        }
    }

    private fun encode(list: List<Item>, p: Pause?): String {
        val root = JsonObject()
        root.addProperty("v", JSON_VERSION)
        p?.let {
            root.add("paused", JsonObject().apply {
                addProperty("kind", it.kind.wire); addProperty("reason", it.reason)
            })
        }
        val arr = JsonArray()
        for (it in list) {
            arr.add(JsonObject().apply {
                addProperty("key", it.key)
                it.uri?.let { u -> addProperty("uri", u) }
                addProperty("name", it.name)
                addProperty("size", it.size)
                addProperty("lastModified", it.lastModified)
                addProperty("dir", if (it.outgoing) "out" else "in")
                addProperty("state", it.state.wire)
                it.reason?.let { r -> addProperty("reason", r) }
                addProperty("busyRetries", it.busyRetries)
                it.transferId?.let { t -> addProperty("transferId", t) }
                if (it.removing) addProperty("removing", true)
                it.resultUri?.let { r -> addProperty("resultUri", r) }
                addProperty("persistable", it.persistable)
            })
        }
        root.add("items", arr)
        return root.toString()
    }

    /** Tolerant: a corrupt blob restores as an empty queue, never a crash. */
    private fun decode(json: String?): Pair<List<Item>, Pause?>? {
        if (json.isNullOrBlank()) return null
        return try {
            val root = JsonParser.parseString(json).asJsonObject
            if (root.get("v")?.asInt != JSON_VERSION) return null
            fun JsonObject.s(k: String): String? = get(k)?.takeUnless { it.isJsonNull }?.asString
            val pause = root.getAsJsonObject("paused")?.let { p ->
                val kind = PauseKind.values().firstOrNull { it.wire == p.s("kind") }
                val reason = p.s("reason")
                if (kind != null && reason != null) Pause(kind, reason) else null
            }
            val out = ArrayList<Item>()
            root.getAsJsonArray("items")?.forEach { el ->
                val o = el.asJsonObject
                val state = State.of(o.s("state")) ?: return@forEach
                val key = o.s("key") ?: return@forEach
                out.add(
                    Item(
                        key = key, uri = o.s("uri"), name = o.s("name") ?: "file",
                        size = o.get("size")?.asLong ?: -1L,
                        lastModified = o.get("lastModified")?.asLong ?: 0L,
                        outgoing = o.s("dir") != "in", state = state, reason = o.s("reason"),
                        busyRetries = o.get("busyRetries")?.asInt ?: 0,
                        transferId = o.s("transferId"),
                        removing = o.get("removing")?.asBoolean ?: false,
                        resultUri = o.s("resultUri"),
                        persistable = o.get("persistable")?.asBoolean ?: false,
                    )
                )
            }
            out to pause
        } catch (e: Exception) {
            null
        }
    }
}
