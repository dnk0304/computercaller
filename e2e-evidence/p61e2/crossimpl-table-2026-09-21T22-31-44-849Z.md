# E2E-P6.1b (g) — phone <-> computer cross-implementation table

## SCOPE

- (g) requires that NO side is simulated. scripts/lib/scripted-phone.mjs is not imported anywhere in this run.
- relay: REAL `node server.js` pid 46920 on ephemeral port 5377, scratch Postgres postgresql://pix:pix@localhost:15433/cc
- phone: REAL debug APK (vc59, built from this tree) on a rooted API-34 AVD, reaching the relay through a TLS terminator as https://computercaller.com — the host the APK hardcodes. No app file edited.
- computer: REAL /app page + REAL shipped extension SW in one real Chromium at http://localhost:3000 (the baked app origin), so the relay-ticket CSRF pin is SATISFIED rather than bypassed.

## SCENARIOS NOT RUN (declared STOP — neither passes nor failures)

| scenario | status | why |
| --- | --- | --- |
| 3 resume / RESET_ROOM | STOP — NOT RUN | NOT RUN — needs a surviving pair across a page reload and a SW restart. Every pairing in this run is torn down by the reload itself (logcat: "E2E torn down (PAIRING_TERMINATED: user_left)"), so same-kid resume cannot be observed until the harness keeps one pair alive across the reload rather than re-pairing per scenario. |
| 4 F1 revocation live / F2 forward-jump live | STOP — NOT RUN | NOT RUN. F2-live is structurally blocked, not merely unfinished: E2eDedupe.observe (E2eDedupe.kt:211) only reaches the forward-jump rule for a frame that AUTHENTICATES, and the seq is bound into the AEAD AAD, so a replayed frame with a relabelled far-future seq fails its tag BEFORE dedupe sees it and refusedForwardJump never increments. Emitting a genuine far-future sealed frame needs the page's own session key AND a caller-chosen seq — and sealFrame() deliberately takes no seq argument precisely so no caller can pick one (tests/e2e-sw-chokepoint asserts that signature). The Android leg of M-A5-2 is therefore proven by android:instrumented-A5 8/8 in Part A (E2eForwardJumpVectorsTest + E2eForwardJumpObservabilityTest, which pins the logcat line), not by this harness. F1-live was not reached. |
| 5 restore-from-backup replay | STOP — NOT RUN | NOT RUN — E2eSeqStore.simulateRestoreFromBackup() (E2eSeqStore.kt:296) deletes the Keystore wrapping key, which needs a live pair to then attempt a send. Blocked behind the same surviving-pair gap as scenario 3. |
| 6 two-recipient canonical peer (vector J live) | STOP — NOT RUN | NOT RUN, and finding A6-P61B-5 is why: the browser advertised e2e=v1/mode1/recips1 in EVERY pairing this run, with the extension SW present as a listener. There is no two-recipient pair to measure live on this base, so a "vector J live" row here would be a one-recipient pair wearing the wrong label. |

## S4a-live — item 4: MUST 2 re-proved LIVE on a RESUME

The node cells pin the ORDER in the source (gate step `relay:e2e-web-epoch-floor`, 123/123: MUST2 cells "the revocation verdict is read BEFORE the epoch is admitted", "the unconditional revocation refusal is BEFORE the admission", "decideAccept (the effective mode) is BEFORE the admission"). This row is the behavioural half on the path P2.6 changed: the pair is ON, the phone’s kid is revoked through the product’s own API, and the pair is then forced through a RESUME rather than a fresh pairing.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| C-2 refusal sentence on the resume | _(none)_ | `[warning] [E2E] e2e-key-mismatch — C-2 pin failed (no-phone-` | _(none)_ | YES |
| effective mode at the refusal | _(none)_ | `ON (failing closed)` | _(none)_ | YES |
| admitted as a RESUME? | _(none)_ | `no` | _(none)_ | YES |
| session on the revoked kid after the resume | _(none)_ | _(none)_ | `(none)` | YES |

## S4a — F1-live: revoke the PHONE's key via the API

M-A5-1. The revocation is applied through the product's own /api/devicekeys/revoke and lands on the page via the unconditional list re-read on PAIRING_ACTIVE (M-A5-1(c)); no product edit and no driver-injected state.

| field | phone | page | extension SW | match |
| --- | --- | --- | --- | --- |
| revoked row | `jwTCglS_lVN14Rea_VOXnA (id=cmubtlz2p0001l27cmdgegvci)` | _(none)_ | _(none)_ | YES |
| registry revokedAt after | `2026-09-21T22:34:23.988Z` | _(none)_ | _(none)_ | YES |
| page refusal (console / chip) | _(none)_ | `[warning] [E2E] e2e-key-mismatch — C-2 pin failed (no-phone-` | _(none)_ | YES |
| computer-side session on the revoked kid | _(none)_ | _(none)_ | `(none)` | YES |
| phone user frames seen after revocation | `0` | _(none)_ | _(none)_ | NO |
