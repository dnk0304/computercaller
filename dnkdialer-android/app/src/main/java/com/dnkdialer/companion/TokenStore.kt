package com.dnkdialer.companion

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Dispatch #28 (2026-05-24) - encrypted storage for the user's phoneToken.
 *
 * The token is the relay's only authentication signal - anyone holding it
 * can connect to that user's room. Store it via androidx.security.crypto
 * which wraps SharedPreferences with AES-256-GCM keys held in the Android
 * Keystore (TEE / StrongBox on supported devices).
 *
 * Bundle C (2026-05-28) - Phase 4 audit fix M12.
 *
 * Previously this object caught Keystore failures and silently fell back to
 * plain SharedPreferences. That defeats the security goal of the wrapper:
 * the token would be readable by anyone with root or filesystem access on
 * the device, and the user has no signal that the protection level dropped.
 *
 * New behaviour: Keystore failure throws [EncryptedPrefsUnavailableException].
 * Read sites (PhoneService auto-dial path, MainActivity status check) treat
 * the exception as "no token saved" -> bounce to SignInActivity so the user
 * re-authenticates fresh. Write sites (SignInActivity post-login) treat it
 * as "cannot persist securely" -> surface a user-facing error rather than
 * silently storing plaintext.
 *
 * The fail-closed stance accepts that on rooted / heavily-modded OEM builds
 * the user may be unable to sign in at all. That is the correct trade-off
 * for a security-sensitive bearer token; the alternative was undetectable
 * downgrade.
 */
object TokenStore {
    private const val PREFS_NAME = "computercaller_secure_prefs"
    private const val KEY_PHONE_TOKEN = "phone_token"
    private const val KEY_DEVICE_NAME = "device_name"

    /**
     * E2E P4.4 / R-BH. The account id this phone's [KEY_PHONE_TOKEN] resolves
     * to, as the DeviceKey API reported it.
     *
     * It lives HERE, beside the token, for one reason: it is only ever true
     * *of that token*. Signing out or signing in to another account must not
     * leave a stale account id behind for the next session to derive keys
     * under, and putting it in the same encrypted prefs makes [clear] wipe both
     * in one act -- there is no second place to forget.
     */
    private const val KEY_USER_ID = "e2e_user_id"

    // Disconnect-from-lobby dispatch (v25, 2026-05-26). When true, the user
    // explicitly tapped "Disconnect from Lobby" in the app and we should
    // NOT auto-dial the relay on:
    //   - cold app launch (onStartCommand ACTION_START)
    //   - OS-driven service restart (START_STICKY after low-memory kill)
    //   - the 5s scheduleLobbyReconnect retry after an unintentional drop
    //   - the manual reconnectToRelay() helper
    // The user clears the flag by tapping "Rejoin Lobby" in the same UI
    // (PhoneService.userRejoinLobby), or implicitly by signing out - Sign
    // Out's existing TokenStore.clear() wipes everything including this key.
    private const val KEY_USER_STAYED_DISCONNECTED = "user_stayed_disconnected"

    /**
     * Thrown when the Android Keystore-backed EncryptedSharedPreferences
     * cannot be opened. Callers should treat the exception as "the token
     * store is not available right now" - read paths return as if no token
     * is set, write paths surface a user-facing error.
     */
    class EncryptedPrefsUnavailableException(cause: Throwable) :
        RuntimeException("EncryptedSharedPreferences unavailable", cause)

