package com.dnkdialer.companion

import android.content.Context
import android.util.Log

/**
 * E2E programme P6.1c part 1a — **the caller [E2eDeviceKeyClient.register] has
 * never had.**
 *
 * SPEC v1.0 line 118 says "Phone: Android Keystore …, registered on login."
 * The client that does it landed in P4 Part 2 (e) and, up to this commit, had
 * ZERO callers anywhere in `app/src/main`. The consequence was found live in
 * P6.1b Part B (finding A6-P61B-1/-7): the page's C-2 pin looks the phone up
 * in the DeviceKey registry at Accept, finds `no-phone-row`, and — correctly —
 * fails closed with effective mode ON. Every ON pairing in the programme has
 * been refused by a check that was right about a registry the phone never
 * wrote to. P4 Part 2's suites did not catch it because the harness seeded the
 * scripted phone's row by hand.
 *
 * ## What this object is, and what it is deliberately not
 *
 * It is the DECISION plus one blocking round trip, and nothing else. The
 * decision — [plan] — is pure, takes no [Context], touches no network, and is
 * where the whole unit suite lives. Everything Android-shaped is confined to
 * [ensureForThisDevice], which is three lookups and a delegation.
 *
 * ## M-A6-2 (GATE1-ADDENDUM-A6): no SILENT kid overwrite
 *
 * The naive implementation of "register on login" is to POST the key every
 * time and move on. That is exactly the silent overwrite A6 forbids: the
 * server's N-4 rotation revokes the live row and inserts a new one
 * (`lib/deviceKeys.registerDeviceKey`), so a blind POST can displace a key the
 * user's peers have already pinned — and the only trace would be a `rotated`
 * boolean nobody read.
 *
 * So this object LISTS FIRST, always, and classifies before it writes:
 *
 * | registry state for (our deviceId, kind=phone) | plan | status |
 * |---|---|---|
 * | live row, `publicKey` == ours          | no call at all       | [Status.ALREADY_LIVE] |
 * | live row, `publicKey` != ours          | register, **WARN**   | [Status.ROTATED] |
 * | no live row (absent, or only revoked)  | register             | [Status.REGISTERED] |
 *
 * The middle row is the one A6 is about. It is not refused — N-4 gives
 * rotation a defined, evidence-preserving meaning and the server implements it
 * in one transaction — but it can never happen *quietly*: the displaced key is
 * logged alongside the new one, and the outcome is a distinct status rather
 * than being folded into "registered". A rotation the user did not ask for is
 * a substitution, and the log line is the only place that ever becomes
 * visible.
 *
 * Note what the middle row also means: per [E2eLifecycle], a genuine local key
 * rotation mints a NEW `deviceId`, so a *different* key under the *same* id is
 * not the normal rotation path at all — it is a reinstall that kept the prefs,
 * a restored backup, or something worse. Hence WARN, not INFO.
 *
 * ## Idempotence
 *
 * [Status.ALREADY_LIVE] issues no HTTP write whatsoever. App start, sign-in
 * and every Accept can therefore all call this, which is exactly what they do
 * — the brief's "register BEFORE the first pairing can be accepted" is
 * satisfied by the Accept path calling it too, not by hoping an earlier call
 * succeeded.
 *
 * ## Failure never blocks anything
 *
 * Every non-success is [Status.DEFERRED] plus a reason, and the caller's only
 * duty is to log it. A 409 `pairing_in_flight` is the designed-for case (P1
 * refuses a key landing mid-handshake, because it would change the set the SAS
 * describes); the next app start or the next Accept retries. Sign-in NEVER
 * waits on this — see [SignInActivity].
 *
 * ## Threading
 *
 * [E2eDeviceKeyClient] blocks. Every entry point here blocks with it, and
 * calling any of them on the main thread is a `NetworkOnMainThreadException`.
 * Callers supply the thread: [PhoneService] its `e2e-accept` executor,
 * [SignInActivity] a plain `Thread` as it already does for the login POST.
 */
