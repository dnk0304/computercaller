package com.dnkdialer.companion

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager

class SmsStatusReceiver : BroadcastReceiver() {

    companion object {
        // Callbacks set by PhoneService
        var onSmsSent: ((clientMsgId: String, success: Boolean, error: String?) -> Unit)? = null
        var onSmsDelivered: ((clientMsgId: String) -> Unit)? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val clientMsgId = intent.getStringExtra("clientMsgId") ?: return

        when (intent.action) {
            "SMS_SENT" -> {
                val success = resultCode == Activity.RESULT_OK
                val error = if (!success) {
                    when (resultCode) {
                        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic failure"
                        SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
                        SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
                        SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio off"
                        else -> "Unknown error (code $resultCode)"
                    }
                } else null
                onSmsSent?.invoke(clientMsgId, success, error)
            }
            "SMS_DELIVERED" -> {
                onSmsDelivered?.invoke(clientMsgId)
            }
        }
    }
}
