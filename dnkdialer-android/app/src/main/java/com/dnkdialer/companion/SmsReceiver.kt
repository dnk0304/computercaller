package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {

    /**
     * Framework-free view of one PDU part of an incoming SMS. Exists so the
     * assembly rule below can be unit-tested on the JVM: `android.telephony.
     * SmsMessage` is a stubbed final class in `app/src/test` and cannot be
     * constructed or mocked there.
     */
    data class SmsPart(
        val from: String?,
        val body: String?,
        val time: Long,
    )

    companion object {
        // simId is the subscriptionId carried in the SMS_RECEIVED broadcast
        // extras (when the platform supplies it). null for older devices /
        // single-SIM, where the field never gets populated.
        var onSmsReceived: ((from: String, body: String, time: Long, simId: Int?) -> Unit)? = null

        /**
         * Collapse the PDU parts of ONE `SMS_RECEIVED_ACTION` broadcast into a
         * single logical message.
         *
         * `Telephony.Sms.Intents.getMessagesFromIntent(Intent)` is documented to
         * return "an array of SmsMessage objects" built from the `pdus` extra —
         * for a concatenated (multipart) SMS that is one element PER PART, in the
         * order the parts were placed in the extra, i.e. by UDH sequence number.
         * One broadcast never carries two unrelated messages. We therefore
         * concatenate in ARRAY ORDER and deliberately do NOT re-sort by
         * timestamp: part timestamps are SMSC service-centre times with 1-second
         * granularity, so parts routinely share a timestamp and a timestamp sort
         * would be unstable — it could scramble a correctly ordered array.
         * (Before 2026-09-22 this receiver invoked the callback once per part,
         * which surfaced a long SMS as N out-of-order bubbles in the web client.)
         *
         * @return the assembled part, or null when there is nothing to emit
         *         (some OEMs deliver a null/empty `pdus` array for malformed PDUs).
         */
        fun assemble(parts: List<SmsPart>): SmsPart? {
            if (parts.isEmpty()) return null
            val body = parts.joinToString("") { it.body ?: "" }
            // First non-blank originating address: every part of a concatenated
            // SMS carries the same sender, but a malformed part can report null.
            val from = parts.firstOrNull { !it.from.isNullOrBlank() }?.from ?: "Unknown"
            // MIN over parts, not first(): it is order-independent (so it cannot
            // be perturbed by an OEM handing us parts in a different order) and
            // it is the earliest moment the message existed, which stays closest
            // to the DATE the SMS provider stamps on the assembled row — keeping
            // the receiver frame and the ContentObserver frame inside the web
            // client's body+time dedupe window.
            val time = parts.minOf { it.time }
            return SmsPart(from, body, time)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
            val messages: Array<android.telephony.SmsMessage>? =
                Telephony.Sms.Intents.getMessagesFromIntent(intent)

            // The "subscription" extra is set by the Telephony framework on
            // dual-SIM devices to indicate which SIM received the message.
            // Default to -1 if the extra isn't there.
            val rawSubId = intent.getIntExtra("subscription", -1)
            val simId = if (rawSubId >= 0) rawSubId else null

            val parts = messages.orEmpty().map {
                SmsPart(it.originatingAddress, it.messageBody, it.timestampMillis)
            }
            // Diagnostics for the multipart regression. Length and index only —
            // never address or body text (PII stays off logcat).
            parts.forEachIndexed { i, p ->
                android.util.Log.d(
                    "SmsReceiver",
                    "pdu part ${i + 1}/${parts.size} len=${p.body?.length ?: 0}"
                )
            }

            // Exactly one emit per broadcast — never one per PDU part.
            val assembled = assemble(parts) ?: run {
                android.util.Log.w("SmsReceiver", "no usable PDU parts — nothing emitted")
                return
            }
            android.util.Log.d(
                "SmsReceiver",
                "assembled emit 1 of 1 from ${parts.size} part(s) len=${assembled.body?.length ?: 0}"
            )

            onSmsReceived?.invoke(
                assembled.from ?: "Unknown",
                assembled.body ?: "",
                assembled.time,
                simId
            )
        }
    }
}
