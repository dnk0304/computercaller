package com.dnkdialer.companion

import android.Manifest
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.content.res.ColorStateList
import android.widget.Toast
import com.dnkdialer.companion.R

class MainActivity : AppCompatActivity() {

    companion object {
        /**
         * Request code for the legacy "auto-request on first launch" flow
         * (kept for back-compat — the Grant All flow uses its own code so
         * the result handler can branch on it).
         */
        private const val REQ_INITIAL_PERMISSIONS = 1

        /**
         * Request code for the "Grant All" runtime-permission batch fired
         * from the blocking permissions-required pane.
         */
        private const val REQ_GRANT_ALL_RUNTIME = 2
    }

    /**
     * Connection-status visual states. The colored dot carries the signal so
     * the status text can stay clean (no emoji prefixes). Keep these in sync
     * with the tint logic in [setStatusVisual].
     *
     * Round 4 additions:
     *   CONNECTING — relay WebSocket handshake in flight. Slate-blue dot.
     *   FAILED     — last connect attempt errored. Red dot. Reason copy
     *                is rendered separately in [connectionErrorText].
     *
     * Backwards compat: LIVE / WAITING / IDLE preserved unchanged. The
     * polling status-loop in [updateStatus] still resolves to one of
     * those three; the new states are driven exclusively by the
     * PhoneService.onRelayPhaseChanged callback so they can't fight
     * the polling loop. See [onRelayPhaseChanged] in onServiceConnected.
     */
    private enum class ConnState { LIVE, WAITING, IDLE, CONNECTING, FAILED }

    private var phoneService: PhoneService? = null
    private var serviceBound = false

    private lateinit var statusText: TextView
    private lateinit var statusDot: View
    private lateinit var statusDotRing: View
    private lateinit var stepNumber: TextView
    private lateinit var enableNotificationsButton: Button
    // Dispatch #29 — Phase 4 finish. LAN-IP / QR plate stripped from
    // activity_main.xml; the corresponding ipText + qrCodeImage fields
    // are gone. The phone now only connects outbound to the SaaS relay
    // (wired in PhoneService.onStartCommand) so there's nothing for the
    // user to copy or scan on this surface.

    /**
     * Round 7 — status dot pulse animator.
     *
     * In CONNECTING / WAITING states the soft halo ring breathes
     * (alpha 0.35 → 1.0 → 0.35 over 1500ms, repeated). In LIVE it's
     * held at a steady 0.6 alpha (clear "lit indicator" affordance,
     * not animated — animation should signal *action*, not *health*).
     * In IDLE / FAILED the ring is hidden entirely.
     *
     * Stored as a field so [setStatusVisual] can cancel the previous
     * animator before starting a new one, preventing alpha drift when
     * state transitions arrive faster than one pulse cycle.
     */
    private var statusPulseAnimator: ValueAnimator? = null

    /**
     * Round 7 — FAILED-state shake suppression flag.
     *
     * The shake should fire only on the FIRST entry into FAILED, not
     * on every subsequent setStatusVisual(FAILED) call (the polling
     * loop + relay-phase callback can re-paint FAILED several times
     * per second while the user is still reading the error message).
     * Reset when state leaves FAILED.
     */
    private var failedShakePlayed: Boolean = false

    // Hoisted to a field so handleRelayPhaseChanged() can flip
    // isEnabled / setText without re-findViewById'ing on every phase
    // transition. The button is labelled "Connect" (R5+) — enabled
    // when the relay socket is IDLE / WAITING / FAILED, disabled
    // while LIVE (already connected) or CONNECTING (handshake in
    // flight — don't let the user spam reconnects).
    private lateinit var reconnectButton: Button

    // Diagnostic surfacing for the LAN flow.
    // Target line + failure line stay GONE in steady-state; only the
    // CONNECTING / FAILED phases populate them. Useful when the user
    // hits Reconnect against a stale LAN IP or the WS handshake hangs.
    private lateinit var connectionTargetText: TextView
    private lateinit var connectionErrorText: TextView

    /**
     * Mirror of the last RelayPhase reported by PhoneService. Drives
     * whether [updateStatus]'s polling loop is allowed to overwrite
     * the status dot — if we're CONNECTING or FAILED, the relay-side
     * truth wins until it transitions back to OPEN/IDLE. Without this,
     * the 2-second status tick would clobber a FAILED state with
     * "Waiting for browser" on the next pulse.
     */
    private var latestRelayPhase: PhoneService.RelayPhase = PhoneService.RelayPhase.IDLE

    private var statusUpdateRunnable: Runnable? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    /**
     * Round 6 — Samsung One UI auto-revoke defense.
     *
     * When true, the Activity is showing the permissions-required pane
     * (R.layout.activity_permissions_required) instead of the main pane.
     * In this state we:
     *   - Do NOT bind to PhoneService (it can't function without
     *     permissions, and binding would crash on a missing-permission
     *     SecurityException inside the service init path).
     *   - Do NOT start the foreground service.
     *   - Do NOT run the 2-second status polling loop.
     *   - Re-check permissions on every onResume — when the list goes
     *     empty, run the success animation and swap to the main pane.
     *
     * The flag is set in [renderPermissionsRequiredPane] and cleared in
     * [renderMainPane]. Treat as the canonical source of truth — guards
     * around it prevent the service-start logic from firing while the
     * user is mid-grant flow.
     */
    private var inPermissionsRequiredPane: Boolean = false

    /**
     * Tracks whether the main pane's onCreate-time service-start logic
     * has run. We defer that logic until the first time we transition
     * INTO the main pane — if the app opens with permissions missing,
     * we render the permissions pane in onCreate and only run the
     * normal auto-start flow once the user finishes granting.
     */
    private var mainPaneInitialized: Boolean = false

    /**
     * Dispatch #9 (2026-05-22) — `userStopped` field REMOVED.
     *
     * Background: dispatch #6 introduced this Boolean to track whether the
     * user explicitly tapped "Disconnect and stop", so that updateStatus()
     * could decide between "show Start CTA" and "paint the loading state".
     * That whole dual-button stopped/running UX is gone in dispatch #9 —
     * Dennis wanted a single "Disconnect and refresh" button that tears
     * down + immediately restarts the service. There's no stopped UI to
     * paint and no user intent for the service to stay down, so the latch
     * is dead weight.
     *
     * Tombstone left so a future agent doesn't reintroduce the same idea.
     */
    // (intentionally no field here — see kdoc above)

    /**
     * Round 8 — Grant All flow state.
     *
     * When the user taps "Grant All Permissions" on the blocking pane we
     * fire ActivityCompat.requestPermissions() with every missing RUNTIME
     * permission batched into one call (Android shows them as a
     * back-to-back sequence of native popups inside a single request).
     * On callback we re-check the audit and, if any SPECIAL grants remain,
     * we walk the user through them sequentially via Settings deep-links.
     *
     * [grantAllInProgress] gates onResume so the special-access dialog
     * doesn't re-fire every time the user comes back from a Settings
     * screen mid-sequence. Cleared when the audit clears or the user
     * cancels.
     */
    private var grantAllInProgress: Boolean = false

    /**
     * Suppression flag for the runtime-popup result handler. When set,
     * onRequestPermissionsResult will (after recording results) continue
     * into the special-access sequence instead of treating the result as
     * a one-shot "did we get every standard permission" gate.
     */
    private var awaitingRuntimeResultForGrantAll: Boolean = false

    // v18 — `permsDetailsExpanded` field removed.
    //
    // Background: rounds 6-8 had a collapsible "What does this need
    // access to?" detail panel hidden behind a toggle, with this
    // boolean tracking expanded/collapsed state across re-renders.
    // v18 replaces the toggle pattern with a permanently-visible
    // checklist (every permission, every status), so the toggle and
    // its state field are both dead. If a future dispatch wants to
    // bring back collapsing rows, look here for the original pattern.

    private val requiredPermissions = arrayOf(
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.ANSWER_PHONE_CALLS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_SMS,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.READ_CALL_LOG
    )
    
