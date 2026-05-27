package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives Disconnect / Reconnect broadcasts from the persistent
 * foreground-service notification's action buttons. The actual lobby
 * disconnect/rejoin logic lives in [PhoneService.userDisconnectFromLobby] /
 * [PhoneService.userRejoinLobby] (shipped v25) — this receiver is a thin
 * pass-through whose only job is to route the user's tap back to the
 * running service.
 *
 * Deliberately SEPARATE from [ConnectionRequestReceiver]: that receiver
 * gates the security-sensitive Accept/Decline pairing decision, while this
 * one only toggles the user's own lobby membership. Keeping them apart
 * means a lobby-toggle change can never widen the surface of the accept
 * path, and the @Volatile handler signatures stay distinct.
 *
 * Registered programmatically in PhoneService.onCreate with
 * RECEIVER_NOT_EXPORTED on API 33+ so no other process can spoof a
 * disconnect/rejoin. The PendingIntents that fire these broadcasts are
 * FLAG_IMMUTABLE and pinned to our own package (setPackage) so they can't
 * be mutated or redirected mid-flight.
 *
 * Intentionally NOT declared in AndroidManifest.xml — runtime registration
 * against the live PhoneService instance gives a clean lifecycle (no
 * broadcasts queue after the service is destroyed) and lets us share state
 * with the service via the [lobbyActionHandler] reference rather than
 * re-binding.
 */
class LobbyActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_DISCONNECT_LOBBY =
            "com.dnkdialer.companion.ACTION_DISCONNECT_LOBBY"
        const val ACTION_REJOIN_LOBBY =
            "com.dnkdialer.companion.ACTION_REJOIN_LOBBY"

        /**
         * The currently-bound service handles these broadcasts directly so
         * we can route the toggle without re-binding. The boolean argument
         * is `rejoin?` — true → userRejoinLobby(), false → userDisconnectFromLobby().
         * Set in PhoneService.onCreate, cleared in onDestroy. Nullable: an
         * in-flight broadcast that arrives after the service is killed is a
         * no-op.
         */
        @Volatile
        var lobbyActionHandler: ((Boolean) -> Unit)? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val rejoin = when (intent.action) {
            ACTION_REJOIN_LOBBY -> true
            ACTION_DISCONNECT_LOBBY -> false
            else -> return
        }
        android.util.Log.d(
            "LobbyActionReceiver",
            "Received ${intent.action} (rejoin=$rejoin)"
        )
        lobbyActionHandler?.invoke(rejoin)
    }
}
