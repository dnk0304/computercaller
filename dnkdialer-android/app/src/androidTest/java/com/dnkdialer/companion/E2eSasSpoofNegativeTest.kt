package com.dnkdialer.companion

import android.content.Context
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * vc67 AMENDMENT 1 — Security F-3 / C1, the on-device negative.
 *
 * ## What this proves
 *
 * [E2eSasGate]'s receiver carries `ACTION_E2E_SAS_RESULT`. If it is EXPORTED,
 * any app on the device can broadcast `EXTRA_SAS_MATCHED=true` and approve the
 * SAS on the user's behalf — the MITM defence defeated without the digits ever
 * being compared. This test sends that exact broadcast from a DIFFERENT UID
 * and asserts the gate does not close.
 *
 * `UiAutomation.executeShellCommand` runs `am broadcast` as the **shell** user
 * (uid 2000), not as us. That is a genuinely external sender: it holds neither
 * our package identity nor the signature-level permission
 * `com.dnkdialer.companion.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` that
 * ContextCompat registers under below API 33. On API 33+ the platform
 * `RECEIVER_NOT_EXPORTED` flag refuses it outright.
 *
 * ## Why the positive control is not optional
 *
 * An assertion satisfied by ABSENCE proves nothing on its own: a typo in the
 * action string, a wrong extra name, or a gate that was never armed all
 * produce the same green. [spoof_is_refused_but_our_own_broadcast_is_accepted]
 * therefore sends the IDENTICAL intent in-process first and requires it to
 * close the gate with MATCHED. Only then is "the same intent from uid 2000
 * does nothing" evidence about the export flag rather than about the intent.
 *
 * ## Coverage note
 *
 * An API-34 AVD exercises the platform-flag path. The `< 33` permission path
 * is not reachable on that image; it is covered by the source pin
 * [E2eReceiverExportContractTest], which asserts every call site in
 * `app/src/main` goes through `ContextCompat` — which is NOT_EXPORTED on every
 * API level by construction.
 *
 * Run: `gradlew.bat :app:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class E2eSasSpoofNegativeTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val digits = "80317"

    /** Runs a shell command as uid 2000 and returns its stdout. */
    private fun shell(cmd: String): String {
        val pfd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand(cmd)
        return FileInputStream(pfd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }
    }

    /** The SAS approval intent an attacking app would send. */
    private fun approvalIntent(pairingId: String) =
        Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
            setPackage(ctx.packageName)
            putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
            putExtra(E2eSasContract.EXTRA_SAS_MATCHED, true)
        }

    /** The same thing spelled for `am broadcast`, sent from the shell uid. */
    private fun spoofFromShell(pairingId: String): String = shell(
        "am broadcast -a ${E2eSasContract.ACTION_E2E_SAS_RESULT}" +
            " -p ${ctx.packageName}" +
            " --es ${PhoneService.EXTRA_PAIRING_ID} $pairingId" +
            " --ez ${E2eSasContract.EXTRA_SAS_MATCHED} true"
    )

    private fun armed(pairingId: String, timeoutMs: Long, out: Array<E2eSasGate.Verdict?>):
        Pair<CountDownLatch, CountDownLatch> {
        val isArmed = CountDownLatch(1)
        val done = CountDownLatch(1)
        Thread {
            out[0] = E2eSasGate.await(
                ctx, pairingId, modeOn = true, digits = digits, timeoutMs = timeoutMs,
                onArmed = { p -> if (p != null) isArmed.countDown() },
            )
            done.countDown()
        }.start()
        assertTrue("gate never armed", isArmed.await(10, TimeUnit.SECONDS))
        return isArmed to done
    }

    @Test
    fun a_broadcast_from_another_uid_cannot_close_the_sas_gate() {
        val pairingId = "pair-spoof-neg"
        val out = arrayOfNulls<E2eSasGate.Verdict>(1)
        val (_, done) = armed(pairingId, 6_000, out)

        val amOut = spoofFromShell(pairingId)
        android.util.Log.i("SasSpoofNegative", "am broadcast (uid shell) said: ${amOut.trim()}")

        assertTrue("the gate never finished", done.await(20, TimeUnit.SECONDS))
        // Fails CLOSED. Not MATCHED, and not REFUSED either: a spoofed intent
        // must not be delivered at all, so the gate can only reach its
        // deadline.
        assertEquals(
            "a broadcast from uid 2000 approved the SAS — the receiver is EXPORTED (F-3)",
            E2eSasGate.Verdict.TIMED_OUT, out[0]
        )
    }

    @Test
    fun spoof_is_refused_but_our_own_broadcast_is_accepted() {
        // ---- control: the identical intent, in-process, DOES close the gate.
        val controlId = "pair-spoof-control"
        val controlOut = arrayOfNulls<E2eSasGate.Verdict>(1)
        val (_, controlDone) = armed(controlId, 15_000, controlOut)
        ctx.sendBroadcast(approvalIntent(controlId))
        assertTrue(controlDone.await(20, TimeUnit.SECONDS))
        assertEquals(
            "the control failed: this intent shape cannot approve a SAS at all, so the " +
                "negative below would be green for the wrong reason",
            E2eSasGate.Verdict.MATCHED, controlOut[0]
        )

        // ---- negative: same action, same extras, sender = shell uid.
        val spoofId = "pair-spoof-neg-2"
        val spoofOut = arrayOfNulls<E2eSasGate.Verdict>(1)
        val (_, spoofDone) = armed(spoofId, 6_000, spoofOut)
        val amOut = spoofFromShell(spoofId)
        android.util.Log.i("SasSpoofNegative", "control=MATCHED; spoof am said: ${amOut.trim()}")
        assertTrue(spoofDone.await(20, TimeUnit.SECONDS))
        assertEquals(
            "same intent from uid 2000 reached the receiver — it is EXPORTED (F-3)",
            E2eSasGate.Verdict.TIMED_OUT, spoofOut[0]
        )
    }
}
