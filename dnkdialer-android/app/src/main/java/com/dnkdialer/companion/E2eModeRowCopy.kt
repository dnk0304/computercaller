package com.dnkdialer.companion

import androidx.annotation.StringRes

/**
 * vc63 (T-VC63-MAIN-SCREEN) — the Encrypted-mode row's copy table, as a pure
 * function.
 *
 * The row now exists on TWO screens (Settings and Home). Two painters would
 * be two tables, and two tables drift: Home saying "ready" while Settings
 * says "waiting" is a contradiction the user has no way to resolve, and the
 * one that drifts is always the one nobody opened while testing. So the rule
 * lives here, once, with no Context and no View — which also means it is
 * unit-testable on the JVM, where [E2eModeRowCopyTest] walks every state.
 *
 * [E2eModeRowBinder] is the thin Android half that applies a [RowCopy] to a
 * real switch; this file decides WHAT to say, that file decides where to put
 * it.
 *
 * ## Two different facts, deliberately not merged (E2E-SPEC-v1.0 §12, §13.1)
 *
 * The switch is the user's INTENT for the NEXT connection. The mode of the
 * LIVE pair is a separate fact, latched at Accept, that this switch cannot
 * change. INC-0923 was exactly this confusion, so the two are modelled as two
 * functions here rather than as one blended answer:
 *
 *  * [forState] — capability + stored preference -> what the control looks
 *    like and why it is or is not operable. This is the not-paired answer and
 *    is what Settings has always shown.
 *  * [liveModeLine] + [switchAgreesWithLiveMode] — what the CURRENT pair
 *    actually is, and whether it disagrees with the switch. Shown only while
 *    a pair is active, because "this connection" is meaningless without one.
 *
 * Never the words "end-to-end" for an unverified pair (§12.6); the strings
 * are pinned by [E2eCopyTableTest].
 */
object E2eModeRowCopy {

    /**
     * The dim applied to a disabled row. The switch tints are a custom colour
     * selector with no disabled state, so a disabled switch is pixel-identical
     * to an enabled one that is merely off; the dimmed row IS the disabled
     * affordance. Named here so Home and Settings cannot pick two values.
     */
    const val DIMMED_ALPHA = 0.45f

    const val FULL_ALPHA = 1f

    /** Everything a painter needs, and nothing it has to decide for itself. */
    data class RowCopy(
        val enabled: Boolean,
        val checked: Boolean,
        @StringRes val reasonRes: Int,
        val alpha: Float,
    )

    /**
     * The capability answer: may the control be operated, is it on, and why.
     *
     * [checked] is ANDed with [enabled] on purpose. A stored `true` under a
     * capability state that forbids the mode would otherwise render a switch
     * that is on and inert — a claim that the next connection will be
     * encrypted, made by a control the user cannot turn off.
     */
    @JvmStatic
    fun forState(state: E2ePeerCapability.State, checkedPref: Boolean): RowCopy {
        val enabled = E2ePeerCapability.isToggleEnabled(state)
        return RowCopy(
            enabled = enabled,
            checked = enabled && checkedPref,
            reasonRes = when (state) {
                E2ePeerCapability.State.UNKNOWN -> R.string.settings_encrypted_mode_waiting
                E2ePeerCapability.State.PEER_UNSUPPORTED -> R.string.settings_encrypted_mode_peer_old
                E2ePeerCapability.State.DEVICE_UNSUPPORTED -> R.string.settings_encrypted_mode_device_old
                E2ePeerCapability.State.PEER_SUPPORTED -> R.string.settings_encrypted_mode_ready
            },
            alpha = if (enabled) FULL_ALPHA else DIMMED_ALPHA,
        )
    }

    /**
     * The reason line shown immediately after the user flips the switch.
     *
     * Separate from [forState] because it is an answer to an ACTION, not a
     * repaint of a state: the capability copy is still true, but it is not
     * what the user just asked about.
     */
    @JvmStatic
    @StringRes
    fun afterFlipLine(checked: Boolean): Int =
        if (checked) R.string.settings_encrypted_mode_on_next_pair
        else R.string.settings_encrypted_mode_off_next_pair

    /**
     * What the LIVE pair actually is, in words.
     *
     * Not derived from the switch. The switch says what the user wants next;
     * this says what they have now, and the whole point of showing it next to
     * the switch is that the two can legitimately differ.
     */
    @JvmStatic
    @StringRes
    fun liveModeLine(mode: E2eStatusCopy.State): Int = when (mode) {
        E2eStatusCopy.State.ENCRYPTED_VERIFIED -> R.string.home_e2e_now_verified
        E2eStatusCopy.State.ENCRYPTED_UNVERIFIED -> R.string.home_e2e_now_unverified
        E2eStatusCopy.State.PLAINTEXT -> R.string.home_e2e_now_plaintext
    }

    /**
     * True when the switch's intent already matches the live pair, i.e. there
     * is nothing to warn about.
     *
     * The switch ON means "encrypted AND verified on the next connection" —
     * that is what [E2eSettings.effectiveMode] produces from a local ON, and
     * it is what the on-next-pair copy promises ("you'll confirm a code").
     * So ENCRYPTED_VERIFIED is the only live mode an ON switch agrees with,
     * and the two unverified/plaintext modes are the only ones an OFF switch
     * agrees with. Anything else earns the next-connection caveat.
     */
    @JvmStatic
    fun switchAgreesWithLiveMode(switchOn: Boolean, mode: E2eStatusCopy.State): Boolean =
        switchOn == (mode == E2eStatusCopy.State.ENCRYPTED_VERIFIED)
}
