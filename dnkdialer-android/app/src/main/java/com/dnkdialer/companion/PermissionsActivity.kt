package com.dnkdialer.companion

import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat

/**
 * vc65, T-ANDROID-PERMISSIONS-SCREEN — Settings > Permissions.
 *
 * Dennis (2026-09-24, verbatim): "when i click on permissions i want it
 * to show me the full row of permissions i have allowed (like in the
 * first opening screen). Then if i click on any of them it sends me to
 * the correct setting inside the phone."
 *
 * Before this screen, the Settings row jumped straight to app info via
 * AccountActions.openAppDetails. That page is a fine DESTINATION and is
 * still where most rows land — but it is a poor ANSWER to "what have I
 * allowed", because it does not say which grants this app actually
 * cares about or why, and it says nothing at all about the special
 * accesses (notification listener, battery, hibernation) that are not
 * runtime permissions and are the ones that actually break the bridge.
 *
 * So: the same audit the first-run pane shows, in the same order, in
 * the same rows, plus a tap target on every row.
 *
 * Three deliberate non-features:
 *  - It NEVER requests a permission. No ActivityCompat.requestPermissions,
 *    no RoleManager, no default-app prompt. It navigates. A settings
 *    screen that starts firing system dialogs at you is a first-run
 *    flow wearing a disguise, and we already have one of those.
 *  - It declares no new <uses-permission>. The manifest diff for this
 *    whole lane is one <activity> element.
 *  - It does not poll and registers no receivers. [onResume] re-runs
 *    the audit once, which is exactly the moment the state can have
 *    changed: the user has just come back from a Settings page.
 */
class PermissionsActivity : AppCompatActivity() {

    private lateinit var list: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_permissions)

        // Edge-to-edge, matching Settings and Home: the page surface
        // fills behind the system bars and the scroll content is padded
        // to clear them.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        InsetsUtils.applySystemBarInsets(findViewById(R.id.permissionsContent))

        findViewById<View>(R.id.permissionsBackButton).setOnClickListener {
            onBackPressedDispatcher.onBackPressed()
        }

        list = findViewById(R.id.permissionsList)
    }

    /**
     * Re-audit on every entry, including the return from a Settings
     * page. `checkAllWithStatus` reads the OS live, so a grant the user
     * just toggled is reflected the instant they come back — which is
     * the whole reason the rows are tappable.
     */
    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val items = PermissionChecker.checkAllWithStatus(this)
        PermissionRows.bind(this, list, items) { item ->
            PermissionDeepLinks.launch(this, item.id)
        }
    }
}
