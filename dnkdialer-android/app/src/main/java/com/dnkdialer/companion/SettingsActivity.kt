package com.dnkdialer.companion

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import com.google.android.material.switchmaterial.SwitchMaterial
import androidx.appcompat.app.AppCompatActivity

/**
 * v56 — Settings.
 *
 * Everything that used to live at the bottom of Home moved here: the lobby
 * disconnect/rejoin toggle, the on-device synced-data viewers, the
 * permission + notification deep links, Sign Out, and Hard Reset. Home is
 * now presence + the primary connection action, per
 * android-mockups/DIRECTION-android-v56.md.
 *
 * DELIBERATELY UNBOUND. This screen never binds PhoneService:
 *  - the lobby toggle fires the SAME [LobbyActionReceiver] broadcasts the
 *    ongoing notification's DISCONNECT / RECONNECT actions use, so there is
 *    exactly one code path into userDisconnectFromLobby / userRejoinLobby;
 *  - the label is driven off [TokenStore.isUserStayedDisconnected], the
 *    persistent flag that is also the service's own source of truth.
 * That keeps a settings screen from ever holding a service binding it could
 * leak, and means the toggle reads correctly even if the service was killed.
 *
 * Sign Out and Hard Reset delegate to [AccountActions] — the same
 * implementation MainActivity calls, not a copy.
 *
 * Styled in v56 step 2 to DIRECTION frames 6/7: four caps sections, flat
 * row-groups, 56dp rows, hairlines, no elevation, and no Bluetooth toggle.
 * See the header of res/layout/activity_settings.xml for the two places this
 * screen deliberately departs from the mockup and why.
 */
class SettingsActivity : AppCompatActivity() {

    /**
     * v56 step 2 — the lobby control is a switch now, not a button whose
     * label flipped between "Disconnect from Lobby" and "Rejoin Lobby". A
     * control that renames itself makes the user read it before every tap;
     * a switch shows the state and the tap is unambiguous. Same flag, same
     * broadcast, same handler.
     */
    private lateinit var lobbyToggle: SwitchMaterial
    private lateinit var enableNotificationsButton: View

    /**
     * E2E programme, P4 (s5). Part 1 is a SCAFFOLD: there is no cryptography
     * behind this switch yet, so it is always disabled and
     * [refreshEncryptedModeRow] states why. Part 2 makes it operable once the
     * paired computer's advertisement is on the wire.
     */
    private lateinit var encryptedModeToggle: SwitchMaterial
    private lateinit var encryptedModeReason: TextView

    /**
     * Guards [encryptedModeToggle] so a repaint from the stored preference
     * can't be read as a tap. Same hazard, same fix, as
     * [suppressLobbyToggleCallback].
     */
    private var suppressEncryptedModeCallback = false

    /** Guards [lobbyToggle] so a repaint from the flag can't be read as a tap. */
    private var suppressLobbyToggleCallback = false

    /** vc63 — the Export diagnostics row and its sub-line. */
    private lateinit var exportDiagnosticsRow: View
    private lateinit var exportDiagnosticsSub: TextView

