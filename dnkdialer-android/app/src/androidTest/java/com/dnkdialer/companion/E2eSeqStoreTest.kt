package com.dnkdialer.companion

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 Part 2 (c2) — the AEAD counter, and GATE1 Addendum A1's named
 * **P4 acceptance criterion**:
 *
 * > The counter persist-before-emit / fail-closed rule is a P4 acceptance
 * > criterion, with an explicit restore-from-backup test. **It is the rule most
 * > likely to be quietly skipped.**
 *
 * Instrumented rather than a JVM unit test because the whole mechanism is an
 * AndroidKeyStore key: the counter record is sealed under a hardware-bound key
 * that is *not* included in a backup, so a restored record fails its tag check
 * instead of handing back a stale integer that looks perfectly valid. There is
 * no way to exercise that on the unit-test classpath, where AndroidKeyStore
 * does not exist.
 *
 * [restore_from_backup_fails_closed] is the acceptance test. If it is ever
 * deleted or weakened, the failure it guards against is silent GCM nonce reuse
 * — not a degradation but total loss of confidentiality *and* forgery for every
 * frame under the affected key.
 */
@RunWith(AndroidJUnit4::class)
class E2eSeqStoreTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val p2c = E2eEnvelope.Direction.PHONE_TO_COMPUTER

    @Before
    fun clean() {
        E2eSeqStore.clearAll(ctx)
    }

    /**
     * A stable, distinct 4-byte prefix per kid. In production this comes from
     * [E2eKdf.deriveNoncePrefixes]; the store only cares that it is 4 bytes and
     * that a resume presents the same one, which this reproduces.
     */
    private fun prefixFor(kid: String): ByteArray {
        val h = java.security.MessageDigest.getInstance("SHA-256")
            .digest(kid.toByteArray(Charsets.UTF_8))
        return h.copyOf(E2eEnvelope.SESSION_PREFIX_BYTES)
    }

    // ------------------------------------------------- ordinary behaviour

    @Test
    fun a_fresh_epoch_starts_at_zero_and_increments() {
        val s = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        assertEquals(0, s.nextSequence)
        assertEquals(listOf(0L, 1L, 2L, 3L), (0 until 4).map { s.reserve() })
        assertEquals(4, s.nextSequence)
        assertEquals(E2eEnvelope.SESSION_PREFIX_BYTES, s.sessionPrefix.size)
    }

    @Test
    fun the_session_prefix_differs_per_kid() {
        val a = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A")).sessionPrefix
        val b = E2eSeqStore.open(ctx, "kid-B", p2c, freshEpoch = true, prefixFor("kid-B")).sessionPrefix
        assertNotEquals(
            "two sessions must not share a nonce prefix",
            E2eKdf.toHex(a), E2eKdf.toHex(b)
        )
    }

    @Test
    fun the_two_directions_are_separate_records() {
        val send = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        val recv = E2eSeqStore.open(
            ctx, "kid-A", E2eEnvelope.Direction.COMPUTER_TO_PHONE, freshEpoch = true,
            prefixFor("kid-A-c2p")
        )
        send.reserve(); send.reserve()
        assertEquals("the other direction's counter must not have moved", 0, recv.nextSequence)
    }

    // ------------------------------------ persist-before-emit (A1 item 3)

    /**
     * The invariant: the persisted high-water mark is ALWAYS at least every
     * sequence ever handed out. A crash can therefore only make the next boot
     * SKIP sequences, never repeat one — skipping is free (§13.5's window
     * tolerates gaps), repeating is fatal.
     */
    @Test
    fun the_high_water_mark_never_trails_a_handed_out_sequence() {
        val s = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        for (i in 0 until 500) {
            val issued = s.reserve()
            assertTrue(
                "sequence $issued was handed out beyond the durable mark ${s.highWaterMark}",
                issued < s.highWaterMark
            )
        }
    }

    /**
     * GATE1 Addendum A2 MUST (2): **the nonce prefix is derived on every
     * session construction and never persisted.**
     *
     * The assertion has to be that the CALLER'S prefix wins on a resume, not
     * merely that the same prefix comes back — passing the same value twice
     * cannot distinguish "re-derived" from "read off disk", which is exactly
     * the state A2 forbids. So this reopens the same record with a DIFFERENT
     * prefix and requires the new one to be in force. A build that still stored
     * the prefix would hand back the old bytes and fail here.
     *
     * (Production can never take this branch: the prefix is a deterministic
     * function of SK and pairContext, so a legitimate resume derives the same
     * four bytes. The point is to prove where the value came FROM.)
     */
    @Test
    fun the_nonce_prefix_is_never_persisted() {
        val original = prefixFor("kid-A")
        val first = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, original)
        first.reserve()
        assertArrayEquals(original, first.sessionPrefix)

        val different = byteArrayOf(0x7f, 0x7e, 0x7d, 0x7c)
        assertFalse(
            "the test's own premise: the two prefixes must differ",
            original.contentEquals(different)
        )
        val second = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = false, different)
        assertArrayEquals(
            "A2 MUST (2): the resumed store used a STORED prefix instead of the derived " +
                "one it was given — the record is carrying state it must not carry",
            different, second.sessionPrefix
        )
    }

    /**
     * Simulates a process kill: a NEW store object opened over the same record,
     * as happens on the next app start. It must resume strictly beyond the
     * persisted mark, never re-issue.
     */
    @Test
    fun reopening_resumes_strictly_beyond_the_persisted_mark() {
        val first = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        val issued = (0 until 5).map { first.reserve() }
        val mark = first.highWaterMark

        // "process death": drop the object, reopen the record.
        val second = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = false, prefixFor("kid-A"))
        assertEquals("must resume AT the durable mark", mark, second.nextSequence)
        assertTrue("and that is beyond everything issued", issued.all { it < second.nextSequence })
        assertArrayEquals(
            "a resume re-derives the SAME prefix from the same SK — it is not stored, " +
                "it is reproduced",
            first.sessionPrefix, second.sessionPrefix
        )

        val more = (0 until 5).map { second.reserve() }
        assertTrue(
            "a reopened store re-issued a sequence",
            more.none { it in issued }
        )
    }

    // ---------------------------------- THE ACCEPTANCE TEST (A1 cond. 3)

    /**
     * **GATE1 Addendum A1's explicit restore-from-backup test.**
     *
     * A restore gives the app its `SharedPreferences` back but NOT its
     * AndroidKeyStore keys — those are hardware-bound and never leave the
     * device. So the sealed counter record is present and well-formed, its
     * integer is stale, and the ONLY thing that reveals this is that it no
     * longer authenticates.
     *
     * The store must refuse to hand out a sequence. A1: *"never resume at a
     * guess, never restart at 0"*.
     */
    @Test
    fun restore_from_backup_fails_closed() {
        val before = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        repeat(10) { before.reserve() }
        val usedUpTo = before.nextSequence
        assertTrue(usedUpTo > 0)

        // The restore: prefs survive, the hardware-bound wrapping key does not.
        E2eSeqStore.simulateRestoreFromBackup()

        try {
            E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = false, prefixFor("kid-A"))
            fail(
                "THE ACCEPTANCE TEST FAILED: a restored counter record was accepted. " +
                    "Sequences up to $usedUpTo may already have been emitted, so resuming " +
                    "here reuses a GCM nonce — total loss of confidentiality AND forgery " +
                    "for every frame under this key."
            )
        } catch (e: E2eSeqStore.CounterUnsafeException) {
            assertTrue(
                "the refusal must say what to do: ${e.message}",
                e.message!!.contains("rekey")
            )
        }

        // And the recovery path works: a fresh Accept mints a NEW kid, which is
        // a new key, so starting at 0 there is legitimate.
        val after = E2eSeqStore.open(ctx, "kid-B", p2c, freshEpoch = true, prefixFor("kid-B"))
        assertEquals(0, after.nextSequence)
        assertEquals(0, after.reserve())
    }

    /**
     * Cleared storage: the record is gone entirely. We cannot prove we have not
     * already used sequences under this key, so resuming is refused for exactly
     * the same reason — but a FRESH epoch is allowed, and that difference is
     * the whole of the rule.
     */
    @Test
    fun cleared_storage_fails_closed_on_resume_but_allows_a_fresh_epoch() {
        E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A")).reserve()
        E2eSeqStore.clear(ctx, "kid-A")

        try {
            E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = false, prefixFor("kid-A"))
            fail("a resume with no record was accepted")
        } catch (e: E2eSeqStore.CounterUnsafeException) {
            assertTrue(e.message!!, e.message!!.contains("rekey"))
        }
        // Control: freshEpoch = true is fine, because the key is new.
        assertEquals(0, E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A")).reserve())
    }

    @Test
    fun a_record_for_another_kid_is_refused() {
        E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A")).reserve()
        // Opening kid-B for resume must not silently borrow kid-A's record.
        try {
            E2eSeqStore.open(ctx, "kid-B", p2c, freshEpoch = false, prefixFor("kid-B"))
            fail("resumed a kid with no record of its own")
        } catch (e: E2eSeqStore.CounterUnsafeException) {
            assertTrue(e.message!!, e.message!!.contains("rekey"))
        }
    }

    @Test
    fun a_corrupt_record_fails_closed() {
        E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A")).reserve()
        val prefs = ctx.getSharedPreferences("computercaller_e2e_seq", Context.MODE_PRIVATE)
        val key = prefs.all.keys.first { it.contains("kid-A") }
        prefs.edit().putString(key, "garbage.notbase64url!!").commit()
        try {
            E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = false, prefixFor("kid-A"))
            fail("a corrupt record was accepted")
        } catch (e: E2eSeqStore.CounterUnsafeException) {
            assertTrue(e.message!!, e.message!!.contains("rekey"))
        }
    }

    /**
     * The stored blob must not be a readable integer. If the counter were stored
     * in the clear, "restore detection" would rest on nothing.
     */
    @Test
    fun the_stored_record_is_not_readable_plaintext() {
        val s = E2eSeqStore.open(ctx, "kid-A", p2c, freshEpoch = true, prefixFor("kid-A"))
        repeat(3) { s.reserve() }
        val prefs = ctx.getSharedPreferences("computercaller_e2e_seq", Context.MODE_PRIVATE)
        val blob = prefs.all.values.first().toString()
        assertTrue("record must be iv.ct", blob.contains("."))
        assertTrue("the kid must not be readable in the record", !blob.contains("kid-A"))
        assertTrue(
            "the nonce prefix must not be readable in the record",
            !blob.contains(E2eKdf.toHex(s.sessionPrefix))
        )
    }
}
