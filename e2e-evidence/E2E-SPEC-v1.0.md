# E2E-SPEC v1.0 FROZEN — End-to-end encryption for ComputerCaller

**Status: v1.0 FROZEN at E2E-P0 (design freeze), Forge 2026-09-17.** The frozen
decisions live in **§13**, which is authoritative: where §§1–12 and §13 disagree,
§13 wins and the earlier text stands as the record of how the decision was reached.
Changing anything in §13 is a breaking protocol change requiring a new version
string, not an edit. Mirrored into the repo at `e2e-evidence/E2E-SPEC-v1.0.md`.

_(merged, Ken 2026-09-16; frozen by Forge 2026-09-17)_

Sources: E2E-SPEC-security.md (Security: threat model, primitives, §9 gate, second-pass review) + E2E-SPEC-forge.md (Forge: architecture, mechanics, migration, effort). Both read the repo at e0967df. **Security verdict on Forge's design: APPROVE WITH CONDITIONS — three blockers (B1 SAS derivation, B2 bridge origin, B3 E2E-lite scope/wording) are design fixes folded below; full text in §10.**

---

## Executive summary for Dennis (plain English, 10 lines)

1. Good news first: we do **not** store your messages, calls, notifications or contacts anywhere. The "3 months" you see is how far back the phone syncs to your computer, not something we keep. Both specialists checked the database schema.
2. So the only place anyone could read your content today is **inside our relay server while it passes through** (and for a few minutes in its memory to survive a reconnect). That is the gap E2E closes.
3. Plan: every message/notification/call frame gets sealed on your phone and only opened on your computer. The relay still routes it but sees only "a message arrived, when, how big" — never what it says.
4. **No new step for you.** Keys are created silently when you log in. The lock is agreed inside the Connect → Accept you already do. Reconnect, dock, closing the panel, Reset lobby — all keep working exactly as now.
5. Notifications with the panel closed keep working; the background part holds its own key. If Chrome was fully restarted and you have not opened the panel yet, you get "New message" instead of the text until you open it once.
6. The phone is the source of truth for history — same as today. A newly paired computer starts from now and re-syncs from the phone. Nothing regresses.
7. What it cannot stop: someone who has already taken over our server at the exact moment you connect a **new** computer (unless you glance at the 5-digit code on the Accept screen), and a malicious update pushed through the Chrome Web Store or Play Store. Nobody can fix the second one with encryption; we say so honestly.
8. Cost: about **7–9 weeks** for full E2E (new app v58 + web + extension + tests + security review). A first milestone "E2E-lite" (live messages, calls AND notifications sealed — the background preview shows "New message" until you open the panel) in **~3.5–4 weeks**. Honest wording for that milestone: "Messages, calls and notifications are end-to-end encrypted as they happen. When your computer loads your history and contacts from your phone, that transfer is not yet encrypted end-to-end — it still passes through our servers in readable form."
9. Wording ladder: today we may say "encrypted in transit, nothing stored, our relay can read in flight"; after E2E-lite a narrow claim; only after the full milestone + external test may we say "end-to-end encrypted".
10. Security reviewed the design: **approved with three fixes** (the 5-digit check code must be computed so a hijacked server cannot fake it; the extension-to-page key hand-off must only trust our own extension — this one is a real weakness today and is being fixed now regardless; the first milestone must seal notifications). **Decision A is resolved by your idea (§12): "Encrypted mode" is an opt-in setting; when ON, pairing asks you to confirm a short code, which closes the hijack gap.** Two decisions left: (B) ship E2E-lite first, then full — or go straight to full; (C) history stays device-only (recommended; the "escrow" option that lets a brand-new computer read old history makes "nobody can read it" false).

---

## 1. Threat model (Security)

**Assets, ranked:** SMS/MMS bodies · phone notification bodies (banking OTPs, 2FA — account-takeover-grade for the user's *other* services; the strongest reason to do this) · contacts · call-log numbers · dialled numbers/targets · MMS blobs.

**Adversaries and outcome after E2E:** relay compromise (A1) → content denied, metadata + inject/drop/reorder remain; DB compromise (A2) → no content gain today either; host/Coolify/hoster (A3) → content denied, pairing tamper remains; operators incl. Dennis/Ken/Niki (A4) → content denied, but we can always ship a malicious client — the irreducible trust; **Chrome Web Store / Play update channel (A5/A6) → unfixable by crypto, must be named**; phone theft unlocked (A7) → game over regardless; shared computer (A8) → non-extractable key blocks export, not local use — sign-out must wipe; TLS MITM (A9) → content denied; lawful access (A10) → content we no longer possess; metadata + compelled client update remain.

**Protected:** SMS/MMS bodies, notification title/body/package, contact names+numbers, call-log numbers, dialled numbers, attachments, quick-reply text in flight.
**Visible by design (say it to Dennis):** frame type, room/user id, roles, presence/pairing state, ua/ip at pairing, HB, ciphertext size, timing, count/rhythm, account/billing/IP data. **Size + timing leak is real** → fixed padding buckets mandatory for notification/SMS frames.

**The two attacks that matter:** (1) pairing MITM under the no-new-step constraint — a compromised relay at pairing time can swap keys undetected unless the SAS is read; mitigations: TOFU pinning per (account, device) + loud key-change warning + key-transparency-lite; none replaces the SAS — **accepted risk with Dennis's name on it**. (2) Frame injection/replay/drop — AEAD gives per-frame integrity; needs per-direction counters + a replay window that tolerates the relay's legitimate frameBuffer replay (dedupe, don't reject — see §3).

Out of scope: account takeover, phoneToken theft, billing, IP logs, abuse, extension credentials, anything on a device the attacker already controls.

## 2. Keys and key exchange (Security primitives, Forge mechanics)

**Primitives (Security ruling R1, 2026-09-17 — supersedes the X25519 line below):** ECDH **P-256** → HKDF-SHA-256 (`info = "cc-e2e-v1"‖userId‖phoneDeviceId‖peerDeviceId‖pairEpoch`, salt = pairingId; transcript binding) → **AES-256-GCM** (chosen because the extension SW must decrypt with the panel closed → key must be a non-extractable WebCrypto CryptoKey; XChaCha20-Poly1305 is not in WebCrypto and would put raw key bytes in JS heap). Two directional keys per pair (`K_p2c`, `K_c2p`); nonce = 32-bit random per-session prefix ‖ 64-bit counter; AAD = type‖kid‖seq‖direction; rekey on every Accept, Reset lobby, sign-out, 2^32 frames or 30 days. Rejected: RSA, hand-rolled crypto, deriving keys from phoneToken, silent negotiation. The sign-off check on `deriveBits` over non-extractable keys was run at P0(e) and passes for P-256 (evidence below).

### 2.1 CURVE — **P-256 everywhere.** X25519 is WITHDRAWN. (Gate 1 R1, 2026-09-17, binding)

P0(e) measured both curves in a real browser and chose X25519. Gate 1 overruled
that, and the reason is worth stating plainly because it is not a curve-quality
argument: **both curves give ~128-bit security, and neither is the risk. The risk
is where the phone's private key lives.** AndroidKeyStore holds NIST curves only
— X25519 is not storable in it on any current Android release — so an X25519 wire
curve would force the phone's long-term private key into application memory,
which is the key an attacker holding the physical device is most likely to reach.
(`PURPOSE_AGREE_KEY` is also API 31+ against minSdk 26, so API 26–30 has no
Keystore-backed ECDH at all; that constraint is a P4 matter and does not change
the curve.) Choosing P-256 buys hardware key custody on the device that needs it
most, at no cryptographic cost.

The P0(e) probe evidence below is unchanged and now supports the **primary**
choice rather than a fallback.

**Encoding — PINNED, one shape everywhere.** A public key is an **uncompressed
SEC1 point: exactly 65 bytes, first byte `0x04`**, carried **base64url** on the
wire and hex in `tests/sas-vectors.json`. This is the single encoding for
WebCrypto (`exportKey('raw')` / `importKey('raw')` on P-256 produces exactly
this), AndroidKeyStore, and the extension service worker — chosen because it is
the only representation all three produce natively, so no party has to re-encode
and no party may invent a second form. Compressed points (`0x02`/`0x03`), DER/SPKI
wrappers and JWK are **not** accepted on the wire.

The relay enforces this shape and nothing else: it is a byte-carrier and does not
validate key bytes. P1 checks that every `pub`/`epk` is exactly 65 bytes starting
`0x04`; anything else → the `e2e` block is dropped, logged `e2e=badkey`, and the
pairing continues in plaintext. Never a crash, never a silent modification.

**Controls the ENDPOINTS must apply (the relay cannot and must not):**

1. **Point validation on every received key**, before any ECDH. Reject a point
   that is not on P-256, the point at infinity / identity, and any small-order or
   otherwise invalid point. WebCrypto's `importKey('raw', …, {name:'ECDH',
   namedCurve:'P-256'})` performs this validation and throws — so the rule is
   "import, and never bypass the import"; Android's `KeyFactory`/`ECPublicKey`
   path validates equivalently. A hand-rolled coordinate copy would skip exactly
   this check, which is why raw-coordinate handling is forbidden.
2. **Reject an all-zero shared secret.** If `deriveBits` ever yields all zero
   bytes, abort the pairing and surface the failure — never derive a key from it
   and never fall back to plaintext silently. This is the invalid-curve /
   degenerate-point outcome, and treating it as a normal secret is how such an
   attack succeeds.
3. **The phone's private key is non-exportable and Keystore-wrapped.** Generated
   in AndroidKeyStore with `setUserAuthenticationRequired(false)`, StrongBox when
   present, and never extracted. Web and SW keys are non-extractable WebCrypto
   `CryptoKey`s in IndexedDB — the raw private bytes never exist in the JS heap.
4. **Zero derived material after use.** Shared secrets and any transient key
   bytes are overwritten (`Arrays.fill(secret, 0)` on Android; on the web the
   derived key is imported as a non-extractable `CryptoKey` and the intermediate
   `ArrayBuffer` dropped) so a heap dump does not yield a live key.

**Vectors.** `tests/sas-vectors.json` carries **`v6-3key-p256`**: three genuine
65-byte `0x04` P-256 static points plus a genuine ephemeral P-256 `epk`, each
proved on-curve by a successful ECDH against it, with digits computed through
`lib/e2e/sas.mjs` (WebCrypto) and independently cross-checked with
`node:crypto.hkdfSync`. P4's instrumented `SasVectorsTest` asserts the same file.

**Correction (Gate 1 F-1).** The P0 text claimed "vector v5 pins exactly that
shape — a 65-byte uncompressed P-256 point". That was false and is withdrawn.
v5's `epk` is `04` followed by 64 bytes of `bb`: it pins the **framing** — that
the SAS layout's `u8` length prefix carries a 65-byte epk correctly, alongside
`u8(n)=4` and out-of-order keys — using placeholder bytes that are **not** a
point on P-256. That distinction matters now that P-256 is primary: an
implementation which correctly validates points (control 1 above) would reject
v5's epk outright and could not reproduce its digits from real key material. v6
is the vector that pins the encoding over bytes that are actually curve points;
v5 remains frozen and valid as a pure framing vector.

**Identity binding — no new user step (Dennis 20:24):** device = (userId, deviceId, publicKey). Phone: Android Keystore (`setUserAuthenticationRequired(false)`, StrongBox if present), registered on login. Web: non-extractable CryptoKey in IndexedDB, on session bootstrap. Extension SW: its own key in SW IndexedDB (SW is `chrome-extension://`, a second device on the same computer; the panel iframe is computercaller.com and shares the web key). New table `DeviceKey` (userId, deviceId, kind, publicKey, label, createdAt, lastSeen, revokedAt) — a revocation ledger, not the trust root; Security to decide whether the phone pins against it at Accept (defends relay key-swap; costs one REST call).

**Exchange inside the existing handshake:** web collects the SW public key over the existing extensionBridge/shell.js channel → `BROWSER_REQUEST_PAIRING{…, e2e:{v, recips:[DK_w.pub, DK_x.pub]}}` → forwarded in `PAIRING_REQUEST` → on **Accept** the phone mints SK, seals it per recipient → `ACCEPT_PAIRING`/`PAIRING_ACTIVE{e2e:{epk,kid,wraps[]}}` to web and `PAIR_STATE{e2e}` to the SW listener. No new permission, no CSP change, no new socket. If the SW key is unavailable, the pair still encrypts and the SW degrades to count-only badges — never plaintext.

**Verification/rotation:** SAS = 5 digits from HKDF(SK,"sas") shown on the Accept dialog and the Connected toast — informational, never blocking. Known-device re-pair reuses device keys; every Accept mints a fresh SK and bumps pairEpoch (no extra prompt — Accept already exists). Resume/hold/dock reuse the live SK (relay must re-send the same `e2e` block on the resume path). Reset lobby / sign-out / LEAVE_ACTIVE drop SK; sign-out also deletes the device key and sets revokedAt. Lost device → revoke row.

