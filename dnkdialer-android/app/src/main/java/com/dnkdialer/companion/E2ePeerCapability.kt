package com.dnkdialer.companion

import android.content.Context

/**
 * E2E programme, phase P4 Part 1 (s5) — the seam between the Settings UI and
 * the pairing wire, with the wire end not yet built.
 *
 * The "Encrypted mode" toggle can only be offered once we know the paired
 * computer can actually do it. That fact arrives in the `e2e` block of P1's
 * PAIRING_REQUEST, which does not exist yet. Rather than let the UI guess,
 * this provider is an explicit STUB that always answers [UNKNOWN], so the
 * toggle ships greyed out with an honest reason.
 *
 * Part 2 replaces [current] with the real lookup (last-seen advertisement
 * from the paired computer, persisted alongside the pairing) and nothing in
 * SettingsActivity has to change. The enum is already the shape the real
 * answer takes, so the UI's three branches are the final three branches.
 *
 * UNKNOWN is deliberately NOT the same as [PEER_UNSUPPORTED]: "we have not
 * heard" must read as "waiting", never as "your computer can't" — the second
 * is a claim we would be making without evidence.
 */
object E2ePeerCapability {

    enum class State {
        /**
         * No advertisement seen yet — no computer has paired since this build,
         * or the wire does not carry the advertisement. ALWAYS returned in
         * Part 1. UI: toggle disabled, "waiting" copy.
         */
        UNKNOWN,

        /** The paired computer advertised the capability. UI: toggle enabled. */
        PEER_SUPPORTED,

        /** The paired computer is too old. UI: toggle disabled, "update" copy. */
        PEER_UNSUPPORTED,

        /**
         * This PHONE cannot do it — see [E2eKeyStore.capability]. Distinct
         * from the peer cases because the remedy is different and none of the
         * peer copy would be true.
         */
        DEVICE_UNSUPPORTED,
    }

    /**
     * Part 1 stub. Returns [State.DEVICE_UNSUPPORTED] when this phone itself
     * cannot hold an E2E key (that much IS knowable today — API 26-30 has no
     * Keystore key agreement), and [State.UNKNOWN] otherwise.
     *
     * It never returns [State.PEER_SUPPORTED] in Part 1, which is what keeps
     * the toggle inert: there is no crypto behind it yet, so it must not be
     * switchable.
     */
    fun current(ctx: Context): State {
        if (!E2eKeyStore.capability(ctx).isSupported) return State.DEVICE_UNSUPPORTED
        // TODO(P4 Part 2): read the last advertisement from the paired
        // computer's PAIRING_REQUEST `e2e` block instead of always UNKNOWN.
        return State.UNKNOWN
    }

    /** Whether the toggle may be operated at all. */
    fun isToggleEnabled(state: State): Boolean = state == State.PEER_SUPPORTED
}
