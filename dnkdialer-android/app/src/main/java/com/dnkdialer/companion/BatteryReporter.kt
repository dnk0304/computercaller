package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * BAT-1 (a) — phone battery telemetry.
 *
 * Wire frame (FROZEN, battery/PLAN.md):
 *   `BATTERY:{"pct":<int 0..100>,"charging":<bool>,"ts":<epoch ms>}`  phone -> browsers only.
 *
 * There is no browser -> phone request: the phone pushes. Nothing here reads
 * a frame, so nothing here can be driven by a peer.
 *
 * ## Plaintext, deliberately (GATE1 Addendum BAT-A1: PLAINTEXT-OK)
 * BATTERY is NOT in [E2eFrameGate.SEALED_TYPES]; it joins §13.7's
 * presence/heartbeat/status family beside AUDIO_STATUS and
 * BT_HEADSET_STATUS, and leaves through the very same
 * `PhoneService.sendResponse(type, payload, viaClient)` chokepoint, so no new
 * egress path exists. BAT-A1's MUSTs that land on THIS lane:
 *  - shape guard before send: pct is an Int in 0..100, charging a strict
 *    Boolean, ts a positive Long. A malformed sample is never sent
 *    ([BatteryPolicy.isValid]).
 *  - the phone never emits a top-level `relay` key: [BatterySample.toPayload]
 *    builds exactly three keys and is the only payload builder.
 * MUSTs 1 (paired-phone origin), 2 (relay-minted reject) and 3 (display-only,
 * resume-buffer exclusion) are enforced on the relay/SW side by BAT-2.
 *
 * ## Cadence (three constants, and nothing else)
 * No wakelocks, no AlarmManager, no timer ticking while nothing changes —
 * every send is driven by a sticky ACTION_BATTERY_CHANGED the system was
 * already broadcasting, plus one unconditional push per (re)connect.
 */
object BatteryPolicy {

    /** Minimum gap between two pct-change frames. */
    const val MIN_INTERVAL_MS: Long = 60_000L

    /** Forced resend anchor: re-emit an unchanged sample this often. */
    const val RESEND_INTERVAL_MS: Long = 600_000L

    /** Smallest pct movement worth a frame. */
    const val MIN_PCT_DELTA: Int = 1

    enum class Decision { SEND, SKIP }

    /**
     * pct from BatteryManager EXTRA_LEVEL / EXTRA_SCALE.
     *
     * Returns null — never a bogus number — when the sticky intent is absent
     * or malformed (scale 0 is the classic one; it would divide by zero, and
     * an emulator briefly reports it during boot).
     */
    @JvmStatic
    fun pctFrom(level: Int, scale: Int): Int? {
        if (level < 0 || scale <= 0) return null
        val pct = Math.round(level * 100.0f / scale)
        // Clamp rather than reject: a device reporting level > scale (seen on
        // some OEM ROMs at 100%) should read 100%, not "no battery value".
        return pct.coerceIn(0, 100)
    }

    /**
     * charging from EXTRA_STATUS / EXTRA_PLUGGED. Either signal alone is
     * enough: STATUS_FULL on a plugged device still means "on the charger",
     * and some devices report PLUGGED before STATUS catches up.
     */
    @JvmStatic
    fun chargingFrom(status: Int, plugged: Int): Boolean =
        status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL ||
            plugged != 0

    /** BAT-A1 shape guard. A sample failing this is never sent. */
    @JvmStatic
    fun isValid(sample: BatterySample): Boolean =
        sample.pct in 0..100 && sample.ts > 0L

    /**
     * The whole cadence rule, as one pure function.
     *
     * @param prev the last sample actually SENT, or null if none has been.
     * @param next the sample just observed.
     * @param elapsedMs ms since [prev] was sent (ignored when prev is null).
     */
    @JvmStatic
    fun decide(prev: BatterySample?, next: BatterySample, elapsedMs: Long): Decision {
        if (!isValid(next)) return Decision.SKIP
        // First sample after (re)connect or service start — always report.
        if (prev == null) return Decision.SEND
        // A charging flip is the one event the user notices immediately;
        // it bypasses the throttle entirely.
        if (prev.charging != next.charging) return Decision.SEND
        val moved = Math.abs(next.pct - prev.pct) >= MIN_PCT_DELTA
        if (moved && elapsedMs >= MIN_INTERVAL_MS) return Decision.SEND
        // Liveness anchor: an unchanged battery still re-announces itself so
        // the browser can tell "stale" from "idle".
        if (elapsedMs >= RESEND_INTERVAL_MS) return Decision.SEND
        return Decision.SKIP
    }
}

