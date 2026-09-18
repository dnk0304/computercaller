package com.dnkdialer.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * FT-2 (e) — every notification this feature raises.
 *
 * Three surfaces, two channels:
 *
 *  - the **offer** prompt (Accept / Reject) on a HIGH-importance channel, for
 *    the same reason the pairing prompt has one: the user has to see it to act
 *    on it, and it must survive the user muting the persistent bridge
 *    notification.
 *  - the **progress** notification (percent, ETA, Cancel) on a LOW channel —
 *    it updates many times a second and must never make a sound.
 *  - the **terminal** notification: tap to open the received file, or the
 *    failure reason in plain language.
 *
 * Deliberately NOT the foreground-service notification. A transfer runs inside
 * the existing `specialUse` FGS's lifetime (spec §3), so this adds no service,
 * no FGS type and no manifest entry — which is what keeps the `dataSync` 6-hour
 * cap and a fresh Play declaration out of the build.
 */
class FileTransferNotifier(private val context: Context) {

    companion object {
        const val OFFER_CHANNEL_ID = "file_transfer_offers"
        const val PROGRESS_CHANNEL_ID = "file_transfer_progress"

        /** Fixed ids: one transfer at a time, so one of each is all we need. */
        private const val OFFER_NOTIFICATION_ID = 1301
        private const val PROGRESS_NOTIFICATION_ID = 1302
        private const val RESULT_NOTIFICATION_ID = 1303

        private const val REQ_ACCEPT = 3001
        private const val REQ_REJECT = 3002
        private const val REQ_CANCEL = 3003
        private const val REQ_OPEN = 3004
    }

    private val manager: NotificationManager =
        context.getSystemService(NotificationManager::class.java)

    fun createChannels() {
        // No SDK guard: NotificationChannel is API 26 and minSdk is 26.
        manager.createNotificationChannel(
            NotificationChannel(
                OFFER_CHANNEL_ID,
                context.getString(R.string.ft_channel_offers),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.ft_channel_offers_desc)
                enableVibration(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                PROGRESS_CHANNEL_ID,
                context.getString(R.string.ft_channel_progress),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = context.getString(R.string.ft_channel_progress_desc)
                setShowBadge(false)
            }
        )
    }

    // --------------------------------------------------------------- offer