    /**
     * One export at a time.
     *
     * The build runs on a worker and the row is disabled for its duration, but
     * the flag is what actually enforces the rule: `setEnabled(false)` loses a
     * tap that was already dispatched, and two concurrent builds would race on
     * the same cache directory while [DiagExport.pruneExports] deletes under
     * them. Volatile because it is written on the worker and read on main.
     */
    @Volatile
    private var exportInFlight = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Signed-out users have no settings to change and Sign Out would be
        // a no-op — bounce to the sign-in gate, same rule as MainActivity.
        if (!TokenStore.hasToken(this)) {
            android.util.Log.d("SettingsActivity", "no stored phoneToken — bouncing to SignInActivity")
            startActivity(Intent(this, SignInActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_settings)

        // Edge-to-edge, matching Home: the page surface fills behind the
        // system bars and the scroll content is padded to clear them.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        InsetsUtils.applySystemBarInsets(findViewById(R.id.settingsContent))

        findViewById<View>(R.id.settingsBackButton).setOnClickListener {
            onBackPressedDispatcher.onBackPressed()
        }

        // ---- ACCOUNT ----------------------------------------------------
        // TokenStore's "device name" is whatever the backend returned with
        // the phone token, which in practice is the signed-in account's email
        // — so this row usually shows the address the mockup shows. It is not
        // guaranteed to be one, though, so nothing here assumes an email: the
        // avatar takes the first character whatever it is, the label ellipsizes
        // in the middle so a long address keeps both ends readable, and the
        // fallback names the phone rather than inventing an identity.
        val accountName = TokenStore.getDeviceName(this)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.settings_account_unknown)
        findViewById<TextView>(R.id.settingsAccountEmail).text = accountName
        findViewById<TextView>(R.id.settingsAccountAvatar).text =
            accountName.trim().take(1).uppercase()

        findViewById<View>(R.id.settingsSignOutButton).setOnClickListener {
            // No binding held here, so no teardown lambda is needed.
            AccountActions.confirmSignOut(this)
        }

        // ---- CONNECTION -------------------------------------------------
        lobbyToggle = findViewById(R.id.settingsLobbyToggleButton)
        lobbyToggle.setOnCheckedChangeListener { _, checked ->
            if (suppressLobbyToggleCallback) return@setOnCheckedChangeListener
            // Checked == "stay disconnected", so checking it LEAVES the lobby.
            val action = if (checked) {
                LobbyActionReceiver.ACTION_DISCONNECT_LOBBY
            } else {
                LobbyActionReceiver.ACTION_REJOIN_LOBBY
            }
            android.util.Log.d("SettingsActivity", "lobby toggle -> $action")
            sendBroadcast(Intent(action).apply { setPackage(packageName) })
            // Optimistic repaint. PhoneService flips the persistent flag on
            // the broadcast; refreshing again in onResume reconciles if the
            // service was dead and the broadcast went nowhere.
            lobbyToggle.postDelayed({ refreshLobbyToggleLabel() }, 250)
        }

        encryptedModeToggle = findViewById(R.id.settingsEncryptedModeToggle)
        encryptedModeReason = findViewById(R.id.settingsEncryptedModeReason)
        // P5b (b) — the switch is OPERABLE now, but only ever in the one state
        // where operating it is honest: PEER_SUPPORTED. In every other state
        // refreshEncryptedModeRow() disables it, and a disabled SwitchMaterial
        // does not deliver onCheckedChanged, so the Part 1 guarantee ("an inert
        // switch never stores a preference") is preserved by the platform
        // rather than by the absence of a listener.
        //
        // suppressEncryptedModeCallback exists for the same reason
        // suppressLobbyToggleCallback does: refreshEncryptedModeRow() assigns
        // isChecked on every onResume, and an assignment fires the listener.
        // Without the guard, merely opening Settings would rewrite the
        // preference — a no-op today and a real bug the moment the write has a
        // side effect.
        encryptedModeToggle.setOnCheckedChangeListener { _, isChecked ->
            if (suppressEncryptedModeCallback) return@setOnCheckedChangeListener
            E2eSettings.setEncryptedModeEnabled(this, isChecked)
            // The mode of a LIVE pair is latched at Accept (B6), so this switch
            // changes the next pairing, not the current one. Saying so beats
            // letting the user believe an active session just changed shape.
            encryptedModeReason.text = getString(
                if (isChecked) R.string.settings_encrypted_mode_on_next_pair
                else R.string.settings_encrypted_mode_off_next_pair
            )
            announceEncryptedModeState(isChecked)
        }

        // ---- ON THIS PHONE ----------------------------------------------
        findViewById<View>(R.id.settingsViewMessagesButton).setOnClickListener {
            startActivity(
                Intent(this, SyncedDataActivity::class.java).putExtra("tab", "messages")
            )
        }
        findViewById<View>(R.id.settingsViewCallsButton).setOnClickListener {
            startActivity(
                Intent(this, SyncedDataActivity::class.java).putExtra("tab", "calls")
            )
        }
        findViewById<View>(R.id.settingsPermissionsButton).setOnClickListener {
            AccountActions.openAppDetails(this)
        }
        enableNotificationsButton = findViewById(R.id.settingsEnableNotificationsButton)
        enableNotificationsButton.setOnClickListener {
            AccountActions.openNotificationSettings(this)
        }
        findViewById<View>(R.id.settingsNotificationSettingsButton).setOnClickListener {
            AccountActions.openNotificationSettings(this)
        }

        // ---- EXPORT DIAGNOSTICS (vc63, T-VC63-EXPORT-DIAGNOSTICS) --------
        exportDiagnosticsRow = findViewById(R.id.settingsExportDiagnosticsButton)
        exportDiagnosticsSub = findViewById(R.id.settingsExportDiagnosticsSub)
        exportDiagnosticsRow.setOnClickListener { startDiagnosticsExport() }

        findViewById<View>(R.id.settingsCopyDiagIdButton).setOnClickListener {
            val id = DiagLog.diagId(this)
            val clip = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clip.setPrimaryClip(android.content.ClipData.newPlainText("ComputerCaller diagnostics ID", id))
            // API 33+ shows its own clipboard confirmation; a toast on top of
            // it is a double notice, so the toast is suppressed there.
            if (android.os.Build.VERSION.SDK_INT < 33) {
                android.widget.Toast.makeText(this, R.string.diag_id_copied, android.widget.Toast.LENGTH_SHORT).show()
            }
            DiagLog.d("SettingsActivity", "diagId copied to clipboard")
        }

        // ---- TROUBLESHOOTING --------------------------------------------
        findViewById<View>(R.id.settingsHardResetButton).setOnClickListener {
            AccountActions.confirmHardReset(this)
        }

        findViewById<TextView>(R.id.settingsFooter).text =
            getString(R.string.settings_footer, BuildConfig.VERSION_NAME)
    }

