# FORGE_PLAN.md — Connect+Accept + Permissions Checklist (APK v18)

## Goal

Ship APK v18 on `feature/saas-multiuser` that:
1. Replaces the v17 auto-pair-on-launch behavior with a **Connect+Accept gesture protocol** — phone lands in lobby on WS open, user must explicitly accept each browser pairing request.
2. Redesigns the **permissions UI** to a live status checklist (✓ granted / ✗ missing-required / ⚠ missing-soft) so granted permissions stay visible and the user can advance once required permissions are met.

## Architecture Overview

```
Browser → Relay → Phone (lobby)
                    ↓
              PAIRING_REQUEST  ←── relay forwards "browser wants pairing"
                    ↓
            [HEADS-UP notif + AlertDialog if foreground]
                    ↓
        User taps Accept ──→ ACCEPT_PAIRING:{pairingId}
        User taps Decline → DECLINE_PAIRING:{pairingId}
        30s elapses ──────→ DECLINE_PAIRING (auto)
                    ↓
              PAIRING_ACTIVE ───────→ foreground notif: "Connected — syncing data"
                                      (until)
              PAIRING_TERMINATED ───→ foreground notif: "Waiting"
                                      stay on relay (lobby) — NO active-room re-entry
```

**Relay-side changes are owned by the parallel Forge dispatch (a5611d64b738f3b39).** My side is APK only.

## Tech Stack Decision

