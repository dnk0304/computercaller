# FORGE_PLAN.md — Tiered sync caps (Dispatch A = ITEM 1)

## Goal
Re-introduce per-category, time-range-tiered row caps on the Full Sync flow. v25
removed caps (Android default `limit = Int.MAX_VALUE`). Dennis is reversing that:
caps come BACK, tiered by selected time range, enforced independently on messages
and call logs, to prevent crash-risk on uncapped syncs. Preview count stays
truthful; the cap is a ceiling on what actually transfers.

## Architecture Overview
Web (SyncSetupPanel) picks a range per category → `capForRange(range)` maps
range→cap → `syncData()` puts `limit` into the `GET_MESSAGES` / `GET_CALL_LOGS`
payload → Android handlers (already wired) read `payload.limit` and return the
newest N rows (DATE DESC + break/take). NO Android change required.

## Cap table (LOCKED 2026-05-27)
| RangeKey | Window   | Cap (each: messages, call logs) |
|----------|----------|---------------------------------|
| `30d`    | 30 days  | 1,500   |
| `3mo`    | 90 days  | 2,500   |
| `6mo`    | 180 days | 5,000   |
| `1yr`    | 365 days | 10,000  |

## Task Breakdown
- TASK-001 `lib/syncCaps.ts` (NEW): canonical 4-key `RangeKey` + `RANGE_CAP` map +
  `capForRange(range)`. NO subscription/tier logic. ~20 lines. Lean.
- TASK-002 `hooks/usePhoneBridge.ts`: extend `syncData` opts (`messageLimit?`,
  `callLogLimit?`); inject `limit` into payloads when present. ~10 lines. Lean.
- TASK-003 `components/SyncSetupPanel.tsx` (handleStartSync ONLY): pass caps via
  `capForRange`. Pixel owns RANGE_OPTIONS / RangeKey decl / render. ~6 lines. Lean.
- TASK-004 Android verification (read-only): confirm both handlers honour
  `payload.limit` as newest-N. NO change.

## Execution Order
001 → 002 → 003 (003 imports 001). 004 read-only, parallel.

## RangeKey coordination (Forge↔Pixel)
Canonical `RangeKey` (4 locked keys) now lives in `lib/syncCaps.ts`. Forge ships
first. Pixel rebases by importing `RangeKey` from `@/lib/syncCaps`, deleting the
local 6-key decl + `7d`/`all` options. Pixel needs exported `capForRange`.

## Status (Dispatch A)
- [x] Plan written
- [x] TASK-001 lib/syncCaps.ts
- [x] TASK-002 usePhoneBridge.ts syncData opts + limit plumbing
- [x] TASK-003 SyncSetupPanel.tsx handleStartSync
- [x] TASK-004 Android verification — web-only confirmed
- [x] tsc / eslint green
- [x] Web commit (Ken deploys; no APK)

---

# FORGE_PLAN.md — Device label in APK Accept dialog (Dispatch FORGE-1)

## Goal
Show a friendly browser-derived device label ("Chrome on macOS", "Edge on Windows 11") in the APK Accept dialog/notification when a browser requests pairing. Auto-detected via UA-CH + UA fallback; user-renameable in Settings; backward-compatible with v22 APK and older browsers.

## Architecture
Browser → BROWSER_REQUEST_PAIRING{ua, ip, deviceLabel} → Relay (pass-through + sanitize) → PAIRING_REQUEST{pairingId, ua, ip, deviceLabel} → APK PhoneService → notification body + dialog body include label.

## Tasks

### TASK-001 — lib/deviceLabel.ts (NEW)
- UA-CH async helper + UA-string sync fallback + localStorage override.
- Exports: getDeviceLabel (async), getDeviceLabelSync, getDeviceLabelOverride, setDeviceLabelOverride, clearDeviceLabelOverride, DEVICE_LABEL_KEY.
- SSR-safe (typeof window guards). 60-char cap. Strip control chars.
- ~120 lines. Lean.

### TASK-002 — hooks/usePhoneBridge.ts
- Add deviceLabel to BROWSER_REQUEST_PAIRING payload (line ~1300).
- Add deviceLabel to lastBrowserRequest snapshot + type.
- useEffect on mount calling void getDeviceLabel() to prime UA-CH cache.
- ~10 lines diff.

### TASK-003 — components/ConnectionStatus.tsx
- Extend lastBrowserRequest prop type with `deviceLabel?: string`.
- ~2 lines diff.

### TASK-004 — server.js relay pass-through
- handleBrowserRequestPairing reads payload.deviceLabel, sanitizes (≤60 chars, strip control chars), forwards in PAIRING_REQUEST JSON.
- ~10 lines diff.

### TASK-005 — APK Kotlin (PhoneService.kt)
- PAIRING_REQUEST parser reads deviceLabel via optString-equivalent on `payload`.
- buildBrowserIdentity gains deviceLabel parameter; prefers it over ua+ip when present.
- Defensive truncate to 60 chars + isISOControl filter in builder.
- ~25 lines diff.

### TASK-006 — strings.xml
- Existing `pair_request_body_template` is reused (it takes %1$s identity already). No new strings strictly needed — the build path through buildBrowserIdentity supplies the label as the identity string.
- ~0 lines diff.

### TASK-007 — build.gradle.kts versionCode 22 → 23
- Bump + comment block. ~10 lines diff.

### TASK-008 — Settings UI device-label section
- app/app/settings/page.tsx — add "This browser" section under saved-phone-IP section.
- localStorage read/write via lib/deviceLabel helpers.
- Rename + Revert affordances. ~80 lines diff.

## Execution Order
001 → 002,003,004 (parallel) → 008 → commit 1 (Web).
005 → 007 → commit 2 (Android).

## Risk Flags
- Sync send + async UA-CH: prime on mount, sync read at click time.
- SSR: every function guards typeof window.
- Backward compat: v22 APK ignores deviceLabel field; new APK falls back to generic when missing.
- Notification length: 60-char cap at lib + relay + APK render (defense in depth).

## Verification
- npx tsc --noEmit exit 0
- Kotlin compile clean (./gradlew compileReleaseKotlin OR :app:assembleRelease compile-only check via Niki)
- Visual: DevTools WS frames show deviceLabel; APK shows label in dialog.

## Status
- [x] Plan written
- [x] TASK-001 lib/deviceLabel.ts
- [x] TASK-002 usePhoneBridge.ts
- [x] TASK-003 ConnectionStatus.tsx
- [x] TASK-004 server.js
- [x] TASK-005 PhoneService.kt
- [x] TASK-006 strings.xml (no change needed)
- [x] TASK-007 build.gradle.kts versionCode bump
- [x] TASK-008 Settings UI
- [x] Web commit
- [x] Android commit
- [x] Pushed to feature/saas-multiuser
