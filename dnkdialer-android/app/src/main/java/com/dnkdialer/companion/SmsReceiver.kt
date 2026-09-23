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
            // it is the earliest moment the message existed per the SMSC.
            // DIAGNOSTIC ONLY as of 2026-09-22 (SMSMP-2): this is no longer what
            // goes on the wire — the emitted frame carries the receiving device's
            // wall clock. See assembleForEmit().
            val time = parts.minOf { it.time }
            return SmsPart(from, body, time)
        }

        /**
         * The frame actually put on the wire by [onReceive].
         *
         * Identical to [assemble] except that `time` is the RECEIVING DEVICE'S
         * WALL CLOCK at emit, not the SMSC service-centre time carried in the
         * PDUs. The web client (`hooks/usePhoneBridge.ts`, SMS_RECEIVED) uses
         * this value for exactly two things — newest-first display sort, and a
         * body+conversation+10 s dedupe against the ContentObserver frame and
         * later GET_MESSAGES rows. Both compare against the provider `DATE`
         * column, which the default SMS app stamps from the phone's wall clock
         * at insert. The receiver frame was the only thing on the wire on a
         * different clock, so a late SMSC delivery — or a multipart whose parts
         * trickle in over seconds, dragging min(parts) toward the 10 s edge —
         * produced a second bubble. Nothing on relay/web/extension reads SMSC
         * time as a sequence key.
         *
         * `now` is a parameter so the JVM unit tests can pin it.
         */
        fun assembleForEmit(parts: List<SmsPart>, now: Long): SmsPart? =
            assemble(parts)?.copy(time = now)
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

            // Exactly one emit per broadcast — never one per PDU part. The
            // emitted `time` is THIS DEVICE'S WALL CLOCK at receipt — the same
            // clock the SMS provider stamps on the row the ContentObserver
            // later reports. See assembleForEmit().
            val now = System.currentTimeMillis()
            val emit = assembleForEmit(parts, now) ?: run {
                android.util.Log.w("SmsReceiver", "no usable PDU parts — nothing emitted")
                DiagLog.counter("sms.dropped.no_parts")
                DiagLog.w("SmsReceiver", "SMS dropped: no usable PDU parts (n=${parts.size})")
                return
            }
            // How far the SMSC clock was from receipt. Length/skew only —
            // never address or body text.
            val smscSkewMs = parts.minOfOrNull { it.time }?.let { now - it } ?: 0L
            android.util.Log.d(
                "SmsReceiver",
                "assembled emit 1 of 1 from ${parts.size} part(s) " +
                    "len=${emit.body?.length ?: 0} smscSkewMs=$smscSkewMs"
            )
            // vc63 — metadata only. The sender is hashed HERE, at the call
            // site, rather than handed to Redact raw: Redact normalises
            // "+4712345678" and "4712345678" to different tokens by design, so
            // hashing the address the SMS stack gave us keeps one sender to one
            // handle across SmsReceiver, MmsHandler and the call log. The BODY
            // is never passed in any form — only its length.
            //
            // `forwarded` is whether a listener was attached at all: a received
            // SMS that never reached the relay because the bridge was down is
            // the exact complaint this line answers.
            DiagLog.counter("sms.received")
            DiagLog.d(
                "SmsReceiver",
                "SMS in parts=${parts.size} multipart=${parts.size > 1} " +
                    "from=${Redact.hash6(emit.from ?: "Unknown")} len=${emit.body?.length ?: 0} " +
                    "smscSkewMs=$smscSkewMs forwarded=${onSmsReceived != null}",
            )

            onSmsReceived?.invoke(
                emit.from ?: "Unknown",
                emit.body ?: "",
                emit.time,
                simId
            )
        }
    }
}