object E2eDeviceKeyRegistrar {

    private const val TAG = "E2eDeviceKeyRegistrar"

    /** The registry `kind` for a phone. The only kind this object ever writes. */
    const val KIND_PHONE = "phone"

    enum class Status {
        /** A live row already holds this exact key. No write was issued. */
        ALREADY_LIVE,

        /** There was no live row; one was created. */
        REGISTERED,

        /** A live row held a DIFFERENT key and was rotated. M-A6-2: never silent. */
        ROTATED,

        /** Nothing was attempted — no token, or this device cannot hold a key. */
        SKIPPED,

        /** Attempted and failed. Retried on the next app start / Accept. */
        DEFERRED,
    }

    /**
     * @param registry the rows as they stand AFTER this call — i.e. including
     *        the row we just wrote. It is deliberately the same
     *        [E2eDeviceKeyClient.Result] shape the §13.6 pin consumes, so the
     *        Accept path can register and pin off ONE list round trip instead
     *        of two. An [E2eDeviceKeyClient.Result.Unavailable] here is passed
     *        through untouched: §13.6 gives "unreachable" and "mismatch"
     *        opposite handling, and collapsing them is the bug that rule exists
     *        to prevent.
     */
    data class Outcome(
        val status: Status,
        val detail: String,
        val registry: E2eDeviceKeyClient.Result<List<E2eDeviceKeyClient.DeviceKeyRow>>,
        /**
         * R-BH: the account id the registry reported for OUR bearer, or null
         * when it said nothing. Never `""` -- [E2eDeviceKeyClient] folds an
         * empty field into null at the parse.
         */
        val userId: String? = null,
        /**
         * A DIFFERENT id was already persisted and was not overwritten. The
         * Accept path treats this as fail-closed under mode ON; see
         * [TokenStore.putUserId].
         */
        val userIdMismatch: Boolean = false,
    ) {
        val wrote: Boolean get() = status == Status.REGISTERED || status == Status.ROTATED
    }

    /** What [plan] decided. Pure; no I/O has happened yet. */
    sealed interface Plan {
        /** A live row already holds our key. Issue nothing. */
        data object UpToDate : Plan

        /**
         * Write. [displacing] is the live row this write will revoke, or null
         * when there is nothing live to displace. Non-null is M-A6-2's case.
         */
        data class Register(val displacing: E2eDeviceKeyClient.DeviceKeyRow?) : Plan
    }

    /**
     * The whole decision, pure. Compares SEC1 BYTES, never the base64url text:
     * two encodings of the same point that differ in padding would otherwise
     * read as a rotation and displace a perfectly good row on every app start.
     *
     * A live row whose `publicKey` does not decode at all counts as displacing
     * — something unusable is in the slot the peers pin against, and replacing
     * it is the only way the pair can ever verify.
     */
    @JvmStatic
    fun plan(
        rows: List<E2eDeviceKeyClient.DeviceKeyRow>,
        deviceId: String,
        publicKeySec1: ByteArray,
    ): Plan {
        val live = rows.firstOrNull {
            it.deviceId == deviceId && it.kind == KIND_PHONE && !it.isRevoked
        } ?: return Plan.Register(null)
        val held = live.publicKeyBytes()
        return if (held != null && held.contentEquals(publicKeySec1)) {
            Plan.UpToDate
        } else {
            Plan.Register(live)
        }
    }

