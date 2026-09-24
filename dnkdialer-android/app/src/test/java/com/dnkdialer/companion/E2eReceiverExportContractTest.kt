package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * vc67 AMENDMENT 1 — Security F-3 / C1 (SECURITY-ACK-VC67-SAS-LATCH).
 *
 * ## The defect this pins shut
 *
 * `minSdk = 26`. On API 26-32 a runtime `registerReceiver(receiver, filter)`
 * with no flag registers an **EXPORTED** receiver for an implicit action. Every
 * in-app receiver in this app was registered that way on those API levels,
 * behind an `if (SDK_INT >= TIRAMISU) … else @Suppress(…) …` shape that looked
 * deliberate. The worst of them is [E2eSasGate.arm]: any other app installed on
 * the device could broadcast `ACTION_E2E_SAS_RESULT` with
 * `EXTRA_SAS_MATCHED=true` and **approve the SAS on the user's behalf**, which
 * defeats the entire man-in-the-middle defence without the digits ever being
 * compared.
 *
 * The fix is `ContextCompat.registerReceiver(ctx, receiver, filter,
 * ContextCompat.RECEIVER_NOT_EXPORTED)`, which is NOT_EXPORTED on every API
 * level: `>= 33` via the platform flag, `< 33` by registering under the
 * signature-level permission
 * `com.dnkdialer.companion.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` that
 * `androidx.core`'s manifest declares and only our own package holds. The
 * SYSTEM is exempt from that permission check, so the three system-broadcast
 * receivers (BluetoothHeadset, SCO, ACTION_BATTERY_CHANGED) keep working.
 *
 * ## Why this is a SOURCE pin
 *
 * The property is "no call site anywhere in `app/src/main` registers an
 * exported receiver". That is a statement about the whole module, not about one
 * function's behaviour, and a behavioural test can only ever cover the call
 * sites someone remembered to exercise — which is exactly how four of these
 * survived every previous gate. The check is a paren-matched scan of the real
 * Kotlin sources, so a receiver added in six months is covered the day it is
 * written.
 *
 * Note on Gradle staleness: these sources are INSIDE this module, so any edit
 * to them recompiles `:app` and this task cannot report UP-TO-DATE against a
 * stale reading. (A vector file outside the module would not have that
 * property — see the kdf-vectors lanes.)
 *
 * Run: `gradlew.bat :app:testDebugUnitTest --tests '*ReceiverExportContract*'`
 */
