package com.dnkdialer.companion

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import java.security.SecureRandom

/**
 * E2E programme, phase P4 Part 2 (f) — key lifecycle: the device id, rotation
 * on Reset and sign-out, and the reinstall case.
 *
 * ## §13.8, the table this file implements
 *
 * | event | what happens to keys |
 * |---|---|
 * | Accept | fresh SK, `pairEpoch` bumped, dedupe window reset — that is (d) |
 * | Reset lobby / LEAVE_ACTIVE | SK dropped both sides |
 * | Sign-out | SK dropped; device key deleted; `DeviceKey.revokedAt` set |
 * | Key rotation | mints a NEW `deviceId`; the old row gets `revokedAt` (N-4) |
 *
 * ## The deviceId, and why rotation mints a new one
 *
 * `publicKey` is immutable per `(userId, deviceId)`. So a rotation cannot reuse
 * the id — it mints a new one, and the old row is revoked rather than updated.
 * An in-place update would erase the evidence that a substitution happened,
 * which is the only trace a user or an auditor would ever have.
 *
 * The id is a random 128-bit value in its own prefs file, matching P1's
 * `DEVICE_ID_PATTERN` (`[A-Za-z0-9_-]{1,128}`). It is an IDENTIFIER, not a
 * credential: the phone's `phoneToken` authenticates, the id only names.
 *
 * ## Reinstall is indistinguishable from a new device — and that is correct
 *
 * An uninstall takes the prefs and the Keystore keys with it. After a
 * reinstall, the phone has a new deviceId and a new device key, so the computer
 * sees a key it has never seen for an id it has never seen and shows its TOFU
 * warning. That warning is CORRECT — the computer genuinely cannot tell a
 * reinstall from a substitution, and pretending otherwise would mean accepting
 * a new key silently, which is the attack.
 *
 * What we can do is give the user the benign explanation alongside it, which is
 * what [REINSTALL_CAUSE_COPY] is for (M-C). It is deliberately phrased as *a*
 * cause, not *the* cause: telling the user "this is just a reinstall" when we
 * cannot know that would train them to click through a real attack.
 */
object E2eLifecycle {

    private const val TAG = "E2eLifecycle"

    /**
     * GATE1 Addendum A5, MUST M-A5-2 — the process-lifetime forward-jump
     * refusal counter, and the reason it lives HERE.
     *
     * [E2eDedupe] is rebuilt on every pairEpoch change (E2eSession.forPhone
     * constructs a new window per epoch), so a counter held by the window would
     * be zeroed by an epoch change — and an epoch change is something an
     * attacker can provoke. The vector file's `counterRule`: a counter an
     * attacker can zero is not a counter. This object is the owner that
     * survives epochs, so the counter hangs here and each window increments it.
     *
     * The web lane keeps the same property with a closure that outlives
     * `reset()`; the SW lane counts on its drops record rather than on the
     * per-epoch window. Three lanes, one rule.
     */
    val forwardJumpCounter = E2eDedupe.ForwardJumpCounter()

    /**
     * Total forward-jump refusals since process start. Exported the way
     * `droppedTotal` is, because §13.5 makes observability the deliverable.
     */
    val refusedForwardJump: Long get() = forwardJumpCounter.value

    private const val PREFS = "computercaller_e2e_identity"
    private const val KEY_DEVICE_ID = "device_id"

    /** Bytes of randomness in a device id. */
    private const val DEVICE_ID_BYTES = 16

    /**
     * Copy the computer shows beside its TOFU warning (M-C). Lists the benign
     * causes WITHOUT asserting one — the computer cannot distinguish them, and
     * a confident "this is just a reinstall" would train users through a real
     * substitution.
     */
    const val REINSTALL_CAUSE_COPY =
        "This phone is using a new key. That happens after reinstalling the app, " +
            "resetting the phone, or signing out and back in. If none of those apply, " +
            "check the code on both devices before continuing."

    /** This device's stable id, generated on first use. */
    @JvmStatic
    fun deviceId(ctx: Context): String {
        val p = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.getString(KEY_DEVICE_ID, null)?.let { return it }
        val fresh = newDeviceId()
        // commit = true, not the default apply(): the id is about to be
        // published to the registry, and an id that reached the server but not
        // the disk would orphan the row. The ktx `edit` overload takes the flag,
        // so this stays synchronous AND satisfies the UseKtx lint rule.
        p.edit(commit = true) { putString(KEY_DEVICE_ID, fresh) }
        if (BuildConfig.DEBUG) Log.d(TAG, "minted a device id")
        return fresh
    }

    /** True when this device has never minted an id (fresh install / post-wipe). */
    @JvmStatic
    fun hasDeviceId(ctx: Context): Boolean =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .contains(KEY_DEVICE_ID)

    private fun newDeviceId(): String =
        E2eKeyEncoding.toBase64Url(
            ByteArray(DEVICE_ID_BYTES).also { SecureRandom().nextBytes(it) }
        )

    /** What a lifecycle call actually did, so the caller can report honestly. */
    data class Outcome(
        val sessionClosed: Boolean,
        val countersCleared: Boolean,
        val deviceKeyRotated: Boolean,
        val newDeviceId: String?,
        /** Null when no revoke was attempted; otherwise whether it succeeded. */
        val remoteRevokeOk: Boolean?,
        val notes: List<String>,
    )

