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

    /**
     * PER-LEG DECLINE (2026-06-16, Dennis full-version). Reject ONE specific
     * ringing/waiting leg by number while keeping any active call connected.
     *
     * IMPORTANT — ARCHITECTURE CONSTRAINT (read before changing):
     *   Targeting a single call requires holding that call's
     *   `android.telecom.Call` object. Those are delivered ONLY to a registered
     *   `InCallService`, which in turn requires this app to hold the system
     *   DEFAULT-DIALER role. This companion app is NOT the default dialer (see
     *   PhoneService.kt registry header — Phase-1 scope explicitly excludes it),
     *   so today there is NO per-leg Call handle available.
     *
     *   `telecomManager.endCall()` is AGGREGATE — it ends the foreground/active
     *   call, NOT a chosen waiting leg. Using it here would hang up the WRONG
     *   call (the active one). So when no InCallService Call handle is
     *   available we DELIBERATELY refuse to act on telecom and return false —
     *   the waiting leg rings out / hits voicemail and the active call is never
     *   disturbed. This is the safe, correct fallback.
     *
     * TO MAKE THIS ACTUALLY HANG UP THE WAITING LEG ON-DEVICE (the new APK):
     *   1. Add a `CompanionInCallService : android.telecom.InCallService` that
     *      tracks `onCallAdded(call)` / `onCallRemoved(call)` into a static
     *      registry keyed by the call's number (call.details.handle).
     *   2. Declare it in AndroidManifest with
     *      <service android:permission="android.permission.BIND_INCALL_SERVICE">
     *      + <meta-data IN_CALL_SERVICE_UI=true> and request the default-dialer
     *      role (RoleManager.ROLE_DIALER) at runtime.
     *   3. Here, look up the Call whose handle matches `number`, in RINGING
     *      state, and call `call.reject(false, null)` (or `call.disconnect()`
     *      for a connecting leg) on THAT leg only.
     *   The web + relay changes are already backward-compatible with this.
     *
     * @return true if a specific waiting leg was actually rejected; false when
     *   no per-leg handle exists (caller leaves the active call untouched).
     */
    fun declineRingingCall(number: String): Boolean {
        val call = CompanionInCallService.findRingingCall(number)
        if (call == null) {
            android.util.Log.w(
                "CallHandler",
                "declineRingingCall: no InCallService Call handle for [$number] — " +
                    "refusing aggregate endCall() so the ACTIVE call is not hung up. " +
                    "Per-leg decline needs the default-dialer/InCallService role (see KDoc)."
            )
            return false
        }
        return try {
            call.reject(false, null)
            android.util.Log.d("CallHandler", "declineRingingCall: rejected ringing leg for [$number]")
            true
        } catch (e: Exception) {
            android.util.Log.e("CallHandler", "declineRingingCall failed: ${e.message}", e)
            false
        }
    }
}