class E2eReceiverExportContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`. */
    private val mainSrc = File("src/main/java/com/dnkdialer/companion")

    private fun sources(): List<File> {
        assertTrue(
            "main source dir not found from cwd ${File(".").absolutePath}",
            mainSrc.isDirectory
        )
        return mainSrc.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    }

    /**
     * Text of the argument list of the call whose `(` is at [open], with every
     * run of whitespace collapsed to one space. Paren-matched, so a nested call
     * or a trailing lambda cannot truncate it.
     */
    private fun args(text: String, open: Int): String {
        var depth = 0
        var i = open
        while (i < text.length) {
            when (text[i]) {
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return text.substring(open + 1, i).replace(Regex("\\s+"), " ")
                }
            }
            i++
        }
        throw AssertionError("unbalanced parentheses after offset $open")
    }

    /** Every `registerReceiver(` call site in main, as (file, args). */
    private fun callSites(): List<Triple<String, Int, String>> {
        val out = mutableListOf<Triple<String, Int, String>>()
        for (f in sources()) {
            val text = f.readText()
            var idx = text.indexOf("registerReceiver(")
            while (idx >= 0) {
                // `unregisterReceiver(` also ends in `registerReceiver(`.
                val isUnregister = idx >= 2 && text.startsWith("unregisterReceiver(", idx - 2)
                if (!isUnregister) {
                    val open = idx + "registerReceiver".length
                    val line = text.substring(0, idx).count { it == '\n' } + 1
                    out += Triple(f.name, line, args(text, open))
                }
                idx = text.indexOf("registerReceiver(", idx + 1)
            }
        }
        return out
    }

    @Test
    fun `every in-app receiver registration is NOT_EXPORTED on every API level`() {
        val bad = callSites().filter { (_, _, a) ->
            // `registerReceiver(null, filter)` is a STICKY READ, not a
            // registration — it returns the last broadcast and registers
            // nothing, so there is nothing to export.
            val stickyRead = a.startsWith("null,")
            !stickyRead && !a.contains("ContextCompat.RECEIVER_NOT_EXPORTED")
        }
        assertEquals(
            "these registerReceiver call sites do not pass " +
                "ContextCompat.RECEIVER_NOT_EXPORTED: " +
                bad.joinToString { "${it.first}:${it.second}" },
            emptyList<Triple<String, Int, String>>(),
            bad
        )
    }

    @Test
    fun `no call site registers a receiver without going through ContextCompat`() {
        // The platform two- and three-arg overloads are the ones that are
        // exported (or silently unflagged) below API 33. The ONLY permitted
        // spellings in main are `ContextCompat.registerReceiver(...)` and the
        // sticky read.
        val offenders = mutableListOf<String>()
        for (f in sources()) {
            val text = f.readText()
            var idx = text.indexOf("registerReceiver(")
            while (idx >= 0) {
                val isUnregister = idx >= 2 && text.startsWith("unregisterReceiver(", idx - 2)
                val viaCompat = idx >= 14 && text.startsWith("ContextCompat.registerReceiver(", idx - 14)
                val sticky = args(text, idx + "registerReceiver".length).startsWith("null,")
                if (!isUnregister && !viaCompat && !sticky) {
                    offenders += "${f.name}:${text.substring(0, idx).count { it == '\n' } + 1}"
                }
                idx = text.indexOf("registerReceiver(", idx + 1)
            }
        }
        assertEquals(
            "bare platform registerReceiver in main (use ContextCompat): $offenders",
            emptyList<String>(), offenders
        )
    }

    @Test
    fun `the UnspecifiedRegisterReceiverFlag suppression is gone from main`() {
        val suppressed = sources()
            .filter { it.readText().contains("UnspecifiedRegisterReceiverFlag") }
            .map { it.name }
        assertEquals(
            "an @Suppress(\"UnspecifiedRegisterReceiverFlag\") is how F-3 hid for four " +
                "releases; the lint rule is now an error and nothing in main may opt out: $suppressed",
            emptyList<String>(), suppressed
        )
    }

    @Test
    fun `the lint rule is enabled as an error`() {
        // cwd is dnkdialer-android/app.
        val gradle = File("build.gradle.kts").readText().replace(Regex("\\s+"), " ")
        assertTrue(
            "app/build.gradle.kts must promote UnspecifiedRegisterReceiverFlag to error, " +
                "or a future bare registration is only a warning nobody reads",
            gradle.contains("error += \"UnspecifiedRegisterReceiverFlag\"")
        )
    }

    @Test
    fun `the five security-relevant sites are each present and flagged`() {
        // Named explicitly so that DELETING a registration (rather than fixing
        // it) cannot make the sweep above vacuously green. Four are the sites
        // SECURITY-ACK-VC67-SAS-LATCH C1 named; MainActivity is the fifth this
        // amendment's audit found — it carries ACTION_E2E_SAS_REQUIRED, which
        // an exported receiver would let any app put six digits of its own
        // choosing in front of the user.
        val required = mapOf(
            "E2eSasGate.kt" to 1,     // ACTION_E2E_SAS_RESULT / _SHOWN
            "MainActivity.kt" to 1,   // ACTION_E2E_SAS_REQUIRED (the fifth site)
            "PhoneService.kt" to 6,   // bluetooth, SCO, connection, lobby, sms-status, file-transfer
            "BatteryReporter.kt" to 1 // ACTION_BATTERY_CHANGED (+1 sticky read, excluded)
        )
        val counted = callSites()
            .filter { it.third.contains("ContextCompat.RECEIVER_NOT_EXPORTED") }
            .groupingBy { it.first }.eachCount()
        for ((file, n) in required) {
            assertEquals(
                "$file must keep $n NOT_EXPORTED registration(s)",
                n, counted[file] ?: 0
            )
        }
    }

    @Test
    fun `the SAS gate receiver specifically is not exported`() {
        val site = callSites().single { it.first == "E2eSasGate.kt" }
        assertTrue(
            "E2eSasGate registers the receiver that carries ACTION_E2E_SAS_RESULT; " +
                "exported, any app on the device can approve the SAS. args=${site.third}",
            site.third.contains("ContextCompat.RECEIVER_NOT_EXPORTED")
        )
    }
}
