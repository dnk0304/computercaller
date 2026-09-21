# E2E-P6.1b (g) — phone <-> computer cross-implementation table

## SCOPE

- (g) requires that NO side is simulated. scripts/lib/scripted-phone.mjs is not imported anywhere in this run.
- relay: REAL `node server.js` pid 15952 on ephemeral port 3859, scratch Postgres postgresql://pix:pix@localhost:15433/cc
- phone: REAL debug APK (vc59, built from this tree) on a rooted API-34 AVD, reaching the relay through a TLS terminator as https://computercaller.com — the host the APK hardcodes. No app file edited.
- computer: REAL /app page + REAL shipped extension SW in one real Chromium at http://localhost:3000 (the baked app origin), so the relay-ticket CSRF pin is SATISFIED rather than bypassed.

## SCENARIOS NOT RUN (declared STOP — neither passes nor failures)

| scenario | status | why |
| --- | --- | --- |
| 3 resume / RESET_ROOM | STOP — NOT RUN | NOT RUN — needs a surviving pair across a page reload and a SW restart. Every pairing in this run is torn down by the reload itself (logcat: "E2E torn down (PAIRING_TERMINATED: user_left)"), so same-kid resume cannot be observed until the harness keeps one pair alive across the reload rather than re-pairing per scenario. |
| 4 F1 revocation live / F2 forward-jump live | STOP — NOT RUN | NOT RUN. F2-live is structurally blocked, not merely unfinished: E2eDedupe.observe (E2eDedupe.kt:211) only reaches the forward-jump rule for a frame that AUTHENTICATES, and the seq is bound into the AEAD AAD, so a replayed frame with a relabelled far-future seq fails its tag BEFORE dedupe sees it and refusedForwardJump never increments. Emitting a genuine far-future sealed frame needs the page's own session key AND a caller-chosen seq — and sealFrame() deliberately takes no seq argument precisely so no caller can pick one (tests/e2e-sw-chokepoint asserts that signature). The Android leg of M-A5-2 is therefore proven by android:instrumented-A5 8/8 in Part A (E2eForwardJumpVectorsTest + E2eForwardJumpObservabilityTest, which pins the logcat line), not by this harness. F1-live was not reached. |
| 5 restore-from-backup replay | STOP — NOT RUN | NOT RUN — E2eSeqStore.simulateRestoreFromBackup() (E2eSeqStore.kt:296) deletes the Keystore wrapping key, which needs a live pair to then attempt a send. Blocked behind the same surviving-pair gap as scenario 3. |
| 6 two-recipient canonical peer (vector J live) | STOP — NOT RUN | NOT RUN, and finding A6-P61B-5 is why: the browser advertised e2e=v1/mode1/recips1 in EVERY pairing this run, with the extension SW present as a listener. There is no two-recipient pair to measure live on this base, so a "vector J live" row here would be a one-recipient pair wearing the wrong label. |

## FINDINGS for Security (A6) — recorded, NOT patched

| id | what | evidence |
| --- | --- | --- |
| A6-P61B-5 | the extension SW is present as a listener but its key is NOT carried into the pairing | relay recorded the SW join (Listener (extension SW) joined lobby — receive-only (deviceId=ext-Zav1hnVVzl4XhFnhvBAYIw)) and, for the same room, a browser advert of e2e=v1/mode1/recips1 — one recipient. Scenario 6 is blocked behind this. Per the Part 3 brief this is recorded as a PRODUCT (B9) finding for Security and is NOT patched in this lane. |
| A6-P61C-REPAIR-WRAP | the page fails to find its wrap when RE-pairing after a lobby reset, though the first pairing opened cleanly | zero e2e-setup-failed at the end of the first ON/ON pairing, 1 after the reset-and-re-pair cycles. Last line: [warning] [E2E] e2e-setup-failed — the accept block has no wrap for our deviceId (1 wrap(s), none ours). The phone re-wraps to a recipient the reloaded page no longer recognises as itself, which is the A6-P61B-8 family surfacing on the re-pair path specifically. Recorded for Security, NOT patched (product frozen after Step A). |

## S1 — ON/ON live pair, SAS

Both sides encrypted; ONE real pairing; both humans confirm on their own surface.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| browser e2e advert (relay-observed) | _(none)_ | `v1/mode1/recips1` | _(none)_ | NO |
| SAS digits (read off the two SURFACES) | `31644` | `31644` | `ABSENT — no SAS impl in the shipped extension` | YES |
| SAS_REQUIRED receiver match count (M-A6-3) | `1` | _(none)_ | _(none)_ | YES |
| sealed BEFORE confirmation (M-A6-4) | `YES — unexpected` | _(none)_ | _(none)_ | NO |
| sealed AFTER both confirmations (M-A6-4) | `yes` | _(none)_ | _(none)_ | YES |
| kid | `yYOc9Mr3vioBBWkUka0P6Q` | _(none)_ | _(none)_ | NO |
| mode | `ON` | `Encrypted` | `counts-only` | NO |
| phone armed line (post-confirm) | `E2E armed kid=yYOc9Mr3vioBBWkUka0P6Q epoch=1 mode=ON verifie` | _(none)_ | _(none)_ | YES |

## S1b — refusals are load-bearing

Each side's "Doesn't match" exercised once against a real pair.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| phone refused -> pair sealed? | `no seal` | _(none)_ | _(none)_ | YES |
| page refused -> refused/torn-down surface | _(none)_ | `refusedNodes=1 chip=Pair again` | _(none)_ | YES |
