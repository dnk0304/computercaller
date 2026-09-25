package com.dnkdialer.companion

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * vc69 — what the in-app transfer card draws. One value at a time, because
 * [FileTransferManager] runs one transfer (or holds one pending offer) at a
 * time by construction.
 */
sealed class FileTransferUi {

    /** Nothing to show; the card is hidden. */
    object Idle : FileTransferUi()

    /**
     * A peer offered a file and the user has not answered yet. Rendered with
     * Accept / Decline whenever the app is opened while the offer is live -
     * independent of whether the app was in front when the offer arrived.
     */
    data class Offer(val id: String, val name: String, val size: Long) : FileTransferUi()

    /** A transfer is running. [sent]/[total] are raw file bytes. */
    data class Running(
        val id: String,
        val name: String,
        val outgoing: Boolean,
        val sent: Long,
        val total: Long,
    ) : FileTransferUi() {
        /** The SAME formula the ongoing notification uses. */
        val percent: Int get() = FileTransfer.percent(sent, total)
    }

    /** Terminal success. [uri] is the received document (incoming only). */
    data class Done(
        val id: String,
        val name: String,
        val outgoing: Boolean,
        val uri: String?,
    ) : FileTransferUi()

    /** Terminal failure. [reason] is a [FileTransfer.Reason] value. */
    data class Failed(
        val id: String,
        val name: String?,
        val outgoing: Boolean,
        val reason: String,
    ) : FileTransferUi()
}

/**
 * vc69 — the in-app card's state, fed by the SAME [FileTransferManager.Listener]
 * events that drive [FileTransferNotifier]. PhoneService forwards every event
 * to both; nothing here reads a counter of its own or computes progress a
 * second way, so the card and the notification cannot disagree.
 *
 * Held for the process (see [PhoneService.fileTransferUi]), so the card
 * survives background/foreground and rotation: an Activity that comes back
 * simply re-reads [state].
 *
 * ## Throttle
 *
 * The manager reports every 16 chunks, which on a fast link is tens of events
 * a second. The card needs no more than ~5: a Running update for the SAME
 * transfer is dropped if the last one went out less than
 * [MIN_PROGRESS_INTERVAL_MS] ago - EXCEPT the first event of a transfer and
 * the one that reaches `total`, which always go out, so the bar never sticks
 * at 98 % on a transfer that finished.
 *
 * ## Terminal hold
 *
 * Done / Failed stay up for [TERMINAL_HOLD_MS] and then auto-dismiss. The
 * caller schedules that with the token [onComplete] / [onFailed] return;
 * [dismissTerminal] ignores a stale token, so a hold timer from an earlier
 * transfer cannot hide a later one's result.
 *
 * Every mutator is `@Synchronized`: events arrive on the file-transfer worker
 * AND on the WebSocket reader thread.
 */
class FileTransferUiModel(private val clock: () -> Long = { System.currentTimeMillis() }) {

    companion object {
        /** ~5 updates a second at most. */
        const val MIN_PROGRESS_INTERVAL_MS = 200L

        /** How long a Done / Failed card stays before it hides itself. */
        const val TERMINAL_HOLD_MS = 6_000L
    }

    private val _state = MutableStateFlow<FileTransferUi>(FileTransferUi.Idle)
    val state: StateFlow<FileTransferUi> = _state.asStateFlow()

    private var lastProgressEmitMs = 0L
    private var terminalToken = 0L

    /** @return true if the event was published, false if throttled away. */
    @Synchronized
    fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean): Boolean {
        val now = clock()
        val cur = _state.value
        val sameTransfer = cur is FileTransferUi.Running && cur.id == id
        val reachedEnd = total > 0 && sent >= total
        if (sameTransfer && !reachedEnd && now - lastProgressEmitMs < MIN_PROGRESS_INTERVAL_MS) {
            return false
        }
        lastProgressEmitMs = now
        _state.value = FileTransferUi.Running(id, name, outgoing, sent, total)
        return true
    }

    @Synchronized
    fun onOffer(id: String, name: String, size: Long) {
        _state.value = FileTransferUi.Offer(id, name, size)
    }

    /**
     * The pending offer died without an answer from us (sender cancelled,
     * relay-minted FILE_FAILED, socket drop, room reset). Only clears the
     * card if it is still showing THAT offer.
     */
    @Synchronized
    fun onOfferWithdrawn(id: String) {
        val cur = _state.value
        if (cur is FileTransferUi.Offer && cur.id == id) _state.value = FileTransferUi.Idle
    }

    /** @return the hold token to pass to [dismissTerminal] later. */
    @Synchronized
    fun onComplete(id: String, name: String, uri: String?, outgoing: Boolean): Long {
        _state.value = FileTransferUi.Done(id, name, outgoing, uri)
        return ++terminalToken
    }

    /** @return the hold token to pass to [dismissTerminal] later. */
    @Synchronized
    fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean): Long {
        _state.value = FileTransferUi.Failed(id, name, outgoing, reason)
        return ++terminalToken
    }

    /**
     * Nothing is running. Clears a Running or Offer card (an answered or
     * expired offer, a finished transfer) but NOT a terminal one: the
     * manager reports idle immediately before it reports the result, and the
     * result must stay up for its hold.
     */
    @Synchronized
    fun onIdle() {
        val cur = _state.value
        if (cur is FileTransferUi.Running || cur is FileTransferUi.Offer) {
            _state.value = FileTransferUi.Idle
        }
    }

    /** Hide the terminal card IF it is still the one [token] was issued for. */
    @Synchronized
    fun dismissTerminal(token: Long): Boolean {
        val cur = _state.value
        val terminal = cur is FileTransferUi.Done || cur is FileTransferUi.Failed
        if (!terminal || token != terminalToken) return false
        _state.value = FileTransferUi.Idle
        return true
    }

    /** Service teardown: nothing the card showed is true any more. */
    @Synchronized
    fun reset() {
        lastProgressEmitMs = 0L
        _state.value = FileTransferUi.Idle
    }
}
