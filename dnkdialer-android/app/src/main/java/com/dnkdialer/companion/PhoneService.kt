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
import java.net.Inet4Address
import java.net.NetworkInterface

class PhoneService : Service() {

    companion object {
        const val ACTION_START = "com.dnkdialer.companion.START_SERVICE"
        const val ACTION_STOP = "com.dnkdialer.companion.STOP_SERVICE"
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
    private var server: PhoneServer? = null
    private var lastClientAddress: String? = null
    private var isClientConnected: Boolean = false
    private var client: PhoneClient? = null
    private var clientRelayUrl: String? = null
    private var connectedHostname: String? = null

    /**
     * Accept/Decline broadcasts from the connection-request notification land
     * in this receiver — we hand back to [handleConnectionDecision] via the
     * shared serviceHandler hook in [ConnectionRequestReceiver]. Held as a
     * field so onDestroy can unregister cleanly.
     */
    private var connectionRequestReceiver: ConnectionRequestReceiver? = null

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
                    android.util.Log.d("PhoneService", "TelephonyCallback state: $state")
                    when (state) {
                        android.telephony.TelephonyManager.CALL_STATE_RINGING -> {
                            // New call — clear downstream guards. CallStateListener
                            // does NOT receive the phone number (that's a separate
                            // PhoneStateListener with stricter permissions); fall
                            // back to the cached currentCallNumber for outgoing
                            // calls, empty string for unknown-inbound.
                            callEndedSentRef.set(false)
                            callAnsweredSentRef.set(false)
                            if (callIncomingSentRef.compareAndSet(false, true)) {
                                val isViaClient = client?.isOpen == true
                                val num = currentCallNumber ?: ""
                                sendResponse("CALL_INCOMING", mapOf("number" to num, "name" to ""), isViaClient)
                                android.util.Log.d("PhoneService", "TelephonyCallback -> CALL_INCOMING sent (num: $num)")
                            } else {
                                android.util.Log.d("PhoneService", "TelephonyCallback RINGING — CALL_INCOMING already sent, skipping")
                            }
                        }
                        android.telephony.TelephonyManager.CALL_STATE_OFFHOOK -> {
                            callEndedSentRef.set(false)
                            if (callAnsweredSentRef.compareAndSet(false, true)) {
                                val isViaClient = client?.isOpen == true
                                val num = currentCallNumber ?: ""
                                sendResponse("CALL_ANSWERED", mapOf("number" to num), isViaClient)
                                android.util.Log.d("PhoneService", "TelephonyCallback -> CALL_ANSWERED sent (num: $num)")

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
                                android.util.Log.d("PhoneService", "TelephonyCallback -> CALL_ENDED sent (num: $num)")
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
     * MainActivity polls this via getBrowserCount() on its 2 s status loop and
     * swaps the connection label between "Waiting…" and "N web client(s)
     * connected" based on the value.
     */
    private var currentBrowserCount: Int = 0

    /** Public read-only accessor for MainActivity's status polling loop. */
    fun getBrowserCount(): Int = currentBrowserCount

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
            audioManager.mode = android.media.AudioManager.MODE_NORMAL
        } catch (e: Exception) {
            android.util.Log.w("PhoneService", "clearSpeakerphoneOnEnd failed: ${e.message}")
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
                    android.util.Log.d("PhoneService", "Call ringing: $number")
                    // New call beginning — clear CALL_ENDED + CALL_ANSWERED guards
                    // so the downstream transitions (whichever observer sees them
                    // first) can fire. CALL_INCOMING itself is guarded below.
                    callEndedSentRef.set(false)
                    callAnsweredSentRef.set(false)
                    if (callIncomingSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_INCOMING", mapOf("number" to number, "name" to ""), isViaClient)
                    } else {
                        android.util.Log.d("PhoneService", "PhoneStateListener RINGING — CALL_INCOMING already sent, skipping")
                    }
                }
                android.telephony.TelephonyManager.CALL_STATE_OFFHOOK -> {
                    android.util.Log.d("PhoneService", "Call offhook (active): $number")
                    callEndedSentRef.set(false)
                    if (callAnsweredSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_ANSWERED", mapOf("number" to number), isViaClient)
                    } else {
                        android.util.Log.d("PhoneService", "PhoneStateListener OFFHOOK — CALL_ANSWERED already sent, skipping")
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
                    android.util.Log.d("PhoneService", "Call idle (ended) [PhoneStateListener]")
                    // Single guard — TelephonyCallback (12+) may also observe this
                    // transition. First-writer wins.
                    if (callEndedSentRef.compareAndSet(false, true)) {
                        val isViaClient = client?.isOpen == true
                        sendResponse("CALL_ENDED", mapOf<String, Any>(), isViaClient)
                        currentCallNumber = null
                        currentCallSpeaker = false
                        clearSpeakerphoneOnEnd()
                        // Retry CALL_ENDED after 800 ms in case the relay WS was briefly
                        // busy and dropped the first frame. The web client dedupes by
                        // event semantics (idempotent CALL_ENDED), so a duplicate is safe.
                        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                            if (client?.isOpen == true || server?.isClientConnected() == true) {
                                sendResponse("CALL_ENDED", mapOf<String, Any>(), client?.isOpen == true)
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        android.util.Log.d("PhoneService", "onStartCommand called with action: ${intent?.action}")
        
        when (intent?.action) {
            ACTION_START -> {
                android.util.Log.d("PhoneService", "Starting server...")
                startServer()

                val notificationIntent = Intent(this, MainActivity::class.java)
                val pendingIntent = PendingIntent.getActivity(
                    this, 0, notificationIntent,
                    PendingIntent.FLAG_IMMUTABLE
                )

                val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                    .setContentTitle("DNK Dialer")
                    .setContentText("Phone bridge is active")
                    .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .build()

                startForeground(NOTIFICATION_ID, notification)
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
                "DNK Dialer Service",
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

        val notification = NotificationCompat.Builder(this, CONNECTION_REQUEST_CHANNEL_ID)
            .setContentTitle("Connection request")
            .setContentText("Web client at $address wants to connect")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "Web client at $address wants to connect to your phone. " +
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
    private fun handleConnectionDecision(requestId: String, accept: Boolean) {
        android.util.Log.d("PhoneService", "handleConnectionDecision: $requestId accept=$accept")
        pendingRequestTimers.remove(requestId)?.let {
            pendingRequestHandler.removeCallbacks(it)
        }
        dismissConnectionRequestNotification(requestId)

        if (accept) {
            val ok = server?.acceptPendingConnection(requestId) ?: false
            if (!ok) {
                android.util.Log.w("PhoneService", "Accept skipped — pending conn no longer present")
            }
        } else {
            server?.declinePendingConnection(requestId)
        }
    }

    /**
     * Replaces the persistent foreground notification's text so the user can see
     * connection state at a glance ("Connected to PC — syncing data" vs the
     * default "Phone bridge is active"). No accept/deny prompt — just visibility.
     */
    private fun updateNotification(text: String) {
        val notificationManager = getSystemService(NotificationManager::class.java)
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DNK Dialer")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
        notificationManager.notify(NOTIFICATION_ID, notification)
    }

    private fun startServer() {
        // Register the modern TelephonyCallback on Android 12+ (S / API 31).
        // Done here in addition to the legacy PhoneStateListener registered in
        // onCreate — both co-exist; whichever observes IDLE first sends
        // CALL_ENDED and the other no-ops via callEndedSentRef. startServer is
        // called every ACTION_START, so guard against double-registration in
        // registerTelephonyCallback by checking telCallbackRef first.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S && telCallbackRef == null) {
            registerTelephonyCallback()
        }

        try {
            android.util.Log.d("PhoneService", "Starting WebSocket server...")
            server = PhoneServer(8765, { command, payload ->
                handleCommand(command, payload)
            }, { connected, address ->
                isClientConnected = connected
                lastClientAddress = if (connected) address else null
                android.util.Log.d("PhoneService", if (connected) "Client connected from: $address" else "Client disconnected")

                // Update the foreground notification to reflect connection state
                updateNotification(if (connected) "Connected to PC — syncing data" else "Phone bridge is active")
            }, { requestId, address ->
                // Incoming WS upgrade has completed but is parked in PENDING —
                // raise the user-facing Accept/Decline notification and start
                // the 30 s auto-decline timer. See [postConnectionRequestNotification]
                // for the heads-up notification + action wiring.
                android.util.Log.d("PhoneService", "Connection request $requestId from $address — prompting user")
                postConnectionRequestNotification(requestId, address)
                scheduleAutoDecline(requestId)
            })
            server?.start()

            // Set up SMS receiver callback — send via both server and client.
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
                server?.send("SMS_RECEIVED", data)
            }

            val ip = getLocalIpAddress()
            android.util.Log.d("PhoneService", "Server started successfully on $ip:8765")

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
            android.util.Log.e("PhoneService", "Failed to start server: ${e.message}", e)
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

        // Keep server running too for backward compat
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
                    cancelConnectTimeout()
                    setRelayPhase(RelayPhase.OPEN)
                } else if (relayPhase != RelayPhase.FAILED) {
                    setRelayPhase(RelayPhase.IDLE)
                }
            },
            { code, reason ->
                // Non-1000 close OR raw exception from PhoneClient.
                // Capture the diagnostic pair and flip to FAILED so the
                // UI can render an actionable error message. The phase
                // ordering here matters — onClose fires AFTER onError
                // when the close is abnormal, but onError -> FAILED
                // wins because the next onClose checks current phase.
                //
                // Cancel the watchdog: a real onError (e.g. DNS fail,
                // refused) means we got a definitive answer faster than
                // 10s — the watchdog's "still hanging?" check is moot.
                cancelConnectTimeout()
                lastConnectionError = code to reason
                android.util.Log.w("PhoneService", "Relay connection error: code=$code reason=$reason")
                setRelayPhase(RelayPhase.FAILED)
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
        // Cancel the connect-timeout watchdog BEFORE we tear down the
        // client. If the user taps Cancel mid-handshake, the watchdog
        // would otherwise fire ~10s later against a now-null client
        // (the identity check inside the runnable handles this too,
        // but cancelling here keeps the Handler queue clean).
        cancelConnectTimeout()
        // Clear error BEFORE close() so the onClose callback below,
        // which may fire synchronously on some socket states, doesn't
        // re-arm FAILED on the way out.
        lastConnectionError = null
        client?.close(1000, "user_disconnect")
        client = null
        clientRelayUrl = null
        isClientConnected = false
        setRelayPhase(RelayPhase.IDLE)
    }

    fun reconnectToRelay() {
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

    private fun sendResponse(type: String, data: Any, viaClient: Boolean = false) {
        android.util.Log.d("PhoneService", "sendResponse: type=$type, viaClient=$viaClient, clientOpen=${client?.isOpen}, serverClientConnected=${server?.isClientConnected()}")
        try {
            if (viaClient && client != null) {
                client?.sendResponse(type, data)
                android.util.Log.d("PhoneService", "Response sent via client")
            } else {
                server?.send(type, data)
                android.util.Log.d("PhoneService", "Response sent via server")
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
                "DISCONNECT_PHONE" -> {
                    // The webapp's "Disconnect" button forwards this command
                    // through the relay so the phone can proactively tear down
                    // its LAN-server side of the connection. Before this branch
                    // existed, the command silently fell through here, the phone
                    // never closed the WS, the relay's outbound auto-reconnect
                    // loop re-established it on the next 5s tick, and the user
                    // ended up unable to pair again without uninstalling the
                    // APK. See PhoneServer.disconnectAllClients for the full
                    // cleanup contract.
                    android.util.Log.d("PhoneService", "Received DISCONNECT_PHONE from webapp — tearing down LAN clients")
                    server?.disconnectAllClients()
                    return
                }
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
                    val enabled = (payload?.get("enabled") as? Boolean) ?: false
                    currentCallSpeaker = enabled
                    applySpeakerphone(enabled)
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
                    val limit = (payload?.get("limit") as? Double)?.toInt() ?: 2500
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
                    val limit = (payload?.get("limit") as? Double)?.toInt() ?: 2500
                    // Optional per-contact filter. When set, SmsHandler clears the
                    // time window internally so the web client gets the FULL thread
                    // history for that address (typical use: user opens a thread
                    // with sparse cached history and wants the complete backlog).
                    // Blank strings are treated as "no filter" to be defensive
                    // against the web client serialising an empty input.
                    val address = (payload?.get("address") as? String)?.takeIf { it.isNotBlank() }
                    // Combined SMS + MMS so group texts, picture messages, and voice
                    // notes all show up in the unified timeline. The merge happens
                    // on-device, so the web client sees a single sorted list.
                    val messages = smsHandler.getMessagesWithMms(this, limit = limit, since = since, address = address)
                    android.util.Log.d("PhoneService", "Got ${messages.size} messages (SMS+MMS, since=$since, limit=$limit, address=${address ?: "all"}), sending in chunks...")
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
                    android.util.Log.d("PhoneService", "Building sync estimate...")
                    val estimate = buildSyncEstimate()
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

    private fun buildSyncEstimate(): Map<String, Any> {
        // Contacts total
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

        // Messages total
        val messagesTotal = try {
            val cursor = contentResolver.query(
                android.net.Uri.parse("content://sms"),
                arrayOf(android.provider.Telephony.Sms._ID),
                null, null, null
            )
            val count = cursor?.count ?: 0
            cursor?.close()
            count
        } catch (e: SecurityException) { 0 }

        // Call logs total
        val callLogsTotal = try {
            val cursor = contentResolver.query(
                android.provider.CallLog.Calls.CONTENT_URI,
                arrayOf(android.provider.CallLog.Calls._ID),
                null, null, null
            )
            val count = cursor?.count ?: 0
            cursor?.close()
            count
        } catch (e: SecurityException) { 0 }

        return mapOf(
            "contacts" to mapOf("total" to contactsTotal),
            "messages" to mapOf("total" to messagesTotal),
            "callLogs" to mapOf("total" to callLogsTotal)
        )
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

    fun getServerStatus(): String {
        val ip = getLocalIpAddress()
        val host = connectedHostname
        return when {
            client?.isOpen == true -> "Connected to relay${if (host != null) " ($host)" else ""} - IP: $ip:8765"
            isClientConnected -> "Connected from ${host ?: lastClientAddress ?: "unknown"} - IP: $ip:8765"
            else -> "Waiting for connection - IP: $ip:8765"
        }
    }

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

        // Stop server
        server?.stop()
        server = null

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
    }
}

