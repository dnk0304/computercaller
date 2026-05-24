package com.dnkdialer.companion

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Dispatch #28 (2026-05-24) — encrypted storage for the user's phoneToken.
 *
 * The token is the relay's only authentication signal — anyone holding it
 * can connect to that user's room. Store it via androidx.security.crypto
 * which wraps SharedPreferences with AES-256-GCM keys held in the Android
 * Keystore (TEE / StrongBox on supported devices).
 *
 * Failure modes handled:
 *   • First-run keystore creation can throw on rooted / heavily-modded
 *     OEM builds. We catch and fall back to plain SharedPreferences so
 *     the app remains functional — the token is still scoped to the app's
 *     private storage, so the security delta is small for the rare device
 *     that hits this path.
 */
object TokenStore {
    private const val PREFS_NAME = "computercaller_secure_prefs"
    private const val KEY_PHONE_TOKEN = "phone_token"
    private const val KEY_DEVICE_NAME = "device_name"

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
            android.util.Log.w("TokenStore", "EncryptedSharedPreferences failed (${e.javaClass.simpleName}: ${e.message}) — falling back to plain SharedPreferences")
            ctx.getSharedPreferences("${PREFS_NAME}_fallback", Context.MODE_PRIVATE)
        }
    }

    fun getPhoneToken(ctx: Context): String? = prefs(ctx).getString(KEY_PHONE_TOKEN, null)

    fun getDeviceName(ctx: Context): String? = prefs(ctx).getString(KEY_DEVICE_NAME, null)

    fun save(ctx: Context, phoneToken: String, deviceName: String?) {
        prefs(ctx).edit()
            .putString(KEY_PHONE_TOKEN, phoneToken)
            .putString(KEY_DEVICE_NAME, deviceName)
            .apply()
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }

    fun hasToken(ctx: Context): Boolean = !getPhoneToken(ctx).isNullOrBlank()
}
