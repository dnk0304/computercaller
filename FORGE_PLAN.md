# FORGE_PLAN.md — Live-sync resume regression (post soft-hold)

Branch: `fix/live-sync-resume-snapshot` off `9f0b020` (PROD tip, soft-hold live).
Date: 2026-06-16 | Author: Forge | Server/web only — NO APK.

## Goal
After the soft-hold deploy (9f0b020) a transient blip recovers the WS connection but not the FLOW: (A) the pair fails to re-form active so live SMS/call frames from the lobby phone are dropped, and (B) a call-end that coincides with the blip leaves a stale "in-call" chip. Restore flow after a blip while preserving soft-hold stability (no reconnect storm, no browser wipe).

## Architecture Overview
Relay (`server.js`) brokers a phone↔browser pair per room token. Soft-hold keeps a survivor in `room.active` and arms `room.resumable`; `tryAutoResume` re-slots the returning peer. Web hook (`hooks/usePhoneBridge.ts`) holds active state on `PEER_RECONNECTING`. Bug A is server-side (pair never re-forms / lobby-phone frames dropped at ~L1005). Bug B is web-side (no re-sync on resume; ACTIVE chip never expires).

## Task Breakdown

### TASK-001: Server — reliable pair re-form + armed-window lobby-frame passthrough
- (1a) `tryAutoResume`: opportunistically re-form when invoked from the lobby-frame branch, not only at lobby-join — so phone+browser need not be in the lobby in the same instant.
- (1b) Lobby-phone data branch (~L1005): while `room.resumable` live AND survivor browser held active, try `tryAutoResume`; if re-formed, forward; else forward the frame to the held survivor browser (armed-window passthrough) instead of silent-drop. Mirror lobby-browser → held survivor phone (~L1118).
- Preserve `LEGACY_RESUME_TEARDOWN`: when teardown path is on, no passthrough (old behavior).
- Output: server.js edits. Complexity High. SAFE (1 file, ~80 lines).

### TASK-002: Web — resume snapshot + stale chip expiry on PEER_RECONNECTING
- `PEER_RECONNECTING`: stamp `peerReconnectingAtRef`; fire an idempotent merge snapshot (GET_MESSAGES + GET_CALL_LOGS since gap) so missed frames backfill — the soft-hold survivor never gets a fresh PAIRING_ACTIVE so it otherwise never re-syncs.
- Stale chip expiry: add `expiredStaleCallIds` (ACTIVE+ringing rows whose last bridge event predates the blip start) to callQueueGuards.ts; call once on resume → clears stuck "in-call".
- CallQueueBand layout LOCKED — call-STATE only.
- Output: callQueueGuards.ts (+1 pure fn), usePhoneBridge.ts. Complexity Med-High. SAFE (2 files, ~120 lines).

### TASK-003: Repro harness (before/after) + unit tests
- tests/repro-resume-sync.mjs proving Bug A (dropped count before / 0 after), Bug B (chip persists before / cleared after), soft-hold regression-guard (still holds). Extend call-queue-guards.test.ts for the new pure fn.

## Execution Order
TASK-001 ∥ TASK-002 → TASK-003 → gates (tsc, next build, eslint delta, node -c).

## Risk Flags
- No reconnect storm / no browser wipe (regression guard required).
- Auth stays in WS query. No socket.destroy on non-/relay. CallQueueBand layout LOCKED. Waitlist branches untouched.

## Open Decisions
None blocking. Server revert = `LEGACY_RESUME_TEARDOWN`. Web change additive/idempotent (no new flag).

## Progress
- [x] TASK-001 server pair re-form + passthrough
- [x] TASK-002 web snapshot + chip expiry
- [x] TASK-003 repro + unit tests
- [x] Gates
