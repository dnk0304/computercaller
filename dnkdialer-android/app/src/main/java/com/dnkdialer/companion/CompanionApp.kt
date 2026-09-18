package com.dnkdialer.companion

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate

/**
 * v56 — Application entry point.
 *
 * Exists for one reason: to pin the day/night mode ONCE, in process
 * startup, before any Activity inflates a layout.
 *
 * Pre-v56 the app was dark-only (a Theme.MaterialComponents Dark parent).
 * Decision 3 of DIRECTION-android-v56.md ships light AND dark following
 * the system setting. Setting MODE_NIGHT_FOLLOW_SYSTEM explicitly rather
 * than relying on the DayNight default matters because several OEM skins
 * (and any earlier build that had persisted a local night-mode override)
 * can otherwise leave the delegate on a stale mode for the life of the
 * install.
 *
 * Setting it here — not in an Activity — avoids the recreate() storm you
 * get when the mode is applied after a window already exists.
 */
class CompanionApp : Application() {

    companion object {
        /**
         * FT-2 — is any Activity of ours resumed right now?
         *
         * Drives ONE thing: whether [PhoneService] also raises the in-app
         * file-offer dialog on top of the notification. The notification fires
         * either way, so a wrong answer here costs a dialog and never the
         * prompt itself — which is why a simple resumed-count is enough and
         * ProcessLifecycleOwner (another dependency, another lint item) is not
         * worth adding for it.
         *
         * Tracked in the Application rather than in an Activity so that FT-2
         * does not have to touch MainActivity, which another lane owns.
         */
        @Volatile
        @JvmStatic
        var isInForeground: Boolean = false
            private set
    }

    override fun onCreate() {
        super.onCreate()
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            private var resumed = 0
            override fun onActivityResumed(activity: android.app.Activity) {
                resumed++
                isInForeground = true
            }

            override fun onActivityPaused(activity: android.app.Activity) {
                resumed = (resumed - 1).coerceAtLeast(0)
                isInForeground = resumed > 0
            }

            override fun onActivityCreated(a: android.app.Activity, b: android.os.Bundle?) = Unit
            override fun onActivityStarted(a: android.app.Activity) = Unit
            override fun onActivityStopped(a: android.app.Activity) = Unit
            override fun onActivitySaveInstanceState(a: android.app.Activity, b: android.os.Bundle) = Unit
            override fun onActivityDestroyed(a: android.app.Activity) = Unit
        })
    }
}
