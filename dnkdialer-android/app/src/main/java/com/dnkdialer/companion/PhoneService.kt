package com.dnkdialer.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.Manifest
import android.content.pm.PackageManager
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface

class PhoneService : Service() {

    companion object {
        const val ACTION_START = "com.dnkdialer.companion.START_SERVICE"
        const val ACTION_STOP = "com.dnkdialer.companion.STOP_SERVICE"
        /**
         * v18 / Connect+Accept pivot — broadcast actions fired by
         * PhoneService when a pairing request arrives over the relay
         * and the host Activity should surface an in-foreground
         * AlertDialog (in addition to the heads-up notification, which
         * always fires).
         *
         * MainActivity registers a runtime LocalBroadcastReceiver with
         * RECEIVER_NOT_EXPORTED for these so no external app can spoof
         * pairing requests into our UI.
         */
        const val ACTION_PAIRING_REQUEST_IN_FOREGROUND =
            "com.dnkdialer.companion.PAIRING_REQUEST_FG"
        const val ACTION_PAIRING_CANCELLED_IN_FOREGROUND =
            "com.dnkdialer.companion.PAIRING_CANCELLED_FG"
        const val EXTRA_PAIRING_ID = "pairing_id"
        /** Composed "ua · ip" string built by [buildBrowserIdentity]. */
        const val EXTRA_PAIRING_IDENTITY = "pairing_identity"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "dnk_dialer_service"

        /**
         * Dedicated channel for incoming-connection prompts. Separate from
         * the foreground-service channel so the user can mute the persistent
         * "Phone bridge is active" notification without losing the
         * Accept/Decline prompt (which they must see — it's a security
         * affordance, not background noise).
         *
         * IMPORTANCE_HIGH so it shows as a heads-up banner and bypasses
         * Do Not Disturb's "ambient" filter on most OEM builds. Sound +
         * vibration are explicitly enabled in createConnectionRequestChannel.
         */
        private const val CONNECTION_REQUEST_CHANNEL_ID = "connection_requests"

        /**
         * One notification id per pending request — derived from a stable
         * hash of the requestId so Accept/Decline broadcasts can dismiss
         * exactly their own notification without clobbering a concurrent
         * second request. Offset by 10_000 to stay clear of the foreground
         * NOTIFICATION_ID and any other ids the app uses elsewhere.
         */
        private fun notificationIdFor(requestId: String): Int =
            10_000 + (requestId.hashCode() and 0x7fffffff) % 1_000_000

        /**
         * Auto-decline window. If the user neither Accepts nor Declines
         * within 30 seconds we close the pending WS with code 1008 so the
         * webapp can show its "phone declined" copy. This matches the
         * webapp's own connect-side timeout so neither side waits forever
         * on a phone the user walked away from.
         */
        private const val PENDING_REQUEST_TIMEOUT_MS = 30_000L
    }

    /**
     * Lifecycle phases for the relay WebSocket — drives the UI's
     * connection-state surface in MainActivity. Kept independent of
     * MainActivity.ConnState so this Service has no Activity-class
     * coupling; MainActivity translates [RelayPhase] → its own
     * ConnState (which also encodes LAN-server states like WAITING /
     * LIVE based on browser presence).
     *
     *   IDLE      — no connect attempt has been made (or last one was
     *               cleanly disconnected by the user).
     *   CONNECTING — connect() has been called, no onOpen yet.
     *   OPEN      — onOpen fired; WebSocket is live.
     *   FAILED    — onError fired, or onClose with non-1000 code.
     *               [lastConnectionError] carries close code + reason.
     */
    enum class RelayPhase { IDLE, CONNECTING, OPEN, FAILED }

    /**
     * Current relay-socket phase. Read by MainActivity via the
     * onRelayPhaseChanged callback below.
     */
    @Volatile
    var relayPhase: RelayPhase = RelayPhase.IDLE
        private set

    /**
     * Pair of (close code, reason) from the last FAILED transition.
     * Code is the WebSocket close code (1006 for abnormal closure,
     * 4401 for the relay's invalid-token close, etc.) or -1 if the
     * failure came from a pre-handshake exception (onError path).
     * Cleared on the next CONNECTING transition + on user-initiated
     * disconnect.
     */
    @Volatile
    var lastConnectionError: Pair<Int, String?>? = null
        private set

    /**
     * URL the LAST connect attempt targeted (with token URL-encoded).
     * Exposed so MainActivity can render the target prominently while
     * Connecting / Failed — the SINGLE most diagnostic affordance, per
     * the UX brief: lets the user see exactly what the APK is trying
     * to reach so they can spot wrong IP / wrong port / stale LAN.
     * MainActivity is responsible for token-masking before display.
     */
    var lastRelayUrlAttempt: String? = null
        private set

    /**
     * Single callback the UI installs to track relay phase transitions.
     * Fires on the Service's worker thread — MainActivity is responsible
     * for re-posting to the main looper before touching views.
     */
    var onRelayPhaseChanged: ((RelayPhase) -> Unit)? = null

    private val binder = LocalBinder()
    // Dispatch #29 — Phase 4 finish. PhoneServer.kt deleted; the phone
    // no longer accepts inbound LAN WebSocket connections. The only
    // network surface is the outbound relay client (`client` below).
    // The LAN `server` field + all PhoneServer references were removed
    // throughout this file. If a future dispatch reintroduces LAN mode,
    // recover from git history (last live revision: 32d0a44).
    private var lastClientAddress: String? = null
    private var isClientConnected: Boolean = false
    private var client: PhoneClient? = null
    private var clientRelayUrl: String? = null
    private var connectedHostname: String? = null

    // v18 / Connect+Accept pivot — replaces dispatch #29's exponential
    // backoff (1s/2s/4s/8s/16s/30s) with a simple fixed 5s lobby-only
    // auto-reconnect. Rationale:
    //   - The relay is authoritative on active-room membership. Phone
    //     re-opening the WS only re-enters the LOBBY; the browser has
    //     to re-trigger the full pairing handshake to put the pair
    //     back into an active room. There is no longer a "we lost the
    //     pair, urgently rebuild it" scenario from the phone's side.
    //   - With pairing being explicit (user must Accept on phone), an
    //     aggressive 1s/2s/4s backoff isn't valuable — the user isn't
    //     waiting on the phone to reconnect mid-pair, they're either
    //     deliberately starting a session or not.
    //   - 5s is a friendly interval — recovers quickly from a transient
    //     blip without hammering the relay during an outage.
    // Active-room re-entry MUST NEVER be automatic. The phone's only
    // re-dial target is the lobby WebSocket; pairing requires fresh
    // explicit user Accept.
    private val reconnectHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var reconnectRunnable: Runnable? = null
    private val lobbyReconnectDelayMs: Long = 5_000L

    /**
     * Accept/Decline broadcasts from the connection-request notification land
     * in this receiver — we hand back to [handleConnectionDecision] via the
     * shared serviceHandler hook in [ConnectionRequestReceiver]. Held as a
     * field so onDestroy can unregister cleanly.
     */
    private var connectionRequestReceiver: ConnectionRequestReceiver? = null

    /**
     * Disconnect / Reconnect broadcasts from the persistent foreground
     * notification's action buttons land here — routed back into
     * [userDisconnectFromLobby] / [userRejoinLobby] via the shared
     * lobbyActionHandler hook in [LobbyActionReceiver]. Held as a field so
     * onDestroy can unregister cleanly. Separate from connectionRequestReceiver
     * so the benign lobby toggle stays decoupled from the accept/decline path.
     */
    private var lobbyActionReceiver: LobbyActionReceiver? = null

    /**
     * Auto-decline timers keyed by requestId. Started when the notification
     * is posted, cancelled on user Accept / Decline. If a timer fires we
     * treat it as a Decline so the webapp doesn't hang forever waiting on
     * a phone the user walked away from.
     */
    private val pendingRequestTimers = mutableMapOf<String, Runnable>()
    private val pendingRequestHandler = Handler(Looper.getMainLooper())

    /**
     * Round 5 — client-side connect timeout.
     *
     * The `java_websocket` library's `connect()` opens a TCP socket and
     * waits for the handshake response. If the remote host swallows the
     * SYN (silent firewall drop, wrong IP/port, VPN interference like
     * NordLynx), the socket can hang for ~75s+ on Android before the
     * OS finally surfaces a SocketTimeoutException. During that window
     * the user sees the blue "Connecting…" state with NO further signal
     * — and has no way to abort cleanly because no FAILED state ever
     * fires.
     *
     * Solution: schedule a 10s watchdog on the main looper at the moment
     * we call `client.connect()`. If `onOpen` fires first, we cancel
     * the watchdog. If 10s elapses with `client?.isOpen != true`, the
     * watchdog force-closes the socket (code 1006 "connect_timeout")
     * and flips to FAILED with a friendly message.
     *
     * Timeout chosen: 10s. A relay on the same LAN should handshake in
     * ~50–200ms; a WSS handshake to a public relay in <2s. 10s gives
     * generous headroom for slow cellular hand-off without leaving the
     * user staring at a stalled spinner.
     *
     * Cancelled in: onOpen success path, onError/onClose error path,
     * disconnectRelay() (user-initiated cancel), and onDestroy.
     */
    private val connectTimeoutHandler = Handler(Looper.getMainLooper())
    private var connectTimeoutRunnable: Runnable? = null
    private val connectTimeoutMs: Long = 10_000L
    private lateinit var callHandler: CallHandler
    private lateinit var smsHandler: SmsHandler
    private lateinit var contactsHandler: ContactsHandler
    private lateinit var callLogsHandler: CallLogsHandler
    private lateinit var smsStatusReceiver: SmsStatusReceiver
    private var wakeLock: PowerManager.WakeLock? = null

    // ContentObservers for real-time push of SMS / call log changes that originate
    // OUTSIDE this app (e.g. SMS sent from default messaging app, calls placed
    // directly from the dialer). Without these, only changes routed through this
    // service (or the SmsReceiver broadcast) get pushed to the web client.
    private var smsObserver: android.database.ContentObserver? = null
    private var callLogObserver: android.database.ContentObserver? = null
    private var mmsObserver: android.database.ContentObserver? = null
    // Watermarks — only push rows whose DATE is newer than the last one we pushed.
    // Initialised to "now" at observer-start so we don't replay history on every
    // launch (full history is fetched explicitly via GET_MESSAGES / GET_CALL_LOGS).
    private var lastSmsTimestamp: Long = System.currentTimeMillis()
    private var lastCallLogTimestamp: Long = System.currentTimeMillis()
    private var lastMmsTimestamp: Long = System.currentTimeMillis()

