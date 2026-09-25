package com.dnkdialer.companion

import android.content.ContextWrapper
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * vc69 — FT incident 2 (offer 518aa1bc): a FILE_FAILED for the offer we are
 * still HOLDING was ignored, because the FAILED branch only looked at
 * `active`. `pendingOffer` - and with it `isBusy` - stayed set until the 60 s
 * expiry, and the next honest offer was answered BUSY in 123 ms.
 *
 * Drives the REAL [FileTransferManager] through [FileTransferManager.onFrame].
 * The offer / FAILED / busy paths touch no Android API (the Context is only
 * used by the accept and send paths, which these tests never reach), so a
 * null-based ContextWrapper is enough to construct it on the JVM.
 *
 * Every assertion is against what the manager SAID - frames it sent and
 * listener calls it made - not against its own fields beyond the public
 * [FileTransferManager.isBusy] the brief names.
 */
class FileTransferPendingOfferTest {

    private val sent = mutableListOf<Pair<String, Map<String, Any?>>>()
    private val offers = mutableListOf<String>()
    private val withdrawn = mutableListOf<Pair<String, String>>()

    private val mgr = FileTransferManager(
        context = ContextWrapper(null),
        send = { type, payload -> synchronized(sent) { sent.add(type to payload) } },
        isOpen = { true },
        queuedBytes = { 0L },
        sealedModeOn = { false },
        listener = object : FileTransferManager.Listener {
            override fun onProgress(id: String, name: String, sent: Long, total: Long, outgoing: Boolean) {}
            override fun onOfferReceived(id: String, name: String, size: Long, mime: String?) {
                offers.add(id)
            }
            override fun onComplete(id: String, name: String, uri: Uri?, outgoing: Boolean) {}
            override fun onFailed(id: String, name: String?, reason: String, outgoing: Boolean) {}
            override fun onIdle() {}
            override fun onOfferWithdrawn(id: String, reason: String) {
                withdrawn.add(id to reason)
            }
        },
    )

    private fun offer(id: String, size: Long = 4096L) = mgr.onFrame(
        FileTransfer.OFFER,
        mapOf(
            "id" to id, "name" to "holiday.jpg", "size" to size,
            "mime" to "image/jpeg", "sha256" to "ab".repeat(32), "from" to "web",
        ),
    )

    private fun failed(id: String, reason: String = FileTransfer.Reason.CANCELLED) =
        mgr.onFrame(FileTransfer.FAILED, mapOf("id" to id, "reason" to reason))

    private fun busyAnswers(): List<Map<String, Any?>> = synchronized(sent) {
        sent.filter { (t, p) -> t == FileTransfer.FAILED && p["reason"] == FileTransfer.Reason.BUSY }
            .map { it.second }
    }

    @Test
    fun failed_for_the_pending_offer_clears_busy_and_the_next_offer_is_taken() {
        offer("o1")
        assertTrue("an unanswered offer makes the manager busy", mgr.isBusy)
        assertEquals(listOf("o1"), offers)

        failed("o1")

        assertFalse("FILE_FAILED(pending id) must clear isBusy", mgr.isBusy)
        assertEquals(listOf("o1" to FileTransfer.Reason.CANCELLED), withdrawn)

        offer("o2")
        assertEquals("the next offer reaches the user", listOf("o1", "o2"), offers)
        assertTrue("and is now the one pending", mgr.isBusy)
        assertTrue("nothing may be answered BUSY", busyAnswers().isEmpty())
    }

    /** The incident's control: WITHOUT a FILE_FAILED the second offer IS busy. */
    @Test
    fun control_a_second_offer_while_one_is_pending_is_answered_busy() {
        offer("o1")
        offer("o2")
        assertEquals(listOf("o1"), offers)
        assertEquals(1, busyAnswers().size)
        assertEquals("o2", busyAnswers()[0]["id"])
    }

    @Test
    fun relay_minted_reason_is_carried_and_an_unknown_reason_still_clears() {
        offer("o1")
        failed("o1", FileTransfer.Reason.TIMEOUT)
        offer("o2")
        failed("o2", "something-new")
        assertFalse(mgr.isBusy)
        assertEquals(
            listOf("o1" to FileTransfer.Reason.TIMEOUT, "o2" to FileTransfer.Reason.CONNECTION_LOST),
            withdrawn,
        )
    }

    @Test
    fun failed_for_a_different_id_leaves_the_pending_offer_alone() {
        offer("o1")
        failed("someone-else")
        assertTrue("an unrelated FILE_FAILED must not clear our offer", mgr.isBusy)
        assertTrue(withdrawn.isEmpty())
    }

    @Test
    fun failed_without_an_id_is_ignored() {
        offer("o1")
        mgr.onFrame(FileTransfer.FAILED, mapOf("reason" to FileTransfer.Reason.CANCELLED))
        assertTrue(mgr.isBusy)
        assertTrue(withdrawn.isEmpty())
    }

    @Test
    fun socket_drop_clears_the_pending_offer_and_sends_nothing() {
        offer("o1")
        val before = synchronized(sent) { sent.size }
        mgr.onDisconnected()
        assertFalse("the relay freed the slot with the socket", mgr.isBusy)
        assertEquals(listOf("o1" to FileTransfer.Reason.CONNECTION_LOST), withdrawn)
        assertEquals("no frame to a socket that is gone", before, synchronized(sent) { sent.size })
        offer("o2")
        assertTrue(busyAnswers().isEmpty())
    }

    @Test
    fun room_reset_drop_clears_the_pending_offer() {
        offer("o1")
        mgr.dropPendingOffer(FileTransfer.Reason.CANCELLED)
        assertFalse(mgr.isBusy)
        assertEquals(listOf("o1" to FileTransfer.Reason.CANCELLED), withdrawn)
    }

    @Test
    fun withdrawal_is_reported_once() {
        offer("o1")
        failed("o1")
        failed("o1")
        mgr.onDisconnected()
        assertEquals(1, withdrawn.size)
    }

    @Test
    fun drop_with_nothing_pending_is_a_no_op() {
        mgr.onDisconnected()
        mgr.dropPendingOffer(FileTransfer.Reason.CANCELLED)
        assertFalse(mgr.isBusy)
        assertTrue(withdrawn.isEmpty())
    }
}
