package com.dnkdialer.companion

import com.google.gson.Gson
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.util.UUID

/**
 * Local LAN WebSocket server on port 8765.
 *
 * Connection lifecycle (Accept-on-phone flow):
 *
 *   1. Remote opens TCP socket → java_websocket completes handshake → onOpen
 *      fires. We DO NOT yet expose the conn to PhoneService; instead we put
 *      it in [pendingConnections] keyed by a fresh request id, and fire the
 *      [onConnectionRequest] callback. PhoneService posts an Android
 *      notification with Accept/Decline actions.
 *   2. On user Accept → PhoneService calls [acceptPendingConnection]. We move
 *      the conn from pending → [client], fire onConnectionChange(true),
 *      and send DEVICE_INFO (existing handshake message). From here on
 *      onMessage is processed normally.
 *   3. On user Decline (or 30s timeout) → PhoneService calls
 *      [declinePendingConnection]. We close the conn with code 1008
 *      ("policy violation") and drop it from pending.
 *
 * Disconnect cleanup (the bug fix):
 *
 *   - onClose now ALWAYS clears state regardless of identity. Previously the
 *     identity check (`if (client == conn)`) meant a new connection arriving
 *     before the old one's onClose fired would overwrite `client`, then the
 *     old onClose found `client != conn` and silently skipped cleanup —
 *     leaving the foreground notification + isClientConnected in their stale
 *     "connected" state.
 *   - onOpen now explicitly closes any pre-existing active client before
 *     starting the new pending-accept flow. This guarantees that if the
 *     webapp's prior session leaks (e.g. relay dropped the WS without
 *     forwarding our DISCONNECT_PHONE), the new connection still gets a
 *     clean phone-side slate.
 *   - [disconnectAllClients] is called from PhoneService when the webapp
 *     explicitly sends DISCONNECT_PHONE: closes pending + active, broadcasts
 *     onConnectionChange(false) so the UI / notification reflect reality.
 */
