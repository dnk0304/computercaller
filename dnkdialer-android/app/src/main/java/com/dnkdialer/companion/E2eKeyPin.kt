package com.dnkdialer.companion

/**
 * E2E programme, phase P4 Part 2 (e) — pinning the advertised recipient keys
 * against the DeviceKey registry.
 *
 * ## The rule (E2E-SPEC §13.6, C-2 — FROZEN)
 *
 * > The P4(e) pin is a REST call on the Accept path, and **an unspecified
 * > failure mode gets implemented fail-open, at which point the pin is
 * > decorative.**
 * >
 * > - **Mode ON → fail CLOSED.** "Couldn't verify this device — try again." No pair.
 * > - **Mode OFF → fail OPEN.** The pair proceeds, a warning is logged
 * >   client-side, and the badge stays **unverified**.
 * >
 * > The registry is a *check*, never a second source of truth: the seal still
 * > goes only to keys advertised in the pairing frame.
 *
 * That last sentence is the one that shapes this file. [verify] returns a
 * verdict; it never returns keys, and nothing downstream may seal to a key that
 * came from the registry. If the registry could supply a key, a compromised
 * server could insert its own and the pin would be an attack surface rather
 * than a defence.
 *
 * ## The three outcomes, kept distinct
 *
 * A boolean would collapse them and this whole file would be decorative:
 *
 * | | mode ON | mode OFF |
 * |---|---|---|
 * | every key matches a live row | [Verdict.Verified] | [Verdict.Verified] |
 * | a key belongs to another device (substitution) | [Verdict.Mismatch] | [Verdict.Mismatch] |
 * | a key's row exists but is REVOKED | [Verdict.Mismatch] | [Verdict.Mismatch] |
 * | a key has NO registry row at all (unregistered) | [Verdict.FailClosed] | [Verdict.FailOpenUnverified] |
 * | the registry is unreachable | [Verdict.FailClosed] | [Verdict.FailOpenUnverified] |
 *
 * A **mismatch always refuses, in both modes.** §13.6 softens only the cases
 * where the registry gave us *no answer about this device*: unreachable, and
 * (INC-0923) a recipient with no row at all. A key that actively disagrees
 * with the registry — substituted, or belonging to a row that has been
 * REVOKED — is the attack the pin exists to catch, and "the user had
 * encryption switched off" is not a reason to accept it.
 *
 * ## INC-0923 — why "absent" is not "wrong"
 *
 * The extension's service worker registers its key best-effort and gives up
 * silently when it has no token (chrome-extension/background.js:392), so an
 * advertised-but-unregistered SW is a routine client-side failure, not
 * evidence of substitution. Treating it as [Verdict.Mismatch] made every
 * pairing hard-fail with "Unexpected device key" for a user whose SW row was
 * merely missing. Absent ⇒ we learned nothing ⇒ mode OFF proceeds
 * **UNVERIFIED** (never badged verified); mode ON still refuses.
 *
 * A row that exists and disagrees, or exists and is revoked, is a real answer
 * and stays a refusal in both modes. That split is the whole safety property:
 * revocation must remain unforgeable by deletion of knowledge.
 */
object E2eKeyPin {

    /** Copy for a key that disagrees with the registry. */
    const val MISMATCH_MESSAGE = "Unexpected device key"

    /** Copy for mode ON when the registry could not be reached (§13.6). */
    const val FAIL_CLOSED_MESSAGE = "Couldn't verify this device — try again"

    sealed interface Verdict {
        /** Every advertised recipient key matches a live registry row. */
        data class Verified(val checked: Int) : Verdict

        /**
         * A key disagrees with the registry — substituted, wrong kind, or its
         * row is REVOKED. Refuse, in BOTH modes.
         */
        data class Mismatch(val userMessage: String, val logReason: String) : Verdict

        /** No answer about this device (unreachable, or unregistered), mode ON. Refuse. */
        data class FailClosed(val userMessage: String, val logReason: String) : Verdict

        /**
         * No answer about this device (unreachable, or unregistered), mode OFF.
         * Proceed, log a warning, and the badge stays UNVERIFIED — the pair
         * must not present itself as verified when nothing was verified.
         */
        data class FailOpenUnverified(val logReason: String) : Verdict
    }

