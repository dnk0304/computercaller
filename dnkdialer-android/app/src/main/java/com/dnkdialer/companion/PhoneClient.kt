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
 *   - [onConnectionChange] - fires on EVERY transition (open / close).
 *     The boolean is "are we currently open?".
 *   - [onConnectionError] - fires on close-with-non-normal-code AND on
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
 *
 * Bundle C (2026-05-28) - the constructor takes an optional [httpHeaders]
 * map that is forwarded to the underlying Java-WebSocket WebSocketClient
 * via its (URI, Map<String,String>) constructor. The phoneToken now ships
 * in `Authorization: Bearer <phoneToken>` instead of the WS URL's
 * `?token=` query string (closes audit finding M3 APK side). Server.js
 * accepts both paths for back-compat.
 */
class PhoneClient(
    serverUri: URI,
    private val onCommand: (String, Map<String, Any>?) -> Unit,
    private val onConnectionChange: (Boolean) -> Unit,
    private val onConnectionError: ((code: Int, reason: String?) -> Unit)? = null,
    httpHeaders: Map<String, String> = emptyMap()
) : WebSocketClient(serverUri, httpHeaders) {

    private val gson = Gson()

    /**
     * P4 (w3) — the E2E chokepoint, injected by [PhoneService] once a pair has
     * negotiated encryption, and null until then.
     *
     * It lives HERE rather than in PhoneService because this class holds the
     * only literal `send()` to the socket and the only `onMessage`. A gate
     * applied one layer up would be bypassed by the four call sites that reach
     * `client?.sendResponse(...)` directly, and each of those sends a frame on
     * §13.7's sealed list. A chokepoint with four ways around it is not one.
     *
     * @Volatile because it is written on the Accept worker and read on the
     * socket's reader thread and on whichever thread emits a frame.
     */
    @Volatile
    var frameGate: E2eFrameGate? = null

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
            // P4 (w3): unseal BEFORE parsing. The envelope is the body, so a
            // sealed frame parsed as a payload would dispatch {e,kid,s,c} to a
            // handler expecting the real fields — which reads as a malformed
            // frame rather than as an encrypted one.
            val gate = frameGate
            val body = if (gate == null) {
                jsonStr
            } else {
                when (val verdict = gate.inbound(command, jsonStr)) {
                    is E2eFrameGate.Inbound.Deliver -> verdict.json
                    is E2eFrameGate.Inbound.Drop -> {
                        // §13.5: drop the frame, NEVER close the socket.
                        android.util.Log.w(
                            "PhoneClient", "dropped inbound $command: ${verdict.reason}"
                        )
                        return
                    }
                }
            }

            val payload = if (body.isNotEmpty()) {
                gson.fromJson(body, Map::class.java) as? Map<String, Any>
            } else null

            onCommand(command, payload)
        } catch (e: Exception) {
            android.util.Log.e("PhoneClient", "Error parsing message: ${e.message}")
        }
    }

    override fun onClose(code: Int, reason: String?, remote: Boolean) {
        android.util.Log.d("PhoneClient", "Disconnected from relay (code: $code, reason: $reason, remote: $remote)")
        onConnectionChange(false)
        // Code 1000 is the normal-closure code. Anything else - including
        // 1006 (abnormal closure, common when the server is unreachable),
        // 4401 (the relay's invalid-token close), 1001 (going away), etc.
        // - should surface as a FAILED state to the user. Code 1000 with
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
        // P4 (w3): the single outbound chokepoint. A null body means DROP —
        // §13.7 says a sealed frame that cannot be sealed must not leave in the
        // clear, because the user has been told this pair is encrypted and a
        // silent fallback on the one frame that failed is worse than losing it.
        // Read the volatile ONCE: two reads could straddle the moment an Accept
        // installs the gate, and "no gate" plus "gate said drop" are opposite
        // outcomes that must not be decided from two different observations.
        val gate = frameGate
        val body = if (gate == null) {
            json
        } else {
            gate.outbound(type, json) ?: run {
                android.util.Log.e(
                    "PhoneClient",
                    "DROPPED outbound $type — ${gate.lastDropReason} " +
                        "(total ${gate.droppedOutbound}). NOT sent in the clear."
                )
                return
            }
        }
        val msg = "$type:$body"
        if (isOpen) {
            send(msg)
        }
    }

    /**
     * FT-2 (a) — bytes this socket has accepted but not yet written to the
     * network. The sender-side watermark (spec §1) defers the next file chunk
     * above [FileTransfer.OUTBOUND_WATERMARK_BYTES].
     *
     * The FT-2 brief specifies OkHttp's `queueSize()`; this module is on
     * Java-WebSocket 1.5.4, whose equivalent is `WebSocketImpl.outQueue` — a
     * public final BlockingQueue of the frames still to go out. Summing its
     * `remaining()` is the same number by a different name.
     *
     * `hasBufferedData()` is the only method on the WebSocket *interface* and
     * it is deliberately NOT what this uses: it is true whenever anything at
     * all is queued, which during a healthy transfer is almost always, so a
     * watermark built on it throttles a fast link down to one chunk per poll.
     * We need a byte count to tell "flowing" from "backing up" apart.
     *
     * Returns 0 when the connection is not an impl we can read — a watermark
     * that cannot measure must not block the transfer, because the ACK window
     * still bounds the peer and an unmeasurable queue is not evidence of a
     * full one.
     */
    fun queuedBytes(): Long {
        val impl = try {
            connection as? org.java_websocket.WebSocketImpl
        } catch (e: Exception) {
            null
        } ?: return 0L
        var total = 0L
        try {
            // Weakly-consistent iteration: a frame drained mid-count just
            // makes the estimate slightly high, which errs toward deferring.
            for (buf in impl.outQueue) total += buf.remaining().toLong()
        } catch (e: Exception) {
            return 0L
        }
        return total
    }
}
