package com.dnkdialer.companion

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
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
 * VISUALS ARE A PLACEHOLDER. res/layout/activity_settings.xml is plain but
 * fully functional; Pixel restyles it in v56 step 2. Ids are the contract.
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var lobbyToggleButton: Button
    private lateinit var enableNotificationsButton: Button

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
        InsetsUtils.applySystemBarInsets(findViewById(R.id.settingsContent))

        // ---- CONNECTION -------------------------------------------------
        lobbyToggleButton = findViewById(R.id.settingsLobbyToggleButton)
        lobbyToggleButton.setOnClickListener {
            val rejoin = TokenStore.isUserStayedDisconnected(this)
            val action = if (rejoin) {
                LobbyActionReceiver.ACTION_REJOIN_LOBBY
            } else {
                LobbyActionReceiver.ACTION_DISCONNECT_LOBBY
            }
            android.util.Log.d("SettingsActivity", "lobby toggle -> $action")
            sendBroadcast(Intent(action).apply { setPackage(packageName) })
            // Optimistic repaint. PhoneService flips the persistent flag on
            // the broadcast; refreshing again in onResume reconciles if the
            // service was dead and the broadcast went nowhere.
            lobbyToggleButton.postDelayed({ refreshLobbyToggleLabel() }, 250)
        }

        // ---- SYNCED DATA ------------------------------------------------
        findViewById<Button>(R.id.settingsViewMessagesButton).setOnClickListener {
            startActivity(
                Intent(this, SyncedDataActivity::class.java).putExtra("tab", "messages")
            )
        }
        findViewById<Button>(R.id.settingsViewCallsButton).setOnClickListener {
            startActivity(
                Intent(this, SyncedDataActivity::class.java).putExtra("tab", "calls")
            )
        }

        // ---- PERMISSIONS ------------------------------------------------
        findViewById<Button>(R.id.settingsPermissionsButton).setOnClickListener {
            AccountActions.openAppDetails(this)
        }
        enableNotificationsButton = findViewById(R.id.settingsEnableNotificationsButton)
        enableNotificationsButton.setOnClickListener {
            AccountActions.openNotificationSettings(this)
        }
        findViewById<Button>(R.id.settingsNotificationSettingsButton).setOnClickListener {
            AccountActions.openNotificationSettings(this)
        }

        // ---- ACCOUNT ----------------------------------------------------
        findViewById<Button>(R.id.settingsSignOutButton).setOnClickListener {
            // No binding held here, so no teardown lambda is needed.
            AccountActions.confirmSignOut(this)
        }

        // ---- TROUBLESHOOTING --------------------------------------------
        findViewById<Button>(R.id.settingsHardResetButton).setOnClickListener {
            AccountActions.confirmHardReset(this)
        }

        // Keep the subtitle resolvable for Pixel's restyle pass even though
        // nothing binds it dynamically.
        findViewById<TextView>(R.id.settingsHardResetSubtitle)
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
        if (!::lobbyToggleButton.isInitialized) return
        lobbyToggleButton.text = if (TokenStore.isUserStayedDisconnected(this)) {
            getString(R.string.action_rejoin_lobby)
        } else {
            getString(R.string.action_disconnect_lobby)
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
