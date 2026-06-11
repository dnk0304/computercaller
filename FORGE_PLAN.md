# FORGE_PLAN.md — Issue 1: On-demand deeper message fetch (Path B)

Branch: `feature/deeper-fetch-pathb` off `79374a6` (Issue 2 merge — current prod tip).
Date: 2026-06-11 | Author: Forge | Ends in: signed v35 APK.

## Goal
Make the Dashboard thread-list "Load 500 more" button perform a REAL global backward
fetch from the phone once the client-side slice is exhausted — pulling the next page of
OLDER messages across ALL threads and merging them into the global store (Path B).

## Architecture (verified, not assumed)
- PhoneService `GET_MESSAGES` already parses since/limit/address/before and passes all
  four to getMessagesWithMms. No change.
- SmsHandler.getMessages honors `before` as exclusive `DATE < ?`. L97
  `effectiveSince = if(addr) 0 else since` → global path (addr=null, since=0, before=X)
  yields WHERE `DATE < X` only, DESC, capped. CORRECT as-is; no change.
- getMessagesWithMms MMS branch passes `since` but NOT `before` → fix needed.
- Web MESSAGES_CHUNK isComplete already has the merge branch (no scopedKey, merge mode)
  → mergeMessages(prev, incoming). Global path reuses it.

## Tech decisions
- MMS: ADD `before` to MmsHandler.getMessages (complete, preferred over skip-MMS). Mirrors
  the existing parameterized `since` clause; MMS dates are SECONDS so before/1000.
- Sentinel: explicit hook state `hasMoreOlderOnPhone`, set in MESSAGES_CHUNK isComplete
  via `globalOlderFetchInFlightRef` flag.
- Loading: `isLoadingOlderThreads` state + 6s safety timeout.

## Tasks
- [x] TASK-001 Android MmsHandler `before` (MmsHandler.kt + getMessagesWithMms call). DONE.
- [x] TASK-002 versionCode 34→35, versionName 1.0.12 (build.gradle.kts). DONE.
- [x] TASK-003 Web loadOlderThreads + refs/state + chunk-handler wiring + export. DONE.
- [x] TASK-004 Dashboard two-mode Load-500-more rewire + oldest-date memo. DONE.
- [x] TASK-005 Gates + signed v35 APK. DONE.

## Outcome
- tsc --noEmit: exit 0. next build: exit 0, 34 routes (incl /app, /app/settings).
- eslint: NO new findings (usePhoneBridge 11 [1 err,10 warn], Dashboard 32 [5 err,27 warn]
  — identical to 79374a6 baseline). Android assembleRelease: BUILD SUCCESSFUL.
- APK: apk-releases/computercaller-v35.apk, 3,745,114 bytes,
  sha256 68b196debcb1745114a77eb64e869ed962a79e6c25df5f3f6604ad6a9cb0e944,
  versionCode 35 / 1.0.12 / targetSdk 35, signer cert SHA-256 3fc108197ec681... (matches
  v34 / OAuth cert). SIGNED in-env (keystore reachable).
- MMS decision: ADDED `before` to MmsHandler.getMessages (complete option).
- L97: unchanged (confirmed correct for global address-less path).

Order: 001→002 ; 003→004 ; 005 last.

## Risk flags
- L97 must NOT change (breaks per-thread). Confirmed unchanged.
- Stay out of: quicksync (Issue 2), per-thread loadOlderMessages, mergeMessages,
  conversationKey grouping, auto-sync-on-connect.
- Keystore reachable in-env → CAN sign v35.
