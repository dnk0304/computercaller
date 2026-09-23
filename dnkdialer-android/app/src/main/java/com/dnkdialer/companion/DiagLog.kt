package com.dnkdialer.companion

import android.content.Context
import androidx.core.content.edit
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the app-wide diagnostics log.
 *
 * Origin: INC-0923. A v62 socket flap storm ate a FILE_ACCEPT and a latched
 * downgrade turned every later pairing attempt into an instant decline. Both
 * were only visible in the RELAY's logs; the phone side was blind, so the
 * incident cost a day of log archaeology and a guess. This object is the phone
 * side of that story — and `Settings > Export diagnostics` is how it reaches
 * Ken without a USB cable or a debug build.
 *
 * ## What this is NOT
 *
 * It is not a replacement for `android.util.Log`. Every instrumented site keeps
 * its existing Log call and ADDS a DiagLog line, because logcat is still the
 * better tool when the device is in front of you, and because a lane that
 * rewrote 60 Log calls would be a much riskier diff than one that adds 60.
 *
 * ## The redaction contract
 *
 * Call sites pass METADATA ONLY: ids, byte counts, status codes, enum names,
 * fingerprint prefixes, booleans. Never a message body, notification text,
 * contact name, file name, token, device key or SAS digit. [Redact] runs inside
 * [DiagStore.append] as defence in depth — see its header for why the policy
 * and the mechanism are deliberately separate.
 *
 * ## Threading
 *
 * [d]/[w]/[e]/[counter] are callable from any thread and never do disk IO. One
 * background thread owns every write: a 5 s tick flushes if [DiagStore] says
 * it is time, and an append that fills the 200-line batch submits an immediate
 * flush. Nothing in the app ever blocks on the log except [flushBlocking],
 * which only the export path calls.
 */
object DiagLog {

    private const val TAG = "DiagLog"

    @Volatile
    private var store: DiagStore? = null

    @Volatile
    private var exec: ScheduledExecutorService? = null

    @Volatile
    private var diagIdCache: String? = null

    /** Close timestamps inside the rolling flap window; guarded by [flapLock]. */
    private val flapCloses = ArrayDeque<Long>()
    private val flapLock = Any()

    /** Rolling window for the flap-storm gauge. */
    private const val FLAP_WINDOW_MS = 60_000L

    /** Closes within the window at which FLAP_STORM starts being emitted. */
    private const val FLAP_THRESHOLD = 3

    private const val PREFS = "diag_prefs"
    private const val KEY_DIAG_ID = "diagId"

    /** `filesDir/diag` — the ring's on-disk home and the export's source. */
    fun dir(context: Context): File = File(context.filesDir, "diag")

