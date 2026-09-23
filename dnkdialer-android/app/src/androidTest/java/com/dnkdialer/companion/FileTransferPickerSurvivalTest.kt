package com.dnkdialer.companion

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.view.KeyEvent
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * FT-PICKER-NOHISTORY - the regression this lane exists for.
 *
 * `android:noHistory="true"` destroys an Activity the moment it stops being
 * visible. Opening a SAF picker does exactly that, so FileTransferActivity was
 * torn down while the user was still choosing a file and its result callback
 * never ran: phone->computer send never started, and an incoming offer could
 * never be given a destination (proven on PROD by ACCEPT-9, 2026-09-23).
 *
 * Both tests below go RED if `noHistory` is put back:
 *  - [manifest_must_not_declare_noHistory] reads the flag the OS actually
 *    parsed, not the source text.
 *  - [activity_survives_the_source_picker] launches the REAL document picker
 *    on the device and asserts the Activity left RESUMED (so the picker really
 *    did cover it) and was NOT destroyed by doing so.
 *
 * Single surface: Android only. No cross-impl vector - no web/SW code decides
 * this Activity's lifecycle.
 */
@RunWith(AndroidJUnit4::class)
class FileTransferPickerSurvivalTest {

    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun activityInfo(): ActivityInfo {
        val name = android.content.ComponentName(ctx, FileTransferActivity::class.java)
        return ctx.packageManager.getActivityInfo(name, PackageManager.GET_META_DATA)
    }

    @Test
    fun manifest_must_not_declare_noHistory() {
        val info = activityInfo()
        assertEquals(
            "FileTransferActivity must NOT be noHistory: the SAF picker would destroy it " +
                "mid-choice and the result callback would never run.",
            0,
            info.flags and ActivityInfo.FLAG_NO_HISTORY,
        )
        // The reason noHistory was there in the first place - "no zombie
        // dialog in recents" - is this flag's job, so it must stay.
        assertNotEquals(
            "excludeFromRecents must stay: it is what keeps the dialog out of recents.",
            0,
            info.flags and ActivityInfo.FLAG_EXCLUDE_FROM_RECENTS,
        )
        // singleTop is why onNewIntent must re-dispatch now that the
        // Activity survives a second offer notification.
        assertEquals(ActivityInfo.LAUNCH_SINGLE_TOP, info.launchMode)
    }

    @Test
    fun activity_survives_the_source_picker() {
        val intent = Intent(ctx, FileTransferActivity::class.java)
            .setAction(FileTransferActivity.ACTION_PICK_FILE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        ActivityScenario.launch<FileTransferActivity>(intent).use { scenario ->
            // The picker is another task coming up on top; wait for our
            // Activity to stop being the resumed one.
            val left = waitFor(15_000) { scenario.state != Lifecycle.State.RESUMED }
            assertTrue(
                "the document picker never came up, so this test proves nothing " +
                    "(state stayed ${scenario.state})",
                left,
            )
            // THE ASSERTION. Under noHistory this is DESTROYED within a frame
            // of the picker appearing.
            assertNotEquals(
                "FileTransferActivity was destroyed while the SAF picker was open - " +
                    "its result callback can never run.",
                Lifecycle.State.DESTROYED,
                scenario.state,
            )
            // And it must still be alive a beat later, not merely mid-teardown.
            idle(1_500)
            assertNotEquals(
                "FileTransferActivity was destroyed shortly after the SAF picker opened.",
                Lifecycle.State.DESTROYED,
                scenario.state,
            )

            // Close the picker so the next test starts on a clean screen.
            InstrumentationRegistry.getInstrumentation()
                .sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            idle(1_000)
        }
    }

    // ------------------------------------------------------------- helpers

    private fun idle(ms: Long) {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(ms)
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    /** Polls [cond] until true or [timeoutMs] elapses. Returns whether it held. */
    private fun waitFor(timeoutMs: Long, cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (cond()) return true
            Thread.sleep(200)
        }
        return cond()
    }
}
