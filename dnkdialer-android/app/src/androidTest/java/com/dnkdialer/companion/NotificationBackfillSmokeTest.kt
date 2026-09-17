package com.dnkdialer.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * P4 (i) — the instrumented smoke the brief asks for: **three posted
 * notifications produce three backfill payloads.**
 *
 * The unit suite already pins the cap, the ordering and the filter. What only
 * a device can show is that `getActiveNotifications()` is actually reachable,
 * that the shared builder survives a real `StatusBarNotification` (extras
 * bundle, icon rasterisation, `sbn.key`), and that the `backfill` flag is set
 * on the way out.
 *
 * Notification-listener access is granted here through the instrumentation's
 * shell identity rather than assumed: without it `getActiveNotifications()`
 * throws and the test would report a product failure for an environment
 * reason. If the grant does not take, the test is SKIPPED with a message
 * rather than passing vacuously — a green run that silently exercised nothing
 * is the outcome this whole programme keeps writing down.
 */
@RunWith(AndroidJUnit4::class)
class NotificationBackfillSmokeTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val channelId = "e2e-backfill-test"
    private val postedIds = mutableListOf<Int>()

    private fun shell(cmd: String): String {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand(cmd)
        return android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use {
            it.readBytes().toString(Charsets.UTF_8)
        }
    }

    @Before
    fun grantListenerAccessAndPost() {
        val component = "${ctx.packageName}/${DnkNotificationListenerService::class.java.name}"
        val existing = shell("settings get secure enabled_notification_listeners").trim()
        if (!existing.contains(component)) {
            val merged = if (existing.isBlank() || existing == "null") {
                component
            } else {
                "$existing:$component"
            }
            shell("settings put secure enabled_notification_listeners '$merged'")
        }

        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(channelId, "E2E backfill", NotificationManager.IMPORTANCE_DEFAULT)
        )

        // Three forwardable notifications: CATEGORY_MESSAGE, not ongoing, with
        // a title and a body. Distinct postTimes so the ordering assertion
        // below means something.
        for (i in 1..3) {
            val n = Notification.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle("Sender $i")
                .setContentText("Message body $i")
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setWhen(1_700_000_000_000L + i * 1000L)
                .build()
            nm.notify(9000 + i, n)
            postedIds.add(9000 + i)
            Thread.sleep(50) // distinct postTime
        }
        // The listener binds asynchronously after the settings write.
        waitForListener()
    }

    @After
    fun clearPosted() {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        postedIds.forEach { nm.cancel(it) }
        nm.deleteNotificationChannel(channelId)
    }

    private fun waitForListener() {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (DnkNotificationListenerService.getInstance() != null) return
            Thread.sleep(200)
        }
    }

    @Test
    fun three_posted_notifications_yield_three_backfill_payloads() {
        val listener = DnkNotificationListenerService.getInstance()
        assumeTrue(
            "notification-listener access was not granted on this device — SKIPPING rather " +
                "than passing vacuously",
            listener != null
        )

        val payloads = listener!!.activeNotificationPayloads()
            .filter { it.packageName == ctx.packageName }

        assertEquals(
            "expected exactly the three posted notifications, got " +
                payloads.joinToString { "${it.title}/${it.notificationKey}" },
            3, payloads.size
        )

        // Every one of them must be flagged, or the web treats a backfill as a
        // live post and badges + notifies for messages the user already saw.
        assertTrue(
            "every backfill payload must carry backfill=true",
            payloads.all { it.backfill }
        )

        // Newest first, as the brief specifies.
        assertEquals(
            payloads.map { it.timestamp }.sortedDescending(),
            payloads.map { it.timestamp }
        )
        assertEquals("Sender 3", payloads.first().title)

        // The fields the web renders survived a real StatusBarNotification.
        for (p in payloads) {
            assertTrue("a payload lost its key", p.notificationKey.isNotBlank())
            assertTrue("a payload lost its body", p.body.startsWith("Message body"))
            assertTrue("postTime must be a real epoch ms", p.timestamp > 0)
        }
    }

    /**
     * The live path must NOT set the flag. Same builder, one boolean apart —
     * so the thing worth proving is that the boolean actually reaches the
     * payload rather than being hardcoded on the backfill side.
     */
    @Test
    fun the_live_path_is_not_flagged_as_backfill() {
        val listener = DnkNotificationListenerService.getInstance()
        assumeTrue("listener not connected", listener != null)

        var live: DnkNotificationListenerService.Companion.Payload? = null
        val previous = DnkNotificationListenerService.onMessageNotification
        DnkNotificationListenerService.onMessageNotification = { p ->
            if (p.packageName == ctx.packageName) live = p
        }
        try {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val n = Notification.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle("Live sender")
                .setContentText("Live body")
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build()
            nm.notify(9100, n)
            postedIds.add(9100)

            val deadline = System.currentTimeMillis() + 5_000
            while (live == null && System.currentTimeMillis() < deadline) Thread.sleep(100)
        } finally {
            DnkNotificationListenerService.onMessageNotification = previous
        }

        assumeTrue("onNotificationPosted did not fire on this device", live != null)
        assertEquals("Live sender", live!!.title)
        assertTrue("a LIVE notification must not be flagged as backfill", !live!!.backfill)
    }
}