    /**
     * Start the log. Called once from [CompanionApp.onCreate], i.e. before any
     * Activity, Service or Receiver of ours can run — which is what lets every
     * other call site treat DiagLog as always-available.
     *
     * Idempotent: a second call is a no-op, so a test or a restarted process
     * cannot end up with two flush threads racing on the same file.
     */
    @Synchronized
    fun init(context: Context) {
        if (store != null) return
        val app = context.applicationContext
        val s = DiagStore(dir(app))
        // Cumulative totals survive the restart; the in-memory gauges do not.
        // device.txt states that distinction so nobody reads counters.json as
        // "since boot".
        try {
            val f = File(dir(app), DiagStore.COUNTERS_FILE)
            if (f.isFile) s.loadCountersFrom(f.readText(Charsets.UTF_8))
        } catch (t: Throwable) {
            // absent or corrupt — start from zero, never fail startup
        }
        store = s
        try {
            s.prune()
        } catch (t: Throwable) {
        }
        val e = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "DiagLog").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
        }
        e.scheduleWithFixedDelay(
            { if (s.shouldFlush()) s.flush() },
            DiagStore.FLUSH_INTERVAL_MS,
            DiagStore.FLUSH_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        exec = e
        d(TAG, "diag start ver=${BuildConfig.VERSION_CODE} id=${diagId(app)}")
    }

    fun d(tag: String, msg: String) = write("D", tag, msg)
    fun w(tag: String, msg: String) = write("W", tag, msg)
    fun e(tag: String, msg: String) = write("E", tag, msg)

    private fun write(level: String, tag: String, msg: String) {
        val s = store ?: return
        s.append(level, tag, msg)
        if (s.shouldFlush()) {
            try {
                exec?.execute { s.flush() }
            } catch (t: Throwable) {
                // executor shut down — the ring still holds the line
            }
        }
    }

    /** Increment a named counter (see the flap-storm set in the brief). */
    fun counter(name: String) {
        store?.counter(name)
    }

    fun snapshotCounters(): Map<String, Long> = store?.snapshotCounters() ?: emptyMap()

    fun ringSnapshot(): List<String> = store?.ringSnapshot() ?: emptyList()

    /**
     * Flush on the CALLING thread and wait. Only the export uses this — it must
     * see the in-memory tail on disk before it zips `app.log`. Never call it
     * from the main thread; [DiagExport] runs on a worker.
     */
    fun flushBlocking(): Boolean = store?.flush() ?: false

    /**
     * Record a socket close for the flap-storm gauge and emit `FLAP_STORM` once
     * the rolling 60 s window holds [FLAP_THRESHOLD] or more.
     *
     * The gauge is what makes T-INC-0923-PHONE-FLAP diagnosable from a user's
     * zip: the relay saw three paired 1000-closes in 71 s, and the phone log
     * said nothing. A per-close counter alone would not have shown the BURST —
     * a healthy week and a bad minute produce the same total.
     */
    fun noteSocketClose() {
        counter("ws.close.any")
        val n: Int
        synchronized(flapLock) {
            val now = System.currentTimeMillis()
            flapCloses.addLast(now)
            while (flapCloses.isNotEmpty() && now - flapCloses.first() > FLAP_WINDOW_MS) {
                flapCloses.removeFirst()
            }
            n = flapCloses.size
        }
        if (n >= FLAP_THRESHOLD) {
            counter("ws.flapstorm")
            w(TAG, "FLAP_STORM n=$n window=60s")
        }
    }

    /**
     * Stable, non-reversible install handle: the first 4 bytes of
     * SHA-256(ANDROID_ID + applicationId), rendered as 8 letters (see below).
     *
     * Purpose (brief §3): when a zip cannot be attached, the user reads this
     * eight-character string over Discord and Ken matches it to the relay logs.
     * ANDROID_ID is already per-app-signing-key scoped on API 26+, and hashing
     * it with the package id means the value we print is not the raw platform
     * identifier — so it is a support handle, not a tracking id, and it cannot
     * be correlated with any other app's.
     *
     * Persisted so it survives an ANDROID_ID change (factory reset restores a
     * different one; the stored handle keeps a long-running support thread
     * coherent).
     *
     * ## Why a 16-LETTER alphabet and not hex
     *
     * An 8-character hex handle is all-digits roughly 1 time in 43. That handle
     * is then printed into `app.log` and `device.txt` — and [Redact] rewrites
     * any run of 7+ digits into `num:<hash>`. The redactor would eat the very
     * id the export exists to be quoted by, for ~2 % of installs, and it would
     * do it silently. Mapping each nibble to `a`..`p` keeps the same 32 bits of
     * entropy, stays trivially readable over Discord, and can never match a
     * phone-number shape. This is the same class of bug as a log line that
     * redacts its own correlation key; it is cheaper to make the key unmatchable
     * than to special-case the redactor.
     */
    // HardwareIds: ANDROID_ID is read ONCE and never stored, transmitted or
    // printed in raw form — only SHA-256(ANDROID_ID + packageName) truncated to
    // 32 bits leaves this function. Since API 26 the value is already scoped
    // per app-signing-key, so it is not a cross-app identifier to begin with,
    // and the hash makes the published handle unusable as one even in
    // principle. The alternative, a random UUID, would not survive a reinstall
    // and would therefore break the one thing the handle exists for: matching a
    // user's support thread to relay logs across a reinstall.
    @android.annotation.SuppressLint("HardwareIds")
    fun diagId(context: Context): String {
        diagIdCache?.let { return it }
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_DIAG_ID, null)?.let { diagIdCache = it; return it }
        val androidId = try {
            android.provider.Settings.Secure.getString(
                app.contentResolver,
                android.provider.Settings.Secure.ANDROID_ID,
            ) ?: ""
        } catch (t: Throwable) {
            ""
        }
        val id = encodeHandle(
            java.security.MessageDigest.getInstance("SHA-256")
                .digest((androidId + app.packageName).toByteArray(Charsets.UTF_8)),
        )
        prefs.edit { putString(KEY_DIAG_ID, id) }
        diagIdCache = id
        return id
    }

    /** First 4 bytes of [digest] as 8 characters of `a`..`p`. See [diagId]. */
    fun encodeHandle(digest: ByteArray): String = buildString(8) {
        for (i in 0 until 4) {
            val b = digest[i].toInt() and 0xFF
            append('a' + (b shr 4))
            append('a' + (b and 0x0F))
        }
    }
}
