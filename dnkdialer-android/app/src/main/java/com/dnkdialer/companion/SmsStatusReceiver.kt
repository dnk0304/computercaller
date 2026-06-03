package com.dnkdialer.companion

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import java.io.File

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
            "MMS_SENT" -> {
                // MMS sentIntent callback. Routes through the same
                // onSmsSent callback so PhoneService emits the unified
                // SMS_SEND_STATUS lifecycle frame — the web bubble
                // updates by clientMsgId without caring whether the
                // underlying transport was SMS or MMS.
                //
                // Two failure paths arrive here:
                //   1. SmsManager.sendMultimediaMessage finished and
                //      passed a result code via resultCode (success →
                //      RESULT_OK, errors → MMS_ERROR_* constants).
                //   2. MmsHandler.broadcastFailure fired a synthetic
                //      MMS_SENT before the PDU even reached the system
                //      service (permission denial / PDU build error) —
                //      these arrive with a `synthetic_failure_reason`
                //      extra and a default resultCode (RESULT_CANCELED).
                val syntheticReason = intent.getStringExtra("synthetic_failure_reason")
                val success = syntheticReason == null && resultCode == Activity.RESULT_OK
                val error = if (!success) {
                    syntheticReason ?: when (resultCode) {
                        // SmsManager.MMS_ERROR_* are constants on API 22+;
                        // wrapped in a try because some OEMs return
                        // platform-specific codes outside the documented set.
                        SmsManager.MMS_ERROR_UNSPECIFIED -> "MMS unspecified error"
                        SmsManager.MMS_ERROR_INVALID_APN -> "Invalid MMS APN — your carrier plan may not be MMS-provisioned"
                        SmsManager.MMS_ERROR_UNABLE_CONNECT_MMS -> "Could not connect to carrier MMS"
                        SmsManager.MMS_ERROR_HTTP_FAILURE -> "MMSC HTTP failure"
                        SmsManager.MMS_ERROR_IO_ERROR -> "MMS I/O error"
                        SmsManager.MMS_ERROR_RETRY -> "MMS retry"
                        SmsManager.MMS_ERROR_CONFIGURATION_ERROR -> "MMS configuration error"
                        SmsManager.MMS_ERROR_NO_DATA_NETWORK -> "No data network for MMS"
                        else -> "MMS send failed (code $resultCode)"
                    }
                } else null

                // Best-effort cleanup of the cached PDU file regardless of
                // outcome. Path was stuffed into the intent extras by
                // MmsHandler.sendMms(). Silent — a leftover cache file
                // isn't fatal, but routine cleanup keeps the directory
                // from growing forever.
                intent.getStringExtra("pduFilePath")?.let { path ->
                    try { File(path).delete() } catch (_: Exception) { /* best-effort */ }
                }

                onSmsSent?.invoke(clientMsgId, success, error)
            }
        }
    }
}