    override fun onResume() {
        super.onResume()
        refreshLobbyToggleLabel()
        refreshNotificationRow()
        refreshEncryptedModeRow()
    }

    /**
     * vc63 — build the diagnostics archive and raise the share sheet.
     *
     * Runs on a one-shot thread rather than a pool or a coroutine: the module
     * has no coroutine dependency, the work happens at most once per user tap,
     * and the thread is gone before the chooser is dismissed. It reads logcat
     * and zips up to ~3 MiB, so it is categorically not main-thread work.
     *
     * The failure path is the interesting one. This feature exists because a
     * user was already having a bad day; a crash here would be the second
     * thing that went wrong today and would take the evidence with it. So the
     * whole build is wrapped, the failure is a toast plus a DiagLog.e line
     * (which lands in the NEXT export), and the row is always re-enabled —
     * including when the Activity is finishing, where posting to the view
     * would otherwise silently drop the re-enable and leave a dead row behind
     * for the next onResume.
     */
    private fun startDiagnosticsExport() {
        if (exportInFlight) return
        exportInFlight = true
        exportDiagnosticsRow.isEnabled = false
        exportDiagnosticsSub.setText(R.string.diag_export_preparing)
        DiagLog.d("SettingsActivity", "diag export started")
        Thread({
            var zip: java.io.File? = null
            var failure: Throwable? = null
            try {
                zip = DiagExport.build(this)
            } catch (t: Throwable) {
                failure = t
            }
            val built = zip
            val err = failure
            runOnUiThread {
                exportInFlight = false
                exportDiagnosticsRow.isEnabled = true
                exportDiagnosticsSub.setText(R.string.row_export_diag_sub)
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (built == null) {
                    // Class name only: an IOException's message can carry a
                    // path, and a path can carry a user name.
                    DiagLog.e("SettingsActivity", "diag export failed cls=" + (err?.javaClass?.simpleName ?: "null"))
                    android.util.Log.e("SettingsActivity", "diagnostics export failed", err)
                    android.widget.Toast.makeText(this, R.string.diag_export_failed, android.widget.Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                try {
                    DiagLog.d("SettingsActivity", "diag export ready bytes=" + built.length())
                    startActivity(DiagExport.shareIntent(this, built, DiagLog.diagId(this)))
                } catch (t: Throwable) {
                    DiagLog.e("SettingsActivity", "diag share failed cls=" + t.javaClass.simpleName)
                    android.widget.Toast.makeText(this, R.string.diag_export_failed, android.widget.Toast.LENGTH_LONG).show()
                }
            }
        }, "diag-export").start()
    }

    /**
     * Paint the "Encrypted mode" row from [E2ePeerCapability].
     *
     * P4.1: the provider now tells the truth. It reads the last `e2e`
     * advertisement persisted for the paired or pending computer, so
     * [E2ePeerCapability.State.PEER_SUPPORTED] — and therefore an operable
     * switch — is reachable on a real device. Until P4.1 it was not, and this
     * row shipped a control no user could ever turn on.
     *
     * The switch's checked state is read from [E2eSettings] (this device's
     * local preference, C-1) and NEVER from the server. It is set with the
     * listener absent — there is no listener in Part 1 — so a repaint can
     * never be mistaken for a tap, the same hazard [suppressLobbyToggleCallback]
     * exists to guard above.
     *
     * A disabled control always carries its reason. A greyed switch with no
     * explanation is the thing users file bugs about.
     */
    private fun refreshEncryptedModeRow() {
        if (!::encryptedModeToggle.isInitialized) return
        val state = E2ePeerCapability.current(this)
        val enabled = E2ePeerCapability.isToggleEnabled(state)

        encryptedModeToggle.isEnabled = enabled
        // Assigning isChecked fires the listener; the guard makes this a
        // repaint rather than a user action. See suppressEncryptedModeCallback.
        suppressEncryptedModeCallback = true
        encryptedModeToggle.isChecked = enabled && E2eSettings.isEncryptedModeEnabled(this)
        suppressEncryptedModeCallback = false

        // The switch tints are a custom colour selector without a disabled
        // state, so a disabled switch is pixel-identical to an enabled one
        // that is merely off. Dim the row's text instead — otherwise the only
        // signal that the control is inert is that tapping it does nothing.
        val rowAlpha = if (enabled) 1f else 0.45f
        findViewById<TextView>(R.id.settingsEncryptedModeTitle).alpha = rowAlpha
        findViewById<TextView>(R.id.settingsEncryptedModeSub).alpha = rowAlpha
        encryptedModeToggle.alpha = rowAlpha
        encryptedModeReason.text = getString(
            when (state) {
                E2ePeerCapability.State.UNKNOWN -> R.string.settings_encrypted_mode_waiting
                E2ePeerCapability.State.PEER_UNSUPPORTED -> R.string.settings_encrypted_mode_peer_old
                E2ePeerCapability.State.DEVICE_UNSUPPORTED -> R.string.settings_encrypted_mode_device_old
                E2ePeerCapability.State.PEER_SUPPORTED -> R.string.settings_encrypted_mode_ready
            }
        )

        // TalkBack reads a switch as "Encrypted mode, off. Switch." and stops.
        // On a DISABLED switch that is actively misleading: the user is told
        // what it is and not that it cannot be operated or why, and the reason
        // line is a separate node they may never reach. Fold the reason into
        // the switch's own description so the control explains itself wherever
        // focus lands.
        encryptedModeToggle.contentDescription = getString(
            R.string.settings_encrypted_mode_a11y,
            getString(R.string.row_encrypted_mode_title),
            encryptedModeReason.text.toString()
        )
    }

    /**
     * Repaint the row from the real provider.
     *
     * P5b's `capabilityOverride` seam is GONE as of P4.1: the provider tells
     * the truth now, so a test puts the row into a state by writing the
     * advertisement that produces it, not by overriding the answer. Lint
     * removed any doubt about whether the seam was production-reachable — with
     * `otherwise = NONE` the elvis read in [refreshEncryptedModeRow] was a
     * RestrictedApi error, because that read WAS production code.
     *
     * This hook remains because an instrumented test can only seed the store
     * after the Activity has already painted, so the second pass is real.
     */
    @androidx.annotation.VisibleForTesting
    internal fun refreshEncryptedModeRowForTest() = refreshEncryptedModeRow()

    /**
     * Speak the outcome of a toggle. The visible reason line changes under the
     * switch, but a change to a node that is not focused is not announced, so
     * a TalkBack user would otherwise hear "on" and never learn that "on"
     * applies to the next pairing rather than this one.
     */
    private fun announceEncryptedModeState(isChecked: Boolean) {
        encryptedModeToggle.contentDescription = getString(
            R.string.settings_encrypted_mode_a11y,
            getString(R.string.row_encrypted_mode_title),
            encryptedModeReason.text.toString()
        )
        encryptedModeToggle.announceForAccessibility(
            getString(
                if (isChecked) R.string.settings_encrypted_mode_on_next_pair
                else R.string.settings_encrypted_mode_off_next_pair
            )
        )
    }

    /**
     * Label the lobby toggle off the persistent flag, exactly like
     * MainActivity.refreshLobbyToggleLabel() does — so Home and Settings can
     * never disagree about which way the toggle points.
     */
    private fun refreshLobbyToggleLabel() {
        if (!::lobbyToggle.isInitialized) return
        val stayedOut = TokenStore.isUserStayedDisconnected(this)
        if (lobbyToggle.isChecked != stayedOut) {
            suppressLobbyToggleCallback = true
            lobbyToggle.isChecked = stayedOut
            suppressLobbyToggleCallback = false
        }
    }

    /**
     * The "Enable notifications" call-to-action only makes sense while
     * notifications are actually blocked at the system level. Re-checked on
     * every resume so it disappears the moment the user comes back from the
     * system settings page having granted it.
     */
    private fun refreshNotificationRow() {
        if (!::enableNotificationsButton.isInitialized) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        enableNotificationsButton.visibility =
            if (nm.areNotificationsEnabled()) View.GONE else View.VISIBLE
    }
}
