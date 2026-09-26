package com.dnkdialer.companion

/**
 * vc70 NOTIF-FORWARDING T4 — the DiagLog side of the notification mirror.
 *
 * Before this, a notification the filter refused, a frame the E2E gate refused
 * and a backfill that ran too early were all logcat-only (or not logged at
 * all), so Dennis's DiagExport could not say why a bank alert never reached the
 * computer. Every line here is METADATA: a reason enum, a frame type, a count,
 * a trigger name and an 8-hex package hash. Never a package name, title or body
 * (SPEC-PLAIN-PRIVACY-9).
 *
 * Counters always increment; the per-event LINES are rate-limited (20/min per
 * family) so a chatty app cannot flood the 200-line ring and push out the
 * lines that explain an incident.
 */
object ForwardDiag {
    private const val TAG = "NotifFwd"

    private val dropLines = DiagRateLimiter()
    private val gateLines = DiagRateLimiter()

    fun notifDrop(reason: NotificationBackfill.DropReason, pkg: String?, backfill: Boolean) {
        DiagLog.counter("notif.drop.${reason.key}")
        if (dropLines.tryAcquire()) {
            DiagLog.d(
                TAG,
                "notif drop reason=${reason.key} pkg=${pkg?.let { NotificationBackfill.pkgHash(it) } ?: "none"} " +
                    "path=${if (backfill) "backfill" else "live"}",
            )
        }
    }

    fun notifForwarded() = DiagLog.counter("notif.fwd")

    /** [type] is our own frame-type literal; [code] is an [E2eFrameGate] drop code. */
    fun gateDrop(type: String, code: String) {
        DiagLog.counter("e2e.gate.drop.$type")
        if (gateLines.tryAcquire()) DiagLog.w(TAG, "e2e gate drop type=$type reason=$code")
    }

    fun line(msg: String) = DiagLog.d(TAG, msg)
}

/**
 * At most [max] acquisitions per rolling [windowMs]. Pure (clock injected) so
 * the budget is unit-testable without sleeping.
 */
class DiagRateLimiter(
    private val max: Int = 20,
    private val windowMs: Long = 60_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val stamps = ArrayDeque<Long>()

    @Synchronized
    fun tryAcquire(): Boolean {
        val now = clock()
        while (stamps.isNotEmpty() && now - stamps.first() >= windowMs) stamps.removeFirst()
        if (stamps.size >= max) return false
        stamps.addLast(now)
        return true
    }
}
