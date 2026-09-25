package com.dnkdialer.companion

import android.app.Activity
import android.content.Intent
import android.view.View
import android.widget.TextView
import androidx.core.net.toUri
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
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
 */
class FileTransferCard(private val activity: Activity) {

    private var scope: CoroutineScope? = null

    fun start() {
        stop()
        val s = MainScope()
        scope = s
        s.launch { PhoneService.fileTransferUi.collect { render(it) } }
    }

    fun stop() {
        scope?.cancel()
        scope = null
    }

    /** Redraw the current state, e.g. into a content view that was just set. */
    fun refresh() {
        render(PhoneService.fileTransferUi.value)
    }

    private fun render(ui: FileTransferUi) {
        val card = activity.findViewById<View>(R.id.ftCard) ?: return
        val heading = card.findViewById<TextView>(R.id.ftCardHeading)
        val percent = card.findViewById<TextView>(R.id.ftCardPercent)
        val name = card.findViewById<TextView>(R.id.ftCardName)
        val progress = card.findViewById<LinearProgressIndicator>(R.id.ftCardProgress)
        val bytes = card.findViewById<TextView>(R.id.ftCardBytes)
        val message = card.findViewById<TextView>(R.id.ftCardMessage)
        val actions = card.findViewById<View>(R.id.ftCardActions)
        val secondary = card.findViewById<TextView>(R.id.ftCardSecondary)
        val primary = card.findViewById<TextView>(R.id.ftCardPrimary)

        card.setOnClickListener(null)
        card.isClickable = false
        secondary.setOnClickListener(null)
        primary.setOnClickListener(null)
        secondary.isEnabled = true
        primary.isEnabled = true

        when (ui) {
            is FileTransferUi.Idle -> {
                card.visibility = View.GONE
                return
            }

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
                    card.setOnClickListener(open)
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
        card.visibility = View.VISIBLE
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
