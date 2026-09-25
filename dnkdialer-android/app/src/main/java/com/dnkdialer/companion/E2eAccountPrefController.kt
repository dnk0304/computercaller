package com.dnkdialer.companion

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.core.content.edit

/**
 * T-E2E-ACCOUNT-PREF step 2 (vc69) — the Android glue around [E2eAccountPref].
 *
 * Owns: per-account persistence (M1), the relay transport PhoneService lends
 * it, and turning [E2eAccountPref.Effect]s into frames, toasts and prompt
 * callbacks. Owns NO rule: every decision is the pure reducer's, pinned by
 * `tests/e2e-pref-latch-vectors.json`.
 *
 * ## Storage (M1)
 *
 * Plain SharedPreferences `computercaller_e2e_prefs` — the same file
 * [E2eSettings] uses, for the same reason (a Keystore outage must not make the
 * phone forget it was ON). One record per account at `acct_pref:<userId>`,
 * where userId is [TokenStore.getUserId] — the account id this phone
 * persisted itself (E2eDeviceKeyRegistrar -> TokenStore.putUserId), NEVER a
 * value from the push. Wiped by [onSignOut] (AccountActions sign-out path).
 * Committed synchronously: the latch must survive a process kill that lands
 * straight after the push.
 *
 * With no stored userId (not yet learned) there is no account to key on:
 * pushes are ignored (the relay re-pushes on every connect) and the phone
 * advertises the legacy local switch, exactly as vc68 did.
 */
object E2eAccountPrefController {

    private const val PREFS_NAME = "computercaller_e2e_prefs"
    private const val KEY_PREFIX = "acct_pref:"
    private const val KEY_LEGACY_CONSUMED = "acct_pref_legacy_seed_consumed"
    private const val TAG = "E2eAccountPref"

    /** How PhoneService lends its relay socket. Null while no service. */
    interface Transport {
        fun isOpen(): Boolean
        fun send(type: String, payload: Map<String, Any>): Boolean
    }

    @Volatile
    var transport: Transport? = null

    /** PhoneService: show (true) / clear (false) the background notification. */
    @Volatile
    var promptListener: ((Boolean) -> Unit)? = null

    private val lock = Any()

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun key(userId: String) = KEY_PREFIX + userId

    /**
     * Where the account id comes from: TokenStore (local, persisted at
     * sign-in / device-key registration). Swappable ONLY so an instrumented
     * test can run against a throwaway id instead of rewriting the persist-once
     * TokenStore id of the device it runs on. Never assigned by app code.
     */
    @androidx.annotation.VisibleForTesting
    @Volatile
    var userIdSource: (Context) -> String? = { ctx -> TokenStore.getUserId(ctx) }

    /** The locally stored account id, or null. Never from a frame. */
    private fun userId(ctx: Context): String? = runCatching { userIdSource(ctx) }.getOrNull()

    fun legacy(ctx: Context): E2eAccountPref.Legacy = E2eAccountPref.Legacy(
        userSetOn = E2eSettings.isEncryptedModeEnabled(ctx) && E2eSettings.isEncryptedModeUserSet(ctx),
        consumed = prefs(ctx).getBoolean(KEY_LEGACY_CONSUMED, false),
    )

    /** This account's state, or null when no account id is stored yet. */
    fun state(ctx: Context): E2eAccountPref.State? {
        val uid = userId(ctx) ?: return null
        return E2eAccountPref.decode(prefs(ctx).getString(key(uid), null))
    }

    private fun save(ctx: Context, uid: String, s: E2eAccountPref.State) {
        prefs(ctx).edit(commit = true) { putString(key(uid), E2eAccountPref.encode(s)) }
    }

    /**
     * What this phone advertises at Accept (PhoneService.decideE2e). With no
     * account id: the legacy local switch, unchanged from vc68.
     */
    fun advertisedOn(ctx: Context): Boolean {
        val s = state(ctx) ?: return E2eSettings.isEncryptedModeEnabled(ctx)
        return E2eAccountPref.advertisedOn(s, legacy(ctx))
    }

    fun isOnline(): Boolean = transport?.isOpen() == true

    // ------------------------------------------------------------ frames in

    fun onPushFrame(ctx: Context, payload: Map<String, Any?>?, nowMs: Long = System.currentTimeMillis()) {
        val push = E2eAccountPref.parsePush(payload)
        if (push == null) {
            DiagLog.w(TAG, "E2E_PREF malformed — dropped")
            return
        }
        synchronized(lock) {
            val uid = userId(ctx) ?: run {
                DiagLog.w(TAG, "E2E_PREF with no stored account id — ignored (re-pushed on next connect)")
                return
            }
            val lg = legacy(ctx)
            val step = E2eAccountPref.onPush(state(ctx) ?: E2eAccountPref.State(), push, lg, nowMs)
            if (step.dropped) {
                if (step.dropReason == E2eAccountPref.DropReason.EQUAL_REV_MISMATCH) {
                    // Same rev, different preference/source: not an honest server frame.
                    DiagLog.w(TAG, "E2E_PREF rev=${push.rev} dropped (equal rev, preference/source mismatch)")
                } else {
                    DiagLog.d(TAG, "E2E_PREF rev=${push.rev} dropped (${step.dropReason})")
                }
                return
            }
            save(ctx, uid, step.state)
            DiagLog.d(
                TAG,
                "E2E_PREF rev=${push.rev}${if (step.masterOnly) " (equal rev, master switch)" else ""} " +
                    "eff=${step.state.mirror?.effective} paused=${step.state.mirror?.pausedByServer} " +
                    "-> advertised=${E2eAccountPref.advertisedOn(step.state, lg)} " +
                    "latched=${step.state.pendingDowngrade != null}",
            )
            run(ctx, step.effects)
        }
    }

