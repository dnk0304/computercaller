package com.dnkdialer.companion

import android.graphics.Bitmap
import android.graphics.Rect
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * vc69 — picture sign-off for the in-app transfer card: outgoing in progress,
 * incoming in progress, done, failed, pending offer; light + dark; plus the
 * notification shade showing the progress notification for the SAME transfer
 * the card is drawing (the notification is unchanged and still present).
 *
 * A fixture, not a product test (same shape as [HomeComputerCardScreenshots]).
 * Each face is reached through the production model and the production
 * notifier - the exact calls PhoneService makes per listener event - and the
 * facts a reviewer would squint at are asserted on the live view tree before
 * the shutter. The real-manager proof is [FileTransferCardUiTest].
 *
 * Output: <app external files>/screenshots/ft-card-*.png
 */
@RunWith(AndroidJUnit4::class)
class FileTransferCardScreenshots {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private val model get() = PhoneService.fileTransferUiModel

    @Before
    fun setUp() {
        TokenStore.save(ctx, "ft-card-shot-not-a-real-token", "dennis@example.com")
        model.reset()
        File(ctx.getExternalFilesDir(null), "screenshots").listFiles { f -> f.name.startsWith("ft-card-") }
            ?.forEach { it.delete() }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            instr.uiAutomation.grantRuntimePermission(ctx.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    @After
    fun tearDown() {
        model.reset()
        FileTransferNotifier(ctx).dismissProgress()
        shell("cmd statusbar collapse")
        // Leave the app on its real default theme (dark), as the vc63 fixture does.
        setNightMode(AppCompatDelegate.MODE_NIGHT_YES)
        TokenStore.clear(ctx)
    }

    @Test
    fun captureTransferCardFacesInBothThemes() {
        val notifier = FileTransferNotifier(ctx).apply { createChannels() }
        val total = 452_984_832L          // 432 MB
        val sent = 222_298_112L           // 212 MB -> 49 %

        for ((theme, mode) in listOf(
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
        )) {
            setNightMode(mode)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()

                // (1) outgoing in progress - and the notification for the
                // same transfer, from the same event, shot from the shade.
                model.reset()
                model.onProgress("out1", "holiday-video.mp4", sent, total, true)
                notifier.showProgress("holiday-video.mp4", sent, total, true, System.currentTimeMillis() - 20_000)
                settle()
                scenario.onActivity { a ->
                    assertCardShows(a, R.string.ft_card_to_computer)
                    assertEquals("49%", a.findViewById<TextView>(R.id.ftCardPercent).text.toString())
                    assertEquals(
                        ctx.getString(R.string.ft_progress_plain, "212 MB", "432 MB"),
                        a.findViewById<TextView>(R.id.ftCardBytes).text.toString(),
                    )
                }
                capture("ft-card-outgoing-$theme.png")
                shell("cmd statusbar expand-notifications")
                Thread.sleep(1500)
                capture("ft-card-shade-outgoing-$theme.png")
                shell("cmd statusbar collapse")
                Thread.sleep(800)
                notifier.dismissProgress()

                // (2) incoming in progress.
                model.reset()
                model.onProgress("in1", "scan-2026-09.pdf", 3_355_444, 8_388_608, false)
                settle()
                scenario.onActivity { a ->
                    assertCardShows(a, R.string.ft_card_from_computer)
                    assertEquals("40%", a.findViewById<TextView>(R.id.ftCardPercent).text.toString())
                }
                capture("ft-card-incoming-$theme.png")

                // (3) done (incoming, with Open).
                model.onIdle()
                model.onComplete("in1", "scan-2026-09.pdf", "content://com.android.providers.downloads.documents/document/1", false)
                settle()
                scenario.onActivity { a ->
                    assertCardShows(a, R.string.ft_card_from_computer)
                    assertEquals(
                        ctx.getString(R.string.ft_received, "scan-2026-09.pdf"),
                        a.findViewById<TextView>(R.id.ftCardName).text.toString(),
                    )
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftCardPrimary).visibility)
                }
                capture("ft-card-done-$theme.png")

                // (4) failed - the notification's copy for the reason.
                model.onFailed("out2", "holiday-video.mp4", FileTransfer.Reason.CONNECTION_LOST, true)
                settle()
                scenario.onActivity { a ->
                    assertCardShows(a, R.string.ft_card_to_computer)
                    assertEquals(
                        failureCopy(ctx, FileTransfer.Reason.CONNECTION_LOST),
                        a.findViewById<TextView>(R.id.ftCardMessage).text.toString(),
                    )
                }
                capture("ft-card-failed-$theme.png")

                // (5) pending offer (FT incident 2, item 2).
                model.onOffer("o1", "report.pdf", 4_404_019)
                settle()
                scenario.onActivity { a ->
                    assertCardShows(a, R.string.ft_card_offer_heading)
                    assertEquals(
                        ctx.getString(R.string.ft_accept),
                        a.findViewById<TextView>(R.id.ftCardPrimary).text.toString(),
                    )
                }
                capture("ft-card-offer-$theme.png")
                model.reset()
            }
        }

        val shots = File(ctx.getExternalFilesDir(null), "screenshots")
            .listFiles { f -> f.name.startsWith("ft-card-") }?.size ?: 0
        assertEquals("expected 12 captures (5 faces + shade, x 2 themes)", 12, shots)
    }

    private fun assertCardShows(a: android.app.Activity, headingRes: Int) {
        val card = a.findViewById<View>(R.id.ftCard)
        assertEquals("the card must be visible", View.VISIBLE, card.visibility)
        assertEquals(ctx.getString(headingRes), a.findViewById<TextView>(R.id.ftCardHeading).text.toString())
        val r = Rect()
        assertTrue(
            "the card is not inside the window - the capture would not show it",
            card.getGlobalVisibleRect(r) && r.height() >= card.height / 2,
        )
    }

    private fun setNightMode(mode: Int) {
        instr.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
        instr.waitForIdleSync()
    }

    private fun settle() {
        instr.waitForIdleSync()
        Thread.sleep(700)
    }

    private fun shell(cmd: String) {
        instr.uiAutomation.executeShellCommand(cmd).close()
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
