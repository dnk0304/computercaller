package com.dnkdialer.companion

import android.content.Context
import androidx.core.content.edit

/**
 * E2E programme, phase P4 Part 1 (s4) — the "Encrypted mode" setting and the
 * pure logic that turns two devices' settings into one pair's effective mode.
 *
 * NO WIRE. Nothing here reads or writes a frame; [effectiveMode] is a pure
 * function and [PeerAdvertisement] is produced by Part 2 from P1's
 * PAIRING_REQUEST `e2e` block. This file exists so that the decision table is
 * frozen, tested and reviewable BEFORE any crypto lands on top of it.
 *
 * ## C-1 — setting semantics (E2E-PLAN v2.1; AUDIT-SECURITY-v2 C-1)
 *
 * The setting is **per-DEVICE** and **stored locally**. It is never read back
 * from the server as truth. AUDIT-SECURITY-v2 C-1 struck the contradictory
 * "per-account" wording: a phone's stored preference is the phone's, full
 * stop, and the server never gets a vote on whether this device wants
 * encryption. The server is not trusted to answer that question — it is the
 * party the mode exists to exclude.
 *
 * ## The OR rule, and why rows 8–10 resolve the way they do
 *
 * The effective mode of a pair is the **OR** of the two sides. If EITHER
 * device has it ON, the SAS is blocking on BOTH and the pair is
 * Encrypted (verified). This is not a new rule — it is what the frozen
 * modeByte already says ("0x01 if either side advertises ON"), so the
 * transcript was always right and only the prose was wrong.
 *
 * A computer is two devices (web + extension SW) behind one peer: it
 * advertises the OR of its own two local settings. That is row 10.
 *
 * OR rather than AND because the alternative is indefensible: under AND, a
 * user who switched encryption ON would silently pair in plaintext because
 * the *other* end was left OFF — "device has mode ON, pair completes in
 * plaintext", the shape the audit brief calls a BLOCKER.
 *
 * Mapped to the AUDIT-SECURITY-v2 matrix:
 *
 * | row | phone | computer          | outcome                        |
 * |-----|-------|-------------------|--------------------------------|
 * |  1  | ON    | ON                | ENCRYPTED_VERIFIED (SAS both)  |
 * |  4  | OFF   | OFF               | ENCRYPTED_UNVERIFIED (no SAS)  |
 * |  3  | ON    | no `e2e` block    | ABORT — "update your computer" |
 * |  5  | OFF   | no `e2e` block    | PLAINTEXT + Unencrypted badge  |
 * |  8  | ON    | OFF               | ENCRYPTED_VERIFIED  (OR)       |
 * |  9  | OFF   | ON                | ENCRYPTED_VERIFIED  (OR)       |
 * | 10  | ON    | web OFF, ext ON   | ENCRYPTED_VERIFIED  (OR of OR) |
 *
 * Rows 8–10 were left *undefined* by the original spec; C-1 defines them and
 * [effectiveMode] is where that definition lives on the Android side.
 *
 * The result is latched at Accept (B6) — Part 2 wires that. Local
 * enforcement at Accept is the real control; the relay and the DeviceKey
 * registry are defence-in-depth only and are never the source of truth.
 */
object E2eSettings {

    /**
     * Plain SharedPreferences, deliberately NOT [TokenStore]'s
     * EncryptedSharedPreferences. This is a user preference, not a secret:
     * nothing is protected by keeping "does this user want encryption" off
     * disk, and putting it behind the Keystore would mean the setting became
     * unreadable exactly when the Keystore is unavailable — i.e. it would
     * fail OPEN into plaintext on the devices most likely to be compromised.
     * A separate prefs file keeps it out of TokenStore.clear()'s blast radius
     * so signing out does not silently turn the user's encryption off.
     */
    private const val PREFS_NAME = "computercaller_e2e_prefs"

    private const val KEY_ENCRYPTED_MODE = "encrypted_mode"

    /** Default OFF: encrypted mode ships dark and the user opts in. */
    const val DEFAULT_ENCRYPTED_MODE = false

    /** What the peer said about encryption in its PAIRING_REQUEST. */
    enum class PeerAdvertisement {
        /** Peer advertised encrypted mode ON. */
        ON,

        /** Peer advertised the capability, with its own setting OFF. */
        OFF,

