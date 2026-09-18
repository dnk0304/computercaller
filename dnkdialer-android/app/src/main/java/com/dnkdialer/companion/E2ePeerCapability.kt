package com.dnkdialer.companion

import android.content.Context

/**
 * E2E programme, phase P4.1 — the real answer to "may the Encrypted mode
 * toggle be operated?".
 *
 * ## What P4 Part 1 left behind, and why it was a blocker
 *
 * Part 1 shipped this as an explicit STUB that always answered [State.UNKNOWN]
 * because the wire end did not exist yet. P5b then built the whole Settings
 * row on top of it — and proved the enabled branch with a test-only override,
 * because the stub could not reach it. The consequence was invisible in every
 * green test and fatal in production: **the toggle could never enable on a
 * real device**, so v58 would have shipped a control that no user could ever
 * switch on. The tests were not wrong; they were testing the override.
 *
 * This file is that stub replaced by the real read.
 *
 * ## The rule (E2E-SPEC-v1.0 §12, opt-in)
 *
 * Peer support means exactly one thing: the computer advertised
 * `e2e { v: 1, … }` in its PAIRING_REQUEST with at least one recipient of kind
 * `web` or `extension`. [E2eNegotiation.parsePeerOffer] is the only thing that
 * decides whether a block parsed; [E2eSettings.recordFor] is the only thing
 * that decides whether what parsed counts as support. Nothing here re-reads a
 * frame.
 *
 * ## Why it is persisted rather than read off the socket
 *
 * The Settings screen is almost never open while a PAIRING_REQUEST arrives.
 * The user pairs, then goes looking for the toggle — minutes later, usually
 * after the process has been killed and restarted. An answer that needed a
 * live socket would grey the control out at exactly the moment the user came
 * to find it, and "greyed out with a waiting message" is indistinguishable, to
 * them, from the Part 1 bug this phase exists to fix. So the last
 * advertisement is written to [E2eSettings] at PAIRING_REQUEST, keyed by
 * phoneDeviceId + peerDeviceId, and survives process death.
 *
 * ## Why [State.UNKNOWN] is not [State.PEER_UNSUPPORTED]
 *
 * "We have not heard" must read as waiting, never as "your computer can't".
 * The second is a claim about the peer, and we would be making it from the
 * absence of evidence rather than from evidence of absence. Every failure path
 * in here — no pairing, an unreadable record, a record written under a retired
 * device identity, a record version this build does not speak — lands on
 * UNKNOWN for that reason. Only a peer that actually paired and actually
 * offered nothing usable earns PEER_UNSUPPORTED.
 */
object E2ePeerCapability {

    enum class State {
        /**
         * Nothing is paired or pending, so no advertisement can exist yet —
         * the state the brief calls NO_PEER. Also the fail-soft landing for a
         * record this build cannot read (see the class doc). UI: toggle
         * disabled, "waiting" copy.
         */
        UNKNOWN,

        /** The paired computer advertised the capability. UI: toggle enabled. */
        PEER_SUPPORTED,

        /**
         * A computer paired and offered no usable `e2e` block — absent, a
         * version we do not speak, or no web/extension recipient. UI: toggle
         * disabled, "update your computer" copy.
         */
        PEER_UNSUPPORTED,

        /**
         * This PHONE cannot do it — see [E2eKeyStore.capability]. Distinct
         * from the peer cases because the remedy is different and none of the
         * peer copy would be true.
         */
        DEVICE_UNSUPPORTED,
    }

    /**
     * The whole decision, as a pure function of the two facts it depends on.
     *
     * Split out from [current] so the rule is unit-testable on the JVM without
     * a Context, a Keystore or an emulator. P4 Part 1's stub could not be
     * tested at all — it had one branch — and that is part of why the gap
     * survived a green gate.
     *
     * The device check comes FIRST: a phone that cannot hold an E2E key cannot
     * encrypt no matter what the computer advertised, and telling the user to
     * update their computer would send them to fix the wrong machine.
     */
    @JvmStatic
    fun evaluate(
        deviceSupported: Boolean,
        record: E2eSettings.PeerAdvertisementRecord?,
    ): State = when {
        !deviceSupported -> State.DEVICE_UNSUPPORTED
        record == null -> State.UNKNOWN
        record.supported -> State.PEER_SUPPORTED
        else -> State.PEER_UNSUPPORTED
    }

    /**
     * The real read: this phone's own capability, plus the last advertisement
     * persisted for the currently paired or pending computer.
     *
     * Both halves are cheap (a Keystore capability probe and one
     * SharedPreferences read), so this is safe to call from
     * `SettingsActivity.onResume`.
     */
    fun current(ctx: Context): State = evaluate(
        deviceSupported = E2eKeyStore.capability(ctx).isSupported,
        record = E2eSettings.currentPeerAdvertisement(ctx),
    )

    /** Whether the toggle may be operated at all. */
    fun isToggleEnabled(state: State): Boolean = state == State.PEER_SUPPORTED
}
