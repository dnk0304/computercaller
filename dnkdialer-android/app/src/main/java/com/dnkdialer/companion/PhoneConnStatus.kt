package com.dnkdialer.companion

import androidx.annotation.StringRes

/**
 * vc70 item 10 (PHONE-STATUS) — what the Home screen says about the connection,
 * as a pure state machine. No Context, no View, no clock of its own, so
 * `tests/phone-status-vectors.json` can walk it on the JVM
 * ([PhoneStatusVectorsTest]).
 *
 * ## What it fixes (Dennis, 2026-09-26 08:21-08:23Z)
 *
 * Switch OFF -> forced reset -> codes refused -> reconnect -> ACTIVE. The
 * phone then said "Connected · Encrypted" / "This connection: Encrypted,
 * verified" over a pair on which NOBODY checked a code (the key was merely
 * pinned from an earlier pair), kept the red "codes didn't match" error from
 * the DEAD pair, and added "The switch applies to your next connection" —
 * which was false, because the switch had already reset the connection.
 *
 * ## The rules
 *
 *  * T1 — the label is the LIVE pair's truth ([liveState]), never the switch
 *    position and never a stored mode. From a switch flip made while a pair
 *    was up, until the next NEW ACTIVE pair, it is [Label.SWITCHING].
 *  * T2 — there is no "next connection" footer. The only footer is
 *    [View.footer]: the forced reset genuinely failed. Failure is (a) the
 *    relay refused the pref write (E2E_PREF_REFUSED op=set), or (b) no new
 *    ACTIVE pair within [RESET_TIMEOUT_MS] of the flip. Retry re-runs the pref
 *    write, plus a LEAVE_ACTIVE when (b) left the pre-flip pair standing.
 *  * T3 — a refusal belongs to ONE pairing id; it is cleared by a NEW active
 *    pair (a different pairing id) and by nothing else.
 *  * T4 — the code screen belongs to ONE pairing id; it goes the moment that
 *    pairing is no longer the one the service is waiting on, the socket is
 *    closed, or a different pair is active.
 *
 * A "new pair" is keyed on the pairing id this phone ACCEPTED
 * ([PhoneService.getActivePairKey]), not on PAIRING_ACTIVE edges: a relay
 * auto-resume re-sends PAIRING_ACTIVE for the SAME pair, and a late
 * PAIRING_ACTIVE for the pair whose codes were just refused must not clear
 * that refusal.
 */
class PhoneConnStatus(private val resetTimeoutMs: Long = RESET_TIMEOUT_MS) {

    enum class Label { CODES_CHECKED, NO_CODE_CHECK, STANDARD_TLS, SWITCHING }

    enum class Failure { WRITE_REFUSED, NO_NEW_PAIR }

    /** One tick's worth of facts, all read from the bound service on the same tick. */
    data class Obs(
        val nowMs: Long,
        val socketOpen: Boolean,
        val pairActive: Boolean,
        /** Pairing id of the pair this phone accepted last; meaningful while [pairActive]. */
        val pairKey: String?,
        val e2e: E2eStatusCopy.State,
        /** The pairing id the service's SAS gate is waiting on, or null. */
        val pendingSasPairingId: String?,
    )

    data class View(
        /** Null = no active pair and nothing switching: the caller's lobby / idle copy. */
        val label: Label?,
        val footer: Boolean,
        val refusal: String?,
        /** The code screen that may stay up, or null (take it down). */
        val sasPairingId: String?,
    )

    /** What Retry must do. [leaveOldPair] = end the pre-flip pair the reset failed to end. */
    data class RetryPlan(val on: Boolean, val leaveOldPair: Boolean)

    private data class Switch(val on: Boolean, val fromPairKey: String?, val startedAtMs: Long)

    private var switching: Switch? = null
    private var failure: Failure? = null
    private var failedSwitch: Switch? = null
    private var refusalPairId: String? = null
    private var refusalMessage: String? = null
    private var sasPairingId: String? = null

    /** The refusal currently owed to the user, for surfaces painted between ticks. */
    val currentRefusal: String? get() = refusalMessage

    val currentFailure: Failure? get() = failure

    /** True from a flip made during a pair until the next new pair, or failure. */
    val isSwitching: Boolean get() = switching != null

    /**
     * SET_E2E_PREF left the phone. [activePairKey] is the pair up at the flip,
     * or null when none was — then the server's reset has nothing to reconnect
     * and there is no transient (a "Couldn't switch" 60 s later would be a lie).
     */
    fun onSwitchSent(on: Boolean, activePairKey: String?, nowMs: Long) {
        failure = null
        failedSwitch = null
        switching = if (activePairKey != null) Switch(on, activePairKey, nowMs) else null
    }

