# E2E-P6.1b (g) — phone <-> computer cross-implementation table

## SCOPE

- (g) requires that NO side is simulated. scripts/lib/scripted-phone.mjs is not imported anywhere in this run.
- relay: REAL `node server.js` pid 11052 on ephemeral port 4061, scratch Postgres postgresql://pix:pix@localhost:15433/cc
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
| A6-P61B-5 | the extension SW is present as a listener but its key is NOT carried into the pairing | relay recorded the SW join (Listener (extension SW) joined lobby — receive-only (deviceId=ext-GD3Z94QlRez_ihbPoW9hzQ)) and, for the same room, a browser advert of e2e=v1/mode1/recips1 — one recipient. Scenario 6 is blocked behind this. Per the Part 3 brief this is recorded as a PRODUCT (B9) finding for Security and is NOT patched in this lane. |
| A6-P61D-RESUME-TEARDOWN | a bare page reload terminated the active pair instead of resuming it | relay: [Relay][r3hhKKyE:4e725f26] terminateActivePair: user_left. Part 3 predicted this shape ("if a bare reload still yields user_left with no abort lines before it -> product finding"). Recorded, NOT patched. Delta log: relay-delta-S3-reload-2026-09-21T13-10-50-059Z.log |

## S1 — ON/ON live pair, SAS

Both sides encrypted; ONE real pairing; both humans confirm on their own surface.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| browser e2e advert (relay-observed) | _(none)_ | `v1/mode1/recips1` | _(none)_ | NO |
| SAS digits (read off the two SURFACES) | `95505` | `95505` | `ABSENT — no SAS impl in the shipped extension` | YES |
| SAS_REQUIRED receiver match count (M-A6-3) | `1` | _(none)_ | _(none)_ | YES |
| sealed BEFORE confirmation (M-A6-4) | `no` | _(none)_ | _(none)_ | YES |
| sealed AFTER both confirmations (M-A6-4) | `yes` | _(none)_ | _(none)_ | YES |
| kid | `_l3Mbsxari2roPagnW7Avw` | _(none)_ | _(none)_ | NO |
| mode | `ON` | `Encrypted` | `counts-only` | NO |
| phone armed line (post-confirm) | `E2E armed kid=_l3Mbsxari2roPagnW7Avw epoch=1 mode=ON verifie` | _(none)_ | _(none)_ | YES |

## S1c — R1 condition 3: zero plaintext phone frames while ON

Counted on the phone's post-TLS wire inside this harness's TLS terminator, NOT from the relay log — server.js frameLabel (:113-116) prints only type= and bytes=, so a sealed and a plaintext frame of the same type are indistinguishable there at any verbosity. Window = frames 13..17 of C:\Users\D\worktrees\computercaller\p61d-logs\phone-frames-2026-09-21T13-10-50-059Z.log.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| evidence file | `C:\Users\D\worktrees\computercaller\p61d-logs\phone-frames-2` | _(none)_ | _(none)_ | NO |
| window (line range in that file, data lines) | `13..17` | _(none)_ | _(none)_ | NO |
| phone frames while ON (all types) | `5` | _(none)_ | _(none)_ | NO |
| of those, USER frames (SPEC 13.7 sealed list) | `4` | _(none)_ | _(none)_ | NO |
| of those, PLAINTEXT (no {e,kid,s,c} envelope) | `0` | _(none)_ | _(none)_ | YES |
| ALL frame types seen in the window (sealed-list members marked *) | `ACCEPT_PAIRING SYNC_ESTIMATE* CONTACTS_CHUNK* MESSAGES_CHUNK` | _(none)_ | _(none)_ | NO |
| partial-seal frames (CALL_STATUS: state clear by §13.7, not asserted) | `0` | _(none)_ | _(none)_ | NO |
| SW badge-credited plaintext successes | _(none)_ | _(none)_ | `null` | NO |

## S1d — M-A6-5: SAS grouping parity on the two RENDERED surfaces

Read back off the live surfaces, not off the normalised scrape. R-BK froze UNGROUPED five digits (§13.3). Screenshots for both surfaces are in this run's log dir and were opened before this row was written.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| phone hero face — rendered string | `"95505"` | _(none)_ | _(none)_ | YES |
| page dialog — rendered string | _(none)_ | `"95505"` | _(none)_ | YES |
| equal AND ungrouped on both | `95505` | `95505` | _(none)_ | YES |
| phone TalkBack contentDescription (spoken form) | `"Code 9 5 5 0 5. Compare it with the code on your computer."` | _(none)_ | _(none)_ | NO |

## S1e — M-A6-2: device-key registration on login

