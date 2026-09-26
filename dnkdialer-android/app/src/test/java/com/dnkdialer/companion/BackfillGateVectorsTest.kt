package com.dnkdialer.companion

import com.dnkdialer.companion.BackfillGate.Decision
import com.dnkdialer.companion.BackfillGate.Trigger
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * vc70 NOTIF-FORWARDING T3 — RULE 30 vectors for backfill timing and the
 * single-flight dedupe against the web's #18 re-request.
 */
class BackfillGateVectorsTest {

    private class Sim {
        val gate = BackfillGate()
        var now = 100_000L
        val runs = mutableListOf<Trigger>()
        fun req(t: Trigger, epoch: String, sasPending: Boolean): Decision {
            val d = gate.request(t, epoch, sasPending, now)
            if (d == Decision.RUN) runs += t
            return d
        }
        fun finish(epoch: String) = gate.finished(epoch, now)
    }

    @Test
    fun encrypted_pair_backfills_exactly_once_after_sas_confirm() {
        val s = Sim()
        assertEquals(Decision.DEFER_SAS_PENDING, s.req(Trigger.ACTIVE, "p1", sasPending = true))
        s.now += 4_000
        assertEquals(Decision.RUN, s.req(Trigger.SAS_CONFIRM, "p1", sasPending = false))
        assertEquals(listOf(Trigger.SAS_CONFIRM), s.runs)
    }

    @Test
    fun plain_pair_backfills_once_on_active() {
        val s = Sim()
        assertEquals(Decision.RUN, s.req(Trigger.ACTIVE, "p1", sasPending = false))
        assertEquals(listOf(Trigger.ACTIVE), s.runs)
    }

    @Test
    fun web_request_within_10s_of_a_confirm_backfill_is_skipped() {
        val s = Sim()
        s.req(Trigger.ACTIVE, "p1", true)
        s.req(Trigger.SAS_CONFIRM, "p1", false)
        // while the run is still in flight
        assertEquals(Decision.SKIP_DUPE, s.req(Trigger.WEB_REQUEST, "p1", false))
        s.now += 300
        s.finish("p1")
        s.now += 9_699
        assertEquals(Decision.SKIP_DUPE, s.req(Trigger.WEB_REQUEST, "p1", false))
        assertEquals(1, s.runs.size)
    }

    @Test
    fun after_10s_the_same_epoch_runs_again() {
        val s = Sim()
        s.req(Trigger.ACTIVE, "p1", false)
        s.finish("p1")
        s.now += BackfillGate.DEDUPE_MS
        assertEquals(Decision.RUN, s.req(Trigger.WEB_REQUEST, "p1", false))
    }

    @Test
    fun a_new_epoch_runs_immediately_even_while_the_old_one_runs() {
        val s = Sim()
        s.req(Trigger.ACTIVE, "p1", false)
        assertEquals(Decision.RUN, s.req(Trigger.ACTIVE, "p2", false))
        // the stale epoch's finish must not open p2's window early
        s.finish("p1")
        assertEquals(Decision.SKIP_DUPE, s.req(Trigger.WEB_REQUEST, "p2", false))
    }

    /**
     * The web may confirm its code BEFORE the phone user does and send
     * GET_NOTIFICATIONS while our gate is still shut. That request must neither
     * run (every frame would be dropped) nor count as a run (it would make the
     * real confirm backfill look like a duplicate).
     */
    @Test
    fun a_web_request_during_sas_pending_defers_and_does_not_poison_the_confirm() {
        val s = Sim()
        s.req(Trigger.ACTIVE, "p1", true)
        assertEquals(Decision.DEFER_SAS_PENDING, s.req(Trigger.WEB_REQUEST, "p1", true))
        s.now += 2_000
        assertEquals(Decision.RUN, s.req(Trigger.SAS_CONFIRM, "p1", false))
        assertEquals(listOf(Trigger.SAS_CONFIRM), s.runs)
    }

    /** PAIRING_ACTIVE landing after the confirm (slow relay) dedupes, not doubles. */
    @Test
    fun active_after_confirm_is_a_dupe() {
        val s = Sim()
        s.req(Trigger.SAS_CONFIRM, "p1", false)
        assertEquals(Decision.SKIP_DUPE, s.req(Trigger.ACTIVE, "p1", false))
        assertEquals(1, s.runs.size)
    }
}
