package com.dnkdialer.companion

import android.app.Activity
import android.content.Intent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.net.toUri
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * vc69 — Dennis, 2026-09-25: "The progress bar that shows in the phone
 * notification when a file is being sent — I want it inside the Android app
 * too, not just the notification."
 *
 * Draws `view_file_transfer_card` on Home from [PhoneService.fileTransferUi].
 * It computes nothing: percent, bytes and the terminal copy all come from the
 * state the service publishes off the same listener events the notification
 * is drawn from, and the failure line is [failureCopy] - the notification's
 * own function.
 *
 * Cancel invokes [FileTransferActionReceiver.handler] - the exact callback the
 * notification's Cancel broadcast lands in - so there is one cancel path.
 *
 * Lifecycle: [start] in onStart, [stop] in onStop. Nothing is held across a
 * stop; a returning Activity re-reads the StateFlow's current value, which is
 * what makes the card survive background/foreground and rotation.
 *
 * Views are looked up per render rather than cached: MainActivity swaps its
 * content view (the permissions-required screen has no card), and a cached
 * reference would draw into a detached tree.
 *
 * FILE-QUEUE (Ken ADDENDUM 2): the card is the ACTIVE slot on top (unchanged:
 * the running transfer or the pending offer with Accept / Decline, and its
 * own terminal hold), with the queue's rows below it
 * ([FileTransferUiModel.queue]) and an Add-file row. Failed rows stay until
 * Removed - the hold applies to the active slot only. The card shows when
 * EITHER half has something to draw.
 */
class FileTransferCard(private val activity: Activity) {

    private var scope: CoroutineScope? = null

    fun start() {
        stop()
        val s = MainScope()
        scope = s
        val model = PhoneService.fileTransferUiModel
        s.launch {
            combine(model.state, model.queue, model.queuePaused) { a, q, p -> Triple(a, q, p) }
                .collect { (a, q, p) -> render(a, q, p) }
        }
    }

    fun stop() {
        scope?.cancel()
        scope = null
    }

    /** Redraw the current state, e.g. into a content view that was just set. */
    fun refresh() {
        val model = PhoneService.fileTransferUiModel
        render(model.state.value, model.queue.value, model.queuePaused.value)
    }

    private fun render(ui: FileTransferUi, rows: List<QueueRowUi>, pausedReason: String?) {
        val card = activity.findViewById<View>(R.id.ftCard) ?: return
        val active = card.findViewById<View>(R.id.ftCardActive)
        val queueShown = renderQueue(card, rows, pausedReason, ui !is FileTransferUi.Idle)
        val activeShown = renderActive(card, ui)
        active.visibility = if (activeShown) View.VISIBLE else View.GONE
        card.visibility = if (activeShown || queueShown) View.VISIBLE else View.GONE
    }

    /**
     * FILE-QUEUE — summary ("N queued" / Paused + Resume), rows, Add file.
     * @return whether the queue section is showing.
     */
    private fun renderQueue(
        card: View,
        rows: List<QueueRowUi>,
        pausedReason: String?,
        activeShown: Boolean,
    ): Boolean {
        val section = card.findViewById<View>(R.id.ftQueueSection)
        val divider = card.findViewById<View>(R.id.ftQueueDivider)
        val summary = card.findViewById<TextView>(R.id.ftQueueSummary)
        val resume = card.findViewById<TextView>(R.id.ftQueueResume)
        val pausedLine = card.findViewById<TextView>(R.id.ftQueuePausedReason)
        val list = card.findViewById<ViewGroup>(R.id.ftQueueRows)
        val add = card.findViewById<View>(R.id.ftQueueAdd)

        if (rows.isEmpty() && pausedReason == null) {
            section.visibility = View.GONE
            list.removeAllViews()
            return false
        }
        section.visibility = View.VISIBLE
        divider.visibility = if (activeShown) View.VISIBLE else View.GONE

        val queued = rows.count { it.state == FileTransferQueue.State.QUEUED }
        if (pausedReason != null) {
            summary.setText(R.string.ft_queue_paused)
            pausedLine.text = failureCopy(activity, pausedReason)
            pausedLine.visibility = View.VISIBLE
            resume.visibility = View.VISIBLE
            resume.setOnClickListener { PhoneService.fileTransferQueue?.resume() }
        } else {
            summary.text = activity.resources.getQuantityString(R.plurals.ft_queue_count, queued, queued)
            pausedLine.visibility = View.GONE
            resume.visibility = View.GONE
            resume.setOnClickListener(null)
        }

        list.removeAllViews()
        val inflater = LayoutInflater.from(activity)
        for (row in rows) {
            val v = inflater.inflate(R.layout.view_file_queue_row, list, false)
            bindRow(v, row)
            list.addView(v)
        }

        add.setOnClickListener {
            activity.startActivity(
                Intent(activity, FileTransferActivity::class.java)
                    .setAction(FileTransferActivity.ACTION_PICK_FILE)
            )
        }
        return true
    }

