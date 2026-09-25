package com.dnkdialer.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
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
 * FILE-QUEUE — picture sign-off for the grown transfer card (Ken ADDENDUM 2):
 * the active slot on top with the queue rows below it, light + dark.
 *
 *  1. mixed: sending (the card) + queued x2 + failed + needs-file (rows);
 *  2. an incoming offer still renders on top, Accept/Decline, rows below;
 *  3. paused: "Paused" + the reason + Resume;
 *  4. the notification shade for the sending transfer - unchanged.
 *
 * A fixture (same shape as [FileTransferCardScreenshots]): each face is
 * reached through the production model - the rows through
 * [FileTransferUiModel.onQueue], exactly what PhoneService publishes - and the
 * facts a reviewer would squint at are asserted on the live view tree first.
 *
 * Output: <app external files>/screenshots/ft-queue-*.png
 */
@RunWith(AndroidJUnit4::class)
class FileTransferQueueScreenshots {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private val model get() = PhoneService.fileTransferUiModel

    @Before
    fun setUp() {
        TokenStore.save(ctx, "ft-queue-shot-not-a-real-token", "dennis@example.com")
        ctx.getSharedPreferences(PhoneService.FT_QUEUE_PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        model.reset()
        File(ctx.getExternalFilesDir(null), "screenshots").listFiles { f -> f.name.startsWith("ft-queue-") }
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
        setNightMode(AppCompatDelegate.MODE_NIGHT_YES)
        TokenStore.clear(ctx)
    }

    private fun item(key: String, name: String, size: Long, state: FileTransferQueue.State, reason: String? = null) =
        FileTransferQueue.Item(
            key = key, uri = "content://fixture/$key", name = name, size = size, lastModified = 0L,
            outgoing = true, state = state, reason = reason,
        )

    private val mixed = listOf(
        item("k1", "holiday-video.mp4", 452_984_832, FileTransferQueue.State.SENDING),
        item("k2", "passport-scan.pdf", 2_202_009, FileTransferQueue.State.QUEUED),
        item("k3", "IMG_2041.HEIC", 3_774_873, FileTransferQueue.State.QUEUED),
        item("k4", "invoice-0925.pdf", 181_248, FileTransferQueue.State.FAILED, FileTransfer.Reason.HASH_MISMATCH),
        item("k5", "contract-draft.docx", 96_256, FileTransferQueue.State.NEEDS_FILE),
    )

    @Test
    fun captureQueueFacesInBothThemes() {
        val notifier = FileTransferNotifier(ctx).apply { createChannels() }
        val total = 452_984_832L
        val sent = 222_298_112L

        for ((theme, mode) in listOf(
            "dark" to AppCompatDelegate.MODE_NIGHT_YES,
            "light" to AppCompatDelegate.MODE_NIGHT_NO,
        )) {
            setNightMode(mode)
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                settle()

                // (1) mixed states.
                model.reset()
                model.onProgress("out1", "holiday-video.mp4", sent, total, true)
                model.onQueue(FileTransferQueue.Snapshot(mixed, null))
                notifier.showProgress("holiday-video.mp4", sent, total, true, System.currentTimeMillis() - 20_000)
                settle()
                scenario.onActivity { a ->
                    assertCardVisible(a)
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftCardActive).visibility)
                    assertEquals("49%", a.findViewById<TextView>(R.id.ftCardPercent).text.toString())
                    assertEquals(
                        ctx.resources.getQuantityString(R.plurals.ft_queue_count, 2, 2),
                        a.findViewById<TextView>(R.id.ftQueueSummary).text.toString(),
                    )
                    val rows = a.findViewById<ViewGroup>(R.id.ftQueueRows)
                    assertEquals("sending is the card, the other 4 are rows", 4, rows.childCount)
                    assertEquals(ctx.getString(R.string.ft_queue_queued, "2.1 MB"), rowState(rows, 0))
                    assertEquals(
                        ctx.getString(R.string.ft_send_failed, "invoice-0925.pdf"),
                        rows.getChildAt(2).findViewById<TextView>(R.id.ftRowName).text.toString(),
                    )
                    assertEquals(failureCopy(ctx, FileTransfer.Reason.HASH_MISMATCH), rowState(rows, 2))
                    assertEquals(ctx.getString(R.string.ft_queue_retry), rowButton(rows, 2, R.id.ftRowPrimary))
                    assertEquals(ctx.getString(R.string.ft_queue_needs_file), rowState(rows, 3))
                    assertEquals(ctx.getString(R.string.ft_queue_repick), rowButton(rows, 3, R.id.ftRowPrimary))
                }
                capture("ft-queue-mixed-$theme.png")

                // (4) the shade: the progress notification for the same send,
                // unchanged by the queue.
                val appShot = shotFile("ft-queue-mixed-$theme.png").readBytes()
                var tries = 0
                do {
                    shell("cmd statusbar expand-notifications")
                    Thread.sleep(2500)
                    capture("ft-queue-shade-$theme.png")
                } while (shotFile("ft-queue-shade-$theme.png").readBytes().contentEquals(appShot) && ++tries < 3)
                assertTrue(
                    "the shade never opened",
                    !shotFile("ft-queue-shade-$theme.png").readBytes().contentEquals(appShot),
                )
                shell("cmd statusbar collapse")
                Thread.sleep(800)
                notifier.dismissProgress()

                // (2) an incoming offer takes the active slot; rows stay below.
                model.onIdle()
                model.onOffer("o1", "report.pdf", 4_404_019)
                model.onQueue(FileTransferQueue.Snapshot(mixed.drop(1), null))
                settle()
                scenario.onActivity { a ->
                    assertCardVisible(a)
                    assertEquals(
                        ctx.getString(R.string.ft_card_offer_heading),
                        a.findViewById<TextView>(R.id.ftCardHeading).text.toString(),
                    )
                    assertEquals(ctx.getString(R.string.ft_accept), a.findViewById<TextView>(R.id.ftCardPrimary).text.toString())
                    assertEquals(4, a.findViewById<ViewGroup>(R.id.ftQueueRows).childCount)
                    // On top: the active slot is above the queue section.
                    val activeY = IntArray(2).also { a.findViewById<View>(R.id.ftCardActive).getLocationOnScreen(it) }[1]
                    val queueY = IntArray(2).also { a.findViewById<View>(R.id.ftQueueSection).getLocationOnScreen(it) }[1]
                    assertTrue("the offer renders on top of the queue", activeY < queueY)
                }
                capture("ft-queue-offer-$theme.png")

                // (3) paused (link-level), no active transfer.
                model.reset()
                model.onQueue(
                    FileTransferQueue.Snapshot(
                        listOf(
                            item("k1", "holiday-video.mp4", total, FileTransferQueue.State.FAILED, FileTransfer.Reason.CONNECTION_LOST),
                            item("k2", "passport-scan.pdf", 2_202_009, FileTransferQueue.State.QUEUED),
                            item("k3", "IMG_2041.HEIC", 3_774_873, FileTransferQueue.State.QUEUED),
                        ),
                        FileTransferQueue.Pause(FileTransferQueue.PauseKind.LINK, FileTransfer.Reason.CONNECTION_LOST),
                    )
                )
                settle()
                scenario.onActivity { a ->
                    assertCardVisible(a)
                    assertEquals(View.GONE, a.findViewById<View>(R.id.ftCardActive).visibility)
                    assertEquals(ctx.getString(R.string.ft_queue_paused), a.findViewById<TextView>(R.id.ftQueueSummary).text.toString())
                    assertEquals(View.VISIBLE, a.findViewById<View>(R.id.ftQueueResume).visibility)
                }
                capture("ft-queue-paused-$theme.png")
                model.reset()
                settle()
                scenario.onActivity { a ->
                    assertEquals("an empty queue hides the card", View.GONE, a.findViewById<View>(R.id.ftCard).visibility)
                }
            }
        }

        val shots = File(ctx.getExternalFilesDir(null), "screenshots")
            .listFiles { f -> f.name.startsWith("ft-queue-") }?.size ?: 0
        assertEquals("expected 8 captures (3 faces + shade, x 2 themes)", 8, shots)
    }

    private fun rowState(rows: ViewGroup, i: Int) =
        rows.getChildAt(i).findViewById<TextView>(R.id.ftRowState).text.toString()

    private fun rowButton(rows: ViewGroup, i: Int, id: Int) =
        rows.getChildAt(i).findViewById<TextView>(id).text.toString()

    private fun assertCardVisible(a: android.app.Activity) {
        val card = a.findViewById<View>(R.id.ftCard)
        assertEquals("the card must be visible", View.VISIBLE, card.visibility)
        val r = Rect()
        assertTrue("the card is not inside the window", card.getGlobalVisibleRect(r) && r.height() >= 100)
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

    private fun shotFile(name: String) = File(File(ctx.getExternalFilesDir(null), "screenshots"), name)

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
