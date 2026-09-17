package com.dnkdialer.companion

/**
 * E2E programme P5b (c) — the contract between the SAS **UI** and the Accept
 * path, and nothing else.
 *
 * Constants only. No crypto, no decision, no I/O: the whole point of this file
 * is that the UI lane can ship the entire user-facing half of the SAS confirm
 * — the hero face, the copy, the a11y, the blocking behaviour, the tests —
 * without editing PhoneService, and that Forge's remaining change is two call
 * sites against a contract that is already written down and already exercised
 * by instrumented tests driving these exact broadcasts.
 *
 * ## The flow
 *
 * 1. The user taps Accept. PhoneService decides as it does today
 *    ([E2eNegotiation.decide]) and, when the decision is
 *    [E2eNegotiation.Decision.Encrypted] with `modeOn = true` — i.e.
 *    [E2eSettings.requiresSas] over the effective mode — it has the SAS digits
 *    in hand (`prepared.sasDigits`, today only logged).
 *
 * 2. Instead of completing, it broadcasts [ACTION_E2E_SAS_REQUIRED] with
 *    [EXTRA_SAS_DIGITS] and waits.
 *
 * 3. The user answers on the hero card. MainActivity broadcasts
 *    [ACTION_E2E_SAS_RESULT] with [EXTRA_SAS_MATCHED].
 *
 * 4. `true` → complete the Accept exactly as today.
 *    `false` → take the **existing** refusal path, unchanged: latch the
 *    downgrade, `broadcastE2eRefusal(...)`. No new refusal logic is written
 *    for the SAS; "the user says the codes differ" is the same outcome as
 *    "the peer could not give us an encrypted pairing", and it must not get a
 *    second, subtly different implementation.
 *
 * ## Why a broadcast rather than a callback
 *
 * The same one MainActivity and the shade notification already converge on
 * (see [ConnectionRequestReceiver]): the decision must survive the Activity
 * being absent, and a service holding a reference to an Activity to call back
 * into is the leak the v56 rewrite removed. Registration is
 * `RECEIVER_NOT_EXPORTED`, like every other pairing receiver here, so no other
 * process can answer the SAS on the user's behalf — which would be the whole
 * ballgame.
 *
 * ## If nobody answers
 *
 * A SAS with no answer must FAIL CLOSED. The Accept is already bounded by the
 * 30 s auto-decline that guards every pairing request, and an unanswered SAS
 * must land there rather than completing: a verification nobody performed is
 * not a verification, and completing on silence would make the whole prompt
 * decorative.
 */
object E2eSasContract {

    /**
     * Service → UI. "Show the user these digits and ask." Carries
     * [PhoneService.EXTRA_PAIRING_ID] and [EXTRA_SAS_DIGITS].
     */
    const val ACTION_E2E_SAS_REQUIRED = "com.dnkdialer.companion.E2E_SAS_REQUIRED"

    /**
     * UI → service. The user's answer. Carries
     * [PhoneService.EXTRA_PAIRING_ID] and [EXTRA_SAS_MATCHED].
     */
    const val ACTION_E2E_SAS_RESULT = "com.dnkdialer.companion.E2E_SAS_RESULT"

    /** The six decimal digits from §13.3, as a string (leading zeros matter). */
    const val EXTRA_SAS_DIGITS = "e2e_sas_digits"

    /** true = "Matches", false = "Doesn't match". Absent must be read as false. */
    const val EXTRA_SAS_MATCHED = "e2e_sas_matched"

    /** §13.3 — six decimal digits, so the UI can reject a malformed payload. */
    const val SAS_DIGIT_COUNT = 6

    /**
     * Group the digits for display and for TalkBack: "412908" → "412 908".
     *
     * One function, used for BOTH the visible text and the spoken description,
     * so the two can never drift — and because an ungrouped run of six digits
     * is read out as "four hundred twelve thousand nine hundred and eight",
     * which cannot be checked against a screen. Grouping is what makes the
     * code confirmable, so it is part of the security feature and not styling.
     *
     * Returns the input unchanged when it is not exactly six digits; the
     * caller is expected to have refused such a payload already.
     */
    @JvmStatic
    fun group(digits: String): String =
        if (digits.length == SAS_DIGIT_COUNT && digits.all { it.isDigit() }) {
            "${digits.substring(0, 3)} ${digits.substring(3)}"
        } else {
            digits
        }

    /** True when [digits] is a well-formed SAS per §13.3. */
    @JvmStatic
    fun isWellFormed(digits: String?): Boolean =
        digits != null && digits.length == SAS_DIGIT_COUNT && digits.all { it.isDigit() }
}
