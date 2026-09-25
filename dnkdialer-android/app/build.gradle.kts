import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Load signing config from keystore.properties (gitignored). The file lives
// at the project root next to settings.gradle.kts, not in the app/ dir, so
// the deploy box can drop one file in without touching source.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "com.dnkdialer.companion"
    compileSdk = 36

    defaultConfig {
        // NOTE: applicationId is the Play Store package name and is
        // PERMANENT once published. Decide before first Play Console upload
        // whether to rename to com.computercaller.companion for brand
        // alignment. (Ken dispatch #14, 2026-05-24.)
        applicationId = "com.dnkdialer.companion"
        minSdk = 26
        targetSdk = 36
        // versionCode: monotonically increasing integer — bump every new APK
        // shipped (debug or release). Play Store requires strictly higher
        // than the highest one already on the track.
        // versionName: human-readable; Play Console shows this on listing.
        // Dispatch #29 (2026-05-25): 16 → 17 for the Phase 4 finish —
        // PhoneServer.kt deleted, MainActivity LAN-IP/QR plate stripped,
        // Sign Out wiring, exponential-backoff relay reconnect, and the
        // permissions-pane refresh-button-advance fix Dennis hit on v16.
        // Connect+Accept pivot (2026-05-25): 17 → 18. Phone no longer
        // auto-enters active room on launch — lands in LOBBY, browser must
        // click Connect, user must Accept on phone. Exponential-backoff
        // ripped out; replaced with simple 5s lobby-only reconnect.
        // Permissions UI redesigned as live checklist (all permissions
        // visible with status icons) instead of missing-only list.
        // Status-display fix (2026-05-25): 18 → 19. Post-Accept the
        // in-activity status line was stuck on "Lobby — waiting for
        // browser to connect" because updateStatus() was gated on a
        // browserCount field the relay no longer populates (BROWSER_STATUS
        // was replaced by PAIRING_ACTIVE/PAIRING_TERMINATED in v18). New
        // isPairActive flag on PhoneService tracks the lifecycle and the
        // status line now picks the right copy.
        // Disconnect button (2026-05-25): 19 → 20. New "Disconnect" button
        // above Sign Out lets the user terminate the current active pair
        // without signing out — phone stays signed in + connected to the
        // relay (returns to lobby state), browser flips back to "Phone in
        // lobby — ready to pair". Wire frame: LEAVE_ACTIVE:{} (matches the
        // browser-side outbound). Visible only while a pair is active.
        // Incoming-call "Unknown" fix (2026-05-25): 20 → 21. The modern
        // TelephonyCallback.CallStateListener on Android 12+ does not
        // receive the incoming phone number — only the legacy
        // PhoneStateListener does. Previously both observers raced to flip
        // callIncomingSentRef; the modern path usually won and emitted
        // CALL_INCOMING with number="" → browser displayed "Unknown".
        // Modern-path RINGING now defers its emit via Handler.postDelayed
        // (600ms) so the legacy listener (which carries the number) wins
        // the race; the modern path only fires as a last-resort safety net.
        // Browser-side: incoming-call surfaces now show "Number hidden"
        // instead of "Unknown" when the emit lacked a number, so the
        // failure mode is visually distinct from a contact-lookup miss.
        // Diagnostic logcat upgrade: every CALL_* emission now logs
        // number=[...] state=... source=[modern|legacy] so future
        // logcat captures can pinpoint which path delivered.
        //
        // 2-mode BT audio routing (2026-05-25): 21 → 22. The 3-pill
        // AudioSourceToggle (earpiece | speaker | pc-stub) is replaced by
        // a 2-mode UX: "Speak through phone" (with nested earpiece/speaker
        // sub-toggle) and "Speak through PC" (gated by BT-HFP profile
        // connection). PC mode routes call audio over the SCO channel via
        // AudioManager.startBluetoothSco(). The phone now observes BT-HFP
        // connection state via a BluetoothHeadset profile-proxy +
        // ACTION_CONNECTION_STATE_CHANGED broadcast receiver, and pushes
        // BT_HEADSET_STATUS:{connected, deviceName} to the browser on every
        // state transition so the toggle can auto-light when the PC pairs
        // and auto-gate when it drops. New WS command shape:
        // SET_AUDIO_SOURCE:earpiece|speaker|bluetooth. Legacy SET_SPEAKER
        // remains as an alias so older browser builds still toggle the
        // speaker correctly. Permission additions: BLUETOOTH_CONNECT
        // (API 31+ runtime grant — required to read device names + call
        // getProfileProxy / registerReceiver for HFP state) plus the
        // legacy BLUETOOTH + BLUETOOTH_ADMIN with maxSdkVersion=30.
        //
        // Device label in Accept dialog (FORGE-1, 2026-05-26): 22 → 23.
        // Browser now sends a friendly `deviceLabel` field in the
        // BROWSER_REQUEST_PAIRING / PAIRING_REQUEST payload — auto-derived
        // from UA-CH + UA fallback, user-renameable in Settings. PhoneService
        // parses the new field (nullable for backward compat with older
        // browser builds), threads it into buildBrowserIdentity which now
        // prefers deviceLabel over ua+ip when present. Notification body
        // updated from "Web client at X wants to connect" to "X wants to
        // connect" so the user sees "Chrome on macOS wants to connect" or
        // their own rename rather than the raw user agent. Old browser
        // builds without deviceLabel fall through to the legacy ua+ip
        // identity — no crash, just less friendly copy. New APK against
        // old web build: deviceLabel absent → generic fallback.
        //
        // Audio toggle simplified to Phone | PC (FORGE-2, 2026-05-26):
        // 23 → 24. Dennis directive: kill the nested Earpiece/Speaker
        // sub-toggle entirely; just two buttons at the top level. The
        // browser now emits SET_AUDIO_SOURCE:phone|pc (was
        // earpiece|speaker|bluetooth). applyAudioSource on this side
        // accepts the new values AND retains the legacy ones as aliases:
        //   "phone" / "earpiece"  → clear SCO + clear speakerphone
        //                           (system picks default — earpiece on
        //                           most devices for MODE_IN_COMMUNICATION)
        //   "pc" / "bluetooth"    → clear speakerphone, start BT-HFP SCO
        //   "speaker"             → legacy only (SET_SPEAKER), keeps the
        //                           phone loudspeaker path so old browser
        //                           builds emitting SET_SPEAKER still work
        // Backward compat is symmetric: new browser + v23 APK falls through
        // v23's else-warning branch (silent no-op, safe). Old browser +
        // v24 APK uses the legacy aliases (no behaviour change).
        //
        // Bundled APK v25 (2026-05-26): TWO orthogonal features in one ship
        // because they both touch PhoneService.kt + build.gradle.kts —
        // bundling avoids sequential-dispatch merge conflicts (Ken's call).
        //
        //   1. Sync-preview consolidated: GET_SYNC_ESTIMATE now accepts
        //      since/until/types and returns range-aware totals. Per Dennis
        //      pivot ("just make it available for users. If we want to cap
        //      it later, we can add a new tier."), the 2,500-row default
        //      cap on SmsHandler / CallLogsHandler / MmsHandler is REMOVED
        //      (default flipped to Int.MAX_VALUE) and the response shape
        //      drops the previously-specced cap / willTruncate fields.
        //      Phone now returns every row in the chosen range — user can
        //      see exact counts in the SyncSetupPanel before tapping Start
        //      Sync. Browser-side panel UI lands in a follow-up Pixel
        //      dispatch; this ship is the protocol + Android plumbing.
        //
        //   2. Disconnect-from-lobby: new toggle button in the main pane
        //      lets the user fully detach the phone from the relay while
        //      staying signed in. A persistent TokenStore flag
        //      (KEY_USER_STAYED_DISCONNECTED) gates all three auto-dial
        //      paths (onStartCommand ACTION_START, scheduleLobbyReconnect,
        //      reconnectToRelay) so the "stay out" intent survives app
        //      backgrounding, force-kill, OS service restart, and reboot.
        //      Sign Out implicitly clears the flag via TokenStore.clear()
        //      so a fresh sign-in starts in the connected/auto-dial state.
        //      Per Dennis 2026-05-26 23:53 GMT+2: phone was auto-rejoining
        //      lobby constantly and he wanted explicit control over it.
        //
        // Per-conversation "Older messages" (Item 2, 2026-05-27): 25 → 26.
        // SmsHandler.getMessages / getMessagesWithMms gain a `before` epoch-ms
        // upper bound; PhoneService GET_MESSAGES parses payload.before and
        // passes it through. Enables backward paging within a single thread —
        // the web client opens a conversation at the newest 25 and the "Older
        // messages" button pages older 25s by sending {address, before, limit}.
        // `before` is honoured even when an address filter is set (the address
        // short-circuit clears only the `since` lower bound). Option A page-size
        // sentinel — no count query / GET_THREAD_INFO. MMS-with-address still
        // skipped, so address-filtered paging is SMS-only (pre-existing limit).
        //
        // Notification-shade "Disconnect/Reconnect" action (2026-05-27): 26 → 27.
        // Surfaces the existing v25 userDisconnectFromLobby/userRejoinLobby
        // methods as state-aware action buttons on the persistent foreground
        // notification (via new LobbyActionReceiver). No new disconnect logic.
        //
        // Sync count-preview perf fix (2026-05-27): 27 → 28. GET_SYNC_ESTIMATE
        // now runs buildSyncEstimate + sendResponse on a background thread so the
        // cursor.count work no longer blocks the WebSocket read thread from
        // draining other inbound frames. Android-only; no web/protocol changes.
        //
        // API 34→35 target bump + edge-to-edge (2026-05-27): 28 → 29 /
        // 1.0.6 → 1.0.7. Play Store rejected v27/v28 ("must target at least
        // API level 35"). compileSdk + targetSdk 34→35 (targetSdk can't
        // exceed compileSdk). On API 35 (Android 15) edge-to-edge is
        // ENFORCED: the system no longer draws status-bar/nav-bar
        // backgrounds and android:statusBarColor / android:navigationBarColor
        // (themes.xml = @color/surface_base) are ignored — content draws
        // under the bars. The three Activity surfaces (MainActivity main +
        // permissions panes, SignInActivity) now call
        // WindowCompat.setDecorFitsSystemWindows(window, false) and attach an
        // androidx.core insets listener (see InsetsUtils.applySystemBarInsets)
        // that pads the scroll content container by systemBars()+displayCutout()
        // so the wordmark sits below the status bar and the bottom-most action
        // sits above the gesture nav bar. The opaque surface_base
        // windowBackground (bg_app_solid) continues to fill behind the bars —
        // no white gap. Robust on API 35 AND non-regressing on minSdk 26–34
        // (insets resolve to existing bar heights). windowLightStatusBar=false
        // left intact so status-bar icons stay light on the near-black surface.
        // No AGP/Gradle/Kotlin bump needed (AGP 8.13.2 supports compileSdk 35).
        //
        // Bundle C - Phase 4 Android security hardening (2026-05-28): 29 -> 30 /
        // 1.0.7 -> 1.0.8. Closes audit findings H11 (allowBackup=true ->
        // false + dataExtractionRules), H12 (usesCleartextTraffic=true ->
        // network_security_config.xml with RFC1918-only cleartext), H13
        // (release APK not minified -> R8 + isShrinkResources + populated
        // proguard-rules.pro), M3 APK side (phoneToken moved from
        // ?token= URL query to Authorization: Bearer header on WS upgrade -
        // server.js Bundle A accepts both paths), M12 (TokenStore silent
        // plaintext fallback on Keystore failure -> fail-closed with
        // EncryptedSharedPreferencesUnavailableException), M13/M14 (PII in
        // release Log.d -> BuildConfig.DEBUG-gated), L12 (incoming-connection
        // notification VISIBILITY_PUBLIC -> PRIVATE + redacted public version).
        // Deferred: TLS leaf SPKI pinning (needs backup-pin discipline).
        // v34 (2026-06-09): multi-call QUEUE Phase 1 — in-memory call registry
        // + per-call CALL_ADD/CALL_UPDATE/CALL_REMOVE events (dual-emitted
        // alongside legacy CALL_INCOMING/WAITING/ANSWERED/ENDED). Removes the
        // single-callWaitingSentRef 2-call ceiling so 3+ calls queue.
        // NOTE: versionCode jumps 32 -> 34 ON PURPOSE. versionCode 33 was
        // already consumed by the divergent apk-v33-off-v29 branch (shipped
        // computercaller-v33.apk, versionName 1.0.10). feature/saas-multiuser's
        // gradle still read 32, so 34 is the next collision-free integer.
        // Issue 1 — on-demand deeper message fetch / Path B (2026-06-11): 34 -> 35 /
        // 1.0.11 -> 1.0.12. Global (all-threads) backward paging: the web thread-list
        // "Load 500 more" button, once the client-side slice is exhausted, sends an
        // ADDRESS-LESS `before`-cursor GET_MESSAGES so the phone returns the newest
        // `limit` messages OLDER than `before` across ALL threads (WHERE DATE < before,
        // DESC). Android change is minimal: MmsHandler.getMessages gains a `before`
        // upper bound (epoch-ms, exclusive; converted to the MMS table's seconds) and
        // getMessagesWithMms threads it into the MMS path so the global page pulls older
        // MMS instead of re-returning the newest. SMS path + the address-filtered
        // per-thread path are unchanged (L97 short-circuit untouched). No protocol
        // shape change — `before` was already parsed by the v26 per-thread paging.
        // Multicall-teardown fix (2026-06-11): 35 → 36. registryOnIdle() blanket
        // callRegistry.clear() on aggregate IDLE wiped EVERY tracked call, so
        // hanging up an active call also killed the waiting call(s). Replaced
        // with per-call teardown (end only the foreground) + a 1200ms debounced
        // sweep that survives the transient IDLE of a call-waiting hang-up.
        // PATH A (no InCallService / no default-dialer — Dennis-approved).
        // isMinifyEnabled stays false (6.0MB un-minified v34/v35 lineage).
        //
        // Stale-queue + VoIP-filter consolidated fix (2026-06-12): 36 → 37.
        // A1 false-ACTIVE promotion killed (empty-number OFFHOOK while active
        // = re-assert, skipped); A2 ringing-entry expiry (65s, 10s after the
        // ambiguous RINGING→OFFHOOK-while-active transition); A3 reconcile on
        // every aggregate callback + 5s tick; A4 self-managed VoIP calls
        // (WhatsApp/Telegram: OFFHOOK, no number, no prior RINGING) ignored —
        // no registry mint, no CALL_ANSWERED.
        // v38 (1.0.15) — "Unknown thread" fix: pushNewMmsEntries no longer
        // ships a live MMS frame with the literal "Unknown" sender when the
        // ContentObserver races the messaging app's staged addr-table write;
        // the watermark is held below the unresolved row and a 3s retry
        // re-reads it once complete (60s grace, then give up + push as-is).
        // v39 (1.0.16) — perm-gate fix on the v38 base: onCreate/onResume
        // block ONLY on a genuinely-missing RUNTIME permission; SPECIAL-only
        // audits (notification_listener / battery_optimization / auto_revoke)
        // fall through to the lobby, mirroring the Refresh button. (39, not 37,
        // because v37/v38 already shipped on disk.)
        // v40 (1.0.17) — Google Play verifiability fix. Adds SyncedDataActivity:
        // an on-device viewer of the synced SMS + call log (reads SmsHandler /
        // CallLogsHandler device providers, no desktop pairing) so a Play
        // reviewer can SEE the restricted-permission feature (READ_SMS /
        // READ_CALL_LOG) on ONE phone. Read/display only — NOT default SMS
        // handler; no perm/exemption change. Built on the v39 (1929e22) lineage.
        // v41 (1.0.18) — RCS↔SMS thread merge. Inbound/sent RCS from Google/
        // Samsung Messages now resolves the sender to a canonical phone number
        // (Person tel: URI → numeric title → contacts reverse-lookup) and routes
        // through SMS_RECEIVED so it merges into the SAME thread as that contact's
        // SMS, instead of landing as a separate notification card. SIDELOAD for
        // Dennis to verify — NOT a Play upload. No new permissions. Built on the
        // v40 (9ba9d12) lineage.
        // v42 (1.0.19) — Play "Active-limbo" escape rebuild (2026-06-22). Bundle
        // 40 (1.0.17) uploaded clean but Play flagged it "Active / 1 release",
        // hiding it from the Production "Add from library" picker AND refusing to
        // render it in a release slot, so v40 could not be attached to a
        // Production release via console. Fix (Pilot): upload a FRESH,
        // never-consumed AAB with a higher versionCode so a new library bundle
        // appears cleanly and bypasses the lock. IDENTICAL code to v40 (this same
        // demo-verifiable SyncedDataActivity lineage) — NO RCS changes (the
        // untested v41 sideload on forge/rcs-sms-merge-on-v40 is deliberately
        // excluded), NO manifest / permission changes (Play permissions
        // declaration is for this exact set). 41 is skipped — reserved by the v41
        // RCS sideload test build to avoid confusion; Play's highest is 40 so 42
        // is a valid strictly-higher code. Signed with the SAME release
        // keystore/cert as v40.
        // Sign in with Google (2026-07-06): "Continue with Google" on
        // SignInActivity via AndroidX Credential Manager + GetGoogleIdOption.
        // The Google ID token is POSTed to /api/auth/apk-google-login which
        // verifies it (audience = WEB client ID) and returns the same
        // {phoneToken, deviceName} shape as /api/auth/apk-login - the existing
        // TokenStore path is reused unchanged. Email/password login remains as
        // fallback. (Was v43/1.0.20 on the worktree branch.)
        // v44 (1.0.21) - RECONCILIATION release: the divergent shipped v36-v42
        // Android line (forge/* branches) merged back into feature/saas-
        // multiuser, PLUS Google sign-in (v43), PLUS Bundle-C security
        // hardening that the side line had dropped (Bearer-capable TokenStore,
        // network_security_config, data_extraction_rules, allowBackup=false).
        // v45 (1.0.22) - Oppo/ColorOS sticky-restart fix: PhoneService
        // onStartCommand now treats the START_STICKY null-intent restart
        // (and unknown actions) as an ACTION_START-equivalent resume via the
        // shared startBridge() path — startForeground() first, then side-
        // effect wiring (now idempotent: content-observer re-registration
        // guarded), then the relay auto-dial gate. Adds a dismissible
        // ColorOS/OxygenOS hint on MainActivity (oppo/oneplus/realme) that
        // deep-links to app details settings for "Allow background
        // activity" + Auto-launch. No manifest/permission changes.
        // v50 (1.0.27) — API 35→36 target bump (Android 16) for Play Store
        // policy (Aug-31 deadline). compileSdk+targetSdk 35→36. Added
        // InsetsUtils to SyncedDataActivity (API 36 edge-to-edge is
        // non-opt-out-able — windowOptOutEdgeToEdgeEnforcement is ignored at
        // targetSdk 36, and SyncedDataActivity (added v40) was the one surface
        // still lacking insets handling). FGS type stays specialUse (not
        // dataSync → no 6h daily cap; the always-on relay is safe). No
        // AGP/Gradle/Kotlin bump (AGP 8.13.2 already supports compileSdk 36).
        // versionCode jumps 45→50 (NOT 46): Play's highest CONSUMED code on
        // com.dnkdialer.companion is 49 (versionName 1.0.26, Production 100%
        // 2026-07-13 — Pilot-confirmed). 46–49 were burned by the divergent
        // shipped line and can never be reused; 50 is the next free integer.
        // versionName follows the live 1.0.26 → 1.0.27 (1.0.23 would be a
        // cosmetic downgrade below what's live). applicationId stays
        // com.dnkdialer.companion — the July-3 com.computercaller.app rename
        // never shipped; this AAB must match the live package to update it.
        // v53 (1.0.29) — web→phone notification dismissal sync. New
        // NOTIFICATION_DISMISS command: clearing a mirrored notification in the
        // browser now cancels the real one on the handset via
        // DnkNotificationListenerService.dismissByKey. Completes the loop that
        // already ran phone→web through NOTIFICATION_REMOVED.
        // versionCode jumps 50→53 (NOT 51): apk-releases/ holds
        // computercaller-v52.aab (versionName 1.0.28, the google-signin-restore
        // line on fix/android-v52-google-signin-restore), so 51 and 52 are
        // consumed and 53 is the next collision-free integer. versionName
        // follows 1.0.28 → 1.0.29 for the same reason — 1.0.28 would collide.
        // NOTE this build descends from the 1.0.27 (v50) code line, not from
        // the divergent v52 branch; it carries no v52-only changes.
        // v54 (1.0.30) — v53 + the ONE missing cd1ee98 delta. v53 shipped
        // without cd1ee98's SignInActivity error-handling hunk (the v52 branch
        // was never merged): a non-NoCredentialException GetCredentialException
        // now logs e.type + class + message and shows signin_error_generic
        // instead of masquerading as "no Google account". v54 is therefore a
        // strict superset of v52 + v53; nothing else changed from v53.
        // CP2 PC-audio confirmation (2026-09-08): adds the
        // AUDIO_CONNECT / AUDIO_STATUS / AUDIO_DISCONNECT protocol and the
        // ACTION_SCO_AUDIO_STATE_UPDATED receiver. No google-signin changes.
        // v56 (2026-09-15) - REDESIGN wave. Notification body tap now
        // surfaces the Accept/Decline dialog (the reported bug), new
        // SettingsActivity, phone-side PC-audio surface retired behind
        // FeatureFlags.PC_AUDIO_UI_ENABLED, monochrome ic_stat_cc small
        // notification icon, DayNight theme + light/dark token sets.
        // v57 (2026-09-16) - OFFICIAL LOGO. Dennis rejected v56's branding:
        // "You have removed our official logo inside the app". ic_cc_mark (a
        // mark this repo drew) is gone; the app bar and the sign-in screen now
        // show the Play-listing artwork, cut by scripts/build-brand-lockup.ts.
        // Adds the adaptive launcher icon the app never had, a -night cut of
        // the wordmark, and a raster ic_stat_cc silhouetted from the real mark.
        // v56 was sideloaded and is SUPERSEDED — never reuse 56.
        // v58 (2026-09-17) — E2E programme, phase P4 Part 1 (SCAFFOLD ONLY).
        // Introduces the first AndroidKeyStore usage in this app (E2eKeyStore,
        // alias scheme cc-e2e-dev-v<n>-<curve>), a per-DEVICE "encrypted mode"
        // preference (E2eSettings, local truth — never read back from the
        // server, plan C-1) and its greyed-out SettingsActivity toggle. There
        // is deliberately NO cryptography yet: no ECDH, no HKDF, no AES-GCM,
        // no SAS, no sealed frames, no wire change. The curve (X25519 vs
        // P-256) is decided at Gate 1, which is why the alias carries the
        // curve name — both can coexist across the switch. Part 2 lands the
        // crypto on a later versionCode.
        // NOTE 57 -> 58 is a normal +1: v57 (1.0.33) was BUILT but never
        // uploaded to Play, so it consumed 57 and nothing else. versionCode 58
        // is consumed EXACTLY ONCE by the eventual signed release; a Play
        // rejection means 59, never a re-signed 58. P4 builds DEBUG only —
        // signing and upload are human steps (DO-NOT-AUTO-RESUME).
        // FT-MERGE-2 (c): 58 -> 59 because vc58 is CONSUMED by the signed v58
        // release (P5b (e)); per the note above a consumed code is never
        // re-signed, so the FT-2 file-transfer work ships as v59.
        // vc60 (2026-09-22): all android commits since the vc59 build 1614ad6 —
        // P4.2 (E2eDedupe forward-jump bound + observability), P4.4 (account id
        // persisted beside the token; E2ePairIdentity under the real account id),
        // P6.1c 1a/1b (DeviceKey register-on-login; SAS before accept),
        // P6.1d-A t3 (M-A6-5 one frozen SAS rendering). Signed on Security A6 FINAL.
        // vc61 (2026-09-22): v60 + BAT-1 (BatteryReporter + pure BatteryPolicy,
        // PhoneService wire-up create/HELLO/onDestroy; 37348db/4d0ed8f/7bc96ef)
        // + BAT-1b (BatteryLoopbackTest unplugged precondition, test only).
        // Signed after web deploy #2 (relay BAT-2 passthrough live first).
        // vc62 (2026-09-22): v61 + SMSMP (a76e26b: multipart SMS assembled
        // once per PDU set, PII-free diagnostics) + SMSMP-2 (bb20569: receiver
        // frame stamps wall-clock time at emit, not SMSC time — removes the
        // late-SMSC double-bubble class on web). Supersedes v61 (never installed).
        // vc63 (2026-09-23): v62 + INC-0923-A (8e6219f: E2eKeyPin fail-open for
        // an absent SW registry row; DowngradeLatch clears on local disconnect /
        // service restart only) + export diagnostics (Settings > "Export
        // diagnostics": DiagLog ring buffer, flap-storm counters, redacted zip
        // via the share sheet). Lane A (8e6219f) left this bump to this lane.
        // vc64 (2026-09-24, Ken cut, R-DE): FT picker fix (noHistory dropped), first-sign-in
        // auto-dial (PhoneServiceStartPolicy), mode-0 status broadcast. Icon unchanged (Dennis:
        // "forget the logo"). Pilot CAMERA/ZXing cleanup deferred to vc65.
        // vc69 (2026-09-25, Ken cut): launcher icon B, alert icons, file progress card + pending-offer
        // fixes, file queue, E2E account-pref (B1 latch, R2/R3, equal-rev). Base release/17.
        versionCode = 69
        versionName = "1.0.45"

        // Google OAuth WEB client ID (NOT the Android client). Credential
        // Manager's GetGoogleIdOption.serverClientId must be the web client
        // so the minted ID token's `aud` matches what the server verifies
        // (lib/google.ts checks aud == process.env.GOOGLE_CLIENT_ID).
        buildConfigField(
            "String",
            "GOOGLE_WEB_CLIENT_ID",
            "\"69483293308-lg5cnvbq9134huu1ndo94btdmf2go8uh.apps.googleusercontent.com\""
        )

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            // Bundle C (2026-05-28) - Phase 4 audit fix H13. R8 minification
            // strips dead code + obfuscates names; isShrinkResources strips
            // unreferenced resources discovered by minification. Together
            // these (a) shrink the release APK, (b) make reverse-engineering
            // markedly harder, and (c) discover dead code + accidentally
            // exposed symbols at build time. proguard-rules.pro carries the
            // -keep rules for Gson model classes, Java-WebSocket reflection
            // entry points, and the manifest-referenced services /
            // receivers / activities (all of which must survive R8).
            // v50 (1.0.27) FIX 2026-08-18: minify MUST stay false to match the
            // live v46-v49 production lineage (un-minified, ~6MB). The merge into
            // feature/saas-multiuser silently flipped these back to true, which
            // R8-stripped the 13MB dex down to a 2.2MB single-dex build (v50 was
            // 2.32MB vs live v49 6.81MB) and risks stripping reflection entry
            // points (Java-WebSocket / Gson models / zxing / credential providers).
            // Reverting to the v49 config restores full-code parity.
            isMinifyEnabled = false
            isShrinkResources = false
            // Wire the release signing config so `assembleRelease` produces
            // a signed APK ready for Play Console + sideload.
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    // Bundle C (2026-05-28) - AGP 8 no longer generates the BuildConfig class
    // unless this is opted in. PhoneService.kt + SignInActivity.kt gate their
    // PII Log.d statements behind BuildConfig.DEBUG (M13/M14) which compiles
    // away in release - this opt-in is what makes the constant exist.
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    // vc67 AMENDMENT 1 (Security F-3). `UnspecifiedRegisterReceiverFlag` is a
    // WARNING by default, which is how four in-app receivers shipped EXPORTED
    // on API 26-32 behind an `@Suppress` nobody re-read. Promoted to ERROR so
    // the next bare `registerReceiver(receiver, filter)` fails lint instead of
    // adding a line to a baseline. abortOnError is deliberately left alone:
    // the android gate grades lint against e2e-evidence/LINT-BASELINE-
    // android.json (may only SHRINK), and the XML report it reads is produced
    // either way. Severity here is what puts the finding in that XML as an
    // error rather than a warning.
    lint {
        error += "UnspecifiedRegisterReceiverFlag"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // WebSocket library
    implementation("org.java-websocket:Java-WebSocket:1.5.4")

    // JSON parsing
    implementation("com.google.code.gson:gson:2.10.1")

    // QR Code generation (ZXing)
    implementation("com.google.zxing:core:3.5.2")

    // QR Code scanning
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    // Dispatch #25 (v15) — PermissionChecker.shouldShowAutoRevokeWarning
    // calls PackageManagerCompat.getUnusedAppRestrictionsStatus(context)
    // which returns com.google.common.util.concurrent.ListenableFuture.
    // The class lives in this 1KB stub artifact that Guava publishes
    // specifically so Android apps can take a ListenableFuture-typed
    // return value without pulling the full ~3 MB Guava jar. AndroidX
    // core 1.12.0 brings it transitively at runtime, but Kotlin's
    // compile-classpath needs an explicit declaration to resolve the
    // symbol.
    implementation("com.google.guava:listenablefuture:1.0")

    // Dispatch #28 (v16) — encrypted phoneToken storage. The user's
    // phoneToken is the relay's authentication signal; we keep it in
    // EncryptedSharedPreferences (AES-256-GCM, keys held in the Android
    // Keystore / TEE). See TokenStore.kt for the wrapper.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Sign in with Google (2026-07-06, v43) — AndroidX Credential Manager
    // plus the Play Services bridge that actually talks to the on-device
    // Google account, and Google's googleid lib providing GetGoogleIdOption /
    // GoogleIdTokenCredential. We use the callback-based getCredentialAsync
    // API so no coroutines dependency is needed.
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    // vc69 — the in-app file-transfer card observes a StateFlow held by
    // PhoneService (FileTransferUiModel). Already on the classpath at exactly
    // this version, transitively via androidx lifecycle 2.6.1; declared so the
    // compile does not depend on a transitive edge. Pinned to that version on
    // purpose so no new version enters the tree.
    //noinspection GradleDependency,NewerVersionAvailable
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    // vc63 — Intents.intended() for the Home "Send a file" row. The row's
    // entire contract is the intent it fires into FileTransferActivity, so
    // the intent is the only thing worth asserting on. Same 3.5.1 line as
    // espresso-core, so no new transitive versions enter the tree.
    // Pinned to espresso-core's 3.5.1 on purpose: a newer intents against an
    // older core is exactly the kind of split-version androidTest classpath
    // that fails at runtime, not at build time. Bumping is a deliberate
    // pair-bump of both lines, not a lint nudge.
    //noinspection GradleDependency
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.5.1")


    // E2E P4 (s3) — the androidTest source set was empty until E2eKeyStoreTest.
    // androidx.test:runner (AndroidJUnitRunner / InstrumentationRegistry) is NOT
    // declared explicitly on purpose: ext:junit 1.1.5 already brings a matching
    // version transitively, and pinning it here only added a GradleDependency
    // "newer version available" lint item against the baseline for no benefit.
}

// E2E P4 Part 2 (a3) — forward the vectors-regeneration switch into the test JVM.
// Gradle does not propagate -D from the build JVM to the test JVM, so without
// this `-De2e.writeVectors=true` is silently ignored and E2eKdfVectorsTest keeps
// asserting against the old file while appearing to have regenerated it. See
// LEARNINGS: "silently ignored CLI flag".
tasks.withType<Test>().configureEach {
    System.getProperty("e2e.writeVectors")?.let { systemProperty("e2e.writeVectors", it) }

    // vc63 Amendment 2 — declare the resource tree as a test INPUT.
    //
    // E2eCopyTableTest (and the vectors tests) read files with plain
    // File("src/main/res/..."), which Gradle cannot see. Without this
    // declaration an edit to strings.xml alone leaves testDebugUnitTest
    // UP-TO-DATE, so the copy rules DO NOT RUN against the copy that
    // changed — and the gate reports a green copy table over text nobody
    // checked. Found by planting a QR string and watching the suite skip:
    // "BUILD SUCCESSFUL ... testDebugUnitTest UP-TO-DATE".
    //
    // RELATIVE sensitivity so the cache still hits when the worktree moves.
    inputs.dir(layout.projectDirectory.dir("src/main/res"))
        .withPropertyName("resourcesReadByCopyTests")
        .withPathSensitivity(PathSensitivity.RELATIVE)

    // vc69 — FileTransferUiVectorsTest reads a vector file from OUTSIDE this
    // module. Undeclared, an edit to that file alone leaves the test task
    // UP-TO-DATE and the gate reports green over rows nobody ran.
    inputs.file(layout.projectDirectory.file("../../tests/ft-progress-card-vectors.json"))
        .withPropertyName("ftProgressCardVectors")
        .withPathSensitivity(PathSensitivity.RELATIVE)

    // FILE-QUEUE — same reason for FileTransferQueueVectorsTest's file.
    inputs.file(layout.projectDirectory.file("../../tests/ft-queue-vectors.json"))
        .withPropertyName("ftQueueVectors")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}
