package com.dnkdialer.companion

import com.dnkdialer.companion.RelayDialPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

/** vc70 ADDENDUM P4 + P1 — RULE 30 vectors for the dial guard and the debounce. */
class RelayDialPolicyVectorsTest {

    private val now = 1_000_000L

    private fun st(
        hasClient: Boolean = true,
        sameUrl: Boolean = true,
        isOpen: Boolean = true,
        isConnecting: Boolean = false,
        aliveAgo: Long = 5_000L,
        dialAgo: Long = 60_000L,
        lost: Boolean = false,
    ) = RelayDialPolicy.State(
        hasClient, sameUrl, isOpen, isConnecting,
        lastAliveAtMs = now - aliveAgo, dialStartedAtMs = now - dialAgo, nowMs = now,
        connectTimeoutMs = 10_000L, boundNetworkLost = lost,
    )

    @Test
    fun open_socket_with_fresh_pong_plus_dial_request_opens_no_new_socket() {
        assertEquals(Decision.SKIP_OPEN, RelayDialPolicy.decide(st()))
    }

    @Test
    fun open_but_silent_past_the_window_is_a_zombie_and_is_replaced() {
        assertEquals(Decision.DIAL, RelayDialPolicy.decide(st(aliveAgo = RelayDialPolicy.ALIVE_WINDOW_MS + 1)))
        assertEquals(Decision.SKIP_OPEN, RelayDialPolicy.decide(st(aliveAgo = RelayDialPolicy.ALIVE_WINDOW_MS)))
    }

    @Test
    fun a_dial_in_flight_is_never_doubled() {
        assertEquals(
            Decision.SKIP_INFLIGHT,
            RelayDialPolicy.decide(st(isOpen = false, isConnecting = true, dialAgo = 2_000L)),
        )
        // a hung dial past the watchdog budget is replaced
        assertEquals(
            Decision.DIAL,
            RelayDialPolicy.decide(st(isOpen = false, isConnecting = true, dialAgo = 10_000L)),
        )
    }

    @Test
    fun closed_socket_or_no_client_dials() {
        assertEquals(Decision.DIAL, RelayDialPolicy.decide(st(isOpen = false)))
        assertEquals(Decision.DIAL, RelayDialPolicy.decide(st(hasClient = false, isOpen = false)))
    }

    @Test
    fun a_different_url_replaces_even_a_healthy_socket() {
        assertEquals(Decision.DIAL, RelayDialPolicy.decide(st(sameUrl = false)))
    }

    @Test
    fun socket_bound_to_a_lost_network_redials_even_if_it_looks_open() {
        assertEquals(Decision.DIAL, RelayDialPolicy.decide(st(lost = true)))
    }

    // ------------------------------------------------------ P1 debounce

    private class FakeScheduler {
        var t = 0L
        val tasks = mutableListOf<Pair<Long, () -> Unit>>()
        fun schedule(delay: Long, task: () -> Unit): NetRedialDebouncer.Cancel {
            val e = (t + delay) to task
            tasks += e
            return NetRedialDebouncer.Cancel { tasks.remove(e) }
        }
        fun advance(ms: Long) {
            t += ms
            val due = tasks.filter { it.first <= t }
            tasks.removeAll(due)
            due.forEach { it.second() }
        }
    }

    @Test
    fun network_lost_burst_gives_one_redial_within_about_1s() {
        val sch = FakeScheduler()
        val fired = mutableListOf<Pair<Long, Boolean>>()
        val d = NetRedialDebouncer(1_000L, sch::schedule) { lost -> fired += sch.t to lost }
        d.onEvent(lost = true) // wifi lost
        sch.advance(100)
        d.onEvent(lost = false) // cellular available
        sch.advance(50)
        d.onEvent(lost = false)
        sch.advance(999)
        assertEquals(emptyList<Pair<Long, Boolean>>(), fired)
        sch.advance(1)
        assertEquals(listOf(1_150L to true), fired)
        sch.advance(10_000)
        assertEquals(1, fired.size)
    }

    @Test
    fun cancel_stops_a_pending_redial() {
        val sch = FakeScheduler()
        var n = 0
        val d = NetRedialDebouncer(1_000L, sch::schedule) { n++ }
        d.onEvent(lost = true)
        d.cancel()
        sch.advance(5_000)
        assertEquals(0, n)
    }
}
