package com.dnkdialer.companion

import android.telecom.Call
import android.telecom.InCallService

/**
 * PER-LEG DECLINE support (2026-06-16, Dennis full-version).
 *
 * An [InCallService] is the ONLY Android surface that hands an app the
 * individual [android.telecom.Call] objects for the calls on the device. The
 * aggregate `TelephonyManager`/`PhoneStateListener` registry used elsewhere in
 * this module can observe RINGING/OFFHOOK/IDLE but cannot target one leg.
 * `TelecomManager.endCall()` is likewise aggregate (ends the foreground call).
 *
 * This service keeps a live map of the on-device Call objects so
 * [CallHandler.declineRingingCall] can reject ONE specific waiting/ringing leg
 * (call.reject) while leaving the active call connected — implementing the
 * "reply with a message → decline the waiting call" action precisely.
 *
 * ── ACTIVATION (required for this to receive any Call objects) ──────────────
 * Android only BINDS this InCallService when the app holds the DEFAULT-DIALER
 * role. Until then onCallAdded never fires, [activeCalls] stays empty, and
 * [findRingingCall] returns null — at which point CallHandler safely refuses to
 * touch telecom (so the active call is never hung up by mistake). To activate:
 *   1. AndroidManifest: declare this service with
 *        android:permission="android.permission.BIND_INCALL_SERVICE"
 *      and an intent-filter for android.telecom.InCallService, plus
 *        <meta-data android:name="android.telecom.IN_CALL_SERVICE_UI"
 *                   android:value="true"/>
 *   2. Request RoleManager.ROLE_DIALER at runtime (or prompt the user to set
 *      this app as the default phone app).
 * These are intentionally NOT added in this dispatch — adopting the
 * default-dialer role is a product decision Ken/Dennis own (it changes the
 * app's responsibilities and Play Store posture). The web + relay path is
 * already backward-compatible: without per-leg support the waiting call just
 * rings out.
 *
 * NOTE: this class compiles and is correct as-is; it simply receives no
 * callbacks until the role is granted. No behavior change ships from merely
 * adding the file.
 */
class CompanionInCallService : InCallService() {

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        synchronized(lock) { liveCalls.add(call) }
        android.util.Log.d(TAG, "onCallAdded state=${call.state} (tracked=${liveCalls.size})")
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        synchronized(lock) { liveCalls.remove(call) }
        android.util.Log.d(TAG, "onCallRemoved (tracked=${liveCalls.size})")
    }

    companion object {
        private const val TAG = "CompanionInCall"
        private val lock = Any()
        private val liveCalls = mutableListOf<Call>()

        /** Digits-only last-8 match, mirroring the web/registry normNum. */
        private fun normNum(s: String?): String =
            (s ?: "").replace(Regex("\\D"), "").takeLast(8)

        /** Read the dial-string number from a Call's handle (tel: URI). */
        private fun numberOf(call: Call): String =
            call.details?.handle?.schemeSpecificPart ?: ""

        /**
         * Find the RINGING leg whose number matches [number]. Returns null when
         * this app is not the default dialer (no Calls are tracked) or no
         * ringing leg matches — CallHandler treats null as "do not touch
         * telecom" so the active call is never hung up by mistake.
         */
        fun findRingingCall(number: String): Call? {
            val want = normNum(number)
            synchronized(lock) {
                return liveCalls.firstOrNull { c ->
                    val ringing = c.state == Call.STATE_RINGING
                    // Empty incoming number can't be matched by digits; only
                    // match a ringing leg when we have a concrete number.
                    ringing && want.isNotEmpty() && normNum(numberOf(c)) == want
                }
            }
        }
    }
}