- Kotlin / Android — existing app
- No new dependencies
- Reuse existing connection_requests notification channel (built for old LAN PhoneServer, dead since #29)
- Reuse existing `ConnectionRequestReceiver` (rewire serviceHandler payload to call new ACCEPT/DECLINE send path)
- Wire-protocol message names per dispatch spec (literal strings — relay-side will match exactly)

## Task Breakdown

### TASK-001: Change A — PhoneService relay reconnect simplification + protocol handlers
- **Type:** Service / Protocol
- **Description:**
  - Delete exponential-backoff reconnect: `scheduleReconnect`, `cancelScheduledReconnect`, `reconnectHandler`, `reconnectRunnable`, `reconnectAttempt`, `reconnectBackoffsMs`.
  - Replace with simple 5s fixed-delay relay-only auto-reconnect (lobby WS only). Active-room re-entry NEVER automatic — relay is authority on room membership.
  - DELETE the existing `DISCONNECT_PHONE` command handler — replaced by `PAIRING_TERMINATED` semantics from the relay side.
  - ADD message handlers in `handleCommand`:
    - `PAIRING_REQUEST` → store pending request + post Accept/Decline notification + (if foreground) broadcast intent to MainActivity to show AlertDialog + start 30s auto-decline timer
    - `PAIRING_CANCELLED` → dismiss notification + cancel auto-decline + broadcast dismissal intent to MainActivity
    - `PAIRING_ACTIVE` → updateNotification("Connected — syncing data") with `ua`/`ip` info
    - `PAIRING_TERMINATED` → updateNotification("Waiting") — stay connected to relay lobby
  - REWIRE `handleConnectionDecision(pairingId, accept)` to send `ACCEPT_PAIRING:{pairingId}` / `DECLINE_PAIRING:{pairingId}` over the relay client.
- **Input context:** PhoneService.kt (already read), ConnectionRequestReceiver.kt, PhoneClient.kt
- **Output:** Modified `PhoneService.kt` (~80 LOC net delta — delete 40 backoff lines, add 60 protocol handler lines, modify 20)
- **Dependencies:** None
- **Estimated complexity:** Medium
- **Context budget:** 3 files read, ~150 lines modified — SAFE ✅
- **Delegatable:** No (single agent context, sequential with task 2)

### TASK-002: Change A — MainActivity broadcast receiver + foreground AlertDialog
- **Type:** UI / Activity
- **Description:**
  - Register a `LocalBroadcastReceiver` (use `ContextCompat.registerReceiver` with RECEIVER_NOT_EXPORTED) for two new actions: `ACTION_PAIRING_REQUEST_IN_FOREGROUND` and `ACTION_PAIRING_CANCELLED_IN_FOREGROUND`.
  - On receive REQUEST: show `AlertDialog` with title "Connection request", message containing `ua` + `ip`, Accept (positive) / Decline (negative). Tapping either fires the SAME broadcast intent `ConnectionRequestReceiver` consumes, so both notification and dialog converge in `PhoneService.handleConnectionDecision`.
  - On receive CANCELLED: dismiss the AlertDialog if still showing.
  - Update lobby status text: when relay is OPEN but no active pair, status reads "Lobby — waiting for browser to connect" (new string `pair_lobby_status`).
- **Input context:** MainActivity.kt (already read)
- **Output:** Modified `MainActivity.kt` (~80 LOC added)
- **Dependencies:** TASK-001
- **Estimated complexity:** Low
- **Context budget:** 1 file modified, ~80 lines — SAFE ✅

### TASK-003: Change B — PermissionChecker `checkAllWithStatus`
- **Type:** Logic
- **Description:**
  - Add new method `checkAllWithStatus(context): List<PermissionStatusItem>` returning ALL permissions with their status enum value (GRANTED / MISSING_REQUIRED / MISSING_SOFT).
  - Add nested `PermissionStatusItem` data class + `Status` enum.
  - Keep existing `checkAll(context)` untouched for callers that only want missing.
  - Classify which permissions are REQUIRED (Phone/Contacts/SMS — real blockers) vs SOFT (auto-revoke, battery toggles — Samsung-soft). Granular classification based on existing `Kind` (RUNTIME = REQUIRED, SPECIAL = SOFT except notification_listener which is RUNTIME-soft? — actually per spec: "Phone, Contacts, SMS" = REQUIRED, everything else (battery, auto-revoke) = SOFT. Notification listener and POST_NOTIFICATIONS — those are arguably SOFT for the "Continue" gate since the app starts without them; will treat notification_listener as SOFT and POST_NOTIFICATIONS as SOFT (already optional in MainActivity), per spec wording.)
- **Input context:** PermissionChecker.kt
- **Output:** Modified `PermissionChecker.kt` (~60 LOC added — type definitions + new method)
- **Dependencies:** None (parallel with TASK-001/002)
- **Estimated complexity:** Low
- **Context budget:** 1 file modified, ~60 lines — SAFE ✅

### TASK-004: Change B — activity_main.xml + Permissions checklist UI in MainActivity
- **Type:** Layout / UI
- **Description:**
  - In `activity_main.xml`: Reword `relay_help_text` to "Sign in on computercaller.com, then tap Connect. You'll get a prompt here to accept." — DONE via strings.xml.
  - Add a permissions-checklist `LinearLayout` (id `permsChecklistList`) and a "Continue" button to the permissions-required pane layout (`activity_permissions_required.xml`).
  - Replace `renderPermissionsRequiredPane`'s detail panel rendering with a live checklist of ALL permissions (granted + missing) — each row shows icon (✓/✗/⚠) + label + status badge.
  - Enable "Continue" only when all REQUIRED are GRANTED.
- **Input context:** activity_main.xml, activity_permissions_required.xml, MainActivity.kt
- **Output:** Modified XML + MainActivity rendering helpers (~100 LOC)
- **Dependencies:** TASK-003
- **Estimated complexity:** Medium
- **Context budget:** 3 files, ~150 lines — SAFE ✅

### TASK-005: strings.xml + build.gradle.kts version bump
- **Type:** Config / Resources
- **Description:**
  - Add new strings: `pair_request_title`, `pair_request_body_template`, `pair_accept`, `pair_decline`, `pair_active_notification`, `pair_terminated_toast`, `pair_lobby_status`, `perm_status_granted`, `perm_status_missing_required`, `perm_status_missing_soft`, `perm_continue_button`.
  - Reword `relay_help_text` per spec.
  - Bump `versionCode = 17 → 18`. `versionName` unchanged.
- **Input context:** strings.xml, build.gradle.kts
- **Output:** Modified strings.xml + build.gradle.kts (~25 LOC)
- **Dependencies:** None (parallel)
- **Estimated complexity:** Low
- **Context budget:** 2 files, ~25 lines — SAFE ✅

## Execution Order

```
TASK-005 (strings + version bump) ──┐
TASK-003 (PermissionChecker)         ├──► TASK-004 (permissions UI)
TASK-001 (PhoneService protocol)     ──► TASK-002 (MainActivity foreground dialog)
```

I'll execute sequentially: 005 → 003 → 001 → 002 → 004 (TASK-004 last so layout XML reflects final string + checker contract).

## Risk Flags

- **Wire protocol naming** — relay-side Forge dispatch is parallel. Spec mandates EXACT message names: `PAIRING_REQUEST`, `PAIRING_CANCELLED`, `PAIRING_ACTIVE`, `PAIRING_TERMINATED`, `ACCEPT_PAIRING`, `DECLINE_PAIRING`. Any drift breaks the pair.
- **PhoneClient message format** — current format is `TYPE:{json}`. My handlers parse via existing `handleCommand(command, payload, viaClient)` path which already strips the colon prefix and decodes the JSON map. Confirmed compatible.
- **AlertDialog lifecycle** — must be dismissed if Activity backgrounds (otherwise BadTokenException on resume). Use `if (!isFinishing && !isDestroyed)` guard before show, and field-track the dialog ref to dismiss in onPause.
- **Active-room re-entry never automatic** — the simple 5s auto-reconnect re-opens the LOBBY WebSocket. Active-room membership is granted ONLY by an explicit `PAIRING_ACTIVE` from the relay (which follows ACCEPT_PAIRING). Phone's local state must NOT assume continued pairing across reconnects.
- **Pending request map cleanup** — `pendingRequestTimers` is currently never populated post-dispatch-#29. New flow re-uses it; must clear in `PAIRING_CANCELLED` and `PAIRING_TERMINATED` paths.
- **Auto-decline on relay disconnect** — if WS closes while a PAIRING_REQUEST is pending, the user can still tap Accept/Decline but the message will fail to send. Decision: clear pending requests on WS close so the dialog dismisses too. Reasonable since the relay no longer cares.

## Open Decisions

- **POST_NOTIFICATIONS classification** — spec says REQUIRED = "Phone, Contacts, SMS". POST_NOTIFICATIONS without grant means we cannot show the Accept/Decline notification. But the spec is explicit, and the existing app already treats it as `optionalPermissions` in MainActivity. Following spec verbatim: REQUIRED = Phone/Contacts/SMS only, everything else SOFT.

## Status

- [x] FORGE_PLAN.md written
- [x] TASK-005 — strings.xml + version bump (done — commit 1ec1683)
- [x] TASK-003 — PermissionChecker.kt checkAllWithStatus (done — commit 5dabf3a)
- [x] TASK-001 — PhoneService.kt protocol handlers (done — commit 5dabf3a)
- [x] TASK-002 — MainActivity foreground dialog (done — commit 5dabf3a)
- [x] TASK-004 — Permissions checklist UI (done — commit 5dabf3a)
- [x] Compile verification (gradle compileReleaseKotlin OK)
- [x] Pushed to feature/saas-multiuser
