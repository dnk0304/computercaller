# P6.1e — STOP report: three gate reds and one new flip-gating product finding

Forge, 2026-09-21. Base **53d89b7** (`git rev-parse HEAD` verified before anything else).
Lane: `FIRE-E2E-P6.1e-final-live.md`. Product FROZEN — nothing in `hooks/`, `lib/`, `app/`,
`components/`, `server.js` or `dnkdialer-android/` was edited by this lane. The gate's own
`git-identity-clean-base-ancestry` step recorded `dirtyPaths 0`, `offLane 0`, scope-base `53d89b7`.

Step A: `bun run e2e:gate --phase P6.1C --lane all`, sequential, Chrome-closed window,
6.31 GiB free at `env:headroom` (floor 6, never lowered), AVD on pinned serial `emulator-5562`,
`dnkdialer-android/app/build/reports/` deleted first (R-BI b).

**Result: FAIL — 113/116.** JSON: `e2e-evidence/gate-P6.1C-53d89b7.json`.

Items 1-4, 7, 8 NOT RUN (see §5). Item 5 NOT MET. Item 6 MET (§6).

---

## 1. relay:e2e-web-frame-classifier.test.mjs 0/1 — PROVEN ENVIRONMENT CAUSE + a real robustness defect

`FAIL the shipped isSealedFrameType loaded`, then `TypeError: isSealedFrameType is not a function`
at `tests/e2e-web-frame-classifier.test.mjs:204`. The suite scored 174/174 in P2.7's lane at
d206fe4 and `git diff d206fe4..53d89b7` is empty, so the committed content is identical.

**Root cause.** `loadWebClassifier()` (`tests/e2e-web-frame-classifier.test.mjs:117`) ends its
slice of `hooks/useE2e.ts` at `USEE2E.indexOf("\n}\n", fnAt)`. Git for Windows sets
`core.autocrlf=true` in the **system** gitconfig (`file:C:/Program Files/Git/etc/gitconfig`), so a
checkout writes the file to disk as CRLF while the blob in git is LF. Measured on this tree:

    SEALED_FRAME_TYPES at 6385
    isSealedFrameType  at 8625
    indexOf("\n}\n",     fnAt) = -1      <-- the slice end
    indexOf("\r\n}\r\n", fnAt) = 8886
    hooks/useE2e.ts on disk: CR count 1155 ; the git blob: 0

`end` becomes `-1 + 3 = 2`, `USEE2E.slice(start, 2)` is empty, `runFragment("")` returns `{}`,
`isSealedFrameType` is `undefined`.

**Proof — same blob, only the line endings differ:**

    git show 53d89b7:hooks/useE2e.ts > <scratch>/useE2e.LF.ts
    P27_USEE2E_PATH=<scratch>/useE2e.LF.ts node tests/e2e-web-frame-classifier.test.mjs
      -> e2e-web-frame-classifier: 174/174 checks passed

versus 0/1 on the CRLF working copy. Nothing else changed.

**Why this is more than a local quirk.** The suite passed in P2.7's worktree only because that
lane had just *written* `hooks/useE2e.ts` with its editor (LF) and never re-checked it out. On
any fresh checkout or clone on Windows — what this lane did, and what CI would do — the merged
tip's gate is RED. A detector that depends on the working copy's line endings is not a detector.

**Remedy, NOT applied.** `git config --local core.autocrlf false` + re-checkout makes the working
copy match the canonical blobs and clears it with no committed change. Not applied here because it
would spend the single R-K environment re-run on a gate that would still fail on §2. The durable
fix belongs in the suite (match `\r?\n`, or normalise after `readFileSync`) and is Ken's to route:
it is a test-file edit inside the artefact this lane exists to grade.

## 2. p6:staging-relay 85/86 — GENUINE RED ON THE TIP, attributable to P2.6 (a653d3f)

The single failing check:

- assertion `scripts/e2e-staging-relay-proof.mjs:933-934`,
  `rebound/ON: the refusal names the floor and the offered epoch`,
  pinning `/pairEpoch 30 is at or below the stored floor 30/`.
- what the product now emits:
  `E2E pairEpoch 30 equals the stored floor 30 for <user> <kid> under the expected kid, but that
  kid has no seq history left to continue: refusing the pairing (A3-M2 + A2).`

That is **P2.6's new `seq-state-missing` branch** (Security MUST #1: an equal-epoch admit also
requires surviving seq history; no probe = refuse, fail closed). The attacker's replayed block has
no surviving seq history, so the refusal now leaves by the seq-state door rather than the floor
door, and the detail sentence changed with it.

