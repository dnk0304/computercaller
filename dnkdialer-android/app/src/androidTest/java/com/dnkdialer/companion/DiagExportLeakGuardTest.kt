package com.dnkdialer.companion

import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.zip.ZipInputStream

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the on-device proof.
 *
 * Four things only a real device can settle:
 *
 *  1. Tapping `Settings > Export diagnostics` actually raises an
 *     `ACTION_CHOOSER` — the row, the worker, the build and `startActivity`
 *     are wired end to end.
 *  2. The share payload is `application/zip` at a `content://` uri under OUR
 *     FileProvider authority, with the read grant set.
 *  3. That uri RESOLVES through `ContentResolver` the way the receiving app
 *     would — which is what proves the manifest `<provider>`, the
 *     `diag_paths.xml` scope and the grant all line up. A unit test can assert
 *     the Intent we build; only this can assert the one the framework serves.
 *  4. The archive behind it contains no phone-number-shaped run.
 *
 * ## Two deviations from the brief, stated plainly
 *
 * **(a) No espresso-intents, and no Espresso at all.** The brief says to
 * capture the chooser with `Intents.intended`. That needs the
 * `espresso-intents` artifact, which adds a `GradleDependency` lint cell and
 * would force regenerating the shared `e2e-evidence/LINT-BASELINE-android.json`
 * — an off-lane file on a lane whose hard gate is "zero files outside
 * dnkdialer-android/". `Instrumentation.ActivityMonitor` is the platform's own
 * equivalent, needs no dependency, and blocks the sheet from opening.
 * Separately, this was the only file in the module using Espresso at all, and
 * on this AVD the Activity's root window never reports `has-window-focus`, so
 * every Espresso ViewAction died in RootViewPicker; the rest of the module
 * drives Settings through `scenario.onActivity`, and so does this.
 *
 * **(b) The SMS body is planted at the DiagLog boundary, not through a "PDU
 * test hook".** There is no such hook: `SmsReceiver` exposes only the
 * `onSmsReceived` OUTPUT callback, and its DiagLog line is emitted inside
 * `onReceive`, which needs a real broadcast carrying valid PDU bytes.
 * Hand-rolling PDUs that `SmsMessage.createFromPdu` accepts across API levels
 * is exactly the fixture that silently decodes to nothing and leaves a test
 * passing with nothing to check. The plant travels the identical path the
 * receiver's own line takes (`DiagLog.d` -> `DiagStore.append` -> `Redact` ->
 * ring -> flush -> zip), and is STRICTLY STRONGER than the brief's: it passes
 * a whole body AND a raw number, which a correct `SmsReceiver` never would,
 * and still demands a clean export. [plantIsActuallyPresentInTheRing] proves
 * the plant landed and [guardCatchesAPlantedNumber] proves the detector fires,
 * so a clean zip cannot be a plant that missed or a guard that never worked.
 */
@RunWith(AndroidJUnit4::class)
class DiagExportLeakGuardTest {

    /**
     * The brief's leak-guard shape. Twin of the helper in
     * `test/.../DiagZipTest.kt`; the unit and instrumented source sets cannot
     * share code, so each copy carries its own plant proof.
     */
    private val NUMBERISH = Regex("""\+?\d[\d \-]{6,}\d""")

