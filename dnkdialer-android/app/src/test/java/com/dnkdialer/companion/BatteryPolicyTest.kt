package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1 (c) — the cadence policy and the BAT-A1 shape guard, as a table.
 *
 * [BatteryPolicy] is pure on purpose: the three constants that define the
 * whole feature (>= 1 pct, 60 s throttle, 10 min resend anchor) are decided
 * here and nowhere else, so they can be pinned without an emulator.
 *
 * The rows assert the DECISION, not the implementation's own bookkeeping —
 * each row states prev/next/elapsed independently of how BatteryReporter
 * happens to track them.
 */
class BatteryPolicyTest {

    private fun s(pct: Int, charging: Boolean = false, ts: Long = 1_700_000_000_000L) =
        BatterySample(pct, charging, ts)

    private data class Row(
        val name: String,
        val prev: BatterySample?,
        val next: BatterySample,
        val elapsedMs: Long,
        val expect: BatteryPolicy.Decision,
    )

    private val SEND = BatteryPolicy.Decision.SEND
    private val SKIP = BatteryPolicy.Decision.SKIP

    @Test
    fun `cadence table`() {
        val rows = listOf(
            // --- (re)connect / cold start -----------------------------------
            Row("first sample ever -> SEND", null, s(50), 0L, SEND),
            Row("first sample, elapsed irrelevant", null, s(3, charging = true), 999_999L, SEND),

            // --- pct movement vs the 60 s throttle --------------------------
            Row("+1 pct at 30 s -> SKIP", s(50), s(51), 30_000L, SKIP),
            Row("+1 pct at 59_999 ms -> SKIP", s(50), s(51), 59_999L, SKIP),
            Row("+1 pct at exactly 60_000 ms -> SEND", s(50), s(51), 60_000L, SEND),
            Row("+1 pct at 61 s -> SEND", s(50), s(51), 61_000L, SEND),
            Row("-5 pct at 59_999 ms -> SKIP (size never beats the clock)", s(50), s(45), 59_999L, SKIP),
            Row("-1 pct at 61 s -> SEND", s(50), s(49), 61_000L, SEND),
            Row("0 pct change at 61 s -> SKIP", s(50), s(50), 61_000L, SKIP),

            // --- charging flip bypasses the throttle ------------------------
            Row("flip off->on at 5 s -> SEND", s(50, charging = false), s(50, charging = true), 5_000L, SEND),
            Row("flip on->off at 5 s -> SEND", s(50, charging = true), s(50, charging = false), 5_000L, SEND),
            Row("flip at 1 ms with a pct drop -> SEND", s(50, charging = false), s(41, charging = true), 1L, SEND),
            Row("same charging state at 5 s, same pct -> SKIP", s(50, charging = true), s(50, charging = true), 5_000L, SKIP),

            // --- 10 min resend anchor ---------------------------------------
            Row("unchanged 9 min -> SKIP", s(50), s(50), 540_000L, SKIP),
            Row("unchanged 599_999 ms -> SKIP", s(50), s(50), 599_999L, SKIP),
            Row("unchanged exactly 600_000 ms -> SEND", s(50), s(50), 600_000L, SEND),
            Row("unchanged 11 min -> SEND", s(50), s(50), 660_000L, SEND),

            // --- BAT-A1 shape guard: malformed is never sent ----------------
            Row("pct 101 -> SKIP", s(50), s(101), 600_000L, SKIP),
            Row("pct -1 -> SKIP", s(50), s(-1), 600_000L, SKIP),
            Row("ts 0 -> SKIP", s(50), BatterySample(50, false, 0L), 600_000L, SKIP),
            Row("ts negative -> SKIP", s(50), BatterySample(50, false, -1L), 600_000L, SKIP),
            Row("invalid pct on a charging flip -> still SKIP", s(50, charging = false), BatterySample(255, true, 1L), 5_000L, SKIP),
            Row("invalid first sample -> SKIP", null, s(101), 0L, SKIP),

            // --- boundary values that ARE valid -----------------------------
            Row("pct 0 is valid", s(2), s(0), 61_000L, SEND),
            Row("pct 100 is valid", s(99), s(100), 61_000L, SEND),
        )

        val failures = rows.filter { BatteryPolicy.decide(it.prev, it.next, it.elapsedMs) != it.expect }
            .map { "${it.name}: expected ${it.expect} got ${BatteryPolicy.decide(it.prev, it.next, it.elapsedMs)}" }

        assertTrue("table rows: ${rows.size}", rows.size >= 12)
        assertEquals("cadence rows failed:\n" + failures.joinToString("\n"), emptyList<String>(), failures)
    }

