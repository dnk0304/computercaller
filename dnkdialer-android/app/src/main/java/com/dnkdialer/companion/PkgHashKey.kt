package com.dnkdialer.companion

import android.content.Context
import android.util.Base64
import androidx.core.content.edit

/**
 * vc70 sec C4 — the per-install secret behind [NotificationBackfill.pkgHash].
 *
 * An unsalted SHA-256 of a package name is reversible by anyone holding a
 * public package list: hash every Play package once and the DiagLog handle
 * names the user's bank. HMAC under 32 random bytes generated on first run
 * keeps the handle stable for the life of the install (log correlation
 * survives) while making that dictionary useless.
 *
 * The key lives only in this app's private SharedPreferences. It is never
 * logged, never exported and never sent; nothing outside [ForwardDiag] reads it.
 */
object PkgHashKey {
    private const val PREFS = "notif_hash_prefs"
    private const val KEY = "pkgHashKey"
    const val KEY_BYTES = 32

    @Volatile
    private var key: ByteArray? = null

    /** Called once from [CompanionApp.onCreate]. Idempotent; never fails startup. */
    @Synchronized
    fun init(context: Context) {
        if (key != null) return
        try {
            val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val stored = prefs.getString(KEY, null)
                ?.let { runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull() }
            key = if (stored != null && stored.size == KEY_BYTES) {
                stored
            } else {
                val fresh = ByteArray(KEY_BYTES).also { java.security.SecureRandom().nextBytes(it) }
                prefs.edit(commit = true) { putString(KEY, Base64.encodeToString(fresh, Base64.NO_WRAP)) }
                fresh
            }
        } catch (t: Throwable) {
            // Leave it null: ForwardDiag then prints "nokey" rather than falling
            // back to an unsalted (reversible) hash.
        }
    }

    /** The key, or null before [init] / if it failed. Never log the result. */
    fun get(): ByteArray? = key
}
