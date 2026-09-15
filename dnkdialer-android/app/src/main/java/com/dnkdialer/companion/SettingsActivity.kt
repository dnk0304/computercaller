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

    /** Guards [lobbyToggle] so a repaint from the flag can't be read as a tap. */
    private var suppressLobbyToggleCallback = false

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
