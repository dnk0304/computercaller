package com.dnkdialer.companion

import android.Manifest
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
    private lateinit var stepNumber: TextView
    private lateinit var ipText: TextView
    private lateinit var qrCodeImage: ImageView
    private lateinit var enableNotificationsButton: Button

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

        // Initial Connect-button state. latestRelayPhase starts as IDLE,
        // so the button is enabled out of the gate — the user can tap
        // it the moment the service binds. The phase callback will
        // override this once a real RelayPhase arrives.
        reconnectButton.isEnabled = true
        reconnectButton.text = getString(R.string.action_reconnect)

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

        // Connect button — re-opens the relay against the LAN URL the
        // service was previously bound to. LAN flow only: the phone is
        // the WS server, the webapp connects in via the IP shown above.
        // The handler still routes through reconnectToRelay() because
        // that's the force-close+reopen path; the label says "Connect"
        // because from the user's POV they're establishing a session,
        // not recovering one.
        reconnectButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Connect button pressed")
            phoneService?.reconnectToRelay()
        }

        // Disconnect button - stops the service and all connections
        val disconnectButton: Button = findViewById(R.id.disconnectButton)
        disconnectButton.setOnClickListener {
            android.util.Log.d("MainActivity", "Disconnect button pressed")
            // Stop the service
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

            // Show brief disconnected state then restart so the user lands back on
            // the QR/IP screen ready to connect again (not stuck on a dead screen).
            statusText.text = getString(R.string.status_disconnected)
            ipText.text = getString(R.string.status_restarting)
            setStatusVisual(ConnState.IDLE)
            disconnectButton.visibility = android.view.View.GONE
            reconnectButton.visibility = android.view.View.GONE
            // Reset the Connect button copy in case it was mid-"Connecting…"
            // when the user pulled the plug.
            reconnectButton.text = getString(R.string.action_reconnect)
            reconnectButton.isEnabled = true
            qrCodeImage.setImageBitmap(null)

            handler.postDelayed({
                if (!serviceBound) {
                    statusText.text = getString(R.string.status_ready)
                    ipText.text = getString(R.string.status_starting)
                    setStatusVisual(ConnState.IDLE)
                    startPhoneService()
                }
            }, 800)
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
        ActivityCompat.requestPermissions(this, allPermissions, 1)
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
        
        if (requestCode == 1) { // Initial permissions request
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
            // Still keep the action stack visible so the user can hit
            // Reset / Cancel.
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = View.VISIBLE
            reconnectButton.visibility = View.VISIBLE
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

            // Show disconnect + connect buttons when service is running
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.VISIBLE
            reconnectButton.visibility = android.view.View.VISIBLE

            android.util.Log.d("MainActivity", "Status updated: ${statusText.text}")
        } else {
            statusText.text = getString(R.string.status_service_not_running)
            ipText.text = getString(R.string.status_loading_ip)
            setStatusVisual(ConnState.IDLE)
            val disconnectButton: Button = findViewById(R.id.disconnectButton)
            disconnectButton.visibility = android.view.View.GONE
            reconnectButton.visibility = android.view.View.GONE
            android.util.Log.d("MainActivity", "Status updated: Service not running")
        }
    }

    /**
     * Drive the status dot tint (and, for back-compat, the hidden
     * stepNumber color) to match the connection state.
     *
     * Round 3 contract: the DOT is the primary signal again.
     *   LIVE     → emerald green (R.color.dot_live)
     *   WAITING  → amber (R.color.dot_waiting)
     *   IDLE     → slate (R.color.dot_idle)
     *
     * The stepNumber TextView is `visibility="gone"` in the R3 layout,
     * so its color setter below is effectively a no-op — kept in case
     * a future debug overlay re-enables it. Removing it would require
     * a separate cleanup pass; not worth the churn now.
     */
    private fun setStatusVisual(state: ConnState) {
        val dotColor = when (state) {
            ConnState.LIVE -> ContextCompat.getColor(this, R.color.dot_live)
            ConnState.WAITING -> ContextCompat.getColor(this, R.color.dot_waiting)
            ConnState.IDLE -> ContextCompat.getColor(this, R.color.dot_idle)
            ConnState.CONNECTING -> ContextCompat.getColor(this, R.color.dot_connecting)
            ConnState.FAILED -> ContextCompat.getColor(this, R.color.dot_failed)
        }
        statusDot.backgroundTintList = ColorStateList.valueOf(dotColor)

        val stepLabel = when (state) {
            ConnState.LIVE -> R.string.step_03
            ConnState.WAITING -> R.string.step_02
            ConnState.IDLE, ConnState.FAILED -> R.string.step_01
            ConnState.CONNECTING -> R.string.step_02
        }
        stepNumber.setText(stepLabel)

        // Active step gets the warm accent; inactive stays dim. The
        // step number is the same size as the status text, so this
        // color shift carries real visual weight.
        val stepColor = when (state) {
            ConnState.LIVE, ConnState.WAITING, ConnState.CONNECTING ->
                ContextCompat.getColor(this, R.color.accent_warm)
            ConnState.IDLE, ConnState.FAILED ->
                ContextCompat.getColor(this, R.color.text_tertiary)
        }
        stepNumber.setTextColor(stepColor)
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

        // Drive the Connect button's enabled state + label off the relay
        // phase. The button reads as "Connect" in every state the user
        // can tap it, and "Connecting…" while the handshake is in flight
        // so the tap registers visually even though the button is
        // disabled (prevents spam taps).
        //
        // Phase → button:
        //   LIVE       → disabled, "Connect"      (already connected)
        //   OPEN       → disabled, "Connect"      (socket up, treat as live;
        //                                          the polling loop will refine)
        //   CONNECTING → disabled, "Connecting…"  (handshake in flight)
        //   IDLE       → enabled,  "Connect"      (ready to tap)
        //   FAILED     → enabled,  "Connect"      (let the user retry)
        //
        // PhoneService.RelayPhase only exposes the four members above
        // (LIVE doesn't exist on RelayPhase — that's ConnState's
        // higher-level abstraction). OPEN is the relay-socket-up state.
        reconnectButton.isEnabled = when (phase) {
            PhoneService.RelayPhase.OPEN -> false        // socket open — nothing to do
            PhoneService.RelayPhase.CONNECTING -> false  // handshake in progress — don't spam
            else -> true                                 // IDLE / FAILED → enabled
        }
        reconnectButton.text = if (phase == PhoneService.RelayPhase.CONNECTING) {
            getString(R.string.action_connecting)
        } else {
            getString(R.string.action_reconnect)
        }

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
            return
        }

        // All permissions granted. If we were on the permissions pane,
        // play the success animation, then initialize the main pane.
        // Otherwise (already on main pane), continue with the normal
        // onResume flow that was here before.
        if (inPermissionsRequiredPane) {
            android.util.Log.d("MainActivity", "onResume: all permissions granted — playing success animation")
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

        // Check if user granted battery optimization exemption
        if (hasPermissions() && isBatteryOptimizationDisabled() && !serviceBound) {
            android.util.Log.d("MainActivity", "Battery exemption granted, starting service")
            statusText.text = getString(R.string.status_starting)
            ipText.text = getString(R.string.status_connecting)
            startPhoneService()
        }

        // Try to rebind to service if it's running
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
     * Inflate / refresh the permissions-required pane. Idempotent — safe
     * to call repeatedly (e.g. user grants one of three permissions and
     * comes back; we re-render the now-2-item list).
     *
     * Side effect: sets [inPermissionsRequiredPane] to true.
     */
    private fun renderPermissionsRequiredPane(missing: List<PermissionChecker.MissingPermission>) {
        if (!inPermissionsRequiredPane) {
            setContentView(R.layout.activity_permissions_required)
            inPermissionsRequiredPane = true
        }

        val listContainer: LinearLayout = findViewById(R.id.missingPermissionsList)
        listContainer.removeAllViews()
        val inflater = LayoutInflater.from(this)
        for (perm in missing) {
            val card = inflater.inflate(R.layout.item_missing_permission, listContainer, false)
            card.findViewById<TextView>(R.id.permTitle).text = perm.displayName
            card.findViewById<TextView>(R.id.permWhy).text = perm.why
            // contentDescription on the Grant button gets the permission
            // name appended so TalkBack reads "Grant, Notifications" rather
            // than just "Grant" eleven times in a row.
            val grantButton: Button = card.findViewById(R.id.permGrantButton)
            grantButton.contentDescription = getString(R.string.perms_grant) + ", " + perm.displayName
            grantButton.setOnClickListener {
                try {
                    startActivity(perm.intent)
                } catch (e: Exception) {
                    android.util.Log.e("MainActivity", "Failed to launch grant intent for ${perm.id}", e)
                    // Defensive fallback: if a special-access intent
                    // isn't resolvable on this OEM build (rare), drop
                    // the user on the app-details screen so they have
                    // somewhere to land.
                    try {
                        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.fromParts("package", packageName, null)
                        }
                        startActivity(fallback)
                    } catch (_: Exception) { /* genuinely nothing we can do */ }
                }
            }
            listContainer.addView(card)
        }

        // Refresh button — re-runs the check without leaving the Activity.
        // Useful when the user grants something via a flow that doesn't
        // resume our Activity (some OEM battery settings drop you on
        // Home rather than coming back).
        findViewById<Button>(R.id.permsRefreshButton).setOnClickListener {
            android.util.Log.d("MainActivity", "Refresh tapped — re-checking permissions")
            val now = PermissionChecker.checkAll(this)
            if (now.isEmpty()) {
                playSuccessAnimationThen { initializeMainPane(); runMainPaneOnResume() }
            } else {
                renderPermissionsRequiredPane(now)
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

    override fun onDestroy() {
        super.onDestroy()
        stopStatusUpdates()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

}
