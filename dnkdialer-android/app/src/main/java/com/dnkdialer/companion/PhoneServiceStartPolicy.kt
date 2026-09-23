package com.dnkdialer.companion

/**
 * T-PHONE-FIRST-SIGNIN-NO-AUTODIAL — the start-vs-bind decision, extracted
 * as a pure function so it can be unit tested without an Activity.
 *
 * THE BUG THIS EXISTS TO PREVENT (reproduced 3x on v63 and on the tip,
 * e2e/evidence/live-acceptance-6d0aa98-20260923T1512Z finding 1):
 * MainActivity.runMainPaneOnResume used to do two independent things:
 *
 *   if (hasPermissions && batteryExempt && !serviceBound) startPhoneService()
 *   if (!serviceBound) bindService(Intent(PhoneService), BIND_AUTO_CREATE)
 *
 * On the first sign-in the battery-exemption dialog is still up when the
 * first onResume lands, so the first branch is skipped and the second one
 * runs a BARE bind with BIND_AUTO_CREATE and NO action. BIND_AUTO_CREATE
 * *instantiates* the service — PhoneService.onCreate runs — but a bound
 * create NEVER delivers onStartCommand, so startBridge() is never called
 * and the relay is never dialed. serviceBound then flips to true, and on
 * every later onResume the `!serviceBound` guard on the START branch is
 * false, so the service is never started. Forever. The UI reads "Ready and
 * listening" (it is bound, and the bridge reports nothing) while the relay
 * lobby stays phones=0. `am force-stop` + relaunch fixes it because the
 * fresh process starts from the not-bound state and hits the START branch.
 *
 * The fix is to key the decision on "has the service been STARTED"
 * (PhoneService.isStarted — set in onStartCommand, cleared in onDestroy),
 * never on "is it bound", and to never auto-create a service we have not
 * started.
 */
object PhoneServiceStartPolicy {

    /** Everything the decision depends on. No Android types. */
    data class Inputs(
        /** All runtime permissions in MainActivity.requiredPermissions granted. */
        val hasPermissions: Boolean,
        /** Doze battery-optimization exemption granted for our package. */
        val batteryExempt: Boolean,
        /** PhoneService.isStarted — onStartCommand has run and onDestroy has not. */
        val serviceStarted: Boolean,
        /** This Activity currently holds a live ServiceConnection. */
        val serviceBound: Boolean,
    )

    enum class Action {
        /** startForegroundService(ACTION_START) then bindService(). */
        START_AND_BIND,

        /** Service is already running; attach a connection to it only. */
        BIND_ONLY,

        /** Nothing to do (already bound, or preconditions not met yet). */
        NONE,
    }

    fun decide(i: Inputs): Action = when {
        // Preconditions met and the service has never been started (or has
        // died): start it, THEN bind. Note this does not look at
        // serviceBound — a bind that auto-created an unstarted service is
        // exactly the state we must recover from, not a reason to skip.
        i.hasPermissions && i.batteryExempt && !i.serviceStarted -> Action.START_AND_BIND

        // Already bound: nothing to do.
        i.serviceBound -> Action.NONE

        // Running but we have no connection (Activity recreated, or the
        // bind was torn down): attach. Safe — it cannot create anything.
        i.serviceStarted -> Action.BIND_ONLY

        // Not started and preconditions not met (permissions pending, or
        // the battery-exemption dialog is still on screen). Binding here
        // is what caused the bug: BIND_AUTO_CREATE would create an
        // unstarted service. Wait for the next onResume instead.
        else -> Action.NONE
    }
}
