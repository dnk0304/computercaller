package com.dnkdialer.companion

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the ring buffer + on-disk log, as pure JVM.
 *
 * All of the behaviour worth testing (wrap, 24 h prune, daily rotation, the
 * 2 MiB disk cap, counter persistence) lives here rather than in [DiagLog] so
 * the unit suite can drive it against a [org.junit.rules.TemporaryFolder] with
 * an injected clock. The module has no Robolectric, so anything that touches
 * `Context` is untestable on the JVM; the Android-specific part of DiagLog is
 * therefore reduced to "where is filesDir" and "which thread".
 *
 * Threading contract: every public method is `@Synchronized`. [DiagLog] calls
 * [append] from arbitrary threads (the socket reader, receivers, the UI) and
 * [flush] from exactly one background thread; the lock is uncontended in the
 * common case and held only for in-memory work on the append path — the disk
 * write happens inside [flush], on the background thread, which is the only
 * place a caller can block.
 *
 * @param dir     the `diag/` directory (created on demand)
 * @param nowMs   injectable clock; production passes `System::currentTimeMillis`
 */
class DiagStore(
    private val dir: File,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {

    companion object {
        /** In-memory ring capacity, in lines. */
        const val RING_CAPACITY = 2_000

        /** Flush when this many lines are pending, whichever comes first. */
        const val FLUSH_LINES = 200

        /** …or this long since the last flush. */
        const val FLUSH_INTERVAL_MS = 5_000L

        /** Retention window. Files whose day-stamp is older are deleted. */
        const val RETENTION_MS = 24L * 60 * 60 * 1000

        /** Hard ceiling on the total size of `diag-*.log`, oldest dropped first. */
        const val DISK_CAP_BYTES = 2L * 1024 * 1024

        const val COUNTERS_FILE = "counters.json"

        private const val LOG_PREFIX = "diag-"
        private const val LOG_SUFFIX = ".log"

        private fun utc(pattern: String) = SimpleDateFormat(pattern, Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
    }

    // SimpleDateFormat is not thread-safe; both are only ever touched under the
    // instance lock, which every public method takes.
    private val stampFmt = utc("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
    private val dayFmt = utc("yyyyMMdd")

    /**
     * The ring. An ArrayDeque used as a bounded FIFO — cheaper than a circular
     * array with an index, and `toList()` for the export tail is a plain copy
     * in insertion order.
     */
    private val ring = ArrayDeque<String>(RING_CAPACITY)

    /** Lines appended since the last successful [flush]. */
    private val pending = ArrayList<String>(FLUSH_LINES)

    /**
     * Seeded from the clock, NOT 0. At 0 the very first `now - lastFlushMs`
     * is the whole Unix epoch, so [shouldFlush] returns true on the first
     * append and the 5 s batching window never applies to the first line of
     * the process — which is exactly the burst (app start, socket open) the
     * batching exists to absorb.
     */
    private var lastFlushMs = nowMs()

    private val counters = LinkedHashMap<String, Long>()
    private var countersDirty = false

    /**
     * Format + redact + ring-buffer one line. Returns the stored line so the
     * caller (and the tests) can assert on exactly what was kept.
     *
     * Redaction happens HERE, before storage, not at the call site — see
     * [Redact]. A line is redacted once and only once; nothing downstream can
     * reach the raw text because the raw text is never retained.
     */
    @Synchronized
    fun append(level: String, tag: String, msg: String?): String {
        val line = stampFmt.format(Date(nowMs())) + " | " + level + " | " +
            Redact.line(tag) + " | " + Redact.line(msg)
        if (ring.size >= RING_CAPACITY) ring.removeFirst()
        ring.addLast(line)
        pending.add(line)
        return line
    }

    /** True when [append] has accumulated enough work, or enough time, to flush. */
    @Synchronized
    fun shouldFlush(): Boolean {
        if (pending.isEmpty() && !countersDirty) return false
        if (pending.size >= FLUSH_LINES) return true
        return nowMs() - lastFlushMs >= FLUSH_INTERVAL_MS
    }

    /**
     * Append pending lines to today's file, persist dirty counters, then apply
     * retention + the disk cap.
     *
     * Never throws: a diagnostics subsystem that can crash the app it is
     * diagnosing is worse than no diagnostics. The caller gets `false` and the
     * pending lines are DROPPED rather than retried — retrying an IO failure
     * forever is how a full disk becomes a wedged background thread. The ring
     * still holds them, so the export's in-memory tail keeps them either way.
     */
    @Synchronized
    fun flush(): Boolean {
        val ok = try {
            dir.mkdirs()
            if (pending.isNotEmpty()) {
                val f = File(dir, LOG_PREFIX + dayFmt.format(Date(nowMs())) + LOG_SUFFIX)
                f.appendText(pending.joinToString(separator = "\n", postfix = "\n"), Charsets.UTF_8)
            }
            if (countersDirty) {
                File(dir, COUNTERS_FILE).writeText(countersJson(), Charsets.UTF_8)
                countersDirty = false
            }
            true
        } catch (t: Throwable) {
            false
        }
        pending.clear()
        lastFlushMs = nowMs()
        try {
            prune()
        } catch (t: Throwable) {
            // best effort
        }
        return ok
    }

    /** Increment a named counter. Persisted on the next [flush]. */
    @Synchronized
    fun counter(name: String, by: Long = 1L) {
        counters[name] = (counters[name] ?: 0L) + by
        countersDirty = true
    }

    /** Immutable snapshot, insertion-ordered. */
    @Synchronized
    fun snapshotCounters(): Map<String, Long> = LinkedHashMap(counters)

    /** The in-memory ring, oldest first. Used by the export's `app.log` tail. */
    @Synchronized
    fun ringSnapshot(): List<String> = ring.toList()

    @Synchronized
    fun countersJson(): String = buildString {
        append("{\n")
        val entries = counters.entries.toList()
        entries.forEachIndexed { i, e ->
            append("  \"").append(e.key.replace("\"", "\\\"")).append("\": ").append(e.value)
            if (i < entries.size - 1) append(",")
            append("\n")
        }
        append("}\n")
    }

    /**
     * Load counters written by a previous process. Called once at start so an
     * export made after a restart still shows the cumulative totals, while the
     * LIVE counters the flap-storm gauge reads are per-process (the brief's
     * "counters reset on app process start" applies to the in-memory gauge —
     * `counters.json` is cumulative, and device.txt says which is which).
     */
    @Synchronized
    fun loadCountersFrom(text: String) {
        Regex("""\"([^\"]+)\"\s*:\s*(-?\d+)""").findAll(text).forEach { m ->
            counters[m.groupValues[1]] = m.groupValues[2].toLongOrNull() ?: 0L
        }
    }

    /** `diag-*.log` files, oldest day first. */
    @Synchronized
    fun logFiles(): List<File> =
        (dir.listFiles() ?: emptyArray())
            .filter { it.isFile && it.name.startsWith(LOG_PREFIX) && it.name.endsWith(LOG_SUFFIX) }
            .sortedBy { it.name }

    /**
     * Retention + cap. Run on every flush and at start.
     *
     * Age is taken from the DAY STAMP IN THE NAME, not from `lastModified()`:
     * an append rewrites mtime, so an mtime-based rule would keep yesterday's
     * file alive forever as long as the process kept writing to today's. A file
     * is dropped once its day is more than [RETENTION_MS] behind now.
     */
    @Synchronized
    fun prune() {
        val now = nowMs()
        val files = logFiles().toMutableList()
        val iter = files.iterator()
        while (iter.hasNext()) {
            val f = iter.next()
            val day = f.name.removePrefix(LOG_PREFIX).removeSuffix(LOG_SUFFIX)
            val dayStart = try {
                dayFmt.parse(day)?.time ?: continue
            } catch (t: Exception) {
                continue
            }
            // Keep a file until the END of its day is outside the window, so a
            // 23:59 line written yesterday survives its full 24 h.
            if (now - (dayStart + 24L * 60 * 60 * 1000) > RETENTION_MS) {
                f.delete()
                iter.remove()
            }
        }
        var total = files.sumOf { it.length() }
        val i2 = files.iterator()
        while (total > DISK_CAP_BYTES && i2.hasNext()) {
            val f = i2.next()
            // Never delete the file we are currently writing to; if it alone
            // busts the cap, truncating the whole day is the only option left.
            val len = f.length()
            if (files.size == 1) {
                f.writeText("", Charsets.UTF_8)
                total = 0
                break
            }
            f.delete()
            i2.remove()
            total -= len
        }
    }
}
