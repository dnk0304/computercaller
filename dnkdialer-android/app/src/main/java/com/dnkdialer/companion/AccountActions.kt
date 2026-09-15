package com.dnkdialer.companion

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import android.app.AlertDialog
import androidx.core.content.ContextCompat

/**
 * v56 — the two destructive account-level actions, extracted out of
 * MainActivity so the new [SettingsActivity] can offer them WITHOUT a
 * second copy of the teardown sequence.
 *
 * Duplicating "stop the service, wipe the token, relaunch sign-in" is
 * exactly the kind of thing that drifts: one copy gets a fix, the other
 * silently keeps the bug. Both call sites now share this object and pass
 * a [beforeTeardown] lambda for whatever local state THEY hold
 * (MainActivity unbinds its ServiceConnection and stops its status poller;
 * SettingsActivity holds neither, so it passes nothing).
 *
 * Behaviour is the pre-v56 MainActivity implementation verbatim — only
 * the host moved.
 */
object AccountActions {

    /**
     * Sign Out confirmation. Two-step (Cancel / Sign out) so an accidental
     * tap does not drop the bridge mid-call.
     */
    fun confirmSignOut(activity: Activity, beforeTeardown: () -> Unit = {}) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.signout_dialog_title)
            .setMessage(R.string.signout_dialog_message)
            .setNegativeButton(R.string.signout_dialog_cancel) { d, _ -> d.dismiss() }
            .setPositiveButton(R.string.signout_dialog_confirm) { d, _ ->
                d.dismiss()
                performSignOut(activity, beforeTeardown)
            }
            .setCancelable(true)
            .show()
    }

    /**
     * Sign Out implementation.
     *   1. Stop the foreground service (ACTION_STOP -> onDestroy -> relay
     *      WebSocket close 1000, so the browser sees a clean disconnect).
     *   2. Let the caller drop its own service binding / pollers.
     *   3. Wipe the stored phoneToken.
     *   4. Launch SignInActivity with NEW_TASK | CLEAR_TASK so back cannot
     *      return to a half-signed-out pane.
     *   5. finish() the caller.
     */
    private fun performSignOut(activity: Activity, beforeTeardown: () -> Unit) {
        android.util.Log.d("AccountActions", "Sign out confirmed")
        Toast.makeText(activity, R.string.action_sign_out, Toast.LENGTH_SHORT).show()

        try {
            val stopIntent = Intent(activity, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            activity.stopService(stopIntent)
        } catch (e: Exception) {
            android.util.Log.w("AccountActions", "stopService threw during sign-out: ${e.message}")
        }
        try {
            beforeTeardown()
        } catch (e: Exception) {
            android.util.Log.w("AccountActions", "beforeTeardown threw during sign-out: ${e.message}")
        }

        try {
            TokenStore.clear(activity)
            android.util.Log.d("AccountActions", "TokenStore cleared")
        } catch (e: Exception) {
            android.util.Log.e("AccountActions", "TokenStore.clear threw — proceeding to SignIn anyway", e)
        }

        val signInIntent = Intent(activity, SignInActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        activity.startActivity(signInIntent)
        activity.finish()
    }

    /**
     * Hard Reset confirmation. The positive action is tinted red after
     * show() — AlertDialog has no builder-level "destructive" style.
     */
    fun confirmHardReset(activity: Activity, beforeTeardown: () -> Unit = {}) {
        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.hard_reset_dialog_title)
            .setMessage(R.string.hard_reset_dialog_message)
            .setNegativeButton(R.string.hard_reset_dialog_cancel) { d, _ -> d.dismiss() }
            .setPositiveButton(R.string.hard_reset_dialog_confirm) { d, _ ->
                d.dismiss()
                performHardReset(activity, beforeTeardown)
            }
            .setCancelable(true)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(
                ContextCompat.getColor(activity, R.color.dot_failed)
            )
        }
        dialog.show()
    }

    /**
     * Hard Reset implementation — ActivityManager.clearApplicationUserData(),
     * the OS-level equivalent of Settings > Apps > ComputerCaller > Storage >
     * Clear data. The OS kills our process partway through the call, so any
     * code after it is best-effort. On a false return we are still alive and
     * fall back to the app-details Settings deep link.
     */
    private fun performHardReset(activity: Activity, beforeTeardown: () -> Unit) {
        android.util.Log.w("AccountActions", "Hard Reset confirmed — clearing user data")
        Toast.makeText(activity, R.string.action_hard_reset, Toast.LENGTH_SHORT).show()

        try {
            beforeTeardown()
        } catch (e: Exception) {
            android.util.Log.w("AccountActions", "beforeTeardown threw during Hard Reset: ${e.message}")
        }
        try {
            val stopIntent = Intent(activity, PhoneService::class.java).apply {
                action = PhoneService.ACTION_STOP
            }
            activity.stopService(stopIntent)
        } catch (e: Exception) {
            android.util.Log.w("AccountActions", "stopService failed during Hard Reset: ${e.message}")
        }

        val ok = try {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            am.clearApplicationUserData()
        } catch (e: Exception) {
            android.util.Log.e("AccountActions", "clearApplicationUserData threw", e)
            false
        }

        if (!ok) {
            Toast.makeText(activity, R.string.hard_reset_failed, Toast.LENGTH_LONG).show()
            try {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", activity.packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                android.util.Log.e("AccountActions", "Couldn't open app-details after Hard Reset failure", e)
            }
        }
        // No finish() on the success path — clearApplicationUserData() kills
        // the process. Next launch lands on the Grant All pane with a clean
        // slate.
    }

    /** Deep-link to this app's system settings page (permissions). */
    fun openAppDetails(activity: Activity) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", activity.packageName, null)
            }
            activity.startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("AccountActions", "Couldn't open app-details", e)
        }
    }

    /** Deep-link to this app's system notification settings. */
    fun openNotificationSettings(activity: Activity) {
        try {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            }
            activity.startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.w("AccountActions", "APP_NOTIFICATION_SETTINGS unavailable — falling back to app details")
            openAppDetails(activity)
        }
    }
}
