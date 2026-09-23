package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.ZipFile

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the archive.
 *
 * Two properties the brief names, plus the leak guard that the instrumented
 * test also runs on-device. Keeping the guard in BOTH places is deliberate:
 * the instrumented one proves the real export on a real device is clean, and
 * this one fails in seconds on every `testDebugUnitTest`, which is the run a
 * future change to a call site will actually trip over.
 */
class DiagZipTest {

    @get:Rule
    val tmp = TemporaryFolder()

    /**
     * The brief's leak-guard shape, plus the one correction the brief could
     * not have known it needed.
     *
     * `\+?\d[\d \-]{6,}\d` matches `2026-09-23` — which is the first ten
     * characters of EVERY line DiagStore writes, and of every logcat line's
     * `09-23 12:00:00.000` column once the year is in front of it. Run raw,
     * the guard fires on a perfectly clean export, and a guard that is red on
     * correct output gets "fixed" by whoever meets it next — usually by
     * deleting it.
     *
     * So the scan strips the STRUCTURAL timestamp first, anchored at position
     * 0 and in exactly the two formats this app emits. Anchoring is what keeps
     * this from being a hole: a number anywhere else in the line, including
     * immediately after the stamp, still gets caught.
     * [guardCatchesAPlantedNumberEverywhereExceptTheStamp] proves that rather
     * than asserting it.
     *
     * Kept in step with the identical helper in
     * `androidTest/.../DiagExportLeakGuardTest.kt` — the unit and instrumented
     * source sets cannot share code, so the two copies are deliberate and each
     * carries its own plant proof.
     */
    private val NUMBERISH = Regex("""\+?\d[\d \-]{6,}\d""")

    /** ISO-8601 (app.log) and logcat threadtime stamps, anchored at line start. */
    private val STRUCTURAL_STAMP = Regex(
        """^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})""",
    )

    private fun leaks(line: String): Boolean =
        NUMBERISH.containsMatchIn(STRUCTURAL_STAMP.replace(line, ""))

    @Test
    fun guardCatchesAPlantedNumberEverywhereExceptTheStamp() {
        val stamp = "2026-09-23T12:00:00.000Z"
        // Clean line: not flagged.
        assertFalse(leaks("$stamp | D | SmsReceiver | from num:bfc3db parts=2"))
        // Planted immediately after the stamp — the position stripping could
        // plausibly have hidden.
        assertTrue(leaks("$stamp +4712345678 | D | t | x"))
        // Planted mid-line.
        assertTrue(leaks("$stamp | D | SmsReceiver | from +4712345678 parts=2"))
        // Planted with separators.
        assertTrue(leaks("$stamp | D | t | 47 12 34 56 78"))
        // A second timestamp mid-line is NOT stripped, and that is correct:
        // only position 0 is structure.
        assertTrue(leaks("$stamp | D | t | seen 2026-09-23T12:00:00.000Z"))
    }

    private fun entries(zip: File): Map<String, String> =
        ZipFile(zip).use { z ->
            z.entries().toList().associate { e -> e.name to z.getInputStream(e).reader().readText() }
        }

    private fun build(
        logFiles: List<File> = emptyList(),
        ringTail: List<String> = listOf("2026-09-23T12:00:00.000Z | D | t | tail"),
        logcat: () -> String = { "09-23 12:00:00.000  1  1 D PhoneService: onOpen resume=false" },
    ): File = DiagZip.write(
        out = File(tmp.root, "out/diag.zip"),
        logFiles = logFiles,
        ringTail = ringTail,
        countersJson = "{\n  \"ws.open\": 3\n}\n",
        deviceTxt = "model: Pixel 7\nversionCode: 63\n",
        logcat = logcat,
    )

    @Test
    fun archiveHasExactlyTheFourEntries() {
        val e = entries(build())
        assertEquals(
            setOf(
                DiagZip.ENTRY_APP_LOG,
                DiagZip.ENTRY_COUNTERS,
                DiagZip.ENTRY_DEVICE,
                DiagZip.ENTRY_LOGCAT,
            ),
            e.keys,
        )
        // Control: each entry carries ITS content, so the set above is not
        // four empty entries with the right names.
        assertTrue(e[DiagZip.ENTRY_APP_LOG]!!.contains("tail"))
        assertTrue(e[DiagZip.ENTRY_COUNTERS]!!.contains("\"ws.open\": 3"))
        assertTrue(e[DiagZip.ENTRY_DEVICE]!!.contains("versionCode: 63"))
        assertTrue(e[DiagZip.ENTRY_LOGCAT]!!.contains("onOpen resume=false"))
    }