## 3. Frame envelope (Forge)

Wire stays `TYPE:body`; sealed body = `{"e":1,"kid":"…","s":<counter>,"c":"<base64url ct‖tag>"}` (+ optional plaintext `h` — see flag). Plaintext padded to buckets 64…2048 B before sealing (mandatory for notification/SMS; bulk `*_CHUNK` exempt). Unknown kid → drop + request re-pair.

**Sealed:** PHONE_NOTIFICATION, SMS_RECEIVED, MESSAGES(+_CHUNK), CONTACTS(+_CHUNK), CALL_LOGS(+_CHUNK), CALL_LOG_ENTRY, MMS_MEDIA_CHUNK/ERROR, CALL_INCOMING/ADD/UPDATE/WAITING/ANSWERED/ENDED/REMOVE, SIM_LIST, SMS_SEND_STATUS, SYNC_ESTIMATE, SEND_SMS, MAKE_CALL, NOTIFICATION_REPLY/DISMISS/REPLY_SENT/REPLY_FAILED/REMOVED. CALL_STATUS: `{state}` clear, number/name sealed.
**Plaintext:** all pairing/lobby/presence/resume/reset/HB/permission/audio/status frames, and — **mandatorily** — `GET_MESSAGES`, `GET_CALL_LOGS`, `GET_CONTACTS`: `gateBrowserSyncFrame()` is the only tier-enforcement chokepoint (clamps `since`, drops GET_CONTACTS below Plus); sealing them would move billing enforcement to the client, i.e. delete it. Leak = a timestamp + a category, no content.

**Overhead:** ~+95 B per small frame; bulk sync ≈ +35% bytes on a full 10k-row sync; MMS <1%.
**Ordering/replay — the stability trap:** frameBuffer legitimately re-sends frames on resume. Receiver keeps a 1024-wide window and **dedupes** by `s`; rejects only below the floor; decrypt failure drops the frame (never closes the socket), 3 in 10 s → request re-pair. Never a reconnect loop.
**Negotiation:** both `e2e` blocks present ⇒ encrypted, latched for the pair's life, plaintext content frames refused thereafter (downgrade protection). Either absent ⇒ legacy pair with an **"Unencrypted"** badge. Per pair, never global.
**Flag for Security:** `logNotifLifecycle()` (server.js ~198) dies when bodies are sealed. Forge default: drop the log. Alternative `h:{pkg,hasReply}` plaintext header tells the relay which app notified, forever — Security decides (Ken's prior: drop the log).

## 4. Relay changes (Forge)

Everything carrying the connection is unchanged (lobby/active, frameBuffer + replay, listener fan-out, HB, PAIR_STATE, resume claims, panel-close hold, RESET_ROOM, rate limits, tier gate). Sealed bodies are opaque strings — frameBuffer, the only place content rests on our infra, becomes meaningless without touching its logic. Entire diff: (1) `handleBrowserRequestPairing` forwards `e2e` (size-capped ~4 KB); (2) `handleAcceptPairing` copies `e2e` into PAIRING_ACTIVE and stashes it on room.active so the resume path re-sends it; (3) PAIR_STATE carries the SW's wrap; (4) logNotifLifecycle per §3 flag. Breaks: nothing real — server-side search, admin content views and stored history do not exist; contact matching, reply routing and MMS handling are already client-side. Lost: content-level support debugging → client-side "export diagnostics".

## 5. Service-worker notifications (Forge)

On PAIR_STATE with `e2e`, the SW unwraps with its non-extractable device key, keeps SK in memory and `{kid, wrap, epk}` in `chrome.storage.session` (memory-backed, cleared on browser exit — **never** `storage.local`). Each MV3 wake re-unwraps (~1 ms). If `storage.session` is empty (browser restarted) the SW has no SK until the next pair forms: **badge counts still work (metadata), body previews read "New message"** — the visible cost, state it to Dennis. Unwrap sits behind the existing unread-counter promise mutex.

## 6. History (both): **(a) device-only — recommended; it is already what ships.**

Phone is the system of record; the browser holds threads in React state, re-pulled on pair within the tier's sync range. Cost 0; Dennis loses nothing he has today. (b) encrypted-at-rest server store = 4–6 extra weeks building a store that does not exist — only if server-side history is wanted for its own sake. (c) account-key escrow = the only option that makes "nobody but your devices" **false**; label it bluntly if chosen. Visible trade-off under (a): a newly paired computer starts from now and re-syncs from the phone — today's behaviour.

## 7. Migration and compatibility (Forge)

APK gate **v58+**; v55 (live) and v57 (built) untouched. Order: relay (inert passthrough, deployable alone) → web + extension (keys, advertise recips, accept both modes) → APK v58 → encryption on for any pair where both ends are new. Dual mode per pair, indefinitely; **never a hard cutover** (would brick every v55 phone on extension auto-update). Legacy pairs show "Unencrypted — update your phone app". Retire plaintext pairs later by a separate decision. **Data migration: none** (no stored content). Pilot: update Play Data Safety in the same release as v58; listing copy must not run ahead of §9.

## 8. Effort and milestones (Forge)

Relay 0.5 wk · DeviceKey + register/list/revoke 0.5 · Android v58 2.5 · Web 2.0 · Extension SW 1.0 · connection-stability regression suite 1.5 (**non-negotiable**) · Security review + SAS/UX + wording 1.0 → **≈9 weeks serialized, ≈7 with web+extension overlapped.** Sequence: relay → keys → web+ext ∥ → APK v58 → regression → security review → wording.
**E2E-lite (≈3.5 weeks):** relay + DeviceKey + web + APK, sealing the live path only (PHONE_NOTIFICATION, SMS_RECEIVED, SEND_SMS, MAKE_CALL, CALL_*, NOTIFICATION_REPLY*); bulk sync + SW body preview stay plaintext. Wording: "Messages and calls you send and receive live are end-to-end encrypted; bulk history sync is not yet." Milestone 2 adds bulk sync + SW previews and unlocks the unqualified claim, subject to §9.

## 9. Security gate before "end-to-end encrypted" may be said (Security owns)

**Blocking conditions (any one = no claim):** plaintext payload byte reachable on the relay/logs/frameBuffer · silent plaintext fallback on a previously-E2E pair · keys recoverable by us (escrow/backup/support) · a green "encrypted" indicator on an unencrypted pair · missing padding on notification/SMS frames · any connection-stability regression vs e0967df.
**Reviewer tests:** non-extractable keys on all three clients; no key/secret in any frame, log, error, analytics; sign-out/Reset/deletion provably destroy keys; nonce uniqueness under reconnect/resume/race/restart; replay window vs frameBuffer replay; AAD relabel fails; transcript binding; epoch rotation; malicious-relay MITM at pairing (expected: succeeds silently unless SAS read — documented accepted risk); drop/reorder/replay → detect or fail closed; downgrade stripping → no silent fallback; padding hides OTP-length; **plaintext-canary grep of relay logs + heap dump under live traffic — zero hits**; no plaintext in chrome.storage.local, URLs, titles, notification ids, devtools state, error payloads; no CSP loosening/new permissions (WASM = blocker); supply-chain review; v55 + new extension pairs and shows "Not encrypted"; all e0967df stability evidence re-passes.
**Honest wording ladder:** today — "Encrypted in transit (TLS). Your messages pass through our relay and are not stored." · E2E-lite — "Message and notification content is end-to-end encrypted between your phone and your computer. Contact names and call numbers are not yet." · Full — "End-to-end encrypted. We cannot read your messages, notifications, contacts, or call history." · With escrow (c) — conditional wording; "nobody but you" is false. Always add: "We can still see that a message arrived, when, and how big it was — just not what it says." Never: zero-knowledge, anonymous, we store nothing, NSA-proof.
Re-test protocol: every finding re-tested by Security after the fix, logged in SECURITY-AUDIT.md.

## 10. Security second-pass verdict on Forge's design

# Security review of E2E-SPEC-forge.md (second pass, 2026-09-16)

**VERDICT: APPROVE WITH CONDITIONS.**

The architecture is right. Forge independently reached the same primitives, correctly identified the frameBuffer/anti-replay collision as the stability risk, correctly refused to touch the listener short-circuit, and correctly reduced the relay diff to 4 edits. Section 0(b) — "two devices, one computer" — is a genuinely good catch that I did not make. Section 6(a) and section 7 ("no data migration") are correct.

Three BLOCKERs must be closed before a line of code is written; two of them are cheap, one is a crypto-design correction. None invalidate the design.

## BLOCKERS

**B1 — The SAS cannot detect the attack it exists to detect.** `E2E-SPEC-forge.md` §2.4: `SAS = HKDF(SK, "sas")`. `SK` is minted by the phone and *forwarded* to each recipient. A MITM relay that substitutes its own `pub_w` in `BROWSER_REQUEST_PAIRING` receives `SK`, and can then re-seal **that same `SK`** to the real web key. Both endpoints compute an identical SAS and the MITM is invisible. The SAS must be derived over the **transcript**, not over the shared secret:
`SAS = HKDF(salt=pairingId, ikm = epk || sort(pub_phone, pub_peer) || pairEpoch, info="cc-sas-v1")[0:5 digits]`, computed by each side from **the keys it actually holds**. Then a swapped key changes the digits on exactly one side. Same correction applies to `kid`: derive it as `HKDF(SK,"kid")`, not `H(SK)[0:8]` — do not publish a truncated hash of key material in every frame. (Threat model §1.4 attack 1.)

**B2 — The SW-pubkey path trusts any installed extension.** §2.2 routes the service-worker public key to the page over `lib/extensionBridge.ts`. That channel's inbound guard is `if (!event.origin.startsWith('chrome-extension://')) return;` (`lib/extensionBridge.ts:280`) — **any** extension, not ours — and outbound posts use `targetOrigin '*'` (`lib/extensionBridge.ts:76`). The file's own SECURITY comment says this is acceptable because "the payload carries no secrets — it is a verb, not data" and "the worst a forged inbound message achieves is showing a wrong email." **Forge's design makes that comment false.** Any installed extension can frame `https://computercaller.com/extension`, answer the pubkey request with its own key, and be handed a wrap of `SK` by the phone — and, as the framer, can read anything the page posts with `targetOrigin '*'`.
Fix (2 lines, already available): compare `event.origin === CC_EXTENSION_ORIGIN` (`lib/extension.ts:16`), and post the pubkey request/response with `targetOrigin = CC_EXTENSION_ORIGIN` rather than `'*'`. Additionally: the page must never relay the `e2e` wrap block over this bridge — the SW gets its wrap on its own `PAIR_STATE` socket (which §2.2 already specifies; keep it that way). Update the file's SECURITY comment in the same change so the next reader does not re-derive the old assumption.

**B3 — E2E-lite's milestone-1 scope is self-contradictory and its wording is not honest as written.** §8 lists `PHONE_NOTIFICATION` as sealed in E2E-lite *and* says "SW body previews stay plaintext." Those cannot both be true. Resolve explicitly, and the answer must be: **`PHONE_NOTIFICATION` is sealed in milestone 1; the SW degrades to "New message" until milestone 2**, exactly as §2.2/§5 already describe for the no-SW-key case. Notification bodies are the top-ranked asset in my threat model (§1.1 — banking OTPs and 2FA codes for the user's *other* services); shipping a milestone that calls itself E2E while leaving them plaintext is the single worst outcome available here.
Separately, the proposed milestone-1 sentence — *"bulk history sync is not yet"* — is technically true and practically misleading. Bulk sync is `MESSAGES*`, `CONTACTS*`, `CALL_LOGS*`: the user's **entire address book** and up to 10 000 message rows, carrying the *same bodies* the live path encrypts, crossing the relay in the clear on **every pair**. Honest wording for milestone 1: *"Messages, calls and notifications are end-to-end encrypted as they happen. When your computer loads your history and contacts from your phone, that transfer is not yet encrypted end-to-end — it still passes through our servers in readable form."* The §9.3 table is amended accordingly; no "end-to-end encrypted" claim ships without that second sentence attached.

## MAJOR

**M4 — `GET_*` staying plaintext: APPROVED, and it is not the leak Ken's framing implies.** `GET_MESSAGES` / `GET_CALL_LOGS` / `GET_CONTACTS` are *requests* — `{since, address?, before?}` and a category. No content. `gateBrowserSyncFrame()` (`server.js:1451`) is verifiably the only server-side tier chokepoint (it drops `GET_CONTACTS` below Plus and clamps `since` up to the entitled floor, fail-closed on the flag); sealing them moves billing enforcement to the client, i.e. deletes it. Leak accepted and documented: the relay learns *when* and *what category*, never *what*. **The content exposure during bulk sync is in the responses, not the requests** — and in the full design those responses (`MESSAGES*`, `CONTACTS*`, `CALL_LOGS*`) are sealed. This is only a real exposure inside E2E-lite, which is B3's problem, not this one. Condition: the §3 plaintext list must carry a one-line note saying exactly this, so nobody later reads "GET_* plaintext" as "sync is plaintext."

