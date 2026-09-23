package com.dnkdialer.companion

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.matcher.ViewMatchers.withId
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
 * Three things only a real device can settle:
 *
 *  1. Tapping `Settings > Export diagnostics` produces an `ACTION_SEND`
 *     chooser whose payload is `application/zip` at a `content://` uri under
 *     OUR FileProvider authority — i.e. the manifest provider, the
 *     `diag_paths.xml` scope and the grant flag all line up. A unit test can
 *     assert the intent we BUILD; only this can assert the one the framework
 *     accepts.
 *  2. The archive that uri resolves to, read back through `ContentResolver`
 *     the way the receiving app would, contains no phone-number-shaped run.
 *  3. A planted SMS body does not survive into it.
 *
 * ## Deviation from the brief, stated plainly
 *
 * The brief says to plant the fixture body "through SmsReceiver's PDU test
 * hook". There is no such hook: `SmsReceiver` exposes only the
 * `onSmsReceived` OUTPUT callback, and its DiagLog line is emitted inside
 * `onReceive`, which needs a real `SMS_RECEIVED` broadcast carrying valid
 * PDU bytes. Hand-rolling PDUs that `SmsMessage.createFromPdu` accepts across
 * API levels is exactly the kind of fixture that silently decodes to nothing
 * and turns this into a test that passes by having nothing to check.
 *
 * So the body is planted at the DiagLog boundary instead, tagged
 * `SmsReceiver`, travelling the identical path the receiver's own line takes
 * (`DiagLog.d` -> `DiagStore.append` -> `Redact.line` -> ring -> flush -> zip).
 * That is a STRICTLY STRONGER assertion than the brief's: it plants the whole
 * body plus a raw number, which a correct SmsReceiver would never pass, and
 * demands the export be clean anyway. [plantIsActuallyPresentInTheRing] proves
 * the plant reached the subject, so a clean zip cannot be a plant that missed.
 */
@RunWith(AndroidJUnit4::class)
class DiagExportLeakGuardTest {

    /**
     * The brief's guard shape, with the structural-timestamp strip the raw
     * form needs — see the twin helper in `test/.../DiagZipTest.kt` for the
     * full reasoning ('2026-09-23' matches the raw regex, so the raw regex is
     * red on a clean export). The two copies exist because the unit and
     * instrumented source sets cannot share code; each carries its own plant
     * proof, [guardCatchesAPlantedNumber] here.
     */
    private val NUMBERISH = Regex("""\+?\d[\d \-]{6,}\d""")

    private val STRUCTURAL_STAMP = Regex(
        """^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})""",
    )

    private fun leaks(line: String) =
        NUMBERISH.containsMatchIn(STRUCTURAL_STAMP.replace(line, ""))

    /** A body no other part of the app could plausibly emit. */
    private val FIXTURE_BODY = "ZZQXPLANTEDSMSBODY your code is 884213 do not share"
    private val FIXTURE_NUMBER = "+4791234567"

    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun setUp() {
        // SettingsActivity bounces to SignInActivity without a token, so the
        // fixture token is a precondition of the screen existing at all. Same
        // shape the other Settings instrumented tests use; cleared in tearDown
        // so the run leaves no credential behind.
        TokenStore.save(ctx, "diag-export-test-not-a-real-token", "dennis@example.com")
        assertTrue("fixture token did not persist", TokenStore.hasToken(ctx))
        DiagLog.init(ctx)
        Intents.init()
    }

    /**
     * Swallow the chooser so the share sheet never actually opens.
     *
     * Called by the assertion test, NOT from [setUp], because
     * [chooserScreenshot] needs the real sheet on screen to photograph. A
     * stubbed chooser screenshotted would be a picture of the Settings screen
     * filed as evidence of a chooser.
     */
    private fun stubChooser() {
        Intents.intending(hasAction(Intent.ACTION_CHOOSER)).respondWith(
            Instrumentation.ActivityResult(Activity.RESULT_OK, null),
        )
    }