    /**
     * Pin [recipients] against [registry].
     *
     * @param registry the rows from `GET /api/devicekeys/list`, or a
     *        [E2eDeviceKeyClient.Result] failure. Passing the Result rather
     *        than a list is deliberate: the caller cannot accidentally turn an
     *        unreachable registry into an empty list, which would read as
     *        "every key is unknown" — a mismatch — and would make a network
     *        blip abort a mode-OFF pairing that §13.6 says must proceed.
     * @param modeOn the EFFECTIVE mode, which is the only thing that changes
     *        the unreachable case.
     */
    @JvmStatic
    fun verify(
        recipients: List<E2eNegotiation.Recipient>,
        registry: E2eDeviceKeyClient.Result<List<E2eDeviceKeyClient.DeviceKeyRow>>,
        modeOn: Boolean,
    ): Verdict {
        val rows = when (registry) {
            is E2eDeviceKeyClient.Result.Ok -> registry.value
            is E2eDeviceKeyClient.Result.PairingInFlight ->
                return unreachable(modeOn, "registry busy: a pairing handshake is in flight")
            is E2eDeviceKeyClient.Result.Forbidden ->
                return unreachable(modeOn, "registry refused the phone token: ${registry.message}")
            is E2eDeviceKeyClient.Result.Unavailable ->
                return unreachable(modeOn, "registry unreachable: ${registry.reason}")
        }

        if (recipients.isEmpty()) {
            return Verdict.Mismatch(MISMATCH_MESSAGE, "nothing to pin — no recipients advertised")
        }

        // Index only the LIVE rows. A revoked row must not satisfy a pin: N-4
        // rotates by inserting a new row and setting revokedAt on the old one,
        // so accepting a revoked key would trust a retired key forever — which
        // is the exact hole revocation exists to close.
        val live = rows.filter { !it.isRevoked }.associateBy { it.deviceId }

        // INC-0923. An UNREGISTERED recipient in mode OFF does not return here:
        // it is remembered and the loop keeps going. Returning early would let
        // one unregistered leg mask a SUBSTITUTED one later in the same set,
        // which would turn the softening into exactly the hole §13.6 warns
        // about. The soft verdict is only used if every other leg is clean.
        var unregistered: String? = null

        for (r in recipients) {
            val row = live[r.deviceId]
            if (row == null) {
                // A row that EXISTS but is revoked is a real answer from the
                // registry: this key was retired. That stays a refusal in both
                // modes — revocation must not be defeatable.
                if (rows.any { it.deviceId == r.deviceId }) {
                    return Verdict.Mismatch(
                        MISMATCH_MESSAGE,
                        "recipient ${r.deviceId} (${r.kind}) has no live registry row" +
                            " — its row is REVOKED"
                    )
                }
                val reason = "recipient ${r.deviceId} (${r.kind}) unregistered" +
                    " — no registry row at all"
                // Absent means the registry told us nothing about this device,
                // which is the same epistemic state as unreachable; §13.6's
                // split applies.
                if (modeOn) return Verdict.FailClosed(FAIL_CLOSED_MESSAGE, reason)
                if (unregistered == null) unregistered = reason
                continue
            }

            val registered = row.publicKeyBytes()
                ?: return Verdict.Mismatch(
                    MISMATCH_MESSAGE,
                    "registry row for ${r.deviceId} holds an unusable public key"
                )

            if (!registered.contentEquals(r.publicKey)) {
                return Verdict.Mismatch(
                    MISMATCH_MESSAGE,
                    "recipient ${r.deviceId} (${r.kind}) advertised a key that is NOT the one " +
                        "on record — this is the substitution the pin exists to catch"
                )
            }

            // The extension's service worker is a recipient whose code the user
            // never sees, so it is the leg an attacker would swap; §13.6 names
            // kind='extension' explicitly. Checking the kind stops a row
            // registered as 'web' from satisfying an 'extension' recipient.
            if (row.kind != r.kind) {
                return Verdict.Mismatch(
                    MISMATCH_MESSAGE,
                    "recipient ${r.deviceId} advertised kind '${r.kind}' but the registry " +
                        "records it as '${row.kind}'"
                )
            }
        }
        return unregistered?.let {
            Verdict.FailOpenUnverified("$it; proceeding UNVERIFIED (encrypted mode off)")
        } ?: Verdict.Verified(recipients.size)
    }

    private fun unreachable(modeOn: Boolean, reason: String): Verdict =
        if (modeOn) {
            Verdict.FailClosed(FAIL_CLOSED_MESSAGE, reason)
        } else {
            Verdict.FailOpenUnverified(reason)
        }

    /** True when the pairing may proceed under [verdict]. */
    @JvmStatic
    fun mayProceed(verdict: Verdict): Boolean =
        verdict is Verdict.Verified || verdict is Verdict.FailOpenUnverified

    /**
     * True when the pair may present itself as VERIFIED.
     *
     * Separate from [mayProceed] on purpose: a fail-open pairing proceeds but
     * must never claim verification, and one method returning both answers is
     * how "proceeded" quietly becomes "verified" at a call site.
     */
    @JvmStatic
    fun isVerified(verdict: Verdict): Boolean = verdict is Verdict.Verified
}
