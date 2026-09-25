package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * T-E2E-ACCOUNT-PREF step 2 (vc69) — the phone half of the per-ACCOUNT
 * Encrypted-mode setting, as PURE logic. No Context, no socket, no disk:
 * [E2eAccountPrefController] is the Android glue, this file is the rule.
 *
 * DESIGN-E2E-ACCOUNT-PREF.md REV 3 §3/§4/§7/§8/§12; SECURITY-DESIGN-READ.md B1 + M1.
 * RULE 30: `tests/e2e-pref-vectors.json` (step 1, [resolve]/[decideSet]/[decideSeed]
 * twins) and `tests/e2e-pref-latch-vectors.json` (this lane, [onPush] and friends).
 *
 * ## B1 — the downgrade latch
 *
 * The server now pushes the account's resolved value (`E2E_PREF`). A hostile
 * relay could push "off" after any ordinary reconnect with forged rev /
 * updatedBy / updatedAt and no reset, and the phone would silently stop asking
 * for the code. So:
 *  - a push that RAISES the effective mode applies at once (never latched);
 *  - a push that LOWERS it while this phone advertises ON applies ONLY if it
 *    matches [State.pendingOwnWrite] — a value THIS phone sent a moment ago.
 *    That is local knowledge. `updatedBy` is the server's word and is never
 *    consulted here: a forged `updatedBy:"phone"` changes nothing.
 *  - otherwise the phone keeps advertising ON, records the downgrade and asks
 *    the user ([Effect.ShowPrompt]). Only a tap lowers it.
 * The state is persisted ([encode]/[decode]) so the latch survives process
 * death and service restart.
 *
 * ## M1 — keyed by account
 *
 * One [State] per userId; the controller keys it by the id the phone stored
 * locally (TokenStore), never by anything in the push, and wipes it on
 * sign-out. A second account never inherits the first one's rev or mode.
 */
object E2eAccountPref {

    /**
     * How long a SET this phone sent may vouch for a matching lowering push.
     * Bounded because a stale own-write "off" would otherwise let a much later
     * foreign downgrade through without the prompt. The honest server answers a
     * SET in one round trip (push-before-reset, server.js applyE2ePrefChange).
     */
    const val OWN_WRITE_TTL_MS = 120_000L

    /** Persisted record version; anything else decodes as [failClosed]. */
    const val STATE_VERSION = 1

    const val FRAME_PUSH = "E2E_PREF"
    const val FRAME_REFUSED = "E2E_PREF_REFUSED"
    const val FRAME_SET = "SET_E2E_PREF"
    const val FRAME_SEED = "SEED_E2E_PREF"

    // ------------------------------------------------------------ resolve twin

    /** The server's resolved view (lib/e2ePref-core.js resolveE2ePref). */
    data class Resolved(
        val preference: Boolean,
        val effective: Boolean,
        val pausedByServer: Boolean,
        val rev: Int,
        val updatedAt: String?,
        val updatedBy: String?,
    ) {
        /** rev 0 and no writer = the account never chose (row is null). */
        val neverChosen: Boolean get() = rev == 0 && updatedBy == null
    }

    /**
     * Kotlin twin of `resolveE2ePref(row, {masterEnabled, defaultOn})`.
     * preference = stored ?: defaultOn; effective = preference AND master;
     * pausedByServer = preference AND NOT master (the brake lowers, never raises).
     */
    @JvmStatic
    fun resolve(
        stored: Boolean?,
        rev: Int,
        masterEnabled: Boolean,
        defaultOn: Boolean,
        updatedAt: String? = null,
        updatedBy: String? = null,
    ): Resolved {
        val pref = stored ?: defaultOn
        return Resolved(
            preference = pref,
            effective = pref && masterEnabled,
            pausedByServer = pref && !masterEnabled,
            rev = rev,
            updatedAt = updatedAt,
            updatedBy = updatedBy,
        )
    }

    /** Twin of `decideSet`: would writing [value] change the resolved preference? */
    @JvmStatic
    fun decideSet(stored: Boolean?, value: Boolean, defaultOn: Boolean): Boolean =
        (stored ?: defaultOn) != value

    /** Twin of `decideSeed`: (refused, applied). 'on' only, and only on a null row. */
    @JvmStatic
    fun decideSeed(stored: Boolean?, value: Boolean): Pair<Boolean, Boolean> =
        if (!value) true to false else false to (stored == null)

