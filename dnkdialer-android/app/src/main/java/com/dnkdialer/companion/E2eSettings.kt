package com.dnkdialer.companion

import android.content.Context
import androidx.core.content.edit
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

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

    /**
     * INC-0924 — "did a HUMAN ever flip this switch?".
     *
     * Deliberately a NEW key rather than a value inside the old one: the whole
     * point is to distinguish a preference this build can prove the user set
     * from one that merely exists on disk, and a `true` written by an earlier
     * build carries no such proof. An absent marker therefore reads as "not by
     * a user", which is exactly what makes the one-time reset below safe.
     *
     * `_v2` because a first attempt at this key would have shipped with the
     * broken switch still masking the value; the suffix means a device that
     * somehow carries the old name is not read as consent.
     */
    private const val KEY_ENCRYPTED_MODE_USER_SET = "encrypted_mode_user_set_v2"

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
        // INC-0924: the marker is written on EVERY flip, on or off, because it
        // records that a human operated the control — not which way. Writing it
        // only on `true` would leave a user who deliberately turned the mode
        // OFF indistinguishable from one who never touched it, and the next
        // migration of this preference would then be free to overwrite their
        // choice. Same transaction as the value: a marker that could be lost
        // separately from the value it describes is not a marker.
        prefs(ctx).edit {
            putBoolean(KEY_ENCRYPTED_MODE, enabled)
            putBoolean(KEY_ENCRYPTED_MODE_USER_SET, true)
        }
    }

    /** True once the user has operated the Encrypted-mode switch on this device. */
    fun isEncryptedModeUserSet(ctx: Context): Boolean =
        prefs(ctx).getBoolean(KEY_ENCRYPTED_MODE_USER_SET, false)

    // -------------------------------------------- INC-0924 one-time migration

    /** What [migrateLegacyEncryptedModePref] should do, as a pure function. */
    enum class LegacyPrefMigration {
        /** Leave the stored preference exactly as it is. */
        NONE,

        /** A stored ON that no user is known to have asked for. Reset to OFF. */
        RESET_TO_OFF,
    }

    /**
     * INC-0924 — the decision, with no Context so it is pinned by vectors.
     *
     * Until this incident `E2eModeRowCopy.forState` ANDed the drawn state of
     * the switch with the capability, so a stored `true` rendered as an OFF,
     * greyed switch while `decide()` read the raw `true` and forced a
     * SAS-blocking pair. Dennis's phone was in exactly that state: the value
     * went ON during the v62/v63 attempts, survived every upgrade, and no
     * screen has shown it since.
     *
     * With the switch fixed to show the truth, that stored `true` would simply
     * start rendering as ON — accurate, but still not a setting he chose while
     * the feature ships dark by spec (§12, default OFF). So a value this build
     * cannot attribute to a human is reset ONCE, and the user who wants it
     * flips it again with the switch that now works.
     *
     * A reset is never applied to a value carrying the marker: the marker is
     * consent, and a migration that overwrites consent is a bug with a
     * changelog entry.
     */
    @JvmStatic
    fun legacyPrefMigration(enabled: Boolean, userSet: Boolean): LegacyPrefMigration =
        if (enabled && !userSet) LegacyPrefMigration.RESET_TO_OFF else LegacyPrefMigration.NONE

    /**
     * Apply [legacyPrefMigration] to this device's store. Returns true when the
     * preference was reset, so the caller can log and repaint exactly once.
     *
     * Committed synchronously: the whole value of this call is that the NEXT
     * `decide()` in this process reads the corrected value, and an `apply()`
     * that had not flushed when the service was killed would leave the
     * incident live on the next boot.
     *
     * Idempotent by construction — after a reset `enabled` is false, so a
     * second call decides NONE. The marker is deliberately NOT set: the user
     * still has not made a choice, and claiming they did would suppress a
     * future migration that has every right to run.
     */
    fun migrateLegacyEncryptedModePref(ctx: Context): Boolean {
        val decision = legacyPrefMigration(
            isEncryptedModeEnabled(ctx),
            isEncryptedModeUserSet(ctx),
        )
        if (decision != LegacyPrefMigration.RESET_TO_OFF) return false
        prefs(ctx).edit(commit = true) { putBoolean(KEY_ENCRYPTED_MODE, false) }
        return true
    }

    // ------------------------------------------ P4.1: peer advertisement

    /**
     * Record shape version. Bumped whenever [PeerAdvertisementRecord]'s fields
     * change. A record carrying any other `v` is read as ABSENT rather than
     * guessed at — see [decodePeerAdvertisement].
     */
    const val PEER_ADVERTISEMENT_RECORD_VERSION = 1

    /**
     * The `peerDeviceId` stored when the peer advertised nothing usable. A
     * peer with no recipients has no canonical deviceId to key on, but the
     * FACT that it paired without a usable block is exactly what
     * [E2ePeerCapability.State.PEER_UNSUPPORTED] is made of, so the record
     * must still exist. A real device id is 16 random bytes base64url (22
     * chars) and is never one character, so this sentinel cannot collide.
     */
    const val NO_PEER_DEVICE_ID = "-"

    /**
     * The last advertisement seen from one computer, for one phone identity.
     *
     * Persisted because the Settings screen must answer "can this pair
     * encrypt?" after process death, with no socket open — which is the normal
     * case: the user opens Settings minutes after pairing, from a cold start.
     * A live-socket-only answer would grey the toggle out exactly when the
     * user went looking for it.
     *
     * Keyed by phoneDeviceId AND peerDeviceId: the phone half means a device
     * key rotation (E2eLifecycle) invalidates every stored advertisement for
     * free, because an advertisement learned under a retired identity says
     * nothing about the current one.
     */
    data class PeerAdvertisementRecord(
        val phoneDeviceId: String,
        val peerDeviceId: String,
        val pairingId: String,
        /**
         * True iff the peer's `e2e` block parsed at v:1 AND carried at least
         * one recipient of kind `web` or `extension`. This is the whole
         * definition of "the computer can encrypt" (E2E-SPEC-v1.0 §12).
         */
        val supported: Boolean,
        /** The recipient kinds seen, for logs and for future Settings copy. */
        val kinds: List<String>,
        /** Why nothing usable was on offer. Null when [supported]. */
        val absentReason: String?,
    )

    // ------------------------------------------------- pure record logic

    /**
     * Turn a parsed offer into the record to persist. Pure: no Context, no
     * disk, so the "what counts as supported" rule is unit-testable without a
     * device.
     *
     * The kind check is re-asserted here rather than inherited from
     * [E2eNegotiation.parsePeerOffer]'s validation. The parser is strict today,
     * but this is the rule the toggle's reachability hangs on, and a rule that
     * lives in exactly one place two files away is a rule that gets relaxed by
     * someone who never reads this one.
     */
    @JvmStatic
    fun recordFor(
        phoneDeviceId: String,
        pairingId: String,
        offer: E2eNegotiation.PeerOffer,
    ): PeerAdvertisementRecord {
        val usable = offer.recipients.filter { it.kind in E2eNegotiation.RECIPIENT_KINDS }
        val supported =
            offer.advertisement != PeerAdvertisement.ABSENT && usable.isNotEmpty()
        return PeerAdvertisementRecord(
            phoneDeviceId = phoneDeviceId,
            peerDeviceId = if (usable.isEmpty()) {
                NO_PEER_DEVICE_ID
            } else {
                E2ePairIdentity.canonicalPeerDeviceId(usable.map { it.deviceId })
            },
            pairingId = pairingId,
            supported = supported,
            kinds = usable.map { it.kind }.distinct().sorted(),
            absentReason = if (supported) {
                null
            } else {
                offer.absentReason ?: "no recipient of kind web|extension"
            },
        )
    }

    /** Serialise a record. Pure. */
    @JvmStatic
    fun encodePeerAdvertisement(r: PeerAdvertisementRecord): String {
        val o = JsonObject()
        o.addProperty("v", PEER_ADVERTISEMENT_RECORD_VERSION)
        o.addProperty("phoneDeviceId", r.phoneDeviceId)
        o.addProperty("peerDeviceId", r.peerDeviceId)
        o.addProperty("pairingId", r.pairingId)
        o.addProperty("supported", r.supported)
        val kinds = JsonArray()
        for (k in r.kinds) kinds.add(k)
        o.add("kinds", kinds)
        r.absentReason?.let { o.addProperty("absentReason", it) }
        return o.toString()
    }

    /**
     * Deserialise a record. Returns null for anything this build cannot read:
     * absent, malformed, or a `v` it does not speak.
     *
     * The unknown-version guard fails to [E2ePeerCapability.State.UNKNOWN]
     * ("we have not heard"), never to PEER_UNSUPPORTED. A future build that
     * writes v:2 and is then downgraded must not make this build tell the user
     * their computer is too old — that is a claim about the PEER made from
     * evidence about OURSELVES.
     */
    @JvmStatic
    fun decodePeerAdvertisement(raw: String?): PeerAdvertisementRecord? {
        if (raw.isNullOrBlank()) return null
        val o = runCatching { JsonParser.parseString(raw).asJsonObject }.getOrNull() ?: return null
        val v = runCatching { o.get("v")?.asInt }.getOrNull() ?: return null
        if (v != PEER_ADVERTISEMENT_RECORD_VERSION) return null
        val phone = runCatching { o.get("phoneDeviceId")?.asString }.getOrNull() ?: return null
        val peer = runCatching { o.get("peerDeviceId")?.asString }.getOrNull() ?: return null
        val pairingId = runCatching { o.get("pairingId")?.asString }.getOrNull() ?: return null
        val supported = runCatching { o.get("supported")?.asBoolean }.getOrNull() ?: return null
        val kinds = runCatching {
            o.getAsJsonArray("kinds")?.mapNotNull { it.asString } ?: emptyList()
        }.getOrNull() ?: emptyList()
        return PeerAdvertisementRecord(
            phoneDeviceId = phone,
            peerDeviceId = peer,
            pairingId = pairingId,
            supported = supported,
            kinds = kinds,
            absentReason = runCatching { o.get("absentReason")?.asString }.getOrNull(),
        )
    }

    // ---------------------------------------------------- record storage

    private const val KEY_PEER_ADV_CURRENT = "peer_adv_current"

    private fun peerAdvKey(phoneDeviceId: String, peerDeviceId: String) =
        "peer_adv:$phoneDeviceId:$peerDeviceId"

    /**
     * Persist what the peer just advertised, and point "current" at it.
     *
     * Called on PAIRING_REQUEST (the pending computer) and re-asserted on
     * PAIRING_ACTIVE. Committed synchronously: the process can be killed
     * between the frame and the next Settings open, and an apply() that never
     * flushed would lose exactly the fact this record exists to survive.
     */
    fun recordPeerAdvertisement(
        ctx: Context,
        pairingId: String,
        offer: E2eNegotiation.PeerOffer,
    ): PeerAdvertisementRecord {
        val record = recordFor(E2eLifecycle.deviceId(ctx), pairingId, offer)
        val key = peerAdvKey(record.phoneDeviceId, record.peerDeviceId)
        prefs(ctx).edit(commit = true) {
            putString(key, encodePeerAdvertisement(record))
            putString(KEY_PEER_ADV_CURRENT, key)
        }
        return record
    }

    /**
     * The advertisement of the currently paired/pending computer, or null when
     * nothing is paired or pending.
     *
     * Null is also the answer when the stored record belongs to a RETIRED
     * phone device id: the identity that learned it no longer exists, so the
     * only honest answer is "we have not heard".
     */
    fun currentPeerAdvertisement(ctx: Context): PeerAdvertisementRecord? {
        val p = prefs(ctx)
        val key = p.getString(KEY_PEER_ADV_CURRENT, null) ?: return null
        val record = decodePeerAdvertisement(p.getString(key, null)) ?: return null
        // Reading through E2eLifecycle.deviceId() would MINT an id on a device
        // that has never paired; hasDeviceId keeps this read side-effect free.
        if (!E2eLifecycle.hasDeviceId(ctx)) return null
        return if (record.phoneDeviceId == E2eLifecycle.deviceId(ctx)) record else null
    }

    /**
     * Forget the current computer's advertisement. Called when the pair ends
     * (RESET_ROOM, PAIRING_TERMINATED, PAIRING_CANCELLED, lobby disconnect,
     * sign-out).
     *
     * The record goes, not just the pointer: a stale record left addressable
     * would come back the next time a pointer happened to name that key, and
     * "the toggle turned itself on again after I unpaired" is the exact bug
     * the clear exists to prevent.
     */
    fun clearPeerAdvertisementFor(ctx: Context, pairingId: String, reason: String) {
        val current = currentPeerAdvertisement(ctx) ?: return
        // Only the record this pairing wrote. A cancelled or declined REQUEST
        // must not erase what a different, already-active computer advertised
        // — the phone can have an active pair and a pending request at once,
        // and an unconditional clear here would grey the toggle out on the
        // live pair because some other browser gave up.
        if (current.pairingId != pairingId) return
        clearPeerAdvertisement(ctx, reason)
    }

    fun clearPeerAdvertisement(ctx: Context, reason: String) {
        val p = prefs(ctx)
        val key = p.getString(KEY_PEER_ADV_CURRENT, null) ?: return
        p.edit(commit = true) {
            remove(key)
            remove(KEY_PEER_ADV_CURRENT)
        }
        android.util.Log.d("E2eSettings", "peer advertisement cleared ($reason)")
    }
}

