# E2E-P6.1b (g) — phone <-> computer cross-implementation table

## SCOPE

- (g) requires that NO side is simulated. scripts/lib/scripted-phone.mjs is not imported anywhere in this run.
- relay: REAL `node server.js` pid 43476 on ephemeral port 3515, scratch Postgres postgresql://pix:pix@localhost:15433/cc
- phone: REAL debug APK (vc59, built from this tree) on a rooted API-34 AVD, reaching the relay through a TLS terminator as https://computercaller.com — the host the APK hardcodes. No app file edited.
- computer: REAL /app page + REAL shipped extension SW in one real Chromium at http://localhost:3000 (the baked app origin), so the relay-ticket CSRF pin is SATISFIED rather than bypassed.

## SCENARIOS NOT RUN (declared STOP — neither passes nor failures)

| scenario | status | why |
| --- | --- | --- |
| 3 resume / RESET_ROOM | STOP — NOT RUN | NOT RUN — needs a surviving pair across a page reload and a SW restart. Every pairing in this run is torn down by the reload itself (logcat: "E2E torn down (PAIRING_TERMINATED: user_left)"), so same-kid resume cannot be observed until the harness keeps one pair alive across the reload rather than re-pairing per scenario. |
| 4 F1 revocation live / F2 forward-jump live | STOP — NOT RUN | NOT RUN. F2-live is structurally blocked, not merely unfinished: E2eDedupe.observe (E2eDedupe.kt:211) only reaches the forward-jump rule for a frame that AUTHENTICATES, and the seq is bound into the AEAD AAD, so a replayed frame with a relabelled far-future seq fails its tag BEFORE dedupe sees it and refusedForwardJump never increments. Emitting a genuine far-future sealed frame needs the page's own session key AND a caller-chosen seq — and sealFrame() deliberately takes no seq argument precisely so no caller can pick one (tests/e2e-sw-chokepoint asserts that signature). The Android leg of M-A5-2 is therefore proven by android:instrumented-A5 8/8 in Part A (E2eForwardJumpVectorsTest + E2eForwardJumpObservabilityTest, which pins the logcat line), not by this harness. F1-live was not reached. |
| 5 restore-from-backup replay | STOP — NOT RUN | NOT RUN — E2eSeqStore.simulateRestoreFromBackup() (E2eSeqStore.kt:296) deletes the Keystore wrapping key, which needs a live pair to then attempt a send. Blocked behind the same surviving-pair gap as scenario 3. |
| 6 two-recipient canonical peer (vector J live) | STOP — NOT RUN | NOT RUN, and finding A6-P61B-5 is why: the browser advertised e2e=v1/mode1/recips1 in EVERY pairing this run, with the extension SW present as a listener. There is no two-recipient pair to measure live on this base, so a "vector J live" row here would be a one-recipient pair wearing the wrong label. |

## S3 — ONE pair held across a page reload and an SW restart

The surviving-pair capability scenarios 4 and 5 are blocked behind, and the live exercise of P6.1d-A 20fc058 (deviceKeyForAccept on the resume path).

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| kid before the reload | `cM8-C43Ux3glgHt712HHgQ` | _(none)_ | _(none)_ | NO |
| relay auto-resumed (same pair) | _(none)_ | `yes` | _(none)_ | YES |
| new BROWSER_REQUEST_PAIRING in the window (would mean re-pair) | _(none)_ | `no` | _(none)_ | YES |
| terminateActivePair in the window | _(none)_ | `none` | _(none)_ | YES |
| page console resume marker | _(none)_ | `[log] [PhoneBridge] relay-confirmed resume — silent backfill` | _(none)_ | YES |
| e2e-setup-failed on the RESUME (REPAIR-WRAP) | _(none)_ | `0` | _(none)_ | YES |
| kid after the reload | _(none)_ | _(none)_ | `(none)` | NO |
| kid after the SW restart | _(none)_ | _(none)_ | `(none)` | NO |
| persisted seq max(next) before -> after | _(none)_ | `0 -> 2` | _(none)_ | YES |
| "E2E armed" lines before -> after (phone re-arm?) | `1 -> 1` | _(none)_ | _(none)_ | YES |

## S3b — RESET_ROOM: new epoch, new SAS, and the REPAIR-WRAP re-proof

Item 6. The console is snapshotted per pairing (Part 3's near-miss: read cumulatively at the end, a re-pair failure reads as a Critical against the FIRST pairing).

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| kid before RESET_ROOM | `cM8-C43Ux3glgHt712HHgQ` | _(none)_ | _(none)_ | NO |
| kid after RESET_ROOM + re-pair | `(none)` | _(none)_ | _(none)_ | NO |
| SAS on the new epoch (phone / page) | `-` | `-` | _(none)_ | NO |
| e2e-setup-failed for THIS pairing only | _(none)_ | `0` | _(none)_ | YES |
| reset performed | _(none)_ | `NO` | _(none)_ | NO |