    private fun bindRow(v: View, row: QueueRowUi) {
        val name = v.findViewById<TextView>(R.id.ftRowName)
        val state = v.findViewById<TextView>(R.id.ftRowState)
        val primary = v.findViewById<TextView>(R.id.ftRowPrimary)
        val secondary = v.findViewById<TextView>(R.id.ftRowSecondary)
        v.tag = row.key
        val size = if (row.size >= 0) FileTransfer.humanSize(row.size) else ""
        when (row.state) {
            FileTransferQueue.State.QUEUED -> {
                name.text = row.name
                state.text = activity.getString(R.string.ft_queue_queued, size)
            }
            FileTransferQueue.State.OFFERING -> {
                name.text = row.name
                state.setText(R.string.ft_send_started)
            }
            FileTransferQueue.State.DONE -> {
                name.text = activity.getString(if (row.outgoing) R.string.ft_sent else R.string.ft_received, row.name)
                state.text = size
            }
            FileTransferQueue.State.FAILED -> {
                name.text = activity.getString(
                    if (row.outgoing) R.string.ft_send_failed else R.string.ft_receive_failed, row.name
                )
                state.text = failureCopy(activity, row.reason ?: FileTransfer.Reason.CONNECTION_LOST)
            }
            FileTransferQueue.State.NEEDS_FILE -> {
                name.text = row.name
                state.setText(R.string.ft_queue_needs_file)
            }
            FileTransferQueue.State.SENDING, FileTransferQueue.State.RECEIVING -> {
                name.text = row.name
                state.text = size
            }
        }
        state.visibility = if (state.text.isNullOrEmpty()) View.GONE else View.VISIBLE

        // Actions: the first listed is the positive one (right-most, accent);
        // a second one sits before it in the neutral colour.
        val acts = row.actions
        val positive = acts.firstOrNull()
        val neutral = acts.getOrNull(1)
        bindAction(primary, positive, row)
        bindAction(secondary, neutral, row)
    }

    private fun bindAction(button: TextView, action: QueueRowAction?, row: QueueRowUi) {
        if (action == null) {
            button.visibility = View.GONE
            button.setOnClickListener(null)
            return
        }
        val q = PhoneService.fileTransferQueue
        button.visibility = View.VISIBLE
        button.isEnabled = true
        button.setText(
            when (action) {
                QueueRowAction.REMOVE -> R.string.ft_queue_remove
                QueueRowAction.CANCEL -> R.string.ft_cancel
                QueueRowAction.RETRY -> R.string.ft_queue_retry
                QueueRowAction.REPICK -> R.string.ft_queue_repick
                QueueRowAction.OPEN -> R.string.ft_card_open
                QueueRowAction.CLEAR -> R.string.ft_queue_clear
            }
        )
        button.setOnClickListener {
            when (action) {
                QueueRowAction.REMOVE, QueueRowAction.CLEAR -> q?.remove(row.key)
                // The one cancel path, same as the card's and the notification's.
                QueueRowAction.CANCEL -> {
                    it.isEnabled = false
                    q?.cancel(row.key)
                }
                QueueRowAction.RETRY -> q?.retry(row.key)
                QueueRowAction.REPICK -> activity.startActivity(
                    Intent(activity, FileTransferActivity::class.java)
                        .setAction(FileTransferActivity.ACTION_REPICK)
                        .putExtra(FileTransferActivity.EXTRA_QUEUE_KEY, row.key)
                )
                QueueRowAction.OPEN -> openReceived(row.resultUri)
            }
        }
    }

