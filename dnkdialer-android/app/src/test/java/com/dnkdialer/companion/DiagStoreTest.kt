package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * T-VC63-EXPORT-DIAGNOSTICS — [DiagStore]: ring wrap, daily rotation, the 24 h
 * retention rule, the 2 MiB disk cap, and counter persistence.
 *
 * The clock is injected rather than slept on. A retention test that waits 24 h
 * does not exist, and one that fakes it by back-dating `lastModified()` would
 * be testing a rule DiagStore deliberately does not use — see [DiagStore.prune],
 * which reads the day out of the FILE NAME precisely because an append rewrites
 * mtime and would keep yesterday's file alive forever.
 */
class DiagStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    /** 2026-09-23T12:00:00Z, and helpers to move whole days from it. */
    private val day0 = 1_790_164_800_000L
    private val dayMs = 24L * 60 * 60 * 1000

    private var now = day0
    private fun dir(): File = File(tmp.root, "diag")
    private fun store() = DiagStore(dir()) { now }

    // -------------------------------------------------------- ring buffer

    @Test
    fun ringWrapsAtCapacityAndKeepsTheNewest() {
        val s = store()
        for (i in 1..DiagStore.RING_CAPACITY + 500) s.append("D", "t", "line$i")
        val ring = s.ringSnapshot()
        assertEquals(DiagStore.RING_CAPACITY, ring.size)
        // Newest kept…
        assertTrue(ring.last().endsWith("line" + (DiagStore.RING_CAPACITY + 500)))
        // …oldest dropped. Control: assert the exact first survivor, not just
        // "line1 is gone" — a ring that kept only the LAST line would also
        // pass that weaker check.
        assertTrue(ring.first(), ring.first().endsWith("line501"))
        assertFalse(ring.any { it.endsWith("line500") })
    }

    @Test
    fun appendFormatsStampLevelTagMessageAndRedacts() {
        val line = store().append("W", "PhoneService", "close code=1000 peer=+4712345678")
        val parts = line.split(" | ")
        assertEquals(4, parts.size)
        assertTrue(parts[0], Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""").matches(parts[0]))
        assertEquals("W", parts[1])
        assertEquals("PhoneService", parts[2])
        // Redaction happens INSIDE the store, so no call site can opt out.
        assertFalse(line, line.contains("4712345678"))
        assertTrue(line, parts[3].contains("code=1000"))
    }

    // ------------------------------------------------------ flush policy

    @Test
    fun flushTriggersOnLineCountAndOnTime() {
        val s = store()
        assertFalse("empty store wants a flush", s.shouldFlush())
        s.append("D", "t", "one")
        assertFalse("one line before the interval", s.shouldFlush())
        now += DiagStore.FLUSH_INTERVAL_MS
        assertTrue("interval elapsed", s.shouldFlush())

        now = day0
        val s2 = store()
        for (i in 1..DiagStore.FLUSH_LINES) s2.append("D", "t", "l$i")
        assertTrue("line batch full", s2.shouldFlush())
    }

    @Test
    fun flushAppendsToTodaysFileAndClearsPending() {
        val s = store()
        s.append("D", "t", "alpha")
        assertTrue(s.flush())
        val f = File(dir(), "diag-20260923.log")
        assertTrue("expected " + f.name + ", got " + dir().list()?.toList(), f.isFile)
        assertTrue(f.readText().contains("alpha"))

        // Append-only: a second flush must not truncate the first.
        s.append("D", "t", "beta")
        assertTrue(s.flush())
        val text = f.readText()
        assertTrue(text.contains("alpha"))
        assertTrue(text.contains("beta"))
    }

    @Test
    fun rotationWritesANewFilePerDay() {
        val s = store()
        s.append("D", "t", "yesterday")
        s.flush()
        now += dayMs
        s.append("D", "t", "today")
        s.flush()
        val names = s.logFiles().map { it.name }
        assertEquals(listOf("diag-20260923.log", "diag-20260924.log"), names)
    }

    // --------------------------------------------------------- retention

    @Test
    fun pruneDeletesFilesOlderThan24hAndKeepsTheRest() {
        val s = store()
        s.append("D", "t", "d0"); s.flush()
        now += dayMs
        s.append("D", "t", "d1"); s.flush()
        // Both still inside the window: d0's day ENDS 12 h ago.
        assertEquals(2, s.logFiles().size)

        now += dayMs
        s.append("D", "t", "d2"); s.flush()
        val names = s.logFiles().map { it.name }
        assertFalse("d0 should be gone: $names", names.contains("diag-20260923.log"))
        assertTrue("d2 must survive: $names", names.contains("diag-20260925.log"))
        // Control: prune drops the OLD file, it does not wipe the directory.
        assertTrue(names.isNotEmpty())
    }

    @Test
    fun pruneIgnoresForeignFiles() {
        // counters.json lives in the same directory and must survive every
        // prune; so must anything an OEM backup agent drops there.
        val s = store()
        s.counter("ws.open")
        s.append("D", "t", "x")
        s.flush()
        now += 3 * dayMs
        s.append("D", "t", "y")
        s.flush()
        assertTrue(File(dir(), DiagStore.COUNTERS_FILE).isFile)
    }

    @Test
    fun diskCapDropsOldestFilesFirst() {
        val s = store()
        // Three days, each comfortably over the cap on its own would be slow;
        // instead write one big day, then two small ones, and assert the big
        // OLD one is the casualty.
        val big = "p".repeat(64)
        for (d in 0..2) {
            if (d > 0) now += dayMs
            val lines = if (d == 0) 40_000 else 10
            for (i in 1..lines) s.append("D", "t", big)
            s.flush()
        }
        val total = s.logFiles().sumOf { it.length() }
        assertTrue("cap not enforced: $total", total <= DiagStore.DISK_CAP_BYTES)
        val names = s.logFiles().map { it.name }
        assertTrue("newest day must survive: $names", names.contains("diag-20260925.log"))
    }

    // ---------------------------------------------------------- counters

    @Test
    fun countersAccumulateSnapshotAndPersist() {
        val s = store()
        s.counter("ws.open")
        s.counter("ws.close.1006")
        s.counter("ws.close.1006")
        assertEquals(mapOf("ws.open" to 1L, "ws.close.1006" to 2L), s.snapshotCounters())
        assertTrue(s.flush())

        val json = File(dir(), DiagStore.COUNTERS_FILE).readText()
        assertTrue(json, json.contains("\"ws.close.1006\": 2"))

        // A fresh store (i.e. a new process) reloads the cumulative totals.
        now = day0
        val s2 = store()
        s2.loadCountersFrom(json)
        assertEquals(2L, s2.snapshotCounters()["ws.close.1006"])
        s2.counter("ws.close.1006")
        assertEquals(3L, s2.snapshotCounters()["ws.close.1006"])
    }

    @Test
    fun snapshotIsACopy() {
        val s = store()
        s.counter("a")
        val snap = s.snapshotCounters()
        s.counter("a")
        assertEquals(1L, snap["a"])
        assertEquals(2L, s.snapshotCounters()["a"])
    }

    @Test
    fun loadCountersFromGarbageDoesNotThrow() {
        val s = store()
        s.loadCountersFrom("not json at all {{{")
        assertTrue(s.snapshotCounters().isEmpty())
    }

    @Test
    fun flushReturnsFalseRatherThanThrowingWhenTheDirIsAFile() {
        // A diagnostics subsystem that can crash the app it diagnoses is worse
        // than none. Block the directory with a regular file and assert the
        // store degrades instead of propagating.
        val blocked = File(tmp.root, "blocked")
        blocked.writeText("I am not a directory")
        val s = DiagStore(File(blocked, "diag")) { now }
        s.append("D", "t", "x")
        assertFalse(s.flush())
        // The ring still holds it, so the export's tail is unaffected.
        assertEquals(1, s.ringSnapshot().size)
    }
}
