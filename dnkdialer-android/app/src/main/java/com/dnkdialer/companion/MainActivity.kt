package com.dnkdialer.companion

import android.Manifest
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.content.res.ColorStateList
import android.widget.Toast
import com.dnkdialer.companion.R
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

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
    private lateinit var ipText: TextView
    private lateinit var qrCodeImage: ImageView
    private lateinit var enableNotificationsButton: Button

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

    /**
     * Detail panel expanded/collapsed state. Persisted across pane
     * re-renders within the same Activity instance so the user doesn't
     * lose their "expanded" view if Android revokes another permission
     * mid-grant.
     */
    private var permsDetailsExpanded: Boolean = false

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
        ipText = findViewById(R.id.ipText)
        qrCodeImage = findViewById(R.id.qrCodeImage)
        enableNotificationsButton = findViewById(R.id.enable_notifications_button)
        reconnectButton = findViewById(R.id.reconnectButton)

        // Diagnostic surface for LAN reconnect attempts that hang or fail.
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

        // Copy IP button - copies the displayed IP/URL to clipboard
        val copyIpButton: Button = findViewById(R.id.copyIpButton)
        copyIpButton.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val clip = android.content.ClipData.newPlainText("Phone IP", ipText.text.toString())
            clipboard.setPrimaryClip(clip)
            Toast.makeText(this, R.string.toast_copied, Toast.LENGTH_SHORT).show()
        }

        // Dispatch #9: reconnectButton click handler REMOVED.
        // The widget is forced GONE in initializeMainPane() above and in
        // every updateStatus() branch below. With no surface, no handler.
        // (See field-site tombstone for `userStopped` above for the
        // full lineage.)

        // "Disconnect and refresh" button (dispatch #9, 2026-05-22).
        // Single-button replacement for the dispatch #6 dual-button UX
        // (Start partner + Disconnect-and-stop). One tap:
        //   1. Politely close active LAN clients (DISCONNECT_PHONE frame
        //      → close 1000 → browser sees a clean teardown, no TCP
        //      timeout reaper).
        //   2. stopService → PhoneService.stopSelf → onDestroy →
        //      server.stop() (port 8765 released, notification cleared).
        //   3. 800 ms postDelayed → startPhoneService() — gives the OS
        //      time to fully release the port before we re-bind it.
        //      Race-condition guard: if the user mashes the button mid-
        //      restart, the second tap finds serviceBound==false and
        //      phoneService==null (set in this handler), so the polite-
        //      close call no-ops and the stopService is a no-op too.
        //   4. updateStatus() runs once the rebind callback lands and
        //      paints the "Listening, ready at IP X.X.X.X" surface.
        //
        // No userStopped latch — the user's intent is "blip the service
        // and come back", not "stay down". onResume's auto-bind will
        // not race the postDelayed start because runMainPaneOnResume
        // only fires startPhoneService when !serviceBound, and our 800ms
        // window is well inside the typical resume interval.
        val disconnectButton: Button = findViewById(R.id.disconnectButton)
        disconnectButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Disconnect and refresh pressed")

            // Step 1: polite close of any active/pending LAN clients
            // BEFORE we kill the service. Idempotent — disconnectAllClients
            // no-ops cleanly when there's nothing connected.
            try {
                phoneService?.getServer()?.disconnectAllClients()
            } catch (e: Exception) {
                android.util.Log.w("MainActivity", "disconnectAllClients threw during refresh: ${e.message}")
            }

            // Step 2: stop the foreground service. ACTION_STOP →
            // PhoneService.stopSelf() → onDestroy → server.stop().
            val stopIntent = Intent(this, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            stopService(stopIntent)
            if (serviceBound) {
                unbindService(serviceConnection)
                serviceBound = false
            }
            phoneService = null
            stopStatusUpdates()

            // Optimistic UI during the 800 ms gap so the tap registers
            // visually. The next updateStatus() (driven by the rebind
            // callback after startPhoneService) will repaint correctly.
            statusText.text = getString(R.string.status_starting)
            ipText.text = getString(R.string.status_connecting)
            setStatusVisual(ConnState.CONNECTING)
            qrCodeImage.setImageBitmap(null)

            // Step 3: re-arm the service after a beat. Bumped 800 ms → 1500 ms
            // (Bug #2 dispatch #23). Field reports showed that on some Android
            // builds (Samsung One UI in particular), 800 ms was occasionally
            // not enough for the kernel to fully release port 8765 from
            // TIME_WAIT after stopService() — the new ServerSocket bind would
            // hit BindException and the service would silently stay down
            // until the user opened the app again. 1500 ms is empirically
            // generous; SO_REUSEADDR (added to PhoneServer.kt init block this
            // same dispatch) is the belt — this longer delay is the braces.
            // Optimistic UI above already shows "Starting / Connecting" so the
            // extra 700 ms isn't user-visible.
            handler.postDelayed({
                android.util.Log.d("MainActivity", "Disconnect-and-refresh: restarting service")
                startPhoneService()
            }, 1500L)
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

        // Auto-start flow: Request permissions and battery exemption
        if (hasPermissions()) {
            android.util.Log.d("MainActivity", "Permissions already granted")
            
            // Check battery optimization
            if (!isBatteryOptimizationDisabled()) {
                android.util.Log.d("MainActivity", "Requesting battery optimization exemption")
                statusText.text = getString(R.string.status_battery_request)
                ipText.text = getString(R.string.status_battery_request_hint)
                setStatusVisual(ConnState.WAITING)
                requestBatteryOptimizationExemption()
            } else {
                android.util.Log.d("MainActivity", "Battery optimization already disabled, starting service")
                statusText.text = getString(R.string.status_connecting)
                ipText.text = getString(R.string.status_connecting)
                setStatusVisual(ConnState.WAITING)
                startPhoneService()
            }
        } else {
            android.util.Log.d("MainActivity", "Permissions not granted, requesting automatically")
            statusText.text = getString(R.string.status_perms_requesting)
            ipText.text = getString(R.string.status_perms_needed)
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
                ipText.text = getString(R.string.status_connecting)
                setStatusVisual(ConnState.WAITING)

                // Auto-start service immediately
                startPhoneService()
            } else {
                android.util.Log.d("MainActivity", "Some required permissions denied")
                val deniedPermissions = requiredPermissions.filter {
                    ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
                }

                // Check if any permission was permanently denied ("Don't ask again")
                val permanentlyDenied = deniedPermissions.any { perm ->
                    !ActivityCompat.shouldShowRequestPermissionRationale(this, perm)
                }

                if (permanentlyDenied) {
                    statusText.text = getString(R.string.status_perms_denied_permanent)
                    ipText.text = getString(R.string.status_perms_denied_permanent_hint)
                    setStatusVisual(ConnState.IDLE)

                    // Show a button to open app settings
                    val disconnectButton: Button = findViewById(R.id.disconnectButton)
                    disconnectButton.text = getString(R.string.action_open_app_settings)
                    disconnectButton.visibility = android.view.View.VISIBLE
                    disconnectButton.setOnClickListener {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        startActivity(intent)
                    }
                } else {
                    statusText.text = getString(R.string.status_perms_denied_count, deniedPermissions.size)
                    ipText.text = getString(R.string.status_cannot_start_without_perms)
                    setStatusVisual(ConnState.IDLE)
                }

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
            ipText.text = getString(R.string.status_failed_to_start)
            setStatusVisual(ConnState.IDLE)
        }
    }

    private fun updateStatus() {
        android.util.Log.d("MainActivity", "updateStatus - serviceBound: $serviceBound, phoneService: ${phoneService != null}")
        // Round 4 — when the relay socket is CONNECTING or FAILED, the
        // phase callback owns the status row and we DON'T let the
        // polling loop overwrite it. Otherwise "Connecting…" would
        // flicker back to "Waiting for browser" on the next 2s tick.
        if (latestRelayPhase == PhoneService.RelayPhase.CONNECTING ||
            latestRelayPhase == PhoneService.RelayPhase.FAILED) {
            // Disconnect-and-refresh stays visible so the user can blip
            // a hung relay attempt. Dispatch #9: reconnectButton is
            // always GONE — see initializeMainPane for the rationale.
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = View.VISIBLE
            reconnectButton.visibility = View.GONE
            return
        }
        if (serviceBound && phoneService != null) {
            val status = phoneService?.getServerStatus() ?: "Service not running"
            val ip = phoneService?.getServerStatus()?.let { s ->
                val ipMatch = Regex("IP: ([\\d.]+):8765").find(s)
                ipMatch?.groupValues?.get(1)
            } ?: "Unknown"

            if (ip != "Unknown" && ip.isNotEmpty()) {
                val wsUrl = "ws://$ip:8765"
                ipText.text = wsUrl
                generateQRCode(wsUrl)
            }

            val isActive = status.contains("Connected to relay") || status.contains("Connected from")
            // Extract hostname if present (e.g. "Connected from D-Omni-HP" or "Connected to relay (D-Omni-HP)")
            val hostnameMatch = Regex("\\(([^)]+)\\)|Connected from ([^\\s-]+[^\\s]*)").find(status)
            val hostname = hostnameMatch?.groupValues?.firstOrNull { it.isNotEmpty() && it != hostnameMatch.value }

            // Browser-presence overlay (false-connection fix). The relay
            // socket being open does NOT mean a real browser is paired —
            // the relay pushes BROWSER_STATUS with the live count, and
            // PhoneService caches it. When we're connected to the relay
            // but no browser is actually on the other end, fall back to
            // the "Waiting for web app" copy rather than claiming the
            // pairing is live. Polled on every 2 s status tick.
            //
            // The colored dot (green / amber / slate) carries the
            // visual signal — keep the text clean, no emoji prefixes.
            val browserCount = phoneService?.getBrowserCount() ?: 0

            val (text, conn) = when {
                status.contains("Connected to relay") && browserCount == 0 ->
                    getString(R.string.status_waiting_for_web) to ConnState.WAITING
                status.contains("Connected to relay") -> {
                    val copy = if (browserCount == 1)
                        getString(R.string.status_clients_connected_one)
                    else
                        getString(R.string.status_clients_connected_many, browserCount)
                    copy to ConnState.LIVE
                }
                status.contains("Connected from") ->
                    getString(R.string.status_connected_to_host, hostname ?: "web app") to ConnState.LIVE
                status.contains("Waiting") ->
                    getString(R.string.status_waiting_for_web) to ConnState.WAITING
                else ->
                    status to ConnState.IDLE
            }
            statusText.text = text
            setStatusVisual(conn)

            // Service is running: Disconnect-and-refresh visible.
            // Dispatch #9: reconnectButton stays GONE forever — the
            // dual-button stopped state is dead, see initializeMainPane.
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.VISIBLE
            reconnectButton.visibility = android.view.View.GONE

            android.util.Log.d("MainActivity", "Status updated: ${statusText.text}")
        } else {
            // Service not bound. Two ways to land here (dispatch #9):
            //   (a) initial state before startPhoneService() finishes
            //       binding — paint the loading copy; the bind callback
            //       will paint the running state in a moment.
            //   (b) inside the 800ms postDelayed gap of the Disconnect-
            //       and-refresh handler. The handler already painted
            //       optimistic "Starting…" copy and ConnState.CONNECTING,
            //       so we leave that surface alone here.
            //   (c) service died unexpectedly (OOM kill / crash). Same
            //       loading copy as (a) — onResume's auto-bind will
            //       restart the service shortly.
            //
            // The userStopped latch from dispatch #6 is gone, so there's
            // no "deliberately stopped" branch any more — we always paint
            // the loading state. The reconnectButton stays GONE.
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.GONE
            reconnectButton.visibility = android.view.View.GONE
            statusText.text = getString(R.string.status_service_not_running)
            ipText.text = getString(R.string.status_loading_ip)
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

    private fun generateQRCode(content: String) {
        try {
            val size = 512 // QR code size in pixels
            val hints = hashMapOf<EncodeHintType, Int>().apply {
                put(EncodeHintType.MARGIN, 1)
            }
            
            val qrCodeWriter = QRCodeWriter()
            val bitMatrix = qrCodeWriter.encode(content, BarcodeFormat.QR_CODE, size, size, hints)
            
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
            for (x in 0 until size) {
                for (y in 0 until size) {
                    bitmap.setPixel(x, y, if (bitMatrix[x, y]) Color.BLACK else Color.WHITE)
                }
            }
            
            qrCodeImage.setImageBitmap(bitmap)
            android.util.Log.d("MainActivity", "QR code generated successfully")
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error generating QR code", e)
        }
    }
    
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
            ipText.text = getString(R.string.status_connecting)
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

        // Populate the expandable detail lists. Hide the section labels
        // when their list is empty so a partially-granted state doesn't
        // show an orphan heading.
        val runtimeList: LinearLayout = findViewById(R.id.permsRuntimeList)
        val specialList: LinearLayout = findViewById(R.id.permsSpecialList)
        val runtimeLabel: TextView = findViewById(R.id.permsRuntimeSectionLabel)
        val specialLabel: TextView = findViewById(R.id.permsSpecialSectionLabel)
        renderDetailList(runtimeList, runtimeMissing)
        renderDetailList(specialList, specialMissing)
        runtimeLabel.visibility = if (runtimeMissing.isEmpty()) View.GONE else View.VISIBLE
        runtimeList.visibility = if (runtimeMissing.isEmpty()) View.GONE else View.VISIBLE
        specialLabel.visibility = if (specialMissing.isEmpty()) View.GONE else View.VISIBLE
        specialList.visibility = if (specialMissing.isEmpty()) View.GONE else View.VISIBLE

        // Detail panel — start collapsed unless the user previously
        // expanded it. Re-renders preserve [permsDetailsExpanded] so an
        // Android-revoked permission appearing mid-flow doesn't snap the
        // panel shut.
        val toggle: TextView = findViewById(R.id.permsDetailsToggle)
        val panel: LinearLayout = findViewById(R.id.permsDetailsPanel)
        applyDetailsExpansion(toggle, panel)
        toggle.setOnClickListener {
            permsDetailsExpanded = !permsDetailsExpanded
            applyDetailsExpansion(toggle, panel)
        }

        // Primary CTA — Grant All. Kicks off the full sequence.
        val grantAllButton: Button = findViewById(R.id.permsGrantAllButton)
        grantAllButton.setOnClickListener {
            startGrantAllFlow(runtimeMissing, specialMissing)
        }

        // Refresh button — re-runs the check without leaving the Activity.
        // Safety net for OEM flows that don't return to us on Back.
        findViewById<Button>(R.id.permsRefreshButton).setOnClickListener {
            android.util.Log.d("MainActivity", "Refresh tapped — re-checking permissions")
            val now = PermissionChecker.checkAll(this)
            if (now.isEmpty()) {
                grantAllInProgress = false
                playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            } else {
                renderPermissionsRequiredPane(now)
            }
        }
    }

    /**
     * Apply the current expanded/collapsed state to the toggle label and
     * the detail panel visibility. Extracted because we need to do the
     * same thing in two places (initial render + click handler).
     */
    private fun applyDetailsExpansion(toggle: TextView, panel: LinearLayout) {
        if (permsDetailsExpanded) {
            panel.visibility = View.VISIBLE
            toggle.text = getString(R.string.perms_details_hide)
        } else {
            panel.visibility = View.GONE
            toggle.text = getString(R.string.perms_details_show)
        }
    }

    /**
     * Render an informational list of missing-permission rows into a
     * container. No Grant buttons — the user grants everything through
     * the Grant All flow. This list is purely a "what does this need?"
     * breakdown for the curious user who taps the disclosure toggle.
     */
    private fun renderDetailList(
        container: LinearLayout,
        items: List<PermissionChecker.MissingPermission>
    ) {
        container.removeAllViews()
        val inflater = LayoutInflater.from(this)
        for (perm in items) {
            val row = inflater.inflate(R.layout.item_missing_permission, container, false)
            row.findViewById<TextView>(R.id.permTitle).text = perm.displayName
            row.findViewById<TextView>(R.id.permWhy).text = perm.why
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

    override fun onDestroy() {
        super.onDestroy()
        stopStatusUpdates()
        // Drop the pulse animator so its update listener can't fire
        // on a destroyed view (no observed leak, but the listener
        // holds a strong ref to statusDotRing).
        statusPulseAnimator?.cancel()
        statusPulseAnimator = null
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

}
