package com.dnkdialer.companion

/**
 * E2E programme P5b (d) — the contract between the TOFU key-change **UI** and
 * the Accept path. Constants only, for the same reason [E2eSasContract] is:
 * the UI lane ships and tests the entire user-facing half without editing
 * PhoneService.
 *
 * ## What the warning is
 *
 * The phone has paired with this computer before and is now being offered a
 * DIFFERENT key for it. M-C: the phone cannot tell a reinstall from a
 * substitution — the wire looks identical — so the copy lists the benign
 * causes without asserting one. It is the mirror of
 * [E2eLifecycle.REINSTALL_CAUSE_COPY], which is what the COMPUTER shows about
 * the PHONE.
 *
 * ## "One-time" is the service's job, not the UI's
 *
 * The prompt is raised once per changed key, not once per connection. Only
 * the Accept path knows whether this key has already been trusted, so it
 * decides whether to broadcast at all; the UI renders whatever it is asked to
 * render and reports the answer. Putting the "have we asked before?" memory
 * in the UI would mean the question stopped being asked whenever the Activity
 * was not running — which is most of the time.
 *
 * ## The two answers
 *
 * "Trust" pins the new key and continues. "Not now" does NOT pin it and does
 * NOT continue: it is a refusal, routed into the existing refusal path like
 * every other one. It is deliberately not called "Cancel" or "Later" — the
 * user is declining to trust a key, and the button should say so.
 *
 * Absent or unanswered must be read as NOT trusted. A key-change prompt that
 * defaults to trust on silence is a key-change prompt that does nothing.
 */
object E2eTofuContract {

    /**
     * Service → UI. "This computer's key changed; ask the user." Carries
     * [PhoneService.EXTRA_PAIRING_ID] and optionally [EXTRA_PEER_LABEL].
     */
    const val ACTION_E2E_KEY_CHANGED = "com.dnkdialer.companion.E2E_KEY_CHANGED"

    /**
     * UI → service. Carries [PhoneService.EXTRA_PAIRING_ID] and
     * [EXTRA_TRUSTED].
     */
    const val ACTION_E2E_KEY_CHANGE_RESULT = "com.dnkdialer.companion.E2E_KEY_CHANGE_RESULT"

    /** Human label for the computer, if known. Absent is fine; the copy works without it. */
    const val EXTRA_PEER_LABEL = "e2e_peer_label"

    /** true = "Trust", false = "Not now". Absent must be read as false. */
    const val EXTRA_TRUSTED = "e2e_trusted"

    /**
     * Service → UI. The pair's encryption state, for the status line and the
     * badge. Carries [EXTRA_ENCRYPTED] and [EXTRA_VERIFIED].
     *
     * Broadcast rather than read from PhoneService because `e2eVerified` and
     * the session are private fields with no accessor, and because the status
     * line must keep working when the Activity was not running at the moment
     * the pair was established.
     */
    const val ACTION_E2E_STATE = "com.dnkdialer.companion.E2E_STATE"

    /** Whether frames on this pair are sealed. */
    const val EXTRA_ENCRYPTED = "e2e_encrypted"

    /** Whether the SAS was confirmed. Encrypted-but-unverified is a real state. */
    const val EXTRA_VERIFIED = "e2e_verified"
}