    // =====================================================================
    //  the three constants — pinned by value, so a silent edit is a failure
    // =====================================================================

    @Test
    fun `constants are the frozen three`() {
        assertEquals(60_000L, BatteryPolicy.MIN_INTERVAL_MS)
        assertEquals(600_000L, BatteryPolicy.RESEND_INTERVAL_MS)
        assertEquals(1, BatteryPolicy.MIN_PCT_DELTA)
    }

    // =====================================================================
    //  EXTRA_LEVEL / EXTRA_SCALE -> pct
    // =====================================================================

    @Test
    fun `pctFrom guards scale 0 and missing extras`() {
        assertNull("scale 0 must not divide", BatteryPolicy.pctFrom(50, 0))
        assertNull("negative scale", BatteryPolicy.pctFrom(50, -1))
        assertNull("missing level (-1)", BatteryPolicy.pctFrom(-1, 100))
    }

    @Test
    fun `pctFrom scales, rounds and clamps`() {
        assertEquals(50, BatteryPolicy.pctFrom(50, 100))
        assertEquals(0, BatteryPolicy.pctFrom(0, 100))
        assertEquals(100, BatteryPolicy.pctFrom(100, 100))
        // scale != 100 (some devices report scale 255)
        assertEquals(50, BatteryPolicy.pctFrom(128, 255))
        assertEquals(100, BatteryPolicy.pctFrom(255, 255))
        // level > scale on an OEM ROM at full: clamp to 100, never 137
        assertEquals(100, BatteryPolicy.pctFrom(137, 100))
    }

    // =====================================================================
    //  EXTRA_STATUS / EXTRA_PLUGGED -> charging
    // =====================================================================

    @Test
    fun `chargingFrom reads status or plugged`() {
        val CHARGING = android.os.BatteryManager.BATTERY_STATUS_CHARGING
        val FULL = android.os.BatteryManager.BATTERY_STATUS_FULL
        val DISCHARGING = android.os.BatteryManager.BATTERY_STATUS_DISCHARGING
        val AC = android.os.BatteryManager.BATTERY_PLUGGED_AC

        assertTrue(BatteryPolicy.chargingFrom(CHARGING, 0))
        assertTrue("FULL on the charger still reads charging", BatteryPolicy.chargingFrom(FULL, 0))
        assertTrue("PLUGGED before STATUS catches up", BatteryPolicy.chargingFrom(DISCHARGING, AC))
        assertFalse(BatteryPolicy.chargingFrom(DISCHARGING, 0))
        assertFalse(BatteryPolicy.chargingFrom(android.os.BatteryManager.BATTERY_STATUS_NOT_CHARGING, 0))
    }

    // =====================================================================
    //  BAT-A1: the payload has exactly three keys, and never `relay`
    // =====================================================================

    @Test
    fun `payload is exactly pct charging ts`() {
        val p = BatterySample(47, true, 1_700_000_000_123L).toPayload()
        assertEquals(setOf("pct", "charging", "ts"), p.keys)
        assertFalse("the phone never mints a relay key", p.containsKey("relay"))
        assertTrue("pct is an Int", p["pct"] is Int)
        assertTrue("charging is a strict Boolean", p["charging"] is Boolean)
        assertTrue("ts is numeric", p["ts"] is Long)
        assertEquals(47, p["pct"])
        assertEquals(true, p["charging"])
        assertEquals(1_700_000_000_123L, p["ts"])
    }

    @Test
    fun `isValid is the shape guard BAT-A1 asks for`() {
        assertTrue(BatteryPolicy.isValid(BatterySample(0, false, 1L)))
        assertTrue(BatteryPolicy.isValid(BatterySample(100, true, 1L)))
        assertFalse(BatteryPolicy.isValid(BatterySample(101, true, 1L)))
        assertFalse(BatteryPolicy.isValid(BatterySample(-1, true, 1L)))
        assertFalse(BatteryPolicy.isValid(BatterySample(50, true, 0L)))
    }

    // =====================================================================
    //  BATTERY is plaintext (BAT-A1: PLAINTEXT-OK)
    // =====================================================================

    @Test
    fun `BATTERY is not a sealed type`() {
        assertFalse(
            "BAT-A1 ruled PLAINTEXT-OK; sealing it is a spec change, not an edit",
            E2eFrameGate.isSealedType("BATTERY")
        )
        assertFalse(E2eFrameGate.SEALED_TYPES.contains("BATTERY"))
    }
}
