package com.dnkdialer.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
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

    /**
     * ANDROID-LINT (b2). The ANSWER_PHONE_CALLS check is made HERE, at the call
     * site, not left to a runtime check somewhere upstream.
     *
     * The lint baseline's `_owners` note recorded the old position — "each site
     * DOES gate on a runtime permission check upstream, lint cannot see it" —
     * and that is exactly the problem with it. A guarantee lint cannot see is
     * also a guarantee the next caller cannot see: add one new caller that does
     * not go through the upstream check and this throws SecurityException at
     * runtime, with nothing in the build to catch it. A local check is the
     * smallest diff that makes the invariant true rather than merely believed,
     * and it is the same pattern makeCall() above already uses (which is why
     * makeCall is not in the baseline while these two are).
     */
    private fun hasAnswerPhoneCalls(): Boolean {
        if (context.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            android.util.Log.e("CallHandler", "ANSWER_PHONE_CALLS permission not granted")
            return false
        }
        return true
    }

    fun answerCall() {
        if (!hasAnswerPhoneCalls()) return
        try {
            telecomManager.acceptRingingCall()
        } catch (e: SecurityException) {
            android.util.Log.e("CallHandler", "SecurityException answering call: ${e.message}", e)
        } catch (e: Exception) {
            android.util.Log.e("CallHandler", "Error answering call: ${e.message}", e)
        }
    }

    /**
     * ANDROID-LINT (b1). `TelecomManager#endCall` was added in API 28 (P) and
     * this module's minSdk is 26, so on Android 8.0/8.1 the unguarded call
     * throws NoSuchMethodError — a real crash on devices in the field today,
     * not a theoretical lint complaint. (It was caught by `catch (e: Exception)`
     * only by accident: NoSuchMethodError is an Error, not an Exception, so it
     * propagated straight out.)
     *
     * There is no supported fallback below 28. The historical one — reflecting
     * into ITelephony#endCall — is deprecated, was never public API, and is
     * blocked from 28 onward anyway; adding it would trade a visible crash for
     * a hidden one. So 26/27 returns false and says why, and the caller treats
     * it as "hang-up unavailable on this device" like any other failure.
     */
    fun endCall(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            android.util.Log.w(
                "CallHandler",
                "endCall unavailable: TelecomManager#endCall is API 28+, device is API ${Build.VERSION.SDK_INT}"
            )
            return false
        }
        if (!hasAnswerPhoneCalls()) return false
        return try {
            telecomManager.endCall()
        } catch (e: SecurityException) {
            android.util.Log.e("CallHandler", "SecurityException ending call: ${e.message}", e)
            false
        } catch (e: Exception) {
            android.util.Log.e("CallHandler", "Error ending call: ${e.message}", e)
            false
        }
    }
}