    /**
     * Modern call-state observer for Android 12+ (API 31 / S). The deprecated
     * PhoneStateListener still works, but on some Samsung / Android 12+ devices
     * its IDLE callback is unreliable — TelephonyCallback fires more
     * consistently. Both observers are registered and share the
     * callEndedSentRef guard so whichever sees IDLE first wins.
     *
     * Registers on a single-thread executor; both the callback and executor are
     * tracked in fields so onDestroy can unregister and shut them down.
     */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.S)
    private fun registerTelephonyCallback() {
        try {
            val telephonyManager = getSystemService(android.telephony.TelephonyManager::class.java) ?: return
            if (checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) != android.content.pm.PackageManager.PERMISSION_GRANTED) return

            val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
            val callback = object : android.telephony.TelephonyCallback(),
                android.telephony.TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    android.util.Log.d("PhoneService", "TelephonyCallback state: $state source=modern")
                    when (state) {
                        android.telephony.TelephonyManager.CALL_STATE_RINGING -> {
                            // New call — clear downstream guards. CallStateListener
                            // does NOT receive the phone number (that's the legacy
                            // PhoneStateListener with stricter permissions). So for
                            // *incoming* calls (where currentCallNumber is null because
                            // we never set it — only MAKE_CALL sets it), emitting
                            // CALL_INCOMING from here would ship number="" and the
                            // browser would display "Unknown" even though the legacy
                            // listener is about to fire with the real number.
                            //
                            // Strategy: defer the modern-path emission. Schedule a
                            // delayed emit on the main thread; the legacy
                            // PhoneStateListener (which DOES carry phoneNumber) will
                            // almost always win the race and flip callIncomingSentRef,
                            // making this delayed task a no-op. The delayed task only
                            // fires as a last-resort safety net if the legacy listener
                            // never delivered (e.g. some future OEM strips the legacy
                            // path entirely) — in which case "number hidden" is the
                            // best we can do.
                            callEndedSentRef.set(false)
                            callAnsweredSentRef.set(false)
                            val cachedOutgoing = currentCallNumber
                            if (!cachedOutgoing.isNullOrEmpty()) {
                                // Outgoing path: MAKE_CALL ran before this fires, so
                                // currentCallNumber is populated and authoritative.
                                // (Outgoing dialing transitions through RINGING on
                                // some OEMs.) Safe to emit immediately.
                                if (callIncomingSentRef.compareAndSet(false, true)) {
                                    val isViaClient = client?.isOpen == true
                                    sendResponse("CALL_INCOMING", mapOf("number" to cachedOutgoing, "name" to ""), isViaClient)
                                    android.util.Log.d("PhoneService", "CALL_INCOMING fired: number=[$cachedOutgoing] state=RINGING source=modern path=outgoing-cached")
                                } else {
                                    android.util.Log.d("PhoneService", "TelephonyCallback RINGING — CALL_INCOMING already sent, skipping (source=modern)")
                                }
                            } else {
                                // Incoming path: schedule a fallback that fires only
                                // if the legacy listener hasn't beaten us to it.
                                // 600ms is empirically long enough for the legacy
                                // path on Samsung One UI; faster than user-perceptible
                                // ring latency (a phone takes >1s to actually ring).
                                android.util.Log.d("PhoneService", "TelephonyCallback RINGING — deferring CALL_INCOMING to await legacy-path number (source=modern)")
                                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                                    if (callIncomingSentRef.compareAndSet(false, true)) {
                                        val isViaClient = client?.isOpen == true
                                        val fallbackNum = currentCallNumber ?: ""
                                        sendResponse("CALL_INCOMING", mapOf("number" to fallbackNum, "name" to ""), isViaClient)
                                        android.util.Log.w("PhoneService", "CALL_INCOMING fired: number=[$fallbackNum] state=RINGING source=modern-fallback (legacy listener didn't deliver — number likely hidden)")
                                    } else {
                                        android.util.Log.d("PhoneService", "TelephonyCallback modern-fallback skipped — legacy listener already delivered (source=modern-fallback)")
                                    }
                                }, 600L)
                            }
                        }
                        android.telephony.TelephonyManager.CALL_STATE_OFFHOOK -> {
                            callEndedSentRef.set(false)
                            if (callAnsweredSentRef.compareAndSet(false, true)) {
                                val isViaClient = client?.isOpen == true
                                val num = currentCallNumber ?: ""
                                sendResponse("CALL_ANSWERED", mapOf("number" to num), isViaClient)
                                android.util.Log.d("PhoneService", "CALL_ANSWERED fired: number=[$num] state=OFFHOOK source=modern")

                                // Apply speakerphone preference — mirrors the legacy
                                // listener so OFFHOOK from either path honors it.
                                // Uses the layered helper (modern setCommunicationDevice
                                // + legacy isSpeakerphoneOn) so Android 12+ devices
                                // actually flip the speaker on.
                                if (currentCallSpeaker) {
                                    applySpeakerphone(true)
                                    android.util.Log.d("PhoneService", "Speakerphone enabled [TelephonyCallback]")
                                }
                            } else {
                                android.util.Log.d("PhoneService", "TelephonyCallback OFFHOOK — CALL_ANSWERED already sent, skipping")
                            }
                        }
                        android.telephony.TelephonyManager.CALL_STATE_IDLE -> {
                            if (callEndedSentRef.compareAndSet(false, true)) {
                                val isViaClient = client?.isOpen == true
                                val num = currentCallNumber ?: ""
                                sendResponse("CALL_ENDED", mapOf<String, Any>(), isViaClient)
                                currentCallNumber = null
                                currentCallSpeaker = false
                                clearSpeakerphoneOnEnd()
                                android.util.Log.d("PhoneService", "CALL_ENDED fired: number=[$num] state=IDLE source=modern")
                            } else {
                                android.util.Log.d("PhoneService", "TelephonyCallback IDLE — CALL_ENDED already sent, skipping")
                            }
                            // Reset incoming/answered guards so the next call starts clean.
                            callIncomingSentRef.set(false)
                            callAnsweredSentRef.set(false)
                        }
                    }
                }
            }
            telephonyManager.registerTelephonyCallback(executor, callback)
            telCallbackRef = callback
            telExecutorRef = executor
            android.util.Log.d("PhoneService", "TelephonyCallback registered")
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "TelephonyCallback registration failed: ${e.message}")
        }
    }

    /**
     * The number we last asked the platform to dial. Cached because Android does not
     * always include the phone number in PhoneStateListener callbacks (privacy on some
     * OEMs / API levels), so we fall back to this value when forwarding state changes
     * to the web app.
     */
    private var currentCallNumber: String? = null

    /**
     * Whether the current call should use speakerphone. Set by MAKE_CALL payload
     * and applied when the call transitions to OFFHOOK. Also mutable mid-call via
     * the SET_SPEAKER command. Reset on IDLE.
     */
    private var currentCallSpeaker: Boolean = false

    /**
     * Number of browser/web clients currently attached to the relay for this
     * phone session. Updated whenever the relay pushes a BROWSER_STATUS frame.
     * Default 0 so the UI shows "Waiting for web app" until a real browser
     * actually joins (false-connection fix — relay-socket-open != browser-paired).
     *
     * v18+ note: the Connect+Accept relay no longer emits BROWSER_STATUS — it
     * now uses PAIRING_ACTIVE / PAIRING_TERMINATED instead, surfaced via
     * [isPairActive] below. This field + handler are retained as harmless
     * dead-code paths in case a future relay revision reinstates the protocol.
     *
     * MainActivity polls this via getBrowserCount() on its 2 s status loop and
     * swaps the connection label between "Waiting…" and "N web client(s)
     * connected" based on the value.
     */
    private var currentBrowserCount: Int = 0

    /** Public read-only accessor for MainActivity's status polling loop. */
    fun getBrowserCount(): Int = currentBrowserCount

    /**
     * Connect+Accept pivot (v18+): whether the relay reports an ACTIVE pair
     * between this phone session and a paired browser. Distinct from the
     * relay-socket [relayPhase] — the WebSocket can be OPEN while still in
     * the lobby (no browser has been Accepted yet).
     *
     * Lifecycle:
     *   - true on PAIRING_ACTIVE (relay confirms the pair crossed into the
     *     active room — either right after our ACCEPT_PAIRING ack, or because
     *     the relay re-promoted an existing session on reconnect).
     *   - false on PAIRING_TERMINATED (browser left, relay reaped the room).
     *   - false on relay WS close (any code) — the active pair cannot
     *     survive a relay socket teardown; we must re-enter the lobby.
     *   - false on user-initiated disconnectRelay() — Sign Out clears
     *     everything including any in-flight pair claim.
     *   - false on service onCreate (default state).
     *
     * MainActivity polls this via [getIsPairActive] on its 2 s status loop
     * to render "Connected — paired with browser" (true) vs "Lobby — waiting
     * for browser to connect" (false) on top of the OPEN phase.
     */
    @Volatile
    private var isPairActive: Boolean = false

    /** Public read-only accessor for MainActivity's status polling loop. */
    fun getIsPairActive(): Boolean = isPairActive

    // -----------------------------------------------------------------------
    // 2-mode BT audio routing (dispatch 2026-05-25).
    //
    // The "Speak through PC" toggle on the browser side routes call audio
    // over a Bluetooth Hands-Free Profile (HFP) link to the user's PC.
    // We don't initiate pairing — the user pairs phone↔PC via system
    // Settings. We OBSERVE the resulting HFP connection state via:
    //   1. A BluetoothHeadset profile-proxy (gives us the current device
    //      list at any moment).
    //   2. A broadcast receiver on BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED
    //      (notifies us of every state transition so we can push
    //      BT_HEADSET_STATUS to the browser in real time).
    //
    // Both observers are gated on BLUETOOTH_CONNECT (API 31+) — without it
    // we silently degrade to "BT mode unavailable" rather than crashing.
    // -----------------------------------------------------------------------

    /** Profile-proxy handle. Acquired via BluetoothAdapter.getProfileProxy
     *  in onCreate, released in onDestroy. Null until the platform calls
     *  back onServiceConnected (async — typically <50ms). */
    private var bluetoothHeadset: android.bluetooth.BluetoothHeadset? = null

    /** Receiver for ACTION_CONNECTION_STATE_CHANGED. Held as a field so
     *  onDestroy can unregister cleanly. */
    private var bluetoothHeadsetReceiver: android.content.BroadcastReceiver? = null

    /** Cached current state — pushed to the browser whenever it changes
     *  AND whenever a new browser pairing becomes active so the UI lights
     *  up correctly on its initial render. */
    private var btHeadsetConnected: Boolean = false
    private var btHeadsetDeviceName: String? = null

    /**
     * Layered speakerphone toggle. On Android 12+ (API 31), the legacy
     * `AudioManager.isSpeakerphoneOn` is deprecated and on many OEM builds
     * (Samsung, Pixel) silently no-ops because (a) the API is restricted and
     * (b) the actual call audio lives in the system dialer's process, not ours.
     * The modern path is `setCommunicationDevice(TYPE_BUILTIN_SPEAKER)` which
     * requires the audio mode to be MODE_IN_CALL or MODE_IN_COMMUNICATION
     * first. We use MODE_IN_COMMUNICATION — the system dialer owns
     * MODE_IN_CALL, and our app can hold COMMUNICATION alongside and still
     * influence routing on most devices. Both modern and legacy paths are
     * attempted in parallel so the toggle has the best possible chance of
     * actually flipping the speaker on the user's specific device/OEM.
     *
     * Called from SET_SPEAKER (live toggle) and from the OFFHOOK observers
     * (apply pre-dial speaker preference once the call goes active).
     */
    private fun applySpeakerphone(enabled: Boolean) {
        try {
            val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager

            // Set mode first — speakerphone routing only works when the audio
            // mode is one of MODE_IN_CALL / MODE_IN_COMMUNICATION.
            audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION

            // Modern API (Android 12+ / API 31+) — preferred path.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                if (enabled) {
                    val speakerDevice = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    }
                    if (speakerDevice != null) {
                        val ok = audioManager.setCommunicationDevice(speakerDevice)
                        android.util.Log.d("PhoneService", "applySpeakerphone modern (on): setCommunicationDevice=$ok")
                    } else {
                        android.util.Log.w("PhoneService", "applySpeakerphone modern: no BUILTIN_SPEAKER device available")
                    }
                } else {
                    audioManager.clearCommunicationDevice()
                    android.util.Log.d("PhoneService", "applySpeakerphone modern (off): clearCommunicationDevice")
                }
            }

            // Legacy fallback — Android <12 and some OEMs that still honor it
            // in parallel. Keep both paths active for maximum coverage.
            @Suppress("DEPRECATION")
            run { audioManager.isSpeakerphoneOn = enabled }

            android.util.Log.d("PhoneService", "applySpeakerphone applied: enabled=$enabled, audioMode=${audioManager.mode}, isSpeakerphoneOn=${audioManager.isSpeakerphoneOn}")
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "applySpeakerphone failed: ${e.message}", e)
        }
    }

    /**
     * Release the speakerphone routing on call end. Clears the modern
     * communication-device assignment, drops the legacy flag, and returns
     * audio mode to NORMAL.
     */
    private fun clearSpeakerphoneOnEnd() {
        try {
            val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            }
            @Suppress("DEPRECATION")
            run { audioManager.isSpeakerphoneOn = false }
            // Tear down any in-progress SCO link too — when the call ends we
            // want to release the BT mic/spk slot whether the user was on PC
            // mode or not. Cheap no-op if SCO was never started.
            try {
                @Suppress("DEPRECATION")
                audioManager.stopBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isBluetoothScoOn = false
            } catch (e: Exception) {
                // Some OEMs throw SecurityException if SCO was never started.
                android.util.Log.d("PhoneService", "stopBluetoothSco on call-end: ${e.message}")
            }
            audioManager.mode = android.media.AudioManager.MODE_NORMAL
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "clearSpeakerphoneOnEnd failed: ${e.message}")
        }
    }

    /**
     * Bluetooth-SCO routing for the "Speak through PC" mode.
     *
     * SCO (Synchronous Connection-Oriented) is the BT audio channel used
     * by Hands-Free Profile (HFP) — the same channel a wireless headset
     * uses for phone-call audio. When the user pairs their phone with
     * their PC over BT-HFP, Windows / macOS exposes the SCO link as a
     * regular audio device, so call audio routed through it shows up on
     * the PC speakers and mic.
     *
     * Why startBluetoothSco() and not setCommunicationDevice(TYPE_BLUETOOTH_SCO)?
     *   The modern setCommunicationDevice path is gated on the SCO link
     *   being already up — and the link only comes up after startBluetoothSco
     *   on most OEM stacks. Calling both is safe and gives the best
     *   coverage across Samsung / Pixel / OnePlus.
     *
     * Same MODE_IN_COMMUNICATION caveat as applySpeakerphone — the system
     * dialer owns MODE_IN_CALL; we use COMMUNICATION as the best we can
     * do without becoming the default dialer.
     *
     * No-op on devices where BT-HFP isn't available (BluetoothAdapter null,
     * or no HFP-capable device paired). Caller (SET_AUDIO_SOURCE handler)
     * is responsible for gating — but we defensive-try the route anyway,
     * since the worst case is a logged failure and the user's call stays
     * on whatever the previous route was.
     */
    private fun applyBluetoothSco(enabled: Boolean) {
        try {
            val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION

            if (enabled) {
                // 1. Start the SCO link. This is async — the BT stack takes
                //    ~500-1500ms to negotiate; setBluetoothScoOn(true) primes
                //    the routing for when SCO_AUDIO_STATE_CONNECTED arrives.
                @Suppress("DEPRECATION")
                audioManager.startBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isBluetoothScoOn = true
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false

                // 2. Modern API (API 31+): also pin the communication device
                //    explicitly. Some OEMs ignore the legacy startSco call
                //    once the system dialer is mid-call; the modern path
                //    sidesteps that. Best-effort — failure leaves the legacy
                //    path doing the work.
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                    val scoDevice = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        it.type == android.media.AudioDeviceInfo.TYPE_BLE_HEADSET
                    }
                    if (scoDevice != null) {
                        val ok = audioManager.setCommunicationDevice(scoDevice)
                        android.util.Log.d("PhoneService", "applyBluetoothSco modern (on): setCommunicationDevice=$ok type=${scoDevice.type}")
                    } else {
                        android.util.Log.w("PhoneService", "applyBluetoothSco modern: no SCO/BLE communication device available — falling back to legacy startBluetoothSco only")
                    }
                }
            } else {
                @Suppress("DEPRECATION")
                audioManager.stopBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isBluetoothScoOn = false
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice()
                }
            }

            android.util.Log.d("PhoneService", "applyBluetoothSco applied: enabled=$enabled, audioMode=${audioManager.mode}, isBluetoothScoOn=${audioManager.isBluetoothScoOn}")
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "applyBluetoothSco failed: ${e.message}", e)
        }
    }

    /**
     * Unified audio-source dispatcher. Called by SET_AUDIO_SOURCE (replaces
     * the legacy SET_SPEAKER, which is retained as an alias on the wire).
     *
     * Accepted values (FORGE-2, v24, 2026-05-26):
     *
     *   - "phone"     — phone-default routing. Clears both forced speakerphone
     *                   AND BT-SCO so the system picks the default route for
     *                   MODE_IN_COMMUNICATION (earpiece on devices that have
     *                   one; OEM decides on the rest). This is the new default
     *                   the browser emits when the user taps "Phone".
     *   - "pc"        — BT-HFP SCO link to the user's paired PC. Clears
     *                   speakerphone first to avoid stacking routes.
     *
     * Legacy aliases (kept so old browser builds keep working against v24+
     * APKs — see brief §2 Decision D, symmetric back-compat):
     *
     *   - "earpiece"  — alias for "phone". Maps to the same routing.
     *   - "speaker"   — phone loudspeaker. Only the LEGACY SET_SPEAKER path
     *                   and old browser builds emit this; the new UI never
     *                   does. Retained so the legacy command shape doesn't
     *                   break.
     *   - "bluetooth" — alias for "pc". Maps to the same routing.
     *
     * Each terminal cleanly tears down the OTHER routings before applying
     * its own — switching from speaker to pc must drop the speaker route,
     * not stack on top of it. Atomic order matters: clear legacy speaker /
     * BT first, then apply the target.
     *
     * currentCallSpeaker is set true ONLY for the legacy "speaker" value.
     * The new "phone" / "pc" / legacy "earpiece" / "bluetooth" values all
     * set it false — there's no forced speakerphone in the new UI.
     */
    private fun applyAudioSource(source: String) {
        currentCallSpeaker = (source == "speaker")
        when (source) {
            "phone", "earpiece" -> {
                applyBluetoothSco(false)
                applySpeakerphone(false)
            }
            "speaker" -> {
                applyBluetoothSco(false)
                applySpeakerphone(true)
            }
            "pc", "bluetooth" -> {
                applySpeakerphone(false)
                applyBluetoothSco(true)
            }
            else -> {
                android.util.Log.w("PhoneService", "applyAudioSource: unknown source '$source' — ignoring")
            }
        }
    }

    /**
     * Acquire the BluetoothHeadset profile proxy + register a state-change
     * receiver so we can push BT_HEADSET_STATUS to the browser whenever
     * the HFP link comes up or goes down.
     *
     * Gated on BLUETOOTH_CONNECT (API 31+) — pre-API-31 the manifest
     * declares legacy BLUETOOTH + BLUETOOTH_ADMIN with maxSdkVersion=30
     * so this works without a runtime grant on older devices.
     *
     * Initial state is pushed to the browser via the existing onConnected
     * pair-active path (see broadcastBtHeadsetStatus); the first push
     * after pairing happens automatically on the next state-change
     * broadcast.
     */
    private fun registerBluetoothHeadsetObserver() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                if (checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) !=
                    android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    android.util.Log.d("PhoneService", "registerBluetoothHeadsetObserver: BLUETOOTH_CONNECT not granted — skipping (BT-PC mode will stay disabled)")
                    return
                }
            }

            val bluetoothManager = getSystemService(android.content.Context.BLUETOOTH_SERVICE)
                as? android.bluetooth.BluetoothManager
            val adapter = bluetoothManager?.adapter
            if (adapter == null) {
                android.util.Log.d("PhoneService", "registerBluetoothHeadsetObserver: no BluetoothAdapter (device has no BT hardware)")
                return
            }

            // 1. Profile-proxy — gives us getConnectedDevices() at any moment.
            adapter.getProfileProxy(
                this,
                object : android.bluetooth.BluetoothProfile.ServiceListener {
                    override fun onServiceConnected(profile: Int, proxy: android.bluetooth.BluetoothProfile) {
                        if (profile == android.bluetooth.BluetoothProfile.HEADSET) {
                            bluetoothHeadset = proxy as android.bluetooth.BluetoothHeadset
                            // Initial-state snapshot — if the user paired BEFORE
                            // we registered (typical), the broadcast receiver
                            // won't have fired yet so seed from the proxy's
                            // current device list.
                            try {
                                val connected = proxy.connectedDevices?.firstOrNull()
                                updateBtHeadsetState(connected != null, connected)
                            } catch (sec: SecurityException) {
                                android.util.Log.w("PhoneService", "BluetoothHeadset.connectedDevices SecurityException: ${sec.message}")
                            }
                            android.util.Log.d("PhoneService", "BluetoothHeadset proxy connected: initial connected=$btHeadsetConnected device=$btHeadsetDeviceName")
                        }
                    }

                    override fun onServiceDisconnected(profile: Int) {
                        if (profile == android.bluetooth.BluetoothProfile.HEADSET) {
                            bluetoothHeadset = null
                            android.util.Log.d("PhoneService", "BluetoothHeadset proxy disconnected")
                        }
                    }
                },
                android.bluetooth.BluetoothProfile.HEADSET
            )

            // 2. ACTION_CONNECTION_STATE_CHANGED — fires on every HFP up/down
            //    transition. Single source of truth for the browser-side state.
            val receiver = object : android.content.BroadcastReceiver() {
                override fun onReceive(ctx: android.content.Context?, intent: android.content.Intent?) {
                    if (intent?.action != android.bluetooth.BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED) return
                    val state = intent.getIntExtra(android.bluetooth.BluetoothHeadset.EXTRA_STATE, -1)
                    val device: android.bluetooth.BluetoothDevice? = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(android.bluetooth.BluetoothDevice.EXTRA_DEVICE, android.bluetooth.BluetoothDevice::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(android.bluetooth.BluetoothDevice.EXTRA_DEVICE)
                    }
                    val connected = state == android.bluetooth.BluetoothProfile.STATE_CONNECTED
                    updateBtHeadsetState(connected, if (connected) device else null)
                    android.util.Log.d("PhoneService", "ACTION_CONNECTION_STATE_CHANGED: state=$state connected=$connected device=$btHeadsetDeviceName")

                    // If the user was on bluetooth audio mode and the HFP
                    // link just died mid-call, the browser will switch the
                    // toggle back to phone-earpiece on receipt of the
                    // BT_HEADSET_STATUS push. Defensive: also drop our
                    // local SCO routing so the call doesn't go silent.
                    if (!connected) {
                        applyBluetoothSco(false)
                    }
                }
            }
            val filter = android.content.IntentFilter(
                android.bluetooth.BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED
            )
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(receiver, filter)
            }
            bluetoothHeadsetReceiver = receiver
            android.util.Log.d("PhoneService", "BluetoothHeadset state observer registered")
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "registerBluetoothHeadsetObserver failed: ${e.message}", e)
        }
    }

    /** Centralised state writer + browser push. Always re-emits on change so
     *  the browser-side toggle can auto-light when the user pairs the PC. */
    private fun updateBtHeadsetState(connected: Boolean, device: android.bluetooth.BluetoothDevice?) {
        val newName: String? = if (connected && device != null) {
            try {
                // getName() throws SecurityException on API 31+ if BLUETOOTH_CONNECT
                // isn't granted — graceful fallback to "Bluetooth device".
                device.name ?: "Bluetooth device"
            } catch (sec: SecurityException) {
                "Bluetooth device"
            }
        } else null

        val changed = (connected != btHeadsetConnected) || (newName != btHeadsetDeviceName)
        btHeadsetConnected = connected
        btHeadsetDeviceName = newName
        if (changed) {
            broadcastBtHeadsetStatus()
        }
    }

    /** Push current BT_HEADSET_STATUS to the browser. Safe to call when no
     *  client is connected — sendResponse degrades to a logged no-op. */
    private fun broadcastBtHeadsetStatus() {
        val isViaClient = client?.isOpen == true
        sendResponse(
            "BT_HEADSET_STATUS",
            mapOf(
                "connected" to btHeadsetConnected,
                "deviceName" to (btHeadsetDeviceName ?: "")
            ),
            isViaClient
        )
        android.util.Log.d("PhoneService", "BT_HEADSET_STATUS broadcast: connected=$btHeadsetConnected deviceName=$btHeadsetDeviceName")
    }

    /**
     * Send a DTMF tone into the active call's audio path.
     *
     * Why ToneGenerator and not TelecomManager.playDtmfTone or Connection.sendDtmf?
     *   We use TelecomManager.placeCall() to dial — the call itself is owned by
     *   the system default dialer (or whichever ConnectionService the platform
     *   selected). We do NOT register an InCallService and we do NOT own a
     *   ConnectionService, so we have no Connection / Call handle to invoke
     *   sendDtmf on. TelecomManager.playDtmfTone is also gated to InCallService
     *   holders.
     *
     *   ToneGenerator(STREAM_VOICE_CALL) is the supported alternative for
     *   non-default-dialer apps: it generates a DTMF waveform and routes it
     *   through the voice-call audio stream. On most OEM stacks the modem
     *   picks up STREAM_VOICE_CALL output and mixes it into the outbound RF
     *   audio, which is exactly what we want — the remote party (IVR, voicemail
     *   tree, etc.) hears the tone.
     *
     *   Caveats:
     *     - Some OEMs / Android versions route STREAM_VOICE_CALL only to the
     *       earpiece, NOT to the modem. In that case the user hears the tone
     *       locally but the IVR does not — this is hardware/firmware dependent
     *       and there is no portable workaround short of becoming the default
     *       dialer. Worth confirming on Dennis's Samsung SM-S911B.
     *     - We use a short tone duration (180ms) so successive presses queue
     *       cleanly. The tone is fire-and-forget — we don't wait for it to
     *       finish before returning, but we DO release the ToneGenerator after
     *       a small delay to avoid leaking native resources.
     */
    private fun sendDtmfTone(digit: Char) {
        // Map character → ToneGenerator constant. Only 0-9, *, # are valid DTMF.
        val toneType = when (digit) {
            '0' -> android.media.ToneGenerator.TONE_DTMF_0
            '1' -> android.media.ToneGenerator.TONE_DTMF_1
            '2' -> android.media.ToneGenerator.TONE_DTMF_2
            '3' -> android.media.ToneGenerator.TONE_DTMF_3
            '4' -> android.media.ToneGenerator.TONE_DTMF_4
            '5' -> android.media.ToneGenerator.TONE_DTMF_5
            '6' -> android.media.ToneGenerator.TONE_DTMF_6
            '7' -> android.media.ToneGenerator.TONE_DTMF_7
            '8' -> android.media.ToneGenerator.TONE_DTMF_8
            '9' -> android.media.ToneGenerator.TONE_DTMF_9
            '*' -> android.media.ToneGenerator.TONE_DTMF_S
            '#' -> android.media.ToneGenerator.TONE_DTMF_P
            else -> {
                android.util.Log.w("PhoneService", "sendDtmfTone: rejecting non-DTMF char '$digit'")
                return
            }
        }

        try {
            // Volume range 0-100. 80 is loud enough to register on most IVRs
            // without clipping. STREAM_VOICE_CALL is the routing target.
            val toneGen = android.media.ToneGenerator(
                android.media.AudioManager.STREAM_VOICE_CALL,
                80
            )
            // 180ms is the sweet spot — long enough to register on most IVR
            // tone detectors, short enough that rapid keying doesn't stack.
            val ok = toneGen.startTone(toneType, 180)
            android.util.Log.d("PhoneService", "sendDtmfTone: digit='$digit' tone=$toneType startTone=$ok")

            // Release the native resource after the tone has had time to play.
            // Releasing immediately would clip the tone; never releasing leaks.
            Handler(Looper.getMainLooper()).postDelayed({
                try { toneGen.release() } catch (e: Exception) { /* swallow */ }
            }, 240)
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "sendDtmfTone failed for '$digit': ${e.message}", e)
        }
    }

    /**
     * Single guard against double-sending CALL_ENDED. The legacy PhoneStateListener
     * and the modern TelephonyCallback (Android 12+) can both observe the IDLE
     * transition independently — whichever fires first flips this from false → true
     * via compareAndSet, and the other no-ops. Reset on RINGING / OFFHOOK so the
     * next call starts with a fresh guard.
     */
    private var callEndedSentRef = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Guards for CALL_INCOMING and CALL_ANSWERED — same dedup pattern as
     * callEndedSentRef. On Android 12+ the legacy PhoneStateListener.listen()
     * is silently non-functional, so the modern TelephonyCallback must carry
     * these events. Both observers are wired and whichever fires first wins.
     * Reset to false on IDLE (and on opposite-direction transitions, where
     * applicable) so the next call gets a fresh guard.
     */
    private var callIncomingSentRef = java.util.concurrent.atomic.AtomicBoolean(false)
    private var callAnsweredSentRef = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Modern call-state observer (Android 12+ / API 31+). Held so we can
     * unregister in onDestroy. The single-thread executor backing it is also
     * tracked here so we can shut it down cleanly.
     */
    private var telCallbackRef: android.telephony.TelephonyCallback? = null
    private var telExecutorRef: java.util.concurrent.ExecutorService? = null

    /**
     * Real-call-state listener. The previous implementation faked CALL_ANSWERED the
     * moment MAKE_CALL was handled, which lied to the UI when the call was still
     * dialing or got rejected. This listener forwards genuine telephony state changes
     * (RINGING / OFFHOOK / IDLE) to the web app.
     */
    private val phoneStateListener = object : android.telephony.PhoneStateListener() {
        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCallStateChanged(state: Int, phoneNumber: String?) {
            val number = phoneNumber?.takeIf { it.isNotEmpty() } ?: currentCallNumber ?: ""
            when (state) {
                android.telephony.TelephonyManager.CALL_STATE_RINGING -> {
                    android.util.Log.d("PhoneService", "PhoneStateListener state=RINGING phoneNumber=[$phoneNumber] resolvedNumber=[$number] source=legacy")
                    // New call beginning — clear CALL_ENDED + CALL_ANSWERED guards
                    // so the downstream transitions (whichever observer sees them
                    // first) can fire. CALL_INCOMING itself is guarded below.
                    //
                    // IMPORTANT: this listener is the ONLY one that carries the
                    // incoming phoneNumber (the modern TelephonyCallback.CallStateListener
                    // does not). So on Android 12+ this path MUST win the
                    // callIncomingSentRef race for incoming calls — otherwise the
                    // modern path would ship number="" and the browser shows
                    // "Unknown". The modern-path RINGING handler defers its emit
                    // via Handler.postDelayed(600ms) precisely so this legacy
                    // listener gets first dibs.
                    callEndedSentRef.set(false)
                    callAnsweredSentRef.set(false)
                    if (callIncomingSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_INCOMING", mapOf("number" to number, "name" to ""), isViaClient)
                        android.util.Log.d("PhoneService", "CALL_INCOMING fired: number=[$number] state=RINGING source=legacy")
                    } else {
                        android.util.Log.d("PhoneService", "PhoneStateListener RINGING — CALL_INCOMING already sent, skipping (source=legacy)")
                    }
                }
                android.telephony.TelephonyManager.CALL_STATE_OFFHOOK -> {
                    android.util.Log.d("PhoneService", "PhoneStateListener state=OFFHOOK phoneNumber=[$phoneNumber] resolvedNumber=[$number] source=legacy")
                    callEndedSentRef.set(false)
                    if (callAnsweredSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_ANSWERED", mapOf("number" to number), isViaClient)
                        android.util.Log.d("PhoneService", "CALL_ANSWERED fired: number=[$number] state=OFFHOOK source=legacy")
                    } else {
                        android.util.Log.d("PhoneService", "PhoneStateListener OFFHOOK — CALL_ANSWERED already sent, skipping (source=legacy)")
                    }

                    // Apply speakerphone preference — layered helper handles
                    // both the modern setCommunicationDevice path (API 31+)
                    // and the legacy isSpeakerphoneOn fallback.
                    if (currentCallSpeaker) {
                        applySpeakerphone(true)
                        android.util.Log.d("PhoneService", "Speakerphone enabled")
                    }
                }
                android.telephony.TelephonyManager.CALL_STATE_IDLE -> {
                    android.util.Log.d("PhoneService", "PhoneStateListener state=IDLE source=legacy")
                    // Single guard — TelephonyCallback (12+) may also observe this
                    // transition. First-writer wins.
                    if (callEndedSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_ENDED", mapOf<String, Any>(), isViaClient)
                        android.util.Log.d("PhoneService", "CALL_ENDED fired: state=IDLE source=legacy")
                        currentCallNumber = null
                        currentCallSpeaker = false
                        clearSpeakerphoneOnEnd()
                        // Retry CALL_ENDED after 800 ms in case the relay WS was briefly
                        // busy and dropped the first frame. The web client dedupes by
                        // event semantics (idempotent CALL_ENDED), so a duplicate is safe.
                        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                            if (client?.isOpen == true) {
                                sendResponse("CALL_ENDED", mapOf<String, Any>(), true)
                            }
                        }, 800)
                    } else {
                        android.util.Log.d("PhoneService", "PhoneStateListener IDLE — CALL_ENDED already sent, skipping")
                    }
                    // Reset incoming/answered guards so the NEXT call starts clean,
                    // regardless of which observer fired the CALL_ENDED above.
                    callIncomingSentRef.set(false)
                    callAnsweredSentRef.set(false)
                }
            }
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): PhoneService = this@PhoneService
    }

    override fun onCreate() {
        super.onCreate()
        android.util.Log.d("PhoneService", "onCreate called")
        
        // Initialize handlers
        callHandler = CallHandler(this)
        smsHandler = SmsHandler(this)
        contactsHandler = ContactsHandler(this)
        callLogsHandler = CallLogsHandler(this)

        // Acquire wake lock to keep service running
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "DNKDialer::PhoneServiceWakeLock"
        )
        wakeLock?.acquire()
        android.util.Log.d("PhoneService", "Wake lock acquired")

        createNotificationChannel()
        createConnectionRequestChannel()

        // Register the connection-request action receiver. Hooks the shared
        // serviceHandler so Accept/Decline broadcasts route through here.
        // Internal-only intents so we keep them NOT_EXPORTED to prevent
        // spoofed Accepts from outside the app.
        connectionRequestReceiver = ConnectionRequestReceiver()
        val connectionFilter = android.content.IntentFilter().apply {
            addAction(ConnectionRequestReceiver.ACTION_ACCEPT_CONNECTION)
            addAction(ConnectionRequestReceiver.ACTION_DECLINE_CONNECTION)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(
                connectionRequestReceiver,
                connectionFilter,
                Context.RECEIVER_NOT_EXPORTED
            )
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(connectionRequestReceiver, connectionFilter)
        }
        ConnectionRequestReceiver.serviceHandler = { requestId, accept ->
            handleConnectionDecision(requestId, accept)
        }

        // Register the lobby-toggle action receiver. Hooks the shared
        // lobbyActionHandler so the foreground notification's Disconnect /
        // Reconnect buttons route through here into the existing v25
        // userDisconnectFromLobby() / userRejoinLobby() methods. Internal-only
        // intents → NOT_EXPORTED on API 33+ so no other process can spoof a
        // disconnect/rejoin against our service.
        lobbyActionReceiver = LobbyActionReceiver()
        val lobbyFilter = android.content.IntentFilter().apply {
            addAction(LobbyActionReceiver.ACTION_DISCONNECT_LOBBY)
            addAction(LobbyActionReceiver.ACTION_REJOIN_LOBBY)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(
                lobbyActionReceiver,
                lobbyFilter,
                Context.RECEIVER_NOT_EXPORTED
            )
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(lobbyActionReceiver, lobbyFilter)
        }
        LobbyActionReceiver.lobbyActionHandler = { rejoin ->
            if (rejoin) userRejoinLobby() else userDisconnectFromLobby()
        }

        // Register for real telephony state changes so we forward true call state
        // (ringing / active / ended) to the web app instead of fake responses tied
        // to MAKE_CALL handling.
        try {
            val telephonyManager =
                getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
            @Suppress("DEPRECATION")
            telephonyManager.listen(
                phoneStateListener,
                android.telephony.PhoneStateListener.LISTEN_CALL_STATE
            )
            android.util.Log.d("PhoneService", "PhoneStateListener registered")
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Failed to register PhoneStateListener: ${e.message}", e)
        }

        // Register SmsStatusReceiver for SMS_SENT / SMS_DELIVERED PendingIntent callbacks.
        // Use RECEIVER_NOT_EXPORTED on API 33+ — these intents are internal-only and
        // exporting them would let any app spoof send/delivery status.
        smsStatusReceiver = SmsStatusReceiver()
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(smsStatusReceiver, android.content.IntentFilter().apply {
                addAction("SMS_SENT")
                addAction("SMS_DELIVERED")
            }, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(smsStatusReceiver, android.content.IntentFilter().apply {
                addAction("SMS_SENT")
                addAction("SMS_DELIVERED")
            })
        }

        SmsStatusReceiver.onSmsSent = { clientMsgId, success, error ->
            val isViaClient = client?.isOpen == true
            if (success) {
                sendResponse(
                    "SMS_SEND_STATUS",
                    mapOf("clientMsgId" to clientMsgId, "status" to "sent"),
                    isViaClient
                )
            } else {
                sendResponse(
                    "SMS_SEND_STATUS",
                    mapOf(
                        "clientMsgId" to clientMsgId,
                        "status" to "failed",
                        "error" to (error ?: "Unknown")
                    ),
                    isViaClient
                )
            }
        }

        SmsStatusReceiver.onSmsDelivered = { clientMsgId ->
            val isViaClient = client?.isOpen == true
            sendResponse(
                "SMS_SEND_STATUS",
                mapOf("clientMsgId" to clientMsgId, "status" to "delivered"),
                isViaClient
            )
        }

        // 2-mode BT audio routing (2026-05-25): acquire the BluetoothHeadset
        // profile proxy + register the connection-state-changed receiver.
        // Best-effort — falls through to a logged warning + disabled
        // BT-PC mode on devices without BT hardware or without the
        // BLUETOOTH_CONNECT runtime grant.
        registerBluetoothHeadsetObserver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        android.util.Log.d("PhoneService", "onStartCommand called with action: ${intent?.action}")

        when (intent?.action) {
            ACTION_START -> {
                android.util.Log.d("PhoneService", "Starting bridge...")

                // Dispatch #29 — Phase 4 finish. startServer() (the LAN
                // PhoneServer on port 8765) is gone. We now ONLY wire
                // up the side-effects that used to live inside startServer
                // (telephony callback, SMS receiver, content observers,
                // notification listener bridge) and then auto-dial the
                // SaaS relay. The user signed in via SignInActivity, the
                // phoneToken is in TokenStore, we connect outbound to
                // wss://computercaller.com/relay/phone?token=… so the
                // webapp's room sees the phone immediately.
                installSideEffects()

                // Disconnect-from-lobby gate (v25, 2026-05-26). The user
                // chose to stay disconnected last time they were on this
                // screen; honor that across cold launches, OS restarts
                // (START_STICKY), and any startService(...ACTION_START)
                // call site. Token in TokenStore is left intact — the
                // user stays signed in, just doesn't auto-dial. Cleared
                // by tapping Rejoin Lobby (userRejoinLobby) or Sign Out
                // (TokenStore.clear wipes everything for free).
                val phoneToken = TokenStore.getPhoneToken(this)
                when {
                    phoneToken.isNullOrBlank() -> {
                        android.util.Log.w("PhoneService", "No phoneToken in TokenStore — skipping relay auto-dial")
                    }
                    TokenStore.isUserStayedDisconnected(this) -> {
                        android.util.Log.d("PhoneService", "User chose to stay disconnected from lobby — skipping auto-dial")
                    }
                    else -> {
                        val relayUrl = "wss://computercaller.com/relay/phone?token=${java.net.URLEncoder.encode(phoneToken, "UTF-8")}"
                        android.util.Log.d("PhoneService", "Auto-dialing relay (token=${phoneToken.take(8)}…)")
                        connectToRelay(relayUrl)
                    }
                }

                // Single source of truth for the foreground notification —
                // see buildForegroundNotification(). It attaches the
                // state-aware Disconnect/Reconnect action and the brand color
                // so this initial build and every updateNotification() rebuild
                // stay identical apart from the body text.
                startForeground(
                    NOTIFICATION_ID,
                    buildForegroundNotification("Phone bridge is active")
                )

                // Disconnect-from-lobby (v25, 2026-05-26): keep the
                // foreground notification copy honest when the user is in
                // the stay-disconnected state. The default copy "Phone
                // bridge is active" is misleading in that case — we ARE
                // running, but on purpose NOT connected to anything.
                if (TokenStore.isUserStayedDisconnected(this)) {
                    updateNotification(getString(R.string.status_user_disconnected))
                }
            }
            ACTION_STOP -> {
                android.util.Log.d("PhoneService", "Stopping service...")
                stopSelf()
            }
        }
        
        // If the service is killed, restart it
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder {
        return binder
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ComputerCaller Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the phone bridge active"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * High-importance channel for the Accept/Decline prompt. Sound +
     * vibration on, badge on, lockscreen visibility public (the user has to
     * see it to act on it). Created once on service start; recreating an
     * existing channel is a no-op on Android.
     */
    private fun createConnectionRequestChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CONNECTION_REQUEST_CHANNEL_ID,
                "Connection requests",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Prompts you to approve incoming web app connections"
                enableVibration(true)
                enableLights(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * Raise the Accept/Decline notification for a pending connection.
     *
     * The action buttons fire broadcasts via PendingIntents — same pattern
     * Android uses for system-level "Reply / Mark as read" actions on
     * messaging notifications. Tap on the notification body itself routes
     * to MainActivity so the user can see the request in-app (helpful on
     * Android Auto / lockscreen where action buttons can be hidden).
     *
     * One notification per requestId so a second concurrent request never
     * dismisses the first one. The notificationIdFor() hash keeps ids
     * deterministic so dismissConnectionRequestNotification() can target
     * exactly the right one.
     */
    private fun postConnectionRequestNotification(requestId: String, address: String) {
        // POST_NOTIFICATIONS gate (Android 13+). If the user revoked
        // notification access after install we cannot raise the prompt
        // — in that case auto-decline the request so the webapp gets a
        // clear "phone rejected" signal instead of hanging on a silent
        // approval that will never come.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) {
                android.util.Log.w(
                    "PhoneService",
                    "POST_NOTIFICATIONS denied — cannot raise connection-request prompt, auto-declining"
                )
                // Defer so the caller's flow has finished setting up the
                // pending entry before we tear it down.
                pendingRequestHandler.post { handleConnectionDecision(requestId, accept = false) }
                return
            }
        }

        val acceptIntent = Intent(ConnectionRequestReceiver.ACTION_ACCEPT_CONNECTION).apply {
            setPackage(packageName)  // restrict broadcast to our own package
            putExtra(ConnectionRequestReceiver.EXTRA_REQUEST_ID, requestId)
        }
        val declineIntent = Intent(ConnectionRequestReceiver.ACTION_DECLINE_CONNECTION).apply {
            setPackage(packageName)
            putExtra(ConnectionRequestReceiver.EXTRA_REQUEST_ID, requestId)
        }

        // Distinct request codes per pending request so concurrent
        // PendingIntents don't get coalesced by the platform.
        val baseCode = requestId.hashCode()
        val acceptPending = PendingIntent.getBroadcast(
            this,
            baseCode,
            acceptIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val declinePending = PendingIntent.getBroadcast(
            this,
            baseCode + 1,
            declineIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Tap on body → open MainActivity. The activity doesn't (yet) have
        // a dedicated "incoming connection" screen — opening the app is
        // enough for the user to see the heads-up that's still sitting
        // in the shade.
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tapPending = PendingIntent.getActivity(
            this,
            baseCode + 2,
            tapIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Dispatch FORGE-1 (2026-05-26) — `address` is now the friendly
        // browser-identity built by buildBrowserIdentity (deviceLabel first,
        // ua+ip fallback). Notification body matches the in-foreground
        // dialog copy from R.string.pair_request_body_template: "X wants to
        // connect" — concise + same string in both surfaces so users
        // recognise the same wording in the shade and the dialog.
        val notification = NotificationCompat.Builder(this, CONNECTION_REQUEST_CHANNEL_ID)
            .setContentTitle("Connection request")
            .setContentText("$address wants to connect")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "$address is trying to connect to your phone. " +
                "Approve only if you started this connection."
            ))
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(false)  // don't dismiss on tap — user must Accept or Decline
            .setOngoing(false)
            .setContentIntent(tapPending)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Decline",
                declinePending
            )
            .addAction(
                android.R.drawable.ic_menu_send,
                "Accept",
                acceptPending
            )
            .build()

        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.notify(notificationIdFor(requestId), notification)
    }

    /**
     * Drop a posted connection-request notification (after Accept, Decline,
     * timeout, or pending-client disconnect-before-decision).
     */
    private fun dismissConnectionRequestNotification(requestId: String) {
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.cancel(notificationIdFor(requestId))
    }

    /**
     * Start the 30 s auto-decline timer for a pending request. The handler
     * is posted on the main looper — Handler.removeCallbacks tolerates
     * being called from any thread but binding the timer to a single
     * looper avoids surprises if a runtime config change reaches in.
     */
    private fun scheduleAutoDecline(requestId: String) {
        val runnable = Runnable {
            android.util.Log.w("PhoneService", "Pending connection $requestId timed out (auto-decline)")
            handleConnectionDecision(requestId, accept = false)
        }
        pendingRequestTimers[requestId] = runnable
        pendingRequestHandler.postDelayed(runnable, PENDING_REQUEST_TIMEOUT_MS)
    }

    /**
     * Apply the user's Accept / Decline decision (or the auto-decline
     * timeout) to the pending connection on the server.
     *
     * Always dismisses the notification + cancels the auto-decline timer
     * so a delayed broadcast can't double-fire after the decision has
     * already been applied. acceptPendingConnection / declinePendingConnection
     * are themselves idempotent (no-op on unknown requestId) so a race
     * between Accept-tap and auto-decline-tick simply produces one
     * winning outcome.
     */
    /**
     * v18 / Connect+Accept pivot — user has tapped Accept or Decline
     * for an inbound pairing request, either via the heads-up
     * notification action buttons (routed through
     * [ConnectionRequestReceiver]) or via the in-foreground
     * AlertDialog (which dispatches the same broadcast action so both
     * paths converge here).
     *
     * Dismisses the notification + auto-decline timer first so a
     * delayed broadcast can't double-fire after the decision was
     * already applied, then sends the appropriate frame through the
     * relay client:
     *   - Accept  → `ACCEPT_PAIRING:{pairingId}`
     *   - Decline → `DECLINE_PAIRING:{pairingId}`
     *
     * If the relay client is no longer open we log a warning and bail —
     * the decision is effectively a no-op (the relay timed out the
     * pairing on its side and the request is moot).
     */
    private fun handleConnectionDecision(pairingId: String, accept: Boolean) {
        android.util.Log.d("PhoneService", "handleConnectionDecision: $pairingId accept=$accept")
        pendingRequestTimers.remove(pairingId)?.let {
            pendingRequestHandler.removeCallbacks(it)
        }
        dismissConnectionRequestNotification(pairingId)

        val type = if (accept) "ACCEPT_PAIRING" else "DECLINE_PAIRING"
        if (client?.isOpen != true) {
            android.util.Log.w(
                "PhoneService",
                "Cannot send $type — relay client not open. pairingId=$pairingId"
            )
            return
        }
        try {
            client?.sendResponse(type, mapOf("pairingId" to pairingId))
            android.util.Log.d("PhoneService", "$type sent for pairingId=$pairingId")
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Failed to send $type: ${e.message}", e)
        }
    }

    /**
     * Compose a short browser-identity string for the heads-up
     * notification body and AlertDialog message.
     *
     * Priority order:
     *   1. `deviceLabel` — friendly browser-supplied label, e.g. "Chrome on
     *      macOS" or a user-renamed "Dennis's office laptop". Added in
     *      dispatch FORGE-1 (2026-05-26). Defensively truncated to 60 chars
     *      and stripped of control chars in case the relay-side sanitizer
     *      was bypassed somehow.
     *   2. `ua + ip` — legacy path for browsers that don't ship deviceLabel
     *      (backward compat). Either piece may be blank — we silently drop
     *      blanks rather than render leading / trailing punctuation.
     *   3. If everything is blank we fall back to a localized
     *      "A browser wants to connect" string.
     */
    private fun buildBrowserIdentity(ua: String, ip: String, deviceLabel: String? = null): String {
        if (!deviceLabel.isNullOrBlank()) {
            // Belt-and-braces — relay should already have sanitized, but a
            // malformed v22 + v23 mix or a future protocol shift could let
            // a raw value through. Strip control chars + cap to 60.
            val safe = deviceLabel.take(60).filter { !it.isISOControl() }.trim()
            if (safe.isNotEmpty()) return safe
        }
        val pieces = listOf(ua, ip).filter { it.isNotBlank() }
        return if (pieces.isEmpty()) {
            getString(R.string.pair_request_body_unknown)
        } else {
            pieces.joinToString(" · ")
        }
    }

    /**
     * Cancel a single pending pairing: stop its auto-decline timer and
     * dismiss its notification. Safe to call for an unknown id (no-op).
     * Used by both PAIRING_CANCELLED handling and the foreground
     * dialog dismiss path.
     */
    private fun cancelPendingPairing(pairingId: String) {
        pendingRequestTimers.remove(pairingId)?.let {
            pendingRequestHandler.removeCallbacks(it)
        }
        dismissConnectionRequestNotification(pairingId)
    }

    /**
     * Cancel every in-flight pending pairing — called when the relay
     * socket dies, when the user signs out, and on service teardown.
     * Prevents a stale Accept-on-notification from sending a frame
     * into a dead socket (which would be silently dropped anyway, but
     * dismissing the notif keeps the UI honest).
     */
    private fun clearAllPendingPairings(reason: String) {
        if (pendingRequestTimers.isEmpty()) return
        android.util.Log.d(
            "PhoneService",
            "Clearing ${pendingRequestTimers.size} pending pairings (reason=$reason)"
        )
        val ids = pendingRequestTimers.keys.toList()
        for (id in ids) {
            cancelPendingPairing(id)
        }
        pendingRequestTimers.clear()
    }

    /**
     * Single source of truth for the persistent foreground-service
     * notification. Both the initial startForeground() in onStartCommand and
     * every updateNotification() rebuild go through here so the notification
     * always carries (a) the brand color, and (b) the correct STATE-AWARE
     * lobby action button.
     *
     * The action toggles off [TokenStore.isUserStayedDisconnected]:
     *   - in lobby (false)         → "Disconnect" → ACTION_DISCONNECT_LOBBY (req 2001)
     *   - stayed-disconnected (true) → "Reconnect"  → ACTION_REJOIN_LOBBY    (req 2002)
     *
     * Both fire PendingIntent.getBroadcast(...) to [LobbyActionReceiver],
     * FLAG_IMMUTABLE + setPackage(packageName) so the intent can't be mutated
     * or redirected. Request codes 2001/2002 are fixed + distinct from the
     * connection-request accept/decline codes (requestId.hashCode-based) and
     * the body contentIntent (code 0). One tap = instant, no confirmation
     * dialog — mirrors the in-app lobbyToggleButton.
     */
    private fun buildForegroundNotification(text: String): Notification {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ComputerCaller")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            // Round 7 — tint the notification chrome with the brand accent so
            // the OS row reads as part of the app. (Folded into updateNotification
            // too as of v27 — the old updateNotification dropped this.)
            .setColor(ContextCompat.getColor(this, R.color.accent_blue))
            .setColorized(false)
            .setContentIntent(pendingIntent)
            .setOngoing(true)

        // State-aware lobby action. When the user has chosen to stay
        // disconnected, the only useful action is Reconnect; otherwise the
        // only useful action is Disconnect.
        if (TokenStore.isUserStayedDisconnected(this)) {
            val rejoinIntent = Intent(LobbyActionReceiver.ACTION_REJOIN_LOBBY).apply {
                setPackage(packageName)
            }
            val rejoinPending = PendingIntent.getBroadcast(
                this,
                2002,
                rejoinIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            builder.addAction(
                android.R.drawable.ic_menu_rotate,
                getString(R.string.notif_action_reconnect),
                rejoinPending
            )
        } else {
            val disconnectIntent = Intent(LobbyActionReceiver.ACTION_DISCONNECT_LOBBY).apply {
                setPackage(packageName)
            }
            val disconnectPending = PendingIntent.getBroadcast(
                this,
                2001,
                disconnectIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.notif_action_disconnect),
                disconnectPending
            )
        }

        return builder.build()
    }

    /**
     * Replaces the persistent foreground notification's text so the user can see
     * connection state at a glance ("Connected to PC — syncing data" vs the
     * default "Phone bridge is active"). No accept/deny prompt — just visibility.
     * Routes through [buildForegroundNotification] so the state-aware lobby
     * action button is re-attached on every connect/disconnect state change.
     */
    private fun updateNotification(text: String) {
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.notify(NOTIFICATION_ID, buildForegroundNotification(text))
    }

    /**
     * Dispatch #29 — Phase 4 finish. Replaces the old `startServer()` that
     * spun up the LAN PhoneServer on port 8765. The PhoneServer is gone
     * (the phone now ONLY talks outbound to the SaaS relay) but the
     * side-effect wiring it used to set up — telephony callback, SmsReceiver
     * callback, content observers, NotificationListenerService bridge —
     * is still needed for the relay-side flow.
     *
     * Idempotent on re-entry: telephony callback registration guards on
     * telCallbackRef; static-callback assignments are simple field writes;
     * startContentObservers() handles its own double-call check.
     */
    private fun installSideEffects() {
        // Register the modern TelephonyCallback on Android 12+ (S / API 31).
        // Done here in addition to the legacy PhoneStateListener registered in
        // onCreate — both co-exist; whichever observes IDLE first sends
        // CALL_ENDED and the other no-ops via callEndedSentRef.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S && telCallbackRef == null) {
            registerTelephonyCallback()
        }

        try {
            android.util.Log.d("PhoneService", "Installing side-effect wiring (no LAN server)")

            // Set up SMS receiver callback — send via the relay client.
            // simId may be null on single-SIM phones / older Android; only put
            // the field on the wire when it's actually known so clients without
            // dual-SIM context don't see a noisy null.
            SmsReceiver.onSmsReceived = { from, body, time, simId ->
                val data: Map<String, Any> = if (simId != null) {
                    mapOf(
                        "from" to from,
                        "body" to body,
                        "time" to time,
                        "simId" to simId
                    )
                } else {
                    mapOf("from" to from, "body" to body, "time" to time)
                }
                if (client?.isOpen == true) {
                    client?.sendResponse("SMS_RECEIVED", data)
                }
            }

            // Wire up ContentObservers so SMS / calls that happen OUTSIDE this app
            // (default messaging app, native dialer, etc.) still flow to the web
            // client in real time. Without this, only the SmsReceiver broadcast
            // and in-app calls trigger pushes.
            startContentObservers()

            // Wire NotificationListenerService callback. We forward EVERY
            // notification (Phone-Link-style universal mirror) as PHONE_NOTIFICATION,
            // and additionally synthesize SMS_RECEIVED for Google Messages "You: ..."
            // notifications so RCS-sent messages from this device land in the
            // unified timeline (the SMS/MMS content provider never sees them
            // unless we're the default messaging app). User must enable
            // "Notification access" once.
            DnkNotificationListenerService.onMessageNotification = { appName, pkg, title, body, hasReply, replyKey, notificationKey, timestamp, icon ->
                val isViaClient = client?.isOpen == true
                val data = mutableMapOf<String, Any>(
                    "id" to notificationKey,
                    "appName" to appName,
                    "packageName" to pkg,
                    "title" to title,
                    "body" to body,
                    "hasReply" to hasReply,
                    "replyKey" to replyKey,
                    "notificationKey" to notificationKey,
                    "timestamp" to timestamp
                )
                if (icon != null) data["icon"] = icon  // only include if available
                sendResponse("PHONE_NOTIFICATION", data, isViaClient)

                // RCS sent message detection: Google Messages sometimes shows "You: [text]"
                // in notification body when a thread updates after we sent a message.
                if (pkg == "com.google.android.apps.messaging" && body.startsWith("You: ")) {
                    val sentText = body.removePrefix("You: ").trim()
                    if (sentText.isNotBlank()) {
                        // Extract recipient from title (conversation name)
                        val sentData = mapOf(
                            "id" to "rcs_sent_${timestamp}",
                            "from" to title,  // conversation partner name/number
                            "body" to sentText,
                            "time" to timestamp,
                            "type" to "sent",
                            "source" to "rcs_notification"
                        )
                        sendResponse("SMS_RECEIVED", sentData, isViaClient)
                    }
                }
            }

            // Mirror notification dismissals to the web client. When the user
            // swipes a notification away on the phone (or the source app
            // cancels it), Android fires onNotificationRemoved → we ship a
            // NOTIFICATION_REMOVED frame keyed by sbn.key so the webapp's
            // notification strip drops the matching row. Matches the
            // notificationKey shipped on PHONE_NOTIFICATION above.
            DnkNotificationListenerService.onNotificationRemovedCb = { notificationKey ->
                val isViaClient = client?.isOpen == true
                sendResponse(
                    "NOTIFICATION_REMOVED",
                    mapOf("notificationKey" to notificationKey),
                    isViaClient
                )
            }
        } catch (e: Exception) {
            e.printStackTrace()
            android.util.Log.e("PhoneService", "Failed to install side-effects: ${e.message}", e)
        }
    }

    /**
     * Reads Settings.Secure to determine whether the user has enabled our
     * NotificationListenerService. The system grants the binding permission
     * implicitly once the user toggles us on in "Notification access", but
     * there is no programmatic API to detect that — we have to read the
     * comma-separated `enabled_notification_listeners` value and look for
     * our package.
     */
    private fun isNotificationListenerEnabled(): Boolean {
        val enabledListeners = android.provider.Settings.Secure.getString(
            contentResolver,
            "enabled_notification_listeners"
        ) ?: return false
        return enabledListeners.contains(packageName)
    }

    /**
     * Resolves a notification "title" (which may be a display name or a phone
     * number) to a phone number from the contacts provider. If the input
     * already looks like a number we return it unchanged. Returns null when
     * the contact lookup fails or is not granted — caller falls back to the
     * raw input.
     */
    private fun resolveContactNumber(nameOrNumber: String): String? {
        // If already looks like a phone number, return as-is.
        if (nameOrNumber.replace(Regex("[^0-9+]"), "").length >= 4) return nameOrNumber

        return try {
            val cursor = contentResolver.query(
                android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER,
                    android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME
                ),
                "${android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} = ?",
                arrayOf(nameOrNumber),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun startContentObservers() {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())

        // SMS observer — fires when any SMS row is added/modified.
        smsObserver = object : android.database.ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                onChange(selfChange, null)
            }
            override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
                android.util.Log.d("PhoneService", "SMS database changed")
                pushNewMessages()
            }
        }

        // Call log observer — fires when call log changes.
        callLogObserver = object : android.database.ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                onChange(selfChange, null)
            }
            override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
                android.util.Log.d("PhoneService", "Call log database changed")
                pushNewCallLogEntries()
            }
        }

        // MMS observer — fires when MMS rows change. Picture/group messages
        // never hit the SmsReceiver broadcast, so without this observer they
        // would only appear after a full GET_MESSAGES sync.
        mmsObserver = object : android.database.ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                onChange(selfChange, null)
            }
            override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
                android.util.Log.d("PhoneService", "MMS database changed")
                pushNewMmsEntries()
            }
        }

        try {
            contentResolver.registerContentObserver(
                android.net.Uri.parse("content://sms"),
                true, smsObserver!!
            )
            contentResolver.registerContentObserver(
                android.provider.CallLog.Calls.CONTENT_URI,
                true, callLogObserver!!
            )
            contentResolver.registerContentObserver(
                android.provider.Telephony.Mms.CONTENT_URI,
                true, mmsObserver!!
            )
            android.util.Log.d("PhoneService", "ContentObservers registered")
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Failed to register ContentObservers: ${e.message}", e)
        }
    }

    private fun stopContentObservers() {
        try {
            smsObserver?.let { contentResolver.unregisterContentObserver(it) }
            callLogObserver?.let { contentResolver.unregisterContentObserver(it) }
            mmsObserver?.let { contentResolver.unregisterContentObserver(it) }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "Error unregistering ContentObservers: ${e.message}")
        }
        smsObserver = null
        callLogObserver = null
        mmsObserver = null
    }

    /**
     * Pulls SMS rows newer than `lastSmsTimestamp`, pushes each as a SMS_RECEIVED
     * frame, then advances the watermark. Skips drafts/outbox/failed rows
     * (only inbox + sent are forwarded). Guarded against READ_SMS denial.
     */
    private fun pushNewMessages() {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.w("PhoneService", "pushNewMessages skipped — READ_SMS denied")
            return
        }
        val isViaClient = client?.isOpen == true
        try {
            val cursor = contentResolver.query(
                android.net.Uri.parse("content://sms"),
                arrayOf(
                    android.provider.Telephony.Sms._ID,
                    android.provider.Telephony.Sms.ADDRESS,
                    android.provider.Telephony.Sms.BODY,
                    android.provider.Telephony.Sms.DATE,
                    android.provider.Telephony.Sms.TYPE,
                    "sub_id"
                ),
                "${android.provider.Telephony.Sms.DATE} > ?",
                arrayOf(lastSmsTimestamp.toString()),
                "${android.provider.Telephony.Sms.DATE} ASC"
            )
            cursor?.use {
                val subIdCol = it.getColumnIndex("sub_id")
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: continue
                    val address = it.getString(1) ?: ""
                    val body = it.getString(2) ?: ""
                    val date = it.getLong(3)
                    val typeInt = it.getInt(4)
                    val rawSubId = if (subIdCol >= 0) it.getInt(subIdCol) else -1
                    val type = when (typeInt) {
                        android.provider.Telephony.Sms.MESSAGE_TYPE_INBOX -> "inbox"
                        android.provider.Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
                        else -> continue
                    }
                    // Build payload — only include simId when the provider gave us
                    // a real value. Map<String, Any> doesn't accept nulls, so we
                    // construct it conditionally.
                    val msgData = if (rawSubId >= 0) {
                        mapOf(
                            "id" to id,
                            "from" to address,
                            "body" to body,
                            "time" to date,
                            "type" to type,
                            "simId" to rawSubId
                        )
                    } else {
                        mapOf(
                            "id" to id,
                            "from" to address,
                            "body" to body,
                            "time" to date,
                            "type" to type
                        )
                    }
                    sendResponse("SMS_RECEIVED", msgData, isViaClient)
                    if (date > lastSmsTimestamp) lastSmsTimestamp = date
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error pushing new messages: ${e.message}")
        }
    }

    /**
     * Pulls call log rows newer than `lastCallLogTimestamp`, pushes each as a
     * CALL_LOG_ENTRY frame, advances the watermark. Guarded against READ_CALL_LOG
     * denial.
     */
    private fun pushNewCallLogEntries() {
        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.w("PhoneService", "pushNewCallLogEntries skipped — READ_CALL_LOG denied")
            return
        }
        val isViaClient = client?.isOpen == true
        try {
            val cursor = contentResolver.query(
                android.provider.CallLog.Calls.CONTENT_URI,
                arrayOf(
                    android.provider.CallLog.Calls._ID,
                    android.provider.CallLog.Calls.NUMBER,
                    android.provider.CallLog.Calls.CACHED_NAME,
                    android.provider.CallLog.Calls.DATE,
                    android.provider.CallLog.Calls.DURATION,
                    android.provider.CallLog.Calls.TYPE,
                    android.provider.CallLog.Calls.PHONE_ACCOUNT_ID
                ),
                "${android.provider.CallLog.Calls.DATE} > ?",
                arrayOf(lastCallLogTimestamp.toString()),
                "${android.provider.CallLog.Calls.DATE} ASC"
            )
            cursor?.use {
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: continue
                    val number = it.getString(1) ?: "Unknown"
                    val name = it.getString(2)
                    val date = it.getLong(3)
                    val duration = it.getInt(4)
                    val callType = it.getInt(5)
                    val accountId = it.getString(6)?.takeIf { s -> s.isNotBlank() }
                    val typeString = when (callType) {
                        android.provider.CallLog.Calls.INCOMING_TYPE -> "incoming"
                        android.provider.CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        android.provider.CallLog.Calls.MISSED_TYPE -> "missed"
                        android.provider.CallLog.Calls.REJECTED_TYPE -> "rejected"
                        else -> "unknown"
                    }
                    // Map<String, Any> can't hold null, so include simId only when set.
                    val entryData = if (accountId != null) {
                        mapOf(
                            "id" to id,
                            "number" to number,
                            "name" to (name ?: ""),
                            "date" to date,
                            "duration" to duration,
                            "type" to typeString,
                            "simId" to accountId
                        )
                    } else {
                        mapOf(
                            "id" to id,
                            "number" to number,
                            "name" to (name ?: ""),
                            "date" to date,
                            "duration" to duration,
                            "type" to typeString
                        )
                    }
                    sendResponse("CALL_LOG_ENTRY", entryData, isViaClient)
                    if (date > lastCallLogTimestamp) lastCallLogTimestamp = date
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error pushing new call log entries: ${e.message}")
        }
    }

    /**
     * Pulls MMS rows newer than `lastMmsTimestamp` via MmsHandler (which already
     * resolves address + parts), pushes each as an SMS_RECEIVED frame so the web
     * client doesn't need a separate code path, then advances the watermark.
     * MmsHandler internally handles the seconds-vs-ms unit conversion.
     */
    private fun pushNewMmsEntries() {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.w("PhoneService", "pushNewMmsEntries skipped — READ_SMS denied")
            return
        }
        val isViaClient = client?.isOpen == true
        try {
            val mmsHandler = MmsHandler(this)
            val newMms = mmsHandler.getMessages(limit = 50, since = lastMmsTimestamp)
            for (mms in newMms) {
                val data = mapOf(
                    "id" to mms.id,
                    "from" to mms.address,
                    "body" to mms.body,
                    "time" to mms.date,
                    "type" to mms.type
                )
                sendResponse("SMS_RECEIVED", data, isViaClient)
                if (mms.date > lastMmsTimestamp) lastMmsTimestamp = mms.date
            }
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error pushing new MMS: ${e.message}")
        }
    }

    fun connectToRelay(relayUrl: String) {
        android.util.Log.d("PhoneService", "Connecting to relay: $relayUrl")
        clientRelayUrl = relayUrl
        lastRelayUrlAttempt = relayUrl

        // We're about to dial — clear the last failure and announce
        // CONNECTING. MainActivity uses this to flip its status dot to
        // the slate-blue "Connecting…" state.
        lastConnectionError = null
        setRelayPhase(RelayPhase.CONNECTING)

        // Cancel any stale watchdog from a previous attempt — a fresh
        // connect always gets a fresh timer. Without this, a rapid
        // retry could leave two timers in flight, the older one firing
        // mid-handshake on the new attempt.
        cancelConnectTimeout()

        // Cancel any pending auto-reconnect — we're about to dial right
        // now, so the 5s timer would just race against us.
        cancelLobbyReconnect()

        client?.close()
        client = PhoneClient(
            java.net.URI(relayUrl),
            { command, payload -> handleCommand(command, payload, true) },
            { connected ->
                isClientConnected = connected
                lastClientAddress = if (connected) "relay" else null
                android.util.Log.d("PhoneService", if (connected) "Connected to relay!" else "Disconnected from relay")
                updateNotification(if (connected) "Connected to PC via relay" else "Phone bridge is active")
                // onOpen → OPEN. onClose → only flip to IDLE if we
                // weren't already pushed to FAILED by the error callback
                // (close fires AFTER error for non-normal closures).
                if (connected) {
                    // Handshake succeeded — the watchdog must NOT fire.
                    // (No backoff counter to reset in v18 — fixed 5s
                    // delay is stateless.)
                    cancelConnectTimeout()
                    setRelayPhase(RelayPhase.OPEN)
                } else {
                    if (relayPhase != RelayPhase.FAILED) {
                        setRelayPhase(RelayPhase.IDLE)
                    }
                    // v18 — drop any pending pair-request state on WS
                    // close. The relay no longer cares about Accept/Decline
                    // sent after the socket dies, and leaving a stale
                    // notification visible would mis-lead the user.
                    clearAllPendingPairings("relay socket closed")
                    // Clear the pair-active flag — the relay is the
                    // authority on active-pair membership, so any socket
                    // teardown drops us back to lobby semantics. Without
                    // this, the in-activity status line would keep
                    // claiming "Connected" while the WS was dead.
                    isPairActive = false
                    // Foreground notification back to "Waiting" — the
                    // user is no longer connected to a browser.
                    updateNotification(getString(R.string.status_waiting_for_web))
                    // Unexpected disconnect (the user didn't tap Sign Out
                    // or anything that would have called disconnectRelay()
                    // — that path clears clientRelayUrl). Schedule the
                    // simple 5s re-dial if we still know the lobby URL.
                    if (clientRelayUrl != null) {
                        scheduleLobbyReconnect("relay socket closed")
                    }
                }
            },
            { code, reason ->
                // Non-1000 close OR raw exception from PhoneClient.
                // Capture the diagnostic pair and flip to FAILED so the
                // UI can render an actionable error message.
                cancelConnectTimeout()
                lastConnectionError = code to reason
                android.util.Log.w("PhoneService", "Relay connection error: code=$code reason=$reason")
                setRelayPhase(RelayPhase.FAILED)
                // 4401 = relay's "invalid token" close. No amount of
                // retrying will fix that — the user needs to sign in
                // again. Bail without scheduling.
                if (code == 4401) {
                    android.util.Log.w("PhoneService", "Relay rejected token (4401) — not auto-reconnecting")
                    cancelLobbyReconnect()
                    return@PhoneClient
                }
                if (clientRelayUrl != null) {
                    scheduleLobbyReconnect("relay error code=$code")
                }
            }
        )
        client?.connectionLostTimeout = 15  // ping every 15 seconds
        client?.connect()

        // Schedule the watchdog AFTER kicking off connect(). Capture
        // the client + URL we just dialed so a stale timer from a
        // previous attempt can't force-close a freshly-opened socket
        // (defensive — cancelConnectTimeout() above should have
        // prevented that, but identity-checking the captured ref makes
        // the race impossible by construction).
        val dialedClient = client
        val timeoutRunnable = Runnable {
            // If the client we dialed is no longer the active one, or
            // it's already open, the watchdog has nothing to do.
            if (dialedClient == null || dialedClient !== client) {
                android.util.Log.d("PhoneService", "Connect watchdog: stale, ignoring")
                return@Runnable
            }
            if (dialedClient.isOpen) {
                android.util.Log.d("PhoneService", "Connect watchdog: already open, ignoring")
                return@Runnable
            }
            android.util.Log.w("PhoneService", "Connect watchdog fired — handshake never completed within ${connectTimeoutMs}ms")
            // Force-close the hung socket. Code 1006 (abnormal closure)
            // is the closest match for "connection never established";
            // reason "connect_timeout" surfaces in PhoneClient.onClose
            // logs to make the diagnostic obvious.
            try { dialedClient.close(1006, "connect_timeout") } catch (_: Exception) {}
            // Surface FAILED with the friendly client-side message.
            // mapConnectionError in MainActivity matches on either
            // "SocketTimeoutException" or "timed out" — we use the
            // latter so the existing copy path picks it up if the
            // user hasn't updated the activity, plus we set a
            // dedicated string for the brief's requested wording.
            lastConnectionError = -1 to "connect_timeout: timed out after ${connectTimeoutMs / 1000}s"
            setRelayPhase(RelayPhase.FAILED)
            connectTimeoutRunnable = null
        }
        connectTimeoutRunnable = timeoutRunnable
        connectTimeoutHandler.postDelayed(timeoutRunnable, connectTimeoutMs)
    }

    /**
     * Round 5 — cancel any scheduled connect-timeout watchdog.
     *
     * Safe to call in any state (no-op if nothing is pending). Called
     * from: onOpen success, onError/onClose error, disconnectRelay()
     * (user-initiated cancel), and onDestroy. Idempotent.
     */
    private fun cancelConnectTimeout() {
        connectTimeoutRunnable?.let {
            connectTimeoutHandler.removeCallbacks(it)
            android.util.Log.d("PhoneService", "Connect watchdog cancelled")
        }
        connectTimeoutRunnable = null
    }

    /**
     * v18 — simple lobby-only auto-reconnect.
     *
     * Replaces dispatch #29's exponential backoff. Schedules a single
     * re-dial after [lobbyReconnectDelayMs] (5s). Cancels any
     * previously-pending redial first so we never end up with two
     * stacked timers competing.
     *
     * The redial re-opens the LOBBY WebSocket only — it does NOT
     * re-enter any active pairing room. Active-room membership is
     * granted exclusively by an explicit `PAIRING_ACTIVE` from the
     * relay, which follows a fresh user Accept on this device. A
     * dropped active pair stays dropped until the browser requests
     * pairing again and the user accepts.
     *
     * The redial only fires if [clientRelayUrl] is still non-null at
     * the moment it pops — a Sign Out / disconnect that lands between
     * scheduling and firing nulls out the URL and the task no-ops.
     */
    private fun scheduleLobbyReconnect(reason: String) {
        cancelLobbyReconnect()
        // Disconnect-from-lobby gate (v25, 2026-05-26). If the user has
        // chosen to stay disconnected, do NOT schedule a redial after an
        // unintentional drop — that's the whole point of the flag. The
        // userDisconnectFromLobby() entry point already calls
        // cancelLobbyReconnect() and nulls clientRelayUrl, but this is a
        // defensive belt-and-braces check in case a stray call path
        // schedules a reconnect between the flag flip and the URL null-out.
        if (TokenStore.isUserStayedDisconnected(this)) {
            android.util.Log.d(
                "PhoneService",
                "Skip lobby reconnect — user stayed-disconnected flag set (reason=$reason)"
            )
            return
        }
        android.util.Log.d(
            "PhoneService",
            "Lobby auto-reconnect scheduled in ${lobbyReconnectDelayMs}ms (reason=$reason)"
        )
        val task = Runnable {
            reconnectRunnable = null
            val url = clientRelayUrl
            if (url.isNullOrBlank()) {
                android.util.Log.d("PhoneService", "Lobby reconnect: clientRelayUrl is null — bailing")
                return@Runnable
            }
            if (client?.isOpen == true) {
                android.util.Log.d("PhoneService", "Lobby reconnect: socket already open — skipping")
                return@Runnable
            }
            android.util.Log.d("PhoneService", "Lobby reconnect firing")
            connectToRelay(url)
        }
        reconnectRunnable = task
        reconnectHandler.postDelayed(task, lobbyReconnectDelayMs)
    }

    /**
     * Cancel any pending lobby auto-reconnect. Safe to call repeatedly.
     */
    private fun cancelLobbyReconnect() {
        reconnectRunnable?.let {
            reconnectHandler.removeCallbacks(it)
            android.util.Log.d("PhoneService", "Lobby auto-reconnect cancelled")
        }
        reconnectRunnable = null
    }

    /**
     * Internal phase setter — single point of truth for transitioning
     * [relayPhase] + firing [onRelayPhaseChanged]. Compares before
     * setting so identical-state callbacks don't spam the UI (e.g. a
     * stale OPEN→OPEN from an unrelated code path would be a no-op).
     */
    private fun setRelayPhase(next: RelayPhase) {
        if (relayPhase == next) return
        relayPhase = next
        try {
            onRelayPhaseChanged?.invoke(next)
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "onRelayPhaseChanged threw: ${e.message}")
        }
    }

    /**
     * User-initiated relay disconnect.
     *
     * Closes the WebSocket with a clean 1000 close code and forces the
     * phase to IDLE. Used by the Cancel button while CONNECTING and the
     * Reset path after a FAILED state — both want the connection torn
     * down without ringing the FAILED-state machinery.
     *
     * Differs from [reconnectToRelay] / the legacy Disconnect button in
     * MainActivity, which tear down the whole foreground service. This
     * method ONLY closes the relay socket — the LAN [PhoneServer] keeps
     * running so the user can still pair via QR / LAN IP afterwards.
     */
    fun disconnectRelay() {
        android.util.Log.d("PhoneService", "User-initiated relay disconnect")
        cancelConnectTimeout()
        // v18 — cancel any pending lobby reconnect too. Without this,
        // a user Sign Out → next 5s redial would wake up after the user
        // is gone and try to log them back in.
        cancelLobbyReconnect()
        // Drop any pending pair requests — same reasoning, the user
        // chose to leave so an Accept tap on a stale notification
        // should not silently put them back in a pair.
        clearAllPendingPairings("user disconnect")
        // Clear error BEFORE close() so the onClose callback below,
        // which may fire synchronously on some socket states, doesn't
        // re-arm FAILED on the way out.
        lastConnectionError = null
        client?.close(1000, "user_disconnect")
        client = null
        // Nulling clientRelayUrl BEFORE the onClose callback fires also
        // gates the auto-reconnect — the scheduleReconnect call sites
        // null-check clientRelayUrl, so this cleanly stops the loop.
        clientRelayUrl = null
        isClientConnected = false
        // User-initiated teardown drops the pair-active claim too. The
        // onClose callback above will also do this (via the connected=false
        // branch), but we set it here too so the status flips immediately
        // for any caller that reads the flag before onClose fires.
        isPairActive = false
        setRelayPhase(RelayPhase.IDLE)
    }

    fun reconnectToRelay() {
        // Disconnect-from-lobby gate (v25, 2026-05-26). Currently no
        // user-facing surface calls this method (the v18+ disconnect/reset
        // flow uses userDisconnectFromLobby / userRejoinLobby instead),
        // but a future caller would silently re-dial without this check
        // and undo the user's stay-disconnected intent.
        if (TokenStore.isUserStayedDisconnected(this)) {
            android.util.Log.d("PhoneService", "reconnectToRelay ignored — user stayed-disconnected flag set")
            return
        }
        android.util.Log.d("PhoneService", "Manual reconnect requested")
        val savedUrl = clientRelayUrl
        if (savedUrl != null) {
            android.util.Log.d("PhoneService", "Reconnecting to: $savedUrl")
            client?.close()
            client = null
            connectToRelay(savedUrl)
        } else {
            android.util.Log.w("PhoneService", "No saved relay URL to reconnect to")
        }
    }

    /**
     * Dispatch #34 (v20, 2026-05-25) — phone-initiated active-pair
     * teardown. Sibling to [disconnectRelay] but narrower in scope:
     * ends only the CURRENT pair claim, NOT the relay socket itself.
     *
     * After this call:
     *   - The relay client stays connected → phone remains in the lobby
     *     and is immediately re-pairable by the browser.
     *   - The user stays signed in on the phone (no TokenStore wipe).
     *   - The browser receives PAIRING_TERMINATED:{reason:"user_left"}
     *     and flips its UI back to the "Phone in lobby" affordance.
     *   - Our local [isPairActive] flag is left for the relay's reply
     *     (PAIRING_TERMINATED handler at line ~1935) to flip — that's
     *     the authoritative source. MainActivity optimistically hides
     *     the Disconnect button without waiting; the polling status
     *     loop then reconciles when the relay frame arrives.
     *
     * Wire frame: `LEAVE_ACTIVE:{}` — chosen to mirror the browser-side
     * Disconnect button which sends the same frame to terminate from
     * its end.
     *
     * Forward-compat note: as of this dispatch, server.js only accepts
     * `LEAVE_ACTIVE` from the active BROWSER socket (server.js:606-613,
     * `if (ws === room.active.browser)` — non-browser LEAVE_ACTIVE is
     * logged and dropped). A matching server.js change is required for
     * the phone-side teardown to actually terminate the pair on the
     * relay. Until that lands, this send is forward-compatible no-op:
     * the relay sees the frame and ignores it (it falls through to the
     * data-plane forward path which broadcasts it to the active browser,
     * which has no inbound LEAVE_ACTIVE handler either). Surfaced as a
     * follow-up in the dispatch return.
     */
    /**
     * Disconnect-from-lobby (v25, 2026-05-26) — user-initiated lobby exit
     * with persistence.
     *
     * Differs from [disconnectRelay] (Sign Out's relay-teardown step) in that
     * the user STAYS SIGNED IN — the phoneToken in TokenStore is untouched.
     * We just:
     *   1. Set [TokenStore.setUserStayedDisconnected] = true so any future
     *      auto-dial path (cold launch, OS START_STICKY restart,
     *      scheduleLobbyReconnect, reconnectToRelay) bails out without
     *      opening the relay socket.
     *   2. Cancel any pending lobby-reconnect timer.
     *   3. Drop any pending pair-request notifications (a stale Accept tap
     *      after disconnect should NOT silently put us back in a pair).
     *   4. Clear the last-error so the IDLE phase below doesn't paint a
     *      stale FAILED state.
     *   5. Close the WebSocket cleanly with code 1000 and a distinct reason
     *      string ("user_disconnect_from_lobby") so server logs can
     *      distinguish this from the Sign Out path's "user_disconnect".
     *   6. Null out the in-memory state so a stray onClose callback can't
     *      schedule a reconnect.
     *   7. Flip the foreground notification copy to the disconnected variant.
     *
     * The flag clears via [userRejoinLobby] (explicit tap) or implicitly
     * via [TokenStore.clear] on Sign Out (wipes everything for free).
     */
    fun userDisconnectFromLobby() {
        android.util.Log.d("PhoneService", "User-initiated lobby disconnect (stay signed in)")
        TokenStore.setUserStayedDisconnected(this, true)
        cancelConnectTimeout()
        cancelLobbyReconnect()
        clearAllPendingPairings("user disconnect from lobby")
        lastConnectionError = null
        client?.close(1000, "user_disconnect_from_lobby")
        client = null
        // Null BEFORE the onClose callback fires so the scheduleLobbyReconnect
        // call site (which null-checks clientRelayUrl) bails cleanly.
        clientRelayUrl = null
        isClientConnected = false
        isPairActive = false
        setRelayPhase(RelayPhase.IDLE)
        updateNotification(getString(R.string.status_user_disconnected))
    }

    /**
     * Disconnect-from-lobby (v25, 2026-05-26) — user-initiated rejoin.
     *
     * Clears the stay-disconnected flag and re-dials the relay using the
     * still-saved phoneToken. If the token is somehow gone (mid-flight Sign
     * Out / cleared from a different surface) we bail with a warn log
     * instead of crashing — caller can retry after sign-in.
     */
    fun userRejoinLobby() {
        android.util.Log.d("PhoneService", "User-initiated lobby rejoin")
        TokenStore.setUserStayedDisconnected(this, false)
        val phoneToken = TokenStore.getPhoneToken(this)
        if (phoneToken.isNullOrBlank()) {
            android.util.Log.w("PhoneService", "Rejoin requested but no phoneToken — cannot dial")
            return
        }
        val relayUrl = "wss://computercaller.com/relay/phone?token=${java.net.URLEncoder.encode(phoneToken, "UTF-8")}"
        connectToRelay(relayUrl)
    }

    fun leaveActivePair() {
        android.util.Log.d("PhoneService", "User-initiated leave of active pair (relay stays connected)")
        // Send LEAVE_ACTIVE over the relay client. Format matches the
        // browser-side outbound (see hooks/usePhoneBridge.ts leaveActive()).
        if (client?.isOpen == true) {
            try {
                client?.send("LEAVE_ACTIVE:{}")
                android.util.Log.d("PhoneService", "LEAVE_ACTIVE sent")
            } catch (e: Exception) {
                android.util.Log.e("PhoneService", "Failed to send LEAVE_ACTIVE: ${e.message}", e)
            }
        } else {
            android.util.Log.w("PhoneService", "leaveActivePair: relay client not open — nothing to send")
        }
        // Do NOT close the relay client. Do NOT null clientRelayUrl. Do
        // NOT touch the TokenStore. Phone stays in lobby, ready to
        // accept a new pairing. The PAIRING_TERMINATED reply (when the
        // relay supports phone-side LEAVE_ACTIVE) will flip
        // isPairActive=false via the existing handler at ~line 1935.
    }

    // Dispatch #29 — restartServer() removed. With no LAN PhoneServer
    // there's nothing to "refresh" on port 8765. The relay-side equivalent
    // is reconnectToRelay() above. If a caller still references this
    // method (none should — the MainActivity Disconnect-and-refresh button
    // is gone), they'll get a compile error and can switch to
    // reconnectToRelay().

    /**
     * Dispatch #29 — viaClient parameter is now effectively dead
     * (there's only one transport, the relay client) but kept in the
     * signature for back-compat with the dozens of existing callsites.
     * If viaClient is true OR if the relay client is open, we send via
     * the client. Otherwise the message is dropped (nowhere to send it).
     */
    private fun sendResponse(type: String, data: Any, viaClient: Boolean = false) {
        android.util.Log.d("PhoneService", "sendResponse: type=$type, viaClient=$viaClient, clientOpen=${client?.isOpen}")
        try {
            if (client?.isOpen == true) {
                client?.sendResponse(type, data)
                android.util.Log.d("PhoneService", "Response sent via relay client")
            } else {
                android.util.Log.w("PhoneService", "sendResponse: relay client not open — dropping $type")
            }
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error sending response $type: ${e.message}", e)
        }
    }

    /**
     * Sends a list as paginated chunks ("${type}_CHUNK") with a small delay between
     * pages. This avoids slamming the relay/web client with one massive frame for
     * hundreds of contacts / 500 messages / 200 call logs.
     *
     * Each chunk frame carries: page (1-based), total_pages, total_count, and the
     * page slice under `key` ("contacts" / "messages" / "callLogs"). The receiver
     * reassembles by appending chunks until page == total_pages.
     */
    private fun <T> sendChunked(
        type: String,
        items: List<T>,
        pageSize: Int,
        viaClient: Boolean,
        key: String
    ) {
        val totalPages = if (items.isEmpty()) 1 else (items.size + pageSize - 1) / pageSize
        val chunkType = "${type}_CHUNK"

        if (items.isEmpty()) {
            sendResponse(chunkType, mapOf(
                "page" to 1,
                "total_pages" to 1,
                "total_count" to 0,
                key to emptyList<Any>()
            ), viaClient)
            return
        }

        items.chunked(pageSize).forEachIndexed { index, chunk ->
            val page = index + 1
            val data = mapOf(
                "page" to page,
                "total_pages" to totalPages,
                "total_count" to items.size,
                key to chunk
            )
            if (index == 0) {
                sendResponse(chunkType, data, viaClient)
            } else {
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    sendResponse(chunkType, data, viaClient)
                }, (index * 40).toLong())
            }
        }
    }

    private fun handleCommand(command: String, payload: Map<String, Any>?, viaClient: Boolean = false) {
        android.util.Log.d("PhoneService", "handleCommand: $command, viaClient: $viaClient")
        try {
            when (command) {
                // v18 Connect+Accept pivot ----------------------------
                //
                // Wire protocol with the relay:
                //   relay → phone: PAIRING_REQUEST    {pairingId, ua, ip}
                //                  PAIRING_CANCELLED  {pairingId}
                //                  PAIRING_ACTIVE     {ua, ip}
                //                  PAIRING_TERMINATED {reason}
                //   phone → relay: ACCEPT_PAIRING     {pairingId}
                //                  DECLINE_PAIRING    {pairingId}
                //
                // The phone lands in LOBBY on relay open. A pair only
                // becomes active after the user explicitly accepts a
                // PAIRING_REQUEST — relay-side responds with PAIRING_ACTIVE,
                // and routes the browser's room frames through. Browser
                // disconnect or relay-driven teardown emits
                // PAIRING_TERMINATED; the phone STAYS connected to the
                // relay lobby (does NOT automatically re-pair).
                //
                // Note: dispatch #29's "DISCONNECT_PHONE" handler was
                // removed — its semantics (close the relay socket) are
                // now covered by PAIRING_TERMINATED (which keeps the
                // socket open and just updates UI).
                "PAIRING_REQUEST" -> {
                    val pairingId = payload?.get("pairingId") as? String
                    if (pairingId.isNullOrBlank()) {
                        android.util.Log.w("PhoneService", "PAIRING_REQUEST missing pairingId — ignoring")
                        return
                    }
                    val ua = (payload["ua"] as? String).orEmpty()
                    val ip = (payload["ip"] as? String).orEmpty()
                    // Dispatch FORGE-1 (2026-05-26) — friendly browser-identity
                    // label sent by the browser ("Chrome on macOS", "Edge on
                    // Windows 11", or a user-supplied rename). Nullable for
                    // backward compat with older browser builds that don't
                    // send the field; in that case identity falls back to
                    // ua+ip via buildBrowserIdentity.
                    val deviceLabel = (payload["deviceLabel"] as? String)?.takeIf { it.isNotBlank() }
                    val identity = buildBrowserIdentity(ua, ip, deviceLabel)
                    android.util.Log.d("PhoneService", "PAIRING_REQUEST id=$pairingId identity=$identity label=$deviceLabel")
                    // Post heads-up notification with Accept/Decline
                    // action buttons. Reuses the same channel + receiver
                    // wiring that was built for the old LAN PhoneServer
                    // accept flow (dispatch #5/#6 lineage).
                    postConnectionRequestNotification(pairingId, identity)
                    scheduleAutoDecline(pairingId)
                    // Broadcast to MainActivity so an in-foreground
                    // user gets the AlertDialog as well as the notif.
                    // Restricted to our package — RECEIVER_NOT_EXPORTED
                    // is set on the registration side.
                    val foregroundIntent = Intent(ACTION_PAIRING_REQUEST_IN_FOREGROUND).apply {
                        setPackage(packageName)
                        putExtra(EXTRA_PAIRING_ID, pairingId)
                        putExtra(EXTRA_PAIRING_IDENTITY, identity)
                    }
                    sendBroadcast(foregroundIntent)
                }
                "PAIRING_CANCELLED" -> {
                    val pairingId = payload?.get("pairingId") as? String
                    if (pairingId.isNullOrBlank()) {
                        android.util.Log.w("PhoneService", "PAIRING_CANCELLED missing pairingId — ignoring")
                        return
                    }
                    android.util.Log.d("PhoneService", "PAIRING_CANCELLED id=$pairingId")
                    cancelPendingPairing(pairingId)
                    // Also notify any visible AlertDialog so the user
                    // doesn't have to dismiss a stale prompt manually.
                    val cancelIntent = Intent(ACTION_PAIRING_CANCELLED_IN_FOREGROUND).apply {
                        setPackage(packageName)
                        putExtra(EXTRA_PAIRING_ID, pairingId)
                    }
                    sendBroadcast(cancelIntent)
                }
                "PAIRING_ACTIVE" -> {
                    // Pair has crossed into the active room — usually
                    // arrives right after ACCEPT_PAIRING was sent (the
                    // relay confirms the room change). Refresh the
                    // foreground notification to reflect the live state,
                    // and flip the in-activity status flag so the main
                    // pane swaps from "Lobby — waiting…" to "Connected"
                    // on its next 2s polling tick.
                    val ua = (payload?.get("ua") as? String).orEmpty()
                    val ip = (payload?.get("ip") as? String).orEmpty()
                    android.util.Log.d("PhoneService", "PAIRING_ACTIVE ua=$ua ip=$ip")
                    isPairActive = true
                    updateNotification(getString(R.string.pair_active_notification))
                }
                "PAIRING_TERMINATED" -> {
                    val reason = (payload?.get("reason") as? String).orEmpty()
                    android.util.Log.d("PhoneService", "PAIRING_TERMINATED reason=$reason")
                    // Stay connected to the relay (lobby). Just reset
                    // the foreground notification text — the pair is
                    // over but we're still available for the next one.
                    isPairActive = false
                    updateNotification(getString(R.string.status_waiting_for_web))
                    // Drop any pending request notifications for this
                    // session — defensive; usually nothing is pending
                    // by the time TERMINATED arrives.
                    clearAllPendingPairings("pairing terminated: $reason")
                }
                // ------------------------------------------------------
                "MAKE_CALL" -> {
                    val number = payload?.get("number") as? String ?: return
                    val speaker = payload?.get("speaker") as? Boolean ?: false
                    // Gson decodes JSON numbers in Map<String, Any> as Double — go through
                    // it before narrowing to Int. Null when the web didn't pick a SIM
                    // (single-SIM phones, or "default" selection).
                    val simId = (payload?.get("simId") as? Double)?.toInt()
                    android.util.Log.d("PhoneService", "MAKE_CALL for: $number (speaker=$speaker, simId=$simId)")
                    // Cache the requested number — PhoneStateListener uses this when the
                    // platform omits the number from state callbacks.
                    currentCallNumber = number
                    currentCallSpeaker = speaker
                    val success = if (simId != null) {
                        callHandler.makeCall(number, simId)
                    } else {
                        callHandler.makeCall(number)
                    }
                    if (!success) {
                        // Only report failure here. Real call-state transitions are
                        // emitted by phoneStateListener (CALL_STATE_OFFHOOK -> CALL_ANSWERED,
                        // CALL_STATE_IDLE -> CALL_ENDED). Do NOT fake CALL_ANSWERED on
                        // success — that lied to the UI when the call was still dialing
                        // or had been rejected.
                        sendResponse(
                            "CALL_ENDED",
                            mapOf("error" to "Failed to place call"),
                            viaClient
                        )
                        currentCallNumber = null
                        currentCallSpeaker = false
                    }
                }
                "ANSWER_CALL" -> {
                    callHandler.answerCall()
                }
                "END_CALL" -> {
                    callHandler.endCall()
                }
                "SET_SPEAKER" -> {
                    // Legacy alias retained for backward compat with older
                    // browser builds that haven't been redeployed to the
                    // simplified SET_AUDIO_SOURCE shape yet. New browser
                    // sends SET_AUDIO_SOURCE:phone|pc instead. Maps to the
                    // legacy "speaker"/"earpiece" terminals — both are
                    // accepted by applyAudioSource as aliases of "phone"
                    // routing in the new world (speaker stays as its own
                    // terminal so this legacy path still toggles the
                    // speakerphone if an old browser emits it).
                    val enabled = (payload?.get("enabled") as? Boolean) ?: false
                    applyAudioSource(if (enabled) "speaker" else "earpiece")
                }
                "SET_AUDIO_SOURCE" -> {
                    // FORGE-2 (v24, 2026-05-26): simplified to 2 buttons.
                    // Browser sends "phone" or "pc"; v24 also accepts the
                    // legacy "earpiece" / "speaker" / "bluetooth" as
                    // aliases so old browser builds keep working against
                    // new APKs. applyAudioSource validates and cleanly
                    // tears down the other routings before applying the
                    // target so we never stack speakerphone on top of SCO.
                    val source = (payload?.get("source") as? String) ?: "phone"
                    applyAudioSource(source)
                    android.util.Log.d("PhoneService", "SET_AUDIO_SOURCE applied: source=$source")
                }
                "GET_BT_HEADSET_STATUS" -> {
                    // Browser asks for an immediate snapshot — typically on
                    // pair-active to populate the toggle's enabled/disabled
                    // state before the first ACTION_CONNECTION_STATE_CHANGED
                    // broadcast lands.
                    broadcastBtHeadsetStatus()
                }
                "SEND_DTMF" -> {
                    // Webapp Quick Dial dialpad routed a key-press through the
                    // bridge while a call is active. Browser-side already validated
                    // the digit + gated on currentCall.state === 'active', but we
                    // re-validate defensively (never trust the wire).
                    val raw = payload?.get("digit") as? String
                    if (raw == null || raw.length != 1) {
                        android.util.Log.w("PhoneService", "SEND_DTMF: invalid digit payload: $raw")
                        return
                    }
                    val ch = raw[0]
                    if (!(ch in '0'..'9' || ch == '*' || ch == '#')) {
                        android.util.Log.w("PhoneService", "SEND_DTMF: non-DTMF char rejected: '$ch'")
                        return
                    }
                    sendDtmfTone(ch)
                }
                "SEND_SMS" -> {
                    val to = payload?.get("to") as? String ?: return
                    val body = payload?.get("body") as? String ?: return
                    val clientMsgId = payload?.get("clientMsgId") as? String ?: ""
                    smsHandler.sendSms(to, body, clientMsgId)
                }
                "GET_CONTACTS" -> {
                    android.util.Log.d("PhoneService", "Getting contacts...")
                    if (checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
                        android.util.Log.w("PhoneService", "READ_CONTACTS permission not granted")
                        // Even on permission failure we send a single "complete" empty chunk so
                        // the web client's reassembly logic resolves and progress unblocks.
                        sendResponse("CONTACTS_CHUNK", mapOf(
                            "page" to 1,
                            "total_pages" to 1,
                            "total_count" to 0,
                            "contacts" to emptyList<Any>(),
                            "error" to "READ_CONTACTS permission denied"
                        ), viaClient)
                        return
                    }
                    val contacts = contactsHandler.getContacts()
                    android.util.Log.d("PhoneService", "Got ${contacts.size} contacts, sending in chunks...")
                    sendChunked("CONTACTS", contacts, 50, viaClient, "contacts")
                }
                "GET_CALL_LOGS" -> {
                    android.util.Log.d("PhoneService", "Getting call logs...")
                    if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
                        android.util.Log.w("PhoneService", "READ_CALL_LOG permission not granted")
                        sendResponse("CALL_LOGS_CHUNK", mapOf(
                            "page" to 1,
                            "total_pages" to 1,
                            "total_count" to 0,
                            "callLogs" to emptyList<Any>(),
                            "error" to "READ_CALL_LOG permission denied"
                        ), viaClient)
                        return
                    }
                    // Gson deserializes JSON numbers in Map<String, Any> as Double — cast through
                    // it before converting to Long/Int.
                    val since = (payload?.get("since") as? Double)?.toLong() ?: 0L
                    // Cap removed 2026-05-26 per Dennis pivot — phone returns
                    // every row in the requested window. Browser still allowed
                    // to send a positive `limit` if it ever wants to bound a
                    // specific request; absent means unbounded.
                    val limit = (payload?.get("limit") as? Double)?.toInt() ?: Int.MAX_VALUE
                    val callLogs = callLogsHandler.getCallLogs(limit = limit, since = since)
                    android.util.Log.d("PhoneService", "Got ${callLogs.size} call logs (since=$since, limit=$limit), sending in chunks...")
                    sendChunked("CALL_LOGS", callLogs, 25, viaClient, "callLogs")
                }
                "GET_MESSAGES" -> {
                    android.util.Log.d("PhoneService", "Getting messages...")
                    if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                        android.util.Log.w("PhoneService", "READ_SMS permission not granted")
                        sendResponse("MESSAGES_CHUNK", mapOf(
                            "page" to 1,
                            "total_pages" to 1,
                            "total_count" to 0,
                            "messages" to emptyList<Any>(),
                            "error" to "READ_SMS permission denied"
                        ), viaClient)
                        return
                    }
                    val since = (payload?.get("since") as? Double)?.toLong() ?: 0L
                    // Cap removed 2026-05-26 per Dennis pivot — see GET_CALL_LOGS
                    // above. Phone returns every row in the requested window.
                    val limit = (payload?.get("limit") as? Double)?.toInt() ?: Int.MAX_VALUE
                    // Optional per-contact filter. When set, SmsHandler clears the
                    // time window internally so the web client gets the FULL thread
                    // history for that address (typical use: user opens a thread
                    // with sparse cached history and wants the complete backlog).
                    // Blank strings are treated as "no filter" to be defensive
                    // against the web client serialising an empty input.
                    val address = (payload?.get("address") as? String)?.takeIf { it.isNotBlank() }
                    // Backward-paging upper bound (epoch-ms, exclusive). Set by the
                    // web "Older messages" button to fetch the next page older than
                    // the oldest currently-loaded message. 0L = no upper bound
                    // (initial open / normal sync). Gson gives JSON numbers as
                    // Double, so cast through it before toLong().
                    val before = (payload?.get("before") as? Double)?.toLong() ?: 0L
                    // Combined SMS + MMS so group texts, picture messages, and voice
                    // notes all show up in the unified timeline. The merge happens
                    // on-device, so the web client sees a single sorted list.
                    val messages = smsHandler.getMessagesWithMms(this, limit = limit, since = since, address = address, before = before)
                    android.util.Log.d("PhoneService", "Got ${messages.size} messages (SMS+MMS, since=$since, limit=$limit, before=$before, address=${address ?: "all"}), sending in chunks...")
                    sendChunked("MESSAGES", messages, 25, viaClient, "messages")
                }
                "GET_MMS_FULL" -> {
                    val messageId = payload?.get("messageId") as? String ?: return
                    android.util.Log.d("PhoneService", "GET_MMS_FULL for: $messageId")

                    if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                        android.util.Log.w("PhoneService", "GET_MMS_FULL denied — READ_SMS missing")
                        sendResponse(
                            "MMS_MEDIA_ERROR",
                            mapOf("messageId" to messageId, "error" to "READ_SMS permission denied"),
                            viaClient
                        )
                        return
                    }

                    // SmsHandler converts MMS ids to "mms_<raw>" so the web client
                    // sees a unified shape. MmsHandler's content-provider queries
                    // expect the raw id, so strip the prefix back off here.
                    val rawId = messageId.removePrefix("mms_")
                    val mmsHandler = MmsHandler(this)
                    val mediaData = mmsHandler.getFullMediaData(rawId)

                    if (mediaData == null) {
                        sendResponse(
                            "MMS_MEDIA_ERROR",
                            mapOf("messageId" to messageId, "error" to "Media not found"),
                            viaClient
                        )
                        return
                    }

                    val (mimeType, bytes) = mediaData
                    val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

                    // Ship the base64 in 64 KB slices so we don't blow past
                    // WebSocket frame limits on the relay or browser side.
                    // 10 ms gap between chunks keeps the socket from drowning
                    // small control frames (PING / PONG) while a multi-MB
                    // image streams.
                    val chunkSize = 65536
                    val totalChunks = (base64.length + chunkSize - 1) / chunkSize

                    for (i in 0 until totalChunks) {
                        val start = i * chunkSize
                        val end = minOf(start + chunkSize, base64.length)
                        val chunk = base64.substring(start, end)

                        sendResponse(
                            "MMS_MEDIA_CHUNK",
                            mapOf(
                                "messageId" to messageId,
                                "chunkIndex" to i,
                                "totalChunks" to totalChunks,
                                "data" to chunk,
                                "mimeType" to mimeType
                            ),
                            viaClient
                        )

                        if (i < totalChunks - 1) {
                            Thread.sleep(10)
                        }
                    }
                    android.util.Log.d(
                        "PhoneService",
                        "MMS_MEDIA_FULL sent: $totalChunks chunks, ${bytes.size} bytes"
                    )
                }
                "GET_SYNC_ESTIMATE" -> {
                    // Sync-preview dispatch (v25, 2026-05-26): payload now
                    // optionally carries since/until (Long epoch ms) and a
                    // types array to subset which categories to count. All
                    // three are optional — bare {} keeps the legacy all-time
                    // all-categories behavior for older browser builds.
                    //
                    // Gson decodes JSON numbers in Map<String, Any> as Double,
                    // arrays as List<*>. Cast through Double before toLong()
                    // and through List<*> before .map { it as? String } —
                    // matches the GET_MESSAGES / GET_CALL_LOGS handlers above.
                    val since = (payload?.get("since") as? Double)?.toLong()?.takeIf { it > 0L }
                    val until = (payload?.get("until") as? Double)?.toLong()?.takeIf { it > 0L }
                    val typesRaw = payload?.get("types") as? List<*>
                    val types = typesRaw
                        ?.mapNotNull { it as? String }
                        ?.filter { it.isNotBlank() }
                        ?: listOf("contacts", "messages", "callLogs")
                    android.util.Log.d("PhoneService", "Building sync estimate (since=$since, until=$until, types=$types)...")
                    val estimate = buildSyncEstimate(since, until, types)
                    android.util.Log.d("PhoneService", "Estimate built: $estimate")
                    sendResponse("SYNC_ESTIMATE", estimate, viaClient)
                }
                "PING" -> {
                    android.util.Log.d("PhoneService", "PING received, sending PONG")
                    sendResponse("PONG", mapOf("time" to System.currentTimeMillis()), viaClient)
                }
                "HELLO" -> {
                    connectedHostname = payload?.get("hostname") as? String
                    android.util.Log.d("PhoneService", "HELLO received from: $connectedHostname")
                    // Report whether the user has granted Notification Listener
                    // access — without it RCS interception silently does nothing,
                    // so the web UI needs to know to prompt the user.
                    val granted = isNotificationListenerEnabled()
                    sendResponse(
                        "NOTIFICATION_PERMISSION",
                        mapOf("granted" to granted),
                        viaClient
                    )
                    // Push the active-SIM list so the web client can render a
                    // SIM picker for dual-SIM users. Empty list on single-SIM /
                    // permission denied — the UI handles both cases.
                    val simList = getSimList()
                    sendResponse("SIM_LIST", mapOf("sims" to simList), viaClient)
                }
                "REQUEST_NOTIFICATION_ACCESS" -> {
                    android.util.Log.d("PhoneService", "REQUEST_NOTIFICATION_ACCESS — opening settings")
                    val intent = android.content.Intent(
                        android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
                    )
                    intent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    try {
                        startActivity(intent)
                    } catch (e: Exception) {
                        android.util.Log.e("PhoneService", "Failed to open notification settings: ${e.message}", e)
                    }
                }
                "NOTIFICATION_REPLY" -> {
                    val notificationKey = payload?.get("notificationKey") as? String ?: return
                    val replyKey = payload?.get("replyKey") as? String ?: return
                    val text = payload?.get("text") as? String ?: return
                    android.util.Log.d("PhoneService", "NOTIFICATION_REPLY to key: $notificationKey")
                    sendNotificationReply(notificationKey, replyKey, text, viaClient)
                }
                "BROWSER_STATUS" -> {
                    // Relay tells us how many browser/web clients are currently
                    // paired with this phone session. Gson decodes JSON numbers
                    // in Map<String, Any> as Double (same gotcha as MAKE_CALL
                    // simId / GET_MESSAGES since/limit above), so narrow via
                    // Double → Int. Missing/malformed count is treated as 0 so
                    // the UI shows "Waiting for web app" rather than getting
                    // stuck on a stale positive count.
                    val count = (payload?.get("count") as? Double)?.toInt() ?: 0
                    if (count != currentBrowserCount) {
                        android.util.Log.d(
                            "PhoneService",
                            "BROWSER_STATUS: $currentBrowserCount -> $count"
                        )
                        currentBrowserCount = count
                    }
                }
                "APP_PING" -> {
                    // Browser → phone heartbeat (relayed). Echo the timestamp
                    // back as APP_PONG via the same WS write helper as every
                    // other response so it rides the same channel/lifecycle.
                    // Fire-and-forget; no phone-side state to track.
                    val ts = payload?.get("ts") as? Double
                    if (ts != null) {
                        sendResponse("APP_PONG", mapOf("ts" to ts), viaClient)
                    } else {
                        android.util.Log.w("PhoneService", "APP_PING missing ts field")
                    }
                }
                else -> {
                    android.util.Log.w("PhoneService", "Unknown command: $command")
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error handling command $command: ${e.message}", e)
        }
    }

    /**
     * Replies to a notification that exposes a RemoteInput action (e.g. WhatsApp,
     * Google Messages, Telegram, Signal). We look up the active StatusBarNotification
     * by sbn.key, find the action whose remoteInputs contains our replyKey, build
     * a Bundle carrying the text under that key, and fire the action's
     * PendingIntent with the text bundled in via RemoteInput.addResultsToIntent.
     *
     * Failure is logged but never throws — the web client treats reply as
     * fire-and-forget and does not block on a result frame.
     */
    private fun sendNotificationReply(notificationKey: String, replyKey: String, text: String, viaClient: Boolean = false) {
        try {
            // Find the active notification by key
            val activeNotif = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                com.dnkdialer.companion.DnkNotificationListenerService.getInstance()
                    ?.activeNotifications
                    ?.firstOrNull { it.key == notificationKey }
                    ?: com.dnkdialer.companion.DnkNotificationListenerService.replyCache[notificationKey]
            } else null

            if (activeNotif == null) {
                android.util.Log.w("PhoneService", "Notification not found for key: $notificationKey")
                return
            }

            val actions = activeNotif.notification.actions ?: return
            for (action in actions) {
                val remoteInputs = action.remoteInputs ?: continue
                if (remoteInputs.isEmpty()) continue

                val remoteInput = remoteInputs.firstOrNull { it.resultKey == replyKey } ?: continue

                val results = android.os.Bundle().apply {
                    putCharSequence(remoteInput.resultKey, text)
                }
                val fillIn = android.content.Intent().apply {
                    android.app.RemoteInput.addResultsToIntent(remoteInputs, this, results)
                }
                action.actionIntent.send(this, 0, fillIn)
                android.util.Log.d("PhoneService", "Notification reply sent successfully")
                try {
                    sendResponse("NOTIFICATION_REPLY_SENT", mapOf("notificationKey" to notificationKey), viaClient)
                } catch (_: Exception) {}
                return
            }
            android.util.Log.w("PhoneService", "No matching RemoteInput found for replyKey: $replyKey")
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Error sending notification reply: ${e.message}")
        }
    }

    /**
     * Build a SYNC_ESTIMATE response for the browser preview panel.
     *
     * - `since` / `until`  Epoch ms inclusive bounds. Null means "no bound".
     *                      Bare null/null = legacy all-time behavior used by
     *                      older browser builds that send GET_SYNC_ESTIMATE:{}.
     *                      Applied to the SMS / CallLog `date` column. Not
     *                      applied to contacts (contacts have no date concept
     *                      in the provider — always full count).
     * - `types`            Which categories to count. Default = all three.
     *                      Letting the browser opt out of a category keeps
     *                      cursor.count off providers the panel doesn't need
     *                      for this re-render — perf hedge for big SMS DBs.
     *
     * Response shape per category:
     *   contacts / messages / callLogs: { total: Int }
     *
     * Dennis pivot 2026-05-26 18:16 GMT+2: no cap, no willTruncate. The
     * earlier brief specced a `cap` + `willTruncate` pair (so the browser
     * could warn before Start Sync) but the user-facing decision is "make
     * it available, cap later if needed". The 2,500 default in
     * SmsHandler / CallLogsHandler / MmsHandler was also lifted in this
     * dispatch — phone now returns every row in the chosen range.
     */
    private fun buildSyncEstimate(
        since: Long? = null,
        until: Long? = null,
        types: List<String> = listOf("contacts", "messages", "callLogs"),
    ): Map<String, Any> {
        val out = mutableMapOf<String, Any>()

        // Contacts: no range concept — always full count when requested.
        if ("contacts" in types) {
            val contactsTotal = try {
                val cursor = contentResolver.query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone._ID),
                    null, null, null
                )
                val count = cursor?.count ?: 0
                cursor?.close()
                count
            } catch (e: SecurityException) { 0 }
            out["contacts"] = mapOf("total" to contactsTotal)
        }

        // Messages: range-aware via "date" column. cursor.count over the
        // SMS provider can take 100-300ms on large histories (50k+ rows) —
        // browser-side has a 400ms debounce so user-perceived latency stays
        // well under 1s. If a future profile shows main-thread jank, wrap
        // this branch in withContext(Dispatchers.IO) — handler is already
        // called off the main thread, but worth a check before optimizing.
        if ("messages" in types) {
            val (selection, args) = buildDateRangeSelection(since, until, "date")
            val messagesTotal = try {
                val cursor = contentResolver.query(
                    android.net.Uri.parse("content://sms"),
                    arrayOf(android.provider.Telephony.Sms._ID),
                    selection, args, null
                )
                val count = cursor?.count ?: 0
                cursor?.close()
                count
            } catch (e: SecurityException) { 0 }
            out["messages"] = mapOf("total" to messagesTotal)
        }

        // Call logs: range-aware via "date" column.
        if ("callLogs" in types) {
            val (selection, args) = buildDateRangeSelection(since, until, "date")
            val callLogsTotal = try {
                val cursor = contentResolver.query(
                    android.provider.CallLog.Calls.CONTENT_URI,
                    arrayOf(android.provider.CallLog.Calls._ID),
                    selection, args, null
                )
                val count = cursor?.count ?: 0
                cursor?.close()
                count
            } catch (e: SecurityException) { 0 }
            out["callLogs"] = mapOf("total" to callLogsTotal)
        }

        // Echo the range back so the browser can verify the response matches
        // the request it dispatched (useful when fast successive user drags
        // through the date picker fire overlapping previews).
        if (since != null || until != null) {
            out["range"] = buildMap<String, Any> {
                if (since != null) put("since", since)
                if (until != null) put("until", until)
            }
        }

        return out
    }

    /**
     * Build a parameterized WHERE clause + args array for a date-range
     * query against a content provider. Returns (null, null) when both
     * bounds are null (legacy all-time path).
     *
     * Always parameterized — never concatenated into the selection string —
     * so this is safe against the (admittedly unlikely) injection vector
     * if a malicious browser ever shipped a non-Long value.
     */
    private fun buildDateRangeSelection(
        since: Long?,
        until: Long?,
        dateColumn: String,
    ): Pair<String?, Array<String>?> {
        if (since == null && until == null) return null to null
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (since != null) {
            clauses += "$dateColumn >= ?"
            args += since.toString()
        }
        if (until != null) {
            clauses += "$dateColumn <= ?"
            args += until.toString()
        }
        return clauses.joinToString(" AND ") to args.toTypedArray()
    }

    /**
     * Enumerates active SIM subscriptions so the web client can render a
     * SIM-picker UI and route MAKE_CALL / SEND_SMS through a specific SIM on
     * dual-SIM phones. Each entry includes the subscriptionId (used by the
     * Telecom / SmsManager APIs), the slot index (0-based), a user-facing
     * name (carrier label or "SIM 1" fallback), and the phone number when
     * the carrier exposes it via the SubscriptionInfo (often null on Android).
     *
     * Returns an empty list if API < 22, READ_PHONE_STATE is denied, or the
     * SubscriptionManager is unavailable.
     */
    private fun getSimList(): List<Map<String, Any>> {
        return try {
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.LOLLIPOP_MR1) return emptyList()
            val subscriptionManager = getSystemService(android.telephony.SubscriptionManager::class.java) ?: return emptyList()
            if (checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) != android.content.pm.PackageManager.PERMISSION_GRANTED) return emptyList()
            val subs = subscriptionManager.activeSubscriptionInfoList ?: return emptyList()
            subs.map { sub ->
                mapOf(
                    "id" to sub.subscriptionId,
                    "slot" to sub.simSlotIndex,
                    "name" to (sub.displayName?.toString() ?: "SIM ${sub.simSlotIndex + 1}"),
                    "number" to (sub.number ?: "")
                )
            }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "SIM list error: ${e.message}")
            emptyList()
        }
    }

    private fun getLocalIpAddress(): String {
        try {
            NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { intf ->
                intf.inetAddresses?.toList()?.forEach { addr ->
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        return addr.hostAddress ?: "Unknown"
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return "Unknown"
    }

    /**
     * Dispatch #29 — simplified to a relay-only status string. The IP /
     * port LAN suffix is gone (no LAN listener) but the textual prefixes
     * are preserved so MainActivity.updateStatus's existing `contains`
     * branches still match.
     */
    fun getServerStatus(): String {
        val host = connectedHostname
        return when {
            client?.isOpen == true -> "Connected to relay${if (host != null) " ($host)" else ""}"
            else -> "Waiting for connection"
        }
    }

    // Dispatch #29 — getServer() removed. Callers should be ported to use
    // reconnectToRelay() / disconnectRelay() instead. The only known caller
    // (MainActivity's Disconnect-and-refresh button) was rewritten as the
    // Sign Out flow this same dispatch.

    override fun onDestroy() {
        super.onDestroy()

        // Tear down ContentObservers FIRST so they can't fire mid-shutdown and try
        // to send through a server/client that's already being closed below.
        stopContentObservers()

        // Unregister telephony state listener — must mirror the registration in onCreate
        // or we leak a reference to this Service.
        try {
            val telephonyManager =
                getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
            @Suppress("DEPRECATION")
            telephonyManager.listen(
                phoneStateListener,
                android.telephony.PhoneStateListener.LISTEN_NONE
            )
            android.util.Log.d("PhoneService", "PhoneStateListener unregistered")
        } catch (e: Exception) {
            android.util.Log.e("PhoneService", "Failed to unregister PhoneStateListener: ${e.message}", e)
        }

        // Unregister the modern TelephonyCallback on Android 12+ and shut down
        // its dedicated executor. Mirrors registerTelephonyCallback().
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            try {
                telCallbackRef?.let {
                    getSystemService(android.telephony.TelephonyManager::class.java)?.unregisterTelephonyCallback(it)
                }
                telExecutorRef?.shutdown()
                android.util.Log.d("PhoneService", "TelephonyCallback unregistered")
            } catch (e: Exception) {
                android.util.Log.w("PhoneService", "TelephonyCallback unregister failed: ${e.message}")
            }
            telCallbackRef = null
            telExecutorRef = null
        }

        // Unregister SMS status receiver and clear callbacks to avoid leaking the
        // PhoneService instance through the static callback fields on SmsStatusReceiver.
        SmsStatusReceiver.onSmsSent = null
        SmsStatusReceiver.onSmsDelivered = null
        try {
            unregisterReceiver(smsStatusReceiver)
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "smsStatusReceiver was not registered: ${e.message}")
        }

        // Dispatch #29 — Phase 4 finish. PhoneServer (LAN) is gone; the
        // server?.stop() + server = null lines from prior dispatches are
        // no longer needed. Only the relay client needs tearing down.

        // v18 — cancel any pending lobby reconnect so a 5s timer
        // doesn't wake up post-onDestroy with a Handler ref back into
        // this dead Service instance.
        cancelLobbyReconnect()

        // Stop client + cancel any pending connect-timeout watchdog so
        // the Handler queue doesn't retain a reference to this (now
        // shutting-down) service instance.
        cancelConnectTimeout()
        client?.close()
        client = null

        // Tear down pending-connection plumbing: cancel any auto-decline
        // timers, drop the receiver, and clear the shared handler so a
        // late-arriving Accept broadcast can't reach a dead service.
        pendingRequestTimers.values.forEach { pendingRequestHandler.removeCallbacks(it) }
        pendingRequestTimers.clear()
        ConnectionRequestReceiver.serviceHandler = null
        try {
            connectionRequestReceiver?.let { unregisterReceiver(it) }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "connectionRequestReceiver was not registered: ${e.message}")
        }
        connectionRequestReceiver = null

        // Mirror the above for the lobby-toggle receiver: clear the shared
        // handler so a late Disconnect/Reconnect broadcast can't reach a dead
        // service, then unregister.
        LobbyActionReceiver.lobbyActionHandler = null
        try {
            lobbyActionReceiver?.let { unregisterReceiver(it) }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "lobbyActionReceiver was not registered: ${e.message}")
        }
        lobbyActionReceiver = null

        // Release wake lock
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
            }
        }
        wakeLock = null

        // Clear SMS receiver callback
        SmsReceiver.onSmsReceived = null

        // Clear NotificationListenerService callbacks so the static fields
        // don't leak this Service instance after destroy.
        DnkNotificationListenerService.onMessageNotification = null
        DnkNotificationListenerService.onNotificationRemovedCb = null

        // 2-mode BT audio routing (2026-05-25): release the BluetoothHeadset
        // profile proxy + unregister the connection-state-changed receiver.
        // Skipping either leaks a binder reference through the BT stack
        // until the next service restart.
        try {
            bluetoothHeadsetReceiver?.let { unregisterReceiver(it) }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "bluetoothHeadsetReceiver was not registered: ${e.message}")
        }
        bluetoothHeadsetReceiver = null
        try {
            val bluetoothManager = getSystemService(android.content.Context.BLUETOOTH_SERVICE)
                as? android.bluetooth.BluetoothManager
            val adapter = bluetoothManager?.adapter
            bluetoothHeadset?.let { proxy ->
                adapter?.closeProfileProxy(android.bluetooth.BluetoothProfile.HEADSET, proxy)
            }
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "closeProfileProxy(HEADSET) failed: ${e.message}")
        }
        bluetoothHeadset = null
    }
}

