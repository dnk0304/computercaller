package com.dnkdialer.companion

import androidx.annotation.StringRes

/**
 * E2E programme P5b (d) — the one place that turns "is this pair encrypted?"
 * into words, for BOTH the in-app status line and the foreground
 * notification.
 *
 * One table, two surfaces, because the alternative is two tables that drift:
 * the in-app line saying "Encrypted" while the shade says "Connected to your
 * computer" is a contradiction the user has no way to resolve, and it is the
 * shade they see when the app is closed.
 *
 * ## Never colour-only (WCAG 1.4.1)
 *
 * The presence dot's tint is an accent, not the signal. Every state here has
 * a WORD, because a dot is invisible to a colour-blind user, absent from the
 * notification entirely, and unreadable in sunlight. [E2eCopyTableTest] and
 * the instrumented tests both assert on the text, never on the tint.
 *
 * ## Why "Not encrypted" is spelled out
 *
 * The unencrypted state could have been left as a bare "Connected" — and that
 * is exactly the reading that makes it dangerous. A plain "Connected" is what
 * a user sees and assumes is safe; the absence of a word is not a signal.
 * Naming both states is what makes either one informative.
 *
 * No "end-to-end" anywhere (P8-CLAIM-REVIEW): say "Encrypted".
 */
object E2eStatusCopy {

    /** What the user's connection actually is right now. */
    enum class State {
        /** Sealed, and the SAS was confirmed on both ends. */
        ENCRYPTED_VERIFIED,

        /** Sealed, but nobody confirmed a code. A real, distinct state. */
        ENCRYPTED_UNVERIFIED,

        /** Not sealed. */
        PLAINTEXT,
    }

    /**
     * Map the wire facts to a state.
     *
     * Takes two booleans rather than one tri-state because that is the shape
     * the Accept path already has ([E2eSettings.isSealed] and
     * [E2eKeyPin.isVerified]), and because "verified" without "encrypted" is
     * not a state that should be representable: a pair that is not sealed has
     * nothing to verify, so it collapses to PLAINTEXT rather than inventing a
     * fourth answer.
     */
    @JvmStatic
    fun stateOf(encrypted: Boolean, verified: Boolean): State = when {
        !encrypted -> State.PLAINTEXT
        verified -> State.ENCRYPTED_VERIFIED
        else -> State.ENCRYPTED_UNVERIFIED
    }

    /** The in-app connection status line, for an ACTIVE pair. */
    @JvmStatic
    @StringRes
    fun statusLine(state: State): Int = when (state) {
        // Verified and unverified share the in-app word deliberately: both
        // are encrypted, and the status line is not where the distinction is
        // actionable. The badge carries it.
        State.ENCRYPTED_VERIFIED, State.ENCRYPTED_UNVERIFIED -> R.string.status_connected_encrypted
        State.PLAINTEXT -> R.string.status_connected_unencrypted
    }

    /** The ongoing foreground-notification title, for an ACTIVE pair. */
    @JvmStatic
    @StringRes
    fun notificationText(state: State): Int = when (state) {
        State.ENCRYPTED_VERIFIED, State.ENCRYPTED_UNVERIFIED ->
            R.string.notif_ongoing_connected_encrypted
        // Unchanged from today. The shade's plaintext wording is the one the
        // user already knows, and P5b is not the place to renegotiate it.
        State.PLAINTEXT -> R.string.notif_ongoing_connected
    }
}
