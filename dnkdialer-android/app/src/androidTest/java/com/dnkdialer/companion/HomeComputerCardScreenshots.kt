package com.dnkdialer.companion

import android.graphics.Bitmap
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
 * vc63 (T-VC63-MAIN-SCREEN) — Dennis's picture sign-off for the Home
 * "Computer" card, light and dark.
 *
 * Same shape as [E2eP5bScreenshots]: a fixture, not a product test. The PNG
 * is the evidence, but what makes it worth keeping is that the facts a
 * reviewer would otherwise have to squint at are asserted against the LIVE
 * view tree before each capture. A screenshot proves a screen rendered; it
 * does not prove it said the right thing.
 *
 * Both themes come from forcing [AppCompatDelegate]'s night mode rather than
 * from a device setting, so the run leaves the emulator as it found it.
 *
 * ## What face (b) is, honestly
 *
 * (b) is "paired, ENCRYPTED_UNVERIFIED, switch off". A fixture cannot make a
 * pair: that needs a bound PhoneService and a real computer on the relay. So
 * the pair's mode is supplied to the PRODUCTION binder through
 * [MainActivity.refreshEncryptedModeRowForTest] — the row in the picture is
 * the production row, painted by the production painter, with one input
 * handed in. The hero above it still shows the unpaired face, and that is
 * stated here rather than hidden, because a screenshot that implied a live
 * pair we did not have would be the same class of claim this whole card
 * exists to stop making.
 */
@RunWith(AndroidJUnit4::class)
class HomeComputerCardScreenshots {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext

    @Before
    fun signIn() {
        TokenStore.save(ctx, "vc63-screenshot-fixture-not-a-real-token", "dennis@example.com")
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        E2eSettings.clearPeerAdvertisement(ctx, "vc63 screenshot setup")
    }

    @After
    fun tearDown() {
        setNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        E2eSettings.clearPeerAdvertisement(ctx, "vc63 screenshot teardown")
        TokenStore.clear(ctx)
    }

    @Test
    fun captureHomeComputerCardInBothThemes() {
        for ((suffix, mode) in listOf(
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
        )) {
            setNightMode(mode)

            // (a) NOT PAIRED, switch enabled and off.
            //
            // Reached by persisting a real `e2e` advertisement, exactly as
            // PhoneService does on a PAIRING_REQUEST — never by overriding
            // the provider. P4.1's lesson: a row photographed through an
            // override is evidence of a row only a test can produce.
            seedPeerSupported()
            E2eSettings.setEncryptedModeEnabled(ctx, false)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()
                scenario.onActivity { activity ->
                    activity.refreshEncryptedModeRowForTest()
                    val toggle = activity.findViewById<
                        com.google.android.material.switchmaterial.SwitchMaterial>(
                        R.id.homeEncryptedModeToggle
                    )
                    assertTrue("(a) the switch must be operable", toggle.isEnabled)
                    assertFalse("(a) the switch must be off", toggle.isChecked)
                    assertOnScreen(activity, R.string.section_computer)
                    assertOnScreen(activity, R.string.row_send_file_title)
                    assertOnScreen(activity, R.string.row_encrypted_mode_title)
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                bringCardIntoFrame(scenario)
                settle()
                capture("home-a-$suffix.png")
            }

            // (b) PAIRED, ENCRYPTED_UNVERIFIED, switch off — the INC-0923
            // face. The row must say what this connection actually is, in
            // words, right under a switch that is off.
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()
                scenario.onActivity { activity ->
                    activity.refreshEncryptedModeRowForTest(
                        E2eStatusCopy.State.ENCRYPTED_UNVERIFIED
                    )
                    val reason = activity.findViewById<android.widget.TextView>(
                        R.id.homeEncryptedModeReason
                    ).text.toString()
                    assertTrue(
                        "(b) the live mode is not on screen: '$reason'",
                        reason.contains(ctx.getString(R.string.home_e2e_now_unverified))
                    )
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                bringCardIntoFrame(scenario)
                settle()
                capture("home-b-$suffix.png")
            }

            // (c) switch ON, not paired. The on-next-pair promise, with no
            // live pair to contradict or confirm it.
            E2eSettings.setEncryptedModeEnabled(ctx, true)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()
                scenario.onActivity { activity ->
                    activity.refreshEncryptedModeRowForTest()
                    val toggle = activity.findViewById<
                        com.google.android.material.switchmaterial.SwitchMaterial>(
                        R.id.homeEncryptedModeToggle
                    )
                    assertTrue("(c) the switch must render ON", toggle.isChecked)
                    CopyRules.assertNoEndToEndClaim(activity.window.decorView)
                }
                bringCardIntoFrame(scenario)
                settle()
                capture("home-c-$suffix.png")
            }
            E2eSettings.setEncryptedModeEnabled(ctx, false)

            // (d) what tapping "Send a file" actually does.
            //
            // The brief asked for the CONFIRM dialog. That dialog is
            // unreachable in a fixture and saying so is the point:
            // FileTransferActivity.confirmAndSend() refuses with
            // ft_not_connected unless PhoneService.fileTransferHandler is
            // live, which needs a bound service and a real paired computer.
            // Photographing it would have meant stubbing the send path — a
            // picture of a dialog the shipped app cannot show from this
            // state. So (d) is the first screen the row really produces: the
            // system document picker.
            //
            // Fired as a bare intent rather than through ActivityScenario:
            // the picker is another process, and a scenario whose Activity
            // has been covered by one cannot be closed (it reports "Current
            // state was null"). That the HOME ROW fires exactly this intent
            // is proved in HomeComputerCardUiTest with Intents.intended();
            // this capture is about what the user then sees.
            ctx.startActivity(
                android.content.Intent(ctx, FileTransferActivity::class.java)
                    .setAction(FileTransferActivity.ACTION_PICK_FILE)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            // The picker is a separate process; give it longer than the
            // in-app settle to inflate before the shutter.
            instr.waitForIdleSync()
            Thread.sleep(3000)
            capture("home-d-$suffix.png")
            instr.uiAutomation.performGlobalAction(
                android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
            )
            Thread.sleep(1200)
        }

        val dir = File(ctx.getExternalFilesDir(null), "screenshots")
        val shots = dir.listFiles { f -> f.name.startsWith("home-") }?.size ?: 0
        assertEquals("expected 8 captures (4 faces x 2 themes)", 8, shots)
    }


