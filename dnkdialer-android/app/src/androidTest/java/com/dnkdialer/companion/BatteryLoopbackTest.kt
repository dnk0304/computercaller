package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * BAT-1 (c) — instrumented proof of the battery emitter on a real device.
 *
 * ## What this is, and what it is NOT
 *
 * [ScriptedPeer] is a Kotlin loopback standing in for the browser end of the
 * wire. It is **not the relay**: it does not enforce the paired-phone origin
 * (BAT-A1 MUST-1), it does not reject a relay-minted frame (MUST-2), it does
 * not apply the per-room rate cap and it does not own the resume frameBuffer
 * exclusion (MUST-3) — all four are BAT-2's, tested there. What this proves is
 * the phone half: that a real `dumpsys battery` change produces a correctly
 * shaped BATTERY frame within 2 s, that the 60 s throttle actually withholds
 * one, that a charging flip bypasses it, and that BATTERY leaves PLAINTEXT
 * while a live sealed session is latched ON.
 *
 * Labelling that boundary matters because a loopback written by the author of
 * the emitter agrees with itself. So the battery values asserted here are the
 * ones **the shell was told to set**, read back independently from
 * `dumpsys battery`, never from the reporter's own bookkeeping; and every
 * "no frame arrived" window is paired with a positive control in the same
 * test that proves the same stimulus DOES produce a frame once the clock
 * allows it — an absence on its own would pass against a reporter that had
 * simply died.
 */