    @Test
    fun appLogConcatenatesRetainedFilesOldestFirstThenTheMemoryTail() {
        val a = File(tmp.root, "diag-20260922.log").apply { writeText("older\n") }
        val b = File(tmp.root, "diag-20260923.log").apply { writeText("newer\n") }
        val text = entries(build(logFiles = listOf(a, b)))[DiagZip.ENTRY_APP_LOG]!!
        assertTrue(text.indexOf("older") < text.indexOf("newer"))
        assertTrue(text.indexOf("newer") < text.indexOf("tail"))
        assertTrue(text.contains("--- in-memory tail ---"))
    }

    @Test
    fun anUnreadableLogFileDoesNotLoseTheRest() {
        val good = File(tmp.root, "diag-20260923.log").apply { writeText("kept\n") }
        val missing = File(tmp.root, "diag-20260921.log") // never created
        val text = entries(build(logFiles = listOf(missing, good)))[DiagZip.ENTRY_APP_LOG]!!
        assertTrue(text, text.contains("kept"))
        assertTrue(text, text.contains("unreadable: diag-20260921.log"))
    }

    // ------------------------------------------- brief: logcat failure path

    @Test
    fun logcatFailureStillYieldsAZipWithAllFourEntries() {
        val zip = build(logcat = { throw java.io.IOException("Cannot run program \"logcat\"") })
        val e = entries(zip)
        assertEquals(4, e.size)
        assertTrue(e[DiagZip.ENTRY_LOGCAT]!!.startsWith("logcat unavailable: java.io.IOException"))
        // Control: the OTHER three entries are unaffected — the point of the
        // catch is that an optional attachment cannot take the export with it.
        assertTrue(e[DiagZip.ENTRY_DEVICE]!!.contains("Pixel 7"))
        assertTrue(e[DiagZip.ENTRY_APP_LOG]!!.contains("tail"))
    }

    @Test
    fun logcatFailureMessageCarriesTheClassNotTheMessage() {
        // An exception message can carry a path, and a path can carry a user
        // name. Only the class name is written.
        val zip = build(logcat = { throw IllegalStateException("/data/user/0/com.x/files/dennis") })
        val body = entries(zip)[DiagZip.ENTRY_LOGCAT]!!
        assertTrue(body, body.contains("java.lang.IllegalStateException"))
        assertFalse(body, body.contains("dennis"))
    }

    // --------------------------------------------------------- leak guard

    @Test
    fun noEntryContainsAPhoneNumberShapedRun() {
        val zip = build(
            ringTail = listOf(DiagStore(File(tmp.root, "d")).append("D", "SmsReceiver", "from +4712345678 parts=2")),
            logcat = { "09-23 12:00:00.000 1 1 D PhoneService: dial to 004712345678 ok" },
        )
        var scanned = 0
        entries(zip).forEach { (name, body) ->
            body.lineSequence().filter { it.isNotBlank() }.forEach { l ->
                scanned++
                assertFalse("$name leaked a number: $l", leaks(l))
            }
        }
        // Control: the scan actually read the archive. Without this, an empty
        // or unreadable zip passes the guard by producing nothing to check —
        // the classic assertion satisfied by absence.
        assertTrue("guard scanned nothing", scanned >= 6)
    }

    @Test
    fun logcatIsFilteredToOurTagsAndRedacted() {
        val raw = buildString {
            append("09-23 12:00:00.000 1 1 D PhoneService: close code=1006\n")
            append("09-23 12:00:00.001 2 2 I SomeOtherApp: user +4712345678 did a thing\n")
            append("09-23 12:00:00.002 3 3 E AndroidRuntime: FATAL EXCEPTION\n")
        }
        val out = DiagZip.redactLogcat(raw)
        assertTrue(out, out.contains("close code=1006"))
        assertTrue(out, out.contains("FATAL EXCEPTION"))
        // Foreign tag dropped entirely — and with it the number it carried.
        assertFalse(out, out.contains("SomeOtherApp"))
        assertFalse(out, out.contains("4712345678"))
    }

    @Test
    fun logcatIsCappedAtOneMiB() {
        val line = "09-23 12:00:00.000 1 1 D PhoneService: " + "x".repeat(100) + "\n"
        val out = DiagZip.redactLogcat(line.repeat(40_000))
        assertTrue("cap not enforced: " + out.length, out.length <= DiagZip.LOGCAT_CAP_BYTES + 64)
        assertTrue(out, out.endsWith("--- truncated at " + DiagZip.LOGCAT_CAP_BYTES + " bytes ---\n"))
    }

    @Test
    fun emptyLogcatSaysSoRatherThanBeingBlank() {
        // A zero-byte logcat.txt reads as "the export is broken". Say which.
        assertEquals("(no matching logcat lines)\n", DiagZip.redactLogcat(""))
    }
}
