# FORGE_PLAN.md — Bundle C (Android v30 / 1.0.8) security hardening

(Bundle A's plan archived in commit f5bc7bd; this file overwritten for Bundle C.)

## Goal
Ship signed APK + AAB v30 (1.0.8) that closes Phase 4 Android findings (H11/H12/H13, M3 APK side, M12–M15, L12). Includes a tiny additive server.js patch so the Bearer-header WS auth path works with the long-lived phoneToken (resolves a gap in Bundle A's actual implementation).

## Architecture Overview
```
Phone (v30)                                Server (Node+Next.js)
-----------                                ---------------------
  TokenStore.kt (Keystore-only, fail-closed)
        |
  phoneToken (long-lived bearer)
        |
  PhoneClient (Java-WebSocket) --Authorization: Bearer <phoneToken>-->  parseConnection()
                                                                              |
                                                                       validateTicket(JWT)? -> no
                                                                              | fallback
                                                                       validateToken(phoneToken) -> userId
                                                                              |
                                                                       room = phoneToken (same as legacy ?token=)
```

## Tech Stack Decision
- AGP 8.13.2, compileSdk/targetSdk 35, minSdk 26 (no change).
- R8 release minification + resource shrinking enabled (was off).
- Java-WebSocket 1.5.4 -> use `WebSocketClient(URI, Map<String,String> headers)` constructor for the Bearer header.
- Network Security Config: cleartext only for RFC1918 / loopback; HTTPS-only for computercaller.com (no SPKI pin -- deferred).
- No new library deps.

## Task Breakdown

### TASK-001: server.js -- additive Bearer-token fallback (UNBLOCKER)
- Type: Service
- Description: Server's Bundle A Bearer-header path only accepts a JWT (purpose='relay-ticket'). Add an additive fallback so if JWT verify fails, validate the Bearer value as a legacy long-lived phoneToken. Back-compat: existing ticket flow untouched (JWT still tried first); only the rejection path widens.
- Files: `server.js` (one block in `wss.on('connection')` ticket branch)
- Lines: ~10 added
- Budget: 2 files read / ~10 lines written -- LEAN
- Status: REQUIRED for the APK's Bearer header to be accepted by the live relay.

### TASK-002: AndroidManifest backup + cleartext + NSC
- Type: Config
- Files: `dnkdialer-android/app/src/main/AndroidManifest.xml`
- Lines: ~5 changed
- Budget: LEAN

### TASK-003: New res/xml/network_security_config.xml + data_extraction_rules.xml
- Type: Config
- Files: 2 new XML resources
- Lines: ~30
- Budget: LEAN

### TASK-004: build.gradle.kts -- versionCode 30, versionName 1.0.8, isMinifyEnabled=true, isShrinkResources=true, buildConfig=true
- Type: Config
- Files: `dnkdialer-android/app/build.gradle.kts`
- Lines: ~10 changed
- Budget: LEAN

### TASK-005: proguard-rules.pro -- populate keep rules
- Type: Config
- Files: `dnkdialer-android/app/proguard-rules.pro`
- Lines: ~50 added
- Budget: LEAN

### TASK-006: PhoneClient.kt -- accept headers; PhoneService.kt -- call WS via Authorization: Bearer
- Type: Service (WS auth cutover)
- Files: `PhoneClient.kt`, `PhoneService.kt` (lines 1185, 2387 region)
- Lines: ~30 changed
- Budget: LEAN

### TASK-007: TokenStore.kt -- fail-closed on Keystore failure
- Type: Auth/Storage
- Files: `TokenStore.kt`
- Lines: ~20 changed
- Budget: LEAN

### TASK-008: PII redaction -- PhoneService.kt + SignInActivity.kt (BuildConfig.DEBUG guard)
- Type: Logging
- Files: `PhoneService.kt`, `SignInActivity.kt`
- Lines: ~30 changed
- Budget: NORMAL

### TASK-009: Notification VISIBILITY_PRIVATE + setPublicVersion (L12)
- Type: UX/Privacy
- Files: `PhoneService.kt` line 1353 region + channel at 1256
- Lines: ~20 changed
- Budget: LEAN

### TASK-010: NotificationListenerService onboarding doc (M15)
- Type: Doc
- Files: `NotificationListenerService.kt` header comment
- Lines: ~15 added
- Budget: LEAN

### TASK-011: Build, sign, verify, hash
- Type: Build
- Commands: `./gradlew clean assembleRelease bundleRelease`; `aapt2 dump badging`; sha256
- Iterate proguard-rules if R8 strips a class.
- Budget: build artifact only; no source changes.

## Execution Order
TASK-001 (server) -> independent.
TASK-002, TASK-003, TASK-004, TASK-005 -- config edits, parallel-safe.
TASK-006, TASK-007, TASK-008, TASK-009, TASK-010 -- source edits, parallel-safe (different functions/files).
TASK-011 last (build + verify).

## Risk Flags
- R8 might strip a Gson model class we didn't enumerate; iterate proguard-rules.
- Bundle A's migration rotated every existing phoneToken -- Dennis's v29 APK already re-signed-in once. v30 will use whatever's in TokenStore at install time; if the user re-signs-in, they'll get a new token. Verify v30 actually authenticates with the relay before declaring done.
- BuildConfig.DEBUG only exists if `buildFeatures { buildConfig = true }` is set on AGP 8+.

## Open Decisions
- None -- proceeding under the brief's stated scope + the additive server.js patch needed to make Bundle A's Bearer path accept the long-lived phoneToken.

## Status
Executing under dispatch authority (Ken/Niki); no further plan-approval ping.