    /** The relay refused the pref write (E2E_PREF_REFUSED op=set). */
    fun onSwitchWriteRefused() {
        val s = switching ?: return
        switching = null
        failure = Failure.WRITE_REFUSED
        failedSwitch = s
    }

    /** Null when there is no failure to retry. */
    fun retryPlan(obs: Obs): RetryPlan? {
        val f = failure ?: return null
        val s = failedSwitch ?: return null
        val oldPairStillUp = obs.pairActive && obs.pairKey != null && obs.pairKey == s.fromPairKey
        return RetryPlan(on = s.on, leaveOldPair = f == Failure.NO_NEW_PAIR && oldPairStillUp)
    }

    /** Retry's pref write was sent: back to "Switching…", same pre-flip pair. */
    fun onRetrySent(nowMs: Long) {
        val s = failedSwitch ?: return
        failure = null
        failedSwitch = null
        switching = Switch(s.on, s.fromPairKey, nowMs)
    }

    fun onRefused(pairingId: String?, message: String) {
        refusalPairId = pairingId
        refusalMessage = message
        if (pairingId == null || pairingId == sasPairingId) sasPairingId = null
    }

    fun onSasShown(pairingId: String) {
        sasPairingId = pairingId
    }

    fun onSasHidden() {
        sasPairingId = null
    }

    fun observe(obs: Obs): View {
        val newKey = if (obs.pairActive) obs.pairKey else null

        // T3 — only a DIFFERENT active pair clears a refusal.
        if (refusalMessage != null && newKey != null && newKey != refusalPairId) {
            refusalMessage = null
            refusalPairId = null
        }

        // T1/T2 — the transient ends on a new ACTIVE pair, or fails on the clock.
        switching?.let { s ->
            if (newKey != null && newKey != s.fromPairKey) {
                switching = null
            } else if (obs.nowMs - s.startedAtMs >= resetTimeoutMs) {
                switching = null
                failure = Failure.NO_NEW_PAIR
                failedSwitch = s
            }
        }
        // A failure is about the pair that was up at the flip; a new pair
        // negotiated from the stored pref makes it moot.
        if (failure != null && newKey != null && newKey != failedSwitch?.fromPairKey) {
            failure = null
            failedSwitch = null
        }

        // T4 — never a code screen for a dead pair.
        sasPairingId?.let { id ->
            val dead = !obs.socketOpen ||
                obs.pendingSasPairingId != id ||
                (newKey != null && newKey != id)
            if (dead) sasPairingId = null
        }

        val label = when {
            switching != null -> Label.SWITCHING
            obs.pairActive -> labelFor(obs.e2e)
            else -> null
        }
        return View(label, failure != null, refusalMessage, sasPairingId)
    }

    companion object {
        /**
         * (b) of T2. Chosen at 60 s: the reset closes the phone socket at once
         * and both ends re-dial within ~5 s, so a healthy switch is ACTIVE again
         * in well under 30 s; 60 s leaves room for a slow network and a Doze
         * wake without calling a working switch "failed".
         */
        const val RESET_TIMEOUT_MS = 60_000L

        /**
         * T1: the live pair's state. `verified` means THIS pair's codes were
         * checked, never "the key is pinned from before" — that was the bug.
         */
        @JvmStatic
        fun liveState(sessionPresent: Boolean, sasConfirmedThisPair: Boolean): E2eStatusCopy.State =
            E2eStatusCopy.stateOf(encrypted = sessionPresent, verified = sasConfirmedThisPair)

        @JvmStatic
        fun labelFor(state: E2eStatusCopy.State): Label = when (state) {
            E2eStatusCopy.State.ENCRYPTED_VERIFIED -> Label.CODES_CHECKED
            E2eStatusCopy.State.ENCRYPTED_UNVERIFIED -> Label.NO_CODE_CHECK
            E2eStatusCopy.State.PLAINTEXT -> Label.STANDARD_TLS
        }

        /** The hero status line for [label]. */
        @JvmStatic
        @StringRes
        fun statusLine(label: Label): Int = when (label) {
            Label.CODES_CHECKED -> R.string.status_connected_encrypted
            Label.NO_CODE_CHECK -> R.string.status_connected_encrypted_unverified
            Label.STANDARD_TLS -> R.string.status_connected_unencrypted
            Label.SWITCHING -> R.string.status_switching
        }

        /** The Encrypted-mode row's live line for [label]. */
        @JvmStatic
        @StringRes
        fun rowLine(label: Label): Int = when (label) {
            Label.CODES_CHECKED -> R.string.home_e2e_now_verified
            Label.NO_CODE_CHECK -> R.string.home_e2e_now_unverified
            Label.STANDARD_TLS -> R.string.home_e2e_now_plaintext
            Label.SWITCHING -> R.string.home_e2e_now_switching
        }
    }
}
