# FORGE_PLAN.md — ComputerCaller call-waiting fix (Item A) + reply-and-hangup (Item B)

Branch: `feature/saas-multiuser` @ `0005ce3` | Date: 2026-06-03 | Author: Forge

## Goal
Two interlocking phone-bridge fixes:
- **Item A** — second incoming call while in an active call must be visible in the
  webapp without clobbering the active call's state. Per-call identity end-to-end
  via a new `CALL_WAITING` frame and a `number` payload on `CALL_ENDED`.
- **Item B** — atomic browser bridge method `declineWithMessage(number, body)` —
  send SMS first, then `END_CALL`. v1 scope: ringing-only (not waiting calls).

## Architecture Overview
- Browser: `hooks/usePhoneBridge.ts` (state + handlers), `hooks/phoneTypes.ts`
  (CallInfo shape + new event types).
- Android: `dnkdialer-android/.../PhoneService.kt` (call-state observers + relay
  emission). No `CallHandler.kt` change needed — `telecomManager.endCall()` already
  rejects a ringing call.
- Relay: zero changes. `server.js` is a blind pipe; it already forwards unknown
  frame types within an active pair.

## Tech Stack Decision
**Lighter listener+call-list approach over full InCallService adoption.** Reasoning:
- Adopting InCallService requires the app to become the default dialer (or default
  companion InCallService) — UX cost (system prompt), Play Store review surface,
  and a non-trivial migration of the existing telephony observers.
- The lighter path keeps both existing observers (legacy `PhoneStateListener` +
  modern `TelephonyCallback`) and adds a **new `callWaitingSentRef` guard** plus a
  RINGING-while-already-active branch that emits a distinct `CALL_WAITING` frame.
- Per-call targeting for rejecting a specific waiting call (which only
  InCallService can do cleanly via `Call.reject()`) is explicitly **deferred** to a
  follow-up. v1 reply-and-hangup is ringing-only.

## Task Breakdown

### TASK-A1 (Android): emit CALL_WAITING + per-call CALL_ENDED
- File: `dnkdialer-android/.../PhoneService.kt`
- Add `callWaitingSentRef: AtomicBoolean`.
- In both observers, RINGING while `callAnsweredSentRef == true` -> emit
  `CALL_WAITING:{number,name}`.
- `CALL_ENDED` carries `{number}` (the active number known to the service).
- Reset `callWaitingSentRef` on IDLE.
- Backward compat: legacy `CALL_ENDED:{}` still accepted by the browser.

### TASK-A2 (Browser): track waitingCall + non-clobbering CALL_INCOMING
- Files: `hooks/usePhoneBridge.ts`, `hooks/phoneTypes.ts`
- Add `'CALL_WAITING'` to `PhoneEventType`.
- Add `waitingCall: CallInfo | null` state slice.
- `CALL_INCOMING`: route into `waitingCall` if `currentCall` already active.
- `CALL_WAITING`: writes to `waitingCall` only.
- `CALL_ENDED`: if payload `number` matches active -> clear and promote waiting;
  if matches waiting -> clear waiting. No `number` -> legacy behavior (clear active).
- Expose `waitingCall` via the hook return so Pixel reads it through `usePhone()`.

### TASK-B1 (Browser): declineWithMessage(number, body)
- File: `hooks/usePhoneBridge.ts`
- `sendSms(number, body)` then `endCall()`. Order matters.
- v1 ringing-only — JSDoc warns that `endCall()` can't target a waiting call.

### TASK-B2 (Android confirmation): END_CALL rejects ringing
- No Android change. `telecomManager.endCall()` rejects the ringing call per
  Android docs. Documented in the Niki return note.

## Execution Order
A1 -> A2 -> B1. Sequential.

## Risk Flags
- OEM variance on Samsung One UI: aggregate `onCallStateChanged` may not re-fire
  RINGING for a second call. If neither observer sees the RINGING transition while
  OFFHOOK, `CALL_WAITING` won't emit — InCallService is the only fully reliable
  path. Flagged to Ken.
- v29/v30 APKs in the field never send `CALL_WAITING` and send `CALL_ENDED:{}`.
  Browser remains compatible.

## Status
- [x] TASK-A1
- [x] TASK-A2
- [x] TASK-B1
- [x] TASK-B2 (no change, documented)
