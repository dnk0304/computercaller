# FORGE_PLAN.md — Notification-shade "Disconnect from Lobby" action button (APK v27)

> Supersedes prior Dispatch-B (Item 2 / v26) content. Base = branch tip `fc3a99d`.

## Goal
Surface the EXISTING v25 `userDisconnectFromLobby()` / `userRejoinLobby()` methods as
state-aware action buttons on the persistent foreground-service notification, so Dennis can
pull down the shade and disconnect from / reconnect to the lobby in one tap WITHOUT opening
the app and WITHOUT killing the service. Android-only. No new disconnect logic.

## Architecture Overview
```
Notification action button (PendingIntent.getBroadcast, FLAG_IMMUTABLE, setPackage)
        │  ACTION_DISCONNECT_LOBBY (req code 2001) / ACTION_REJOIN_LOBBY (2002)
        ▼
LobbyActionReceiver (NEW, RECEIVER_NOT_EXPORTED, thin pass-through)
        │  lobbyActionHandler?.invoke(rejoin: Boolean)
        ▼
PhoneService.lobbyActionHandler (set in onCreate, nulled in onDestroy)
        │  rejoin -> userRejoinLobby()  |  !rejoin -> userDisconnectFromLobby()  [REUSED AS-IS]
        ▼
TokenStore.setUserStayedDisconnected(...) + relay WS close/redial  ──► updateNotification(...)
                                                                              │
                          buildForegroundNotification(text) [shared builder]  ▼
              state-aware action: isUserStayedDisconnected? "Reconnect" : "Disconnect"
```
Both notification build sites (onStartCommand ACTION_START ~L1162 and `updateNotification` ~L1496)
route through ONE new `buildForegroundNotification(text): Notification` so the correct action is
always attached and the brand color is no longer dropped by updateNotification.

## Tech Stack Decision
Kotlin / Android (existing). Reuse proven `ConnectionRequestReceiver` broadcast pattern.
NEW separate `LobbyActionReceiver` (NOT extending ConnectionRequestReceiver) — keeps the benign
lobby-toggle decoupled from the security-sensitive accept/decline path (Ken's preference) and
keeps the @Volatile handler signatures distinct ((Boolean)->Unit vs (String,Boolean)->Unit).

## Task Breakdown

### TASK-001: NEW LobbyActionReceiver.kt  [Low · SAFE ✅]
Thin BroadcastReceiver modelled on ConnectionRequestReceiver. Two action constants +
`@Volatile var lobbyActionHandler: ((Boolean) -> Unit)?`. onReceive maps
ACTION_DISCONNECT_LOBBY→rejoin=false, ACTION_REJOIN_LOBBY→rejoin=true, invokes handler. ~55 lines.

### TASK-002: PhoneService wiring  [Medium · SAFE ✅]
- Field `private var lobbyActionReceiver: LobbyActionReceiver? = null`.
- onCreate: register IntentFilter(2 actions) + RECEIVER_NOT_EXPORTED (API33+) mirroring the
  ConnectionRequestReceiver block; set handler `{ rejoin -> if (rejoin) userRejoinLobby() else
  userDisconnectFromLobby() }`.
- onDestroy: null handler + unregister + null field (mirror serviceHandler cleanup).
- Extract `buildForegroundNotification(text): Notification` — title/text, small icon,
  setColor(accent_blue)+setColorized(false), contentIntent (req 0), ongoing, + ONE state-aware
  action off `TokenStore.isUserStayedDisconnected(this)`:
    false → "Disconnect" → getBroadcast(2001, ACTION_DISCONNECT_LOBBY, FLAG_IMMUTABLE, setPackage)
    true  → "Reconnect"  → getBroadcast(2002, ACTION_REJOIN_LOBBY,  FLAG_IMMUTABLE, setPackage)
- L1162 ACTION_START: startForeground(NOTIFICATION_ID, buildForegroundNotification("Phone bridge
  is active")). Keep the post-start isUserStayedDisconnected→updateNotification(...) call.
- updateNotification(text): notify(NOTIFICATION_ID, buildForegroundNotification(text)).

### TASK-003: Strings  [Low · SAFE ✅]
res/values/strings.xml: `notif_action_disconnect`="Disconnect", `notif_action_reconnect`="Reconnect".

### TASK-004: Version bump  [Low · SAFE ✅]
build.gradle.kts versionCode 26→27, versionName "1.0.4"→"1.0.5".

### TASK-005: Build + verify  [Medium]
compileReleaseKotlin → clean assembleRelease bundleRelease → aapt dump badging (27 / 1.0.5).
NO binary commit, NO deploy.

## Execution Order
001 + 003 + 004 (parallelizable) → 002 (needs 001) → 005 → commit SOURCE on feature/saas-multiuser.

## Risk Flags
- Request codes 2001/2002 distinct from accept/decline (requestId.hashCode) + contentIntent (0). Safe.
- updateNotification previously dropped brand color; folding it in is intended (brief 3c).
- IMPORTANCE_LOW channel still renders action buttons in expanded row — confirmed by brief.

## Open Decisions
None — all settled by brief + v25 impl.

## Status
- TASK-001: pending
- TASK-002: pending
- TASK-003: pending
- TASK-004: pending
- TASK-005: pending
