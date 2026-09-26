package com.dnkdialer.companion

/**
 * vc70 NOTIF-FORWARDING T3 — when a notification backfill may run.
 *
 * Item 3 (encrypted pair -> empty Alerts): the backfill fired on PAIRING_ACTIVE,
 * which on an encrypted pair arrives BEFORE the user confirms the code. The
 * E2E gate is shut until then (sasPending), so every backfilled frame was
 * dropped and nothing ever re-sent them. The fix is ordering, not retries:
 *
 *  - PAIRING_ACTIVE on a pair with a pending code check -> DEFER; the SAS
 *    confirm runs it.
 *  - PAIRING_ACTIVE on a plain / no-code pair -> run (unchanged behaviour).
 *  - A web GET_NOTIFICATIONS while the code is pending -> DEFER too: it would
 *    be dropped by the gate AND, recorded as a run, it would make the confirm
 *    backfill look like a duplicate.
 *
 * Single-flight per pair epoch: the web (#18 A) re-requests exactly once after
 * ITS SAS confirm, which lands within seconds of ours. If a backfill for the
 * current epoch is running or finished < [DEDUPE_MS] ago, a further request is
 * SKIP_DUPE. After that window, or on a new epoch, it runs normally.
 *
 * Pure: the caller passes the clock and the epoch.
 */
class BackfillGate {

    companion object {
        const val DEDUPE_MS = 10_000L
    }

    enum class Trigger(val key: String) {
        ACTIVE("active"),
        SAS_CONFIRM("sas_confirm"),
        WEB_REQUEST("web_request"),
    }

    enum class Decision { RUN, SKIP_DUPE, DEFER_SAS_PENDING }

    private var epoch: String? = null
    private var running = false
    private var finishedAtMs = Long.MIN_VALUE

    /**
     * @param epoch the current pair's identity (the accepted pairing id); a
     *        new value resets the dedupe window.
     * @param sasPending the E2E gate is shut for a code check on this pair.
     */
    @Synchronized
    fun request(trigger: Trigger, epoch: String, sasPending: Boolean, nowMs: Long): Decision {
        if (sasPending) return Decision.DEFER_SAS_PENDING
        if (epoch == this.epoch &&
            (running || (finishedAtMs != Long.MIN_VALUE && nowMs - finishedAtMs < DEDUPE_MS))
        ) {
            return Decision.SKIP_DUPE
        }
        this.epoch = epoch
        running = true
        finishedAtMs = Long.MIN_VALUE
        return Decision.RUN
    }

    /** The run for [epoch] has emitted its frames. A stale epoch's finish is ignored. */
    @Synchronized
    fun finished(epoch: String, nowMs: Long) {
        if (epoch != this.epoch) return
        running = false
        finishedAtMs = nowMs
    }
}