Every sibling assertion still passes — `refused by the A3-M2 epoch floor specifically`
(`error === "e2e-epoch-replayed"`) is green — so the refusal **code**, the badge and the SAS
divergence are unchanged. Only the pinned English moved.

**Attribution.** `git log -- scripts/e2e-staging-relay-proof.mjs` puts a653d3f
(`[E2E-P2.6] a admission rule: equal epoch admits as RESUME only when the kid matches`) on top:
P2.6 re-pinned parts of this proof and missed this string. It could not have been caught in P2.6's
own lane — P2.6 was node-only and its "node sweep 47 suites 0 red" runs `tests/*.test.mjs`, while
`p6:staging-relay` is a gate step over `scripts/e2e-staging-relay-proof.mjs`. This is precisely the
grade R-BM/R-BN deferred to this re-gate, and it has come back red.

**Not fixed here.** Re-pinning the literal is one line, but this lane exists to grade P2.6;
re-pinning P2.6's own assertion to match P2.6's own new behaviour inside that grade would be
marking the homework. Ken's ruling. When it is re-pinned it needs the usual treatment: plant-prove
the new pin goes red, and keep a negative control proving the refusal still happens at the floor
and not downstream.

## 3. reap:ext-sw-lifetime-proof leaked 1 — harness leak

`node.exe#13052 (ppid 46876, parent-dead)`, command line `node scripts/ext-sw-lifetime-proof.mjs`,
created 2026-09-21T18:17:52 — spawned by this gate, so mine. Identity re-verified (image name +
command line + creation time) immediately before the kill per rule 14a, reaped, confirmed gone.
The same harness leaked the same way in P3 (`e2e-p3/.e2e-lock`: "node 46672, ext-sw-lifetime-proof,
held port 41777"), so it is a recurring harness leak, not a one-off.

## 4. NEW PRODUCT FINDING — A6-P61E-WEB-RAWSEND-3 (flip-gating class)

**Three frozen §13.7 sealed types leave the web client in PLAINTEXT on an encrypted pair.**

`sendCommand` (`hooks/usePhoneBridge.ts:3244-3271`) is, by its own comment and by P4's design,
*THE* outbound seal chokepoint. Three senders bypass it with a raw socket write:

| type | raw send | in web SEALED_FRAME_TYPES | in Android SEALED_TYPES (§13.7) |
|---|---|---|---|
| `MAKE_CALL` | `hooks/usePhoneBridge.ts:3669-3671` | yes | yes |
| `NOTIFICATION_REPLY` | `hooks/usePhoneBridge.ts:4459` | yes | yes |
| `NOTIFICATION_DISMISS` | `hooks/usePhoneBridge.ts:4471` | yes | yes |

Web list: `hooks/useE2e.ts` `SEALED_FRAME_TYPES` (28 entries, P2.7).
Android list: `dnkdialer-android/app/src/main/java/com/dnkdialer/companion/E2eFrameGate.kt`
`SEALED_TYPES` ("§13.7, FROZEN").

**What the phone does with them.** `E2eFrameGate.inbound()` — plaintext + latch on +
`isSealedType(type)` -> `droppedInbound++`, `Drop("plaintext under the latch")`; the branch is
commented "exactly what a stripping relay produces". The only exception is the relay-minted
`FILE_FAILED` path, which does not apply here.

**User-visible on every ON pair:**
- **Dialling from the computer does nothing** — `MAKE_CALL` is dropped by the phone. That is the
  product's headline feature.
- Replying to and dismissing a phone notification from the computer both silently fail.
- The dialled **number** and the notification **reply text** cross the relay in the clear on a pair
  whose UI tells the user it is encrypted.

**Class.** The same class Ken has twice ruled FLIP-GATING — core-flow breakage on every encrypted
pair, never exercised live because no previous lane placed a call or touched a notification on an
encrypted pair.

**Not caused by P2.7.** The raw sends predate it; P2.7 neither introduced nor touched them. What
P2.7 did was make the contradiction legible: the list now says these three are sealed and the send
says they are not. Distinct from the APP_PING flag ruled in R-BM — `APP_PING` is *absent* from the
sealed list, so its raw send is spec-correct bytes; these three are *present* on it, so theirs is not.

**Recorded, NOT patched** (product frozen).

## 5. Item 2's prescribed method is VOID on this tip

The brief specifies `END_CALL` with no active call so `S3-seq` is load-bearing; fallback
`AUDIO_DISCONNECT`; explicitly not `APP_PING`. On 53d89b7, P2.7 replaced the exclusion rule with
the frozen 28-member inclusion list. Measured against that list:

    END_CALL         in SEALED_FRAME_TYPES: false
    AUDIO_DISCONNECT in SEALED_FRAME_TYPES: false
    APP_PING         in SEALED_FRAME_TYPES: false

Neither the method nor its fallback is sealed any more, so neither moves the page's send counter:
`S3-seq` would still read `0 -> 0` and the brief's own rule ("the driver must FAIL, not report
inconclusive") would fire on a false negative. The method was correct when P2.6 proposed it — under
the exclusion rule `END_CALL` *was* sealed — and P2.7 invalidated it.

Every page-originated type that goes through the chokepoint:

    END_CALL x2, SET_SPEAKER, SET_AUDIO_SOURCE, SEND_SMS, SEND_DTMF,
    GET_CONTACTS, DECLINE_CALL, AUDIO_DISCONNECT, AUDIO_CONNECT, ANSWER_CALL

Of these **only `SEND_SMS` is on the sealed list** — and the brief forbids SMS. `MAKE_CALL`,
`NOTIFICATION_REPLY` and `NOTIFICATION_DISMISS` are on the list but bypass the chokepoint (§4), so
they do not move the counter either.

So on this tip there is **no page-originated sealed frame that is both driveable from the UI and
free of an SMS**. Item 2 as written is unachievable and needs Ken's ruling. Candidates: allow
`SEND_SMS` on the AVD (no SIM, no carrier — it sends nothing anywhere), or re-spec item 2 after §4
is fixed.

Side note for Security's ack: it follows from the same list that `ANSWER_CALL`, `DECLINE_CALL`,
`END_CALL`, `SEND_DTMF` and the audio commands are **plaintext by spec** on an encrypted pair.
Android agrees, so this is conformant, not a defect — but DTMF digits in the clear deserves a
sentence in the ack rather than silence.

## 6. Item 6 — redaction grep: CLEAN

Pattern set = the §5 item-7 seven (JWT prefix, the token/ticket query-param forms, bearer,
password, secret, apikey) over the whole committed
`e2e-evidence/` tree, excluding `<redacted>`:

    measured BEFORE this document was added:
      11 raw matches, all 11 in e2e-evidence/E2E-SPEC-v1.0.md
    measured AFTER it was added (the committed state):
      16 raw matches: the same 11, plus 5 in this file

All eleven spec hits are the English word "secret" in the frozen spec's prose ("all-zero shared
secret", "Shared secrets and any transient key bytes are overwritten", the reviewer-test
paragraph, ...). The five in this file are this section naming the pattern set in prose. There is
no `<redacted>` marker on any of them because none of them is redacted material.

