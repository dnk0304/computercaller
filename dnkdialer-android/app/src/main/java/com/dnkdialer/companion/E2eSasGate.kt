package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * E2E programme P6.1c part 1b — the service half of [E2eSasContract].
 *
 * P5b built the whole user-facing SAS: the hero face, the copy, the a11y, the
 * Back-swallowing, the instrumented UI tests. What it could not build was the
 * two call sites in the Accept path, and [E2eSasContract]'s doc says so in as
 * many words: *"Forge's remaining change is two call sites"*. P6.1b Part B
 * then ran the first live phone↔computer pair and found the obvious: the phone
 * never shows the SAS, because nobody ever broadcast
 * [E2eSasContract.ACTION_E2E_SAS_REQUIRED] (finding A6-P61B-3).
 *
 * This object is those two call sites, extracted so they can be tested. It
 * writes **no refusal logic**: the caller takes the existing refusal path
 * ([PhoneService]'s latch + DECLINE + `broadcastE2eRefusal`) for every verdict
 * [mayProceed] rejects. The contract is explicit that "the user says the codes
 * differ" is the same outcome as "the peer could not give us an encrypted
 * pairing" and must not get a second, subtly different implementation.
 *
 * ## Ordering is the load-bearing part
 *
 * [await] ARMS the result receiver **before** it broadcasts the request. The
 * other order has a real race: MainActivity's answer is a `sendBroadcast` from
 * the main thread, and on a fast device it can land before a receiver
 * registered afterwards exists — the user taps "Matches", nothing hears it,
 * and the pairing hangs until the deadline and then fails closed. That is a
 * correct-but-infuriating failure, and the unit suite pins the ordering.
 *
 * ## Timeout policy (stated, because there was a choice)
 *
 * **Two deadlines, and which one applies is a fact the UI reports rather than
 * one the service guesses. Expiry is a refusal either way.**
 *
 * vc67. `PENDING_REQUEST_TIMEOUT_MS` (30 s) is the right bound for a prompt
 * nobody can see, and the wrong one for a human comparing five digits across
 * two screens: the vc66 live run timed out on a user who was doing exactly
 * what the SAS asks for. So the wait starts at the short deadline and extends
 * to the long one the moment [E2eSasContract.ACTION_E2E_SAS_SHOWN] arrives —
 * the Activity's statement that the digits are on screen in front of someone.
 * No ack, no extension: the Activity-absent case still fails closed in 30 s.
 *
 * [E2eSasContract] says an unanswered SAS "is already bounded by the 30 s
 * auto-decline that guards every pairing request, and an unanswered SAS must
 * land there rather than completing". That is no longer true by the time we
 * get here — `respondToPairing` cancels that timer at its very first
 * statement, before the Accept branches — so the bound has to be
 * re-established, and re-establishing it with the same constant keeps one
 * number instead of inventing a second.
 *
 * What is still NOT done, deliberately: waiting FOREVER while the app is
 * foreground. Two reasons, neither changed by the ack:
 *
 *  1. **An unbounded wait blocks the single-threaded `e2e-accept` worker.** An
 *     Activity can go away between the ack and the answer (the user leaves,
 *     the process is killed), and a deadline is the only thing that gets the
 *     worker back. 120 s is long enough to read five digits twice and short
 *     enough that a forgotten prompt clears itself.
 *  2. **There is no shade path to reuse.** The shade notification carries
 *     Accept/Decline for the *request*; the SAS surface is `heroSasFace`
 *     inside MainActivity and nothing else, and `showSasConfirm` bails with
 *     "hero not inflated yet" when the Activity is gone. Building a
 *     notification that displays five digits and takes a verification answer
 *     is a new user-facing surface with its own copy, a11y and spoofing
 *     surface — a UI deliverable, not a wiring one, and out of this lane.
 *
 * Re-prompting on a later foreground is NOT implemented and does not need to
 * be: `heroSasFace` is view state on a live Activity, so a user who leaves and
 * returns within the window finds the same digits still on screen. The case it
 * would cover — the Activity DESTROYED mid-window — cannot be served by a
 * re-broadcast either, because the service would have to hold the digits
 * outside the accept worker's stack frame, and "somewhere else the SAS digits
 * live" is a worse trade than a 30 s fail-closed.
 *
 * ## Malformed digits fail closed too
 *
 * If the mode is ON and the digits are absent or not five decimal digits,
 * [await] returns [Verdict.MALFORMED] and never prompts. Prompting with a
 * payload the user cannot meaningfully compare, or completing without
 * prompting, are both worse than refusing: a verification nobody could perform
 * is not a verification.
 */
object E2eSasGate {

    private const val TAG = "E2eSasGate"

    enum class Verdict {
        /** Mode OFF / UNVERIFIED — §13.1 asks for no SAS. Proceed. */
        NOT_REQUIRED,

        /** The user pressed "Matches". Proceed. */
        MATCHED,

        /** The user pressed "Doesn't match". Refuse. */
        REFUSED,

        /** Nobody answered inside the deadline. Refuse. */
        TIMED_OUT,

        /** The pair went away while we waited (teardown, reset, sign-out). */
        CANCELLED,

        /** Mode ON but the digits are not a §13.3 SAS. Refuse, never prompt. */
        MALFORMED,
    }

    /** The only verdicts an ACCEPT may be sent on. Everything else refuses. */
    @JvmStatic
    fun mayProceed(verdict: Verdict): Boolean =
        verdict == Verdict.MATCHED || verdict == Verdict.NOT_REQUIRED

    /**
     * One armed, single-shot SAS wait. Pure JVM — no Android type appears in
     * it, which is what lets the unit suite drive the whole state machine.
     *
     * Single-shot on purpose: the first answer wins and every later one is
     * dropped. A second SAS_RESULT for a pairing already decided is either a
     * double tap or an app trying to talk over the user, and re-deciding on it
     * would let the *second* answer overrule the one the user actually gave.
     */
    class Pending(val pairingId: String) : AutoCloseable {
        private val latch = CountDownLatch(1)
        private val decided = AtomicReference<Verdict?>(null)
        private var release: (() -> Unit)? = null

        /**
         * vc67 — set when the UI acked that the digits are on screen. Volatile
         * because it is written from a binder thread (the receiver) and read
         * from the `e2e-accept` worker that is blocked in [await].
         */
        @Volatile
        private var surfaced: Boolean = false

        /** True once the UI has said these digits reached a screen. */
        val isSurfaced: Boolean get() = surfaced

        internal fun onClose(r: () -> Unit) {
            release = r
        }

        /** True when THIS answer decided it. False for a foreign pairingId or a late answer. */
        fun answer(forPairingId: String, matched: Boolean): Boolean {
            // An answer for another pairing is not ours to consume. Without
            // this check, a stale SAS_RESULT from a pairing the user already
            // dealt with would silently approve the next one.
            if (forPairingId != pairingId) return false
            val verdict = if (matched) Verdict.MATCHED else Verdict.REFUSED
            if (!decided.compareAndSet(null, verdict)) return false
            latch.countDown()
            return true
        }

        /**
         * vc67 — the UI says the digits are on screen for [forPairingId].
         *
         * Extends the deadline and nothing else: it cannot decide, cannot
         * approve, and cannot shorten a wait. An ack for another pairing is
         * ignored for the same reason [answer] ignores one.
         *
         * @return true when THIS pending wait was extended by it.
         */
        fun markSurfaced(forPairingId: String): Boolean {
            if (forPairingId != pairingId) return false
            surfaced = true
            return true
        }

        /** The pair ended underneath us. Refuses, and never blocks a teardown. */
        fun cancel(): Boolean {
            if (!decided.compareAndSet(null, Verdict.CANCELLED)) return false
            latch.countDown()
            return true
        }

        /**
         * Block for at most [unsurfacedMs], and — if the UI acked that the
         * digits reached a screen ([markSurfaced]) — for up to [surfacedMs] in
         * total. Never returns a "proceed" on silence.
         *
         * The two-phase shape is what lets ONE wait carry two deadlines without
         * the caller having to know, before it starts waiting, something only
         * the UI can tell it. The second phase is entered on the state of
         * `surfaced` AT THE SHORT DEADLINE, which is the only moment the answer
         * matters: an ack that arrives later than that means nobody saw the
         * digits inside the window the short deadline protects.
         *
         * [surfacedMs] <= [unsurfacedMs] degrades to a single wait, so a caller
         * that passes one number twice gets exactly the old behaviour.
         */
        @JvmOverloads
        fun await(unsurfacedMs: Long, surfacedMs: Long = unsurfacedMs): Verdict {
            if (!awaitFor(unsurfacedMs)) {
                val extra = surfacedMs - unsurfacedMs
                if (!surfaced || extra <= 0L) return Verdict.TIMED_OUT
                if (!awaitFor(extra)) return Verdict.TIMED_OUT
            }
            return decided.get() ?: Verdict.TIMED_OUT
        }

        /** One bounded wait. False on expiry or interruption — never a "yes". */
        private fun awaitFor(ms: Long): Boolean = try {
            latch.await(ms, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            // Restore the flag and refuse. An interrupted wait is a wait that
            // did not happen; it is not a "yes".
            Thread.currentThread().interrupt()
            false
        }

        override fun close() {
            release?.invoke()
            release = null
        }
    }

    /**
     * The whole flow, with the outside world injected. [arm] must register
     * whatever listens for the answer; it is called BEFORE [broadcast], and
     * the unit suite asserts exactly that.
     *
     * @param onArmed lets the caller stash the [Pending] so a teardown can
     *        [Pending.cancel] it. Called after arming, before the broadcast.
     */
    @JvmStatic
    @JvmOverloads
    fun await(
        modeOn: Boolean,
        digits: String?,
        timeoutMs: Long,
        arm: () -> Pending,
        broadcast: (String) -> Unit,
        onArmed: (Pending?) -> Unit = {},
        surfacedTimeoutMs: Long = timeoutMs,
    ): Verdict {
        if (!modeOn) return Verdict.NOT_REQUIRED
        // NOTE: no android.util.Log anywhere above the "Android binding"
        // heading below. Everything down to here is plain JVM so the unit
        // suite can drive it without Robolectric — this module sets no
        // testOptions.unitTests.returnDefaultValues, so a single Log call
        // would turn every one of those tests into "not mocked".
        if (!E2eSasContract.isWellFormed(digits)) return Verdict.MALFORMED
        val pending = arm()
        return try {
            onArmed(pending)
            broadcast(digits!!)
            pending.await(timeoutMs, surfacedTimeoutMs)
        } finally {
            onArmed(null)
            pending.close()
        }
    }

    // ------------------------------------------------------- Android binding

    /**
     * Register the SAS_RESULT receiver for [pairingId].
     *
     * `RECEIVER_NOT_EXPORTED`, like every other pairing receiver here and for
     * the same reason [E2eSasContract] gives for SAS_REQUIRED: an exported
     * result receiver would let any app on the phone answer the user's
     * verification for them, which is the whole ballgame.
     */
    @JvmStatic
    fun arm(ctx: Context, pairingId: String): Pending {
        val pending = Pending(pairingId)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val action = intent?.action ?: return
                val id = intent.getStringExtra(PhoneService.EXTRA_PAIRING_ID).orEmpty()
                // vc67 — the deadline extension, handled on the SAME receiver
                // as the answer so there is one registration to unregister and
                // one lifetime to reason about.
                if (action == E2eSasContract.ACTION_E2E_SAS_SHOWN) {
                    if (pending.markSurfaced(id)) {
                        Log.i(TAG, "SAS surfaced for $id — deadline extended")
                        DiagLog.d("E2eSasGate", "SAS surfaced — long deadline")
                    }
                    return
                }
                if (action != E2eSasContract.ACTION_E2E_SAS_RESULT) return
                // Contract: "Absent must be read as false." An intent that
                // forgot the extra is not an approval.
                val matched = intent.getBooleanExtra(E2eSasContract.EXTRA_SAS_MATCHED, false)
                if (pending.answer(id, matched)) {
                    Log.i(TAG, "SAS answered for $id matched=$matched")
                    // vc63 — the SAS gate opening/closing. `matched` is a
                    // boolean verdict; the DIGITS themselves are never logged
                    // anywhere, by DiagLog contract.
                    DiagLog.counter(if (matched) "sas.matched" else "sas.rejected")
                    DiagLog.d("E2eSasGate", "SAS gate closed matched=$matched")
                }
            }
        }
        val filter = IntentFilter(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
            addAction(E2eSasContract.ACTION_E2E_SAS_SHOWN)
        }
        // F-3 (SECURITY-ACK-VC67-SAS-LATCH C1): minSdk is 26, and on API
        // 26-32 a bare registerReceiver for an implicit action is EXPORTED.
        // Any other app on the device could then broadcast
        // ACTION_E2E_SAS_RESULT with EXTRA_SAS_MATCHED=true and approve the
        // SAS on the user's behalf - defeating the whole MITM defence without
        // the digits ever being seen. ContextCompat applies
        // RECEIVER_NOT_EXPORTED on every API level: >=33 via the platform
        // flag, <33 by registering under the signature-level permission
        // <applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION that
        // androidx.core declares and only our own package holds.
        ContextCompat.registerReceiver(ctx, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        pending.onClose {
            // Unregistering a receiver twice throws; close() is idempotent
            // above, but a service torn down mid-wait can race us here.
            runCatching { ctx.unregisterReceiver(receiver) }
        }
        return pending
    }

    /** Service → UI. "Show the user these digits and ask." */
    @JvmStatic
    fun request(ctx: Context, pairingId: String, digits: String) {
        ctx.sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_REQUIRED).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
                putExtra(E2eSasContract.EXTRA_SAS_DIGITS, digits)
            }
        )
    }

    /**
     * The call site. Blocking — it is reached from the `e2e-accept` worker,
     * which is where blocking belongs.
     */
    @JvmStatic
    @JvmOverloads
    fun await(
        ctx: Context,
        pairingId: String,
        modeOn: Boolean,
        digits: String?,
        timeoutMs: Long,
        onArmed: (Pending?) -> Unit = {},
        surfacedTimeoutMs: Long = timeoutMs,
    ): Verdict = await(
        modeOn = modeOn,
        digits = digits,
        timeoutMs = timeoutMs,
        arm = { arm(ctx, pairingId) },
        broadcast = { request(ctx, pairingId, it) },
        onArmed = onArmed,
        surfacedTimeoutMs = surfacedTimeoutMs,
    )
}