    /**
     * Scroll the "Computer" card into the VIEWPORT before the shutter.
     *
     * This is not cosmetic. The card sits below the fold on a 411 dp phone
     * (deliberately — the hero and the lobby button keep the top of the
     * screen), and the first run of this fixture produced byte-identical
     * PNGs for faces (a) and (c) because the only thing that differed
     * between them was a switch that was not in frame. CopyRules.visibleText
     * walks the view TREE, so it said "on screen" about a card the camera
     * could not see. The rect check below is what closes that gap: it asks
     * the platform whether the row is actually drawn inside the window, and
     * the fixture fails rather than shipping Dennis a picture of the wrong
     * half of the screen.
     */
    private fun bringCardIntoFrame(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity ->
            val reason = activity.findViewById<android.view.View>(R.id.homeEncryptedModeReason)
            val scroller = activity.findViewById<android.view.View>(R.id.mainContentContainer)
                .parent as android.widget.ScrollView
            // Put the reason line just above the bottom edge, which leaves
            // the section label, both rows and the switch above it in frame.
            val pad = (24 * activity.resources.displayMetrics.density).toInt()
            scroller.scrollTo(0, maxOf(0, reason.bottom - scroller.height + pad))
        }
        instr.waitForIdleSync()
        Thread.sleep(300)
        scenario.onActivity { activity ->
            for (id in listOf(
                R.id.homeSendFileRow, R.id.homeEncryptedModeToggle, R.id.homeEncryptedModeReason
            )) {
                val v = activity.findViewById<android.view.View>(id)
                val r = android.graphics.Rect()
                assertTrue(
                    "view $id is not inside the window — the capture would not show it",
                    v.getGlobalVisibleRect(r) && r.height() > 0
                )
            }
        }
    }

    // ------------------------------------------------------------- helpers

    private fun assertOnScreen(activity: android.app.Activity, res: Int) {
        val want = ctx.getString(res)
        val shown = CopyRules.visibleText(activity.window.decorView)
        assertTrue("'$want' is not on screen: $shown", shown.any { it.contains(want) })
    }

    private fun seedPeerSupported() {
        E2eSettings.clearPeerAdvertisement(ctx, "seed")
        E2eSettings.recordPeerAdvertisement(
            ctx, "shot-pairing", E2eNegotiation.parsePeerOffer(supportedE2eBlock())
        )
        assertEquals(
            "the screenshot fixture did not reach PEER_SUPPORTED",
            E2ePeerCapability.State.PEER_SUPPORTED, E2ePeerCapability.current(ctx)
        )
    }

    private fun setNightMode(mode: Int) {
        instr.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
        instr.waitForIdleSync()
    }

    /** Let the recreate-on-theme-change and any animation land before capture. */
    private fun settle() {
        instr.waitForIdleSync()
        Thread.sleep(600)
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** A PAIRING_REQUEST `e2e` block from a capable computer (P1 wire shape). */
    private fun supportedE2eBlock(): com.google.gson.JsonObject {
        val g = java.security.KeyPairGenerator.getInstance("EC")
        g.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        val pub = E2eKeyEncoding.toBase64Url(E2eKeyEncoding.toSec1(g.generateKeyPair().public))
        return com.google.gson.JsonObject().apply {
            addProperty("v", 1)
            addProperty("mode", 1)
            add("recips", com.google.gson.JsonArray().apply {
                add(com.google.gson.JsonObject().apply {
                    addProperty("kind", "web")
                    addProperty("deviceId", "shot-dev-web")
                    addProperty("pub", pub)
                })
            })
        }
    }
}