**Zero credential material anywhere in the tree** — no JWT, no token or ticket query parameter, no
bearer header, no password, no API key, in any committed evidence file. That is what item 6
asserts, and it holds. The raw hit count is not zero and was never going to be: the pattern set
contains four ordinary English words, and both the frozen spec and any document discussing the
grep will match them. A future lane should read the classification, not the count.

## 7. What was NOT started

No live scenario was run; no browser pairing was driven beyond the gate's own harnesses. The AVD was
booted, rooted, hosts- and trust-store-prepared (the Conscrypt APEX overlay is tmpfs and was
re-applied after this boot: 135 certs, `u:object_r:system_file:s0`, in both init's and zygote's
mount namespaces) and used only by the gate's android lane.

No `--phase P6.1D --lane all` gate was started — it grades the same tree and would carry §1 and §2
unchanged.

No gate JSON appeared in the worktree that this lane did not start: the only JSON newer than this
lane's start is `gate-P6.1C-53d89b7.json`, which it produced.

## 8. What Ken has to rule before this lane can be re-fired

1. §2 — who re-pins `scripts/e2e-staging-relay-proof.mjs:934`, and with what plant proof.
2. §1 — whether the classifier suite is hardened against CRLF checkouts (it must be, or the tip's
   gate is red for the next person who checks it out), or whether lanes are told to set
   `core.autocrlf=false`.
3. §4 — `A6-P61E-WEB-RAWSEND-3`: almost certainly a P2.8 on the same pattern as P2.7, and it is
   flip-gating, so vc60 cannot sign on P6.1e evidence gathered before it lands.
4. §5 — the replacement method for item 2.

Re-firing the live items before 2 and 3 land would burn a Chrome window on evidence a P2.8 re-gate
invalidates.
