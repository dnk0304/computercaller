package com.dnkdialer.companion

import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatDelegate
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
import java.io.File

/**
 * vc70 item 10 (PHONE-STATUS) — Dennis's 2026-09-26 08:21-08:23Z sequence,
 * replayed through the PRODUCTION MainActivity, both themes, every state
 * asserted on the live view tree and captured.
 *
 * ## What is scripted, honestly
 *
 * The relay URL is a hard-coded production constant (PhoneService
 * `wss://computercaller.com/relay/phone`), so an in-test relay cannot be
 * dialled without adding a URL seam to product code — out of scope. What is
 * scripted instead is what the relay's frames turn into on the phone: the
 * per-tick service facts ([PhoneConnStatus.Obs]) fed through
 * [MainActivity.driveConnStatusForTest] into the PRODUCTION state machine and
 * the PRODUCTION painters, plus the two REAL broadcasts the service sends on
 * this path — `E2E_SAS_REQUIRED` (the code screen) and `PAIRING_E2E_REFUSED`
 * (the refusal) — received by the production receiver.
 *
 * Final state must NOT show "verified", the footer, or the red error.
 */
@RunWith(AndroidJUnit4::class)
class PhoneStatusReplayTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private val refusedMsg get() = ctx.getString(R.string.e2e_sas_refused)

    @Before
    fun signIn() {
        TokenStore.save(ctx, "vc70-status-fixture-not-a-real-token", "dennis@example.com")
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        dir().listFiles { f -> f.name.startsWith("status-") || f.name.startsWith("top-") }?.forEach { it.delete() }
    }

    @After
    fun tearDown() {
        setNightMode(AppCompatDelegate.MODE_NIGHT_YES)
        TokenStore.clear(ctx)
    }

    private fun obs(
        t: Long, socket: Boolean = true, active: Boolean, key: String?,
        session: Boolean, sas: Boolean = false, pendingSas: String? = null,
    ) = PhoneConnStatus.Obs(
        nowMs = t, socketOpen = socket, pairActive = active, pairKey = key,
        e2e = PhoneConnStatus.liveState(session, sas), pendingSasPairingId = pendingSas,
    )

    @Test
    fun dennis_0821_sequence_both_themes() {
        for ((suffix, mode) in listOf(
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
        )) {
            setNightMode(mode)
            ActivityScenario.launch(MainActivity::class.java).use { sc ->
                settle()
                // 1 — before: pair A, switch ON, codes checked on this pair.
                step(sc, "1-codes-checked-$suffix", obs(0, active = true, key = "A", session = true, sas = true)) { a ->
                    assertStatus(a, R.string.status_connected_encrypted)
                    assertReasonHas(a, R.string.home_e2e_now_verified)
                }
                // 2 — switch OFF sent during pair A -> reset; the phone socket closes.
                step(
                    sc, "2-switching-$suffix",
                    obs(1_000, socket = false, active = false, key = "A", session = false),
                    event = { it.onSwitchSent(false, "A", 0) },
                ) { a ->
                    assertStatus(a, R.string.status_switching)
                    assertReasonHas(a, R.string.home_e2e_now_switching)
                    assertFooter(a, false)
                }
                // 3 — web re-paired with stale mode1: pair B asks for codes (REAL broadcast).
                sendSasRequired("B", "41290")
                step(sc, "3-code-screen-$suffix", obs(20_000, active = true, key = "B", session = true, pendingSas = "B")) { a ->
                    assertEquals("the code screen must be up for B", View.VISIBLE, a.findViewById<View>(R.id.homeHeroSas).visibility)
                    assertStatus(a, R.string.status_connected_encrypted_unverified)
                }
                // 4 — codes refused on B (REAL broadcast); pair B torn down.
                sendRefused("B", refusedMsg)
                step(sc, "4-refused-$suffix", obs(80_000, active = false, key = "B", session = false)) { a ->
                    assertEquals(View.GONE, a.findViewById<View>(R.id.homeHeroSas).visibility)
                    assertError(a, refusedMsg)
                }
                // 5 — second re-pair, mode0 with keys -> ACTIVE (08:23:04). THE screenshot state.
                step(sc, "5-final-no-code-check-$suffix", obs(105_000, active = true, key = "C", session = true)) { a ->
                    assertStatus(a, R.string.status_connected_encrypted_unverified)
                    assertReasonHas(a, R.string.home_e2e_now_unverified)
                    assertFooter(a, false)
                    assertError(a, null)
                    val shown = CopyRules.visibleText(a.window.decorView)
                    assertFalse("final state must not say 'verified': $shown", shown.any { Regex("\\bverified\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) })
                    assertFalse("no 'next connection' footer: $shown", shown.any { it.contains("next connection", true) })
                    assertEquals(View.GONE, a.findViewById<View>(R.id.homeHeroSas).visibility)
                    CopyRules.assertNoEndToEndClaim(a.window.decorView)
                }
            }
        }
        assertEquals("10 captures (5 states x 2 themes)", 10, shots("status-").size)
    }

    @Test
    fun code_screen_goes_when_its_pair_ends_without_a_refusal() {
        ActivityScenario.launch(MainActivity::class.java).use { sc ->
            settle()
            sendSasRequired("N", "12345")
            drive(sc, obs(0, active = true, key = "N", session = true, pendingSas = "N"))
            sc.onActivity { a -> assertEquals(View.VISIBLE, a.findViewById<View>(R.id.homeHeroSas).visibility) }
            // Pair terminated / room reset: the gate was released, no refusal broadcast.
            drive(sc, obs(2_000, active = false, key = "N", session = false))
            sc.onActivity { a ->
                assertEquals("never a code screen for a dead pair", View.GONE, a.findViewById<View>(R.id.homeHeroSas).visibility)
                assertError(a, null)
            }
        }
    }

    @Test
    fun reset_failure_shows_footer_and_retry_clears_it_both_themes() {
        for ((suffix, mode) in listOf(
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
        )) {
            setNightMode(mode)
            ActivityScenario.launch(MainActivity::class.java).use { sc ->
                settle()
                drive(sc, obs(0, active = true, key = "P1", session = true, sas = true), event = { it.onSwitchSent(false, "P1", 0) })
                step(sc, "6-reset-failed-$suffix", obs(PhoneConnStatus.RESET_TIMEOUT_MS, active = true, key = "P1", session = true, sas = true)) { a ->
                    assertFooter(a, true)
                    assertEquals(ctx.getString(R.string.home_e2e_switch_retry), a.findViewById<TextView>(R.id.homeE2eSwitchRetry).text.toString())
                    assertStatus(a, R.string.status_connected_encrypted)
                }
                // Retry sent -> Switching…; then the new pair -> footer gone.
                drive(sc, obs(61_000, active = true, key = "P1", session = true, sas = true), event = { it.onRetrySent(61_000) })
                sc.onActivity { a -> assertFooter(a, false); assertStatus(a, R.string.status_switching) }
                drive(sc, obs(70_000, active = true, key = "P2", session = true))
                sc.onActivity { a ->
                    assertFooter(a, false)
                    assertStatus(a, R.string.status_connected_encrypted_unverified)
                }
            }
        }
        assertEquals("2 captures", 2, shots("status-6-").size)
    }

    // ------------------------------------------------------------- helpers

    private fun drive(
        sc: ActivityScenario<MainActivity>,
        o: PhoneConnStatus.Obs,
        event: (PhoneConnStatus) -> Unit = {},
    ) {
        sc.onActivity { it.driveConnStatusForTest(o, event) }
        instr.waitForIdleSync()
    }

    private fun step(
        sc: ActivityScenario<MainActivity>,
        name: String,
        o: PhoneConnStatus.Obs,
        event: (PhoneConnStatus) -> Unit = {},
        check: (MainActivity) -> Unit,
    ) {
        drive(sc, o, event)
        sc.onActivity { a ->
            // Status line and row both in frame: scroll so the row sits at the bottom.
            val scroller = a.findViewById<View>(R.id.mainContentContainer).parent as android.widget.ScrollView
            scroller.scrollTo(0, 0)
            check(a)
        }
        settle()
        capture("status-$name-top.png")
        sc.onActivity { a ->
            val reason = a.findViewById<View>(R.id.homeEncryptedModeReason)
            val footer = a.findViewById<View>(R.id.homeE2eSwitchFailed)
            val bottom = if (footer.visibility == View.VISIBLE) footer.bottom else reason.bottom
            val scroller = a.findViewById<View>(R.id.mainContentContainer).parent as android.widget.ScrollView
            val pad = (24 * a.resources.displayMetrics.density).toInt()
            scroller.scrollTo(0, maxOf(0, bottom - scroller.height + pad))
        }
        settle()
        capture("status-$name.png")
        File(dir(), "status-$name-top.png").renameTo(File(dir(), "top-$name.png"))
    }

    private fun sendSasRequired(pairingId: String, digits: String) {
        ctx.sendBroadcast(Intent(E2eSasContract.ACTION_E2E_SAS_REQUIRED).apply {
            setPackage(ctx.packageName)
            putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
            putExtra(E2eSasContract.EXTRA_SAS_DIGITS, digits)
        })
        waitFor { it.findViewById<View>(R.id.homeHeroSas).visibility == View.VISIBLE }
    }

    private fun sendRefused(pairingId: String, message: String) {
        ctx.sendBroadcast(Intent(PhoneService.ACTION_PAIRING_E2E_REFUSED).apply {
            setPackage(ctx.packageName)
            putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
            putExtra(PhoneService.EXTRA_E2E_MESSAGE, message)
        })
        waitFor { it.findViewById<TextView>(R.id.connectionErrorText).text.toString() == message }
    }

    private fun waitFor(cond: (MainActivity) -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            var ok = false
            instr.runOnMainSync {
                val a = resumed() ?: return@runOnMainSync
                ok = cond(a)
            }
            if (ok) return
            Thread.sleep(100)
        }
        throw AssertionError("condition not reached within 5 s")
    }

    private fun resumed(): MainActivity? =
        androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
            .filterIsInstance<MainActivity>().firstOrNull()

    private fun assertStatus(a: MainActivity, res: Int) {
        assertEquals("status line", ctx.getString(res), a.findViewById<TextView>(R.id.statusText).text.toString())
    }

    private fun assertReasonHas(a: MainActivity, res: Int) {
        val t = a.findViewById<TextView>(R.id.homeEncryptedModeReason).text.toString()
        assertTrue("row line '$t' must contain '${ctx.getString(res)}'", t.contains(ctx.getString(res)))
        assertFalse("no 'next connection' caveat: '$t'", t.contains("next connection", true))
    }

    private fun assertFooter(a: MainActivity, shown: Boolean) {
        assertEquals("reset-failed footer", if (shown) View.VISIBLE else View.GONE, a.findViewById<View>(R.id.homeE2eSwitchFailed).visibility)
    }

    private fun assertError(a: MainActivity, text: String?) {
        val e = a.findViewById<TextView>(R.id.connectionErrorText)
        if (text == null) {
            assertEquals("no red error: '${e.text}'", View.GONE, e.visibility)
        } else {
            assertEquals(View.VISIBLE, e.visibility)
            assertEquals(text, e.text.toString())
        }
    }

    private fun setNightMode(mode: Int) {
        instr.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
        instr.waitForIdleSync()
    }

    private fun settle() {
        instr.waitForIdleSync()
        Thread.sleep(600)
    }

    private fun dir() = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }

    private fun shots(prefix: String) = dir().listFiles { f -> f.name.startsWith(prefix) }?.toList().orEmpty()

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        File(dir(), name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
