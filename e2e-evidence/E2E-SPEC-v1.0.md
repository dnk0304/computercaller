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
| 10 | v58 ON | ext ON, web OFF (same computer) | **effective ON.** The computer advertises OR(web, ext) = ON. Both surfaces show the SAS. |
| 11 | v58 ON | new web ON, SW key swapped | **digits diverge** — the SAS covers the whole key set (13.3), so the swap is visible to the user, not only to the phone's DeviceKey pin. |
| 12 | v58 ON | new web ON, relay strips `e2e` | abort, and the digits would differ anyway (modeByte) |

Rows 8–10 all resolve the same way and it is the only safe direction: **a device
that asked for verification never silently gets less than it asked for.**

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

Pinned by `tests/padding-property.test.mjs` over 500 plaintexts including 1 B
and 100 KB.

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

**A3-M3 (MUST).** A receiver MUST refuse a block whose `ctx.peerDeviceId` is not
its own `deviceId`, and — wherever it independently knows the value — whose
`ctx.pairingId` differs from the pairingId it is party to. Both fail closed, no
plaintext fallback.

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
parse, A3-M3 and A3-M4, and returns `pairEpoch` as a BigInt so the **caller**
can apply the A3-M2 floor — which is deliberately not in the module, because the
floor needs durable per-device storage the module does not have and must not
invent. The relay's half is `derivePairState` in `server.js`, pinned by
`tests/e2e-pair-state-ctx.test.mjs`.