    /**
     * List, decide, and write at most once. Blocking. No [Context] — the two
     * injected lambdas are the entire outside world, which is what lets the
     * unit suite drive every branch including 409.
     */
    @JvmStatic
    @JvmOverloads
    fun ensureRegistered(
        phoneToken: String?,
        deviceId: String,
        publicKeySec1: ByteArray,
        label: String? = null,
        lister: (String) -> E2eDeviceKeyClient.Result<E2eDeviceKeyClient.Listing> =
            { E2eDeviceKeyClient.list(it) },
        registrar: (String, String, ByteArray, String?)
        -> E2eDeviceKeyClient.Result<E2eDeviceKeyClient.Registration> =
            { t, d, k, l -> E2eDeviceKeyClient.register(t, d, k, l) },
    ): Outcome {
        if (phoneToken.isNullOrBlank()) {
            val why = "no phone token — not signed in"
            return Outcome(Status.SKIPPED, why, E2eDeviceKeyClient.Result.Unavailable(why))
        }
        if (deviceId.isBlank()) {
            val why = "no device id"
            return Outcome(Status.SKIPPED, why, E2eDeviceKeyClient.Result.Unavailable(why))
        }

        val listed = lister(phoneToken)
        if (listed !is E2eDeviceKeyClient.Result.Ok) {
            // Pass the real failure through. The pin must see "unreachable" as
            // unreachable, not as "no phone row" — those fail differently.
            return Outcome(Status.DEFERRED, "registry list failed: $listed", failureAs(listed))
        }
        // R-BH: one round trip now yields two things — the rows the pin reads,
        // and the account id the key schedule needs. They are separated here so
        // that everything downstream keeps the shape it had.
        val rows = listed.value.keys
        val listedRows = E2eDeviceKeyClient.Result.Ok(rows)
        val listedUserId = listed.value.userId

        val decided = plan(rows, deviceId, publicKeySec1)
        if (decided is Plan.UpToDate) {
            // The ALREADY_LIVE path is exactly why LIST has to carry the
            // account id too: it issues no write at all, so a register-only
            // channel would never reach a phone whose row already exists --
            // which, after the first run, is every phone.
            return Outcome(
                Status.ALREADY_LIVE, "a live row already holds this key", listedRows, listedUserId,
            )
        }
        val displacing = (decided as Plan.Register).displacing

        return when (val written = registrar(phoneToken, deviceId, publicKeySec1, label)) {
            is E2eDeviceKeyClient.Result.Ok -> {
                val row = written.value.key
                val serverRotated = written.value.rotated
                val status = if (displacing != null || serverRotated) {
                    Status.ROTATED
                } else {
                    Status.REGISTERED
                }
                val detail = if (status == Status.ROTATED) {
                    "ROTATED: displaced ${fingerprint(displacing?.publicKey)} with " +
                        "${fingerprint(row.publicKey)} for deviceId=$deviceId " +
                        "(serverRotated=$serverRotated)"
                } else {
                    "registered ${fingerprint(row.publicKey)} for deviceId=$deviceId"
                }
                Outcome(
                    status,
                    detail,
                    E2eDeviceKeyClient.Result.Ok(merge(rows, row)),
                    written.value.userId ?: listedUserId,
                )
            }

            E2eDeviceKeyClient.Result.PairingInFlight -> Outcome(
                Status.DEFERRED,
                "409 pairing_in_flight — a handshake is mid-flight; retrying on the " +
                    "next app start or Accept",
                listedRows,
                listedUserId,
            )

            is E2eDeviceKeyClient.Result.Forbidden -> Outcome(
                Status.DEFERRED,
                "registry refused the write (${written.status}): ${written.message}",
                listedRows,
                listedUserId,
            )

            is E2eDeviceKeyClient.Result.Unavailable -> Outcome(
                Status.DEFERRED,
                "registry unavailable for the write: ${written.reason}",
                listedRows,
                listedUserId,
            )
        }
    }

