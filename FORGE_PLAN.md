# FORGE_PLAN.md — MMS SEND (web → phone → recipient)

Branch: `feature/mms-send` off `3c02462` | Author: Forge

## Goal
Add MMS sending to ComputerCaller without forcing the app to become the
default SMS handler. Web user attaches an image → browser downscales →
sends `SEND_MMS` over WS → phone composes an MMS PDU and ships it via
`SmsManager.sendMultimediaMessage(...)` → SMS_SEND_STATUS lifecycle frames
flow back to the web bubble.

## No-default-app verdict (load-bearing)
- `SmsManager.sendMultimediaMessage(contentUri, locationUrl,
  configOverrides, sentIntent)` does NOT require the caller to be the
  default SMS handler. KitKat's lockdown was on direct SMS PROVIDER
  WRITES; the `SmsManager` send path delegates to `MmsService`, which
  composes/ships the PDU regardless of caller default-app status as
  long as the caller holds `SEND_SMS`.
- Edge case: multi-SIM devices with no default subscription — sentIntent
  fires with `RESULT_NO_DEFAULT_SMS_APP`. Mitigation: per-subscription
  `createForSubscriptionId(subId)` when web supplies `simId`.
- Confirmation: the app already sends SMS without being default via the
  same `SmsManager` (SmsHandler.kt:59). Microsoft Phone Link ships MMS
  off Android without being the default SMS app — same surface.
- **Verdict: CONFIRMED-with-caveat — works without default-app on
  SDK 35**, modulo the multi-SIM-no-default edge handled by simId
  routing.

## Tech stack decision
- Vendor `com.klinkerapps:android-smsmms:5.2.6` (Maven Central) for
  M-Send.req PDU composition. Wire-format mistakes silently fail at
  carriers — using the de-facto reference library is the safe path.
  Apache 2.0, ~150KB.

## Task Breakdown

### TASK-A1 — gradle: klinker dep + versionCode bump
- Files: `app/build.gradle.kts` · LOC: ~5
- Status: done

### TASK-A2 — AndroidManifest: FileProvider + xml/file_paths
- Files: `AndroidManifest.xml`, `res/xml/mms_file_paths.xml` (NEW)
- Status: done

### TASK-A3 — MmsHandler.sendMms()
- Files: `MmsHandler.kt` · LOC: ~180
- Status: done (used explicit setX(...) calls on SendReq/PduPart to
  bypass Kotlin property/setter ambiguity vs the outer `body` parameter)

### TASK-A4 — SmsStatusReceiver: MMS_SENT branch
- Files: `SmsStatusReceiver.kt` · LOC: ~30
- Status: done

### TASK-A5 — PhoneService.kt: SEND_MMS frame handler
- Files: `PhoneService.kt` · LOC: ~60
- Status: done

### TASK-B1 — usePhoneBridge.ts sendMms()
- Files: `hooks/usePhoneBridge.ts` · LOC: ~90
- Status: done

### TASK-V1 — Verification (tsc, kotlin compile, lint baseline)
- tsc --noEmit: clean (EXIT=0)
- compileReleaseKotlin: BUILD SUCCESSFUL
- assembleRelease (R8 minified): BUILD SUCCESSFUL — APK 3.85MB produced
- eslint baseline: 10 problems/1 error (UNCHANGED from pre-edit baseline)
- Status: done

## Execution order
A1 → A2 → A3 → A4 → A5 → B1 → V1

## Risk flags
1. PDU wire format → mitigated by using klinker.
2. Multi-SIM no-default → mitigated by createForSubscriptionId(subId).
3. Carrier APN provisioning — user-side, out of scope.
4. Relay frame size — default ws limit is 100MB, ~1MB base64 fits.
5. No real-device test in this engagement — APK rebuild + sideload owed.

## Open decisions
- Web UI for attach + preview: per Ken's brief, Layer C is Pixel's.
  Forge exposes `sendMms()` on the `usePhone()` surface; Pixel wires the
  paperclip button + preview thumb against this contract.
