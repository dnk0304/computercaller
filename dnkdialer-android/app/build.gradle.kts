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
        versionCode = 50
        versionName = "1.0.27"

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

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
