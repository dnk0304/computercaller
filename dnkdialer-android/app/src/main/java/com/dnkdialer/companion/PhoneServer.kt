package com.dnkdialer.companion

import com.google.gson.Gson
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress

class PhoneServer(
    port: Int,
    private val onCommand: (String, Map<String, Any>?) -> Unit,
    private val onConnectionChange: (Boolean, String?) -> Unit  // (connected, remoteAddress)
) : WebSocketServer(InetSocketAddress(port)) {

    private val gson = Gson()
    private var client: WebSocket? = null

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        client = conn
        val addr = conn.remoteSocketAddress?.toString() ?: "unknown"
        println("Desktop connected: $addr")
        onConnectionChange(true, addr)
        // Send device name to the connecting client
        val deviceName = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
        send("DEVICE_INFO", mapOf("deviceName" to deviceName))
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        if (client == conn) {
            client = null
        }
        println("Desktop disconnected")
        onConnectionChange(false, null)
    }

    override fun onMessage(conn: WebSocket, message: String) {
        android.util.Log.d("PhoneServer", "Received message: ${message.take(100)}")
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
}
