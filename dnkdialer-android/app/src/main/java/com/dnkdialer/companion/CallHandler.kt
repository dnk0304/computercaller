package com.dnkdialer.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager

class CallHandler(private val context: Context) {

    private val telecomManager: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    /**
     * Place an outgoing call.
     *
     * On Android 10+ (API 29) launching ACTION_CALL via context.startActivity() from a
     * background Service is silently blocked by the background-activity-start restrictions,
     * which is why the previous Intent-based implementation never actually dialed.
     *
     * TelecomManager.placeCall() is the supported path that works from a Service —
     * the platform routes the request through the default dialer for us.
     *
     * `subscriptionId` is optional; when supplied (dual-SIM phones), the request is
     * tagged with `EXTRA_PHONE_ACCOUNT_HANDLE_SUBSCRIPTION_ID` so Telecom routes the
     * call through that specific SIM. When null, the platform's default outgoing
     * SIM is used.
     */
    fun makeCall(number: String, subscriptionId: Int? = null): Boolean {
        android.util.Log.d("CallHandler", "makeCall called with number: $number, subscriptionId: $subscriptionId")

        if (context.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.e("CallHandler", "CALL_PHONE permission not granted")
            return false
        }

        // Clean the phone number — keep only valid characters.
        val cleanNumber = number.replace(Regex("[^0-9+*#]"), "")
        if (cleanNumber.isEmpty()) {
            android.util.Log.w("CallHandler", "Invalid phone number")
            return false
        }

        return try {
            val uri = Uri.fromParts("tel", cleanNumber, null)
            val extras = Bundle()
            if (subscriptionId != null) {
                // Hard-coded key string — TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE_SUBSCRIPTION_ID
                // is hidden API on most Android versions, but the key itself is stable
                // and the platform reads it from the placeCall extras.
                extras.putInt("android.telecom.extra.PHONE_ACCOUNT_HANDLE_SUBSCRIPTION_ID", subscriptionId)
            }
            telecomManager.placeCall(uri, extras)
            android.util.Log.d("CallHandler", "telecomManager.placeCall dispatched for $cleanNumber (sub=$subscriptionId)")
            true
        } catch (e: SecurityException) {
            android.util.Log.e("CallHandler", "SecurityException placing call: ${e.message}", e)
            false
        } catch (e: Exception) {
            android.util.Log.e("CallHandler", "Error placing call: ${e.message}", e)
            false
        }
    }

    fun answerCall() {
        try {
            telecomManager.acceptRingingCall()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun endCall(): Boolean {
        return try {
            telecomManager.endCall()
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }
}