The listing is taken AFTER cold sign-in and BEFORE any pairing was offered, which is the only ordering that distinguishes register-on-login from register-on-pair. ids only (A4-M5) — no publicKey bytes.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| GET /api/devicekeys/list (pre-pairing) answered | `yes` | _(none)_ | _(none)_ | YES |
| live phone DeviceKey rows at that moment (deviceIds) | `ivzpm4LyJUxjx9h8INm9jw` | _(none)_ | _(none)_ | YES |
| top-level userId on /list vs seeded User.id (R-BH option B) | `cmub9k3rb0000l2acr3e6j8a1` | `cmub9k3rb0000l2acr3e6j8a1` | _(none)_ | YES |
| C-2 verdict for the PHONE's kid on the live pairing | `kid=_l3Mbsxari2roPagnW7Avw verified=true mode=ON` | _(none)_ | _(none)_ | YES |
| evidence file (pre-pairing listing) | `devicekeys-list-before-pairing-2026-09-21T13-10-50-059Z.json` | _(none)_ | _(none)_ | NO |

## S1b — refusals are load-bearing

Each side's "Doesn't match" exercised once against a real pair.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| phone refused -> pair sealed? | `no seal` | _(none)_ | _(none)_ | YES |
| page refused -> refused/torn-down surface | _(none)_ | `refusedNodes=1 chip=Pair again` | _(none)_ | YES |

## S3 — ONE pair held across a page reload and an SW restart

The surviving-pair capability scenarios 4 and 5 are blocked behind, and the live exercise of P6.1d-A 20fc058 (deviceKeyForAccept on the resume path).

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| kid before the reload | `Y6tH61hEzvx1v97K5vUgYQ` | _(none)_ | _(none)_ | NO |
| relay auto-resumed (same pair) | _(none)_ | `yes` | _(none)_ | YES |
| new BROWSER_REQUEST_PAIRING in the window (would mean re-pair) | _(none)_ | `no` | _(none)_ | YES |
| terminateActivePair in the window | _(none)_ | `[Relay][r3hhKKyE:4e725f26] terminateActivePair: user_left` | _(none)_ | NO |
| page console resume marker | _(none)_ | `[log] [PhoneBridge] relay-confirmed resume — silent backfill` | _(none)_ | YES |
| e2e-setup-failed on the RESUME (REPAIR-WRAP) | _(none)_ | `0` | _(none)_ | YES |
| kid after the reload | _(none)_ | _(none)_ | `(none)` | NO |
| kid after the SW restart | _(none)_ | _(none)_ | `(none)` | NO |
| persisted seq max(next) before -> after | _(none)_ | `0 -> 0` | _(none)_ | YES |
| "E2E armed" lines before -> after (phone re-arm?) | `1 -> 1` | _(none)_ | _(none)_ | YES |

## S3b — RESET_ROOM: new epoch, new SAS, and the REPAIR-WRAP re-proof

Item 6. The console is snapshotted per pairing (Part 3's near-miss: read cumulatively at the end, a re-pair failure reads as a Critical against the FIRST pairing).

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| kid before RESET_ROOM | `Y6tH61hEzvx1v97K5vUgYQ` | _(none)_ | _(none)_ | NO |
| kid after RESET_ROOM + re-pair | `kL8dPHZl89Mvb2JbQahcMQ` | _(none)_ | _(none)_ | YES |
| SAS on the new epoch (phone / page) | `60196` | `60196` | _(none)_ | YES |
| e2e-setup-failed for THIS pairing only | _(none)_ | `0` | _(none)_ | YES |
| reset performed | _(none)_ | `yes` | _(none)_ | YES |

## S4b — F1-live: "Forget this computer" (the WEB control — see the scenario note)

The brief located this control on the phone; it does not exist there. The string and handler live in components/ConnectionStatus.tsx + usePhoneBridge.ts:3586 (runRevokingTeardown: revokeLocalPair + resetRoom + revoke this browser's row). Driven where it exists; the PHONE is the side whose teardown is asserted.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| control clicked | _(none)_ | `yes` | _(none)_ | YES |
| phone teardown line | `09-21 15:28:11.840 17888 17928 I PhoneService: E2E torn down` | _(none)_ | _(none)_ | YES |
| browser registry row revoked | _(none)_ | `8427638d3dbcbf886c322ad63aa2d7b3,8427638d3dbcbf886c322ad63aa` | _(none)_ | YES |
| kid the pair was on | `9-JTfBfibljWdDqoeSHaXw` | _(none)_ | _(none)_ | NO |

## S4a — F1-live: revoke the PHONE's key via the API

M-A5-1. The revocation is applied through the product's own /api/devicekeys/revoke and lands on the page via the unconditional list re-read on PAIRING_ACTIVE (M-A5-1(c)); no product edit and no driver-injected state.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| revoked row | `ivzpm4LyJUxjx9h8INm9jw (id=cmub9kv1b0001l2j0ivssp6ax)` | _(none)_ | _(none)_ | YES |
| registry revokedAt after | `2026-09-21T13:29:51.417Z` | _(none)_ | _(none)_ | YES |
| page refusal (console / chip) | _(none)_ | `[warning] [E2E] e2e-key-mismatch — C-2 pin failed (no-phone-` | _(none)_ | YES |
| computer-side session on the revoked kid | _(none)_ | _(none)_ | `(none)` | YES |
| phone user frames seen after revocation | `0` | _(none)_ | _(none)_ | NO |
