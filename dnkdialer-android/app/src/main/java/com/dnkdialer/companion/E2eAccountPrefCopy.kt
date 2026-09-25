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

    fun noticeText(ctx: Context, n: E2eAccountPref.Notice): String =
        ctx.getString(R.string.e2e_pref_notice_on, source(ctx, n.updatedBy), time(n.updatedAt) ?: "--:--")

    fun changedByLine(ctx: Context, m: E2eAccountPref.Resolved): String? {
        if (m.updatedBy == null) return null
        val t = time(m.updatedAt) ?: return null
        return ctx.getString(R.string.e2e_pref_changed_by, source(ctx, m.updatedBy), t)
    }
}
