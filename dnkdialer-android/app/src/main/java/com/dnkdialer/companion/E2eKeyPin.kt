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
 * | a key is absent, revoked, or belongs to another device | [Verdict.Mismatch] | [Verdict.Mismatch] |
 * | the registry is unreachable | [Verdict.FailClosed] | [Verdict.FailOpenUnverified] |
 *
 * A **mismatch always refuses, in both modes.** §13.6 only softens the
 * *unreachable* case — a key that actively disagrees with the registry is the
 * substitution the pin exists to catch, and "the user had encryption switched
 * off" is not a reason to accept a device key that is demonstrably not the
 * one on record.
 */
object E2eKeyPin {

    /** Copy for a key that disagrees with the registry. */
    const val MISMATCH_MESSAGE = "Unexpected device key"

    /** Copy for mode ON when the registry could not be reached (§13.6). */
    const val FAIL_CLOSED_MESSAGE = "Couldn't verify this device — try again"

    sealed interface Verdict {
        /** Every advertised recipient key matches a live registry row. */
        data class Verified(val checked: Int) : Verdict

        /** A key disagrees with the registry. Refuse, in BOTH modes. */
        data class Mismatch(val userMessage: String, val logReason: String) : Verdict

        /** Registry unreachable, mode ON. Refuse. */
        data class FailClosed(val userMessage: String, val logReason: String) : Verdict

        /**
         * Registry unreachable, mode OFF. Proceed, log a warning, and the badge
         * stays UNVERIFIED — the pair must not present itself as verified when
         * nothing was verified.
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

        for (r in recipients) {
            val row = live[r.deviceId]
                ?: return Verdict.Mismatch(
                    MISMATCH_MESSAGE,
                    "recipient ${r.deviceId} (${r.kind}) has no live registry row" +
                        (if (rows.any { it.deviceId == r.deviceId }) " — its row is REVOKED" else "")
                )

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
        return Verdict.Verified(recipients.size)
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