        /**
         * No `e2e` block at all — an old computer that predates the feature.
         * Distinct from [OFF] on purpose: OFF is a capable peer that chose
         * not to, ABSENT cannot encrypt at any price. Collapsing the two
         * would silently downgrade a mode-ON user (matrix rows 3 and 5).
         */
        ABSENT,
    }

    /** The effective mode of one pair, decided locally at Accept. */
    enum class EffectiveMode {
        /** Sealed, and the SAS is BLOCKING on both ends. Badge: Encrypted (verified). */
        ENCRYPTED_VERIFIED,

        /** Sealed, no SAS shown. Badge: Encrypted (unverified). */
        ENCRYPTED_UNVERIFIED,

        /** Not sealed. Badge: Unencrypted + "update your computer". */
        PLAINTEXT,

        /**
         * Refuse the pairing. Reached only when THIS device wants encryption
         * and the peer cannot provide it — never silently downgraded.
         */
        ABORT,
    }

    // --------------------------------------------------------- pure logic

    /**
     * The whole decision table, as a pure function. No Context, no I/O, no
     * frame — so it is unit-testable on the JVM and so the rule can be
     * reviewed without reading the networking code.
     *
     * @param localEnabled   this device's stored setting
     * @param peer           what the peer advertised
     */
    @JvmStatic
    fun effectiveMode(localEnabled: Boolean, peer: PeerAdvertisement): EffectiveMode =
        when (peer) {
            // A peer that cannot encrypt at all. If we asked for encryption we
            // refuse rather than downgrade; if we did not, we pair in the clear
            // and say so in the badge.
            PeerAdvertisement.ABSENT ->
                if (localEnabled) EffectiveMode.ABORT else EffectiveMode.PLAINTEXT

            // Both ends capable: seal either way. The OR decides only whether
            // the SAS is blocking, i.e. verified vs unverified.
            PeerAdvertisement.ON -> EffectiveMode.ENCRYPTED_VERIFIED
            PeerAdvertisement.OFF ->
                if (localEnabled) {
                    EffectiveMode.ENCRYPTED_VERIFIED       // rows 8 / 10
                } else {
                    EffectiveMode.ENCRYPTED_UNVERIFIED     // row 4
                }
        }

    /**
     * What a multi-device peer advertises: the OR of its own local settings.
     * A computer is web + extension SW behind one peer identity, so it
     * advertises ON when EITHER is ON (matrix row 10).
     *
     * Present on the phone because the phone must be able to reproduce the
     * peer's advertisement when it recomputes the SAS transcript; the phone
     * itself is a single device and always passes one value.
     *
     * An empty list means "no capable sub-device" = [PeerAdvertisement.ABSENT],
     * NOT OFF — see the note on [PeerAdvertisement.ABSENT].
     */
    @JvmStatic
    fun advertisementOf(subDeviceSettings: List<Boolean>): PeerAdvertisement = when {
        subDeviceSettings.isEmpty() -> PeerAdvertisement.ABSENT
        subDeviceSettings.any { it } -> PeerAdvertisement.ON
        else -> PeerAdvertisement.OFF
    }

    /** True when the effective mode requires the user to confirm a SAS. */
    @JvmStatic
    fun requiresSas(mode: EffectiveMode): Boolean = mode == EffectiveMode.ENCRYPTED_VERIFIED

    /** True when frames are sealed under this mode. */
    @JvmStatic
    fun isSealed(mode: EffectiveMode): Boolean =
        mode == EffectiveMode.ENCRYPTED_VERIFIED || mode == EffectiveMode.ENCRYPTED_UNVERIFIED

    // ------------------------------------------------------------- storage

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** This device's stored "Encrypted mode" preference. Local truth (C-1). */
    fun isEncryptedModeEnabled(ctx: Context): Boolean =
        prefs(ctx).getBoolean(KEY_ENCRYPTED_MODE, DEFAULT_ENCRYPTED_MODE)

    /**
     * Set this device's preference. Applies to the NEXT pairing: an existing
     * pair's mode is latched at Accept (B6) and never changes underneath a
     * live session, because a mode that could flip mid-pair is a downgrade
     * channel.
     */
    fun setEncryptedModeEnabled(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit { putBoolean(KEY_ENCRYPTED_MODE, enabled) }
    }
}
