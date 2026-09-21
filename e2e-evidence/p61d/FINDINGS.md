# P6.1d-B — findings and flip-set status

Lane: `e2e/p6.1d-live`, base `e2e/integration` 9c088c7 (P6.1d-A merged).
Authoritative run: `crossimpl-table-2026-09-21T13-10-50-059Z` → 70 passed, 2 failed, 2 findings.
Phone: debug APK built by `android:assembleDebug` from this tree, versionCode 59 untouched,
on AVD `e2e_p61b` / `emulator-5562`. Computer: one real Chromium with the real shipped
extension SW. Relay: real `node server.js`, real scratch Postgres. Nothing simulated.

## Step A — the grade of P6.1d-A

| gate | result |
|---|---|
| `gate-P6.1C-9c088c7.json` | **PASS 114/114**, failedStep null, sequential, offLane 0 |
| `gate-P6.1D-91ace26.json` | **PASS 114/114**, failedStep null, sequential, offLane 0 |

P6.1d-A shipped with no gate JSON (its brief named `--lane node`, which the gate does not
accept). These two runs are its first and only grade, and it is **green** — no P6.1d-A.1
lane is needed. Every floor A registered is met on the merged tip: sas-confirm 58,
e2e-web-policy 151, revocation-wiring 90, devicekey-authz 83, sw-advert 47,
harness-list 149, ctx-parity 14, headroom 54, testDebugUnitTest 250, instrumented-A5 8/8,
SasVectors 7/7, e2e-ui-proof 104/104, android lint 0.

## Flip-gating items

| item | verdict | evidence |
|---|---|---|
| Step A re-gate | **PASS** | the two JSONs above |
| M-A6-2 listing | **MET** | `devicekeys-list-before-pairing.json` — a LIVE `kind=phone` row exists AFTER cold sign-in and BEFORE any pairing was offered; top-level `userId` equals the seeded `User.id` (R-BH option B). C-2 returned `verified=true` for the phone's own kid on the live pairing. |
| M-A6-5 SAS grouping | **MET** | `sas-phone-S1.png` and `sas-page-S1.png` both render **95505** — five contiguous digits, no separator, equal to each other and to the digits the driver scraped. Both PNGs were opened and read back before this line was written. |
| R1 condition 3 | **MET** | `phone-frames.log` — 4 user frames from the phone while ON (SYNC_ESTIMATE, CONTACTS_CHUNK, MESSAGES_CHUNK, CALL_LOGS_CHUNK), **0 without the `{e,kid,s,c}` envelope**. |
| REPAIR-WRAP re-proof | **MET** | `page-console-S3-repair.log` — after RESET_ROOM the re-paired page opened the new accept block's wrap: new kid, new SAS on both surfaces, **0** `e2e-setup-failed` for that pairing (console snapshotted per pairing). |
| Scenario 4 / F1-live | **MET, both directions** | see below |
| Scenario 3 / resume | **FAIL — product finding** | see A6-P61D-RESUME-TEARDOWN |

### F1-live, both directions

- **phone -> page.** The phone's DeviceKey row revoked through the product's own
  `POST /api/devicekeys/revoke`; registry then reports `revokedAt`. On the next
  `PAIRING_ACTIVE` the page re-reads the list (M-A5-1(c)) and refuses:
  `[E2E] e2e-key-mismatch — C-2 pin failed (no-phone-row) with effective mode ON — failing closed`,
  chip **"Device not verified"**, and no live session on the revoked kid.
  (`page-console-S4a-revoke.log`)
- **page -> phone.** "Forget this computer" clicked on the shipped control; the phone tore
  the pairing down — `E2E torn down (PAIRING_TERMINATED: room_reset): [SK dropped for kid=...,
  device key kept — leaving a room is not losing a key]` — and the browser's own registry
  row is `revokedAt`, i.e. a revocation and not merely a room reset.
  (`logcat-S4b-forget.log`)

F2-live deliberately not attempted (by design unreachable; Security acked — the Android leg
is covered by `android:instrumented-A5` 8/8).

## NEW FINDING — A6-P61D-RESUME-TEARDOWN (flip-gating, recorded NOT patched)

