package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * FILE-QUEUE — the [FileTransferQueue] properties a step table does not
 * express well: the done-row cap, the persistence round trip, and the
 * lock-order contract (the manager calls back INTO the queue from inside
 * startSend; the queue must not hold its lock across that call).
 */
class FileTransferQueueTest {

    private open class Sender : FileTransferQueue.Sender {
        override var isBusy = false
        override var isConnected = true
        val starts = ArrayList<String>()
        override fun start(uri: String) { starts.add(uri) }
        override fun cancelActive() {}
        override fun canRead(uri: String) = true
    }

    private fun file(n: String) = FileTransferQueue.NewFile("u:$n", n, 1L, persistable = true)

    @Test
    fun done_rows_are_capped_oldest_first_and_failed_rows_never_dropped() {
        val s = Sender()
        var k = 0
        val q = FileTransferQueue(s, { 0L }, { "k" + (++k) })
        q.enqueue(listOf(file("bad")))
        q.onFailed("", "bad", FileTransfer.Reason.HASH_MISMATCH, true)
        val total = FileTransferQueue.MAX_DONE_ROWS + 5
        q.enqueue((1..total).map { file("f$it") })
        repeat(total) { i -> q.onComplete("t$i", "f${i + 1}", null, true) }
        val items = q.snapshot().items
        assertEquals(FileTransferQueue.MAX_DONE_ROWS, items.count { it.state == FileTransferQueue.State.DONE })
        assertEquals("the failed row survives", "bad", items.first().name)
        assertEquals("the oldest done rows went", "f6", items[1].name)
        assertEquals("f$total", items.last().name)
    }

    @Test
    fun the_persisted_form_round_trips() {
        val s = Sender().apply { isBusy = true }
        var k = 0
        val a = FileTransferQueue(s, { 0L }, { "k" + (++k) })
        a.enqueue(listOf(file("x"), file("y")))
        a.onProgress("in1", "in.pdf", 1, 2, false)
        a.onComplete("in1", "in.pdf", "content://doc/in.pdf", false)
        val json = a.toJson()
        val b = FileTransferQueue(Sender().apply { isBusy = true }, { 0L }, { "z" })
        b.restore(json)
        assertEquals(a.snapshot(), b.snapshot())
        assertEquals("the published encoding is the same blob", json, a.encodeSnapshot(a.snapshot()))
    }

    /**
     * FileTransferManager.startSend reports a busy refusal by calling
     * listener.onFailed SYNCHRONOUSLY, from inside its own lock. If the queue
     * held its lock across Sender.start, the re-entrant onFailed from another
     * thread would deadlock; from the same thread it would observe a
     * half-updated queue. Neither may happen.
     */
    @Test
    fun a_reentrant_failure_from_inside_start_is_handled_after_the_lock_is_released() {
        var k = 0
        lateinit var q: FileTransferQueue
        val s = object : Sender() {
            override fun start(uri: String) {
                super.start(uri)
                // Another thread reports the refusal while this one is still
                // inside start(): it must be able to take the queue's lock.
                val done = CountDownLatch(1)
                Thread { q.onFailed("", "a", FileTransfer.Reason.BUSY, true); done.countDown() }.start()
                assertTrue("the queue lock was held across Sender.start", done.await(5, TimeUnit.SECONDS))
            }
        }
        q = FileTransferQueue(s, { 0L }, { "k" + (++k) })
        q.enqueue(listOf(file("a")))
        val it = q.snapshot().items.single()
        assertEquals(FileTransferQueue.State.QUEUED, it.state)
        assertEquals(1, it.busyRetries)
        assertEquals(listOf("u:a"), s.starts)
    }

    @Test
    fun concurrent_events_never_put_two_items_in_flight() {
        val s = Sender()
        var k = 0
        val q = FileTransferQueue(s, { 0L }, { synchronized(this) { "k" + (++k) } })
        q.enqueue((1..15).map { file("f$it") }) // < MAX_DONE_ROWS: nothing trimmed
        // An assert inside a worker thread only prints; count violations instead.
        val violations = java.util.concurrent.atomic.AtomicInteger()
        val threads = (1..4).map { t ->
            Thread {
                repeat(200) {
                    q.onIdle(); q.tick()
                    if (t == 1) q.onComplete("", "x", null, true)
                    val inFlight = q.snapshot().items.count {
                        it.state == FileTransferQueue.State.OFFERING || it.state == FileTransferQueue.State.SENDING
                    }
                    if (inFlight > 1) violations.incrementAndGet()
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join(10_000) }
        assertEquals("snapshots with two items in flight", 0, violations.get())
        val done = q.snapshot().items.count { it.state == FileTransferQueue.State.DONE }
        // Every start is followed by exactly one completion before the next.
        assertEquals(s.starts.size, done + q.snapshot().items.count { it.state == FileTransferQueue.State.OFFERING })
    }
}