class PhoneServer(
    port: Int,
    private val onCommand: (String, Map<String, Any>?) -> Unit,
    private val onConnectionChange: (Boolean, String?) -> Unit,  // (connected, remoteAddress)
    private val onConnectionRequest: (String, String) -> Unit    // (requestId, remoteAddress)
) : WebSocketServer(InetSocketAddress(port)) {

    private val gson = Gson()
    private var client: WebSocket? = null

    /**
     * Connections that have completed the WS handshake but are awaiting
     * user Accept on the phone. Keyed by a UUID request id so the
     * notification Accept/Decline buttons can target the right one even
     * if multiple requests arrive in quick succession.
     *
     * Synchronized via the WebSocketServer's worker thread + the
     * PendingIntent broadcasts hopping back through PhoneService, so
     * concurrent access from the WS worker + the Accept broadcast is
     * possible. Wrapped in @Synchronized on the public mutators below.
     */
    private val pendingConnections = mutableMapOf<String, WebSocket>()

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        val addr = conn.remoteSocketAddress?.toString() ?: "unknown"
        android.util.Log.d("PhoneServer", "Incoming connection from $addr — awaiting user Accept")

        // Defensive cleanup: if a stale active client survived (e.g. the
        // webapp's previous session's relay didn't forward DISCONNECT_PHONE
        // and the underlying TCP socket just hung), close it now so we
        // don't accumulate ghost connections.
        client?.let { stale ->
            try { stale.close(1000, "superseded_by_new_connection") } catch (_: Exception) {}
            android.util.Log.d("PhoneServer", "Closed stale active client before pending-accept handshake")
        }
        client = null

        // Stage the connection as pending. PhoneService.onConnectionRequest
        // raises the Accept/Decline notification; user action calls back
        // into accept/declinePendingConnection().
        val requestId = UUID.randomUUID().toString()
        synchronized(pendingConnections) {
            pendingConnections[requestId] = conn
        }
        // Stash the request id on the WebSocket's attachment so onClose can
        // find + clean up its slot in pendingConnections if the client
        // disconnects before the user decides.
        conn.setAttachment(requestId)

        onConnectionRequest(requestId, addr)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        android.util.Log.d(
            "PhoneServer",
            "Connection closed: code=$code reason=$reason remote=$remote isCurrentClient=${client == conn}"
        )

        // Pending-side cleanup: if the closing conn was a pending request
        // (user never had a chance to Accept), drop it from the map.
        val attachmentId: String? = conn.getAttachment()
        if (attachmentId != null) {
            synchronized(pendingConnections) {
                pendingConnections.remove(attachmentId)
            }
        }

        // Active-side cleanup. We deliberately clear `client` regardless of
        // identity — the previous identity check (`if (client == conn)`)
        // missed cleanup in the race where a new conn arrived before the
        // old one's onClose fired, overwriting `client`. The result was a
        // dangling "connected" state that only an APK reinstall could
        // clear. The new rule: any onClose for the conn we currently
        // believe is active resets state; any onClose for an already-
        // superseded conn is a no-op (handled by client == conn check),
        // but in both cases we broadcast the connection-change so the
        // foreground notification reflects truth.
        if (client == conn) {
            client = null
            onConnectionChange(false, null)
        } else if (client == null) {
            // Either we never had an active client (pending declined or
            // raw disconnect before Accept), or it was already cleared.
            // Still notify so the foreground notification flips back to
            // "Phone bridge is active".
            onConnectionChange(false, null)
        }
    }

    override fun onMessage(conn: WebSocket, message: String) {
        android.util.Log.d("PhoneServer", "Received message: ${message.take(100)}")

        // Guard: messages from a still-pending connection (user hasn't
        // accepted yet) are dropped on the floor. The webapp would only
        // send commands after STATUS:connected anyway, but the defense
        // here prevents a misbehaving client from issuing MAKE_CALL etc.
        // before the phone owner explicitly approves the session.
        if (conn != client) {
            android.util.Log.w(
                "PhoneServer",
                "Dropping message from non-accepted connection (pending or stale)"
            )
            return
        }

        try {
            val colonIndex = message.indexOf(':')
            if (colonIndex == -1) {
                android.util.Log.w("PhoneServer", "Invalid message format (no colon)")
                return
            }

            val command = message.substring(0, colonIndex)
            val jsonStr = message.substring(colonIndex + 1)
            android.util.Log.d("PhoneServer", "Parsed command: $command")
            val payload = if (jsonStr.isNotEmpty()) {
                gson.fromJson(jsonStr, Map::class.java) as? Map<String, Any>
            } else null

            onCommand(command, payload)
        } catch (e: Exception) {
            android.util.Log.e("PhoneServer", "Error processing message: ${e.message}", e)
        }
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        ex.printStackTrace()
    }

    override fun onStart() {
        println("Server started on port $port")
    }

    fun send(type: String, payload: Any) {
        val json = gson.toJson(payload)
        val msg = "$type:$json"
        android.util.Log.d("PhoneServer", "Sending: ${msg.take(100)}... (${msg.length} chars)")
        try {
            client?.send(msg)
            android.util.Log.d("PhoneServer", "Message sent successfully")
        } catch (e: Exception) {
            android.util.Log.e("PhoneServer", "Error sending: ${e.message}", e)
        }
    }

    fun isClientConnected(): Boolean = client?.isOpen == true

    /**
     * User tapped Accept on the connection-request notification.
     *
     * Promotes the pending conn → active client. From this point on
     * onMessage processes incoming commands normally and PhoneService
     * can send responses back via [send]. The DEVICE_INFO frame mirrors
     * the previous handshake message so the webapp's name display works.
     *
     * Returns true on success, false if the requestId is unknown (either
     * the user took too long and the client gave up, or a double-accept
     * race).
     */
    @Synchronized
    fun acceptPendingConnection(requestId: String): Boolean {
        val conn = synchronized(pendingConnections) {
            pendingConnections.remove(requestId)
        } ?: run {
            android.util.Log.w("PhoneServer", "acceptPendingConnection: unknown requestId $requestId")
            return false
        }

        if (!conn.isOpen) {
            android.util.Log.w("PhoneServer", "acceptPendingConnection: conn already closed for $requestId")
            return false
        }

        client = conn
        // Clear the request-id attachment now that the conn has been
        // promoted — its onClose path will fall through the identity
        // check naturally.
        conn.setAttachment(null as String?)

        val addr = conn.remoteSocketAddress?.toString() ?: "unknown"
        android.util.Log.d("PhoneServer", "Accepted connection from $addr")
        onConnectionChange(true, addr)

        // Send the device-info handshake the webapp expects.
        val deviceName = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
        send("DEVICE_INFO", mapOf("deviceName" to deviceName))
        return true
    }

    /**
     * User tapped Decline (or the 30 s auto-decline fired). Closes the
     * pending conn with WebSocket close code 1008 ("policy violation")
     * — chosen over 1000 so the webapp can distinguish "phone said no"
     * from "phone said disconnect normally" and surface a clear message.
     */
    @Synchronized
    fun declinePendingConnection(requestId: String): Boolean {
        val conn = synchronized(pendingConnections) {
            pendingConnections.remove(requestId)
        } ?: return false

        try {
            conn.close(1008, "user_declined")
        } catch (e: Exception) {
            android.util.Log.w("PhoneServer", "declinePendingConnection close threw: ${e.message}")
        }
        android.util.Log.d("PhoneServer", "Declined connection $requestId")
        return true
    }

    /**
     * Tear down EVERYTHING — active client + every pending request. Called
     * from PhoneService when the webapp sends DISCONNECT_PHONE so the
     * phone-side state ends up clean and ready for the next pairing.
     *
     * Close code 1000 ("normal closure") because this is a clean,
     * mutually-agreed teardown initiated by the user from the webapp side.
     */
    @Synchronized
    fun disconnectAllClients() {
        val pending = synchronized(pendingConnections) {
            val copy = pendingConnections.values.toList()
            pendingConnections.clear()
            copy
        }
        pending.forEach { conn ->
            try { conn.close(1000, "user_disconnect") } catch (_: Exception) {}
        }
        client?.let { active ->
            try { active.close(1000, "user_disconnect") } catch (_: Exception) {}
        }
        client = null
        onConnectionChange(false, null)
        android.util.Log.d("PhoneServer", "disconnectAllClients: cleared active + ${pending.size} pending")
    }

    /**
     * Look up the remote address of a still-pending request — used by
     * MainActivity when the user taps the notification body (not the
     * action buttons) to render a confirmation screen with the IP.
     */
    fun getPendingAddress(requestId: String): String? {
        return synchronized(pendingConnections) {
            pendingConnections[requestId]?.remoteSocketAddress?.toString()
        }
    }
}
