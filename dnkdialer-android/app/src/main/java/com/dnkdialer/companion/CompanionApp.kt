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
    override fun onCreate() {
        super.onCreate()
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
    }
}