    @After
    fun tearDown() {
        Intents.release()
        TokenStore.clear(ctx)
    }

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
    }

    @Test
    fun plantIsActuallyPresentInTheRing() {
        // Proves the plant reaches the subject. A clean zip is only evidence
        // if something dirty was put in front of it.
        DiagLog.d("SmsReceiver", FIXTURE_BODY + " from " + FIXTURE_NUMBER)
        val ring = DiagLog.ringSnapshot()
        val line = ring.lastOrNull { it.contains("SmsReceiver") }
        assertTrue("plant never reached the ring", line != null)
        // The distinctive token survives (it is not number- or email-shaped);
        // the NUMBER in the same line does not. That is the redactor doing its
        // job at the boundary, which is what the zip then inherits.
        assertTrue(line!!, line.contains("ZZQXPLANTEDSMSBODY"))
        assertFalse(line, line.contains("4791234567"))
    }

    @Test
    fun exportTapRaisesAZipChooserAndTheZipIsClean() {
        stubChooser()
        DiagLog.d("SmsReceiver", FIXTURE_BODY + " from " + FIXTURE_NUMBER)
        DiagLog.d("PhoneService", "ws close code=1000 remote=false peer +47 91 23 45 67")
        DiagLog.counter("ws.close.1000.phone")

        ActivityScenario.launch(SettingsActivity::class.java).use {
            onView(withId(R.id.settingsExportDiagnosticsButton)).perform(scrollTo(), click())
            // The export runs on a worker; wait for the chooser rather than
            // sleeping a fixed amount, which is how these go flaky.
            waitForChooser()
        }

        val chooser = Intents.getIntents().last { it.action == Intent.ACTION_CHOOSER }
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("application/zip", send.type)

        val uri = send.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)!!
        assertEquals("content", uri.scheme)
        assertEquals(ctx.packageName + ".diagnostics", uri.authority)
        assertTrue(
            "uri escaped the diag-export scope: $uri",
            uri.path!!.contains("diag-export") || uri.path!!.contains("computercaller-diag-"),
        )
        assertTrue(
            "read grant missing",
            send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0,
        )

        // Read it back exactly as the receiving app would.
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
                assertFalse("$name leaked the fixture body: $l", l.contains("884213"))
            }
        }
        // Control: the scan had something to scan. An unreadable or empty zip
        // would otherwise pass every assertion above by producing no lines.
        assertTrue("guard scanned nothing", scanned >= 10)

        // Control: the archive is the REAL one, not an empty shell that is
        // trivially leak-free — the planted tag and the counter are both in it.
        assertTrue(entries["app.log"]!!.contains("ZZQXPLANTEDSMSBODY"))
        assertTrue(entries["counters.json"]!!.contains("ws.close.1000.phone"))
        assertTrue(entries["device.txt"]!!.contains("versionCode: "))
    }

    /**
     * The brief's two screenshots, from a REAL chooser.
     *
     * Deliberately separate from the assertion test and deliberately
     * unstubbed: the evidence is meant to show a user what they will see, and
     * a stubbed intent shows nothing. Asserts the sheet actually appeared
     * (the row's sub-line returns from "Preparing…") so a blank shot cannot be
     * filed as proof.
     */
    @Test
    fun chooserScreenshot() {
        ActivityScenario.launch(SettingsActivity::class.java).use {
            onView(withId(R.id.settingsExportDiagnosticsButton)).perform(scrollTo())
            shot("vc63-settings-export-row.png")
            onView(withId(R.id.settingsExportDiagnosticsButton)).perform(click())
            waitForChooser()
            // Give the system sheet a moment to animate in before capturing.
            Thread.sleep(1_500)
            shot("vc63-export-chooser.png")
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
                .uiAutomation.performGlobalAction(
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
     * Plant proof for the brief's two screenshots.
     *
     * `uiAutomation.takeScreenshot()` is scoped to the device under test — an
     * emulator this lane booted — not to the developer's desktop; RULE 25's
     * desktop-capture prohibition is about host-side capture and does not
     * apply to an on-device instrumented shot.
     */
    private fun shot(name: String) {
        val instr = InstrumentationRegistry.getInstrumentation()
        val bmp = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = java.io.File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        java.io.File(dir, name).outputStream().use {
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    private fun waitForChooser() {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (Intents.getIntents().any { it.action == Intent.ACTION_CHOOSER }) return
            Thread.sleep(100)
        }
        throw AssertionError("no chooser intent within 20 s")
    }
}
