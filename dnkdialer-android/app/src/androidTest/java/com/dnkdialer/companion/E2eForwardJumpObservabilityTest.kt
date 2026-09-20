package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E programme, phase P4.2 (d) — the refusal must be OBSERVABLE from outside
 * the process.
 *
 * §13.5 makes this the deliverable rather than a nicety: "a silent refuser and
 * a working receiver are otherwise indistinguishable". P6.1b scenario (4)
 * F2-live drives a real phone from `scripts/e2e-cross-impl-android.mjs`, and
 * that driver cannot call a Kotlin getter — it reads `adb logcat`. So the line
 * is part of the contract, and a contract nobody tests is a comment.
 *
 * ## The grep contract, pinned here so P6.1b can rely on it
 *
 *  - **tag:** `E2eDedupe`
 *  - **line:** `E2E refusedForwardJump=<n> kid=<kid> dir=<dir>`
 *  - `<n>` is the SESSION-LIFETIME total AFTER this refusal (so it starts at 1,
 *    never 0), `<dir>` is an [E2eDedupe.Direction] name.
 *  - emitted at WARN, once per refusal — never batched, never sampled. A
 *    sampled line would under-report exactly during the burst it exists to make
 *    visible.
 *
 * The number in the line is read from the counter's own return value rather
 * than re-read afterwards, so the line and the counter cannot disagree even if
 * another direction refuses concurrently.
 *
 * This test reads the app's OWN log buffer, which an app may do without
 * permission — the instrumented test runs in the app process.
 */
@RunWith(AndroidJUnit4::class)
class E2eForwardJumpObservabilityTest {

    /** Exactly the shape `scripts/e2e-cross-impl-android.mjs` greps for. */
    private val contract =
        Regex("""E2E refusedForwardJump=(\d+) kid=(\S+) dir=(\S+)""")

    private fun readOwnLog(): String =
        ProcessBuilder("logcat", "-d", "-s", "E2eDedupe")
            .redirectErrorStream(true)
            .start()
            .inputStream
            .bufferedReader()
            .use { it.readText() }

    @Test
    fun a_refusal_writes_the_line_the_cross_impl_driver_greps() {
        // A kid unique to this run, so the assertion cannot pass on a line left
        // in the buffer by an earlier test or an earlier run of this one.
        val kid = "p42-obs-${System.nanoTime()}"
        val counter = E2eDedupe.ForwardJumpCounter()
        val window = E2eDedupe(kid, E2eDedupe.Direction.COMPUTER_TO_PHONE, 1L, counter)

        // Arm the mark, then jump one past the inclusive bound.
        assertEquals(E2eDedupe.Verdict.FRESH, window.observe(0, authenticates = true))
        assertEquals(
            E2eDedupe.Verdict.REFUSED_FORWARD_JUMP,
            window.observe(E2eDedupe.WINDOW + 1L, authenticates = true)
        )

        // logcat is asynchronous; poll rather than sleep-and-hope, so the test
        // is not a race that passes on a fast machine and fails on a loaded one.
        var matched: MatchResult? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && matched == null) {
            matched = readOwnLog()
                .lineSequence()
                .filter { it.contains(kid) }
                .mapNotNull { contract.find(it) }
                .firstOrNull()
            if (matched == null) Thread.sleep(250)
        }

        assertTrue(
            "no logcat line matching '$contract' under tag E2eDedupe for kid=$kid — " +
                "P6.1b's cross-impl driver greps exactly this line, so losing it silently " +
                "disables scenario (4) F2-live",
            matched != null
        )

        val (n, loggedKid, dir) = matched!!.destructured
        assertEquals("the line must carry the refusing window's kid", kid, loggedKid)
        assertEquals(
            "the line must carry the direction, as an E2eDedupe.Direction name",
            E2eDedupe.Direction.COMPUTER_TO_PHONE.name,
            dir
        )
        assertEquals(
            "the logged count must be the total AFTER this refusal, not before it",
            1L,
            n.toLong()
        )
        assertEquals("the line and the counter must not disagree", 1L, window.refusedForwardJump)
    }

    /**
     * The getter half of (d). A driver that can attach to the process — and the
     * regression suite — reads the counter directly rather than parsing logs.
     *
     * [E2eLifecycle] is the owner that survives epochs, so this is the number
     * that answers "has this device ever refused a forward jump", which is the
     * question F2-live asks.
     */
    @Test
    fun the_debug_getter_is_reachable_and_session_lifetime() {
        val before = E2eLifecycle.refusedForwardJump

        // The DEFAULT counter is E2eLifecycle's, so a window built the way
        // production builds one feeds the process-lifetime total.
        val window = E2eDedupe("p42-getter", E2eDedupe.Direction.COMPUTER_TO_PHONE, 1L)
        assertEquals(E2eDedupe.Verdict.FRESH, window.observe(0, authenticates = true))
        assertEquals(
            E2eDedupe.Verdict.REFUSED_FORWARD_JUMP,
            window.observe(E2eDedupe.WINDOW + 1L, authenticates = true)
        )

        assertEquals(
            "a refusal in a window built the production way must reach E2eLifecycle",
            before + 1,
            E2eLifecycle.refusedForwardJump
        )

        // An epoch change rebuilds the window. The counter must NOT follow it
        // down — the vector file's counterRule, and the reason the counter does
        // not live on the window.
        val nextEpoch = E2eDedupe("p42-getter", E2eDedupe.Direction.COMPUTER_TO_PHONE, 2L)
        assertEquals("a new epoch disarms the mark", -1L, nextEpoch.highestAccepted)
        assertEquals("a new epoch must not zero the counter", 0L, nextEpoch.floor)
        assertEquals(
            "an epoch change zeroed the security counter — an attacker can provoke one",
            before + 1,
            E2eLifecycle.refusedForwardJump
        )
    }
}
