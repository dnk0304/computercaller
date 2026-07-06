# FORGE_PLAN — ComputerCaller Multi-call Teardown Isolation (Path A)

## Goal
Fix: hanging up an ACTIVE call also kills the other waiting/incoming call(s). Make
registry teardown PER-CALL + debounced so a transient aggregate IDLE during a
multi-call transition removes only the call that actually ended, leaving the
others live in the web queue. PATH A ONLY (no default-dialer / no InCallService) —
per Dennis.

## Root Cause (confirmed against v35 source `fa45670`)
- PRIMARY — `PhoneService.kt:1125 registryOnIdle()` does `callRegistry.clear()` +
  `CALL_REMOVE` for EVERY entry on any aggregate IDLE. During an end-call-#1-while-
  call-#2-waiting transition the listener reports a transient IDLE → wipes call #2.
- Both observers call it: legacy `PhoneStateListener` IDLE (line 1268) and modern
  `TelephonyCallback` IDLE (line 398).
- SECONDARY (ceiling, NOT fixable in Path A) — `telecomManager.endCall()` is
  phone-wide, cannot target a leg. Documented, not fixed.

## Web side — NO CHANGES NEEDED (verified)
`hooks/usePhoneBridge.ts` already implements per-call teardown:
- `CALL_ENDED` (1303): number-match removes only that call; legacy no-number removes
  only the FOREGROUND (not wholesale).
- `CALL_REMOVE` (1418): removes only the matched callId.
- `endCall` (2483): optimistically removes only the foreground; `clearAllCalls()`
  only when list already empty.
- All `clearAllCalls()` callers (1168 DISCONNECT, 1202 heartbeat-timeout, 2319/3149
  lobby/unload) are legitimate full-teardown events, none IDLE-driven.
=> The bug is 100% Android-side. `calls[]`/`CallInfo` shape UNCHANGED (Pixel safe).

## Tech Stack
Kotlin / Android service. No new deps. v35 un-minified line (`isMinifyEnabled=false`).

## Task Breakdown

### TASK-001: Per-call debounced teardown in PhoneService.kt
- Type: Service
- Replace blanket `registryOnIdle()` with:
  - `registryOnIdleEndForeground(reason)`: pick ONE entry to end on IDLE
    (prefer state=="active", else most-recently-added non-ended), mark ended,
    emit CALL_REMOVE for ONLY that entry. If registry empty → no-op.
  - Arm a 1200ms debounced sweep (`scheduleIdleSweep`): if still no fresh
    OFFHOOK/RINGING arrived AND registry still has only ended/stale leftovers,
    clear remaining + emit CALL_REMOVE each (genuine all-ended). A fresh
    RINGING/OFFHOOK cancels the sweep (survivors are real).
  - `cancelIdleSweep()` called from registryOnRinging/registryOnOffhook.
- Keep legacy `CALL_ENDED:{number}` frame untouched (backward compat).
- Both IDLE paths (legacy 1268, modern 398) swap `registryOnIdle("idle")` →
  `registryOnIdleEndForeground("idle")`.
- 0-1 call case stays byte-identical: foreground is the only call → removed →
  sweep finds empty → no-op. Same observable behavior as old clear().
- Context budget: 1 file, ~80 lines net. SAFE.

### TASK-002: Build v36 APK
- versionCode 35→36, versionName 1.0.12→1.0.13, isMinifyEnabled stays false.
- Sign with computercaller-release.keystore / alias computercaller.
- Size gate ~6.0MB, cert SHA-256 must match.

## Execution Order
TASK-001 → build (TASK-002).

## Risk Flags
- Debounce heuristic is best-effort (Path A limitation): on rapid hang-up→answer
  within 1200ms the "which ended" pick relies on state=="active" being the
  foreground. Documented. Real targeting needs InCallService (Path B, deferred).
- Two observers can both hit IDLE; `callEndedSentRef` already serializes — the
  new teardown is invoked inside that first-writer guard, so it runs once.

## Open Decisions
None — Dennis locked Path A. Path B written up as follow-up only.
