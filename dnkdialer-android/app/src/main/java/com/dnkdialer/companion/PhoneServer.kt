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

    init {
        // Bug #2 dispatch #23 — "Disconnect and refresh" sometimes failed to
        // come back online because the OS held port 8765 in TIME_WAIT after
        // the previous server.stop(), and the new bind would hit
        // BindException: Address already in use.
        //
        // SO_REUSEADDR (set via the inherited AbstractWebSocket.isReuseAddr
        // Kotlin property — backed by setReuseAddr(boolean) on the Java side)
        // tells the OS we explicitly want to bind even if a previous socket
        // is still lingering in TIME_WAIT. Safe on Android/Linux: the OS
        // still guarantees TCP correctness because the 4-tuple
        // (src-ip, src-port, dst-ip, dst-port) of an incoming packet is
        // unique enough to route to the new socket.
        //
        // CRITICAL: this MUST be set BEFORE start() is called — the value
        // is read once during the ServerSocketChannel bind in run(). Setting
        // it after start() is a no-op. Construction in PhoneService happens
        // BEFORE the explicit server?.start() at PhoneService.kt:960, so
        // the init block runs in time.
        isReuseAddr = true
    }

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

    /**
     * Messages received while a connection is still PENDING (user hasn't
     * tapped Accept yet). Replayed through [onMessage]'s normal codepath
     * the moment [acceptPendingConnection] promotes the conn to active.
     *
     * Why buffer instead of drop: the relay (server.js / relay-server.js)
     * sends informational frames the instant the outbound WS opens —
     * specifically `HELLO:{hostname}` and `BROWSER_STATUS:{count:N}`. The
     * `BROWSER_STATUS` count is what the phone's MainActivity reads to
     * decide between "Waiting for browser" and "1 client connected".
     * Dropping it left the phone permanently stuck on the waiting copy
     * even after a successful Accept, because no further BROWSER_STATUS
     * gets sent unless a new browser joins/leaves the relay room.
     *
     * Bounded to 64 messages per pending conn so a hostile/buggy client
     * can't OOM the service by spraying frames during the Accept window.
     * 64 is generous — server.js sends ~2-3 frames before the user can
     * possibly tap Accept.
     */
    private val pendingMessageBuffer = mutableMapOf<String, MutableList<String>>()
    private val maxBufferedPerPending = 64

    /**
     * Diagnostic — emits a single line capturing all connection-lifecycle
     * state at the point of call. Use at the END of every transition
     * (onOpen, onClose, accept, decline, disconnectAllClients) so a logcat
     * capture during a repro tells us exactly what state survives where.
     * Added 2026-05-20 after 4 patches failed to fix "disconnect → cannot
     * reconnect; uninstall is the only recovery." If this output ever shows
     * stale entries after disconnectAllClients, THAT is the bug to chase.
     */
    private fun dumpState(label: String) {
        val clientAddr = client?.remoteSocketAddress?.toString() ?: "null"
        val pendingIds = synchronized(pendingConnections) { pendingConnections.keys.toList() }
        val bufferSizes = synchronized(pendingConnections) {
            pendingMessageBuffer.mapValues { it.value.size }
        }
        android.util.Log.d(
            "PhoneServer",
            "STATE@$label client=$clientAddr pending=$pendingIds buffered=$bufferSizes"
        )
    }

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
            pendingMessageBuffer[requestId] = mutableListOf()
        }
        // Stash the request id on the WebSocket's attachment so onClose can
        // find + clean up its slot in pendingConnections if the client
        // disconnects before the user decides.
        conn.setAttachment(requestId)

        onConnectionRequest(requestId, addr)
        dumpState("onOpen")
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        android.util.Log.d(
            "PhoneServer",
            "Connection closed: code=$code reason=$reason remote=$remote isCurrentClient=${client == conn}"
        )

        // Pending-side cleanup: if the closing conn was a pending request
        // (user never had a chance to Accept), drop it from the map +
        // discard any buffered pre-Accept messages — they were never
        // promoted to the active codepath, so no one will replay them.
        val attachmentId: String? = conn.getAttachment()
        if (attachmentId != null) {
            synchronized(pendingConnections) {
                pendingConnections.remove(attachmentId)
                pendingMessageBuffer.remove(attachmentId)
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
            // "Phone bridge is active" — UNLESS there's a pending request
            // in flight (e.g. user just hit Disconnect + immediately
            // hit Reconnect; the old conn's delayed onClose would
            // otherwise wrongly flip the UI to disconnected while the
            // user is staring at the new Accept notification).
            val hasPending = synchronized(pendingConnections) {
                pendingConnections.isNotEmpty()
            }
            if (hasPending) {
                android.util.Log.d(
                    "PhoneServer",
                    "Stale onClose suppressed: a fresh pending request is awaiting Accept"
                )
            } else {
                onConnectionChange(false, null)
            }
        }
        dumpState("onClose")
    }

    override fun onMessage(conn: WebSocket, message: String) {
        android.util.Log.d("PhoneServer", "Received message: ${message.take(100)}")

        // Pre-Accept guard: messages from a still-pending connection are
        // BUFFERED, not processed. Once the user taps Accept we replay
        // the buffer through this same method so HELLO / BROWSER_STATUS /
        // any informational frames the relay sent during the Accept
        // window aren't lost.
        //
        // Why buffer over drop: server.js sends BROWSER_STATUS the moment
        // its outbound WS to the phone opens — BEFORE the phone user has
        // had a chance to tap Accept. Without buffering, the phone's
        // currentBrowserCount stayed at 0 and MainActivity rendered
        // "Waiting for browser" forever after Accept, since the relay
        // never re-sends BROWSER_STATUS unless a browser joins/leaves.
        //
        // Active-but-stale guard: if `client` is set but `conn` isn't
        // it AND `conn` isn't in pendingConnections either, this is a
        // truly stale frame from a superseded socket — drop it.
        if (conn != client) {
            val pendingId: String? = conn.getAttachment()
            if (pendingId != null) {
                synchronized(pendingConnections) {
                    val buf = pendingMessageBuffer[pendingId]
                    if (buf != null && buf.size < maxBufferedPerPending) {
                        buf.add(message)
                        android.util.Log.d(
                            "PhoneServer",
                            "Buffered pre-Accept message (${buf.size}/$maxBufferedPerPending): ${message.take(60)}"
                        )
                    } else if (buf != null) {
                        android.util.Log.w(
                            "PhoneServer",
                            "Pre-Accept buffer full — dropping: ${message.take(60)}"
                        )
                    }
                    // Explicit Unit so Kotlin doesn't try to infer the
                    // synchronized block's return type from the if-expression
                    // above (which lacks a final else branch and would fail
                    // compilation with "'if' must have both main and 'else'
                    // branches if used as an expression").
                    Unit
                }
            } else {
                android.util.Log.w(
                    "PhoneServer",
                    "Dropping message from stale (superseded) connection"
                )
            }
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
        val conn: WebSocket
        val buffered: List<String>
        synchronized(pendingConnections) {
            conn = pendingConnections.remove(requestId) ?: run {
                android.util.Log.w("PhoneServer", "acceptPendingConnection: unknown requestId $requestId")
                return false
            }
            buffered = pendingMessageBuffer.remove(requestId).orEmpty()
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
        android.util.Log.d("PhoneServer", "Accepted connection from $addr (replaying ${buffered.size} buffered messages)")
        onConnectionChange(true, addr)

        // Send the device-info handshake the webapp expects.
        val deviceName = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
        send("DEVICE_INFO", mapOf("deviceName" to deviceName))

        // Replay any informational frames the relay/browser sent while we
        // were parked in pending state. This is what ensures the accepted
        // path re-enters the normal post-open codepath — HELLO sets
        // connectedHostname, BROWSER_STATUS sets currentBrowserCount, and
        // MainActivity's polling loop picks up the resulting state on its
        // next 2s tick. Without this replay, BROWSER_STATUS arriving
        // pre-Accept (which server.js sends on outbound-open) was lost and
        // the status row stayed stuck on "Waiting for browser".
        buffered.forEach { msg ->
            try {
                onMessage(conn, msg)
            } catch (e: Exception) {
                android.util.Log.w("PhoneServer", "Replay of buffered message failed: ${e.message}")
            }
        }
        dumpState("acceptPendingConnection")
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
            // Drop the buffered messages alongside the pending entry —
            // declined conns never enter the active codepath, so a
            // lingering buffer would leak memory until the next pending
            // request happened to reuse the slot (which never happens —
            // request ids are UUIDs).
            pendingMessageBuffer.remove(requestId)
            pendingConnections.remove(requestId)
        } ?: return false

        try {
            conn.close(1008, "user_declined")
        } catch (e: Exception) {
            android.util.Log.w("PhoneServer", "declinePendingConnection close threw: ${e.message}")
        }
        android.util.Log.d("PhoneServer", "Declined connection $requestId")
        dumpState("declinePendingConnection")
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
            pendingMessageBuffer.clear()
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
        dumpState("disconnectAllClients")
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