**A bare page reload resumes the pair and then immediately terminates it.**
Reproduced on three consecutive independent runs.

From `relay-delta-S3-reload.log`, in order:

```
socket_closed: soft-hold survivor (droppedRole=browser, code=1000 reason="page_unload"),
    resume window armed (180000ms), panelHold=YES
Browser joined lobby (phones=0, active=true, listener=false, claim=armed(droppedRole=browser))
auto-resumed pair after socket_closed (gap=595ms, heldFor=595ms, droppedRole=browser,
    panelHold=true, survivorHeld=true)
terminateActivePair: user_left
Dropping lobby-browser frame: type=GET_SYNC_ESTIMATE bytes=20
Dropping lobby-browser frame: type=GET_MESSAGES bytes=36
Dropping lobby-browser frame: type=GET_CALL_LOGS bytes=37
```

So the resume machinery **works** — the relay re-associates the same pair with no new
`BROWSER_REQUEST_PAIRING`, and the phone does not re-arm — and the pair is then torn down
anyway. Afterwards the page is an unpaired lobby browser and its `GET_*` frames are dropped.

`user_left` has exactly two producers in `server.js`: an explicit `LEAVE_ACTIVE:` frame from
the phone (:3267) or from the browser (:3535). **Attribution is not yet nailed down** — the
phone-side frame capture for this window contains no `LEAVE_ACTIVE`, which points at the
freshly reloaded browser as the sender, but that is an inference from absence and is recorded
as such rather than asserted.

This is **pre-existing, not caused by P6.1d-A**: P6.1c Part 3 already recorded "every pairing
in this run is torn down by the reload itself (logcat: `E2E torn down (PAIRING_TERMINATED:
user_left)`)", and the Part 3 brief anticipated exactly this shape.

Two further reds are **downstream of this one defect, not separate defects**:
`S3-samekid` and `S3-swrestart` both report the computer side holding no kid after the
reload — which is the correct consequence of a pair that has just been terminated.

## Checks that are NOT evidence, stated as such

Two checks were green while proving nothing, and now say so in the artefact rather than
inflating the pass count:

- **`S3-seq` — INCONCLUSIVE.** It compared `after >= before` with both values 0. They are 0
  whenever the page never sends a sealed frame, which is the normal case in this scenario, so
  "the counter did not reset" was vacuously true. Seq continuity across a resume is
  **untested**, not passed.
- **`S3-repairwrap` (on the resume path) — NOT LOAD-BEARING.** "Zero `e2e-setup-failed`" only
  evidences that the wrap opened if a wrap was attempted; with the pair terminated straight
  after the resume, nothing is attempted. The load-bearing REPAIR-WRAP re-proof is
  `S3-repairwrap2`, on the RESET_ROOM re-pair path, where a real pairing completes.

## Pre-existing findings re-observed

- **A6-P61B-5** — the extension SW joins as a listener but its key is not carried into the
  pairing (`recips1`). Product B9; Security R1 granted ship-dark. Recorded, not patched.

## R1 conditions 1 and 2

Condition 3 is discharged above. Condition 1 (no extension copy claiming "encrypted" or
"verified" under recips1): nothing in the surfaces this lane exercised made such a claim, but
this lane did **not** audit the extension UI exhaustively — treat that as "no counter-example
seen", not as a clearance. Condition 2 (recips2 only via a new epoch + fresh SAS) is a
constraint on future work and nothing here touches it.

## Brief correction

The brief places "Forget this computer" **on the phone**. There is no such control there:
the string and handler are web-side (`components/ConnectionStatus.tsx` aria-label,
`usePhoneBridge.ts:3586` `forgetThisComputer` -> `runRevokingTeardown`); `dnkdialer-android`
ships only `action_disconnect` / `action_disconnect_pair`. The leg was driven on the surface
where the control exists, with the phone as the side whose teardown is asserted.

## Not run (declared)

Scenario 2 (ctx dump both sides), scenario 5 (restore-from-backup replay) and scenario 6
(recips2 / vector J) are ship-dark per R-BJ + Security R1 and were NOT run in this lane.
Scenario 6 stays NOT RUN by ruling (recips2 comes later via a new epoch + fresh SAS).
