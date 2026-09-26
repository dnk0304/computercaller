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
 * v56 (decision 3 of DIRECTION-android-v56.md) moved it to DayNight
 * following the system setting.
 *
 * vc63 Amendment 1 — Dennis, 2026-09-23 12:21Z: "default mode in android
 * app should be dark mode." So the mode is PINNED to dark, not merely
 * defaulted to it: there is no theme preference and no theme selector
 * anywhere in this app (no theme key in any getSharedPreferences call),
 * so there is nothing for a user choice to override and nothing to
 * migrate. Dark is the only runtime path.
 *
 * The DayNight parent and the values-night resources STAY. Light is no
 * longer reachable at runtime, but it must stay buildable: the screenshot
 * fixtures force MODE_NIGHT_NO to capture the light set, and deleting the
 * light resources would turn that into a silent fallback rather than a
 * failure.
 *
 * Setting the mode explicitly rather than relying on the theme parent
 * matters because several OEM skins (and any earlier build that had
 * persisted a local night-mode override) can otherwise leave the delegate
 * on a stale mode for the life of the install.
 *
 * Setting it here — not in an Activity — avoids the recreate() storm you
 * get when the mode is applied after a window already exists.
 */
class CompanionApp : Application() {

    companion object {
        /**
         * The night mode this app runs in, named so a test can assert it
         * without re-running [onCreate] (which would re-register the
         * lifecycle callbacks below).
         *
         * vc63 Amendment 1 — pinned to dark. A `const` so the JVM unit test
         * can read it without loading an Android class.
         */
        const val NIGHT_MODE: Int = AppCompatDelegate.MODE_NIGHT_YES

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

        // vc63 (T-VC63-EXPORT-DIAGNOSTICS) — first thing in the process, so
        // that every Activity, Service and Receiver below can log without
        // checking whether the log exists. init() also applies the 24 h
        // retention rule to filesDir/diag and to the cached exports: doing it
        // at start (not only at export time) means an app that is never
        // exported from still cannot accumulate logs past a day.
        DiagLog.init(this)
        // vc70 sec C4: per-install HMAC key for the DiagLog package handle.
        PkgHashKey.init(this)
        DiagExport.pruneExports(this)

        AppCompatDelegate.setDefaultNightMode(NIGHT_MODE)

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