    private fun prefs(ctx: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                ctx,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            // Bundle C (2026-05-28) - audit M12 fail-closed. No plaintext
            // fallback. Log a single warning (no PII) and re-throw so the
            // caller can recover (typically by routing to SignInActivity).
            android.util.Log.w(
                "TokenStore",
                "EncryptedSharedPreferences unavailable (${e.javaClass.simpleName}) - fail-closed"
            )
            throw EncryptedPrefsUnavailableException(e)
        }
    }

    /**
     * Best-effort read of the encrypted prefs. If the Keystore is unavailable
     * (rooted device, hardware fault, OEM-modified ROM) returns null instead
     * of throwing - callers expect a nullable token and a null is
     * indistinguishable from "no token saved" for routing purposes (both
     * land on SignInActivity).
     */
    private fun safePrefs(ctx: Context): SharedPreferences? = try {
        prefs(ctx)
    } catch (e: EncryptedPrefsUnavailableException) {
        null
    }

    fun getPhoneToken(ctx: Context): String? = safePrefs(ctx)?.getString(KEY_PHONE_TOKEN, null)

    fun getDeviceName(ctx: Context): String? = safePrefs(ctx)?.getString(KEY_DEVICE_NAME, null)

    /**
     * The account id for SPEC 13.10.3's pairContext, or null.
     *
     * Null when it has never been learned, when the Keystore is unavailable, or
     * -- deliberately -- when a blank somehow reached the disk. A caller must
     * treat null as REFUSE, never as `""`: an empty account id is the value
     * that made every wrap this phone sealed unopenable on the page
     * (A6-P61B-8), and the JS side's frozen KDF module will not even represent
     * it.
     */
    fun getUserId(ctx: Context): String? =
        safePrefs(ctx)?.getString(KEY_USER_ID, null)?.takeIf { it.isNotBlank() }

    /** What [putUserId] did. */
    enum class UserIdWrite {
        /** There was nothing stored; the value is now stored. */
        STORED,

        /** Nothing to do: no value offered, or the same one is already stored. */
        UNCHANGED,

        /**
         * A DIFFERENT non-blank id is already stored and was NOT overwritten.
         * Persist-once: see [putUserId].
         */
        MISMATCH,

        /** The encrypted prefs could not be opened. Nothing was written. */
        UNAVAILABLE,
    }

    /**
     * Persist the account id ONCE.
     *
     * The rule is the same one M-A6-2 applies to the device key: a value the
     * peers' key schedules already depend on may not be replaced quietly. A
     * second, different id arriving for the same phoneToken is not a normal
     * event -- the token resolves to exactly one User row on the server -- so
     * it is either a server-side identity change or someone answering for it.
     * Either way, overwriting would silently re-key every pairing, and the only
     * trace would be that traffic stopped decrypting.
     *
     * So the stored value WINS, the new one is dropped, and the caller is told
     * [UserIdWrite.MISMATCH] so mode ON can fail closed. A legitimate change of
     * account goes through sign-out, which calls [clear] and takes the token
     * and the id together.
     *
     * A null or blank [userId] is never written. There is no state in which
     * storing `""` is better than storing nothing.
     *
     * A4-M5: the log line carries ids only -- no key material, no token.
     */
    fun putUserId(ctx: Context, userId: String?): UserIdWrite {
        val offered = userId?.takeIf { it.isNotBlank() } ?: return UserIdWrite.UNCHANGED
        val p = safePrefs(ctx) ?: return UserIdWrite.UNAVAILABLE
        val stored = p.getString(KEY_USER_ID, null)?.takeIf { it.isNotBlank() }
        if (stored == offered) return UserIdWrite.UNCHANGED
        if (stored != null) {
            android.util.Log.w(
                "TokenStore",
                "E2E_USERID_MISMATCH stored=$stored served=$offered - keeping the stored id; " +
                    "mode ON pairings fail closed until sign-out clears it"
            )
            return UserIdWrite.MISMATCH
        }
        p.edit().putString(KEY_USER_ID, offered).apply()
        return UserIdWrite.STORED
    }

    /**
     * Persist a new phoneToken. Throws [EncryptedPrefsUnavailableException]
     * if the Keystore can't be opened - SignInActivity should catch and
     * present a user-facing error rather than letting the sign-in flow
     * appear to succeed while the token is lost.
     */
    fun save(ctx: Context, phoneToken: String, deviceName: String?) {
        prefs(ctx).edit()
            .putString(KEY_PHONE_TOKEN, phoneToken)
            .putString(KEY_DEVICE_NAME, deviceName)
            .apply()
    }

    /**
     * Sign out. Wipes the whole prefs file, which is what makes the phoneToken
     * and the E2E account id ([KEY_USER_ID]) impossible to separate: a phone
     * that kept the id after signing out would, on the next login to a
     * DIFFERENT account, either derive under the old account's identity or hit
     * the [UserIdWrite.MISMATCH] refusal forever. Clearing both together is the
     * only state where neither can happen.
     */
    fun clear(ctx: Context) {
        // Clear is best-effort - if the prefs file can't be opened the
        // token effectively doesn't exist on disk anyway, so swallowing
        // the failure is correct.
        safePrefs(ctx)?.edit()?.clear()?.apply()
    }

    fun hasToken(ctx: Context): Boolean = !getPhoneToken(ctx).isNullOrBlank()

    /**
     * Disconnect-from-lobby dispatch (v25, 2026-05-26).
     *
     * Returns true if the user explicitly tapped "Disconnect from Lobby" and
     * has not yet tapped "Rejoin Lobby" (or signed out). PhoneService's
     * auto-dial paths check this and bail before opening the relay socket
     * when true, so a force-killed / cold-launched process honors the user's
     * intent without needing any in-memory state.
     */
    fun isUserStayedDisconnected(ctx: Context): Boolean =
        safePrefs(ctx)?.getBoolean(KEY_USER_STAYED_DISCONNECTED, false) ?: false

    /**
     * Set the stay-disconnected flag. Called from PhoneService.userDisconnectFromLobby
     * (true) and PhoneService.userRejoinLobby (false). Sign Out clears it
     * implicitly via TokenStore.clear() - no separate write needed.
     */
    fun setUserStayedDisconnected(ctx: Context, value: Boolean) {
        // Best-effort write. If the prefs are unavailable the user signs
        // in fresh next time anyway (no token -> SignInActivity bounce),
        // so a missing stay-disconnected flag is harmless.
        safePrefs(ctx)?.edit()?.putBoolean(KEY_USER_STAYED_DISCONNECTED, value)?.apply()
    }
}
