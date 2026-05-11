package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {

    companion object {
        // simId is the subscriptionId carried in the SMS_RECEIVED broadcast
        // extras (when the platform supplies it). null for older devices /
        // single-SIM, where the field never gets populated.
        var onSmsReceived: ((from: String, body: String, time: Long, simId: Int?) -> Unit)? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)

            // The "subscription" extra is set by the Telephony framework on
            // dual-SIM devices to indicate which SIM received the message.
            // Default to -1 if the extra isn't there.
            val rawSubId = intent.getIntExtra("subscription", -1)
            val simId = if (rawSubId >= 0) rawSubId else null

            messages.forEach { sms ->
                val from = sms.originatingAddress ?: "Unknown"
                val body = sms.messageBody ?: ""
                val time = sms.timestampMillis

                onSmsReceived?.invoke(from, body, time, simId)
            }
        }
    }
}