/** The frozen three fields, and no fourth. */
data class BatterySample(val pct: Int, val charging: Boolean, val ts: Long) {
    /**
     * The BATTERY payload. Exactly three keys — the phone never mints a
     * top-level `relay` key (BAT-A1 MUST-2 is a reject on the receiving
     * sides; this is the reason it can never legitimately appear).
     */
    fun toPayload(): Map<String, Any> = mapOf(
        "pct" to pct,
        "charging" to charging,
        "ts" to ts,
    )
}

/**
 * Observes ACTION_BATTERY_CHANGED for as long as PhoneService is running and
 * hands [BatteryPolicy]-approved samples to [emit].
 *
 * ACTION_BATTERY_CHANGED is a sticky, protected system broadcast: registering
 * for it needs no permission and no manifest entry, and the registration call
 * itself returns the current value — which is why [currentSample] exists and
 * why there is no polling anywhere in this file.
 */
class BatteryReporter(
    private val context: Context,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val emit: (BatterySample) -> Unit,
) {

    private var receiver: BroadcastReceiver? = null

    /** Last sample actually emitted, and when. Guarded by [lock]. */
    private var lastSent: BatterySample? = null
    private var lastSentAt: Long = 0L
    private val lock = Any()

    /** Register the observer. Idempotent. */
    fun register() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                // Nothing blocking happens on this path: parse the extras,
                // apply a pure policy, hand off to a thread-safe websocket
                // send. No disk, no network wait, no binder round-trip.
                if (intent?.action != Intent.ACTION_BATTERY_CHANGED) return
                sampleFrom(intent)?.let { offer(it) }
            }
        }
        try {
            context.registerReceiver(r, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            receiver = r
            android.util.Log.d(TAG, "battery observer registered")
        } catch (e: Exception) {
            android.util.Log.w(TAG, "registerReceiver failed: ${e.message}", e)
        }
    }

    /** Unregister. Safe to call when never registered, and twice. */
    fun unregister() {
        val r = receiver ?: return
        receiver = null
        try {
            context.unregisterReceiver(r)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "battery observer was not registered: ${e.message}")
        }
        android.util.Log.d(TAG, "battery observer unregistered")
    }

    /**
     * Read the current value straight off the sticky broadcast. Returns null
     * if the system has no battery state to give (guarded, never throws).
     */
    fun currentSample(): BatterySample? = try {
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        sticky?.let { sampleFrom(it) }
    } catch (e: Exception) {
        android.util.Log.w(TAG, "currentSample failed: ${e.message}")
        null
    }

    /**
     * BAT-1 (b) — the (re)connect push: emit the current sample
     * unconditionally and reset the throttle clock, so the first
     * pct-change frame after a reconnect is a full 60 s away.
     *
     * Returns the sample sent, or null when there was nothing valid to send.
     */
    fun sendNow(): BatterySample? {
        val s = currentSample() ?: return null
        if (!BatteryPolicy.isValid(s)) {
            android.util.Log.w(TAG, "sendNow: malformed sample dropped pct=${s.pct} ts=${s.ts}")
            return null
        }
        synchronized(lock) {
            lastSent = s
            lastSentAt = clock()
        }
        emit(s)
        return s
    }

    /** Apply the cadence policy to an observed sample. */
    private fun offer(next: BatterySample) {
        val send: Boolean
        synchronized(lock) {
            val prev = lastSent
            val elapsed = if (prev == null) 0L else clock() - lastSentAt
            send = BatteryPolicy.decide(prev, next, elapsed) == BatteryPolicy.Decision.SEND
            if (send) {
                lastSent = next
                lastSentAt = clock()
            }
        }
        if (send) emit(next)
    }

    private fun sampleFrom(intent: Intent): BatterySample? {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val pct = BatteryPolicy.pctFrom(level, scale) ?: return null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        return BatterySample(pct, BatteryPolicy.chargingFrom(status, plugged), clock())
    }

    /** Test seam: what the reporter believes it last sent. */
    internal fun lastSentForTest(): BatterySample? = synchronized(lock) { lastSent }

    private companion object {
        const val TAG = "BatteryReporter"
    }
}