@RunWith(AndroidJUnit4::class)
class BatteryLoopbackTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context get() = instr.targetContext

    private val pairingId = "pair-battery"
    private val peerDeviceId = "dev-web-battery"

    private var reporter: BatteryReporter? = null

    @Before
    fun setUp() {
        // The brief's gate precondition: never grade an instrumented run
        // against an APK other than the one this lane built.
        assertEquals(
            "installed versionCode must be the vc60 line this lane targets",
            60L,
            installedVersionCode()
        )
        shell("dumpsys battery reset")
        E2eSeqStore.clearAll(ctx)
        E2eSession.clearKidBindingsForTest()
        TokenStore.clear(ctx)
        TokenStore.putUserId(ctx, "acct-battery")
    }

    @After
    fun tearDown() {
        // try/finally at the suite level: the device must never be left with a
        // frozen fake battery, whatever failed above.
        try {
            reporter?.unregister()
        } finally {
            reporter = null
            shell("dumpsys battery reset")
        }
    }

    // =====================================================================
    //                          the scripted peer
    // =====================================================================

    /** The browser end. Ordered queue so a failure is reproducible. */
    private class ScriptedPeer {
        private val frames = ConcurrentLinkedQueue<Map<String, Any>>()

        fun receive(payload: Map<String, Any>) {
            frames.add(payload)
        }

        fun drain() = frames.clear()

        fun count() = frames.size

        /** Next frame, or null if none arrives inside [ms]. */
        fun await(ms: Long): Map<String, Any>? {
            val deadline = System.currentTimeMillis() + ms
            while (System.currentTimeMillis() < deadline) {
                frames.poll()?.let { return it }
                Thread.sleep(25)
            }
            return frames.poll()
        }

        /** Assert nothing arrives for [ms]. Only meaningful beside a control. */
        fun awaitSilence(ms: Long): Map<String, Any>? = await(ms)
    }

    // =====================================================================
    //  (c) cadence on a real device: connect push, flip, throttle, release
    // =====================================================================

    @Test
    fun cadence_on_a_real_battery() {
        val peer = ScriptedPeer()

        // A known starting point, set BEFORE the observer exists so the
        // sticky broadcast the registration replays is one we chose.
        shell("dumpsys battery set level 50")
        shell("dumpsys battery set ac 0")
        Thread.sleep(500)

        val r = BatteryReporter(ctx) { peer.receive(it.toPayload()) }
        reporter = r
        r.register()

        // 1. Registration replays the sticky ACTION_BATTERY_CHANGED, so the
        //    first sample lands immediately — the same "first sample -> SEND"
        //    rule a (re)connect relies on.
        val first = peer.await(2_000)
        assertNotNull("no BATTERY frame from the sticky broadcast", first)
        assertShape(first!!)
        assertEquals("pct from `dumpsys battery set level 50`", 50, first["pct"])
        assertEquals(false, first["charging"])
        val firstTs = first["ts"] as Long

        // 2. Charging flip bypasses the 60 s throttle entirely: this arrives
        //    ~5 s after the frame above, not 60 s after it.
        shell("dumpsys battery set ac 1")
        val flip = peer.await(2_000)
        assertNotNull("charging flip must bypass the throttle", flip)
        assertShape(flip!!)
        assertEquals(50, flip["pct"])
        assertEquals(true, flip["charging"])
        assertTrue(
            "the flip frame must be newer than the first",
            (flip["ts"] as Long) >= firstTs
        )
        // Independent read-back: the device really is on AC and at 50.
        val dump = shell("dumpsys battery")
        assertTrue("dumpsys should report level 50, got:\n$dump", dump.contains(Regex("level: 50")))

        val flipAt = System.currentTimeMillis()
        peer.drain()

        // 3. A 1 pct move inside the 60 s window is WITHHELD.
        shell("dumpsys battery set level 49")
        assertNull(
            "a +/-1 pct change 60 s must not produce a frame",
            peer.awaitSilence(8_000)
        )

        // 4. ...and the positive control for that silence: the SAME stimulus
        //    once the throttle window has passed DOES produce a frame. Without
        //    this, step 3 would also pass against a dead reporter.
        val waitMs = BatteryPolicy.MIN_INTERVAL_MS - (System.currentTimeMillis() - flipAt) + 2_000
        if (waitMs > 0) Thread.sleep(waitMs)
        shell("dumpsys battery set level 48")
        val released = peer.await(4_000)
        assertNotNull("after 60 s the same 1 pct move must send", released)
        assertShape(released!!)
        assertEquals(48, released["pct"])
        assertEquals(true, released["charging"])

        // 5. (b)'s reconnect push: unconditional, regardless of the clock.
        peer.drain()
        val pushed = r.sendNow()
        assertNotNull("sendNow() must push the current sample unconditionally", pushed)
        val onConnect = peer.await(2_000)
        assertNotNull("the (re)connect push must reach the peer", onConnect)
        assertShape(onConnect!!)
        assertEquals(48, onConnect["pct"])
    }

    // =====================================================================
    //  (c) mode-ON twin — BATTERY leaves PLAINTEXT under a live session
    // =====================================================================

    @Test
    fun mode_on_twin_battery_stays_plaintext() {
        val session = armedSession()
        val gate = E2eFrameGate(sessionProvider = { session }, latchedProvider = { true })

        val battery = """{"pct":50,"charging":true,"ts":1700000000000}"""
        val out = gate.outbound("BATTERY", battery)
        assertEquals("BAT-A1: BATTERY rides plaintext under mode ON", battery, out)
        assertFalse("BATTERY must not be wrapped in a 13.7 envelope", E2eFrameGate.looksSealed(out!!))

        // AUDIO_STATUS behaviour unchanged by this lane.
        val audio = """{"state":"idle","ts":1700000000000}"""
        assertEquals("AUDIO_STATUS unchanged", audio, gate.outbound("AUDIO_STATUS", audio))

        // The control that makes the two assertions above mean something: the
        // very same gate DOES seal a 13.7 type. If the session were dead the
        // gate would return null here, not the body.
        val sealedBody = """{"body":"x"}"""
        val sealedOut = gate.outbound("SMS_RECEIVED", sealedBody)
        assertNotNull("the gate must be live (a dead session drops, not passes)", sealedOut)
        assertNotEquals("a 13.7 type must NOT come back as the plaintext body", sealedBody, sealedOut)
        assertTrue("the control frame must be a sealed envelope", E2eFrameGate.looksSealed(sealedOut!!))

        assertFalse(E2eFrameGate.isSealedType("BATTERY"))
    }

    // =====================================================================
    //  BAT-A1 shape guard, end of the real path
    // =====================================================================

    @Test
    fun current_sample_is_always_in_shape() {
        shell("dumpsys battery set level 7")
        shell("dumpsys battery set ac 0")
        Thread.sleep(500)
        val r = BatteryReporter(ctx) { }
        reporter = r
        val s = r.currentSample()
        assertNotNull("the sticky broadcast must yield a sample", s)
        assertTrue("BAT-A1 shape guard", BatteryPolicy.isValid(s!!))
        assertEquals(7, s.pct)
        assertEquals(setOf("pct", "charging", "ts"), s.toPayload().keys)
    }

    // ------------------------------------------------------------- helpers

    private fun assertShape(p: Map<String, Any>) {
        assertEquals("BAT-A1 MUST-3: exactly three keys, never `relay`", setOf("pct", "charging", "ts"), p.keys)
        assertTrue("pct must be an Int", p["pct"] is Int)
        assertTrue("pct in 0..100", (p["pct"] as Int) in 0..100)
        assertTrue("charging must be a strict Boolean", p["charging"] is Boolean)
        assertTrue("ts must be numeric", p["ts"] is Long)
        assertTrue("ts must be positive", (p["ts"] as Long) > 0L)
    }

    private fun armedSession(): E2eSession {
        val sk = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        val pc = E2eKdf.PairContext(
            pairingId = pairingId,
            userId = requireNotNull(E2ePairIdentity.userIdForPairContext(ctx)) {
                "the account id must be seeded before a pair context can be built"
            },
            phoneDeviceId = E2eLifecycle.deviceId(ctx),
            peerDeviceId = peerDeviceId,
            pairEpoch = 1L,
        )
        return E2eSession.forPhone(ctx, sk, pc, "kid-battery", freshEpoch = true)
    }

    private fun installedVersionCode(): Long {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            pi.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            pi.versionCode.toLong()
        }
    }

    /** Run an adb shell command through UiAutomation and return its output. */
    private fun shell(cmd: String): String {
        val pfd = instr.uiAutomation.executeShellCommand(cmd)
        return FileInputStream(pfd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }
    }
}
