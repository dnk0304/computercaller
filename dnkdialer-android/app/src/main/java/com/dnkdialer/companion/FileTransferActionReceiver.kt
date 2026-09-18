package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * FT-2 (e) — Reject / Cancel taps from the file-transfer notifications.
 *
 * Deliberately SEPARATE from [ConnectionRequestReceiver] and
 * [LobbyActionReceiver], for the same reason those two are separate from each
 * other: this receiver must never be able to widen the surface of the pairing
 * accept path, and keeping the handler references distinct is what guarantees
 * that a change here cannot reach there.
 *
 * **Accept is not here.** Accepting a file has to open a SAF document picker,
 * which needs an Activity — and routing it through a broadcast first would
 * spend the user's tap on a hop that cannot do the thing the tap asked for.
 * The Accept action's PendingIntent goes straight to [FileTransferActivity].
 *
 * Registered at runtime in [PhoneService] with RECEIVER_NOT_EXPORTED so no
 * other process can cancel a transfer; the PendingIntents that fire it are
 * FLAG_IMMUTABLE and pinned to our own package.
 */
class FileTransferActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REJECT = "com.dnkdialer.companion.FT_REJECT"
        const val ACTION_CANCEL = "com.dnkdialer.companion.FT_CANCEL"

        /**
         * Set in PhoneService.onCreate, cleared in onDestroy. The boolean is
         * `cancelRunning?` — true → cancel the live transfer, false → reject
         * the pending offer. Nullable: a broadcast that outlives the service
         * must be a no-op, not a crash.
         */
        @Volatile
        @JvmStatic
        var handler: ((Boolean) -> Unit)? = null
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        when (intent?.action) {
            ACTION_REJECT -> handler?.invoke(false)
            ACTION_CANCEL -> handler?.invoke(true)
        }
    }
}
