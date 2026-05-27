# FORGE_PLAN.md — Per-conversation "Load more" (Dispatch B = ITEM 2, requires APK v26)

> Dispatch A (Item 1, tiered caps) is DONE + DEPLOYED at `fedc6f2`. This plan
> supersedes the prior Dispatch-A content of this file and covers ONLY Item 2.

## Goal
Add backward paging within a single conversation. Opening a thread loads the
newest 25 messages; an "Older messages" button pages older 25s. Mechanism is
Option A (page-size sentinel) — NO count query, NO GET_THREAD_INFO. A load
returning exactly 25 means "maybe more"; <25 means "start of history".

## Architecture Overview
Web (ThreadView, Pixel B's job) calls `loadOlderMessages(address, before, 25)` →
hook sends `GET_MESSAGES:{address, before, limit:25}` WITHOUT clearing the
message buffer (append/merge, not replace) → Android `PhoneService.GET_MESSAGES`
parses `before` and passes to `SmsHandler.getMessagesWithMms(..., before)` →
`getMessages` adds `DATE < before` to the WHERE clause (honoured even when
address is set) → returns newest `limit` messages older than `before`, DATE DESC.
Web merge block (usePhoneBridge `MESSAGES_CHUNK`, merge mode) dedupes by `id`.

## Tech Stack Decision
No new deps. TypeScript (web hook) + Kotlin (Android). Existing protocol frames.

## Task Breakdown

### TASK-001: Android SmsHandler `before` upper-bound
- Type: Service (Kotlin). Files: SmsHandler.kt.
- Add `before: Long = 0` to `getMessages` and `getMessagesWithMms`; when
  `before > 0` add `DATE < ?` arg. `before` honoured even when address set
  (the address short-circuit only clears `since`, never `before`).
- Budget: 1 file, ~15 lines. SAFE.

### TASK-002: Android PhoneService GET_MESSAGES handler
- Type: Service (Kotlin). Files: PhoneService.kt (:2639).
- Parse `before`, pass through, update log line.
- Budget: 1 file, ~3 lines. SAFE.

### TASK-003: Android APK bump
- Type: Config. Files: app/build.gradle.kts. versionCode 25→26, versionName 1.0.3→1.0.4.
- Budget: 1 file, ~2 lines. SAFE.

### TASK-004: Web hook `loadOlderMessages` + newest-25 initial open
- Type: Service (TS). Files: hooks/usePhoneBridge.ts.
- Add `loadOlderMessages(address, before, limit=25)` — does NOT clear buffer.
- Change `getContactMessages` initial open to newest 25 (`{address, limit:25}`, no since).
- Export `loadOlderMessages` on hook return (flows to usePhone via ReturnType inference).
- Budget: 1 file, ~20 lines. SAFE.

### TASK-005: Verify + build
- tsc --noEmit, eslint, gradle compileReleaseKotlin assembleRelease bundleRelease.

## Execution Order
TASK-001 → TASK-002 → TASK-003 (android commit) ; TASK-004 (web commit, independent).
Build (TASK-005) after all source lands.

## Risk Flags
- MMS-with-address still skipped → paging is SMS-only for address-filtered queries
  (pre-existing limitation, accepted per brief).
- Merge dedupe MUST run in 'merge' mode (not 'replace') — verified: load paths
  don't touch syncModeRef, default is 'merge'.

## Open Decisions
None — Q1-Q4 LOCKED 2026-05-27.

## Status
- TASK-001: pending
- TASK-002: pending
- TASK-003: pending
- TASK-004: pending
- TASK-005: pending
