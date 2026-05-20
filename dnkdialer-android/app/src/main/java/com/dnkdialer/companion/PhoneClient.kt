package com.dnkdialer.companion

import com.google.gson.Gson
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI

/**
 * Thin WebSocket client for the relay. Lifecycle callbacks fan out to the
 * owning PhoneService so it can drive the UI's connection-state machine.
 *
 * Callback contract:
 *   - [onConnectionChange] — fires on EVERY transition (open / close).
 *     The boolean is "are we currently open?".
 *   - [onConnectionError] — fires on close-with-non-normal-code AND on
 *     the raw onError exception path. Carries the close code (or -1
 *     for pre-handshake exceptions) + best-effort reason string so the
 *     UI can map it to actionable user-facing copy (refused vs timed
 *     out vs invalid token vs generic).
 *
 * Why two callbacks instead of one richer onConnectionChange:
 * PhoneService already wires onConnectionChange to its notification +
 * client-connected flag. Splitting the error signal out means we don't
 * have to rewrite that wiring; the new onConnectionError handler exists
 * ONLY to fuel the FAILED state in MainActivity.
 */
class PhoneClient(
    serverUri: URI,
    private val onCommand: (String, Map<String, Any>?) -> Unit,
    private val onConnectionChange: (Boolean) -> Unit,
    private val onConnectionError: ((code: Int, reason: String?) -> Unit)? = null
) : WebSocketClient(serverUri) {

    private val gson = Gson()

    override fun onOpen(handshake: ServerHandshake?) {
        android.util.Log.d("PhoneClient", "Connected to relay: $uri")
        onConnectionChange(true)
        // Send device name to relay so browsers can display it
        val deviceName = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
        sendResponse("DEVICE_INFO", mapOf("deviceName" to deviceName))
    }

    override fun onMessage(message: String) {
        try {
            val colonIndex = message.indexOf(':')
            if (colonIndex == -1) return

            val command = message.substring(0, colonIndex)
            val jsonStr = message.substring(colonIndex + 1)
            val payload = if (jsonStr.isNotEmpty()) {
                gson.fromJson(jsonStr, Map::class.java) as? Map<String, Any>
            } else null

            onCommand(command, payload)
        } catch (e: Exception) {
            android.util.Log.e("PhoneClient", "Error parsing message: ${e.message}")
        }
    }

    override fun onClose(code: Int, reason: String?, remote: Boolean) {
        android.util.Log.d("PhoneClient", "Disconnected from relay (code: $code, reason: $reason, remote: $remote)")
        onConnectionChange(false)
        // Code 1000 is the normal-closure code. Anything else — including
        // 1006 (abnormal closure, common when the server is unreachable),
        // 4401 (the relay's invalid-token close), 1001 (going away), etc.
        // — should surface as a FAILED state to the user. Code 1000 with
        // a user-initiated disconnect path is handled separately in
        // PhoneService.disconnectRelay() which clears the error first.
        if (code != 1000) {
            onConnectionError?.invoke(code, reason)
        }
    }

    override fun onError(ex: Exception?) {
        // -1 sentinel = "no close frame, raw exception". Reason carries
        // the exception class name + message so MainActivity can map
        // ConnectException / SocketTimeoutException / UnknownHostException
        // to concrete user-facing copy.
        val reason = ex?.let { "${it.javaClass.simpleName}: ${it.message ?: "no detail"}" }
        android.util.Log.e("PhoneClient", "Connection error: $reason")
        onConnectionError?.invoke(-1, reason)
    }

    fun sendResponse(type: String, payload: Any) {
        val json = Gson().toJson(payload)
        val msg = "$type:$json"
        if (isOpen) {
            send(msg)
        }
    }
}
