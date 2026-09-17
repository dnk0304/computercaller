package com.dnkdialer.companion

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/**
 * E2E programme, phase P4 Part 2 (c2) — the durable AEAD sequence counter.
 *
 * GATE1 Addendum A1, item 3, third rule, quoted in full because this file
 * exists only to satisfy it:
 *
 * > **Persist-before-emit, and fail closed.** The counter MUST be durably
 * > committed before the frame it authorises leaves the device. If a device
 * > starts and cannot prove its counter is strictly beyond every value it has
 * > used (restore from backup, cleared storage, corrupt state), it MUST refuse
 * > to encrypt and force a rekey — never resume at a guess, never restart at 0.
 * > **This is the single most likely way this design gets broken in the field**:
 * > an Android restore-from-backup replaying counters silently.
 *
 * A1 also names it a **P4 acceptance criterion with an explicit
 * restore-from-backup test** — see `E2eSeqStoreTest.restore_from_backup_fails_closed`.
 *
 * ## Why a repeated sequence is catastrophic, not merely wrong
 *
 * The nonce is `sessionPrefix ‖ be64(seq)`. Reuse a `seq` under the same key and
 * you reuse a GCM nonce, which does not corrupt one frame — it leaks the
 * XOR of two plaintexts *and* the GHASH authentication key, giving an attacker
 * forgery for every other frame under that key. There is no partial failure
 * mode to degrade into. Hence: refuse.
 *
 * ## How "prove the counter is beyond every value used" is actually proved
 *
 * Not by trusting the stored number. A restored `SharedPreferences` file
 * contains a perfectly well-formed, perfectly stale number, and nothing about
 * the number itself reveals that.
 *
 * The record is sealed with AES-256-GCM under an **AndroidKeyStore** key. A
 * Keystore key is hardware-bound: it is never included in a backup and does not
 * survive a restore onto another device or a Keystore reset. So after a restore
 * the prefs come back and the wrapping key does not, the GCM tag check fails,
 * and [reserve] refuses. The proof is the tag, not the integer.
 *
 * The record also binds its own `kid`, so a record belonging to a different key
 * id cannot be presented for this one.
 *
 * ## Reservation windows — persist-before-emit without a disk write per frame
 *
 * A synchronous commit per notification would be unusable. Instead the store
 * durably reserves a WINDOW of [WINDOW] sequences and hands them out from
 * memory. The invariant is the one that matters:
 *
 *   **the persisted high-water mark is always >= every sequence ever handed out**
 *
 * so a crash, a kill or a battery pull can only make the next boot SKIP
 * sequences, never repeat one. Skipping is free (the dedupe window §13.5 keys
 * on the sequence but tolerates gaps; only a duplicate is a problem). Repeating
 * is fatal. The window trades a bounded number of wasted sequence values —
 * which are 2^63 deep and rekeyed at 2^32 per §13.8 — for one disk write per
 * [WINDOW] frames.
 *
 * `commit()` is used rather than `apply()` deliberately: `apply()` is
 * asynchronous, so a frame could leave the device before its reservation
 * reached disk, which is precisely the rule being implemented.
 */