    /** The vc69 active slot. @return whether it has anything to show. */
    private fun renderActive(card: View, ui: FileTransferUi): Boolean {
        // The tap-to-open target is the active slot, not the whole card:
        // a tap between two queue rows must not open the last received file.
        val slot = card.findViewById<View>(R.id.ftCardActive)
        val heading = card.findViewById<TextView>(R.id.ftCardHeading)
        val percent = card.findViewById<TextView>(R.id.ftCardPercent)
        val name = card.findViewById<TextView>(R.id.ftCardName)
        val progress = card.findViewById<LinearProgressIndicator>(R.id.ftCardProgress)
        val bytes = card.findViewById<TextView>(R.id.ftCardBytes)
        val message = card.findViewById<TextView>(R.id.ftCardMessage)
        val actions = card.findViewById<View>(R.id.ftCardActions)
        val secondary = card.findViewById<TextView>(R.id.ftCardSecondary)
        val primary = card.findViewById<TextView>(R.id.ftCardPrimary)

        slot.setOnClickListener(null)
        slot.isClickable = false
        secondary.setOnClickListener(null)
        primary.setOnClickListener(null)
        secondary.isEnabled = true
        primary.isEnabled = true

        when (ui) {
            is FileTransferUi.Idle -> return false

            is FileTransferUi.Running -> {
                heading.setText(
                    if (ui.outgoing) R.string.ft_card_to_computer else R.string.ft_card_from_computer
                )
                percent.text = activity.getString(R.string.ft_card_percent, ui.percent)
                percent.visibility = View.VISIBLE
                name.text = ui.name
                progress.visibility = View.VISIBLE
                progress.setProgressCompat(ui.percent, true)
                bytes.text = activity.getString(
                    R.string.ft_progress_plain,
                    FileTransfer.humanSize(ui.sent), FileTransfer.humanSize(ui.total),
                )
                bytes.visibility = View.VISIBLE
                message.visibility = View.GONE
                actions.visibility = View.VISIBLE
                secondary.setText(R.string.ft_cancel)
                secondary.visibility = View.VISIBLE
                secondary.setOnClickListener {
                    it.isEnabled = false
                    // The notification's Cancel lands in this same handler.
                    FileTransferActionReceiver.handler?.invoke(true)
                }
                primary.visibility = View.GONE
            }

            is FileTransferUi.Done -> {
                heading.setText(
                    if (ui.outgoing) R.string.ft_card_to_computer else R.string.ft_card_from_computer
                )
                percent.text = activity.getString(R.string.ft_card_percent, 100)
                percent.visibility = View.VISIBLE
                name.text = activity.getString(
                    if (ui.outgoing) R.string.ft_sent else R.string.ft_received, ui.name
                )
                progress.visibility = View.VISIBLE
                progress.setProgressCompat(100, true)
                bytes.visibility = View.GONE
                message.visibility = View.GONE
                val openable = !ui.outgoing && ui.uri != null
                if (openable) {
                    actions.visibility = View.VISIBLE
                    secondary.visibility = View.GONE
                    primary.setText(R.string.ft_card_open)
                    primary.visibility = View.VISIBLE
                    val open = View.OnClickListener { openReceived(ui.uri) }
                    primary.setOnClickListener(open)
                    slot.setOnClickListener(open)
                } else {
                    actions.visibility = View.GONE
                }
            }

            is FileTransferUi.Failed -> {
                heading.setText(
                    if (ui.outgoing) R.string.ft_card_to_computer else R.string.ft_card_from_computer
                )
                percent.visibility = View.GONE
                name.text = activity.getString(
                    if (ui.outgoing) R.string.ft_send_failed else R.string.ft_receive_failed,
                    ui.name ?: activity.getString(R.string.ft_generic_file),
                )
                progress.visibility = View.GONE
                bytes.visibility = View.GONE
                message.text = failureCopy(activity, ui.reason)
                message.visibility = View.VISIBLE
                actions.visibility = View.GONE
            }

            is FileTransferUi.Offer -> {
                // FT incident 2, item 2: Accept reachable in-app whenever the
                // offer is live. Same name + size + trust line the offer
                // notification shows before a byte is written - that is the
                // protection (we do not scan files), so it is not optional.
                heading.setText(R.string.ft_card_offer_heading)
                percent.visibility = View.GONE
                name.text = ui.name
                progress.visibility = View.GONE
                bytes.text = FileTransfer.humanSize(ui.size)
                bytes.visibility = View.VISIBLE
                message.setText(R.string.ft_offer_trust)
                message.visibility = View.VISIBLE
                actions.visibility = View.VISIBLE
                secondary.setText(R.string.ft_reject)
                secondary.visibility = View.VISIBLE
                secondary.setOnClickListener {
                    it.isEnabled = false
                    // The notification's Reject lands in this same handler.
                    FileTransferActionReceiver.handler?.invoke(false)
                }
                primary.setText(R.string.ft_accept)
                primary.visibility = View.VISIBLE
                primary.setOnClickListener {
                    // Exactly the notification's Accept intent: the save
                    // picker opens straight away, FILE_ACCEPT follows it.
                    activity.startActivity(
                        Intent(activity, FileTransferActivity::class.java).apply {
                            action = FileTransferActivity.ACTION_SHOW_OFFER
                            putExtra(FileTransferActivity.EXTRA_AUTO_ACCEPT, true)
                        }
                    )
                }
            }
        }
        return true
    }

    /** Same intent as the "Received" notification's tap. */
    private fun openReceived(uri: String?) {
        val u = (uri ?: return).toUri()
        try {
            activity.startActivity(
                Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(u, activity.contentResolver.getType(u) ?: "*/*")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            )
        } catch (e: Exception) {
            DiagLog.d("FileTransferCard", "no app to open the received file: ${e.javaClass.simpleName}")
        }
    }
}