    /**
     * Re-type a NON-Ok [E2eDeviceKeyClient.Result]. Every failure arm carries
     * no value and is a `Result<Nothing>`, so this is total and lossless — it
     * exists only because the lister now yields a [E2eDeviceKeyClient.Listing]
     * while [Outcome.registry] still yields rows, and the §13.6 pin must keep
     * seeing the ORIGINAL failure rather than a flattened one.
     */
    private fun <T> failureAs(
        r: E2eDeviceKeyClient.Result<*>,
    ): E2eDeviceKeyClient.Result<T> = when (r) {
        is E2eDeviceKeyClient.Result.Ok ->
            throw IllegalArgumentException("failureAs is for failures only")
        E2eDeviceKeyClient.Result.PairingInFlight -> E2eDeviceKeyClient.Result.PairingInFlight
        is E2eDeviceKeyClient.Result.Forbidden -> r
        is E2eDeviceKeyClient.Result.Unavailable -> r
    }

    /**
     * Fold the freshly written row into the rows we listed, so the caller can
     * pin off this one result. Any live row for the same (deviceId, kind) is
     * dropped — the server just revoked it in the same transaction, so keeping
     * it would hand the pin a row the registry no longer serves.
     */
    private fun merge(
        rows: List<E2eDeviceKeyClient.DeviceKeyRow>,
        written: E2eDeviceKeyClient.DeviceKeyRow,
    ): List<E2eDeviceKeyClient.DeviceKeyRow> =
        rows.filterNot {
            it.deviceId == written.deviceId && it.kind == written.kind && !it.isRevoked
        } + written

    /** First 12 chars of a base64url key. Enough to compare two, useless to steal. */
    private fun fingerprint(publicKey: String?): String =
        if (publicKey.isNullOrEmpty()) "(none)" else publicKey.take(12) + "…"

    // ------------------------------------------------------- Android binding

    /**
     * [ensureRegistered] for THIS device. Blocking — never call it on the main
     * thread. Never throws: a device that cannot hold a key at all is
     * [Status.SKIPPED], not a crash on the Accept path.
     *
     * @param reason appears in the log line, so "service start" and "accept"
     *        are distinguishable in a bug report.
     */
    @JvmStatic
    @JvmOverloads
    fun ensureForThisDevice(
        ctx: Context,
        reason: String,
        phoneToken: String? = TokenStore.getPhoneToken(ctx),
    ): Outcome {
        val app = ctx.applicationContext
        val publicKey = runCatching { E2eKeyAgreement.devicePublicSec1(app) }.getOrElse { e ->
            val why = "no device key on this device: ${e.javaClass.simpleName}: ${e.message}"
            Log.w(TAG, "[$reason] $why")
            return Outcome(Status.SKIPPED, why, E2eDeviceKeyClient.Result.Unavailable(why))
        }
        val outcome = runCatching {
            ensureRegistered(
                phoneToken = phoneToken,
                deviceId = E2eLifecycle.deviceId(app),
                publicKeySec1 = publicKey,
                label = TokenStore.getDeviceName(app),
            )
        }.getOrElse { e ->
            val why = "${e.javaClass.simpleName}: ${e.message}"
            Outcome(Status.DEFERRED, why, E2eDeviceKeyClient.Result.Unavailable(why))
        }
        // R-BH: persist the account id off the same round trip. Persist-once,
        // so a second DIFFERENT id is refused rather than applied -- the phone
        // keeps what it has and the Accept path fails closed under mode ON.
        val write = TokenStore.putUserId(app, outcome.userId)
        val settled = if (write == TokenStore.UserIdWrite.MISMATCH) {
            Log.w(TAG, "[$reason] E2E_USERID_MISMATCH - refusing to re-key; see TokenStore")
            outcome.copy(userIdMismatch = true)
        } else {
            outcome
        }
        when (outcome.status) {
            // M-A6-2: the displacement is the one outcome that must never pass
            // unremarked, so it is the one that is not at INFO.
            Status.ROTATED -> Log.w(TAG, "[$reason] ${outcome.detail}")
            Status.DEFERRED -> Log.w(TAG, "[$reason] deferred — ${outcome.detail}")
            else -> Log.i(TAG, "[$reason] ${outcome.status}: ${outcome.detail}")
        }
        return settled
    }
}
