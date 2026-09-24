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
import androidx.core.view.WindowCompat
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

    // ==================== v56 Home surface ====================
    // The hero card has two faces that swap in place (see the header comment
    // in res/layout/activity_main.xml): the presence/state face, and the
    // connection-request face. Both are hoisted here so the 2s polling tick
    // and the pairing broadcasts can repaint without re-finding views.
    private lateinit var heroDefaultFace: View
    private lateinit var heroRequestFace: View

    /**
     * P5b (c) — the third face of the hero card: the SAS confirm. Shown after
     * Accept when the pair is Encrypted (verified), and BLOCKING while it is
     * up: see [showSasConfirm].
     */
    private lateinit var heroSasFace: View

    /**
     * The pairing whose SAS is on screen, or null. Distinct from
     * [pairingRequestDialogId]: by the time the SAS is up the request face is
     * gone and that id has been cleared, and conflating the two would let a
     * late ACTION_PAIRING_CANCELLED for the request tear down a SAS belonging
     * to a different pairing.
     */
    private var sasPairingId: String? = null

    /**
     * Swallows Back while the SAS is on screen. Enabled/disabled alongside
     * [heroSasFace]'s visibility so Back is untouched everywhere else.
     */
    private var sasBackCallback: androidx.activity.OnBackPressedCallback? = null

    /** P5b (d) — the fourth hero face: the TOFU key-change warning. */
    private lateinit var heroKeyChangeFace: View

    /** The pairing whose key-change warning is on screen, or null. */
    private var keyChangePairingId: String? = null

    /**
     * P5b (d) — this pair's encryption state, as words in the status line.
     *
     * Held here rather than read from PhoneService because `e2eVerified` and
     * the session are private fields with no accessor. Set by the service's
     * ACTION_E2E_STATE broadcast, and optimistically by a confirmed SAS so
     * the line is right the instant the user answers rather than a round trip
     * later. Cleared whenever the pair ends, because a stale "Encrypted" on a
     * dead pair is the one wrong answer that actively misleads.
     */
    private var e2eState: E2eStatusCopy.State = E2eStatusCopy.State.PLAINTEXT
    private lateinit var heroTitle: TextView
    private lateinit var heroBody: TextView
    private lateinit var deviceDot: View
    private lateinit var deviceLabel: TextView
    private lateinit var bridgeState: TextView
    private lateinit var requestName: TextView
    private lateinit var requestMeta: TextView
    private lateinit var requestAvatar: TextView
    private lateinit var notifBand: View
    private lateinit var permissionsSub: TextView

    // The stay-disconnected switch. Guarded by [suppressStaySwitchCallback]
    // whenever WE set isChecked from the flag, so a programmatic repaint can
    // never be mistaken for a user tap and bounce the lobby.
    private lateinit var staySwitch: com.google.android.material.switchmaterial.SwitchMaterial
    private var suppressStaySwitchCallback = false

    /**
     * vc63 — the Home "Encrypted mode" row. The SAME painter Settings uses
     * ([E2eModeRowBinder]), over the SAME preference, so the two screens
     * cannot disagree about a fact that is stored in one place.
     */
    private var encryptedModeBinder: E2eModeRowBinder? = null

    /**
     * The (pairActive -> live mode) the row was last painted for.
     *
     * updateStatus() runs on a 2 s tick and [E2eModeRowBinder.refresh] does a
     * Keystore capability probe plus a preferences read; repainting every
     * tick would be wasteful, and worse, it would wipe the "applies to your
     * next connection" line two seconds after the user read it. So the row is
     * repainted only when the fact it displays actually changed.
     *
     * Null is a MEANINGFUL value here ("no active pair"), so "never painted"
     * needs its own flag rather than being folded into it.
     */
    private var lastPaintedLiveMode: E2eStatusCopy.State? = null
    private var hasPaintedModeRow = false

    // Dispatch #34 (v20) — Disconnect button (terminates the active
    // pair without signing out). Hoisted to a field so updateStatus()
    // and handleRelayPhaseChanged() can flip visibility based on the
    // PhoneService.isPairActive lifecycle without re-finding the view.
    // VISIBLE only when there's an actual pair to disconnect from
    // (relay OPEN + isPairActive=true); GONE in lobby/idle/connecting/
    // failed states so the user doesn't see a dead button.
    private lateinit var disconnectPairButton: Button

    // Disconnect-from-lobby dispatch (v25, 2026-05-26). Toggles between
    // "Disconnect from Lobby" (when connected) and "Rejoin Lobby" (when
    // the user has chosen to stay disconnected). Always visible in the
    // main pane — no per-phase visibility gating — so the user can flip
    // state at any time. Label is reconciled by refreshLobbyToggleLabel()
    // on init, after each tap, and from the polling updateStatus() loop
    // so external flag changes (e.g. Sign Out clearing it via
    // TokenStore.clear()) keep the copy honest.
    private lateinit var lobbyToggleButton: Button

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
     * Activity is foregrounded we surface the request so the user can act
     * without diving into the notification shade. The notification still
     * posts in parallel — both Accept/Decline paths dispatch the same
     * internal broadcast that [ConnectionRequestReceiver] consumes, so the
     * decision converges in [PhoneService.handleConnectionDecision].
     *
     * v56 — this used to be an AlertDialog. It is now the hero card's second
     * face (see res/layout/activity_main.xml), so there is no window to leak
     * and no modal covering the presence line that explains the rest of the
     * screen. The AlertDialog field went with it; [pairingRequestDialogId]
     * alone tracks what is on screen.
     */

    /**
     * Pairing-id currently shown in [pairingRequestDialog]. Used so
     * PAIRING_CANCELLED with a different id leaves the dialog alone
     * (defensive — should never happen in practice, but a second
     * concurrent request handled by a different code path could race).
     */
    private var pairingRequestDialogId: String? = null

    /**
     * v56 — the name of the computer we are currently paired with, so the
     * connected hero card can say WHICH computer instead of "Connected".
     * Captured from the pairing request the user accepted (the relay's
     * friendly browser identity) and cleared when the pair ends. Null means
     * we only know that something is paired, and the card falls back to
     * "Your computer".
     */
    private var pairedComputerName: String? = null

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
                    // The other end gave up. Take the SAS down too — but only
                    // for THIS pairing, or a late cancellation for a request
                    // the user already answered would dismiss a live prompt.
                    if (sasPairingId == pairingId) hideSasConfirm()
                }

                // P5b (c) — the Accept path has the digits and is waiting.
                E2eSasContract.ACTION_E2E_SAS_REQUIRED -> {
                    val pairingId = intent.getStringExtra(PhoneService.EXTRA_PAIRING_ID) ?: return
                    val digits = intent.getStringExtra(E2eSasContract.EXTRA_SAS_DIGITS).orEmpty()
                    showSasConfirm(pairingId, digits)
                }

                // P5b (d) — this computer's key is not the one we saw before.
                E2eTofuContract.ACTION_E2E_KEY_CHANGED -> {
                    val pairingId = intent.getStringExtra(PhoneService.EXTRA_PAIRING_ID) ?: return
                    showKeyChangeWarning(pairingId)
                }

                // P5b (d) — the pair's encryption state, for the status line.
                E2eTofuContract.ACTION_E2E_STATE -> {
                    e2eState = E2eStatusCopy.stateOf(
                        encrypted = intent.getBooleanExtra(E2eTofuContract.EXTRA_ENCRYPTED, false),
                        verified = intent.getBooleanExtra(E2eTofuContract.EXTRA_VERIFIED, false),
                    )
                    updateStatus()
                }

                // P5b (c)/(d) — a refusal the user must be told about. Nothing
                // listened for this before P5b; see showE2eRefusal.
                PhoneService.ACTION_PAIRING_E2E_REFUSED -> {
                    val message = intent.getStringExtra(PhoneService.EXTRA_E2E_MESSAGE)
                        ?: E2eNegotiation.ABORT_MESSAGE
                    showE2eRefusal(message)
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
            // v56 notification-tap fix - the bind can land AFTER onResume
            // (binding is async), so re-surface here too. Idempotent:
            // showPairingRequestDialog no-ops when the same id is already
            // on screen.
            resurfacePendingPairings()
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
        // Round-? — block ONLY on a genuinely-missing RUNTIME permission.
        // SPECIAL entries (notification_listener, battery_optimization,
        // auto_revoke) are OEM-re-flagged after backgrounding even when
        // every runtime grant is intact; gating onCreate on the raw
        // isNotEmpty() therefore re-blocked the user on every reopen and
        // trapped them in the pane (the same dead-end the Refresh button
        // at permsRefreshButton already escapes via the kind==RUNTIME
        // rule). Match the Refresh button: a SPECIAL-only audit passes
        // straight through to the main pane.
        val missing = PermissionChecker.checkAll(this)
        val runtimeMissing = missing.any { it.kind == PermissionChecker.Kind.RUNTIME }
        if (runtimeMissing) {
            android.util.Log.d("MainActivity", "onCreate: runtime permissions missing (${missing.filter { it.kind == PermissionChecker.Kind.RUNTIME }.map { it.id }}) — showing blocking pane")
            renderPermissionsRequiredPane(missing)
            return
        }
        if (missing.isNotEmpty()) {
            android.util.Log.d("MainActivity", "onCreate: only SPECIAL permissions missing (${missing.map { it.id }}) — proceeding to main pane")
        }

        initializeMainPane()

        // v56 notification-tap fix - cold start through the connection-request
        // notification. The service is not bound yet at this point, so this
        // records/validates nothing on its own; onServiceConnected ->
        // resurfacePendingPairings() is what actually raises the dialog. The
        // call is kept here so the intent extras are consumed exactly once
        // and a rotation cannot replay them.
        handlePairingIntent(intent)
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

        // API 35 edge-to-edge: stop the decor from fitting system windows so
        // the surface_base background fills behind the bars, then pad the
        // scroll content so the wordmark clears the status bar and the
        // bottom-most action (Sign Out / Hard Reset) clears the gesture nav.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        InsetsUtils.applySystemBarInsets(findViewById(R.id.mainContentContainer))

        statusText = findViewById(R.id.statusText)
        statusDot = findViewById(R.id.statusDot)
        statusDotRing = findViewById(R.id.statusDotRing)
        stepNumber = findViewById(R.id.stepNumber)
        reconnectButton = findViewById(R.id.reconnectButton)

        // Diagnostic surface for relay-dial attempts that hang or fail.
        connectionTargetText = findViewById(R.id.connectionTargetText)
        connectionErrorText = findViewById(R.id.connectionErrorText)

        // ---- v56 hero card ------------------------------------------------
        heroDefaultFace = findViewById(R.id.homeHeroDefault)
        heroRequestFace = findViewById(R.id.homeHeroRequest)
        heroTitle = findViewById(R.id.homeHeroTitle)
        heroBody = findViewById(R.id.relayHelpText)
        deviceDot = findViewById(R.id.homeDeviceDot)
        deviceLabel = findViewById(R.id.homeDeviceLabel)
        bridgeState = findViewById(R.id.homeBridgeState)
        requestName = findViewById(R.id.homeRequestName)
        requestMeta = findViewById(R.id.homeRequestMeta)
        requestAvatar = findViewById(R.id.homeRequestAvatar)
        notifBand = findViewById(R.id.homeNotifBand)
        permissionsSub = findViewById(R.id.homePermissionsSub)

        // "This phone - <model>". Build.MODEL is what the relay shows the
        // browser, so the two surfaces name the same device the same way.
        deviceLabel.text = getString(R.string.home_device_line, deviceDisplayName())

        // Accept / Decline on the hero card dispatch the SAME broadcast the
        // notification action buttons use, so an in-app decision and a shade
        // decision converge in PhoneService.handleConnectionDecision. There is
        // no second code path to keep in sync.
        findViewById<View>(R.id.pairAcceptButton).setOnClickListener {
            val id = pairingRequestDialogId ?: return@setOnClickListener
            hidePairingRequest()
            dispatchPairingDecision(id, accept = true)
        }
        findViewById<View>(R.id.pairDeclineButton).setOnClickListener {
            val id = pairingRequestDialogId ?: return@setOnClickListener
            hidePairingRequest()
            dispatchPairingDecision(id, accept = false)
        }

        // P5b (c) — the SAS answers. Both go through dispatchSasVerdict, so
        // "Matches" and "Doesn't match" are the same code path with one
        // boolean between them; a refusal that took its own branch would be a
        // second place for the refusal to be got wrong.
        heroSasFace = findViewById(R.id.homeHeroSas)

        // Back must not be an escape hatch from a security prompt. Enabled
        // only while the SAS is up, so Back behaves exactly as before
        // everywhere else — including on the pairing REQUEST face, which is
        // dismissable on purpose (declining by leaving is a safe default;
        // skipping verification is not).
        onBackPressedDispatcher.addCallback(
            this,
            object : androidx.activity.OnBackPressedCallback(false) {
                override fun handleOnBackPressed() {
                    heroSasFace.announceForAccessibility(
                        getString(R.string.e2e_sas_prompt)
                    )
                }
            }.also { sasBackCallback = it }
        )

        findViewById<View>(R.id.sasMatchesButton).setOnClickListener {
            dispatchSasVerdict(matched = true)
        }
        findViewById<View>(R.id.sasNoMatchButton).setOnClickListener {
            dispatchSasVerdict(matched = false)
        }

        // P5b (d) — the key-change answers. Same one-path-two-booleans shape
        // as the SAS: "Not now" is a refusal, not a cancel, and it travels the
        // same broadcast as "Trust".
        heroKeyChangeFace = findViewById(R.id.homeHeroKeyChange)
        findViewById<View>(R.id.keyChangeTrustButton).setOnClickListener {
            dispatchKeyChangeVerdict(trusted = true)
        }
        findViewById<View>(R.id.keyChangeNotNowButton).setOnClickListener {
            dispatchKeyChangeVerdict(trusted = false)
        }

        // ---- v56 row groups ------------------------------------------------
        // The synced viewers and the permission screen are one tap from Home,
        // which is what the Play restricted-permission review needs to see.
        findViewById<View>(R.id.homeMessagesRow).setOnClickListener {
            startActivity(Intent(this, SyncedDataActivity::class.java).putExtra("tab", "messages"))
        }
        findViewById<View>(R.id.homeCallsRow).setOnClickListener {
            startActivity(Intent(this, SyncedDataActivity::class.java).putExtra("tab", "calls"))
        }
        findViewById<View>(R.id.homePermissionsRow).setOnClickListener {
            AccountActions.openAppDetails(this)
        }
        findViewById<View>(R.id.homeNotifTurnOnButton).setOnClickListener {
            AccountActions.openNotificationSettings(this)
        }

        // ---- v56 stay-disconnected switch ----------------------------------
        // Same flag, same broadcast, same handler as the Rejoin button below
        // and as the ongoing notification's DISCONNECT action. Three surfaces,
        // one source of truth: TokenStore.isUserStayedDisconnected.
        staySwitch = findViewById(R.id.homeStaySwitch)
        staySwitch.setOnCheckedChangeListener { _, checked ->
            if (suppressStaySwitchCallback) return@setOnCheckedChangeListener
            val action = if (checked) {
                LobbyActionReceiver.ACTION_DISCONNECT_LOBBY
            } else {
                LobbyActionReceiver.ACTION_REJOIN_LOBBY
            }
            android.util.Log.d("MainActivity", "stay-disconnected switch -> $action")
            sendBroadcast(Intent(action).apply { setPackage(packageName) })
            staySwitch.postDelayed({ refreshLobbyToggleLabel() }, 250)
        }

        // ---- vc63 COMPUTER card -------------------------------------------
        // Row A: the in-app file picker. FileTransferActivity has carried
        // ACTION_PICK_FILE since the feature shipped and nothing in the app
        // ever fired it — the share sheet was the only way in. This is that
        // intent's first caller, and it is ALL this row does.
        //
        // Deliberately unguarded: no "are we connected?" check here. Every
        // refusal (not connected, a transfer already running, tier, quota)
        // already lives inside FileTransferActivity and the share-sheet path
        // goes through it. A second copy of those checks on Home is a second
        // copy that drifts, and the day it drifts the two entry points
        // disagree about whether a send is possible.
        findViewById<View>(R.id.homeSendFileButton).setOnClickListener {
            startActivity(
                Intent(this, FileTransferActivity::class.java)
                    .setAction(FileTransferActivity.ACTION_PICK_FILE)
            )
        }

        // Row B: the same Encrypted-mode row as Settings, same binder, same
        // preference. Flipping it here changes the NEXT connection only —
        // the live pair's mode is latched at Accept (SPEC §13.1) — and the
        // reason line under the row says so whenever the two disagree.
        encryptedModeBinder = E2eModeRowBinder(
            this,
            findViewById(R.id.homeEncryptedModeToggle),
            findViewById(R.id.homeEncryptedModeTitle),
            findViewById(R.id.homeEncryptedModeSub),
            findViewById(R.id.homeEncryptedModeReason),
        ).apply {
            bind { checked -> DiagLog.d("MainActivity", "e2e.toggle.home ${if (checked) "on" else "off"}") }
            refresh()
        }

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


        // Dispatch #34 (v20) — Disconnect (active pair only) button.
        // Sits above Sign Out. Tapping ends the current pair without
        // signing out: phone stays signed in, returns to lobby state,
        // browser flips back to "Phone in lobby — ready to pair", can
        // re-Connect from browser without phone re-sign-in.
        // Visibility is gated on PhoneService.isPairActive — initial
        // state is GONE (XML default) until updateStatus() picks up
        // the first LIVE poll after the service binds.
        // Disconnect-from-lobby dispatch (v25, 2026-05-26). Toggle button
        // wired here so the click handler can read live PhoneService state
        // via the bound service reference. Label is set by
        // refreshLobbyToggleLabel() which reads the persistent TokenStore
        // flag — so on cold launch in the stay-disconnected state, the
        // button paints as "Rejoin Lobby" before any service binding
        // happens.
        lobbyToggleButton = findViewById(R.id.lobbyToggleButton)
        lobbyToggleButton.setOnClickListener {
            val service = phoneService
            if (service == null) {
                android.util.Log.w("MainActivity", "lobbyToggleButton: service not bound yet — ignoring tap")
                return@setOnClickListener
            }
            // v56 — this button is Rejoin only. It is visible exactly when
            // the phone is out of the lobby, so there is no second meaning to
            // flip into: leaving the lobby is the switch below it, the
            // Settings switch, and the ongoing notification's DISCONNECT.
            android.util.Log.d("MainActivity", "Rejoin Lobby tapped")
            service.userRejoinLobby()
            // Repaint immediately so the user gets feedback without
            // waiting for the 2s polling tick. updateStatus() will
            // reconcile on its next cycle either way.
            refreshLobbyToggleLabel()
        }
        refreshLobbyToggleLabel()

        disconnectPairButton = findViewById(R.id.disconnectPairButton)
        disconnectPairButton.setOnClickListener {
            val pairActive = phoneService?.getIsPairActive() == true
            if (!pairActive) {
                // Defensive — the button should be hidden when there's
                // no active pair, but if a stale tap lands during the
                // ~1 polling-cycle window between PAIRING_TERMINATED
                // and the next updateStatus(), do nothing.
                android.util.Log.d("MainActivity", "Disconnect tapped with no active pair — ignoring")
                return@setOnClickListener
            }
            android.util.Log.d("MainActivity", "Disconnect (active pair) tapped")
            phoneService?.leaveActivePair()
            // Optimistic UI — hide the button immediately and flip the
            // status row to lobby copy so the user gets feedback without
            // waiting for the server roundtrip. The PAIRING_TERMINATED
            // frame coming back from the relay will reconcile via the
            // existing PhoneService handler → isPairActive=false →
            // updateStatus() lobby branch (idempotent with what we set
            // here).
            disconnectPairButton.visibility = View.GONE
            statusText.text = getString(R.string.pair_lobby_status)
            setStatusVisual(ConnState.WAITING)
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
        // v56 — Sign Out moved to SettingsActivity; Home now has a single
        // Settings entry point instead of the old button stack.
        // v56 — the Settings entry point is now the app-bar gear (an
        // ImageButton), so this is bound as a View rather than a Button.
        val settingsButton: View = findViewById(R.id.settingsButton)
        settingsButton.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        
        // Hard Reset button — manual escape hatch for the "Samsung
        // One UI silently revoked something" class of bugs. Wipes app
        // data via ActivityManager.clearApplicationUserData() and
        // force-restarts the process, so the user lands back on the
        // Grant All pane with a clean slate. Gated behind a confirmation
        // dialog with a destructive-style action button (red text) so an
        // accidental tap doesn't nuke the user's setup.
        // v56 — Hard Reset moved to SettingsActivity (see AccountActions).

        // Play verifiability fix (v40, 2026-06-21) — open the on-device view
        // of the synced SMS / call log. SyncedDataActivity reads the device's
        // own providers (SmsHandler / CallLogsHandler) and renders them in-app
        // with NO desktop pairing required, so the restricted-permission
        // feature is demonstrable on one phone. Each button deep-links to its
        // tab; the activity handles its own runtime-permission grant flow.
        // v56 — the synced Messages / Call history entry points moved to
        // SettingsActivity. They are still one tap from Home (Settings row)
        // and still work with no desktop pairing, which is what the Play
        // restricted-permission review needs to see.

        // Check and show notification status
        checkNotificationStatus()

        // ColorOS/OxygenOS background hint (v45, 2026-07-07). Oppo/OnePlus/
        // Realme run their own app-killer + auto-launch gate that the
        // standard Doze battery exemption does NOT cover — the service gets
        // killed in the background anyway. Surface a one-line dismissible
        // hint pointing the user at the vendor Battery/Auto-launch toggles.
        setupColorOsHint()

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
    
    /**
     * v56 — notifications blocked at OS level is the one problem a user of
     * this app cannot afford to miss: with them off, an incoming call from
     * the computer simply never announces itself. So Home shows a notice band
     * about it, with the fix in the band. The full notification settings row
     * lives in SettingsActivity; this is only the blocked-state warning.
     *
     * Re-run from onResume via [refreshPermissionSummary] so the band
     * disappears the moment the user comes back having granted it.
     */
    private fun checkNotificationStatus() {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val enabled = notificationManager.areNotificationsEnabled()
        android.util.Log.d("MainActivity", "Notifications enabled at system level: $enabled")
        if (::notifBand.isInitialized) {
            notifBand.visibility = if (enabled) View.GONE else View.VISIBLE
        }
    }

    /**
     * Keep the Permissions row's subtitle honest: "All granted", or how many
     * are still outstanding. A row that always claims everything is fine is
     * worse than no row, because it is the row users check when calls stop
     * arriving. Counts RUNTIME grants only — the SPECIAL entries are
     * re-flagged by some OEMs after backgrounding even when nothing changed,
     * and surfacing that churn here would cry wolf.
     */
    private fun refreshPermissionSummary() {
        if (!::permissionsSub.isInitialized) return
        val missing = PermissionChecker.checkAll(this)
            .count { it.kind == PermissionChecker.Kind.RUNTIME }
        permissionsSub.text = if (missing == 0) {
            getString(R.string.row_permissions_all)
        } else {
            getString(R.string.row_permissions_some, missing)
        }
    }
    
    /**
     * ColorOS/OxygenOS background hint (v45). Shown only when:
     *  - Build.MANUFACTURER is oppo / oneplus / realme (ColorOS/OxygenOS
     *    family — all share the aggressive app-killer + auto-launch gate),
     *  - the standard battery exemption is ALREADY granted (so the user
     *    thinks they're done, but the vendor killer still applies),
     *  - the user hasn't dismissed it before (persisted flag).
     * "Open app settings" deep-links to the app-details page — the vendor
     * Battery ("Allow background activity") and Auto-launch toggles live
     * under it. "Got it" hides the hint permanently.
     */
    private fun setupColorOsHint() {
        val container = findViewById<android.view.View>(R.id.colorOsHintContainer) ?: return
        val prefs = getSharedPreferences("coloros_hint", Context.MODE_PRIVATE)
        val manufacturer = Build.MANUFACTURER.lowercase()
        val isColorOsFamily = manufacturer.contains("oppo") ||
            manufacturer.contains("oneplus") ||
            manufacturer.contains("realme")
        if (!isColorOsFamily ||
            prefs.getBoolean("dismissed", false) ||
            !isBatteryOptimizationDisabled()
        ) {
            container.visibility = android.view.View.GONE
            return
        }
        container.visibility = android.view.View.VISIBLE
        findViewById<Button>(R.id.colorOsHintSettingsButton).setOnClickListener {
            try {
                startActivity(
                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                    }
                )
            } catch (e: Exception) {
                android.util.Log.e("MainActivity", "Failed to open app details settings", e)
            }
        }
        findViewById<Button>(R.id.colorOsHintDismissButton).setOnClickListener {
            prefs.edit().putBoolean("dismissed", true).apply()
            container.visibility = android.view.View.GONE
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

        // Disconnect-from-lobby (v25, 2026-05-26): keep the toggle button
        // label in sync with the persistent flag on every polling tick so
        // any external flag change (e.g. Sign Out clearing it via
        // TokenStore.clear, or a future surface flipping it) stays honest.
        refreshLobbyToggleLabel()

        // Disconnect-from-lobby (v25): when the user has chosen to stay
        // disconnected, the status row paints the disconnected copy
        // regardless of relay phase / service-bound state — the relay
        // socket is intentionally closed, so any "Connecting" / "Waiting"
        // would be a lie. Short-circuit BEFORE the phase / pair-active
        // logic below since both would otherwise overwrite this.
        if (TokenStore.isUserStayedDisconnected(this)) {
            statusText.text = getString(R.string.status_user_disconnected_short)
            setStatusVisual(ConnState.IDLE)
            reconnectButton.visibility = View.GONE
            if (::disconnectPairButton.isInitialized) {
                disconnectPairButton.visibility = View.GONE
            }
            pairedComputerName = null
            paintHero(ConnState.IDLE, pairActive = false, callInProgress = false)
            return
        }

        // Dispatch #29 — Phase 4 finish. With the LAN PhoneServer gone,
        // updateStatus only paints the relay-side state. Phase-driven
        // paints (CONNECTING / FAILED) are owned by handleRelayPhaseChanged
        // and short-circuit here so the 2s polling tick doesn't fight them.
        if (latestRelayPhase == PhoneService.RelayPhase.CONNECTING ||
            latestRelayPhase == PhoneService.RelayPhase.FAILED) {
            // Sign Out button stays visible regardless of phase so the
            // user can always escape a wedged state.
            reconnectButton.visibility = View.GONE
            // Dispatch #34 — Disconnect button hidden in CONNECTING /
            // FAILED phases: there's no active pair to disconnect from
            // (the relay socket itself is mid-handshake or wedged).
            if (::disconnectPairButton.isInitialized) {
                disconnectPairButton.visibility = View.GONE
            }
            // v56 — repaint the hero for these phases too. Without this the
            // card kept the last good copy while the presence line above it
            // said "Couldn't connect.", which is exactly the contradiction
            // trait 1 exists to prevent. handleRelayPhaseChanged owns the
            // presence LINE in these phases; paintHero owns what is under it.
            pairedComputerName = null
            paintHero(
                if (latestRelayPhase == PhoneService.RelayPhase.FAILED) {
                    ConnState.FAILED
                } else {
                    ConnState.CONNECTING
                },
                pairActive = false,
                callInProgress = false
            )
            return
        }

        if (serviceBound && phoneService != null) {
            val status = phoneService?.getServerStatus() ?: "Service not running"

            // v19 — Connect+Accept pivot status display.
            //
            // Relay-socket OPEN (`status.contains("Connected to relay")`)
            // does NOT mean a browser is actually paired with us. The
            // socket can be open while we're still in the LOBBY waiting
            // for the user to Accept a pairing request.
            //
            // PhoneService now tracks an explicit `isPairActive` flag that
            // flips on PAIRING_ACTIVE (relay confirms the pair crossed
            // into the active room) and clears on PAIRING_TERMINATED /
            // socket close / user disconnect. We read it here and use it
            // as the source of truth for the status copy.
            //
            // The legacy `browserCount` field is kept on PhoneService as
            // a dead-code path in case the relay protocol changes back,
            // but the relay no longer emits BROWSER_STATUS — so we no
            // longer read it here. (Removing the field would risk a
            // wider blast radius; the flag-based approach lets us land
            // a tight UX fix without touching the protocol.)
            val pairActive = phoneService?.getIsPairActive() ?: false

            val (text, conn) = when {
                // Relay open + active pair → the actual "Connected" state.
                // Pre-v19 this branch was gated on browserCount which the
                // relay no longer populates, so the UI never reached it
                // even after a successful Accept. Now it's wired to the
                // PAIRING_ACTIVE/PAIRING_TERMINATED lifecycle directly.
                // v56 (replaces the dropped in-call screen, decision 5) —
                // while the paired computer has a call running, the presence
                // line says so instead of the generic connected copy.
                // PhoneService already knows the phone's call state; we read
                // it through the SAME bound-service channel as isPairActive,
                // on the same 2 s tick, so the two can never disagree.
                status.contains("Connected to relay") && pairActive &&
                    phoneService?.getIsCallInProgress() == true ->
                    getString(R.string.status_call_in_progress) to ConnState.LIVE
                // P5b (d) — an ACTIVE pair names its encryption state in
                // words. The dot's tint is an accent, never the signal: a
                // colour-blind user, a monochrome display and the notification
                // shade all see the word and none of them see the tint
                // (WCAG 1.4.1). "Not encrypted" is spelled out rather than
                // left as a bare "Connected", because the absence of a word is
                // not a signal — a plain "Connected" is exactly what a user
                // reads as safe.
                status.contains("Connected to relay") && pairActive -> {
                    // T-PHONE-STATUS-MODE0: read the state from the bound
                    // service on this same tick — the SAME channel as
                    // getIsCallInProgress above — rather than trusting that
                    // an ACTION_E2E_STATE edge was received. An Activity that
                    // bound after the Accept, or was recreated, never saw
                    // that edge; a row-4 (0/0) pair asks no SAS, so nothing
                    // else ever moved the field off its PLAINTEXT
                    // initialiser and the line said "Not encrypted" over a
                    // sealed pair. The broadcast is still sent (it makes the
                    // line right immediately); this makes it right REGARDLESS.
                    phoneService?.currentE2eState()?.let { e2eState = it }
                    getString(E2eStatusCopy.statusLine(e2eState)) to ConnState.LIVE
                }
                // Relay open + no active pair → LOBBY. Phone is sitting
                // waiting for a browser to send a pairing request that
                // the user must Accept.
                status.contains("Connected to relay") -> {
                    // No pair, no encryption state. A stale "Encrypted" on a
                    // dead pair is the one wrong answer that actively misleads.
                    e2eState = E2eStatusCopy.State.PLAINTEXT
                    getString(R.string.pair_lobby_status) to ConnState.WAITING
                }
                status.contains("Waiting") ->
                    getString(R.string.pair_lobby_status) to ConnState.WAITING
                else ->
                    status to ConnState.IDLE
            }
            statusText.text = text
            setStatusVisual(conn)
            if (!pairActive) pairedComputerName = null
            paintHero(conn, pairActive, phoneService?.getIsCallInProgress() == true)
            // vc63 — the Encrypted-mode row's honest-state line, fed from the
            // SAME e2eState and the SAME pairActive this status line was just
            // painted from, on the same tick. Reading it from anywhere else
            // is how the row and the status line end up contradicting each
            // other about the connection the user is looking at.
            paintEncryptedModeRow(if (pairActive) e2eState else null)

            reconnectButton.visibility = View.GONE
            // Dispatch #34 — Disconnect button is visible iff there's an
            // active pair to disconnect from. Reuses the same pairActive
            // signal that drives the status copy above so the button and
            // the copy can't disagree.
            if (::disconnectPairButton.isInitialized) {
                disconnectPairButton.visibility = if (pairActive) View.VISIBLE else View.GONE
            }
            android.util.Log.d("MainActivity", "Status updated: ${statusText.text}")
        } else {
            reconnectButton.visibility = View.GONE
            // Dispatch #34 — service not bound → no relay session → no
            // pair possible. Disconnect hidden.
            if (::disconnectPairButton.isInitialized) {
                disconnectPairButton.visibility = View.GONE
            }
            statusText.text = getString(R.string.status_service_not_running)
            setStatusVisual(ConnState.IDLE)
            pairedComputerName = null
            paintHero(ConnState.IDLE, pairActive = false, callInProgress = false)
            // No bound service means no pair, so there is no "this connection"
            // to describe — the row falls back to the capability copy.
            paintEncryptedModeRow(null)
            android.util.Log.d("MainActivity", "Status updated: Service not running")
        }
    }

    /**
     * vc63 — repaint the Encrypted-mode row for the live pair's mode ([live]
     * null = nothing paired).
     *
     * Guarded on change because updateStatus() ticks every 2 s: an
     * unconditional repaint would re-read the Keystore twenty times a minute
     * and, worse, would overwrite the "applies to your next connection" line
     * the user is in the middle of reading two seconds after they flipped the
     * switch.
     */
    private fun paintEncryptedModeRow(live: E2eStatusCopy.State?) {
        val binder = encryptedModeBinder ?: return
        if (hasPaintedModeRow && lastPaintedLiveMode == live) return
        hasPaintedModeRow = true
        lastPaintedLiveMode = live
        binder.livePairMode = live
        binder.refresh()
    }

    /**
     * Force a repaint of the Encrypted-mode row, with [live] as the pair's
     * mode.
     *
     * Instrumented tests can only seed the capability store AFTER the
     * Activity has painted, and an active pair needs a bound PhoneService and
     * a real computer — neither of which a fixture has. This hook paints the
     * PRODUCTION row through the PRODUCTION binder with one input supplied;
     * it does not fake a pair and nothing in the app calls it. Same shape,
     * and same reason, as SettingsActivity.refreshEncryptedModeRowForTest().
     */
    @androidx.annotation.VisibleForTesting
    internal fun refreshEncryptedModeRowForTest(live: E2eStatusCopy.State? = null) {
        hasPaintedModeRow = false
        paintEncryptedModeRow(live)
    }

    /**
     * Disconnect-from-lobby (v25, 2026-05-26) — sync the lobby toggle
     * button label to the persistent TokenStore flag.
     *
     * Called on init, after each tap, and from the polling updateStatus()
     * loop so a flag change from any source (Sign Out implicitly clearing
     * it via TokenStore.clear, or a future surface) keeps the copy honest.
     *
     * Guarded against being called before initializeMainPane() wires the
     * button — early lifecycle paths (permissions pane, splash) can call
     * updateStatus before the main pane initializes.
     */
    private fun refreshLobbyToggleLabel() {
        if (!::lobbyToggleButton.isInitialized) return
        val disconnected = TokenStore.isUserStayedDisconnected(this)

        // v56 + Dennis's hard requirement: whenever this phone is NOT in the
        // lobby, rejoining is one obvious tap from Home. The button is that
        // tap and it is only ever a Rejoin — the "leave the lobby" direction
        // now lives on the switch below it, on the Settings switch, and on
        // the ongoing notification's DISCONNECT action. A single control that
        // changed its own meaning under the user's thumb was the v55 problem.
        lobbyToggleButton.text = getString(R.string.action_rejoin_lobby)
        lobbyToggleButton.visibility = if (disconnected) View.VISIBLE else View.GONE

        // Repaint the switch from the flag without re-firing its listener.
        if (::staySwitch.isInitialized && staySwitch.isChecked != disconnected) {
            suppressStaySwitchCallback = true
            staySwitch.isChecked = disconnected
            suppressStaySwitchCallback = false
        }
    }

    /**
     * v56 — Home's hero card copy.
     *
     * The presence LINE (dot + `statusText`) is painted by updateStatus() and
     * setStatusVisual(); this paints the TITLE and BODY under it, so the card
     * answers "what is happening" at a glance and "what do I do about it" on
     * the second read. One place, so the two halves cannot contradict.
     */
    private fun paintHero(state: ConnState, pairActive: Boolean, callInProgress: Boolean) {
        if (!::heroTitle.isInitialized) return

        val stayedOut = TokenStore.isUserStayedDisconnected(this)
        when {
            stayedOut -> {
                heroTitle.setText(R.string.home_hero_offline_title)
                heroBody.setText(R.string.home_hero_offline_body)
            }
            pairActive && callInProgress -> {
                heroTitle.text = pairedComputerName ?: getString(R.string.home_hero_connected_title)
                heroBody.setText(R.string.home_hero_call_body)
            }
            pairActive -> {
                heroTitle.text = pairedComputerName ?: getString(R.string.home_hero_connected_title)
                heroBody.setText(R.string.home_hero_connected_body)
            }
            state == ConnState.WAITING -> {
                heroTitle.setText(R.string.home_hero_waiting_title)
                heroBody.setText(R.string.home_hero_waiting_body)
            }
            state == ConnState.CONNECTING -> {
                heroTitle.setText(R.string.home_hero_connecting_title)
                heroBody.setText(R.string.home_hero_connecting_body)
            }
            // The failure copy says what to check and that the app is still
            // trying, because the relay retries on its own — telling the user
            // it failed and stopping there would send them hunting for a
            // retry button that does not exist.
            state == ConnState.FAILED -> {
                heroTitle.setText(R.string.home_hero_failed_title)
                heroBody.setText(R.string.home_hero_failed_body)
            }
            else -> {
                heroTitle.setText(R.string.home_hero_offline_title)
                heroBody.setText(R.string.home_hero_waiting_body)
            }
        }

        // The device line's own dot is about the BRIDGE, not the pair: green
        // while the relay socket is up, idle grey when it is not.
        val bridgeUp = !stayedOut && (state == ConnState.LIVE || state == ConnState.WAITING)
        deviceDot.backgroundTintList = ColorStateList.valueOf(
            ContextCompat.getColor(this, if (bridgeUp) R.color.dot_live else R.color.dot_idle)
        )
        bridgeState.setText(
            if (bridgeUp) R.string.home_bridge_active else R.string.home_bridge_inactive
        )
    }

    /**
     * "This phone - Pixel 8". Build.MODEL alone reads as a part number on
     * some OEMs, so the manufacturer is prefixed unless the model already
     * starts with it (Samsung's "SM-…" does not, Google's "Pixel 8" does).
     */
    private fun deviceDisplayName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        val maker = Build.MANUFACTURER?.trim().orEmpty()
        if (model.isEmpty()) return maker.ifEmpty { getString(R.string.synced_unknown) }
        if (maker.isEmpty() || model.startsWith(maker, ignoreCase = true)) return model
        return "${maker.replaceFirstChar { it.uppercase() }} $model"
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
                // v56 — the halo tops out at 0.7 rather than 1.0. At full
                // alpha the amber ring was the heaviest thing on the hero
                // card and pulled the eye off the state copy it exists to
                // support (trait 1: ONE presence line).
                statusDotRing.alpha = 0.25f
                statusPulseAnimator = ValueAnimator.ofFloat(0.25f, 0.7f).apply {
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
                // v56 - the presence line is the STATE in a word or two; the
                // explanation belongs to the hero copy under it (paintHero)
                // and the machine detail to connectionErrorText below that.
                // Before this the line and the hero both read "Couldn't
                // connect", which is a wasted line, not emphasis.
                statusText.text = getString(R.string.status_disconnected)
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
     *   - 4401: relay's invalid-token close. Tell the user to sign out
     *     and back in — there is no QR and nothing to re-scan.
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

        // v56 — re-check the two things the user can change while they are
        // away from this screen: whether notifications are blocked at OS
        // level, and how many runtime permissions are outstanding. Both are
        // no-ops until the main pane is inflated, so this is safe on the
        // permissions-pane path too.
        checkNotificationStatus()
        refreshPermissionSummary()

        // vc63 — the user may have flipped Encrypted mode in Settings while
        // they were away, or paired a computer that changed the capability.
        // Both screens refresh() in onResume, so whichever one you come back
        // to shows the stored truth rather than what it painted last time.
        hasPaintedModeRow = false
        paintEncryptedModeRow(lastPaintedLiveMode)

        // v56 notification-tap fix - belt and braces. Whatever brought us
        // to the foreground (launcher icon, notification body tap, recents),
        // ask PhoneService for pairing requests that are STILL pending and
        // raise the dialog for them. Covers the window between the arrival
        // broadcast (which fires when we may not be listening) and the
        // 30 s auto-decline.
        resurfacePendingPairings()

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
        // Round-? — block ONLY on a genuinely-missing RUNTIME permission,
        // mirroring onCreate and the Refresh button. SPECIAL-only items
        // (notification_listener / battery_optimization / auto_revoke) are
        // re-flagged by aggressive OEMs after backgrounding even though the
        // runtime grants are intact; gating onResume on the raw isNotEmpty()
        // re-blocked the user on every reopen. A SPECIAL-only audit must
        // fall through to the all-clear path below (which either resumes the
        // main pane or — if we were stuck on the pane — plays the success
        // animation, exactly like the Refresh button's !stillRuntimeMissing
        // branch).
        val missing = PermissionChecker.checkAll(this)
        val runtimeMissing = missing.any { it.kind == PermissionChecker.Kind.RUNTIME }
        if (runtimeMissing) {
            android.util.Log.d("MainActivity", "onResume: runtime permissions missing (${missing.filter { it.kind == PermissionChecker.Kind.RUNTIME }.map { it.id }})")
            if (!inPermissionsRequiredPane) {
                // We were on the main pane — Android revoked a RUNTIME
                // permission in the background. Tear down the service-bound
                // state and switch to the blocking pane.
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

        // Start-vs-bind. Dispatch #9: userStopped gating removed (see
        // field-site tombstone) — the single-button "Disconnect and refresh"
        // UX never leaves the service intentionally down, so onResume can
        // always auto-restart.
        //
        // T-PHONE-FIRST-SIGNIN-NO-AUTODIAL: this used to be two independent
        // `if`s, the second of which bind-auto-created an UNSTARTED service
        // while the battery-exemption dialog was still up, permanently
        // disabling the first one via its `!serviceBound` guard. The
        // decision now lives in one pure function keyed on
        // PhoneService.isStarted. Do not reintroduce a bare BIND_AUTO_CREATE
        // here.
        val startDecision = PhoneServiceStartPolicy.decide(
            PhoneServiceStartPolicy.Inputs(
                hasPermissions = hasPermissions(),
                batteryExempt = isBatteryOptimizationDisabled(),
                serviceStarted = PhoneService.isStarted,
                serviceBound = serviceBound,
            )
        )
        android.util.Log.d("MainActivity", "onResume start decision: $startDecision")
        when (startDecision) {
            PhoneServiceStartPolicy.Action.START_AND_BIND -> {
                statusText.text = getString(R.string.status_starting)
                startPhoneService()
            }
            PhoneServiceStartPolicy.Action.BIND_ONLY -> {
                val intent = Intent(this, PhoneService::class.java)
                bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            }
            PhoneServiceStartPolicy.Action.NONE -> Unit
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
            // API 35 edge-to-edge — same treatment as the main pane. Pads the
            // permissions scroll content so the wordmark clears the status bar
            // and the bottom buttons (Continue / Refresh) clear the nav bar.
            WindowCompat.setDecorFitsSystemWindows(window, false)
            InsetsUtils.applySystemBarInsets(findViewById(R.id.permsContentContainer))
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
        // vc65 — the painter moved to PermissionRows so Settings >
        // Permissions renders the identical row. Passing no onRowTap
        // keeps this screen's behaviour exactly as it was: granted rows
        // inert, missing rows opening item.intent.
        PermissionRows.bind(this, container, items)
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

    override fun onPause() {
        super.onPause()
        // v18 — unregister the pairing-foreground receiver. The notification
        // path stays live, so a user who backgrounds mid-prompt still gets
        // the heads-up and the shade entry as usual.
        //
        // v56 — the request is a view inside the hero card now, not a window,
        // so there is nothing here that can leak a token or throw
        // BadTokenException. The card is deliberately LEFT on its request
        // face across a pause: the request is still pending on the relay, and
        // a user who glances away should find it where they left it.
        unregisterPairingForegroundReceiver()
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
            // P5b (c)/(d). RECEIVER_NOT_EXPORTED below matters more for these
            // two than for anything above it: an exported SAS_REQUIRED would
            // let any app on the phone put six digits of its choosing in front
            // of the user, which is the whole ballgame.
            addAction(E2eSasContract.ACTION_E2E_SAS_REQUIRED)
            addAction(PhoneService.ACTION_PAIRING_E2E_REFUSED)
            addAction(E2eTofuContract.ACTION_E2E_KEY_CHANGED)
            addAction(E2eTofuContract.ACTION_E2E_STATE)
        }
        // F-3: NOT_EXPORTED on EVERY API level, not just 33+. The bare
        // API 26-32 branch that used to live here left ACTION_E2E_SAS_REQUIRED
        // open to any app on the device.
        ContextCompat.registerReceiver(
            this, pairingForegroundReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
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
        if (pairingRequestDialogId == pairingId &&
            ::heroRequestFace.isInitialized && heroRequestFace.visibility == View.VISIBLE) {
            android.util.Log.d("MainActivity", "showPairingRequestDialog: already showing for $pairingId")
            return
        }
        if (!::heroRequestFace.isInitialized) {
            android.util.Log.d("MainActivity", "showPairingRequestDialog: hero not inflated yet, skipping")
            return
        }

        // v56 — the request now swaps the HERO CARD's contents instead of
        // raising a modal (DIRECTION frame 3, note 1): same frame, same
        // position, so the user never loses context and the request does not
        // cover the presence line that explains the rest of the screen.
        //
        // What we give up by dropping the AlertDialog is setCancelable(false),
        // i.e. forcing a choice. That was never real security — the shade
        // notification has always been dismissible and the 30s auto-decline
        // in PhoneService is the actual safety net, which still applies.
        pairingRequestDialogId = pairingId
        pairedComputerName = identity.takeIf { it.isNotBlank() }

        // `identity` is the relay's composed browser label, typically
        // "DESKTOP-4K2 · Chrome on Windows". Split on the separator so the
        // device name can be the hero and the rest the supporting line; if it
        // does not split, the whole string is the name and the meta is hidden
        // rather than padded with a placeholder.
        val parts = identity.split(" · ", " - ", limit = 2).map { it.trim() }
        requestName.text = parts.firstOrNull()?.takeIf { it.isNotEmpty() }
            ?: getString(R.string.pair_request_default_name)
        val meta = parts.getOrNull(1)?.takeIf { it.isNotEmpty() }
        requestMeta.text = meta.orEmpty()
        requestMeta.visibility = if (meta == null) View.GONE else View.VISIBLE
        requestAvatar.text = initialsFor(requestName.text?.toString())

        heroDefaultFace.visibility = View.GONE
        heroRequestFace.visibility = View.VISIBLE

        // TalkBack: move focus to the request and announce it, because the
        // card changed underneath the user rather than a new window opening.
        heroRequestFace.announceForAccessibility(
            getString(R.string.pair_request_body_template, requestName.text)
        )
        heroRequestFace.sendAccessibilityEvent(
            android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED
        )
        android.util.Log.d("MainActivity", "Pairing request surfaced in hero card for $pairingId")
    }

    /**
     * Put the hero card back on its default face. Called when the user
     * decides, when the relay cancels, and when the request times out.
     */
    private fun hidePairingRequest() {
        if (!::heroRequestFace.isInitialized) return
        heroRequestFace.visibility = View.GONE
        // Never uncover the default face while the SAS is up: the SAS replaces
        // the request face, and a stray hidePairingRequest() (the relay
        // cancelling the request we already accepted, the 30 s timer) would
        // otherwise dismiss a blocking security prompt as a side effect.
        if (sasPairingId == null) heroDefaultFace.visibility = View.VISIBLE
        pairingRequestDialogId = null
    }

    /**
     * P5b (c) — put the six-digit SAS on the hero card and block on the answer.
     *
     * "Blocking" here is a property of the whole screen, not of a dialog:
     *  - there is no dismiss affordance and no scrim to tap through;
     *  - [onBackPressedDispatcher] swallows Back while it is up;
     *  - [hidePairingRequest] refuses to uncover the default face underneath
     *    it;
     *  - the only exits are the two buttons and the pairing being cancelled
     *    from the other end.
     * A SAS a user can wave away verifies nothing, and "Doesn't match" is
     * precisely the answer an attacker needs the user never to be asked for.
     *
     * A malformed payload is REFUSED, not rendered. Six digits is §13.3; if
     * what arrived is not six digits then something upstream is wrong, and
     * showing the user an arbitrary string to compare would teach them to
     * confirm whatever they are shown.
     */
    private fun showSasConfirm(pairingId: String, digits: String) {
        if (isFinishing || isDestroyed) return
        if (!::heroSasFace.isInitialized) {
            android.util.Log.d("MainActivity", "showSasConfirm: hero not inflated yet, skipping")
            return
        }
        if (!E2eSasContract.isWellFormed(digits)) {
            android.util.Log.w(
                "MainActivity",
                "showSasConfirm: refusing a malformed SAS payload for $pairingId"
            )
            dispatchSasVerdict(matched = false, pairingIdOverride = pairingId)
            return
        }

        sasPairingId = pairingId
        // M-A6-5 / SPEC §13.3 R-BK: the VISIBLE code is ungrouped and identical
        // to what the page dialog shows, so the two surfaces are one exact
        // string compare. The SPOKEN description spells the same digits out
        // one at a time — a screen-reader user must be comparing the same
        // string a sighted user is, and neither "41290" nor "412 90" is read
        // as digits by TalkBack. Both come from E2eSasContract, one door each.
        val rendered = E2eSasContract.render(digits)
        val code = findViewById<TextView>(R.id.homeSasCode)
        code.text = rendered
        code.contentDescription = getString(R.string.e2e_sas_code_a11y, E2eSasContract.spoken(digits))

        heroRequestFace.visibility = View.GONE
        heroDefaultFace.visibility = View.GONE
        heroSasFace.visibility = View.VISIBLE
        sasBackCallback?.isEnabled = true

        heroSasFace.announceForAccessibility(
            "${getString(R.string.e2e_sas_prompt)} ${code.contentDescription}"
        )
        code.sendAccessibilityEvent(
            android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED
        )
        // vc67 T-SAS-GATE-TIMEOUT-30S — tell the service the digits reached a
        // SCREEN, which is the fact it cannot observe for itself and the only
        // thing that earns the long deadline. Sent LAST, after the malformed
        // refusal and after the hero face is visible, so the ack means "a human
        // can see these", not "an intent was delivered".
        sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_SHOWN).apply {
                setPackage(packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, pairingId)
            }
        )
        android.util.Log.d("MainActivity", "SAS confirm surfaced for $pairingId")
    }

    /** Take the SAS face down and restore the card's default face. */
    private fun hideSasConfirm() {
        if (!::heroSasFace.isInitialized) return
        heroSasFace.visibility = View.GONE
        heroDefaultFace.visibility = View.VISIBLE
        sasPairingId = null
        sasBackCallback?.isEnabled = false
    }

    /**
     * Send the user's answer back to the Accept path.
     *
     * Both answers travel the same broadcast with one boolean between them.
     * On `false` the service takes its EXISTING refusal path (latch +
     * broadcastE2eRefusal) — no refusal logic is written here, because "the
     * user says the codes differ" is the same outcome as "the peer could not
     * give us an encrypted pairing" and a second implementation of it is a
     * second thing to get wrong.
     */
    private fun dispatchSasVerdict(matched: Boolean, pairingIdOverride: String? = null) {
        val id = pairingIdOverride ?: sasPairingId ?: return
        hideSasConfirm()
        // Optimistic, and corrected by the service's ACTION_E2E_STATE if it
        // disagrees. A confirmed SAS means this pair IS encrypted and
        // verified; waiting a round trip to say so would leave the status line
        // reading "Not encrypted" for the moment right after the user
        // personally verified it, which reads as the check having failed.
        e2eState = if (matched) {
            E2eStatusCopy.State.ENCRYPTED_VERIFIED
        } else {
            E2eStatusCopy.State.PLAINTEXT
        }
        sendBroadcast(
            Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
                setPackage(packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, id)
                putExtra(E2eSasContract.EXTRA_SAS_MATCHED, matched)
            }
        )
        if (!matched) {
            // Say what happened immediately rather than waiting for the
            // service's refusal broadcast to make the round trip. A user who
            // taps "Doesn't match" and sees nothing change assumes the tap
            // missed and tries again — and retrying is what an attacker needs.
            showE2eRefusal(getString(R.string.e2e_sas_refused))
        }
        android.util.Log.d("MainActivity", "SAS verdict for $id: matched=$matched")
    }

    /**
     * Surface an encrypted-pairing refusal.
     *
     * Until P5b nothing in the UI listened for
     * [PhoneService.ACTION_PAIRING_E2E_REFUSED] at all: the service broadcast
     * the user-facing copy and it went nowhere, so a refused encrypted pairing
     * looked to the user exactly like a connection that never arrived. That is
     * the worst possible reading of a security refusal — it is indistinguishable
     * from a bug, and the obvious response to a bug is to try again.
     *
     * Rendered in the hero card's own error line, never as "disconnected": the
     * phone is fine, the relay is fine, and this pairing was refused on purpose.
     */
    /**
     * P5b (d) — this computer's key is not the one the phone saw last time.
     *
     * Blocking for the same reasons the SAS is, and reusing the same Back
     * callback: both faces are questions the user must answer, and a second
     * mechanism for the second question would be a second thing to get wrong.
     *
     * "One-time" is not enforced here. Only the Accept path knows whether this
     * key has already been trusted, so it decides whether to ask at all;
     * remembering in the UI would mean the question stopped being asked
     * whenever the Activity was not running, which is most of the time.
     */
    private fun showKeyChangeWarning(pairingId: String) {
        if (isFinishing || isDestroyed) return
        if (!::heroKeyChangeFace.isInitialized) {
            android.util.Log.d("MainActivity", "showKeyChangeWarning: hero not inflated, skipping")
            return
        }
        keyChangePairingId = pairingId

        heroRequestFace.visibility = View.GONE
        heroSasFace.visibility = View.GONE
        heroDefaultFace.visibility = View.GONE
        heroKeyChangeFace.visibility = View.VISIBLE
        sasBackCallback?.isEnabled = true

        heroKeyChangeFace.announceForAccessibility(
            "${getString(R.string.e2e_key_change_title)}. " +
                getString(R.string.e2e_key_change_body)
        )
        findViewById<TextView>(R.id.homeKeyChangeTitle).sendAccessibilityEvent(
            android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED
        )
        android.util.Log.d("MainActivity", "Key-change warning surfaced for $pairingId")
    }

    /** Take the key-change face down and restore the card's default face. */
    private fun hideKeyChangeWarning() {
        if (!::heroKeyChangeFace.isInitialized) return
        heroKeyChangeFace.visibility = View.GONE
        heroDefaultFace.visibility = View.VISIBLE
        keyChangePairingId = null
        if (sasPairingId == null) sasBackCallback?.isEnabled = false
    }

    /**
     * Send the user's key-change answer.
     *
     * "Not now" is a REFUSAL, not a cancel: the key is not pinned and the
     * pairing does not continue. It is deliberately not called "Later", because
     * the user is declining to trust a key and the button should say so.
     */
    private fun dispatchKeyChangeVerdict(trusted: Boolean) {
        val id = keyChangePairingId ?: return
        hideKeyChangeWarning()
        sendBroadcast(
            Intent(E2eTofuContract.ACTION_E2E_KEY_CHANGE_RESULT).apply {
                setPackage(packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, id)
                putExtra(E2eTofuContract.EXTRA_TRUSTED, trusted)
            }
        )
        android.util.Log.d("MainActivity", "Key-change verdict for $id: trusted=$trusted")
    }

    private fun showE2eRefusal(message: String) {
        hideSasConfirm()
        val error = findViewById<TextView>(R.id.connectionErrorText)
        error.text = message
        error.visibility = View.VISIBLE
        error.announceForAccessibility(message)
    }

    /**
     * Up to two letters for the request avatar. "DESKTOP-4K2" reads as "DE",
     * "Dennis PC" as "DP". Falls back to the mark's own "PC" when the name is
     * unusable, which is also what the mockup shows.
     */
    private fun initialsFor(name: String?): String {
        val words = name.orEmpty()
            .split(' ', '-', '_', '.')
            .filter { it.isNotBlank() && it.first().isLetterOrDigit() }
        return when {
            words.size >= 2 -> "${words[0].first()}${words[1].first()}".uppercase()
            words.size == 1 -> words[0].take(2).uppercase()
            else -> getString(R.string.pair_request_avatar)
        }
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
     * Put the hero card back on its default face when PAIRING_CANCELLED
     * arrives for the request currently on screen. No-op if the visible id
     * doesn't match (defensive — concurrent requests should not happen).
     */
    private fun dismissPairingDialogIfMatching(pairingId: String) {
        if (pairingRequestDialogId == pairingId) {
            android.util.Log.d("MainActivity", "Clearing pairing request card for cancelled $pairingId")
            pairedComputerName = null
            hidePairingRequest()
        }
    }

    /**
     * v56 notification-tap fix - MainActivity is launchMode=singleTop, so
     * the connection-request notification's content intent
     * (FLAG_ACTIVITY_CLEAR_TOP on a live instance) is delivered here
     * rather than re-creating the Activity.
     *
     * setIntent() so a later rotation replays the CURRENT intent, not the
     * pairing one (which would re-raise a dialog for a resolved request).
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handlePairingIntent(intent)
    }

    /**
     * Raise the Accept/Decline dialog for a pairing id carried on a
     * launch intent, but ONLY if PhoneService still has that request
     * pending. A stale intent (user tapped, walked away, the request
     * auto-declined, then they returned via recents) must not resurrect
     * a prompt for a pairing that no longer exists.
     *
     * Security note: the extras are trusted only because the intent can
     * only be constructed by our own immutable PendingIntent - and the
     * pending-check against PhoneService means even a forged extra can
     * at worst re-show a dialog for a request the service itself is
     * already tracking.
     */
    private fun handlePairingIntent(intent: Intent?) {
        val pairingId = intent?.getStringExtra(PhoneService.EXTRA_PAIRING_ID) ?: return
        if (pairingId.isBlank()) return
        // Consume it so a config change / re-delivery doesn't replay.
        intent.removeExtra(PhoneService.EXTRA_PAIRING_ID)
        val identity = intent.getStringExtra(PhoneService.EXTRA_PAIRING_IDENTITY).orEmpty()
        intent.removeExtra(PhoneService.EXTRA_PAIRING_IDENTITY)

        val service = phoneService
        if (service == null) {
            // Not bound yet (cold start through the notification). Stash it;
            // onServiceConnected -> resurfacePendingPairings() will pick the
            // request up from the service's own pending map, which is the
            // authoritative source anyway.
            android.util.Log.d("MainActivity", "handlePairingIntent: service not bound yet for $pairingId - deferring to resurface")
            return
        }
        val pending = service.getPendingPairings()
        if (!pending.containsKey(pairingId)) {
            android.util.Log.d("MainActivity", "handlePairingIntent: $pairingId no longer pending - ignoring")
            return
        }
        showPairingRequestDialog(pairingId, pending[pairingId]?.takeIf { it.isNotBlank() } ?: identity)
    }

    /**
     * Ask the bound PhoneService for every still-pending pairing request
     * and show the dialog for the first one. (The relay does not issue
     * concurrent requests to one phone; if it ever does, the remaining
     * ones stay in the shade with their own Accept/Decline actions.)
     */
    private fun resurfacePendingPairings() {
        val service = phoneService ?: return
        if (isFinishing || isDestroyed) return
        val pending = service.getPendingPairings()
        if (pending.isEmpty()) return
        val (pairingId, identity) = pending.entries.first()
        android.util.Log.d("MainActivity", "resurfacePendingPairings: re-showing dialog for $pairingId")
        showPairingRequestDialog(pairingId, identity)
    }

    override fun onDestroy() {
        super.onDestroy()
        stopStatusUpdates()
        // Drop the pulse animator so its update listener can't fire
        // on a destroyed view (no observed leak, but the listener
        // holds a strong ref to statusDotRing).
        statusPulseAnimator?.cancel()
        statusPulseAnimator = null
        // v18 — drop any stray pairing-request state and the receiver
        // registration (onPause should have done this already; defensive).
        pairingRequestDialogId = null
        unregisterPairingForegroundReceiver()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

}