    /**
     * Reset lobby / LEAVE_ACTIVE: **SK dropped, device key KEPT.**
     *
     * The device key survives on purpose. Rotating it here would invalidate
     * every other pairing and force the user to re-verify each one, for an
     * event that is not a compromise — leaving a room is not losing a key.
     */
    @JvmStatic
    fun onPairEnded(session: E2eSession?): Outcome {
        val kid = session?.kid
        session?.close()
        return Outcome(
            sessionClosed = session != null,
            countersCleared = false,
            deviceKeyRotated = false,
            newDeviceId = null,
            remoteRevokeOk = null,
            notes = listOfNotNull(
                kid?.let { "SK dropped for kid=$it" },
                "device key kept — leaving a room is not losing a key",
            ),
        )
    }

    /**
     * Sign-out: SK dropped, device key DELETED, and the registry row revoked.
     *
     * The local delete happens whether or not the remote revoke succeeds. The
     * two failure modes are not symmetric: a key deleted locally but still
     * live in the registry is a stale row that the next `register` supersedes
     * (N-4), whereas a key kept locally after the user asked to sign out is the
     * thing they explicitly asked us not to do.
     *
     * @param phoneToken the token to revoke with, or null to skip the remote
     *        call (already signed out, or offline).
     * @param revoker injected so the unit suite can drive every branch without
     *        a network.
     */
    @JvmStatic
    @JvmOverloads
    fun onSignOut(
        ctx: Context,
        session: E2eSession?,
        deviceId: String?,
        phoneToken: String?,
        revoker: (String, String) -> E2eDeviceKeyClient.Result<*> = { t, d ->
            E2eDeviceKeyClient.revoke(t, d)
        },
    ): Outcome {
        val notes = ArrayList<String>()
        session?.close()

        // Revoke FIRST, while the token is still valid — after the local delete
        // we would be asking the server to revoke a key we can no longer prove
        // we hold.
        var revokeOk: Boolean? = null
        if (phoneToken != null && deviceId != null) {
            revokeOk = when (val r = runCatching { revoker(phoneToken, deviceId) }.getOrNull()) {
                is E2eDeviceKeyClient.Result.Ok<*> -> { notes.add("registry row revoked"); true }
                null -> { notes.add("revoke threw; continuing with the local delete"); false }
                else -> { notes.add("revoke failed ($r); the next register supersedes the row"); false }
            }
        } else {
            notes.add("no token or deviceId — skipped the remote revoke")
        }

        E2eKeyAgreement.rotateDeviceKey(ctx)   // delete + regenerate
        E2eKeyStore.clearAll()                  // and remove any other generation
        E2eSeqStore.clearAll(ctx)
        clearDeviceId(ctx)
        notes.add("device key deleted, counters cleared, device id dropped")

        return Outcome(
            sessionClosed = session != null,
            countersCleared = true,
            deviceKeyRotated = true,
            newDeviceId = null, // minted lazily on the next sign-in
            remoteRevokeOk = revokeOk,
            notes = notes,
        )
    }

    /**
     * Explicit key rotation — the user's "this device is compromised" escape
     * hatch, and the `2^32 frames / 30 days` rekey of §13.8.
     *
     * Mints a NEW deviceId, because `publicKey` is immutable per
     * `(userId, deviceId)` and reusing the id would mean updating a key in
     * place — which erases the evidence of the substitution.
     *
     * Every pairing that pinned the old key must re-verify. That is the point.
     */
    @JvmStatic
    @JvmOverloads
    fun rotateDeviceKey(
        ctx: Context,
        session: E2eSession?,
        oldDeviceId: String?,
        phoneToken: String?,
        revoker: (String, String) -> E2eDeviceKeyClient.Result<*> = { t, d ->
            E2eDeviceKeyClient.revoke(t, d)
        },
    ): Outcome {
        val notes = ArrayList<String>()
        session?.close()

        var revokeOk: Boolean? = null
        if (phoneToken != null && oldDeviceId != null) {
            revokeOk = runCatching { revoker(phoneToken, oldDeviceId) }.getOrNull()
                .let { it is E2eDeviceKeyClient.Result.Ok<*> }
            notes.add(if (revokeOk) "old row revoked (N-4)" else "old row not revoked remotely")
        }

        E2eKeyAgreement.rotateDeviceKey(ctx)
        E2eSeqStore.clearAll(ctx)
        val fresh = mintNewDeviceId(ctx)
        notes.add("new deviceId minted — publicKey is immutable per (userId, deviceId)")

        return Outcome(
            sessionClosed = session != null,
            countersCleared = true,
            deviceKeyRotated = true,
            newDeviceId = fresh,
            remoteRevokeOk = revokeOk,
            notes = notes,
        )
    }

    private fun mintNewDeviceId(ctx: Context): String {
        val fresh = newDeviceId()
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit(commit = true) { putString(KEY_DEVICE_ID, fresh) }
        return fresh
    }

    private fun clearDeviceId(ctx: Context) {
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit { clear() }
    }
}
