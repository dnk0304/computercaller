package com.dnkdialer.companion

import com.google.gson.Gson
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI

class PhoneClient(
    serverUri: URI,
    private val onCommand: (String, Map<String, Any>?) -> Unit,
    private val onConnectionChange: (Boolean) -> Unit
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
        android.util.Log.d("PhoneClient", "Disconnected from relay (code: $code, reason: $reason)")
        onConnectionChange(false)
    }

    override fun onError(ex: Exception?) {
        android.util.Log.e("PhoneClient", "Connection error: ${ex?.message}")
    }

    fun sendResponse(type: String, payload: Any) {
        val json = Gson().toJson(payload)
        val msg = "$type:$json"
        if (isOpen) {
            send(msg)
        }
    }
}
