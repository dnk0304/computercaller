package com.dnkdialer.companion

import java.io.File
import java.io.IOException
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the zip writer, as pure JVM.
 *
 * Split out of [DiagExport] for the same reason [DiagStore] is split out of
 * [DiagLog]: the module has no Robolectric, so anything holding a `Context` is
 * unreachable from the unit suite. Everything the brief asks the unit tests to
 * prove about the archive — that it carries all four entries, and that a
 * logcat failure still yields a zip — is decided here.
 *
 * The archive is fixed at exactly four entries:
 *
 *  - `app.log`      — the retained `diag-*.log` files, oldest first, then the
 *                     in-memory ring tail. Already redacted: every line in it
 *                     went through [Redact] on its way into [DiagStore].
 *  - `counters.json`— cumulative counters, including the flap-storm set.
 *  - `device.txt`   — build / permission / pairing facts, built by the caller.
 *  - `logcat.txt`   — our own process's logcat, re-redacted line by line.
 *
 * ## Why logcat failure cannot fail the export
 *
 * `logcat -d --pid=<me>` is the one input here that depends on a binary the
 * platform is free to move, restrict or kill (OEM builds do all three). The
 * export exists to be sent by a user who is ALREADY having a bad day; an
 * export that refuses to produce a file because an optional attachment was
 * unavailable is worse than useless. So [write] takes a provider that is
 * allowed to throw, catches it, and writes `logcat unavailable: <class>` into
 * the entry. The other three entries are ours and always exist.
 */
object DiagZip {

    const val ENTRY_APP_LOG = "app.log"
    const val ENTRY_COUNTERS = "counters.json"
    const val ENTRY_DEVICE = "device.txt"
    const val ENTRY_LOGCAT = "logcat.txt"

    /** Hard cap on the logcat entry, per the brief. */
    const val LOGCAT_CAP_BYTES = 1024 * 1024

    /**
     * Build the archive.
     *
     * @param out        destination file; parent directories are created
     * @param logFiles   retained `diag-*.log`, oldest first
     * @param ringTail   the in-memory ring, already redacted, oldest first
     * @param countersJson  contents of the `counters.json` entry
     * @param deviceTxt  contents of the `device.txt` entry
     * @param logcat     provider for raw logcat text; MAY throw — see the class
     *                   header. Its output is passed through [Redact.line] per
     *                   line regardless of where it came from.
     */
    @Throws(IOException::class)
    fun write(
        out: File,
        logFiles: List<File>,
        ringTail: List<String>,
        countersJson: String,
        deviceTxt: String,
        logcat: () -> String,
    ): File {
        out.parentFile?.mkdirs()
        ZipOutputStream(out.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry(ENTRY_APP_LOG))
            for (f in logFiles) {
                try {
                    f.forEachLine(Charsets.UTF_8) { zip.write((it + "\n").toByteArray(Charsets.UTF_8)) }
                } catch (t: Throwable) {
                    zip.write(("--- unreadable: " + f.name + " ---\n").toByteArray(Charsets.UTF_8))
                }
            }
            // The tail is what the flush could not reach — the last seconds
            // before the user tapped Export, which for a flap storm is exactly
            // the interesting part.
            zip.write("--- in-memory tail ---\n".toByteArray(Charsets.UTF_8))
            for (l in ringTail) zip.write((l + "\n").toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(ENTRY_COUNTERS))
            zip.write(countersJson.toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(ENTRY_DEVICE))
            zip.write(deviceTxt.toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(ENTRY_LOGCAT))
            val text = try {
                redactLogcat(logcat())
            } catch (t: Throwable) {
                "logcat unavailable: " + t.javaClass.name + "\n"
            }
            zip.write(text.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        return out
    }

    /**
     * Filter to our own tags, redact every line, cap at [LOGCAT_CAP_BYTES].
     *
     * Redaction is unconditional even though most of these lines were emitted
     * by our own code: logcat carries `AndroidRuntime` stack traces, whose
     * messages are whatever an exception happened to interpolate, and that is
     * precisely the path by which a phone number reaches a crash log.
     */
    fun redactLogcat(raw: String): String {
        val sb = StringBuilder()
        for (l in raw.lineSequence()) {
            if (l.isEmpty()) continue
            if (!TAG_FILTER.containsMatchIn(l)) continue
            val red = redactThreadtimeLine(l)
            if (sb.length + red.length + 1 > LOGCAT_CAP_BYTES) {
                sb.append("--- truncated at ").append(LOGCAT_CAP_BYTES).append(" bytes ---\n")
                break
            }
            sb.append(red).append('\n')
        }
        return if (sb.isEmpty()) "(no matching logcat lines)\n" else sb.toString()
    }

    /**
     * Redact a threadtime line's MESSAGE, leaving its header intact.
     *
     * ## Why this is not just `Redact.line(wholeLine)`
     *
     * A threadtime line opens `MM-DD HH:MM:SS.mmm  PID  TID L Tag:`. The
     * millis, pid and tid are digits separated by spaces, so the redactor's
     * "7+ digits with separators" rule sees `123  1234  5678` as ONE phone
     * number and rewrites the three columns into a single `num:` token —
     * producing `09-23 12:25:46.num:946d9a D Tag: ...`.
     *
     * That is worse than cosmetic. The pid/tid columns are how you tell the
     * socket reader thread's close from the main thread's, which is exactly
     * the attribution INC-0923 needed and did not have. The redactor was
     * silently destroying the most useful column in the file.
     *
     * So the header is parsed off as STRUCTURE and passed through verbatim,
     * and only the message — the part that carries interpolated content, and
     * the only part an exception message or a stray log call can put a number
     * into — goes through [Redact]. A line that does not match the threadtime
     * shape is redacted whole, which is the safe default.
     */
    fun redactThreadtimeLine(line: String): String {
        val m = THREADTIME_HEADER.find(line) ?: return Redact.line(line)
        return m.value + Redact.line(line.substring(m.value.length))
    }

    /**
     * `MM-DD HH:MM:SS.mmm  PID  TID L Tag: ` — anchored at position 0, with
     * every field's shape pinned, so it cannot match anything inside a message.
     */
    private val THREADTIME_HEADER = Regex(
        """^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} +\d+ +\d+ +[VDIWEFAS] +[^:\n]{0,64}: ?""",
    )

    /**
     * Tag allowlist from the brief. Matched anywhere in the threadtime line
     * rather than parsed out of it, because the threadtime tag column is
     * space-padded and truncated differently across API levels — an exact
     * column parse is the kind of thing that silently yields an empty file.
     */
    private val TAG_FILTER = Regex(
        "PhoneService|MainActivity|FileTransfer|CallHandler|MmsHandler|NotifListener|" +
            "AccountActions|SettingsActivity|SyncedDataActivity|E2e|DiagLog|AndroidRuntime",
    )
}