**M5 — TOFU pinning: required, but `DeviceKey` is the wrong trust root on its own.** §2.1 correctly calls the registry "a convenience/revocation ledger, not the trust root." Pinning the handshake pubkey against a server-held table defends against a relay that swaps a key in a frame **without** a DB write — real, worth having, cheap. It defends against nothing in adversary classes A3/A4 (host or operator compromise), because the same party owns the table. So require **both**:
 (a) phone pins against `DeviceKey` at Accept (Forge's proposal — take it); and
 (b) **client-side TOFU**: each side stores the peer's pubkey per `deviceId` locally on first pair and shows a loud, blocking-by-default warning if it ever changes for a known `deviceId`. A key change on a device you already paired is either a reinstall or an attack, and the user is the only one who knows which.
 Plus a server-side rule: `publicKey` is **immutable** for a given `(userId, deviceId)`. A rotation mints a new `deviceId`. A server that can silently rewrite your device's public key is a server that can MITM you at leisure.

**M6 — Reject the `h` plaintext header (§3 flag); take Option A, drop the log.** `logNotifLifecycle()` (`server.js:190–238`) is already disciplined — package name and booleans, key hashed, never title or body, and the comment says why. But `h:{pkg,hasReply}` would persist **which app notified you, for every notification, forever**: banking app, dating app, messaging app, employer's app. That is a behavioural profile of the user, it is exactly the metadata E2E is supposed to stop us accumulating, and it would be retained to buy back a debug log for a feature that has already shipped. Drop the log; replace with a client-side counter if it is ever needed again.

**M7 — Padding (§3): adopted construction is correct, two gaps.** Buckets 64/128/256/512/1024/2048 with an inner length prefix is right, and exempting `*_CHUNK` is defensible (fixed-count chunks, real bandwidth cost, no short-secret risk). Gaps: (i) specify behaviour **above** the top bucket — pad up to the next multiple of 2048, never leave the tail unpadded; (ii) `CALL_INCOMING` / `CALL_WAITING` / `CALL_STATUS`'s sealed `{number, contactName}` must pad too — Forge's list reads as if padding is notification/SMS-only. Padding is a §9.2 blocking condition (#5): no "notification content is protected" claim ships without it.

## MINOR

**m8 — Derive the nonce prefix, don't transmit it.** §2.3/§3 send the 32-bit per-session prefix once in the `e2e` handshake block. The SW persists `{kid, wrap, epk}` in `chrome.storage.session` and re-unwraps after MV3 eviction (§5) — if the prefix is not in that blob, the SW decrypts with the wrong nonce after every eviction. Derive it instead: `prefix = HKDF(SK, "nonce-prefix|" + direction)[0:4]`. Removes a whole class of state-sync bug and one field from the wire.

**m9 — Dedupe window (§3): APPROVED as designed.** Dedupe-not-reject over a 1024-wide sliding window, rejecting only below the floor, is the correct reconciliation with the `frameBuffer` resume replay (`server.js` ~1030–1055) — this was my MEDIUM finding from the first pass and Forge has answered it properly. "Decryption failure never closes the socket; 3-in-10s requests a re-pair" is right. Conditions: the window is per `(kid, direction)` and **resets on `pairEpoch`**; cap how far a single frame may advance the window floor (a relay holding then releasing a far-future frame must not strand the frames behind it); and the silent-drop counter must be exposed in the regression suite, because a dedupe window that quietly eats real frames is indistinguishable from one that works.

**m10 — `setUserAuthenticationRequired(false)` (§2.1) is correct and must be stated, not buried.** Background frame handling would break otherwise. Consequence for Dennis in plain words: an unlocked stolen phone reads everything, encryption or not. That is true today and E2E does not change it.

**m11 — X25519 vs P-256 in WebCrypto (§2.3).** Forge's fallback plan is right. Resolve at sign-off by testing `deriveBits` on a non-extractable X25519 key in the target Chrome, and record the result in the spec. If it fails, **ECDH P-256 is an acceptable substitute** — non-extractability is the property we refuse to trade; curve choice is not.

## Sign-off condition

B1, B2, B3 closed in the spec text before implementation starts; M5, M6, M7 folded in; m8–m11 recorded. On that basis the design satisfies §9.1 as a *design*, and the §9.2 blocking conditions become testable rather than theoretical. The §9.3 wording ladder stands, with the milestone-1 row replaced by B3's text. Security re-tests every finding after the owning specialist's fix lands; nothing is closed on a diff alone (§9.5).

---
Open items flagged inside the halves for sign-off: 2.3 curve/AEAD non-extractability check in Chrome; 2.1 phone pinning against DeviceKey; 3 `h` header vs dropping logNotifLifecycle; 3 replay window vs frameBuffer dedupe; 6(c) escrow wording; padding bucket sizes (Security 256/1024/4096/16384 vs Forge 64…2048 — reconcile).

## 11. Blockers folded into the plan (Ken)
- **B1 (crypto design):** SAS derived over the transcript (pairingId salt, epk + sorted peer pubkeys + pairEpoch) from keys each side actually holds — never from SK; `kid = HKDF(SK,"kid")`. Cost: 0 extra weeks (design correction inside the Android/web/SW seats).
- **B2 (live weakness today):** lib/extensionBridge.ts:280 accepts any `chrome-extension://` origin and :76 posts with targetOrigin `*` → pin to `CC_EXTENSION_ORIGIN` (lib/extension.ts:16) both ways; fix the now-false SECURITY comment. Shipped NOW as a standalone Forge fix (DISPATCH-BRIEF-FORGE-P-bridge-origin-pin.md), independent of E2E.
- **B3 (scope/wording):** E2E-lite seals PHONE_NOTIFICATION (#1 asset) with the SW degrading to "New message"; milestone-1 wording per §10; §9.3 table amended. Effort: E2E-lite ≈ 3.5–4 weeks (SW unwrap path pulled forward from milestone 2).
- Conditions adopted: TOFU = client-side pinning AND DeviceKey pinning, publicKey immutable per (userId, deviceId); dedupe window per (kid, direction), reset on pairEpoch, capped floor advance, drop counter exposed in the regression suite; `h` header rejected, logNotifLifecycle dropped; padding gaps (above-bucket behaviour, sealed call numbers) to be specified by Forge at build time; GET_* plaintext approved with the one-line note in §3.

## 12. Encrypted mode (opt-in) — resolves decision A (Dennis 20:42: "rather be an option they pick in settings in the android app and webapp. If they pick encrypted mode then it asks for the pin pairing to be truly end to end.")
1. A **per-DEVICE** setting "Encrypted mode" in Android Settings AND web/extension Settings, default OFF, stored locally and never read back from the server as truth. (v1.0: this originally read "per-account", which contradicted "stored locally per device" and left matrix rows 8-10 undefined — see **§13.1**.)
2. OFF = today's Connect → Accept, unchanged, no SAS. ON = pairing requires the transcript-derived SAS (B1-corrected: pairingId salt, epk + sorted peer pubkeys + pairEpoch, from keys each side holds) shown on the phone and confirmed on the computer — a BLOCKING step that closes the pairing-MITM residual.
3. Downgrade protection: once a pair is established in encrypted mode, relay and clients refuse plaintext for that pair; any plaintext pair renders a persistent "Unencrypted" badge in panel + web.
4. Gating: the option is visible only when both devices run E2E-capable versions (APK v58+, new extension/web); otherwise greyed with the reason ("Update your phone app").
5. Mode negotiated at PAIRING_ACTIVE and recorded on DeviceKey (per pair, per epoch) — as a **record**, not as the authority. Enforcement is local, at Accept, from state the device holds itself; the relay and DeviceKey are defence in depth only (**§13.1**).
6. Honest wording: "end-to-end encrypted" only for pairs with mode ON and only after the full milestone (§9). Mode OFF pairs keep today's wording.
7. Effort delta ≈ +1 week (settings UI ×2, SAS confirm UI on Accept/Connected, badge). Security must re-run the §9 checklist for the OFF/ON mixed-mode downgrade case (a mode-ON device pairing with a mode-OFF device must fail closed with a clear message, never silently pair in plaintext).
Decision A = RESOLVED by design. Decisions B (E2E-lite first vs full) and C (history device-only) still awaiting Dennis.

---

## 13. FROZEN at v1.0 (P0 design freeze, Forge 2026-09-17)

Everything in this section is frozen. Changing any of it is a breaking protocol
change and needs a new version string, not an edit. Where §§1–12 and this section
disagree, this section wins — the earlier text is kept as the record of how the
decision was reached.

**AMENDING AUTHORITY.** §13 as frozen on 2026-09-17 left the key schedule and
the AEAD layout unspecified. `GATE1.md` **"Addendum A1 — KDF/AEAD layout:
AMENDED"** (2026-09-17T22:34Z, signed by the Gate 1 security signer) closes that
gap, and **§13.10 below is that addendum**, transcribed. A1 is the amending
authority for §13.10 and for nothing else: it freezes a layer §13 left open, it
does not reopen anything §13 froze, and Gate 1's PASS verdict is unaffected.
Where §13.10 and A1 could be read to disagree, A1 wins and §13.10 is the bug.

A1 has since been amended twice, by the same signer, in the same way — each
closing a layer that was left open or written wrong, neither reopening anything
§13 froze, and **Gate 1's PASS verdict is unaffected by either**:

- **Addendum A2 — nonce prefix: RATIFIED (A)** (2026-09-17T15:50Z). The nonce
  prefix is **derived, not random**. §13.10.7 below. A2 also **strikes** A1's
  "defence in depth" rationale for the prefix, which makes §13.10.5 rule 3 the
  sole control against nonce reuse.
- **Addendum A3 — pairContext channel: RATIFIED (A), AMENDED**
  (2026-09-17T23:41Z). The pair context is **carried on the wire** as `ctx`.
  §13.10.8 below.

The same precedence rule applies to both: where §13.10 and the addendum could be
read to disagree, **the addendum wins and §13.10 is the bug**. Where A2 or A3
contradicts A1, the later one wins — that is the point of an amendment.

*Numbering note:* A1's own text calls the new section "§13.9". §13.9 was already
taken by **History** when A1 was written, and renumbering a frozen section would
break every reference to it, so the addendum lands at **§13.10**. Ken ruled this
on 2026-09-17. Read every "§13.9" in A1 as §13.10.

### 13.1 Encrypted mode is PER-DEVICE (C-1) — corrects §12.1

§12.1 says "a per-account setting … stored locally per device". Those are two
different things and the contradiction left matrix rows 8–10 undefined, which is
the "device has mode ON, pair completes in plaintext" shape the brief calls a
blocker. Resolved:

- The setting is **per-device**, stored **locally**, and is **never read back
  from the server as truth**. The server may hold a copy for UI convenience; it
  is not the authority, because a server that decides the mode can downgrade it.
- The **effective mode of a pair is the OR of both sides**. If either device has
  it ON, the SAS is blocking on **both**, and the pair is Encrypted (verified).
  This is what the modeByte rule already implied ("0x01 if either side
  advertises ON"); only the prose was wrong.
- A **computer advertises the OR of its own web and extension settings**. Web
  and SW are two devices on one machine but one *user-facing* computer, and a
  user who turns encryption on in the panel has not consented to it being off in
  the tab.
- The mode is **latched at Accept** for the life of the pair. Enforcement is
  **local, at Accept**: the device that advertised ON refuses to complete without
  SAS confirmation, using only state it holds itself.
- The relay's downgrade refusal and the DeviceKey pin are **defence in depth**.
  Neither is the thing that makes mode ON safe — if enforcement depended on the
  relay, a hostile relay could turn it off.

### 13.2 Mixed-mode matrix (M-B) — rows 8–10 resolved

| # | phone | computer | outcome |
|---|---|---|---|
| 1 | v58 ON | new web+ext ON | pair; SAS blocking both; **Encrypted (verified)** |
| 2 | v58 ON | new web ON, no ext | pair; SAS on web; SW absent → counts-only badges |
| 3 | v58 ON | v55-era web/ext (no `e2e` block) | **abort** |
| 4 | v58 OFF | new web/ext OFF | pair; no SAS; **Encrypted (unverified)** |
| 5 | v58 OFF | v55-era | plaintext pair; **Unencrypted** badge |
| 6 | v55/v57 | new web ON | **abort** — "Update your phone app" |
| 7 | v55/v57 | new web OFF | plaintext; **Unencrypted** + "Update your phone app" |
| 8 | **v58 ON** | **new web OFF** | **effective ON.** SAS shown and blocking on BOTH. Encrypted (verified). The mode-OFF computer displays the SAS even though its own setting is off — a peer asking to verify is not an error state. |
| 9 | **v58 OFF** | **new web ON** | **effective ON.** Symmetric with row 8. |
| 10 | ~~v58 ON~~ | ~~ext ON, web OFF (same computer)~~ | **STRUCK (Security A5, F4 ACCEPTED).** The premise is false: there is no such state. See the note below. |
| 11 | v58 ON | new web ON, SW key swapped | **digits diverge** — the SAS covers the whole key set (13.3), so the swap is visible to the user, not only to the phone's DeviceKey pin. |
| 12 | v58 ON | new web ON, relay strips `e2e` | abort, and the digits would differ anyway (modeByte) |

Rows 8–9 resolve the same way and it is the only safe direction: **a device
that asked for verification never silently gets less than it asked for.**

**Row 10 is STRUCK — Security A5, F4 ACCEPTED.** It described "ext ON, web OFF
on the same computer" and had the computer advertise `OR(web, ext)`. That state
cannot arise: **the computer side has ONE encrypted-mode setting — the page's —
and it governs BOTH recipients.** The extension service worker does not hold a
second, independently settable mode to be OR'd with; it is a recipient of the
pairing the page's setting establishes. Row 10 therefore collapses into rows 8
and 9, which already cover every real combination, and `OR(web, ext)` MUST NOT
appear in any implementation.

**M-A5-4 (MUST).** The mode is **never server-authoritative**. No relay or
server field establishes, corrects or overrides either side's mode; each side
knows its own setting locally and learns the peer's only from the peer's own
advertised byte (§13.2 F5 note below).

**F5 — what the `mode` byte on the wire actually is (Security A5).** The accept
block's `mode` byte on the wire is the SENDER'S LOCAL SETTING at that moment (an
advertisement); the effective session mode = OR(ownLocal, peerByte), computed
locally, latched for the pair, never transmitted; §13.3's `modeByte` input to the
SAS = the effective mode. Vector M pins the values (GATE1.md, Addendum A5);
freezing it into `tests/kdf-vectors.json` is P2.2's job.

### 13.3 SAS transcript (B7 as corrected by B9) — FROZEN

```
salt = UTF8(pairingId)
info = "cc-sas-v1"
ikm  = 0x01 || u8(len(epk)) || epk
     || 0x02 || u8(n) || u8(len(K_1)) || K_1 || … || u8(len(K_n)) || K_n
     || 0x03 || be64(pairEpoch)
     || 0x04 || modeByte
digits = be32(HKDF-SHA256(salt, ikm, info)[0..4]) mod 100000, zero-padded to 5
```

**Rendering — FROZEN (R-BK, 2026-09-21, closes M-A6-5).** Every surface that
shows the SAS renders the five digits **ungrouped**, as one contiguous string
(`31644`), no space, hyphen or other separator, tabular/monospace numerals, no
leading-zero suppression. Phone hero face (`R.id.homeSasCode`), page dialog
(`[data-cc-sas-digits]`) and any future surface MUST be byte-identical to the
zero-padded 5-digit string above. Rationale: the SAS is a human exact-string
compare; two groupings of the same digits raise the miscompare rate and train the
user to accept "looks a bit different" — the exact judgment a substitution attack
needs. Pinned by a unit test on each surface (P6.1d-A) and read off both
screenshots in P6.1d-B.

`K_1…K_n` are **all** static public keys in the pairing — the phone plus every
recipient (web, service worker, any further computer) — deduplicated and sorted
by **unsigned** lexicographic byte comparison. `modeByte` is the effective mode
of 13.1. **One code per pairing, never one per recipient.**

Under a per-recipient SAS the service worker's code is never displayed, because
the SW has no UI — so a swapped SW key would be invisible to the user while
remaining the one leg that decrypts notification bodies with the panel closed.
That is precisely the attack mode ON exists to stop.

Consequence for P1(c), and it is not optional: **`PAIR_STATE` must carry the full
recipient key list to the SW, and `PAIRING_ACTIVE` must carry it to the web.**
Without the whole list no party can compute the transcript. Both are additive
fields on frames P1 already edits.

Pinned by `tests/sas-vectors.json` (2-, 3- and 4-key vectors), asserted in the
web/node lane, in a service-worker context, and — at P4 — by an instrumented
Kotlin test against the same file.

**B9 wording, amended (Security A5, F3 ACCEPT).** The SAS is **computed and
displayed on the PAGE**, over the canonical key set that **includes the service
worker's static key**. The SW is a **recipient, not a verifier**: it neither
computes nor displays a code, and there is no second code anywhere.

**M-A5-3 (MUST).** The SW's static key is read **live over the A4.1 bridge** at
the moment the SAS is computed, and is **never page-cached**. If that read
returns `unknown`, the page MUST NOT ship a 2-key SAS that claims to cover the
SW — a code presented as covering a key it did not include is a false assurance
about exactly the leg that decrypts notification bodies with the panel closed.
Fail closed and say the SW key is unavailable instead.

### 13.4 Padding — FROZEN (m-E, M7 both gaps closed)

```
padded = be32(len(plaintext)) || plaintext || 0x00 * (bucket - 4 - len)
bucket = smallest of 64, 128, 256, 512, 1024, 2048 that fits;
         above 2048 → the next multiple of 2048
```

- The inner length prefix is what makes the padding removable: 0x00 is legal
  plaintext, so "strip trailing zeros" corrupts any payload ending in one.
- **Above the top bucket, round up** — never leave the tail unpadded (gap i).
- **`CALL_INCOMING` / `CALL_WAITING` / `CALL_STATUS` pad too** (gap ii). Their
  sealed `{number, contactName}` is short and a caller's number length is
  exactly the kind of short secret buckets exist to hide.
- **`*_CHUNK` is exempt**, by suffix rather than by list. Fixed-count bulk
  transfer already discloses its size through the chunk count, so padding each
  chunk costs bandwidth and hides nothing.

**The file-transfer family, and why the suffix rule needed no amendment
(GATE1 Addendum FT-A1; transcribed in E2E-P1.3 (b)).**

- **`FILE_CHUNK` is exempt** — it matches `*_CHUNK` by suffix, so the exemption
  reaches it with **no spec change**. That is the point of having written the
  rule as a suffix instead of a list: a list would have had to be edited by
  whoever added file transfer, and an un-edited list fails OPEN (the chunk gets
  padded, bandwidth doubles, nobody notices). The exemption is also what makes
  FT-A1's **A-3 wire meter** exact and free: an unpadded chunk's wire length IS
  its content length, so the relay can charge actual bytes without decrypting
  anything.
- **`FILE_OFFER` is NOT exempt and DOES pad.** It is the frame carrying the
  filename, the mime type and the sender's device name, which is precisely the
  short-secret shape buckets exist to hide — an unpadded offer leaks the
  filename's length. **Vector L** (`tests/kdf-vectors.json` → `aead.vectorL`)
  freezes the worked case: a 210-byte body, `+4` for the length prefix, into the
  **256-byte bucket**, sealing to 272 bytes (256 ciphertext ‖ 16 tag). It is the
  first vector in that file to land above the 64-byte bucket, so until it was
  frozen nothing in the repo exercised a second rung of this ladder.
- The `ft:{id,size}` **envelope hint rides OUTSIDE the sealed body and outside
  the AAD**, so it contributes nothing to the bucket and nothing to the tag.
  See §13.7.

Pinned by `tests/padding-property.test.mjs` over 500 plaintexts including 1 B
and 100 KB, and — for the two file-transfer cases above — by
`tests/kdf-vectors.test.mjs` (vector L) and the clean-room
`tools/ft-a1-vector-l-verify.mjs`.

### 13.5 Dedupe / replay parameters — FROZEN

- Window **1024** frames wide, kept **per (kid, direction)**.
- **Reset on pairEpoch** — a new epoch is a new key, so the old window is
  meaningless and keeping it would reject legitimate frames after every Accept.
- Floor advance **capped at 256** per step, so a forged high sequence number
  cannot jump the floor past frames that have not arrived yet.
- **Anti-replay dedupes, it never rejects.** frameBuffer legitimately re-sends
  frames on resume; a receiver that treated a duplicate as an attack would turn
  every reconnect into a failure.
- Decrypt failure **drops the frame and never closes the socket**; 3 failures in
  10 s requests a re-pair. Never a reconnect loop.
- The **drop counter is exported** and asserted in the regression suite — a
  silent dropper and a working receiver are otherwise indistinguishable.

### 13.6 DeviceKey pin failure (C-2) — FROZEN

The P4(e) pin is a REST call on the Accept path, and an unspecified failure mode
gets implemented fail-open, at which point the pin is decorative.

- **Mode ON → fail CLOSED.** "Couldn't verify this device — try again." No pair.
- **Mode OFF → fail OPEN.** The pair proceeds, a warning is logged client-side,
  and the badge stays **unverified**.

The registry is a *check*, never a second source of truth: the seal still goes
only to keys advertised in the pairing frame.

**Note (P4.1 finding, transcribed in D1-PREP (c4)) — `PAIR_STATE` is a
computer-side frame.** The phone has **no `PAIR_STATE` handler**. Resume on the
phone is served by the **persisted advertisement / pair record**, not by a
`PAIR_STATE` frame, so nothing in the phone's resume path depends on receiving
one. `PAIR_STATE` — and with it §13.10.9's per-listener `wrap`, the only
per-socket builder in the relay — is addressed to the computer-side listeners
(the page and the extension service worker). Read every `PAIR_STATE` MUST in
this spec as computer-side unless it says otherwise. This holds unless P6 (g)
(cross-implementation) shows otherwise; if it does, this note is what must be
corrected, and any phone-side resume MUST that was written assuming a
`PAIR_STATE` handler is unenforceable as written until then.

**(g) cross-implementation — what the term means (Security A5).** The web page
and the extension service worker are **both COMPUTER-side**. "Cross-
implementation" therefore means **phone ↔ computer**, never web ↔ SW: the two
computer-side recipients share one pairing, one context and one mode, so
comparing them against each other tests one implementation against itself. The
phone leg is run by **P6.1**.

### 13.7 Sealed vs plaintext frame list — FROZEN

**Sealed:** PHONE_NOTIFICATION, SMS_RECEIVED, MESSAGES(+_CHUNK),
CONTACTS(+_CHUNK), CALL_LOGS(+_CHUNK), CALL_LOG_ENTRY, MMS_MEDIA_CHUNK/ERROR,
CALL_INCOMING/ADD/UPDATE/WAITING/ANSWERED/ENDED/REMOVE, SIM_LIST,
SMS_SEND_STATUS, SYNC_ESTIMATE, SEND_SMS, MAKE_CALL,
NOTIFICATION_REPLY/DISMISS/REPLY_SENT/REPLY_FAILED/REMOVED.
`CALL_STATUS`: `{state}` clear, number and name sealed.

**Plaintext:** all pairing / lobby / presence / resume / reset / heartbeat /
permission / audio / status frames, and — **mandatorily** — `GET_MESSAGES`,
`GET_CALL_LOGS`, `GET_CONTACTS`.

> **Note on the GET_\* frames.** These stay plaintext deliberately.
> `gateBrowserSyncFrame()` is the only tier-enforcement chokepoint in the
> product: it clamps `since` and drops `GET_CONTACTS` below Plus. Sealing these
> frames would move billing enforcement to the client, which is the same as
> deleting it. What leaks is a timestamp and a category — no content. This is an
> accepted, documented trade, not an oversight.

#### 13.7.1 `SEALED_PASSTHROUGH_FRAME_TYPES` — the file-transfer family

*GATE1 Addendum FT-A1 (B), MUST B-1 — HIGH/BLOCKER. Transcribed verbatim in
intent by E2E-P1.3 (b); the ledger text is `ADDENDUM-FT-A1.md`.*

**The set (exhaustive, 8):** `FILE_OFFER` · `FILE_ACCEPT` · `FILE_REJECT` ·
`FILE_CHUNK` · `FILE_ACK` · `FILE_RESUME` · `FILE_DONE` · `FILE_FAILED`.

**The three rules, and each one is a MUST:**

1. **`requiresSeal()` is TRUE for all eight.** A plaintext `FILE_*` frame
   arriving while the session is OPEN is **dropped and counted**, exactly like
   any other sealed frame in the clear. (The one narrow exception is the
   relay-marked `FILE_FAILED` of §13.7.2.)
2. **They are routed to the page SEALED — `INBOUND_ROUTE_SEALED` takes
   precedence over UNSEAL.** The service worker forwards `{e,kid,s,c}`
   **verbatim** and never calls `openIfSealed`. The SW never holds file bytes.
3. **They are NOT added to `SEALED_FRAME_TYPES`.** That set also drives
   `sealFrame()`/`unseal()`, so widening it would make the SW a file-transfer
   endpoint. The passthrough set is **disjoint** from it, and `sealFrame()`'s
   refusal is **not** widened.

**Why this is a blocker and not a tidiness item.** Before FT-A1, `requiresSeal()`
named no `FILE_*` frame at all, so `inboundDisposition()` branch 3 **delivered a
plaintext `FILE_OFFER`/`FILE_CHUNK` while the session was OPEN**. A relay could
strip `{e,kid,s,c}` and the page would render the filename, the size, the sender
and every chunk in the clear — the P3 (c) downgrade guard reopened for the one
frame family that carries whole documents. `inboundDisposition` is a pure
function, so this is testable in node with no browser.

**The `ft:{id,size}` hint (FT-A1 (A), A-1…A-6).** `FILE_OFFER` alone carries a
plaintext envelope hint, **outside the sealed body and outside the AAD**:

- `name`, `mime`, `sha256` and `from` stay **sealed**. The sealed `size` is
  **authoritative**; the hint's `size` is **untrusted admission-control input
  only**. *(This supersedes the earlier plaintext `size` on `FILE_OFFER`.)*
- **A-1** the hint is `ft:{id,size}`, never `ft:{size}`. Without `id` neither the
  SW nor the relay can author a `FILE_FAILED` (`coerceFileFrame` drops a payload
  with no `id`) and the relay has nothing to key a meter on. `id` is 16 random
  bytes with zero semantic content.
- **A-2** the relay MUST **fail closed** on an absent or malformed hint —
  otherwise every sender bypasses tier and quota by omitting one field.
- **A-5** the receiver compares `ft.id`/`ft.size` against the sealed body
  **before any prompt, any accept and any save picker**; a mismatch is
  `FILE_FAILED size_mismatch`, **surfaced, never silent**.
- **A-6** the 1 GiB receiver ceiling applies to the **sealed** size, never the
  hint.
- **A-3/A-4** the hint defends against a lying **relay**, not a lying **sender**.
  A sender can seal `size:1024`, hint `1024`, and then stream 700 MiB: both
  checks pass, because both values are lies told by the same party — the one the
  quota is charged to. The relay therefore MUST meter **actual `FILE_CHUNK` wire
  bytes** per `(room, ft.id)` and abort on overrun, and quota charges **metered
  bytes**, not `ft.size`.

**Why outside and not AAD-bound.** Binding the hint into the AAD works — the
counterfactual was run — and is rejected anyway: it forks the frozen `aad()`
layout for one frame type, which is the "Encrypted mode never pairs, all logs
green" failure the framing exists to prevent, and it buys nothing. A relay that
lowers the hint produces a **byte-identical ciphertext** and the receiver refuses
regardless. **A tampering relay can only make a transfer fail, which it can
always do by dropping it. No new power.** All of this is frozen as **vector L**.

**Frozen and reaffirmed:** both §13.7 sets, `kdf.mjs aad()`, and the `*_CHUNK`
padding exemption. **Logged, not blocking:** frame TYPE, direction and chunk
count are relay-visible for file transfers and always were.

#### 13.7.2 Relay-minted `FILE_FAILED` — shape, subset, origin rule

*GATE1 Addendum FT-A1.1 (ii), MUSTs M1–M11; Addendum FT-A1.2, MUSTs M13–M15.*

**Shape (frozen):** `FILE_FAILED:{"id":…,"reason":…,"relay":true}` — plaintext,
one mint path under mode ON **and** OFF.

**Relay-owned reasons (frozen, exhaustive, 8):** `tier` · `quota` · `too_large` ·
`size_mismatch` · `busy` · `relay_backpressure` · `timeout` · `connection_lost`.

**Peer-owned reasons** (`hash_mismatch`, `cancelled`, `oom`) stay **sealed**; a
plaintext one is dropped **even when it carries the mark**.

- **M1** `bad_hint` is a **counter only** — never a wire reason, never in
  `FT_FAIL_REASONS`. **M2** it must be observable per token. **M3** a readable
  `id` with a bad size still mints `size_mismatch`, which is itself a
  relay-minted plaintext frame and therefore carries the mark.
- **M4 (FROZEN)** the sender's own 60 s offer expiry is **strictly less than**
  `FT_OFFER_TTL_MS` (90 s). The margin is what stops the relay racing an honest
  sender.
- **M5** `busy` moves from `FILE_REJECT` to a relay-minted `FILE_FAILED` and is
  added to `FT_FAIL_REASONS` — `FILE_REJECT` is sealed-by-exclusion, so `busy`
  would otherwise be **invisible under mode ON**.
- **M6/M7 — the origin rule.** `relay:true` is stamped **only** by
  `ftFailedFrame()`. The peer re-mint path needs an explicitly **un-marked**
  variant. Every verbatim-forwarded `FILE_*` frame carrying a top-level `relay`
  key is **REJECTED and counted — not stripped**. Stripping would make a forged
  mark indistinguishable from an absent one, which is the whole property.
- **M8** a **sealed** `FILE_FAILED` is still forwarded verbatim, never re-minted.
- **M9 — the receiver's one exception.** `requiresSeal()` stays true for all
  eight; before the branch-2 drop, a plaintext `FILE_FAILED` with
  `relay === true`, a reason in the subset, and the `id` of a **LIVE** transfer
  is **delivered**. It is **abort-only**: it never advances state, never creates
  a record, is never accepted for an unknown id, causes **no persistent client
  state change** (no quota cache, no tier cache, no feature flag), and **never
  touches `mode` or `setAborted()`**. *Residual risk accepted:* a lying relay can
  inject a false "limit reached" abort — a DoS with a misleading message, which
  it can do anyway by dropping.
- **M10** the copy must read as a **transport outcome, not an account
  statement**; account truth comes over authenticated HTTPS.
- **M11 (SW)** the service worker forwards a relay-marked plaintext
  `FILE_FAILED` under the same origin rule, abort-only, **minus** the liveness
  clause — the page owns transfer state and the SW must not begin tracking it.

**Timer hierarchy (FROZEN, Addendum FT-A1.2).**

| timer | owner | role |
|---|---|---|
| 60 s | sender, local | **PRIMARY** — the transfer's own expiry |
| 60 s | SW marker | **INFORMATIONAL** — notification + page hand-off; **sends nothing** |
| 90 s `FT_OFFER_TTL_MS` | relay | **BACKSTOP** — also frees the slot and the quota reservation |
| 30 s `FT_STALL_MS` | sender | **post-ACCEPT only** |

- **B-3 STRUCK.** The no-receiver timeout is the **relay's**. A MUST that cannot
  be met without violating M6/M7/B9 is struck, not waived: the listener→relay
  data-plane drop, `assertSwSendsNothing`, and the phone's B-1 guard against a
  plaintext unmarked frame each independently make an SW-authored one
  impossible.
- **M13** the SW marker MUST never construct, seal, mark or send **any** frame.
  `assertSwSendsNothing` and `assertSwMintsNoRelayMark` are the regression pins
  and MUST NOT be relaxed for B-3.
- **M14** the relay `timeout` fans out to **both** endpoints; the receiver copy
  is admissible under M9 (abort-only, live id). An unknown id → **silent drop**.
- **M15** `timeout` stays relay-owned: a **sealed** peer-authored `timeout` is
  forwarded verbatim (M8); a **plaintext unmarked** `timeout` is **DROPPED**.
- **`no_receiver` is NOT added** to the reason enum. The SW holds a marker
  `{ft.id, receivedAt}` for ≤ 60 s plus a notification, replays the sealed
  envelope verbatim if a page attaches, and on expiry the **relay** emits
  `FILE_FAILED {id: ft.id, reason:'timeout'}`. The sender's own 30 s
  post-ACCEPT stall timer fires first and independently, so the transfer already
  fails correctly regardless.

**Metering (RATIFIED, FT-A1.1).** Metered **wire** bytes are compared against
`ftWireCeiling(raw size) = min(ceil(size × 1.40) + FT_CHUNK_WIRE_BYTES,
ceil(1 GiB × 1.40) + FT_CHUNK_WIRE_BYTES)`. A raw-vs-wire comparison aborts every
honest transfer at ~75 % with `size_mismatch`, and **a false-positive control is
a disabled control**. **M12** `ftRawFromWire()` MUST NOT share the 1.40 constant
— it under-charges quota by ~4.3 % on honest traffic. **The ceiling errs
generous; the charge errs conservative**: invert the charge on the base64 floor
of 4/3.

The full wire truth these rules describe — every frame, the 11-reason enum, the
constants — is transcribed in the repo at `docs/FILE-TRANSFER-SPEC.md`,
Addendum B.

### 13.8 Key lifecycle (M-C) — FROZEN

| event | what happens to keys |
|---|---|
| Accept | fresh SK minted, `pairEpoch` bumped, dedupe window reset |
| Reset lobby | SK dropped both sides |
| Sign-out | SK dropped; device key deleted; `DeviceKey.revokedAt` set |
| LEAVE_ACTIVE | SK dropped |
| Resume / hold / dock | SK **reused** — the relay re-sends the same `e2e` block |
| 2^32 frames or 30 days | rekey |
| Key rotation | mints a NEW `deviceId`; the old row gets `revokedAt` (N-4), or the pin trusts a retired key forever |
| **Account deletion** | **all `DeviceKey` rows deleted and every room `RESET_ROOM`'d — owner P1(e), scenario in P6(c) (C-4).** Without it, deleted accounts leave key rows the pin will trust if an account id is ever reused. |

`publicKey` is immutable per `(userId, deviceId)`.

### 13.9 History — decision C RESOLVED: device-only

Approved by Dennis 2026-09-17. History stays on the device; we store nothing
server-side. This is already what ships, so it is a confirmation rather than a
change — and it is what lets §9.1's "we do not store your content" survive
scrutiny.

**Note (P4.1 finding, transcribed in D1-PREP (c4)).** Because history is
device-only, the phone's resume path reads its **own persisted advertisement /
pair record** rather than any server- or relay-delivered state. That is the
mechanism referred to in §13.6's note: the phone has no `PAIR_STATE` handler,
and resume does not require one. `PAIR_STATE` is a computer-side frame unless
P6 (g) shows otherwise.

### 13.10 Key schedule + AEAD — FROZEN (GATE1 Addendum A1, which calls it §13.9)

§13 froze the SAS transcript (13.3), the padding (13.4), the dedupe parameters
(13.5) and the key lifecycle (13.8) — and left the key schedule and the AEAD
layout unspecified. The only statement of the schedule was the brief's prose,
`HKDF-SHA-256(info = "cc-e2e-v1" ‖ userId ‖ phoneDeviceId ‖ peerDeviceId ‖
pairEpoch, salt = pairingId)`, and that `‖` is bare concatenation of
variable-length strings: user `ab` + phone `cd` produces the same info bytes as
user `a` + phone `bcd`, so two different pairings derive **identical traffic
keys**. It is invisible to any test that uses fixed-width ids, and it is
unfixable once shipped because fixing it is a breaking protocol change.

P4 caught it, published it as a proposal rather than implementing it silently,
and Security ratified the fix and specified the AEAD half — the higher-risk
half, because a nonce-reuse bug in GCM is not a degradation, it is total loss of
confidentiality *and* forgery for the affected key.

#### 13.10.1 Reserved tag ranges

Every tagged structure in this protocol allocates its own range, and the ranges
are disjoint **by construction and must stay that way**: a SAS transcript can
never be replayed as a KDF info string, or the reverse. That is a real
cross-protocol defence, not tidiness.

| Range | Owner | Status |
|---|---|---|
| `0x01..0x04` | SAS transcript | frozen, §13.3 |
| `0x11..0x15` | KDF pair context | frozen, this section |
| `0x21..0x25` | AEAD associated data | frozen, this section |
| `0x05..0x10`, `0x16..0x20`, `0x26..0xff` | — | **RESERVED** |

The next person adding a tagged structure **allocates a new range**. Reusing an
existing one reintroduces exactly the ambiguity the tags exist to remove.

#### 13.10.2 Framing rule

Inherited from the frozen SAS (§13.3): **every variable-length value carries a
one-byte tag and a `u8` length prefix.**

`u8` is deliberate and is **not** to be widened to `u16` — the ids are
cuid/uuid-shaped (~25–36 bytes), 255 is an order of magnitude of headroom, and
`u16` would break framing symmetry with the frozen SAS for no gain. **But the
cap is enforced, never assumed:** any of `userId`, `phoneDeviceId`,
`peerDeviceId`, `kid` or `frameType` exceeding 255 bytes **MUST THROW at encode
time on every platform**. Silent truncation to `len & 0xff` would recreate the
exact collision this section exists to kill, in the one code path nobody tests.

`pairingId` carries **no tag and no prefix** and that is correct: it is the HKDF
salt, a separate argument, structurally unambiguous.

#### 13.10.3 Pair context and key schedule

```
pairContext = 0x11 u8(len) userId
            ‖ 0x12 u8(len) phoneDeviceId
            ‖ 0x13 u8(len) peerDeviceId
            ‖ 0x14 be64(pairEpoch)

salt        = UTF8(pairingId)

KEK_i = HKDF-SHA-256(salt, ikm = ECDH(epk_priv, K_i),
            info = "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i)   -> 32 bytes
k_p2c = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/p2c" ‖ pairContext) -> 32
k_c2p = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/c2p" ‖ pairContext) -> 32
```

- `K_i` is the recipient's static public key in the Gate 1 R1 wire encoding:
  uncompressed SEC1, `0x04`-prefixed, **exactly 65 bytes**. Reject any other
  length at import — do not infer.
- The three labels are distinct suffixes of a common prefix, so the same `salt`
  and `pairContext` can never yield the same key for two purposes.
- `pairEpoch` is `be64` via BigInt, **not** a JS number: a value above 2^53 must
  not silently round on the web side and derive a different key from the one
  Kotlin derives from the same value.
- **The KEK info binds `K_i` but not `epk`, and this is correct** — recorded so
  a later reader does not "fix" it. The ECDH ikm already binds `epk`
  cryptographically, and `pairEpoch` bumps on every Accept, so a wrap cannot be
  replayed into another epoch. Binding `K_i` is the load-bearing part: it is
  what stops a wrap minted for the web page from opening in the service worker.

**Directional keys never cross.** `k_p2c ≠ k_c2p`, so a frame reflected back at
its sender cannot decrypt under the sender's own receive key. **Mandatory
consequence for implementers:** each side holds exactly one *send* key and one
*receive* key and **MUST NOT be able to name the other**. There is deliberately
no `keyForDirection(dir)` helper anywhere in this protocol — directional
separation enforced by a naming convention is directional separation that will
be violated.

#### 13.10.4 AEAD

```
cipher = AES-256-GCM, 128-bit tag, 96-bit nonce.

nonce (12 B) = sessionPrefix(4 B) ‖ be64(seq)
               -- A1 wrote "random, per (kid,direction)". Addendum A2 REPLACED
                  that word: the prefix is DERIVED. See §13.10.7.

AAD = 0x21 u8(len) frameType          (ASCII, e.g. "SMS_RECEIVED")
    ‖ 0x22 u8(len) kid                (ASCII)
    ‖ 0x23 be64(seq)                  (the SAME seq as the nonce)
    ‖ 0x24 u8 direction               (0x01 = p2c, 0x02 = c2p)
    ‖ 0x25 be64(pairEpoch)

plaintext fed to GCM = the §13.4 padded block (be32(len) ‖ plaintext ‖ 0x00*).
```

**Pad first, then seal.** Sealing first would put the real plaintext length in
the clear, which is the entire point of §13.4.

**The AAD is NOT the JSON header bytes.** The wire header `{e,kid,s}` is JSON,
and JSON key order, spacing and number formatting are not canonical across
Kotlin and JS. Both sides **MUST parse the header and re-encode the five fields
above**. Authenticating serializer output would make a whitespace difference
present itself as a decryption failure.

What the AAD buys: it binds `frameType`, so a sealed `CALL_STATUS` cannot be
relabelled `SMS_RECEIVED` by the relay; it binds `seq`, so a frame cannot be
moved to a different sequence position to slip the §13.5 dedupe window; it binds
`direction` and `pairEpoch`, so replay across directions or epochs fails
authentication rather than decrypting into something plausible.

#### 13.10.5 The nonce counter — four rules, all fail-closed

1. **Counter-based, never random-only.** `seq` is per `(kid, direction)`, starts
   at `0`, strictly increments, and never repeats under a given key. A 96-bit
   random nonce would collide around 2^48 frames by the birthday bound —
   comfortable, but "comfortable" is the wrong standard for a failure whose cost
   is total. The counter already exists: §13.5's dedupe window is keyed on it.
2. **Uniqueness comes from the counter, not the prefix.** A1 called the 4-byte
   prefix "defence in depth against a state-restore bug"; **Addendum A2
   WITHDRAWS that rationale** and §13.10.7 explains why it was never sound.
   The prefix contributes **zero** nonce-uniqueness. Anyone reasoning "the
   prefix varies, so a counter collision is fine" has reintroduced the bug, and
   **rule 3 is now the SOLE control against nonce reuse.**
3. **Persist before emit, and fail closed.** The counter MUST be durably
   committed *before* the frame it authorises leaves the device. A device that
   starts and cannot prove its counter is strictly beyond every value it has
   used — restore from backup, cleared storage, corrupt state — **MUST refuse to
   encrypt and force a rekey**. Never resume at a guess, never restart at 0.
   A1 names this the single most likely way this design gets broken in the
   field, an Android restore-from-backup silently replaying counters, so it is
   an acceptance criterion with its own restore-from-backup test rather than a
   note. In `lib/e2e/kdf.mjs` it is a constructor precondition: `createSender()`
   refuses without an awaited durable commit and refuses outright without a
   proven counter floor.
4. **The rekey bound is load-bearing now.** §13.8's rekey at 2^32 frames /
   30 days keeps `seq` far from any wrap. It is no longer only hygiene.

#### 13.10.6 Where this lives

- `lib/e2e/kdf.mjs` + `lib/e2e/kdf.d.mts` — one `.mjs`, no build step, so node,
  the web page (P2) and the MV3 service worker (P3) import the same bytes
  (Gate 1 R2). The sidecar is `.d.mts`, not `.d.ts`: TypeScript resolves the
  types for `./kdf.mjs` at `./kdf.d.mts` and never consults a `.d.ts` beside an
  `.mjs`.
- `tests/kdf-vectors.json` — frozen vectors. The context / labels / traffic /
  kek blocks are P4's proposal values, which Security recomputed independently
  and ratified byte for byte; they **must not be regenerated**. The `aead` block
  is A1's own amended set: the full AEAD vector, the three 256-byte-id cases
  that must throw, the AAD tamper, and the cross-direction negative.
- `tests/kdf-vectors.test.mjs` (web + service-worker context) and
  `E2eKdfVectorsTest` (Android) assert **the same file**, so a drift in either
  lane fails its own build rather than surfacing as "Encrypted mode never
  pairs".

#### 13.10.7 Addendum A2 — the nonce prefix is DERIVED, never random

**RATIFIED (A), 2026-09-17T15:50Z.** A1's nonce line said the 4-byte prefix was
"random per `(kid, direction)`". The merged, frozen frame `{e, kid, s, c}` has
**no field to carry a random value**, so A1 as written was undecryptable: the
two sides would each invent a prefix and neither could reproduce the other's.
P4 escalated rather than inventing a field, and was right to. A2 replaces the
word.

```
np2c = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
                    info = "cc-e2e-v1/np2c" ‖ pairContext)   -> L = 4 bytes
nc2p = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
                    info = "cc-e2e-v1/nc2p" ‖ pairContext)   -> L = 4 bytes

nonce (12 B) = np2c ‖ be64(seq)     for direction p2c (0x01)
             = nc2p ‖ be64(seq)     for direction c2p (0x02)
```

`pairContext` is §13.10.3, byte for byte, unchanged. The two labels are exact
ASCII, new members of the `cc-e2e-v1/` namespace, distinct from `/kek`, `/p2c`
and `/c2p`. **`L = 4` and "expand 32 then truncate to 4" are the same bytes**
(HKDF-Expand emits `T(1)` first), so either implementation is conformant — but
implementations **SHOULD** request `L = 4` so the intent is not mistaken for a
truncated key.

Nothing about the envelope `{e, kid, s, c}`, the merged `e2e` block or
`PAIR_STATE` changes. This is not a workaround, it is the standard construction:
TLS 1.3 derives its per-connection record IV from the traffic secret by HKDF and
never transmits it (RFC 8446 §5.3), and "fixed field ‖ counter" is RFC 5116
§3.2. A nonce prefix has no confidentiality or unpredictability requirement at
all — GCM's requirement is *uniqueness under a key*, and that is the counter's
job.

**WHAT A2 STRIKES, and implementers MUST NOT rely on.** A1 justified the prefix
as "defence in depth against a state-restore bug". **That rationale is withdrawn
— and on inspection it was never sound under A1 either.** A restored device
restores its persisted state; under A1 the prefix was per `(kid, direction)`,
not per process start, so a device that restored a stale counter also restored
or re-derived the same prefix. It protected against the restore scenario only
where the prefix was *not* persisted while the counter *was* — a specific
storage bug, not a design property. Under A2 the prefix is a deterministic
function of `SK` and `pairEpoch`, so within one epoch a restore reproduces it
exactly. **The prefix contributes zero nonce-uniqueness. Say so in the code
comment.**

The load-bearing consequence: **§13.10.5 rule 3 — persist-before-emit, fail
closed — is now the SOLE control against nonce reuse.** It was always the real
one; A2 removes the fig leaf beside it. It is upgraded from an acceptance
criterion to **blocking** for P2, P3 and P4 alike: a lane that seals frames
without a restore-from-backup test proving refuse-and-rekey does not ship.
Android's `E2eSeqStoreTest.restore_from_backup_fails_closed` is the model; the
web and service-worker lanes owe the equivalent for their own storage
(IndexedDB cleared, profile copied, SW storage evicted).

**Two MUSTs A2 adds:**

1. **`kid` ↔ `SK` MUST be strictly 1:1.** `pairContext` does not bind `kid`, so
   `k_p2c` / `k_c2p` / `np2c` / `nc2p` are scoped to
   `(pairing, pairEpoch, direction)` while §13.10.5 scopes the counter to
   `(kid, direction)`. Those two scopes coincide **only** while one `kid` names
   exactly one `SK`. If a second `kid` were minted under the same `SK`, its
   counter would restart at 0 against the same key **and the same prefix** —
   GCM nonce reuse, total loss of confidentiality and forgery resistance. Every
   rekey MUST mint a fresh `SK` (and bump `pairEpoch`) with its new `kid`, and a
   `kid` MUST NEVER be reused across `SK`s. **Enforce it where `kid` is minted,
   not by convention.**
2. **The prefix MUST be derived, never persisted, never carried across a
   session.** Re-derive from `SK` + `pairContext` on every session
   construction. A persisted prefix is stale state that can survive a restore,
   and it is the only way this design drifts back into the bug it just removed.
   `lib/e2e/kdf.mjs` expresses this structurally: `trafficKeys()` hands each
   direction its prefix alongside its key, so a caller has nothing to store.

**Vectors: E, F, G, H in `tests/kdf-vectors.json`** (`noncePrefixes`,
`aead.vectorF`, `aead.vectorG`, `noncePrefixes.negativeH`). Vector A keeps its
explicit `sessionPrefixHex` and is unaffected — it is the "given a prefix, seal
correctly" test. Vector F is the *same frame as A with exactly one input
changed*, so a divergence localises immediately; G is the reverse direction,
which proves the direction byte, the c2p key and the c2p prefix all move
together; H is the negative that catches feeding the same label twice.

#### 13.10.8 Addendum A3 — the pairContext channel (`ctx`)

**RATIFIED (A), AMENDED, 2026-09-17T23:41Z.** §13.10.3 froze *what* the pair
context is and never said *how the computer side learns it*. Three of its four
fields are known only to the phone, so a browser and a phone of different
implementations derive different traffic keys and **every sealed frame fails
authentication** — with both loopbacks blind to it by construction, and every
log line on every side reporting success. Non-exploitable (fail-closed, no key
compromise) and a total availability break on the first real pair. A3 supplies a
transport for a context §13 already froze; it reopens nothing.

**Wire form.** On `ACCEPT_PAIRING` / `PAIRING_ACTIVE` / `PAIR_STATE.e2e`:

```
ctx = { pairingId, phoneDeviceId, peerDeviceId, pairEpoch }   // pairEpoch: DECIMAL STRING
```

`userId` is deliberately **not transmitted**. Each side uses its own
authenticated session userId and a mismatch fails closed; transmitting it would
let the relay propose an identity, and the derivation would then agree with the
relay instead of with the session. Vector I.3 pins that one character of local
`userId` yields total key divergence.

`pairEpoch` is a **decimal string and MUST NOT become a JSON number**:
`JSON.parse` yields a double and §13.10.3 already forbids `pairEpoch` rounding
above 2^53. Receivers MUST parse with BigInt and **reject** anything not
matching `^(0|[1-9][0-9]{0,19})$` or exceeding 2^64−1 — no `Number()`, no
leading zeros, no sign, no whitespace.

**`ctx` is what makes the SAS computable on the computer side at all.** The
frozen §13.3 SAS is
`HKDF(salt = pairingId, ikm = epk ‖ sort(pub_phone, pub_peer) ‖ pairEpoch,
info = "cc-sas-v1")`, and before A3 the browser could not compute it because it
lacked `pairEpoch`. SAS display was silently *unreachable* on P2/P3, not merely
mis-derived.

The SAS is also why `ctx` needs no separate integrity binding. `pairEpoch` and
`pairingId` are **already inside the SAS**: a relay that edits either changes
the digits on exactly one side and the user sees a mismatch.
`phoneDeviceId`/`peerDeviceId` are not SAS-covered and do not need to be — they
enter `pairContext`, hence the traffic keys, hence every frame, so editing them
yields decryption failure on frame one. **There is no wrong-but-working key
reachable by editing `ctx`:** every field is either SAS-visible or key-binding.
All four fields stay — dropping `peerDeviceId` would let one device's context
derive another's keys, and dropping `phoneDeviceId` would unbind the pair from
the phone identity the whole pinning story rests on.

**A3-M1 (MUST, relay, P1 delta).** `server.js`'s `derivePairState` slice is an
explicit allowlist `{kid, epk, mode, recipKeys, wrap}`, so a `ctx` on the block
was **silently dropped** — fixing the web page and leaving the extension service
worker, the one recipient whose whole purpose is decrypting with the panel
closed, exactly as broken. It MUST splice `ctx: block.ctx` into `state.e2e`
alongside `wrap`, under the same `block && forWs.deviceId && mine` precondition.
`ctx` is **pair-scoped, not device-scoped**: unlike `wrap`, every recipient gets
the identical object. `ACCEPT_PAIRING → PAIRING_ACTIVE` and the resume path
forward the block **whole** — `validateE2eBlock` has no key allowlist and
returns `raw` verbatim — so those recipients already receive it, and the 4 KB
block cap absorbs `ctx` (~140 B). **The relay remains a byte-carrier:** it does
not parse, validate, default or mint `ctx`. A relay that parsed it would be a
relay that could propose one, and a relay that rejected a malformed one would
hand an attacker a way to deny a working pairing. M2–M4 below are all
**receiver-side**.

**A3-M2 (MUST, blocking, P2/P3/P4) — the epoch floor.** Each computer-side
device persists a floor `lastPairEpoch[(userId, phoneDeviceId)]` and **MUST
refuse any `ctx.pairEpoch <= floor`**, aborting the pair — never falling back to
plaintext, never deriving. The floor is written **before** the derived keys are
used to seal or unseal anything (persist-before-use, the same family as
§13.10.5 rule 3 and for the same reason: a crash between use and persist must
leave the floor ahead, not behind). First sight of a `phoneDeviceId` sets the
floor with **no comparison** (TOFU, consistent with §13 device pinning). The
floor is cleared **only** by an explicit user unpair / revoke / sign-out —
**never by a value arriving on the wire**.

Rationale: `pairEpoch` is phone-owned and monotonic (Accept bumps it, Reset /
`RESET_ROOM` increments it). Without the floor, a relay that replays an old
`ACCEPT_PAIRING` block re-installs a superseded `SK` under its old epoch, and
A2's per-`(kid, direction)` counter restarts at 0 against a key *and prefix*
that have already sealed frames — **GCM nonce reuse**, the one failure in this
protocol whose cost is total. The floor is what makes A2 MUST#1 hold across a
*replay* rather than only across an honest rekey. The SAS would also mismatch,
but §13 makes the SAS explicitly non-blocking, so it cannot be the control here.

**A3-M3 — SUPERSEDED IN FULL by Addendum A4 (below).** Its original text —
"a receiver MUST refuse a block whose `ctx.peerDeviceId` is not its own
`deviceId`" — is **DELETED**, not relaxed: it contradicted A3-M1 ("`ctx` is
pair-scoped; every recipient gets the identical object") and the two together
admit at most ONE recipient per pairing. The replacement text, its three
clauses, and the reason the deletion is safe for everything already shipped are
in **§13.10.9**. The `pairingId` half survives there as clause (a).

**A3-M4 (MUST).** A `mode=1` block arriving with **no `ctx`** MUST be refused,
**not derived-from-local**. Deriving from a locally guessed context is precisely
the silent divergence A3 exists to kill, and it would let a stripping relay
force both sides into a guess.

**Vector I in `tests/kdf-vectors.json`** (`ctxWire`). I.1 is the positive — wire
`ctx` + local `userId` reproduces the frozen `contextBytesHex`, the frozen
traffic keys and A2's prefixes, and A2 vector F's ciphertext opens under the key
derived from it. I.2 is the epoch-drift replay case, I.3 the `userId`-drift
case, I.4 the parser negatives. **P4 asserts I.1 through its *encode* path (it
builds `ctx`), P2/P3 through their *decode* path** — that pairing is what makes
the vector cross-implementation rather than two copies of one belief.

**Where this lives.** `pairContextFromWire()` in `lib/e2e/kdf.mjs` is the ingest
point for the web and service-worker lanes: it enforces the decimal-string
parse, A3-M3 (as re-scoped by §13.10.9) and A3-M4, and returns `pairEpoch` as a BigInt so the **caller**
can apply the A3-M2 floor — which is deliberately not in the module, because the
floor needs durable per-device storage the module does not have and must not
invent. The relay's half is `derivePairState` in `server.js`, pinned by
`tests/e2e-pair-state-ctx.test.mjs`.

#### 13.10.9 Addendum A4 — multi-recipient `ctx` and the canonical peer

**RATIFIED (1), AMENDED, 2026-09-17T20:58Z.** A3 froze two MUSTs that cannot
both hold. A3-M1 made `ctx` **pair-scoped** — "every recipient gets the
identical object". A3-M3 then made a receiver refuse any block whose
`ctx.peerDeviceId` was not its own `deviceId`. Together they admit **at most one
recipient per pairing**: the page and the extension service worker could not
both be admitted by the same block, and §13.6's whole reason for a second
recipient disappears. A4 resolves the contradiction and freezes a selection
rule. It reopens no frozen frame, rekeys no shipped pairing, and **Gate 1's PASS
verdict is unaffected**.

**Why not per-recipient contexts.** A device-scoped `ctx` would mean a different
`pairContext` per recipient, hence different `k_p2c`/`k_c2p` per recipient. It
is not a costlier variant — it is a protocol the shipped transport cannot carry.
Sealed phone data frames are **one ciphertext broadcast byte-identically to
every listener** (`broadcastToListeners(room, msg, perSocket = null)` in
`server.js`; the per-socket builder exists **only** for `PAIR_STATE`, which is
§13.6's per-listener `wrap`). A single broadcast frame would open for exactly
one recipient and present the other with a GCM tag failure **indistinguishable
from a network fault** — a silent, permanent, unattributable half-break. It also
contradicts §13.2's multi-recipient wrap design, in which every wrap's KEK
derives from **one** context.

**A4-R1 (RATIFIED).** `ctx.peerDeviceId` is the **canonical peer for
derivation**, not "the receiver". There is ONE `ctx`, ONE `pairContext`, ONE
traffic-key set and ONE nonce-prefix pair per pairing, shared by every
recipient. Per-recipient separation is provided **where it already belongs** —
the KEK, which binds the recipient's own static key on top of the shared context
(`kekInfo = "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i`). Vector J.1c pins
that the KEKs differ while the traffic keys do not.

**A4-R2 (FROZEN) — the canonical set is `wraps[].deviceId`, NOT `recipKeys[]`.**

> `canonicalPeerDeviceId(wraps)` = the **byte-wise lexicographically lowest** of
> `wraps[].deviceId`, compared as **raw UTF-8 bytes** — not code points, not
> locale collation, not `String.prototype.localeCompare`, not case-folded.

`recipKeys[]` is the **full static key set** of the pairing — SEC1 public keys,
and it **includes the phone** (`lib/e2eBlock-core.js`:152–155). A "lowest of
`recipKeys[]`" is neither a deviceId nor a recipient-only set, so that wording
MUST NOT be adopted. The recipient deviceId set lives in `wraps[].deviceId`,
which `validateE2eBlock` already bounds (1..128 chars) and already proves
**duplicate-free** (`lib/e2eBlock-core.js`:169–173). That uniqueness is what
makes "lowest" **total** — there can be no tie.

UTF-8 **bytes**, not JS string order: `a < b` compares UTF-16 code units and
disagrees with byte order above U+FFFF, so a `<`-based lane and a byte-based
lane would pick **different** canonical peers and both fail closed with a tag
error and no attribution. The selection is deterministic and
**order-independent**, so a re-ordered but otherwise identical offer derives the
same keys and a reordering relay alone cannot steer.

**Single-recipient invariance — FROZEN.** Tag `0x13` keeps its existing
encoding: one id, `u8`-length-prefixed, no count byte, no list. For a
one-recipient pairing the canonical lowest **is** that recipient, so the context
bytes are byte-identical to what ships today. Proof, not assertion: vector
**J.3**'s steered context — the two-recipient pairing with `peerDeviceId` forced
to `dev-web-01` — recomputes `k_p2c = b12f964e…e060`, which is **exactly** A3
vector I.1's frozen `phoneToComputerKeyHex`. A4 rekeys nothing already shipped,
adds no row to E–H or I, and forces no re-pair.

**A4-R3 — the membership check must be the cryptographic one.** "Refuse when
`ctx.peerDeviceId` is not the canonical lowest" is sound against relay steering
**only where the receiver can see the deviceId set**. It cannot on the lane that
matters: `derivePairState`'s allowlist is `{kid, epk, mode, recipKeys, wrap,
ctx}` — `wrap` **singular**, the opaque value only, deliberately, because
handing a listener every wrap would put other devices' sealed key material in a
service worker for no reason. The extension SW therefore holds **no deviceId
list at all**. Shipping the syntactic check as a flat MUST would produce a check
the SW must silently skip — the decorative control §13.6's pin exists to refuse.

The real membership proof is already in the protocol and is strictly stronger:
**the wrap addressed to this device opens under the KEK derived from `(ctx, its
own static key)`.** Success proves in one step that (i) this device's `ctx`
bytes are **byte-identical to the phone's** — a cryptographic confirmation of
the whole shared context, canonical-peer choice included — and (ii) the phone
deliberately addressed this device. A relay cannot forge it without `SK`.

**A3-M3, re-scoped — REPLACEMENT TEXT (supersedes A3-M3 in full).**

> **A3-M3 (MUST; receiver-side; fail-closed, never a plaintext fallback).** A
> receiver MUST refuse a `mode=1` block when **any** of the following holds:
>
> **(a) Pairing.** `ctx.pairingId` differs from the id of the pairing it is
> party to, wherever it independently knows that value.
>
> **(b) Membership — cryptographic.** The wrap addressed to it does not open
> under the KEK derived from `(pairContext(ctx ‖ local userId), its own static
> key K_i)`; or no wrap is addressed to it at all. The wrap that opens **is**
> the proof of recipient status. Refusal is fail-closed: no retry in the clear,
> no derive-anyway.
>
> **(c) Canonical peer — conditional, and ONLY where verifiable.** A receiver
> that holds the full `wraps[]` (the page, via `ACCEPT_PAIRING` /
> `PAIRING_ACTIVE`, which forward the block whole) MUST refuse when
> `ctx.peerDeviceId` is not the byte-wise lexicographically lowest of
> `wraps[].deviceId`. A receiver that does **not** hold the set (the extension
> service worker, via `PAIR_STATE`, which carries only its own `wrap`) MUST NOT
> attempt this check, and MUST NOT substitute its own `deviceId` for the
> canonical peer — doing so is the A3-M1/A3-M3 contradiction A4 exists to
> remove. For that receiver, (b) is the binding check.
>
> **DELETED:** "a receiver MUST refuse a block whose `ctx.peerDeviceId` is not
> its own `deviceId`." It refuses every recipient except the canonical one and
> makes multi-recipient pairing impossible. It is **removed** from
> `pairContextFromWire()`, not merely relaxed.

**A4.1-M2 (MUST, normative; GATE1 Addendum A4.1, RATIFIED 2026-09-17T23:00:39Z).**
No control may be gated on clause (a), and clause (a) MUST NOT be described
anywhere in this spec as a membership or authenticity check.

> The `cc_e2e_own_pairing` pin is a consistency pin only; it is clearable by a
> wire-delivered `ROOM_RESET` and confers no authenticity. The SW's membership
> proof is A4 clause (b).

The reasoning, recorded so it is not rediscovered as a finding. A
relay-position attacker can **erase the TOFU pin at will**: `ROOM_RESET`
arrives on the wire and clears it, after which a new epoch's `ctx` bearing any
`pairingId` is pinned with no comparison. Clause (a) therefore has **no**
adversarial strength against the threat model it sits in — it catches the
*benign* failure (a `ctx` or wrap surviving from a different pairing in the
same browser session: stale room, two tabs, a re-pair mid-flight) and nothing
more.

That is acceptable **only** because clause (b) is untouched. The own wrap must
open under `KEK(ctx, own static key)` and `ctx` binds `pairingId`, so a foreign
`pairingId` fails the unwrap and lands in `setAborted()` (A4-M3, sticky) —
never counts-only, never plaintext. **Clause (b) is the sole anchor.**

Re-TOFU is therefore **by design and survivable**, not a gap. The same
`ROOM_RESET` also calls `clearAborted()`, and after a browser restart the pin
re-TOFUs from the first `ctx` of the same epoch — both are survivable because
the next block re-fails the unwrap and re-aborts, and because both landing
states (abort, counts-only) hide bodies. Since (a) is non-authoritative,
re-TOFU loses nothing. Severity: **Informational**; no fix dispatched.

This is also why the pin stays in `storage.session` while the epoch floor stays
in `storage.local`: the floor is a safety control whose failure is catastrophic
and silent, so it must outlive the browser; the pin is a consistency hint whose
failure is a *false refusal*, and a pin surviving browser exit would convert a
legitimate re-pair into a permanent unexplained counts-only state for a check
that was never authoritative. Moving it to `storage.local` requires a fresh
ruling, not a storage swap.

**Residual risk, stated plainly.** A relay that **rewrites** `wraps[].deviceId`
(renaming, not re-keying) can move the canonical peer and desynchronise
derivation. It is a **denial of service only**: the relay holds no `SK`, gains
no plaintext, and every recipient fails closed on frame one. It is not a
downgrade and not key confusion. Clause (c) narrows even that wherever the set
is visible. Accepted, with the reasoning recorded so it is not rediscovered as a
finding.

**A4-M1 (MUST, `lib/e2e/kdf.mjs`).** `pairContextFromWire()` drops the
`deviceId !== ctxWire.peerDeviceId` refusal and takes an optional
`recipientDeviceIds` instead. When supplied it MUST refuse unless
`ctx.peerDeviceId` equals the byte-wise lowest of that set; when absent it MUST
perform **no** peer check and MUST NOT default to the caller's own `deviceId`.
`pairingId` (a) and the A3 decimal-string/BigInt parse are unchanged. The
implementation **rejects** a `deviceId` option rather than ignoring it: a caller
still passing it believes a membership check is running, and silently dropping
the option would leave that belief intact with the check gone. `canonicalPeerDeviceId(wraps)`
is exported as the single helper both lanes and the tests use.

**A4-M2 (MUST, P4 encoder).** The phone emits
`ctx.peerDeviceId = canonicalPeerDeviceId(wraps)` under A4-R2's byte-wise UTF-8
rule, computed over the **same** `wraps[]` it ships in that block. It MUST be
pinned by a test with a set whose lowest is **not first in array order**.

**A4-M3 (MUST, every receiver).** Unwrap failure is a **pairing abort**, never a
degrade. §13.2 row 2's "SW absent → counts-only badges" covers a recipient that
never had a key; it does **not** cover one whose wrap failed to open. That is a
tampered or mismatched pairing and MUST fail closed.

**A4-M4 (MUST, relay — restatement, no code change).** The relay stays a
byte-carrier for `ctx`: it does not parse, validate, default, mint or reorder
it, and it does not reorder `wraps[]`. Reordering would be indistinguishable
from steering. A3-M1's splice is verbatim-forward and remains correct.

**A4-M5 (SHOULD, diagnostics).** On unwrap failure a receiver logs the
**canonical peer it derived from** and its own `deviceId` — ids only, never key
material, never `ctx` in full. Without it the multi-recipient failure mode is a
tag error with no attribution.

**A4.1 — the SW's `pairingId` channel (Ken's ruling; PENDING Security ack).**
Clause (a) is unverifiable on the SW lane as A4 writes it: `PAIR_STATE` carries
`pairingId` only **inside `ctx`**, and checking `ctx.pairingId` against itself is
a check that cannot fail. The SW's **own** `pairingId` is therefore learned two
ways, neither of which touches the relay:

1. **Handed over by the page** over the FORGE-P pinned bridge whenever the page
   is open — the `e2e-pubkey-request` reply gains `pairingId`. The page owns the
   pairing, so this is the authoritative source.
2. **Otherwise TOFU** from the **first** `PAIR_STATE` `ctx` of a new
   `pairEpoch`, persisted in `storage.session` alongside that epoch. Every later
   `ctx` in that epoch MUST match it; a mismatch refuses. A new epoch resets it.

**No relay change.** And clause (b) — the SW's own wrap opening under its own
KEK — remains the SW's cryptographic proof of membership. A4.1 makes (a) a
**consistency** check on that lane; it is **not** the anchor, and it does not
weaken (b) in any way. Security to acknowledge as A4.1.

**SAS — §13.3 stays FROZEN.** `pairingId` (the salt) + `pairEpoch` + the full
static key set `K_1..K_n` already cover everything the canonical-peer choice can
affect, and A3's test applies unchanged: **every `ctx` field is either
SAS-visible or key-binding, and there is no wrong-but-working key reachable by
editing `ctx`.** `pairingId` and `pairEpoch` are SAS-visible — editing either
changes the digits on one side and the user sees it.
`phoneDeviceId`/`peerDeviceId` are key-binding — editing either yields universal
authentication failure on frame one, a property A4 makes *stronger*: one shared
key set means a tampered canonical peer breaks **every** recipient identically
and loudly rather than one of them quietly. Adding deviceIds to the SAS would
re-freeze §13.3 for zero security property and would make the user-facing digits
depend on relay-mutable **non-key metadata** — converting a rename from "both
sides fail loudly" into "the digits also disagree", which teaches users to
dismiss mismatches.

**Vector J in `tests/kdf-vectors.json`** (`canonicalPeer`). Fixtures continue
A3's, so J composes with E–H and I instead of standing apart.
`wraps[].deviceId = ["dev-web-01", "dev-ext-02"]`, deliberately ordered so the
canonical lowest (`dev-ext-02`) is **not** first. J.1 is the positive — one
`ctx`, identical context bytes and identical traffic keys on both lanes. J.1b is
the ONE broadcast ciphertext that opens for BOTH. J.1c is the per-recipient KEKs
differing from that same `ctx`. J.2 is the `pairingId` refusal, J.3 the
relay-steering refusal **and** the single-recipient invariance cross-check, J.4
the non-member, J.5 the pre-A4 regression this addendum is for. **P4 asserts
J.1 + J.3's canonical selection through its *encode* path; P2 asserts
J.1/J.1b/J.1c/J.3/J.5 through its *decode* path with the full `wraps[]`; P3
asserts J.1/J.1b/J.4 through the `PAIR_STATE` path without the deviceId set** —
proving (c) is correctly skipped there and (b) correctly binds.

**Vector K in `tests/kdf-vectors.json`** (`canonicalPeerByteOrder`) — GATE1
"Addendum A4 — vector K: **COUNTERSIGNED**", 2026-09-17T19:07:20Z. Vector J
freezes the rule's bytes but **cannot catch a wrong comparator**: all of its
deviceIds are pure ASCII, where unsigned UTF-8 byte order, signed byte order and
UTF-16 code-unit order all agree. K is the fixture where they disagree, on J's
otherwise-unchanged fixtures, and it is **two** mandatory vectors because one
pair cannot pin both bugs — signed-vs-unsigned diverges only when the first
differing byte is ASCII vs non-ASCII, UTF-16-vs-code-point only when the first
differing character is BMP ≥ U+E000 vs supplementary, and those conditions are
mutually exclusive at the same position.

- **K1** catches **UTF-16 code-unit order** (Kotlin `String.minOrNull()`, JS
  `<`): `"dev-�-01"` vs `"dev-𐀀-01"` (U+10000). Canonical =
  `"dev-�-01"`. A signed-`Byte` implementation picks the **correct** id
  here, so K1 alone does **not** satisfy the requirement.
- **K2** catches **signed byte comparison** (Kotlin `Byte`, Java `byte`):
  `"dev-z-01"` vs the U+10000 id. Canonical = `"dev-z-01"` (`0x7A < 0xF0`
  unsigned; signed reads `0xF0` as −16 and picks the wrong id). UTF-16 order
  agrees with unsigned here, so K2 alone does not satisfy it either.

Each is frozen in **both** `wraps[]` orders: selection is a function of the
**set**, never of arrival order. The negatives (K1.2, K2.3) freeze the key the
wrong comparator would derive — which is the point: the derivation **succeeds**,
it is simply a key nobody else holds, so without the refusal the break is silent.
The page lane MUST refuse them; the SW lane, holding no set, skips clause (c)
and anchors on clause (b) (K.4, unchanged from A4).

**CORRECTION, binding.** An earlier statement of this requirement asserted that
U+10000 (`F0 90 80 80`) sorts **below** U+FFFD (`EF BF BD`) under unsigned UTF-8
byte order. It does not: unsigned UTF-8 byte order is identical to Unicode
code-point order, `0xEF < 0xF0`, so **U+FFFD is the lower** and is the canonical
peer. The inverted direction is the **UTF-16 answer** — precisely the wrong
answer the vector exists to catch, so freezing it would have pinned the bug
instead of the rule. A4-R2's rule is unchanged; only the illustrative direction
was wrong.

**Implementation requirement (normative).** `canonicalPeerDeviceId(wraps)` MUST
compare `new TextEncoder().encode(id)` (`Uint8Array`, unsigned by construction)
element-wise, shorter-is-lower on a common prefix. It MUST NOT use JS string
`<`, `Array.prototype.sort` on strings, Kotlin `String.minOrNull()` /
`compareTo`, or any signed-`Byte` comparison.

**Scope.** A4 blocks **P3's multi-recipient acceptance only**. P2 / P3 / P4
sealing on the **single-recipient** path continues under A3 unchanged — A4-R2's
invariance proof (J.3 ≡ I.1) is what makes that safe rather than hopeful. A1 /
A2 / A3 conditions carry over unchanged except A3-M3, superseded in full above.
§13.3 is untouched.

### 13.11 N-1 — encrypted-pairing kill switch (`E2E_PAIRING_ENABLED`)

**N-1.1 — ACKED (Security A5).**

> `E2E_PAIRING_ENABLED === '1'` enables NEW encrypted pairings; anything else
> refuses them with the plan's copy; existing pairs continue; plaintext
> untouched.

The switch gates the **handshake only**, never the data plane, so flipping it
mid-incident drops nobody who is already connected, and it never strips or
modifies an `e2e` block — a relay that quietly removed key material would be
indistinguishable on the wire from an attacker doing the same, which would turn
the downgrade attack the SAS exists to catch into a first-party feature. A
`mode=1` request is therefore REFUSED OUTRIGHT rather than silently downgraded.

Default OFF: D1 ships the code dark and the variable is flipped afterwards in
the environment. An unset or unrecognised value must leave the handshake dark —
the failure mode of a misconfiguration must never be "the crypto feature turned
itself on".

**LANDED — E2E-P1.3 (a).** `server.js`:

```js
const E2E_PAIRING_ENABLED = process.env.E2E_PAIRING_ENABLED === '1';
```

- **Exactly one string.** No trimming, no case folding, no second member.
  `"true"`, `"TRUE"`, `" 1 "`, `"01"`, `"0"`, `"false"`, `""`, unset and every
  typo are OFF. D1-PREP's interim `['1','true']` ON-list is **superseded**: it
  widened the ON side past the N-1.1 ack, which names `'true'` as a value that
  must fail closed. A padded `" 1 "` from an env console therefore leaves the
  feature dark and says so in the log — the safe way to be wrong.
- **READ TIMING: once at module load, not per request.** Flipping the variable
  takes a **relay restart**, not merely the next request; the boot log is the
  confirmation the new value took. A switch whose state can change between the
  block validation and the gate inside one handler is harder to reason about at
  3am than one that cannot.
- **Boot log, exactly one line, greppable:**

  ```
  [e2e] encrypted pairing DISABLED (E2E_PAIRING_ENABLED != '1')
  [e2e] encrypted pairing ENABLED (E2E_PAIRING_ENABLED === '1')
  ```

  The OFF line names the **predicate**, not the env value. Echoing an
  operator-supplied string into the one line an incident responder greps invites
  reading a typo as a mode. **This supersedes the older
  `[e2e] pairing disabled (E2E_PAIRING_ENABLED=0)` wording; any runbook step
  that greps the old string matches nothing and must be updated.**
- **Refusal copy (frozen, E2E-PLAN N-1):** a refused mode-ON client sees
  **"Encrypted pairing temporarily unavailable"**. The wire frame is unchanged:
  `PAIRING_E2E_UNAVAILABLE:{"reason":"kill-switch"}`. The copy names **no
  update to either device** — no update clears an operator-thrown switch, and
  copy that says otherwise sends the user to do something that cannot work.
- Pinned by `tests/e2e-kill-switch.test.mjs`, which **extracts and evaluates the
  shipped predicate** rather than re-typing it. Two earlier revisions of that
  file tested a hand-copied predicate and certified the wrong answer both times.
