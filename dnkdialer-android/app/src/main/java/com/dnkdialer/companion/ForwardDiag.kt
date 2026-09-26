package com.dnkdialer.companion

/**
 * vc70 NOTIF-FORWARDING T4 — the DiagLog side of the notification mirror.
 *
 * Before this, a notification the filter refused, a frame the E2E gate refused
 * and a backfill that ran too early were all logcat-only (or not logged at
 * all), so Dennis's DiagExport could not say why a bank alert never reached the
 * computer. Every line here is METADATA: a reason enum, a frame type, a count,
 * a trigger name and an 8-hex keyed package hash. Never a package name, title or body
 * (SPEC-PLAIN-PRIVACY-9).
 *
 * Counters always increment; the per-event LINES are rate-limited (20/min per
 * drop reason, 20/min for gate drops) so a chatty app cannot flood the
 * 200-line ring and push out the lines that explain an incident.
 */
object ForwardDiag {
    private const val TAG = "NotifFwd"

    // One budget PER REASON: on a live phone our own foreground notification
    // is re-posted on every connection change, and with a shared budget those
    // own_pkg lines starved the one line that matters (emulator proof, vc70).
    private val dropLines = java.util.concurrent.ConcurrentHashMap<NotificationBackfill.DropReason, DiagRateLimiter>()
    private val gateLines = DiagRateLimiter()

    fun notifDrop(reason: NotificationBackfill.DropReason, pkg: String?, backfill: Boolean) {
        DiagLog.counter("notif.drop.${reason.key}")
        if (dropLines.getOrPut(reason) { DiagRateLimiter() }.tryAcquire()) {
            DiagLog.d(
                TAG,
                "notif drop reason=${reason.key} pkg=${pkgHandle(pkg)} " +
                    "path=${if (backfill) "backfill" else "live"}",
            )
        }
    }

    /** Keyed handle; "nokey" (never an unsalted hash) if [PkgHashKey] is not ready. */
    private fun pkgHandle(pkg: String?): String {
        if (pkg == null) return "none"
        val key = PkgHashKey.get() ?: return "nokey"
        return NotificationBackfill.pkgHash(pkg, key)
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