class E2eSeqStore private constructor(
    private val ctx: Context,
    val kid: String,
    val direction: E2eEnvelope.Direction,
    /**
     * Per-(kid,direction) nonce prefix, DERIVED from the session key by
     * [E2eKdf.deriveNoncePrefixes] — ratified by GATE1 Addendum A2 (2026-09-17).
     *
     * **This prefix contributes ZERO nonce uniqueness.** A2 struck A1's
     * "defence in depth against a state-restore bug" rationale: the prefix is a
     * deterministic function of SK and pairEpoch, so a device that restores a
     * stale counter re-derives exactly the same prefix. Uniqueness rests
     * entirely on [reserve]'s persist-before-emit / fail-closed counter, which
     * A2 upgraded from an acceptance criterion to the SOLE control.
     *
     * A2 MUST (2): it is derived on every session construction and **never
     * persisted** — a stored prefix is stale state that can survive a restore.
     * It is therefore absent from [Record]; see [open].
     */
    val sessionPrefix: ByteArray,
    private var reservedThrough: Long,
    private var next: Long,
) {

    /**
     * Thrown when the counter cannot be proved safe. The caller MUST NOT
     * encrypt; it must force a rekey (a fresh Accept mints a new kid and a new
     * key, which is what makes starting at 0 legitimate again).
     */
    class CounterUnsafeException(message: String) : RuntimeException(message)

    companion object {
        private const val TAG = "E2eSeqStore"
        private const val PREFS = "computercaller_e2e_seq"
        private const val WRAP_ALIAS = "cc-e2e-seq-v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val RECORD_VERSION = 2

        /** Sequences reserved per durable write. */
        const val WINDOW = 64L

        private const val GCM_TAG_BITS = 128
        private const val GCM_IV_BYTES = 12

        private fun prefs(ctx: Context) =
            ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun recordKey(kid: String, d: E2eEnvelope.Direction) = "rec_${d.name}_$kid"

        /**
         * Open the counter for ([kid], [direction]).
         *
         * @param freshEpoch true when this call follows an Accept that minted a
         *        NEW kid. Only then may a counter legitimately start at 0 — and
         *        only then, because the KEY is new, so a repeated sequence is
         *        under a different key and therefore a different nonce space.
         * @throws CounterUnsafeException the stored record is missing, stale,
         *         unreadable or for another kid, and [freshEpoch] is false.
         */
        @JvmStatic
        fun open(
            ctx: Context,
            kid: String,
            direction: E2eEnvelope.Direction,
            freshEpoch: Boolean,
            /**
             * The nonce prefix for this (kid, direction), from
             * [E2eKdf.deriveNoncePrefixes]. Derived rather than random so the
             * peer can reconstruct it without a wire field that does not exist
             * — see that function for the full reasoning and the flag.
             *
             * A2 MUST (2): this value is used on a RESUME too. The record does
             * NOT store a prefix — re-deriving is not merely equivalent, it is
             * the rule, because a persisted prefix is exactly the stale state a
             * restore can carry forward. The derivation is deterministic in SK
             * and pairEpoch, so a legitimate resume reproduces the same four
             * bytes the already-emitted frames used.
             */
            noncePrefix: ByteArray,
        ): E2eSeqStore {
            if (noncePrefix.size != E2eEnvelope.SESSION_PREFIX_BYTES) {
                throw CounterUnsafeException(
                    "nonce prefix must be ${E2eEnvelope.SESSION_PREFIX_BYTES} bytes, " +
                        "got ${noncePrefix.size}"
                )
            }
            val p = prefs(ctx)
            val blob = p.getString(recordKey(kid, direction), null)

            if (blob == null) {
                if (!freshEpoch) {
                    // Cleared storage, or a pair we are resuming with no record.
                    // We cannot prove we have not already used sequences under
                    // this key, so we refuse. A1: never resume at a guess.
                    throw CounterUnsafeException(
                        "no sequence record for kid=$kid/$direction and this is not a fresh " +
                            "epoch — refusing to encrypt; force a rekey"
                    )
                }
                val store = E2eSeqStore(ctx, kid, direction, noncePrefix.copyOf(), 0, 0)
                store.persist(WINDOW) // reserve BEFORE anything can be emitted
                return store
            }

            val rec = try {
                unseal(blob)
            } catch (e: java.security.GeneralSecurityException) {
                // The Keystore wrapping key is gone: restore-from-backup onto a
                // new device, a Keystore reset, or a corrupt record. All three
                // mean the same thing — we cannot prove the counter.
                throw CounterUnsafeException(
                    "sequence record for kid=$kid/$direction does not authenticate " +
                        "(restore-from-backup, Keystore reset, or corruption) — " +
                        "refusing to encrypt; force a rekey"
                )
            } catch (e: IllegalArgumentException) {
                throw CounterUnsafeException(
                    "sequence record for kid=$kid/$direction is malformed — " +
                        "refusing to encrypt; force a rekey"
                )
            }

            if (rec.version != RECORD_VERSION) {
                throw CounterUnsafeException(
                    "sequence record is v${rec.version}, this build understands " +
                        "v$RECORD_VERSION — refusing to encrypt; force a rekey"
                )
            }
            if (rec.kid != kid || rec.direction != direction.name) {
                throw CounterUnsafeException(
                    "sequence record is for ${rec.kid}/${rec.direction}, not $kid/$direction " +
                        "— refusing to encrypt; force a rekey"
                )
            }
            // Resume STRICTLY BEYOND the persisted high-water mark. Everything
            // below it may already have been emitted, so none of it is reusable.
            return E2eSeqStore(
                ctx, kid, direction, noncePrefix.copyOf(),
                rec.reservedThrough, rec.reservedThrough
            )
        }

        /** Drop the record for a pair. Called on Reset / sign-out (§13.8). */
        @JvmStatic
        fun clear(ctx: Context, kid: String) {
            prefs(ctx).edit {
                for (d in E2eEnvelope.Direction.entries) remove(recordKey(kid, d))
            }
        }

        /** Drop EVERY counter record. Sign-out / full reset. */
        @JvmStatic
        fun clearAll(ctx: Context) {
            prefs(ctx).edit { clear() }
        }

        private data class Record(
            val version: Int,
            val kid: String,
            val direction: String,
            val reservedThrough: Long,
        )

        private fun seal(rec: Record): String {
            // No prefix field: A2 MUST (2) forbids persisting it.
            val body = "${rec.version}\u0000${rec.kid}\u0000${rec.direction}\u0000" +
                "${rec.reservedThrough}"
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, wrappingKey())
            val ct = c.doFinal(body.toByteArray(Charsets.UTF_8))
            return E2eKeyEncoding.toBase64Url(c.iv) + "." + E2eKeyEncoding.toBase64Url(ct)
        }

        private fun unseal(blob: String): Record {
            val parts = blob.split(".")
            require(parts.size == 2) { "sequence record is not iv.ct" }
            val iv = E2eKeyEncoding.fromBase64Url(parts[0])
            require(iv.size == GCM_IV_BYTES) { "sequence record IV is ${iv.size} bytes" }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            val fields = String(c.doFinal(E2eKeyEncoding.fromBase64Url(parts[1])), Charsets.UTF_8)
                .split("\u0000")
            require(fields.size == 4) { "sequence record has ${fields.size} fields" }
            return Record(
                version = fields[0].toInt(),
                kid = fields[1],
                direction = fields[2],
                reservedThrough = fields[3].toLong(),
            )
        }

        /**
         * The AES key that seals the record. Hardware-bound and therefore NOT
         * restorable from a backup — which is the whole mechanism by which a
         * restored counter is detected rather than trusted.
         */
        private fun wrappingKey(): javax.crypto.SecretKey {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            (ks.getKey(WRAP_ALIAS, null) as? javax.crypto.SecretKey)?.let { return it }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            gen.init(
                KeyGenParameterSpec.Builder(
                    WRAP_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
            return gen.generateKey()
        }

        /**
         * TEST ONLY. Simulates a restore-from-backup: the prefs survive, the
         * hardware-bound Keystore key does not. Deleting the alias is exactly
         * what a restore onto a new device looks like from the app's side, and
         * it is the only way to exercise the fail-closed path without two
         * physical devices.
         */
        @androidx.annotation.VisibleForTesting
        @JvmStatic
        fun simulateRestoreFromBackup() {
            try {
                KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                    .deleteEntry(WRAP_ALIAS)
            } catch (e: java.security.GeneralSecurityException) {
                Log.w(TAG, "simulateRestoreFromBackup: could not delete the wrapping key", e)
            } catch (e: java.io.IOException) {
                Log.w(TAG, "simulateRestoreFromBackup: could not open the Keystore", e)
            }
        }
    }

    /** The highest sequence durably reserved. Never handed out beyond this. */
    val highWaterMark: Long get() = reservedThrough

    /** The sequence the next [reserve] will return. */
    val nextSequence: Long get() = next

    /**
     * Reserve the next sequence number.
     *
     * Durably extends the reservation window BEFORE returning a value that
     * crosses it, so the persisted high-water mark is always at least every
     * sequence ever handed out.
     */
    @Synchronized
    fun reserve(): Long {
        if (next > Long.MAX_VALUE - WINDOW - 1) {
            // §13.8 rekeys at 2^32 frames, so this is unreachable in practice.
            // Refusing rather than wrapping means that if the rekey is ever
            // missed we stop instead of reusing a nonce.
            throw CounterUnsafeException(
                "sequence space exhausted for kid=$kid/$direction — rekey required"
            )
        }
        if (next >= reservedThrough) persist(next + WINDOW)
        return next++
    }

    /** Durably record that everything up to [through] is spoken for. */
    private fun persist(through: Long) {
        val rec = Record(RECORD_VERSION, kid, direction.name, through)
        val blob = seal(rec)
        // commit(), NOT apply(): apply() is asynchronous, so a frame could leave
        // the device before its reservation reached disk — which is exactly the
        // rule this class exists to enforce.
        val ok = prefs(ctx).edit().putString(recordKey(kid, direction), blob).commit()
        if (!ok) {
            throw CounterUnsafeException(
                "could not durably persist the sequence reservation for $kid/$direction — " +
                    "refusing to encrypt rather than emitting an unrecorded sequence"
            )
        }
        reservedThrough = through
    }
}