    /**
     * Structure stripped before the hunt — every rule ANCHORED or NAMED, never
     * a widened "dates are fine" exemption. See the twin helper for the full
     * reasoning.
     */
    private val APP_LOG_PREFIX = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z""")
    private val LOGCAT_PREFIX = Regex(
        """^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} +\d+ +\d+ +[VDIWEFAS] +[^:\n]{0,64}: ?""",
    )
    private val DEVICE_DATE_FIELD =
        Regex("""^(generatedUtc|securityPatch): \d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?""")

    private fun leaks(line: String): Boolean {
        var s = APP_LOG_PREFIX.replace(line, "")
        s = LOGCAT_PREFIX.replace(s, "")
        s = DEVICE_DATE_FIELD.replace(s, "")
        return NUMBERISH.containsMatchIn(s)
    }

    /**
     * A body no other part of the app could plausibly emit.
     *
     * Note what this test does and does NOT claim about it. The redactor
     * removes phone numbers, emails and over-long text; it cannot scrub
     * arbitrary prose, and the `884213` here is a SIX-digit one-time code
     * deliberately below [Redact.MIN_PHONE_DIGITS] (pinned by
     * `RedactTest.sixDigitCodesAreNotRemovedWhichIsWhyBodiesAreNeverLogged`).
     * That is not a hole in the export's promise — it is why the promise is
     * kept at the CALL SITES: no instrumented site passes a body, only `len=`.
     */
    private val FIXTURE_BODY = "ZZQXPLANTEDSMSBODY your code is 884213 do not share"
    private val FIXTURE_NUMBER = "+4791234567"

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun setUp() {
        // SettingsActivity bounces to SignInActivity without a token, so the
        // fixture token is a precondition of the screen existing at all.
        TokenStore.save(ctx, "diag-export-test-not-a-real-token", "dennis@example.com")
        assertTrue("fixture token did not persist", TokenStore.hasToken(ctx))
        DiagLog.init(ctx)
    }

    @After
    fun tearDown() {
        TokenStore.clear(ctx)
    }

    // ------------------------------------------------------- the detectors

    @Test
    fun guardCatchesAPlantedNumber() {
        // The detector, proved before it is trusted. Without this, every
        // assertFalse(leaks(..)) below could be passing because `leaks` is
        // broken rather than because the export is clean.
        val stamp = "2026-09-23T12:00:00.000Z"
        assertFalse(leaks("$stamp | D | t | from num:bfc3db parts=2"))
        assertTrue(leaks("$stamp | D | t | from $FIXTURE_NUMBER"))
        assertTrue(leaks("$stamp $FIXTURE_NUMBER"))
        assertTrue(leaks("$stamp | D | t | 47 91 23 45 67"))
        // device.txt's two NAMED date fields are not leaks…
        assertFalse(leaks("generatedUtc: 2026-09-23T10:20:57Z"))
        assertFalse(leaks("securityPatch: 2023-09-05"))
        // …but the exemption covers only that field's date value.
        assertTrue(leaks("securityPatch: 2023-09-05 and also $FIXTURE_NUMBER"))
        assertTrue(leaks("someNewDateField: 2023-09-05"))
        // The logcat header (pid/tid included) is excused; its message is not.
        assertFalse(leaks("09-23 12:00:00.000  1234  5678 D PhoneService: code=1006"))
        assertTrue(leaks("09-23 12:00:00.000  1234  5678 D PhoneService: to $FIXTURE_NUMBER"))
    }

    @Test
    fun plantIsActuallyPresentInTheRing() {
        // Proves the plant reaches the subject. A clean zip is only evidence
        // if something dirty was put in front of it.
        DiagLog.d("SmsReceiver", "$FIXTURE_BODY from $FIXTURE_NUMBER")
        val line = DiagLog.ringSnapshot().lastOrNull { it.contains("SmsReceiver") }
        assertTrue("plant never reached the ring", line != null)
        // The distinctive token survives (not number- or email-shaped); the
        // NUMBER in the same line does not. That is the redactor at the
        // boundary, which is what the zip then inherits.
        assertTrue(line!!, line.contains("ZZQXPLANTEDSMSBODY"))
        assertFalse(line, line.contains("4791234567"))
    }

    // --------------------------------------------- the export, end to end

    @Test
    fun exportTapRaisesAChooser() {
        // ActivityMonitor with block=true intercepts the chooser and stops it
        // opening, so the assertion is about OUR wiring and not about the
        // system sheet's timing.
        val monitor = instr.addMonitor(IntentFilter(Intent.ACTION_CHOOSER), null, true)
        try {
            ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
                tapExportRow(scenario)
                val deadline = System.currentTimeMillis() + 20_000
                while (monitor.hits == 0 && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100)
                }
                assertTrue(
                    "no chooser raised within 20 s of tapping Export diagnostics",
                    monitor.hits > 0,
                )
            }
        } finally {
            instr.removeMonitor(monitor)
        }
    }

    @Test
    fun theSharedArchiveIsServedByOurProviderAndIsClean() {
        DiagLog.d("SmsReceiver", "$FIXTURE_BODY from $FIXTURE_NUMBER")
        DiagLog.d("PhoneService", "ws close code=1000 remote=false peer +47 91 23 45 67")
        DiagLog.counter("ws.close.1000.phone")

        // Build + share exactly as SettingsActivity does.
        val zip = DiagExport.build(ctx)
        val diagId = DiagLog.diagId(ctx)
        val chooser = DiagExport.shareIntent(ctx, zip, diagId)

        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("application/zip", send.type)
        assertTrue(
            "subject does not carry the diagnostics id",
            send.getStringExtra(Intent.EXTRA_SUBJECT)!!.contains(diagId),
        )
        assertTrue(
            "read grant missing",
            send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0,
        )

        val uri = send.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)!!
        assertEquals("content", uri.scheme)
        assertEquals(ctx.packageName + ".diagnostics", uri.authority)
        // diag_paths.xml exposes cache-path diag-export/ and nothing else, so a
        // uri outside that prefix would mean the scope had been widened.
        assertTrue("uri escaped the diag-export scope: $uri", uri.path!!.contains("diag-export"))

        // Read it back the way the receiving app would. This is the part that
        // proves the provider actually SERVES the file, not just that we built
        // a plausible-looking uri.
        val entries = HashMap<String, String>()
        ctx.contentResolver.openInputStream(uri)!!.use { input ->
            ZipInputStream(input).use { zin ->
                var e = zin.nextEntry
                while (e != null) {
                    entries[e.name] = zin.readBytes().toString(Charsets.UTF_8)
                    e = zin.nextEntry
                }
            }
        }
        assertEquals(
            setOf("app.log", "counters.json", "device.txt", "logcat.txt"),
            entries.keys,
        )

        var scanned = 0
        entries.forEach { (name, body) ->
            body.lineSequence().filter { it.isNotBlank() }.forEach { l ->
                scanned++
                assertFalse("$name leaked a number: $l", leaks(l))
                assertFalse("$name leaked the fixture number: $l", l.contains("4791234567"))
            }
        }
        // Control: the scan had something to scan. An unreadable or empty zip
        // would otherwise pass every assertion above by producing no lines.
        assertTrue("guard scanned nothing", scanned >= 10)

        // Control: this is the REAL archive, not an empty shell that is
        // trivially leak-free — the planted tag and the counter are both in it.
        assertTrue(entries["app.log"]!!.contains("ZZQXPLANTEDSMSBODY"))
        assertTrue(entries["counters.json"]!!.contains("ws.close.1000.phone"))
        assertTrue(entries["device.txt"]!!.contains("versionCode: "))
    }

    // ----------------------------------------------------------- evidence

    /**
     * The brief's two screenshots, from a REAL (un-intercepted) chooser.
     *
     * Deliberately separate from the assertion tests: the evidence is meant to
     * show a user what they will see, and an intercepted chooser shows
     * nothing. Both shots are size-asserted so a failed capture cannot be
     * filed as proof.
     */
    @Test
    fun chooserScreenshot() {
        ActivityScenario.launch(SettingsActivity::class.java).use { scenario ->
            scenario.onActivity { a ->
                a.findViewById<android.view.View>(R.id.settingsExportDiagnosticsButton)
                    .requestRectangleOnScreen(android.graphics.Rect(0, 0, 1, 1), true)
            }
            instr.waitForIdleSync()
            Thread.sleep(500)
            shot("vc63-settings-export-row.png")
            tapExportRow(scenario)
            waitForShareSheet()
            shot("vc63-export-chooser.png")
            instr.uiAutomation.performGlobalAction(
                android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK,
            )
            Thread.sleep(500)
        }
        val dir = java.io.File(ctx.getExternalFilesDir(null), "screenshots")
        listOf("vc63-settings-export-row.png", "vc63-export-chooser.png").forEach {
            val f = java.io.File(dir, it)
            assertTrue("missing screenshot $it", f.isFile)
            // A 0-byte or trivially small PNG is a failed capture filed as
            // evidence; 20 KiB is far below a real screen and far above that.
            assertTrue("screenshot $it is only ${f.length()} B", f.length() > 20_000)
        }
    }

    /**
     * Tap the row the way the rest of this module drives Settings.
     *
     * `performClick()` on the UI thread dispatches the same OnClickListener a
     * real tap does, which is the behaviour under test; window focus — which
     * this AVD never grants — is not.
     */
    private fun tapExportRow(scenario: ActivityScenario<SettingsActivity>) {
        scenario.onActivity { a ->
            val row = a.findViewById<android.view.View>(R.id.settingsExportDiagnosticsButton)
            assertTrue("export row is not enabled", row.isEnabled)
            assertTrue("export row click was not consumed", row.performClick())
        }
    }

    /** Wait for the archive to exist, rather than sleeping blind. */
    private fun waitForShareSheet() {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val dir = java.io.File(ctx.cacheDir, DiagExport.EXPORT_DIR)
            if ((dir.listFiles()?.size ?: 0) > 0) {
                // The zip exists, so startActivity has been called (or is one
                // frame away). Give the sheet a beat to animate in.
                Thread.sleep(2_000)
                return
            }
            Thread.sleep(100)
        }
        throw AssertionError("export produced no archive within 20 s")
    }

    /**
     * On-device capture, scoped to the emulator under test — RULE 25's
     * desktop-capture prohibition is about host-side capture and does not
     * apply here.
     */
    private fun shot(name: String) {
        val bmp = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = java.io.File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        java.io.File(dir, name).outputStream().use {
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