    /**
     * Parse an `E2E_PREF` body. Strict: anything malformed is null and the
     * caller DROPS the frame (a push we cannot read must never lower anything).
     */
    @JvmStatic
    fun parsePush(o: JsonObject?): Resolved? {
        if (o == null) return null
        fun onOff(k: String): Boolean? = runCatching {
            when (o.get(k)?.asString) { "on" -> true; "off" -> false; else -> null }
        }.getOrNull()
        val preference = onOff("preference") ?: return null
        val effective = onOff("effective") ?: return null
        val paused = runCatching { o.get("pausedByServer")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean }
            .getOrNull() ?: return null
        val revEl = o.get("rev")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber } ?: return null
        val revD = runCatching { revEl.asDouble }.getOrNull() ?: return null
        if (revD < 0 || revD != Math.floor(revD) || revD > Int.MAX_VALUE) return null
        fun str(k: String): String? = runCatching {
            o.get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        }.getOrNull()
        return Resolved(preference, effective, paused, revD.toInt(), str("updatedAt"), str("updatedBy"))
    }

    /** Same, from the Gson Map<String, Any> PhoneClient hands to handleCommand. */
    @JvmStatic
    fun parsePush(payload: Map<String, Any?>?): Resolved? {
        if (payload == null) return null
        return parsePush(com.google.gson.Gson().toJsonTree(payload).asJsonObject)
    }

    // ------------------------------------------------------------------ state

    enum class DowngradeKind { PREF_OFF, PAUSED }

    data class OwnWrite(val value: Boolean, val sentAtMs: Long)

    data class PendingDowngrade(
        val rev: Int,
        val updatedBy: String?,
        val updatedAt: String?,
        val kind: DowngradeKind,
    )

    /** One-time "turned on from X at T" notice (design §8 item 8). */
    data class Notice(val on: Boolean, val updatedBy: String?, val updatedAt: String?)

    /**
     * Everything the phone knows about ONE account.
     *
     * @property advertised what the phone advertises at Accept. Null = nothing
     *   decided for this account yet (see [advertisedOn] for the fallback).
     * @property lastRev highest rev applied; pushes at or below it are dropped.
     * @property mirror the last accepted push (drives the Settings switch).
     */
    data class State(
        val advertised: Boolean? = null,
        val lastRev: Int = -1,
        val mirror: Resolved? = null,
        val pendingOwnWrite: OwnWrite? = null,
        val pendingDowngrade: PendingDowngrade? = null,
        val seedAttempted: Boolean = false,
        val notice: Notice? = null,
    )

    /** Device-level legacy switch (vc<=68), read-only after this build. */
    data class Legacy(
        /** `encrypted_mode` ON and `encrypted_mode_user_set_v2` true. */
        val userSetOn: Boolean,
        /** A seed has been settled for some account on this device. */
        val consumed: Boolean,
    )

    enum class ToastKind { RATE_LIMITED, FAILED }

    sealed interface Effect {
        data class Send(val type: String, val value: Boolean) : Effect
        object ShowPrompt : Effect { override fun toString() = "ShowPrompt" }
        object ClearPrompt : Effect { override fun toString() = "ClearPrompt" }
        data class ShowNotice(val notice: Notice) : Effect
        data class Toast(val kind: ToastKind, val retryAfterMs: Long?) : Effect
        object MarkLegacyConsumed : Effect { override fun toString() = "MarkLegacyConsumed" }
    }

    data class Step(val state: State, val effects: List<Effect>, val dropped: Boolean = false)

    /**
     * The value advertised at Accept. Before any push for this account the
     * persisted [State.advertised] stands (it is never lowered except by a
     * matching own write or a tap), so "advertise max(mirror, latch)" holds by
     * construction. For an account with nothing decided yet: the legacy switch,
     * if a human set it ON and it has not been consumed by a seed.
     */
    @JvmStatic
    fun advertisedOn(s: State, legacy: Legacy): Boolean =
        s.advertised ?: (legacy.userSetOn && !legacy.consumed)

    /** Is the prompt card owed to the user? */
    @JvmStatic
    fun promptVisible(s: State): Boolean = s.pendingDowngrade != null

    private fun liveOwn(s: State, nowMs: Long): OwnWrite? =
        s.pendingOwnWrite?.takeIf { nowMs - it.sentAtMs in 0..OWN_WRITE_TTL_MS }

    // ----------------------------------------------------------------- events

    /** An `E2E_PREF` push arrived. */
    @JvmStatic
    fun onPush(s: State, push: Resolved, legacy: Legacy, nowMs: Long): Step {
        // §4 / M1: a rev this account has already seen is replay or reorder.
        if (push.rev <= s.lastRev) return Step(s, emptyList(), dropped = true)

        val effects = ArrayList<Effect>(3)
        val curAdv = advertisedOn(s, legacy)
        val own = liveOwn(s, nowMs)
        // A matched own write is consumed; an expired one is forgotten; a
        // mismatched live one stays until its TTL (the next push may be ours).
        val ownMatched = own != null && own.value == push.preference
        val keptOwn = if (ownMatched) null else own
        var st = s.copy(lastRev = push.rev, mirror = push, pendingOwnWrite = keptOwn)

        // §7: a seed was settled for this account (the row is no longer null).
        if (s.seedAttempted && !push.neverChosen && !legacy.consumed) {
            effects += Effect.MarkLegacyConsumed
        }

        // §7 seed-once: server never chose + a human set the legacy switch ON.
        if (push.neverChosen && legacy.userSetOn && !legacy.consumed && !s.seedAttempted) {
            st = st.copy(advertised = true, seedAttempted = true)
            effects += Effect.Send(FRAME_SEED, true)
            return Step(st, effects)
        }

        if (push.effective) {
            // RAISE (or steady ON): apply now, never latched.
            val raised = !curAdv
            st = st.copy(advertised = true, pendingDowngrade = null)
            if (s.pendingDowngrade != null) effects += Effect.ClearPrompt
            if (raised && !ownMatched) {
                val n = Notice(true, push.updatedBy, push.updatedAt)
                st = st.copy(notice = n)
                effects += Effect.ShowNotice(n)
            }
            return Step(st, effects)
        }

        // effective OFF from here.
        if (!curAdv) {
            // Row 5: already off. Nothing to protect.
            return Step(st.copy(advertised = false), effects)
        }
        if (ownMatched && !push.preference) {
            // Row 3: the value THIS phone asked for. No prompt.
            st = st.copy(advertised = false, pendingDowngrade = null)
            if (s.pendingDowngrade != null) effects += Effect.ClearPrompt
            return Step(st, effects)
        }
        // B1: keep advertising ON, remember the downgrade, ask the user.
        st = st.copy(
            advertised = true,
            pendingDowngrade = PendingDowngrade(
                push.rev,
                push.updatedBy,
                push.updatedAt,
                if (push.pausedByServer) DowngradeKind.PAUSED else DowngradeKind.PREF_OFF,
            ),
        )
        effects += Effect.ShowPrompt
        return Step(st, effects)
    }

    /** [Keep off] / [Continue without code check]: lower locally, write nothing. */
    @JvmStatic
    fun onKeepOff(s: State): Step {
        if (s.pendingDowngrade == null) return Step(s, emptyList())
        return Step(s.copy(advertised = false, pendingDowngrade = null), listOf(Effect.ClearPrompt))
    }

    /** Paused variant [Keep code check]: stay ON, dismiss. No write (the pref is already on). */
    @JvmStatic
    fun onKeepCodeCheck(s: State): Step {
        if (s.pendingDowngrade == null) return Step(s, emptyList())
        return Step(s.copy(advertised = true, pendingDowngrade = null), listOf(Effect.ClearPrompt))
    }

    /** [Turn back on]: the tap is the confirmation. SET on, stay ON. */
    @JvmStatic
    fun onTurnBackOn(s: State, nowMs: Long): Step {
        if (s.pendingDowngrade == null) return Step(s, emptyList())
        return Step(
            s.copy(advertised = true, pendingDowngrade = null, pendingOwnWrite = OwnWrite(true, nowMs)),
            listOf(Effect.Send(FRAME_SET, true), Effect.ClearPrompt),
        )
    }

    /** Settings switch, after the confirm dialog. Advertised moves only on the push. */
    @JvmStatic
    fun onUserSet(s: State, value: Boolean, nowMs: Long): Step =
        Step(s.copy(pendingOwnWrite = OwnWrite(value, nowMs)), listOf(Effect.Send(FRAME_SET, value)))

    /**
     * `E2E_PREF_REFUSED:{op, reason[, retryAfterMs]}` — nothing was saved.
     * The own write is gone (so a later foreign downgrade still hits the
     * latch). If the phone is ON while the account mirror is lowered, the
     * latch comes back: a refusal never lowers anything. A refused SEED is not
     * retried (seedAttempted stays set until sign-out wipes this account).
     */
    @JvmStatic
    fun onRefused(s: State, op: String, reason: String?, retryAfterMs: Long?, legacy: Legacy): Step {
        val effects = ArrayList<Effect>(2)
        var st = if (op == "set") s.copy(pendingOwnWrite = null) else s
        val m = st.mirror
        if (st.pendingDowngrade == null && advertisedOn(st, legacy) && m != null && !m.effective) {
            st = st.copy(
                advertised = true,
                pendingDowngrade = PendingDowngrade(
                    m.rev, m.updatedBy, m.updatedAt,
                    if (m.pausedByServer) DowngradeKind.PAUSED else DowngradeKind.PREF_OFF,
                ),
            )
            effects += Effect.ShowPrompt
        }
        if (op == "set") {
            effects += Effect.Toast(
                if (reason == "rate_limited") ToastKind.RATE_LIMITED else ToastKind.FAILED,
                if (reason == "rate_limited") retryAfterMs else null,
            )
        }
        return Step(st, effects)
    }

    /** The one-time notice was shown. */
    @JvmStatic
    fun onNoticeShown(s: State): State = s.copy(notice = null)

    // -------------------------------------------------------------- persistence

    /**
     * What an unreadable persisted record decodes to. FAIL CLOSED: a record we
     * cannot read might have been the latch, so the phone keeps asking for the
     * code; the next push (any rev, lastRev -1) re-establishes the truth, and a
     * lowering push then goes through the prompt like any other.
     */
    @JvmStatic
    fun failClosed(): State = State(advertised = true)

    @JvmStatic
    fun encode(s: State): String {
        val o = JsonObject()
        o.addProperty("v", STATE_VERSION)
        s.advertised?.let { o.addProperty("advertised", it) }
        o.addProperty("lastRev", s.lastRev)
        s.mirror?.let { m ->
            val j = JsonObject()
            j.addProperty("preference", if (m.preference) "on" else "off")
            j.addProperty("effective", if (m.effective) "on" else "off")
            j.addProperty("pausedByServer", m.pausedByServer)
            j.addProperty("rev", m.rev)
            m.updatedAt?.let { j.addProperty("updatedAt", it) }
            m.updatedBy?.let { j.addProperty("updatedBy", it) }
            o.add("mirror", j)
        }
        s.pendingOwnWrite?.let { w ->
            val j = JsonObject()
            j.addProperty("value", w.value)
            j.addProperty("sentAtMs", w.sentAtMs)
            o.add("pendingOwnWrite", j)
        }
        s.pendingDowngrade?.let { d ->
            val j = JsonObject()
            j.addProperty("rev", d.rev)
            d.updatedBy?.let { j.addProperty("updatedBy", it) }
            d.updatedAt?.let { j.addProperty("updatedAt", it) }
            j.addProperty("kind", d.kind.name)
            o.add("pendingDowngrade", j)
        }
        o.addProperty("seedAttempted", s.seedAttempted)
        s.notice?.let { n ->
            val j = JsonObject()
            j.addProperty("on", n.on)
            n.updatedBy?.let { j.addProperty("updatedBy", it) }
            n.updatedAt?.let { j.addProperty("updatedAt", it) }
            o.add("notice", j)
        }
        return o.toString()
    }

    /** Null raw = nothing stored = fresh [State]. Unreadable = [failClosed]. */
    @JvmStatic
    fun decode(raw: String?): State {
        if (raw.isNullOrBlank()) return State()
        return runCatching { decodeStrict(raw) }.getOrNull() ?: failClosed()
    }

    private fun decodeStrict(raw: String): State? {
        val o = JsonParser.parseString(raw).asJsonObject
        if (o.get("v")?.asInt != STATE_VERSION) return null
        fun JsonObject.optStr(k: String): String? =
            get(k)?.takeIf { it.isJsonPrimitive }?.asString
        val mirror = o.getAsJsonObject("mirror")?.let { parsePush(it) ?: return null }
        val own = o.getAsJsonObject("pendingOwnWrite")?.let {
            OwnWrite(it.get("value").asBoolean, it.get("sentAtMs").asLong)
        }
        val pd = o.getAsJsonObject("pendingDowngrade")?.let {
            PendingDowngrade(
                it.get("rev").asInt,
                it.optStr("updatedBy"),
                it.optStr("updatedAt"),
                DowngradeKind.valueOf(it.get("kind").asString),
            )
        }
        val notice = o.getAsJsonObject("notice")?.let {
            Notice(it.get("on").asBoolean, it.optStr("updatedBy"), it.optStr("updatedAt"))
        }
        return State(
            advertised = o.get("advertised")?.asBoolean,
            lastRev = o.get("lastRev").asInt,
            mirror = mirror,
            pendingOwnWrite = own,
            pendingDowngrade = pd,
            seedAttempted = o.get("seedAttempted")?.asBoolean ?: false,
            notice = notice,
        )
    }
}
