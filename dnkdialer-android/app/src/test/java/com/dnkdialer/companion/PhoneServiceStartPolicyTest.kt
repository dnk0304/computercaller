package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Test

import com.dnkdialer.companion.PhoneServiceStartPolicy.Action
import com.dnkdialer.companion.PhoneServiceStartPolicy.Inputs
import com.dnkdialer.companion.PhoneServiceStartPolicy.decide

/**
 * T-PHONE-FIRST-SIGNIN-NO-AUTODIAL — the start-vs-bind decision.
 *
 * The regression under test is not "a wrong branch once": it is a LATCH.
 * A bind that auto-created an unstarted service used to set serviceBound,
 * and the old `!serviceBound` guard then suppressed the start on every
 * subsequent onResume. The sequence tests below walk the real first-sign-in
 * timeline and assert the latch cannot form.
 */
class PhoneServiceStartPolicyTest {

    private fun inputs(
        perms: Boolean = true,
        battery: Boolean = true,
        started: Boolean = false,
        bound: Boolean = false,
    ) = Inputs(perms, battery, started, bound)

    // ---- the four corners -------------------------------------------------

    @Test
    fun `preconditions met and not started starts and binds`() {
        assertEquals(Action.START_AND_BIND, decide(inputs()))
    }

    @Test
    fun `started and unbound binds only`() {
        assertEquals(Action.BIND_ONLY, decide(inputs(started = true, bound = false)))
    }

    @Test
    fun `started and bound does nothing`() {
        assertEquals(Action.NONE, decide(inputs(started = true, bound = true)))
    }

    @Test
    fun `not started and preconditions unmet never binds`() {
        // This is the exact bug: the old code ran a bare BIND_AUTO_CREATE
        // here, creating a service that onStartCommand would never reach.
        assertEquals(Action.NONE, decide(inputs(battery = false)))
        assertEquals(Action.NONE, decide(inputs(perms = false)))
        assertEquals(Action.NONE, decide(inputs(perms = false, battery = false)))
    }

    // ---- the latch --------------------------------------------------------

    @Test
    fun `a bound but unstarted service is still started`() {
        // The recovery case. If some other path (an old build, a sticky
        // rebind) left us bound to an unstarted service, the decision must
        // still be START_AND_BIND — not NONE.
        assertEquals(
            Action.START_AND_BIND,
            decide(inputs(started = false, bound = true)),
        )
    }

    @Test
    fun `first sign-in timeline dials the relay without a force-stop`() {
        // t0: MainActivity onResume lands while the battery-exemption
        //     dialog is on screen. Nothing may be created.
        var bound = false
        var started = false
        val d0 = decide(inputs(battery = false, started = started, bound = bound))
        assertEquals(Action.NONE, d0)
        // (old code bound here; model that the bind WOULD have set bound)
        // t1: user taps Allow, onResume runs again.
        val d1 = decide(inputs(battery = true, started = started, bound = bound))
        assertEquals(Action.START_AND_BIND, d1)
        started = true; bound = true
        // t2: a later onResume must not re-start an already running service.
        assertEquals(
            Action.NONE,
            decide(inputs(battery = true, started = started, bound = bound)),
        )
    }

    @Test
    fun `the old guard would have latched - control`() {
        // Red control for the fix: reproduce the OLD decision inline and
        // show it goes silent forever once a bind lands first. If this ever
        // starts agreeing with decide(), the fix has been reverted.
        fun legacy(i: Inputs): Action = when {
            i.hasPermissions && i.batteryExempt && !i.serviceBound -> Action.START_AND_BIND
            !i.serviceBound -> Action.BIND_ONLY
            else -> Action.NONE
        }
        // t0 with the dialog up: legacy binds (auto-creating an unstarted
        // service), the fix does nothing.
        val t0 = inputs(battery = false)
        assertEquals(Action.BIND_ONLY, legacy(t0))
        assertEquals(Action.NONE, decide(t0))
        // t1 after Allow, now bound-but-unstarted: legacy latches to NONE
        // (the bug — no onStartCommand, ever), the fix starts.
        val t1 = inputs(battery = true, started = false, bound = true)
        assertEquals(Action.NONE, legacy(t1))
        assertEquals(Action.START_AND_BIND, decide(t1))
    }

    @Test
    fun `service death while bound restarts`() {
        // onServiceDisconnected clears bound; onDestroy clears started.
        assertEquals(Action.START_AND_BIND, decide(inputs(started = false, bound = false)))
    }
}