    /**
     * "Accept holiday.jpg (4.2 MB)?" with Accept / Reject.
     *
     * The "only accept files from people you trust" line is in the expanded
     * body and NOT optional: we do not scan files (spec §6), and a transfer
     * feature that silently implies safety is a promise we cannot keep. The
     * name and size shown before a byte is written are the actual protection,
     * which is why they are in the title rather than behind a tap.
     */
    fun showOffer(id: String, name: String, size: Long) {
        val accept = PendingIntent.getActivity(
            context, REQ_ACCEPT,
            Intent(context, FileTransferActivity::class.java).apply {
                action = FileTransferActivity.ACTION_SHOW_OFFER
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                putExtra(FileTransferActivity.EXTRA_AUTO_ACCEPT, true)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val reject = PendingIntent.getBroadcast(
            context, REQ_REJECT,
            Intent(FileTransferActionReceiver.ACTION_REJECT).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        // Tapping the body opens the in-app dialog rather than accepting —
        // an accidental tap on a notification must not start writing a file.
        val body = PendingIntent.getActivity(
            context, REQ_OPEN,
            Intent(context, FileTransferActivity::class.java).apply {
                action = FileTransferActivity.ACTION_SHOW_OFFER
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val n = NotificationCompat.Builder(context, OFFER_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cc)
            .setColor(ContextCompat.getColor(context, R.color.accent_blue))
            .setContentTitle(
                context.getString(R.string.ft_offer_title, name, FileTransfer.humanSize(size))
            )
            .setContentText(context.getString(R.string.ft_offer_trust))
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(context.getString(R.string.ft_offer_trust))
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setAutoCancel(true)
            .setContentIntent(body)
            .addAction(android.R.drawable.ic_menu_save, context.getString(R.string.ft_accept), accept)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, context.getString(R.string.ft_reject), reject)
            .build()
        manager.notify(OFFER_NOTIFICATION_ID, n)
    }

    fun dismissOffer() = manager.cancel(OFFER_NOTIFICATION_ID)

    // ------------------------------------------------------------ progress

    /**
     * Ongoing progress with percent, ETA and Cancel, for both directions.
     *
     * [startedMs] rather than a rate we keep: the ETA is recomputed from the
     * whole transfer so far, which is noisier early and far more stable later.
     * A rolling window reads better for two seconds and lies after a stall.
     */
    fun showProgress(name: String, sent: Long, total: Long, outgoing: Boolean, startedMs: Long) {
        val cancel = PendingIntent.getBroadcast(
            context, REQ_CANCEL,
            Intent(FileTransferActionReceiver.ACTION_CANCEL).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val pct = if (total > 0) ((sent * 100) / total).toInt().coerceIn(0, 100) else 0
        val eta = FileTransfer.etaSeconds(sent, total, System.currentTimeMillis() - startedMs)
        val sub = if (eta != null) {
            context.getString(
                R.string.ft_progress_eta,
                FileTransfer.humanSize(sent), FileTransfer.humanSize(total), humanEta(eta)
            )
        } else {
            context.getString(
                R.string.ft_progress_plain,
                FileTransfer.humanSize(sent), FileTransfer.humanSize(total)
            )
        }

        val n = NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cc)
            .setColor(ContextCompat.getColor(context, R.color.accent_blue))
            .setContentTitle(
                context.getString(
                    if (outgoing) R.string.ft_sending else R.string.ft_receiving, name
                )
            )
            .setContentText(sub)
            .setProgress(100, pct, total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                context.getString(R.string.ft_cancel), cancel
            )
            .build()
        manager.notify(PROGRESS_NOTIFICATION_ID, n)
    }

    fun dismissProgress() = manager.cancel(PROGRESS_NOTIFICATION_ID)

    // ------------------------------------------------------------ terminal

    /** Done. Tapping a received file opens it. */
    fun showComplete(name: String, uri: Uri?, outgoing: Boolean) {
        val b = NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cc)
            .setColor(ContextCompat.getColor(context, R.color.accent_blue))
            .setContentTitle(
                context.getString(if (outgoing) R.string.ft_sent else R.string.ft_received, name)
            )
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)

        if (!outgoing && uri != null) {
            // FLAG_GRANT_READ_URI_PERMISSION is what makes this openable by
            // the handling app: the SAF grant we hold is ours, not theirs.
            val open = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, context.contentResolver.getType(uri) ?: "*/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            b.setContentIntent(
                PendingIntent.getActivity(
                    context, REQ_OPEN, open,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
            b.setContentText(context.getString(R.string.ft_tap_to_open))
        }
        manager.notify(RESULT_NOTIFICATION_ID, b.build())
    }

    /** Failed. The copy is per-reason and never technical. */
    fun showFailed(name: String?, reason: String, outgoing: Boolean) {
        val text = failureCopy(context, reason)
        val n = NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cc)
            .setColor(ContextCompat.getColor(context, R.color.accent_blue))
            .setContentTitle(
                context.getString(
                    if (outgoing) R.string.ft_send_failed else R.string.ft_receive_failed,
                    name ?: context.getString(R.string.ft_generic_file)
                )
            )
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        manager.notify(RESULT_NOTIFICATION_ID, n)
    }

    /**
     * "45 seconds" / "3 minutes" / "1 hour".
     *
     * getQuantityString rather than getString: "1 minutes" is the kind of
     * detail that makes an app feel unfinished, and several of the languages
     * this ships in do not pluralise the way English does.
     */
    private fun humanEta(seconds: Long): String = when {
        seconds < 60 -> context.resources.getQuantityString(
            R.plurals.ft_eta_seconds, seconds.toInt(), seconds.toInt()
        )
        seconds < 3600 -> context.resources.getQuantityString(
            R.plurals.ft_eta_minutes, (seconds / 60).toInt(), (seconds / 60).toInt()
        )
        else -> context.resources.getQuantityString(
            R.plurals.ft_eta_hours, (seconds / 3600).toInt(), (seconds / 3600).toInt()
        )
    }
}

/**
 * (d) — one place that turns a frozen `FILE_FAILED.reason` into user copy.
 *
 * Top-level so the dialog and the notification cannot drift into saying two
 * different things about the same failure, which is how a quota message ends
 * up reading as a bug report in one surface and as a limit in the other.
 *
 * NOTE for FT-2b / Pilot: the brief asks the `tier` case to read "Send files is
 * included with a subscription — Upgrade" with a deep-link. This module has no
 * upgrade path and `strings.xml` carries an explicit standing rule — "no
 * pricing or plan language anywhere (Play policy)". The copy here is therefore
 * neutral and link-free until Pilot rules on what Play permits. That is a copy
 * decision, not a behaviour one: the refusal itself is server-enforced and
 * already correct.
 */
fun failureCopy(context: Context, reason: String): String = context.getString(
    when (reason) {
        FileTransfer.Reason.TOO_LARGE -> R.string.ft_fail_too_large
        FileTransfer.Reason.QUOTA -> R.string.ft_fail_quota
        FileTransfer.Reason.TIER -> R.string.ft_fail_tier
        FileTransfer.Reason.HASH_MISMATCH -> R.string.ft_fail_hash
        FileTransfer.Reason.CANCELLED -> R.string.ft_fail_cancelled
        FileTransfer.Reason.TIMEOUT -> R.string.ft_fail_timeout
        FileTransfer.Reason.OOM -> R.string.ft_fail_oom
        FileTransfer.Reason.RELAY_BACKPRESSURE -> R.string.ft_fail_backpressure
        FileTransfer.Reason.SIZE_MISMATCH -> R.string.ft_fail_size_mismatch
        else -> R.string.ft_fail_connection
    }
)
