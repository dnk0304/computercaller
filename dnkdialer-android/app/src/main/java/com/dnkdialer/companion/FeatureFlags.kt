package com.dnkdialer.companion

/**
 * Compile-time feature flags.
 *
 * These are `const val` so the Kotlin compiler folds the branches away —
 * a disabled feature costs nothing at runtime, and the code it guards
 * stays compiled, type-checked and reviewable rather than rotting in a
 * branch nobody rebases.
 */
object FeatureFlags {

    /**
     * v56 — phone-side UI for the "Speak through PC" (Bluetooth HFP / SCO)
     * call-audio route.
     *
     * Dennis, 2026-09-15 13:39: "We can also remove the bluetooth toggle in
     * the settings as we dont need that for now." Deliberately DORMANT, not
     * deleted: v57 may restore it, and deleting the BLUETOOTH_CONNECT
     * permission surfacing would mean re-deriving it from scratch.
     *
     * What this flag turns off: the BLUETOOTH_CONNECT rows in
     * [PermissionChecker] (both the status list and the missing-permission
     * list), which were the only phone-side surface for PC audio.
     *
     * What it does NOT touch — and must not: the relay protocol. The web
     * app still offers PC audio (797fe09), and PhoneService's
     * AUDIO_CONNECT / AUDIO_STATUS / AUDIO_DISCONNECT handling plus
     * applyBluetoothSco() / setAudioRoute() stay fully live. Without the
     * runtime grant the SCO calls throw SecurityException, which those
     * paths already catch and log. HELLO and PERMISSIONS_STATUS frames are
     * unchanged.
     */
    const val PC_AUDIO_UI_ENABLED = false
}