    private val optionalPermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(Manifest.permission.POST_NOTIFICATIONS)
    } else {
        emptyArray()
    }

    /**
     * v18 / Connect+Accept pivot — in-foreground pairing-request dialog.
     *
     * PhoneService broadcasts ACTION_PAIRING_REQUEST_IN_FOREGROUND every
     * time a PAIRING_REQUEST frame arrives over the relay. When the
     * Activity is foregrounded we surface a synchronous AlertDialog so
     * the user can act without diving into the notification shade.
     * The notification still posts in parallel — both Accept/Decline
     * paths dispatch the same internal broadcast that
     * [ConnectionRequestReceiver] consumes, so the decision converges
     * in [PhoneService.handleConnectionDecision].
     *
     * Field-tracked so a PAIRING_CANCELLED (relay tells us the browser
     * walked away) can dismiss a still-visible dialog, and so onPause
     * can dismiss it cleanly without leaking a window token.
     */
    private var pairingRequestDialog: AlertDialog? = null

    /**
     * Pairing-id currently shown in [pairingRequestDialog]. Used so
     * PAIRING_CANCELLED with a different id leaves the dialog alone
     * (defensive — should never happen in practice, but a second
     * concurrent request handled by a different code path could race).
     */
    private var pairingRequestDialogId: String? = null

    /**
     * Broadcast receiver for the in-foreground pairing surfacing.
     * Registered in [onResume] with RECEIVER_NOT_EXPORTED so no
     * external app can spoof pairing intents into our UI. Unregistered
     * in [onPause].
     */
    private val pairingForegroundReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent == null) return
            when (intent.action) {
                PhoneService.ACTION_PAIRING_REQUEST_IN_FOREGROUND -> {
                    val pairingId = intent.getStringExtra(PhoneService.EXTRA_PAIRING_ID) ?: return
                    val identity = intent.getStringExtra(PhoneService.EXTRA_PAIRING_IDENTITY)
                        ?: getString(R.string.pair_request_body_unknown)
                    showPairingRequestDialog(pairingId, identity)
                }
                PhoneService.ACTION_PAIRING_CANCELLED_IN_FOREGROUND -> {
                    val pairingId = intent.getStringExtra(PhoneService.EXTRA_PAIRING_ID) ?: return
                    dismissPairingDialogIfMatching(pairingId)
                }
            }
        }
    }

    /**
     * Tracks whether [pairingForegroundReceiver] is currently registered
     * so the unregister call in [onPause] doesn't throw on cold starts
     * where onResume hasn't run yet (rare but possible during config
     * changes).
     */
    private var pairingReceiverRegistered: Boolean = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as PhoneService.LocalBinder
            phoneService = binder.getService()
            serviceBound = true
            // Dispatch #9: userStopped field removed (see field-site
            // tombstone above). No bind-side cleanup needed.
            android.util.Log.d("MainActivity", "Service connected")

            // Install the relay-phase callback so any CONNECTING / FAILED
            // transition during a LAN reconnect attempt is surfaced in
            // the status row. Callback fires on the WebSocket worker
            // thread; we hop back to the main looper before touching
            // views (Handler.post). Set to null in onServiceDisconnected
            // so a stale reference can't fire after we tear down.
            phoneService?.onRelayPhaseChanged = { phase ->
                handler.post { handleRelayPhaseChanged(phase) }
            }

            updateStatus()
            startStatusUpdates()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // Drop our callback so PhoneService can't fire into a dead
            // Activity (it can outlive us — foreground service binding).
            phoneService?.onRelayPhaseChanged = null
            phoneService = null
            serviceBound = false
            android.util.Log.d("MainActivity", "Service disconnected")
            stopStatusUpdates()
            updateStatus()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Dispatch #28 (2026-05-24) — first-launch sign-in gate. Before any
        // permission audit, check we have a phoneToken stored. Without one
        // there is no relay room to join, so showing the permissions pane
        // would be pointless — we bounce to SignInActivity immediately and
        // come back here once the user has signed in.
        if (!TokenStore.hasToken(this)) {
            android.util.Log.d("MainActivity", "onCreate: no stored phoneToken — launching SignInActivity")
            startActivity(Intent(this, SignInActivity::class.java))
            finish()
            return
        }

        // Samsung One UI auto-revoke defense — see [inPermissionsRequiredPane]
        // kdoc. We audit permissions BEFORE inflating the main layout so
        // findViewById calls below never try to resolve ids that aren't
        // present yet. If any are missing, we render the blocking pane
        // and bail out of onCreate without touching the service.
        val missing = PermissionChecker.checkAll(this)
        if (missing.isNotEmpty()) {
            android.util.Log.d("MainActivity", "onCreate: ${missing.size} permissions missing — showing blocking pane")
            renderPermissionsRequiredPane(missing)
            return
        }

        initializeMainPane()
    }

    /**
     * Sets up the main control pane. Extracted from the original onCreate
     * body so it can be called either directly (when permissions are
     * already granted at launch) OR deferred (when the user opens the
     * app with permissions revoked, grants them, then comes back).
     *
     * Guarded by [mainPaneInitialized] so we never re-bind the service
     * or re-register listeners if onResume calls us a second time.
     */
    private fun initializeMainPane() {
        if (mainPaneInitialized) {
            android.util.Log.d("MainActivity", "initializeMainPane: already initialized, skipping")
            return
        }
        mainPaneInitialized = true
        inPermissionsRequiredPane = false
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        statusDot = findViewById(R.id.statusDot)
        statusDotRing = findViewById(R.id.statusDotRing)
        stepNumber = findViewById(R.id.stepNumber)
        enableNotificationsButton = findViewById(R.id.enable_notifications_button)
        reconnectButton = findViewById(R.id.reconnectButton)

        // Diagnostic surface for relay-dial attempts that hang or fail.
        connectionTargetText = findViewById(R.id.connectionTargetText)
        connectionErrorText = findViewById(R.id.connectionErrorText)

        // Initial visual: idle. Real state arrives once the service binds.
        setStatusVisual(ConnState.IDLE)

        // Dispatch #9: the reconnectButton widget is now PERMANENTLY hidden.
        // The dual-button "Start / Disconnect and stop" UX from dispatch #6
        // collapsed to a single "Disconnect and refresh" button. The XML id
        // is retained to avoid layout churn but the widget is forced GONE
        // here AND in every updateStatus() branch (see lines below). If a
        // future dispatch wants to bring a partner button back, look here.
        reconnectButton.visibility = View.GONE
        reconnectButton.isEnabled = false

        // Enable Notifications button - opens system settings
        enableNotificationsButton.setOnClickListener {
            openNotificationSettings()
        }

        // Dispatch #29 — disconnectButton repurposed as Sign Out.
        // Old behavior: polite-close LAN clients + stop service + restart
        // service after 1500ms (dispatch #6/#9/#23 lineage). With no LAN
        // server anymore (PhoneServer.kt deleted) there's nothing to
        // "refresh" — the only meaningful tear-down is dropping the
        // signed-in identity. Tapping Sign Out:
        //   1. Confirms with the user (dialog with Cancel / Sign out).
        //   2. Stops the foreground service so the relay socket closes
        //      cleanly (otherwise the browser would still see the phone).
        //   3. Wipes the stored phoneToken via TokenStore.clearToken.
        //   4. Launches SignInActivity with CLEAR_TASK so back-button
        //      can't return to the main pane in a half-signed-out state.
        //   5. finish() so the activity stack ends with SignIn as root.
        val disconnectButton: Button = findViewById(R.id.disconnectButton)
        disconnectButton.setOnClickListener {
            showSignOutConfirmation()
        }
        
        // Hard Reset button — manual escape hatch for the "Samsung
        // One UI silently revoked something" class of bugs. Wipes app
        // data via ActivityManager.clearApplicationUserData() and
        // force-restarts the process, so the user lands back on the
        // Grant All pane with a clean slate. Gated behind a confirmation
        // dialog with a destructive-style action button (red text) so an
        // accidental tap doesn't nuke the user's setup.
        val hardResetButton: Button = findViewById(R.id.hardResetButton)
        hardResetButton.setOnClickListener {
            showHardResetConfirmation()
        }

        // Check and show notification status
        checkNotificationStatus()

        // Auto-start flow: request battery exemption then start the
        // service. Permissions were already audited via the
        // permissions-required pane gate in onCreate, so we don't need
        // to redundantly re-request them here.
        if (hasPermissions()) {
            android.util.Log.d("MainActivity", "Permissions already granted")

            if (!isBatteryOptimizationDisabled()) {
                android.util.Log.d("MainActivity", "Requesting battery optimization exemption")
                statusText.text = getString(R.string.status_battery_request)
                setStatusVisual(ConnState.WAITING)
                requestBatteryOptimizationExemption()
            } else {
                android.util.Log.d("MainActivity", "Battery optimization already disabled, starting service")
                statusText.text = getString(R.string.status_connecting)
                setStatusVisual(ConnState.WAITING)
                startPhoneService()
            }
        } else {
            android.util.Log.d("MainActivity", "Permissions not granted, requesting automatically")
            statusText.text = getString(R.string.status_perms_requesting)
            setStatusVisual(ConnState.IDLE)
            requestPermissions()
        }
    }

    private fun hasPermissions(): Boolean {
        val allGranted = requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        
        if (!allGranted) {
            // Log which permissions are missing
            requiredPermissions.forEach { permission ->
                val granted = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
                android.util.Log.d("MainActivity", "Permission $permission: ${if (granted) "GRANTED" else "DENIED"}")
            }
        }
        
        return allGranted
    }

    private fun requestPermissions() {
        android.util.Log.d("MainActivity", "Requesting permissions...")
        // Request all permissions together (required + optional)
        val allPermissions = requiredPermissions + optionalPermissions
        ActivityCompat.requestPermissions(this, allPermissions, REQ_INITIAL_PERMISSIONS)
    }
    
    private fun openNotificationSettings() {
        try {
            val intent = Intent()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent.action = android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS
                intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
            } else {
                intent.action = android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                intent.data = android.net.Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed to open notification settings", e)
            statusText.text = getString(R.string.action_enable_notifications)
        }
    }
    
    private fun checkNotificationStatus() {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val areNotificationsEnabled = notificationManager.areNotificationsEnabled()
        
        if (!areNotificationsEnabled) {
            android.util.Log.d("MainActivity", "Notifications are blocked at system level")
            enableNotificationsButton.visibility = android.view.View.VISIBLE
        } else {
            android.util.Log.d("MainActivity", "Notifications are enabled")
            enableNotificationsButton.visibility = android.view.View.GONE
        }
    }
    
    private fun isBatteryOptimizationDisabled(): Boolean {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val isIgnoring = powerManager.isIgnoringBatteryOptimizations(packageName)
        android.util.Log.d("MainActivity", "Battery optimization disabled: $isIgnoring")
        return isIgnoring
    }
    
    private fun requestBatteryOptimizationExemption() {
        if (isBatteryOptimizationDisabled()) {
            android.util.Log.d("MainActivity", "Already exempt from battery optimization")
            return
        }
        
        try {
            android.util.Log.d("MainActivity", "Requesting battery optimization exemption")
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed to request battery optimization exemption", e)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        android.util.Log.d("MainActivity", "Permission result received, requestCode: $requestCode")

        // Round 8 — Grant All flow result.
        // The batched runtime popup finished (every permission either
        // granted, denied, or "Don't ask again"'d). Re-run the full audit
        // so we know whether to continue into special-access prompts or
        // surface a "still missing" UI.
        if (requestCode == REQ_GRANT_ALL_RUNTIME) {
            awaitingRuntimeResultForGrantAll = false
            // Log every result for diagnostics — useful when a user
            // reports "I tapped Allow on everything but it still shows
            // the screen". Almost always one permission was tapped
            // Don't allow once before and the OS auto-denied it.
            for (i in permissions.indices) {
                val granted = i < grantResults.size &&
                    grantResults[i] == PackageManager.PERMISSION_GRANTED
                android.util.Log.d(
                    "MainActivity",
                    "Grant All runtime result: ${permissions[i]} = ${if (granted) "GRANTED" else "DENIED"}"
                )
            }
            continueGrantAllFlow()
            return
        }

        if (requestCode == REQ_INITIAL_PERMISSIONS) { // Initial permissions request
            if (hasPermissions()) {
                android.util.Log.d("MainActivity", "All required permissions granted, auto-starting service")
                statusText.text = getString(R.string.status_perms_granted)
                setStatusVisual(ConnState.WAITING)

                // Auto-start service immediately
                startPhoneService()
            } else {
                android.util.Log.d("MainActivity", "Some required permissions denied")
                val deniedPermissions = requiredPermissions.filter {
                    ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
                }

                statusText.text = getString(R.string.status_perms_denied_count, deniedPermissions.size)
                setStatusVisual(ConnState.IDLE)

                // Show which specific permissions were denied
                deniedPermissions.forEach {
                    android.util.Log.d("MainActivity", "Denied: $it")
                }
            }
        }
    }

    private fun startPhoneService() {
        android.util.Log.d("MainActivity", "startPhoneService called")
        val intent = Intent(this, PhoneService::class.java).apply {
            action = PhoneService.ACTION_START
        }
        
        try {
            // Use startForegroundService on Android O+ so the service can call startForeground()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            android.util.Log.d("MainActivity", "startService called")
            
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            android.util.Log.d("MainActivity", "bindService called")
            
            updateStatus()
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error starting service", e)
            statusText.text = getString(R.string.status_error_format, e.message ?: "unknown")
            setStatusVisual(ConnState.IDLE)
        }
    }

    private fun updateStatus() {
        android.util.Log.d("MainActivity", "updateStatus - serviceBound: $serviceBound, phoneService: ${phoneService != null}")

        // Dispatch #29 — Phase 4 finish. With the LAN PhoneServer gone,
        // updateStatus only paints the relay-side state. Phase-driven
        // paints (CONNECTING / FAILED) are owned by handleRelayPhaseChanged
        // and short-circuit here so the 2s polling tick doesn't fight them.
        if (latestRelayPhase == PhoneService.RelayPhase.CONNECTING ||
            latestRelayPhase == PhoneService.RelayPhase.FAILED) {
            // Sign Out button stays visible regardless of phase so the
            // user can always escape a wedged state.
            reconnectButton.visibility = View.GONE
            return
        }

        if (serviceBound && phoneService != null) {
            val status = phoneService?.getServerStatus() ?: "Service not running"

            // Browser-presence overlay (false-connection fix). The relay
            // socket being open does NOT mean a real browser is paired —
            // the relay pushes BROWSER_STATUS with the live count, and
            // PhoneService caches it. When we're connected to the relay
            // but no browser is actually on the other end, fall back to
            // the "Waiting for browser" copy rather than claiming the
            // pairing is live. Polled on every 2 s status tick.
            val browserCount = phoneService?.getBrowserCount() ?: 0

            val (text, conn) = when {
                // v18 — relay socket is OPEN but no active pair. The phone
                // is sitting in the LOBBY waiting for a browser to send
                // a pairing request that the user must Accept. New copy
                // makes the gesture-required nature explicit (vs the
                // ambiguous pre-v18 "Waiting for browser").
                status.contains("Connected to relay") && browserCount == 0 ->
                    getString(R.string.pair_lobby_status) to ConnState.WAITING
                status.contains("Connected to relay") -> {
                    val copy = if (browserCount == 1)
                        getString(R.string.status_clients_connected_one)
                    else
                        getString(R.string.status_clients_connected_many, browserCount)
                    copy to ConnState.LIVE
                }
                status.contains("Waiting") ->
                    getString(R.string.pair_lobby_status) to ConnState.WAITING
                else ->
                    status to ConnState.IDLE
            }
            statusText.text = text
            setStatusVisual(conn)

            reconnectButton.visibility = View.GONE
            android.util.Log.d("MainActivity", "Status updated: ${statusText.text}")
        } else {
            reconnectButton.visibility = View.GONE
            statusText.text = getString(R.string.status_service_not_running)
            setStatusVisual(ConnState.IDLE)
            android.util.Log.d("MainActivity", "Status updated: Service not running")
        }
    }

    /**
     * Drive the status dot tint + glow ring to match the connection
     * state. Owns animation (pulse / shake) as a side effect.
     *
     * Round 7 contract: dot + glow ring carry the entire visual signal.
     *   LIVE       → emerald dot, steady soft-emerald ring at 0.6 alpha
     *                (the "lit indicator" — looks awake, not animated)
     *   WAITING    → amber dot, breathing amber ring (alpha pulse)
     *   CONNECTING → blue dot, breathing blue ring (alpha pulse)
     *   IDLE       → slate dot, ring hidden
     *   FAILED     → red dot, ring hidden; one-shot shake on first entry
     *
     * The pulse animator is cancelled before each transition so we
     * don't get drifting alpha when state changes mid-cycle. shake
     * is gated by [failedShakePlayed] so it only fires on the FIRST
     * transition into FAILED, not on every poll-loop repaint.
     */
    private fun setStatusVisual(state: ConnState) {
        // Cancel any in-flight ring pulse before we touch tint/alpha.
        statusPulseAnimator?.cancel()
        statusPulseAnimator = null

        val dotColorRes = when (state) {
            ConnState.LIVE -> R.color.dot_live
            ConnState.WAITING -> R.color.dot_waiting
            ConnState.IDLE -> R.color.dot_idle
            ConnState.CONNECTING -> R.color.dot_connecting
            ConnState.FAILED -> R.color.dot_failed
        }
        statusDot.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, dotColorRes))

        // Glow ring tint — use the *_soft (25% alpha) variant so it
        // sits behind the dot as a halo rather than a competing disc.
        val ringColorRes = when (state) {
            ConnState.LIVE -> R.color.dot_live_soft
            ConnState.WAITING -> R.color.dot_waiting_soft
            ConnState.CONNECTING -> R.color.dot_connecting_soft
            ConnState.IDLE, ConnState.FAILED -> R.color.dot_idle  // unused; ring is hidden
        }
        statusDotRing.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, ringColorRes))

        // Ring visibility + animation per-state.
        when (state) {
            ConnState.LIVE -> {
                // Steady halo. Held alpha — health is communicated by
                // presence, not motion.
                statusDotRing.alpha = 0.6f
            }
            ConnState.WAITING, ConnState.CONNECTING -> {
                // Breathing halo. 1500ms loop, ease-in-out.
                statusDotRing.alpha = 0.35f
                statusPulseAnimator = ValueAnimator.ofFloat(0.35f, 1.0f).apply {
                    duration = 1500
                    repeatCount = ValueAnimator.INFINITE
                    repeatMode = ValueAnimator.REVERSE
                    interpolator = AccelerateDecelerateInterpolator()
                    addUpdateListener { anim ->
                        statusDotRing.alpha = anim.animatedValue as Float
                    }
                    start()
                }
            }
            ConnState.IDLE -> {
                statusDotRing.alpha = 0f
            }
            ConnState.FAILED -> {
                statusDotRing.alpha = 0f
                if (!failedShakePlayed) {
                    failedShakePlayed = true
                    playFailedShake()
                }
            }
        }

        // Reset the shake suppression when we leave FAILED so the
        // *next* entry into FAILED gets its own one-shot animation.
        if (state != ConnState.FAILED) {
            failedShakePlayed = false
        }

        // Hidden stepNumber back-compat — kept so legacy refs compile.
        val stepLabel = when (state) {
            ConnState.LIVE -> R.string.step_03
            ConnState.WAITING -> R.string.step_02
            ConnState.IDLE, ConnState.FAILED -> R.string.step_01
            ConnState.CONNECTING -> R.string.step_02
        }
        stepNumber.setText(stepLabel)
        stepNumber.setTextColor(
            ContextCompat.getColor(
                this,
                if (state == ConnState.IDLE || state == ConnState.FAILED)
                    R.color.text_tertiary
                else
                    R.color.accent_blue
            )
        )
    }

    /**
     * Round 7 — FAILED state shake.
     *
     * Brief horizontal jitter on the whole status row (dot + label).
     * 4 oscillations over 320ms — short enough to read as "something
     * went wrong" without crossing into "buggy / glitching". Respects
     * the system animator-duration-scale: if the user has animations
     * disabled (Developer options → Animator duration scale = Off),
     * we skip the shake entirely. Otherwise translation animations
     * would no-op and we'd just freeze the view at a random offset.
     */
    private fun playFailedShake() {
        val animScale = try {
            Settings.Global.getFloat(
                contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
            )
        } catch (e: Exception) { 1f }
        if (animScale == 0f) return

        // Shake the parent row (dot FrameLayout + label) by walking up
        // from statusDot to its parent LinearLayout. Translating just
        // the dot would look like the indicator broke; translating the
        // row signals "alert".
        val row = statusDot.parent?.parent as? View ?: statusDot
        val shake = ObjectAnimator.ofFloat(
            row, "translationX",
            0f, -12f, 12f, -8f, 8f, -4f, 4f, 0f
        ).apply {
            duration = 320
            interpolator = AccelerateDecelerateInterpolator()
        }
        shake.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                // Hard-reset translation in case the animator was
                // cancelled mid-cycle (config-change, state churn).
                row.translationX = 0f
            }
        })
        shake.start()
    }

    /**
     * Round 4 — bridge from PhoneService.RelayPhase to MainActivity's
     * ConnState + the diagnostic text blocks.
     *
     * Runs on the main thread (the install site re-posts via Handler).
     * Owns three things:
     *   1. Mirror [latestRelayPhase] so the polling [updateStatus] loop
     *      can defer to phase truth when it matters (CONNECTING/FAILED).
     *   2. Translate phase → ConnState and call [setStatusVisual] +
     *      [statusText] copy that matches.
     *   3. Drive [renderConnectionDiagnostics] which handles the
     *      target-URL line + failure-reason line below the status row.
     */
    private fun handleRelayPhaseChanged(phase: PhoneService.RelayPhase) {
        android.util.Log.d("MainActivity", "Relay phase: $phase")
        latestRelayPhase = phase
        val service = phoneService
        val targetUrl = service?.lastRelayUrlAttempt
        val error = service?.lastConnectionError

        // Round 7 — the Refresh button no longer mirrors the relay
        // phase. In LAN-only mode there's no outbound relay socket, so
        // the phase callback effectively never fires with anything
        // interesting; if it does (e.g. an old leftover transition
        // during teardown) we don't want it stomping the Refresh label.
        // The button's enabled/text state is now owned by the click
        // handler (disabled → "Refreshing…" for 500ms, then re-enabled).
        //
        // Phase-keyed reasoning preserved as a comment for future
        // reference if a relay client ever returns:
        //   OPEN/CONNECTING → would disable; IDLE/FAILED → would enable.

        when (phase) {
            PhoneService.RelayPhase.CONNECTING -> {
                statusText.text = getString(R.string.status_connecting_relay)
                setStatusVisual(ConnState.CONNECTING)
                renderConnectionDiagnostics(phase, targetUrl, null)
            }
            PhoneService.RelayPhase.FAILED -> {
                val msg = mapConnectionError(error?.first ?: -1, error?.second, targetUrl)
                statusText.text = getString(R.string.status_failed_prefix)
                setStatusVisual(ConnState.FAILED)
                renderConnectionDiagnostics(phase, targetUrl, msg)
            }
            PhoneService.RelayPhase.OPEN -> {
                // Hand back to the polling loop — it knows whether a
                // browser is actually attached and will paint LIVE vs
                // WAITING accordingly. Hide the diagnostic lines.
                renderConnectionDiagnostics(phase, null, null)
                updateStatus()
            }
            PhoneService.RelayPhase.IDLE -> {
                renderConnectionDiagnostics(phase, null, null)
                updateStatus()
            }
        }
    }

    /**
     * Render the target-URL line + failure-reason line below the status
     * row. Both lines are GONE unless their content is non-null —
     * keeps the layout from leaving an empty 16dp gap when we're in
     * LIVE/WAITING/IDLE.
     *
     * The target line is shown for both CONNECTING and FAILED phases —
     * users debugging a failure need to see what was attempted just
     * as much as users watching a handshake in flight do.
     */
    private fun renderConnectionDiagnostics(
        phase: PhoneService.RelayPhase,
        targetUrl: String?,
        error: String?
    ) {
        val showTarget = (phase == PhoneService.RelayPhase.CONNECTING ||
            phase == PhoneService.RelayPhase.FAILED) && !targetUrl.isNullOrBlank()
        if (showTarget) {
            connectionTargetText.text = getString(
                R.string.status_target_prefix,
                maskTokenInUrl(targetUrl!!)
            )
            connectionTargetText.visibility = View.VISIBLE
        } else {
            connectionTargetText.visibility = View.GONE
        }

        if (!error.isNullOrBlank()) {
            connectionErrorText.text = error
            connectionErrorText.visibility = View.VISIBLE
        } else {
            connectionErrorText.visibility = View.GONE
        }
    }

    /**
     * Mask the `token=` query parameter in a relay URL to its first 12
     * characters, suffixed with `…`. The token is a 25-char cuid; 12
     * chars is enough to verify identity at a glance ("yep, that's
     * mine") without leaving the full secret visible on screen for
     * shoulder-surfing or screenshots.
     *
     * Falls back to the raw URL if the regex doesn't match (defensive —
     * the URL builder in PhoneService always emits `?token=`, but if a
     * future schema change drops the query string we don't want this
     * to throw).
     */
    private fun maskTokenInUrl(url: String): String {
        val regex = Regex("(token=)([^&]+)")
        return regex.replace(url) { m ->
            val full = m.groupValues[2]
            val visible = if (full.length > 12) full.substring(0, 12) + "…" else full
            "${m.groupValues[1]}$visible"
        }
    }

    /**
     * Map a relay close code + exception reason to actionable user
     * copy. The exception class names come from
     * java_websocket → PhoneClient.onError's reason format
     * ("${javaClass.simpleName}: ${message}"). Covered cases:
     *   - 4401: relay's invalid-token close. Tell the user to re-scan.
     *   - ConnectException: server not listening / refused.
     *   - SocketTimeoutException: TCP / handshake timeout.
     *   - UnknownHostException: DNS failed.
     *   - Anything else: surface the raw reason for the bug report.
     *
     * Host string is extracted from [targetUrl] (without token) so the
     * error copy can include it ("Couldn't reach the relay at ws://x").
     */
    private fun mapConnectionError(code: Int, reason: String?, targetUrl: String?): String {
        val hostForCopy = targetUrl
            ?.substringBefore('?', missingDelimiterValue = targetUrl)
            ?.substringBefore("/phone", missingDelimiterValue = targetUrl)
            ?: "the relay"
        // Relay's invalid-token close. 4401 is the policy code emitted
        // by the Forge relay patch when token verification fails.
        if (code == 4401) {
            return getString(R.string.status_failed_invalid_token)
        }
        val r = reason.orEmpty()
        return when {
            r.contains("ConnectException", ignoreCase = true) ||
                r.contains("Connection refused", ignoreCase = true) ->
                getString(R.string.status_failed_refused, hostForCopy)
            // Client-side 10s watchdog timeout (PhoneService.connectToRelay
            // schedules this when the WS handshake never completes). Tagged
            // with the literal "connect_timeout" so this branch wins over
            // the generic "timed out" / SocketTimeoutException one below
            // and we can surface the more actionable WiFi/firewall hint.
            r.contains("connect_timeout", ignoreCase = true) ->
                getString(R.string.error_connect_timeout)
            r.contains("SocketTimeoutException", ignoreCase = true) ||
                r.contains("timed out", ignoreCase = true) ->
                getString(R.string.status_failed_timeout)
            r.contains("UnknownHostException", ignoreCase = true) ->
                getString(R.string.status_failed_unknown_host, hostForCopy)
            r.isBlank() && code > 0 ->
                getString(R.string.status_failed_generic, "close code $code")
            else ->
                getString(R.string.status_failed_generic, reason ?: "unknown")
        }
    }

    // Dispatch #29 — generateQRCode() removed. The LAN-IP QR plate that
    // it rendered is gone from activity_main.xml; the webapp now pairs by
    // authenticated cookie + phoneToken via the SaaS relay, not by
    // scanning a per-phone WS URL. zxing imports stripped at the top of
    // the file. If we ever want a QR for a different surface again,
    // resurrect from git history (last live revision: 32d0a44).

    private fun startStatusUpdates() {
        statusUpdateRunnable = object : Runnable {
            override fun run() {
                updateStatus()
                handler.postDelayed(this, 2000) // Update every 2 seconds
            }
        }
        handler.post(statusUpdateRunnable!!)
    }
    
    private fun stopStatusUpdates() {
        statusUpdateRunnable?.let { handler.removeCallbacks(it) }
        statusUpdateRunnable = null
    }

    override fun onResume() {
        super.onResume()
        android.util.Log.d("MainActivity", "onResume called")

        // v18 — register the pairing-foreground broadcast receiver so
        // we can surface the Accept/Decline AlertDialog while the
        // Activity is visible. Notification path stays primary (always
        // posts) — the dialog is the additional in-foreground affordance
        // so the user doesn't have to dive into the shade.
        registerPairingForegroundReceiver()

        // Samsung One UI auto-revoke defense — re-check on EVERY resume.
        // This catches two cases:
        //   1. User opened the app, was shown the permissions pane, went
        //      to Settings to grant something, and returned. onResume
        //      fires; if the list is now empty we transition to main.
        //   2. App was already on the main pane, user backgrounded it,
        //      Android revoked a permission while we were gone, user
        //      brings the app back. We catch the revocation here and
        //      switch INTO the permissions pane before they can interact.
        //
        // This is the load-bearing piece of the auto-revoke defense — it's
        // why the user gets caught immediately instead of silently failing
        // when they try to use the app days/weeks later.
        val missing = PermissionChecker.checkAll(this)
        if (missing.isNotEmpty()) {
            android.util.Log.d("MainActivity", "onResume: ${missing.size} permissions missing")
            if (!inPermissionsRequiredPane) {
                // We were on the main pane — Android revoked something
                // in the background. Tear down the service-bound state
                // and switch to the blocking pane.
                handleRevocationMidSession()
            }
            renderPermissionsRequiredPane(missing)

            // Round 8 — if a Grant All flow is in progress and we're
            // back from a Settings deep-link, advance to the next step.
            // continueGrantAllFlow re-audits, re-renders, and either
            // shows the next dialog (special-access still missing) or
            // plays the success animation (everything resolved during
            // this trip to Settings — handled inside continueGrantAllFlow).
            if (grantAllInProgress && !awaitingRuntimeResultForGrantAll) {
                continueGrantAllFlow()
            }
            return
        }

        // All permissions granted. If we were on the permissions pane,
        // play the success animation, then initialize the main pane.
        // Otherwise (already on main pane), continue with the normal
        // onResume flow that was here before.
        if (inPermissionsRequiredPane) {
            android.util.Log.d("MainActivity", "onResume: all permissions granted — playing success animation")
            grantAllInProgress = false
            playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            return
        }

        runMainPaneOnResume()
    }

    /**
     * The pre-existing onResume body, extracted so it can be invoked
     * either directly (when we resume into the main pane) or deferred
     * (after the success animation transitions us out of the
     * permissions pane).
     *
     * Defensive guard: the lateinit views below assume the main pane
     * layout is current. If we're called while the permissions pane is
     * still up (shouldn't happen, but Android lifecycle reordering on
     * config-change has surprised us before), bail rather than NPE.
     */
    private fun runMainPaneOnResume() {
        if (inPermissionsRequiredPane || !mainPaneInitialized) {
            android.util.Log.w("MainActivity", "runMainPaneOnResume called while not on main pane — skipping")
            return
        }
        // Check notification status on resume (user might have changed it in settings)
        checkNotificationStatus()

        // Check if user granted battery optimization exemption.
        // Dispatch #9: userStopped gating removed (see field-site tombstone).
        // The single-button "Disconnect and refresh" UX never leaves the
        // service intentionally down, so onResume can always auto-restart.
        if (hasPermissions() && isBatteryOptimizationDisabled() && !serviceBound) {
            android.util.Log.d("MainActivity", "Battery exemption granted, starting service")
            statusText.text = getString(R.string.status_starting)
            startPhoneService()
        }

        // Try to rebind to service if it's running. Dispatch #9: no
        // userStopped gate — see above.
        if (!serviceBound) {
            val intent = Intent(this, PhoneService::class.java)
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }

        // Always update status when resuming
        updateStatus()
    }

    /**
     * Handle the "user revoked a permission while the app was in the
     * background" case. PhoneService can't function without its
     * permissions, so we tear down the binding + stop the status loop
     * before switching panes. The service itself will SIGSEGV / throw
     * SecurityException the next time it tries to read a revoked
     * surface (CallLog, SMS), so stopping it here is the responsible
     * thing — we'll restart it cleanly once the user re-grants.
     */
    private fun handleRevocationMidSession() {
        android.util.Log.w("MainActivity", "Detected permission revocation mid-session — tearing down service")
        stopStatusUpdates()
        if (serviceBound) {
            try {
                unbindService(serviceConnection)
            } catch (e: Exception) {
                android.util.Log.w("MainActivity", "unbindService threw on revocation teardown: ${e.message}")
            }
            serviceBound = false
        }
        // Stop the foreground service so it can't keep throwing on the
        // revoked permission. It'll be restarted by the normal auto-start
        // flow once the user re-grants and we transition back to the
        // main pane.
        try {
            val stopIntent = Intent(this, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            stopService(stopIntent)
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "stopService threw on revocation teardown: ${e.message}")
        }
        phoneService = null
        // Force the main pane to re-initialize next time we transition
        // into it — otherwise mainPaneInitialized=true would short-circuit
        // initializeMainPane() and leave the service unbound.
        mainPaneInitialized = false
    }

    /**
     * Inflate / refresh the permissions-required pane (Round 8 — Grant
     * All flow). Idempotent — safe to call repeatedly.
     *
     * The pane is now a single primary CTA ("Grant All Permissions") plus
     * an expandable detail panel for the curious. The CTA fires the
     * OS-native runtime-permission popup batched across every missing
     * RUNTIME permission, then walks the user through any remaining
     * SPECIAL grants (Notification Listener, Battery optimization) via
     * Settings deep-links.
     *
     * Side effect: sets [inPermissionsRequiredPane] to true.
     */
    private fun renderPermissionsRequiredPane(missing: List<PermissionChecker.MissingPermission>) {
        if (!inPermissionsRequiredPane) {
            setContentView(R.layout.activity_permissions_required)
            inPermissionsRequiredPane = true
        }

        // Partition the audit by kind. Runtime permissions go in one
        // batch via ActivityCompat.requestPermissions; special-access
        // grants are walked sequentially via Settings deep-links.
        val runtimeMissing = missing.filter { it.kind == PermissionChecker.Kind.RUNTIME }
        val specialMissing = missing.filter { it.kind == PermissionChecker.Kind.SPECIAL }

        // v18 — render the live status checklist. Replaces the
        // collapsible per-Kind detail panel from rounds 6-8. Every
        // permission is shown with its current status (granted/missing-
        // required/missing-soft) so the user can SEE progress as they
        // grant things.
        val checklistList: LinearLayout = findViewById(R.id.permsChecklistList)
        val statusItems = PermissionChecker.checkAllWithStatus(this)
        renderChecklist(checklistList, statusItems)

        // Primary CTA — Grant All. Kicks off the full sequence.
        val grantAllButton: Button = findViewById(R.id.permsGrantAllButton)
        grantAllButton.setOnClickListener {
            startGrantAllFlow(runtimeMissing, specialMissing)
        }

        // v18 — Continue button. Enabled iff every REQUIRED permission
        // is GRANTED. SOFT misses are tolerated (the user can grant
        // them later from app settings; reliability may degrade but
        // the core flow works). Disabled state mutes opacity so the
        // user can SEE it's not actionable yet without it disappearing.
        val continueButton: Button = findViewById(R.id.permsContinueButton)
        val anyRequiredMissing = statusItems.any {
            it.status == PermissionChecker.Status.MISSING_REQUIRED
        }
        continueButton.isEnabled = !anyRequiredMissing
        continueButton.alpha = if (anyRequiredMissing) 0.4f else 1.0f
        continueButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Continue tapped — required permissions satisfied")
            grantAllInProgress = false
            playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
        }

        // "I've granted everything — re-check" button.
        //
        // Dispatch #29 fix — Dennis testing v16 on Samsung One UI got
        // stuck on this pane even after granting every visible permission:
        // PermissionChecker.checkAll() kept returning a non-empty list
        // because one or more SPECIAL entries (auto_revoke whitelist,
        // battery optimization toast that requires re-tap on each launch)
        // never resolve cleanly on this OEM. The audit was correct but
        // the pane became a dead-end with no escape.
        //
        // Fix: split the result by Kind.
        //   - RUNTIME entries still missing → real blockers (CALL_PHONE,
        //     READ_PHONE_STATE, etc. — the service would crash without
        //     these). Stay on the pane and re-render.
        //   - Only SPECIAL entries still missing → soft / reliability
        //     warnings. Allow the user to advance to the main pane with
        //     a one-line toast acknowledging the trade-off. They can
        //     revisit from app settings later if reliability suffers.
        //   - List empty → happy path, success animation + transition.
        findViewById<Button>(R.id.permsRefreshButton).setOnClickListener {
            android.util.Log.d("MainActivity", "Refresh tapped — re-checking permissions")
            val now = PermissionChecker.checkAll(this)
            val stillRuntimeMissing = now.any { it.kind == PermissionChecker.Kind.RUNTIME }

            if (now.isEmpty()) {
                grantAllInProgress = false
                playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            } else if (!stillRuntimeMissing) {
                // Only soft (SPECIAL) entries remain — let the user through.
                android.util.Log.d(
                    "MainActivity",
                    "Refresh: only SPECIAL permissions missing (${now.map { it.id }}) — allowing user to continue"
                )
                grantAllInProgress = false
                Toast.makeText(
                    this,
                    R.string.perms_continue_anyway_hint,
                    Toast.LENGTH_LONG
                ).show()
                playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            } else {
                // Real blockers still missing — re-render and keep them here.
                android.util.Log.d(
                    "MainActivity",
                    "Refresh: RUNTIME permissions still missing — staying on pane"
                )
                renderPermissionsRequiredPane(now)
            }
        }
    }

    /**
     * v18 — render the live permissions checklist into the container.
     * One row per permission; status drives the icon tint + badge color
     * + badge label so the user can scan the list at a glance and see
     * what's done vs what isn't.
     *
     * Tint mapping (matches the status-dot vocabulary used elsewhere
     * in the app — emerald = healthy, red = blocker, amber = warning):
     *   GRANTED          → dot_live   (✓ green)
     *   MISSING_REQUIRED → dot_failed (✗ red)
     *   MISSING_SOFT     → dot_waiting (⚠ amber)
     */
    private fun renderChecklist(
        container: LinearLayout,
        items: List<PermissionChecker.PermissionStatusItem>
    ) {
        container.removeAllViews()
        val inflater = LayoutInflater.from(this)
        for (item in items) {
            val row = inflater.inflate(R.layout.item_permission_status, container, false)
            row.findViewById<TextView>(R.id.permTitle).text = item.displayName
            row.findViewById<TextView>(R.id.permWhy).text = item.why

            val (colorRes, badgeRes) = when (item.status) {
                PermissionChecker.Status.GRANTED ->
                    R.color.dot_live to R.string.perm_status_granted
                PermissionChecker.Status.MISSING_REQUIRED ->
                    R.color.dot_failed to R.string.perm_status_missing_required
                PermissionChecker.Status.MISSING_SOFT ->
                    R.color.dot_waiting to R.string.perm_status_missing_soft
            }
            val color = ContextCompat.getColor(this, colorRes)
            row.findViewById<View>(R.id.permStatusIcon).backgroundTintList =
                ColorStateList.valueOf(color)
            val badge: TextView = row.findViewById(R.id.permStatusBadge)
            badge.text = getString(badgeRes)
            badge.setTextColor(color)

            // Tap a missing row to deep-link straight into the relevant
            // grant surface. Granted rows are non-interactive. Helpful
            // for the user who wants to fix just one thing instead of
            // running the full Grant All flow.
            val tapTarget = item.intent
            if (tapTarget != null) {
                row.setOnClickListener {
                    try {
                        startActivity(tapTarget)
                    } catch (e: Exception) {
                        android.util.Log.w(
                            "MainActivity",
                            "Per-row tap intent failed for ${item.id}: ${e.message}"
                        )
                    }
                }
            } else {
                row.setOnClickListener(null)
                row.isClickable = false
            }

            container.addView(row)
        }
    }

    /**
     * Round 8 — Grant All flow entry point.
     *
     * Sequence:
     *   1. Fire ActivityCompat.requestPermissions with every missing
     *      runtime permission batched into one call. Android dispatches
     *      them as a back-to-back sequence of native popups under a
     *      single result callback.
     *   2. When the callback fires, [continueGrantAllFlow] re-audits
     *      and either:
     *        a. Walks the user through remaining SPECIAL grants via a
     *           confirmation dialog + Settings deep-links.
     *        b. Plays the success animation if everything's resolved.
     *        c. Re-renders the pane with whatever still needs attention.
     *
     * If there are NO runtime permissions to request (already granted —
     * the user came back to grant the special ones), we skip straight
     * to [continueGrantAllFlow] so they don't see a no-op popup.
     */
    private fun startGrantAllFlow(
        runtimeMissing: List<PermissionChecker.MissingPermission>,
        specialMissing: List<PermissionChecker.MissingPermission>
    ) {
        android.util.Log.d(
            "MainActivity",
            "Grant All tapped — runtime=${runtimeMissing.size}, special=${specialMissing.size}"
        )
        grantAllInProgress = true

        val runtimeArr = runtimeMissing
            .mapNotNull { it.manifestPermission }
            .toTypedArray()

        if (runtimeArr.isEmpty()) {
            // Nothing to batch — straight into special-access dialogs.
            continueGrantAllFlow()
            return
        }

        awaitingRuntimeResultForGrantAll = true
        ActivityCompat.requestPermissions(this, runtimeArr, REQ_GRANT_ALL_RUNTIME)
    }

    /**
     * Step 2 of the Grant All flow — runs after the runtime popup batch
     * has returned (or if there were no runtime permissions to batch).
     *
     * Re-audits everything and decides the next step:
     *   - Audit empty: play success animation, transition to main pane.
     *   - Only special-access remaining: show the confirmation dialog +
     *     route the user to the first Settings screen. onResume detects
     *     when they come back and re-enters this method.
     *   - Mixed remaining (some runtime were denied): re-render the pane.
     *     This typically means the user tapped "Don't allow" on one of
     *     the runtime popups — the OS won't show it again, so the user
     *     needs to go to Settings → Apps → ComputerCaller → Permissions.
     *     We push them there via the special-access flow.
     */
    private fun continueGrantAllFlow() {
        val now = PermissionChecker.checkAll(this)
        if (now.isEmpty()) {
            android.util.Log.d("MainActivity", "Grant All complete — all permissions resolved")
            grantAllInProgress = false
            playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            return
        }

        val remainingRuntime = now.filter { it.kind == PermissionChecker.Kind.RUNTIME }
        val remainingSpecial = now.filter { it.kind == PermissionChecker.Kind.SPECIAL }

        // If runtime entries are still missing here, the user denied them
        // in the popup (and possibly tapped "Don't ask again"). The OS
        // popup can't be re-shown for "Don't ask again" entries, so the
        // only path forward is App Settings. Drop them there with a
        // dialog explaining why.
        if (remainingRuntime.isNotEmpty()) {
            android.util.Log.d(
                "MainActivity",
                "Grant All — runtime still missing: ${remainingRuntime.map { it.id }}"
            )
            // Re-render to show the new (smaller) list, so the user can
            // see progress. The Refresh button below the CTA lets them
            // re-tick the audit after fixing.
            renderPermissionsRequiredPane(now)
            // Send them to the app-details Settings screen so they can
            // manually re-grant the denied runtime perms. We use the
            // same dialog UI as the special-access flow for consistency.
            promptForRemainingGrants(remainingRuntime, remainingSpecial)
            return
        }

        // Only SPECIAL grants left — the normal happy path of the flow.
        if (remainingSpecial.isNotEmpty()) {
            android.util.Log.d(
                "MainActivity",
                "Grant All — special access still missing: ${remainingSpecial.map { it.id }}"
            )
            renderPermissionsRequiredPane(now)
            promptForRemainingGrants(emptyList(), remainingSpecial)
        }
    }

    /**
     * Show the single explanatory dialog before routing the user to
     * Settings. Covers three message variants:
     *   - Both special-access grants missing → "Two more to go..."
     *   - Only Notification Listener missing → "Notification Access..."
     *   - Only Battery optimization missing → "Battery (Don't optimize)..."
     *
     * "Take me there" launches the first remaining grant intent.
     * onResume detects when the user comes back and either fires the
     * next dialog (if the previous one resolved) or re-renders the pane.
     *
     * If [remainingRuntime] is non-empty (denied/"Don't ask again" case),
     * the first stop is App Settings; remainingSpecial entries are
     * queued behind it.
     */
    private fun promptForRemainingGrants(
        remainingRuntime: List<PermissionChecker.MissingPermission>,
        remainingSpecial: List<PermissionChecker.MissingPermission>
    ) {
        val hasListener = remainingSpecial.any { it.id == "notification_listener" }
        val hasBattery = remainingSpecial.any { it.id == "battery_optimization" }

        val messageRes = when {
            // Runtime denied — message focuses on the Settings hand-off.
            // We reuse the "both" copy because it's the most descriptive
            // ("tap each one when prompted") and matches what the user
            // will see if both runtime + special are mixed.
            remainingRuntime.isNotEmpty() -> R.string.perms_special_dialog_message_both
            hasListener && hasBattery -> R.string.perms_special_dialog_message_both
            hasListener -> R.string.perms_special_dialog_message_listener
            hasBattery -> R.string.perms_special_dialog_message_battery
            else -> return // nothing to prompt for
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.perms_special_dialog_title)
            .setMessage(messageRes)
            .setPositiveButton(R.string.perms_special_dialog_action) { dialog, _ ->
                dialog.dismiss()
                launchNextGrantIntent(remainingRuntime, remainingSpecial)
            }
            .setNegativeButton(R.string.perms_special_dialog_cancel) { dialog, _ ->
                grantAllInProgress = false
                dialog.dismiss()
            }
            .setCancelable(true)
            .setOnCancelListener { grantAllInProgress = false }
            .show()
    }

    /**
     * Launch the first available grant intent in priority order:
     *   1. App settings (if any runtime perms are stuck on "Don't ask again")
     *   2. Notification Listener settings
     *   3. Battery optimization request
     *
     * onResume re-audits and re-enters [continueGrantAllFlow] when the
     * user returns, so this method is one-shot — it never tries to
     * chain calls internally. The chain is driven by user navigation
     * (back from Settings → onResume → next step).
     */
    private fun launchNextGrantIntent(
        remainingRuntime: List<PermissionChecker.MissingPermission>,
        remainingSpecial: List<PermissionChecker.MissingPermission>
    ) {
        val intent = when {
            remainingRuntime.isNotEmpty() -> remainingRuntime.first().intent
            else -> remainingSpecial.firstOrNull()?.intent
        } ?: return

        try {
            startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed to launch grant intent", e)
            // Fallback: app-details Settings is universally resolvable.
            try {
                val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(fallback)
            } catch (_: Exception) {
                // Genuinely nothing we can do — at least keep the flow
                // state sane so the next Refresh tap works.
                grantAllInProgress = false
            }
        }
    }

    /**
     * Brief "All set" beat before the main pane appears. Fades the
     * success overlay in (240ms), holds (320ms), fades out (240ms) —
     * total ~800ms. Honors prefers-reduced-motion via the system
     * animator duration scale; if the user has animations disabled
     * (Settings → Developer options → Animator duration scale = Off),
     * the overlay is shown without animation and dismissed after the
     * hold beat, so the success state still registers.
     *
     * Calls [onComplete] on the main thread once the overlay is fully
     * gone. The caller is responsible for swapping setContentView.
     */
    private fun playSuccessAnimationThen(onComplete: () -> Unit) {
        val overlay: View = findViewById(R.id.permsSuccessOverlay)
        overlay.visibility = View.VISIBLE
        overlay.alpha = 0f

        val animScale = try {
            Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        } catch (e: Exception) { 1f }

        if (animScale == 0f) {
            // Reduced motion: show + hold + hide without easing.
            overlay.alpha = 1f
            handler.postDelayed({
                overlay.visibility = View.GONE
                onComplete()
            }, 600)
            return
        }

        overlay.animate()
            .alpha(1f)
            .setDuration(240)
            .withEndAction {
                handler.postDelayed({
                    overlay.animate()
                        .alpha(0f)
                        .setDuration(240)
                        .withEndAction {
                            overlay.visibility = View.GONE
                            onComplete()
                        }
                        .start()
                }, 320)
            }
            .start()
    }

    /**
     * Dispatch #29 — Sign Out confirmation.
     *
     * Replaces the dispatch #6/#9/#23 "Disconnect and refresh" button
     * since there's no LAN listener left to refresh. Sign Out is what
     * the user actually wants when they're done with a session.
     *
     * Two-step confirmation (Cancel / Sign out) so an accidental tap
     * doesn't drop the bridge mid-call.
     */
    private fun showSignOutConfirmation() {
        AlertDialog.Builder(this)
            .setTitle(R.string.signout_dialog_title)
            .setMessage(R.string.signout_dialog_message)
            .setNegativeButton(R.string.signout_dialog_cancel) { d, _ -> d.dismiss() }
            .setPositiveButton(R.string.signout_dialog_confirm) { d, _ ->
                d.dismiss()
                performSignOut()
            }
            .setCancelable(true)
            .show()
    }

    /**
     * Dispatch #29 — Sign Out implementation.
     *
     * Steps:
     *   1. Stop the foreground service (ACTION_STOP → onDestroy → relay
     *      WebSocket close 1000 → the browser side sees the phone
     *      disconnect cleanly).
     *   2. Unbind locally so we don't leak the ServiceConnection.
     *   3. Clear the stored phoneToken so the next launch lands on the
     *      Sign In screen (MainActivity.onCreate's TokenStore.hasToken
     *      gate kicks).
     *   4. Launch SignInActivity with FLAG_ACTIVITY_NEW_TASK +
     *      FLAG_ACTIVITY_CLEAR_TASK so the back button from the new
     *      SignIn screen can't return to this half-signed-out activity.
     *   5. finish() — defensive; the CLEAR_TASK above already kills
     *      this instance, but we want to make damn sure we don't
     *      linger.
     */
    private fun performSignOut() {
        android.util.Log.d("MainActivity", "Sign out confirmed")
        Toast.makeText(this, R.string.action_sign_out, Toast.LENGTH_SHORT).show()

        // 1+2. Stop + unbind service.
        try {
            val stopIntent = Intent(this, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            stopService(stopIntent)
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "stopService threw during sign-out: ${e.message}")
        }
        try {
            if (serviceBound) {
                unbindService(serviceConnection)
                serviceBound = false
            }
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "unbindService threw during sign-out: ${e.message}")
        }
        phoneService = null
        stopStatusUpdates()

        // 3. Wipe the stored phoneToken.
        try {
            TokenStore.clear(this)
            android.util.Log.d("MainActivity", "TokenStore cleared")
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "TokenStore.clear threw — proceeding to SignIn anyway", e)
        }

        // 4+5. Hand off to SignInActivity and finish.
        val signInIntent = Intent(this, SignInActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        startActivity(signInIntent)
        finish()
    }

    /**
     * Hard Reset confirmation dialog. Shown before any destructive
     * action so accidental taps don't nuke the user's setup. The
     * positive action ("Reset") is restyled red after the dialog
     * shows — AlertDialog doesn't expose a "destructive" style via
     * the builder API, but tinting the positive button text post-show
     * gives the same visual signal.
     */
    private fun showHardResetConfirmation() {
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.hard_reset_dialog_title)
            .setMessage(R.string.hard_reset_dialog_message)
            .setNegativeButton(R.string.hard_reset_dialog_cancel) { d, _ -> d.dismiss() }
            .setPositiveButton(R.string.hard_reset_dialog_confirm) { d, _ ->
                d.dismiss()
                performHardReset()
            }
            .setCancelable(true)
            .create()

        dialog.setOnShowListener {
            // Tint the positive button red to signal destructive action.
            // Cancel stays in the default secondary color so the user's
            // eye lands on it first — the safer choice.
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(
                ContextCompat.getColor(this, R.color.dot_failed)
            )
        }
        dialog.show()
    }

    /**
     * Hard Reset implementation. Uses ActivityManager.clearApplicationUserData()
     * — the OS-level equivalent of Settings → Apps → ComputerCaller →
     * Storage → Clear data. On success:
     *   - All app SharedPreferences, databases, cache, files are wiped.
     *   - On Android 13+ the OS revokes runtime permissions back to their
     *     default-denied state (matching what a fresh install looks like),
     *     so the user re-enters the Grant All flow on next launch.
     *   - The process is force-killed by the OS as part of the call; the
     *     OS will restart the launcher activity on next user tap.
     *
     * We stop our foreground service first so it can't outlive the clear
     * and re-bind to a half-wiped state. The call itself returns true
     * on success; if it returns false (rare — usually means the app is
     * being debugged or is the device-owner) we surface a toast pointing
     * the user at the manual Settings path.
     */
    private fun performHardReset() {
        android.util.Log.w("MainActivity", "Hard Reset confirmed — clearing user data")
        Toast.makeText(this, R.string.action_hard_reset, Toast.LENGTH_SHORT).show()

        // Tear down the service cleanly before the wipe. The OS will kill
        // the process anyway, but doing it explicitly means a foreground
        // notification doesn't linger for the half-second between Toast
        // and process-kill.
        try {
            if (serviceBound) {
                unbindService(serviceConnection)
                serviceBound = false
            }
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "unbindService failed during Hard Reset: ${e.message}")
        }
        try {
            val stopIntent = Intent(this, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            stopService(stopIntent)
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "stopService failed during Hard Reset: ${e.message}")
        }
        phoneService = null
        stopStatusUpdates()

        // Fire the wipe. The OS kills our process partway through this
        // call, so any code after the `if` block here is best-effort and
        // may not execute. If clearApplicationUserData() returns false,
        // we're still alive — show the manual-recovery toast.
        val ok = try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            am.clearApplicationUserData()
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "clearApplicationUserData threw", e)
            false
        }

        if (!ok) {
            Toast.makeText(this, R.string.hard_reset_failed, Toast.LENGTH_LONG).show()
            // Last-resort fallback — open app-details Settings so the
            // user can clear data manually.
            try {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(intent)
            } catch (e: Exception) {
                android.util.Log.e("MainActivity", "Couldn't open app-details after Hard Reset failure", e)
            }
        }
        // No `finish()` / `startActivity()` here on the success path —
        // clearApplicationUserData() kills our process. On next launch
        // the OS reads the (now empty) permission state, MainActivity.
        // onCreate runs PermissionChecker.checkAll(), finds everything
        // missing, and routes the user into the Grant All pane.
    }

    override fun onPause() {
        super.onPause()
        // v18 — unregister the pairing-foreground receiver and dismiss
        // any visible AlertDialog so a paused Activity can't leak a
        // window token (BadTokenException on the next show). The
        // notification path is still live — if the user backgrounds
        // mid-prompt they get the heads-up + shade entry as usual.
        unregisterPairingForegroundReceiver()
        pairingRequestDialog?.dismiss()
        pairingRequestDialog = null
        pairingRequestDialogId = null
    }

    /**
     * v18 — register [pairingForegroundReceiver] with
     * RECEIVER_NOT_EXPORTED on API 33+ so no other app can spoof
     * pairing intents into our UI. Idempotent — guarded by
     * [pairingReceiverRegistered].
     */
    private fun registerPairingForegroundReceiver() {
        if (pairingReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(PhoneService.ACTION_PAIRING_REQUEST_IN_FOREGROUND)
            addAction(PhoneService.ACTION_PAIRING_CANCELLED_IN_FOREGROUND)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(pairingForegroundReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(pairingForegroundReceiver, filter)
        }
        pairingReceiverRegistered = true
        android.util.Log.d("MainActivity", "Pairing-foreground receiver registered")
    }

    /**
     * v18 — paired with [registerPairingForegroundReceiver]. Safe to
     * call when not registered.
     */
    private fun unregisterPairingForegroundReceiver() {
        if (!pairingReceiverRegistered) return
        try {
            unregisterReceiver(pairingForegroundReceiver)
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "unregisterPairingForegroundReceiver threw: ${e.message}")
        }
        pairingReceiverRegistered = false
    }

    /**
     * v18 — show the Accept/Decline AlertDialog for an incoming
     * PAIRING_REQUEST. If a dialog is already visible for a different
     * pairingId we replace it (later request wins — defensive; the
     * relay shouldn't issue concurrent requests for the same phone but
     * we shouldn't trust it). If the same id is already showing we
     * leave it alone — re-broadcast on resume is the typical cause.
     *
     * Both buttons dispatch the SAME broadcast that the notification
     * action buttons use ([ConnectionRequestReceiver.ACTION_ACCEPT_CONNECTION]
     * / [ACTION_DECLINE_CONNECTION]) so both paths converge in
     * [PhoneService.handleConnectionDecision]. This avoids any
     * "dialog said Accept but the notification handler also fired
     * Decline due to a race" class of bug.
     */
    private fun showPairingRequestDialog(pairingId: String, identity: String) {
        if (isFinishing || isDestroyed) {
            android.util.Log.d("MainActivity", "showPairingRequestDialog: activity gone, skipping")
            return
        }
        if (pairingRequestDialogId == pairingId && pairingRequestDialog?.isShowing == true) {
            android.util.Log.d("MainActivity", "showPairingRequestDialog: already showing for $pairingId")
            return
        }
        pairingRequestDialog?.dismiss()

        val message = getString(R.string.pair_request_body_template, identity)
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.pair_request_title)
            .setMessage(message)
            .setPositiveButton(R.string.pair_accept) { d, _ ->
                d.dismiss()
                dispatchPairingDecision(pairingId, accept = true)
            }
            .setNegativeButton(R.string.pair_decline) { d, _ ->
                d.dismiss()
                dispatchPairingDecision(pairingId, accept = false)
            }
            // Cancelable=false so a stray back-tap mid-prompt doesn't
            // leave the relay hanging. User MUST choose. The 30s
            // auto-decline timer in PhoneService is the safety net if
            // they ignore it entirely.
            .setCancelable(false)
            .create()
        pairingRequestDialog = dialog
        pairingRequestDialogId = pairingId
        dialog.setOnDismissListener {
            // Clear refs once the dialog leaves the screen. The decision
            // dispatcher above runs BEFORE this listener fires.
            if (pairingRequestDialog === dialog) {
                pairingRequestDialog = null
                pairingRequestDialogId = null
            }
        }
        dialog.show()
        android.util.Log.d("MainActivity", "Pairing dialog shown for $pairingId")
    }

    /**
     * Convergence helper — dispatch the same broadcast the notification
     * action buttons use so both Accept/Decline paths land in
     * [PhoneService.handleConnectionDecision].
     */
    private fun dispatchPairingDecision(pairingId: String, accept: Boolean) {
        val action = if (accept)
            ConnectionRequestReceiver.ACTION_ACCEPT_CONNECTION
        else
            ConnectionRequestReceiver.ACTION_DECLINE_CONNECTION
        val intent = Intent(action).apply {
            setPackage(packageName)
            putExtra(ConnectionRequestReceiver.EXTRA_REQUEST_ID, pairingId)
        }
        sendBroadcast(intent)
        android.util.Log.d("MainActivity", "Dispatched $action for $pairingId")
    }

    /**
     * Dismiss the in-foreground AlertDialog when PAIRING_CANCELLED
     * arrives for the visible request. No-op if the visible id doesn't
     * match (defensive — concurrent requests should not happen).
     */
    private fun dismissPairingDialogIfMatching(pairingId: String) {
        if (pairingRequestDialogId == pairingId) {
            android.util.Log.d("MainActivity", "Dismissing pairing dialog for cancelled $pairingId")
            pairingRequestDialog?.dismiss()
            pairingRequestDialog = null
            pairingRequestDialogId = null
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopStatusUpdates()
        // Drop the pulse animator so its update listener can't fire
        // on a destroyed view (no observed leak, but the listener
        // holds a strong ref to statusDotRing).
        statusPulseAnimator?.cancel()
        statusPulseAnimator = null
        // v18 — drop any stray pairing-dialog refs and the receiver
        // registration (onPause should have done this already; defensive).
        pairingRequestDialog?.dismiss()
        pairingRequestDialog = null
        pairingRequestDialogId = null
        unregisterPairingForegroundReceiver()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

}
