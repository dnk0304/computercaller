package com.dnkdialer.companion

/**
 * vc70 ADDENDUM P4 + P1 — when may the phone dial the relay?
 *
 * Before this, `connectToRelay` closed whatever socket it had and dialed a new
 * one, unconditionally. Any caller that fired while the link was healthy — a
 * sticky restart, an ACTION_START, a stray timer — tore down a working pair
 * (prod 2026-09-25 20:59: phone 1000-close, rejoin 0.28 s later). With P1's
 * network callback added as one more trigger, that became a way to open two
 * sockets for one phone. This object is the single-flight rule, pure so the
 * vectors run on the JVM.
 */
object RelayDialPolicy {

    /**
     * A socket counts as healthy when it is OPEN and has shown life (open, an
     * inbound frame, a ping or a pong) within this window. The phone pings
     * every 15 s (PhoneClient.connectionLostTimeout), so 45 s is three missed
     * pongs — past the point where the library itself gives up on the socket.
     */
    const val ALIVE_WINDOW_MS = 45_000L

    enum class Decision(val key: String) {
        DIAL("dial"),
        /** An OPEN socket with fresh life — never tear it down. */
        SKIP_OPEN("redial_skipped_open"),
        /** A dial to the same URL is already in flight — do not start a second. */
        SKIP_INFLIGHT("redial_skipped_inflight"),
    }

    data class State(
        val hasClient: Boolean,
        /** The requested URL is the one the current client dialed. */
        val sameUrl: Boolean,
        val isOpen: Boolean,
        /** connect() called, handshake neither completed nor failed. */
        val isConnecting: Boolean,
        val lastAliveAtMs: Long,
        val dialStartedAtMs: Long,
        val nowMs: Long,
        /** The connect watchdog's budget; an older in-flight dial is presumed hung. */
        val connectTimeoutMs: Long,
        /** P1: the socket is bound to a network the platform reported lost. */
        val boundNetworkLost: Boolean = false,
    )

    @JvmStatic
    fun decide(s: State): Decision {
        // A different URL is a different identity (sign-in, token change): the
        // caller means "replace", and a skip would keep the wrong session.
        if (!s.hasClient || !s.sameUrl) return Decision.DIAL
        // A socket on a network that no longer exists is dead even if the
        // library has not noticed yet — that is P1's whole reason to exist.
        if (s.boundNetworkLost) return Decision.DIAL
        if (s.isOpen && s.nowMs - s.lastAliveAtMs <= ALIVE_WINDOW_MS) return Decision.SKIP_OPEN
        if (s.isConnecting && s.nowMs - s.dialStartedAtMs < s.connectTimeoutMs) {
            return Decision.SKIP_INFLIGHT
        }
        return Decision.DIAL
    }
}

/**
 * vc70 P1 — collapse a burst of network callbacks (onLost + onAvailable +
 * capability changes fire together on every wifi/cell switch) into ONE
 * re-dial decision ~1 s after the last event. Scheduler injected so the
 * vectors can drive time by hand.
 */
class NetRedialDebouncer(
    private val delayMs: Long,
    private val schedule: (delayMs: Long, task: () -> Unit) -> Cancel,
    private val fire: (lostSeen: Boolean) -> Unit,
) {
    fun interface Cancel { fun cancel() }

    private var pending: Cancel? = null
    private var lostSeen = false

    @Synchronized
    fun onEvent(lost: Boolean) {
        if (lost) lostSeen = true
        pending?.cancel()
        pending = schedule(delayMs) { fireNow() }
    }

    private fun fireNow() {
        val lost: Boolean
        synchronized(this) {
            pending = null
            lost = lostSeen
            lostSeen = false
        }
        fire(lost)
    }

    @Synchronized
    fun cancel() {
        pending?.cancel()
        pending = null
        lostSeen = false
    }
}