    fun onRefusedFrame(ctx: Context, payload: Map<String, Any?>?) {
        val op = payload?.get("op") as? String
        if (op != "set" && op != "seed") return
        val reason = payload["reason"] as? String
        val retry = (payload["retryAfterMs"] as? Number)?.toLong()
        synchronized(lock) {
            val uid = userId(ctx) ?: return
            val step = E2eAccountPref.onRefused(
                state(ctx) ?: E2eAccountPref.State(), op, reason, retry, legacy(ctx),
            )
            save(ctx, uid, step.state)
            DiagLog.w(TAG, "E2E_PREF_REFUSED op=$op reason=$reason")
            run(ctx, step.effects)
        }
    }

    // ------------------------------------------------------------ user acts

    enum class Result { SENT, DONE, OFFLINE, NO_ACCOUNT }

    /** Settings switch, AFTER its confirm dialog. */
    fun requestSet(ctx: Context, on: Boolean): Result = synchronized(lock) {
        val uid = userId(ctx) ?: return Result.NO_ACCOUNT
        if (!isOnline()) return Result.OFFLINE
        val step = E2eAccountPref.onUserSet(state(ctx) ?: E2eAccountPref.State(), on, System.currentTimeMillis())
        save(ctx, uid, step.state)
        run(ctx, step.effects)
        Result.SENT
    }

    /** [Turn back on] — the tap is the confirmation. Needs the socket. */
    fun turnBackOn(ctx: Context): Result = synchronized(lock) {
        val uid = userId(ctx) ?: return Result.NO_ACCOUNT
        if (!isOnline()) return Result.OFFLINE
        val step = E2eAccountPref.onTurnBackOn(state(ctx) ?: return Result.NO_ACCOUNT, System.currentTimeMillis())
        save(ctx, uid, step.state)
        run(ctx, step.effects)
        Result.SENT
    }

    /** [Keep off] / [Continue without code check]. Local only, works offline. */
    fun keepOff(ctx: Context): Result = local(ctx) { E2eAccountPref.onKeepOff(it) }

    /** Paused [Keep code check]. Local only. */
    fun keepCodeCheck(ctx: Context): Result = local(ctx) { E2eAccountPref.onKeepCodeCheck(it) }

    private fun local(ctx: Context, f: (E2eAccountPref.State) -> E2eAccountPref.Step): Result =
        synchronized(lock) {
            val uid = userId(ctx) ?: return Result.NO_ACCOUNT
            val step = f(state(ctx) ?: E2eAccountPref.State())
            save(ctx, uid, step.state)
            run(ctx, step.effects)
            Result.DONE
        }

    /** The pending one-time notice, consumed. */
    fun takeNotice(ctx: Context): E2eAccountPref.Notice? = synchronized(lock) {
        val uid = userId(ctx) ?: return null
        val s = state(ctx) ?: return null
        val n = s.notice ?: return null
        save(ctx, uid, E2eAccountPref.onNoticeShown(s))
        n
    }

    /**
     * M1: sign-out wipes THIS account's record. Called before TokenStore.clear()
     * (AccountActions), because the key IS the stored userId.
     */
    fun onSignOut(ctx: Context) {
        synchronized(lock) {
            val uid = userId(ctx) ?: return
            prefs(ctx).edit(commit = true) { remove(key(uid)) }
        }
        promptListener?.invoke(false)
        DiagLog.d(TAG, "account pref wiped (sign-out)")
    }

    // --------------------------------------------------------------- effects

    private fun run(ctx: Context, effects: List<E2eAccountPref.Effect>) {
        for (e in effects) when (e) {
            is E2eAccountPref.Effect.Send -> {
                val ok = transport?.send(e.type, mapOf("value" to if (e.value) "on" else "off")) == true
                DiagLog.d(TAG, "${e.type} ${if (e.value) "on" else "off"} sent=$ok")
            }
            E2eAccountPref.Effect.ShowPrompt -> promptListener?.invoke(true)
            E2eAccountPref.Effect.ClearPrompt -> promptListener?.invoke(false)
            is E2eAccountPref.Effect.ShowNotice -> Unit // painted by MainActivity via takeNotice()
            is E2eAccountPref.Effect.Toast -> toast(ctx, E2eAccountPrefCopy.toastText(ctx, e))
            E2eAccountPref.Effect.MarkLegacyConsumed ->
                prefs(ctx).edit(commit = true) { putBoolean(KEY_LEGACY_CONSUMED, true) }
        }
    }

    private fun toast(ctx: Context, text: String) {
        val app = ctx.applicationContext
        Handler(Looper.getMainLooper()).post {
            android.widget.Toast.makeText(app, text, android.widget.Toast.LENGTH_LONG).show()
        }
    }
}
