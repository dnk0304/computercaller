package com.dnkdialer.companion

import android.content.Context
import androidx.annotation.StringRes
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * vc69 — copy for the per-account Encrypted-mode setting. [sourceRes] and
 * [rateLimitedSeconds] are pure (JVM-tested); the rest formats with a Context.
 *
 * `updatedBy` is server-supplied text: it is only ever mapped through a fixed
 * table here, never shown verbatim.
 */
object E2eAccountPrefCopy {

    @JvmStatic
    @StringRes
    fun sourceRes(updatedBy: String?): Int = when (updatedBy) {
        "web" -> R.string.e2e_pref_src_web
        "ext" -> R.string.e2e_pref_src_ext
        "phone" -> R.string.e2e_pref_src_phone
        "admin" -> R.string.e2e_pref_src_admin
        else -> R.string.e2e_pref_src_account
    }

    /** Seconds to show for a rate-limit refusal, or null for "in a minute". */
    @JvmStatic
    fun rateLimitedSeconds(retryAfterMs: Long?): Int? {
        if (retryAfterMs == null || retryAfterMs <= 0 || retryAfterMs >= 45_000) return null
        return ((retryAfterMs + 999) / 1000).toInt()
    }

    fun source(ctx: Context, updatedBy: String?): String = ctx.getString(sourceRes(updatedBy))

    /** Local HH:mm for an ISO instant, or null when absent/unreadable. */
    fun time(iso: String?): String? {
        if (iso.isNullOrBlank()) return null
        return runCatching {
            DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
        }.getOrNull()
    }

    fun toastText(ctx: Context, t: E2eAccountPref.Effect.Toast): String = when (t.kind) {
        E2eAccountPref.ToastKind.FAILED -> ctx.getString(R.string.e2e_pref_toast_failed)
        E2eAccountPref.ToastKind.RATE_LIMITED -> rateLimitedSeconds(t.retryAfterMs)
            ?.let { ctx.resources.getQuantityString(R.plurals.e2e_pref_toast_rate_limited_s, it, it) }
            ?: ctx.getString(R.string.e2e_pref_toast_rate_limited)
    }

    fun promptText(ctx: Context, d: E2eAccountPref.PendingDowngrade): String = when (d.kind) {
        E2eAccountPref.DowngradeKind.PREF_OFF -> ctx.getString(R.string.e2e_pref_prompt_off, source(ctx, d.updatedBy))
        E2eAccountPref.DowngradeKind.PAUSED -> ctx.getString(R.string.e2e_pref_prompt_paused)
    }

    /** What a latch-prompt button does. Pure, so the layout decision is JVM-tested. */
    enum class PromptAction(@StringRes val labelRes: Int) {
        KEEP_CODE_CHECK(R.string.e2e_pref_prompt_keep_check),
        CONTINUE_WITHOUT(R.string.e2e_pref_prompt_continue_without),
        KEEP_OFF(R.string.e2e_pref_prompt_keep_off),
        TURN_BACK_ON(R.string.e2e_pref_prompt_turn_back_on),
    }

    /**
     * Which action sits on which button of the latch prompt card.
     * [primaryFilled] = the primary button carries the filled brand pill.
     *
     * Security review R2 (c7c290f): on PAUSED the safe choice, "Keep code
     * check", is the PRIMARY (filled) button and "Continue without code
     * check" is the outline secondary — a reflex tap keeps the check on.
     * PREF_OFF is unchanged (both outline).
     */
    data class PromptButtons(
        val primary: PromptAction,
        val secondary: PromptAction,
        val primaryFilled: Boolean,
    )

    @JvmStatic
    fun promptButtons(kind: E2eAccountPref.DowngradeKind): PromptButtons = when (kind) {
        E2eAccountPref.DowngradeKind.PAUSED ->
            PromptButtons(PromptAction.KEEP_CODE_CHECK, PromptAction.CONTINUE_WITHOUT, primaryFilled = true)
        E2eAccountPref.DowngradeKind.PREF_OFF ->
            PromptButtons(PromptAction.TURN_BACK_ON, PromptAction.KEEP_OFF, primaryFilled = false)
    }

    fun noticeText(ctx: Context, n: E2eAccountPref.Notice): String =
        ctx.getString(R.string.e2e_pref_notice_on, source(ctx, n.updatedBy), time(n.updatedAt) ?: "--:--")

    fun changedByLine(ctx: Context, m: E2eAccountPref.Resolved): String? {
        if (m.updatedBy == null) return null
        val t = time(m.updatedAt) ?: return null
        return ctx.getString(R.string.e2e_pref_changed_by, source(ctx, m.updatedBy), t)
    }
}
