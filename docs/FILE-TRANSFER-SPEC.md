# FILE-TRANSFER-SPEC — phone ⇄ PC file transfer, relay-only
Forge, 2026-09-17. Feasibility spec. **No code was written; the main checkout was read-only.**
Origin: Dennis 2026-09-17 14:46 — "scope what it would take to add a file transfer function, we shall not save anything, we shall just relay the communication and the file transfer must be accepted by the receiving party. We should be able to transfer both ways, to phone or to pc."

---

## Plain English — read this part

**What it is.** You pick a file on your phone, your PC asks "Accept this file? holiday.jpg, 4.2 MB" — you click Accept, and the file lands on your PC. And the same the other way round. Nothing is stored on our servers: the file goes through the relay in small pieces, each piece is forwarded and immediately forgotten. If nobody accepts, not a single byte of the file ever leaves the sending device.

**Is it doable?** Yes. The relay already does exactly this job for messages, contacts and call logs — a file is just a bigger version of the same thing. There is one uncomfortable truth: a browser tab can only hold a file in memory while it receives it, so the honest cap for v1 is **25 MB**, and I would not promise more than 100 MB ever without a different (much more expensive) design. Photos, PDFs, documents, voice notes — all fine. Videos — mostly not.

**What it costs.** About **13–16 working days** across relay, web, extension, Android, UI and tests. It needs a new phone app version (**v59 or later** — do NOT bundle it into v58, that one is the encryption build), and two deploys.

**What it does NOT do.** We do not scan files for viruses. That has to be said out loud in the UI and in the Play listing, because a "send files" feature that silently implies safety is a promise we cannot keep. The receiver always sees the file name, size and type *before* accepting, which is the actual protection.

**The one decision you must make first (everything else follows from it): is file transfer a paid feature (Plus and up) or is it in Free too?** It changes the cap, the abuse budget, the relay's bandwidth bill and the marketing copy. My recommendation: **Plus and Pro only, 25 MB, 20 transfers/hour.** Free users see it, click it, and get the upgrade modal — it is a good upgrade trigger and it keeps the bandwidth cost attached to revenue.

---

## 0. Verified facts this spec is built on

Read from `C:\Users\D\Desktop\computercaller` at `0e487ce` (read-only, no branch checkout):

| Claim | Evidence |
|---|---|
| Nothing content-shaped is persisted today | `prisma/schema.prisma` — 15 models: User, Template, QuickReplyTemplate, Waitlist, FreeAccessEmail, FreeAccessAudit, AdminUserAudit, Subscription, UnmatchedWhopEvent, Article, Partner, PartnerApiKey, UsageCounter, FeatureSuggestion, FeatureVote. **No message, no attachment, no blob, no media table.** This spec keeps it that way. |
| The relay is a text-frame bus | `server.js:1897` and `server.js:2150` — every inbound frame is `data.toString()`. A binary WS frame would be UTF-8-mangled on arrival. `server.js:607` re-sends `typeof msg === 'string' ? msg : msg.toString()`. |
| Dispatch is prefix-matching on strings | `server.js` `msg.startsWith('SEND_SMS')`, `'MAKE_CALL'`, `'GET_MESSAGES:'` … ; `frameType()` at `server.js:103` takes `split(':',1)[0]` validated against `/^[A-Z][A-Z0-9_]{0,39}$/`. |
| **There is no per-message size cap today** | No `maxPayload` anywhere in `server.js`; `new WebSocketServer({ noServer: true })` at `server.js:407`. `ws@8.21.0` default `maxPayload` = **100 MiB**. A 25 MB frame would pass today — which is exactly why we must set an explicit cap rather than rely on the default. |
| `frameBuffer` is a 200-entry replay buffer | `FRAME_BUFFER_MAX = 200` (`server.js:336`); pushed at `server.js:2017-2019`; replayed on resume at `server.js:1056-1077`; cleared on hold/expiry at `:869`, `:970`, `:1077`. |
| The tier chokepoint exists and is named | `gateBrowserSyncFrame(ws, msg)` at `server.js:1473`, returning `{action:'pass'\|'clamp'\|'drop'}`, applied at `server.js:2226` to both the active-pair forward and the survivor path. |
| Android is at versionCode 57 / 1.0.33 | `dnkdialer-android/app/build.gradle.kts:345-346`. v58 is the E2E build (e2e/STATE.md, P4). File transfer is therefore **v59+**. |
| `*_CHUNK` is padding-exempt **by suffix, not by list** | E2E-SPEC-v1.0.md §13.4: "`*_CHUNK` is exempt, by suffix rather than by list." `FILE_CHUNK` matches that suffix with **no spec amendment needed** — see §5. |

---

## 1. Transport

### Recommendation — base64 payload inside a text frame, `FILE_CHUNK:{…}`

```
FILE_CHUNK:{"id":"<transferId>","seq":0,"n":64,"data":"<base64>"}
```

**Chunk size: 48 KiB of raw bytes → 65 536 B of base64 → ~65.7 KB on the wire including the JSON envelope.** At 25 MB that is 534 chunks.

**Why text/base64 and not binary WS frames.** Binary is 33% cheaper on bandwidth and that is its entire case. Against it:

1. `server.js:1897` / `:2150` call `data.toString()` unconditionally. Binary support is not a flag — it is a **second data plane** through the relay's routing, held-pair, survivor-forward, lobby-drop and logging paths, on a file that is 2 756 lines of carefully-reasoned edge cases.
2. `frameType()` (`:103`) and `frameLabel()` (`:109`) are how every log line is redacted. A binary frame has no type prefix, so it logs as `UNKNOWN` or not at all — we lose the one observability surface the relay has, on the one feature most likely to need debugging.
3. `gateBrowserSyncFrame()` is a **string** gate. Tier enforcement for files would need a parallel binary gate. Two gates is how one of them ends up fail-open.
4. The E2E envelope (§13.10) is specified as a JSON header `{e,kid,s}` with the AAD re-encoded from parsed fields. Sealed binary frames would need their own framing, and §13.10.1's tag ranges would need a new allocation.
5. Android/OkHttp, the web `WebSocket`, and the MV3 SW all already have working **text** paths with reconnect/resume semantics that have been debugged for a year.

The 33% is real but it is paid in bandwidth, which is cheap and elastic; binary would be paid in protocol divergence, which is neither. **Revisit binary only if v2 raises the cap past 100 MB.**

### Backpressure

Sender-paced, ACK-windowed, never unbounded:

- **`FILE_ACK:{"id":…,"upTo":<seq>}`** from receiver, emitted every 8 chunks and on the final chunk.
- Sender keeps a window of **16 unacked chunks (~1 MB in flight)**. It stops sending at the window edge and resumes on the next ACK.
- **Sender-side watermark** (both web and Android): before each send, if `socket.bufferedAmount > 2 MB`, defer the next chunk (web: `setTimeout(…, 25)` loop; Android: OkHttp's `queueSize()`). This is the guard that actually prevents an OOM on a slow uplink — the ACK window bounds the *peer*, the watermark bounds *us*.
- **Relay-side watermark** (new, ~10 lines at the forward site): if the destination socket's `bufferedAmount > 8 MB`, the relay **aborts the transfer** with `FILE_FAILED:{id, reason:"relay_backpressure"}` to both sides. It does **not** buffer. A relay that queues is a relay that stores.

### frameBuffer must not hold file chunks

`frameBuffer` exists to replay *missed messages* across a resume window (`server.js:1056-1077`, bounded at 200 entries). 534 file chunks would evict every real message in the buffer — the classic shape-keyed failure: a size-blind buffer that a big payload silently flushes.

**Exclusion:** at the two push sites (`server.js:2017-2019` and the browser-side equivalent), skip when `frameType(msg)` is in `FILE_OFFER | FILE_CHUNK | FILE_ACK | FILE_DONE`. Use `frameType()`, not `startsWith` — it is the already-validated classifier. Control frames `FILE_ACCEPT / FILE_DECLINE / FILE_CANCEL / FILE_VERIFIED / FILE_FAILED` are tiny and rare; buffering them is harmless and lets a decline survive a blip, so **they stay bufferable**.

### Behaviour across held-pair / dock / resume — **decision: ABORT, do not resume**

If the pair goes held (`server.js:855`) or the socket drops mid-transfer, the transfer is **cancelled** with `FILE_FAILED:{id, reason:"connection_lost"}`, the receiver discards its partial buffer, and the UI offers "Retry". It does **not** resume from the last ACK in v1.

Justification: resume needs the *sender* to still hold the file handle across an app backgrounding (Android SAF URIs can be revoked; the web `File` handle dies with the tab), the *receiver* to hold a partial buffer across a resume window of unbounded length, and the *relay* to keep per-transfer state across a hold — which is state about content, and content state on the relay is the thing Dennis explicitly ruled out. Abort is one branch, testable, and honest. **Resume-from-ACK is a v2 item and it should be gated on a real complaint, not on elegance.**

Practically: a held pair lasts seconds; the retry is one click; and at 25 MB over a normal connection a transfer is ~10–40 s, so the exposure window is small.

### Relay size cap

Set an **explicit `maxPayload` on the WebSocketServer** (`server.js:407`): `maxPayload: 256 * 1024`. 256 KiB is ~4× the 65.7 KB chunk with headroom for the E2E seal (+16 B tag, +12 B nonce, base64-of-ciphertext expansion, JSON header) and still far under the 100 MiB default that is currently our only protection. This is a **strict improvement to the relay's security posture independent of file transfer** and should ship even if Dennis kills the feature — today a single client can push a 100 MB frame through us.

Note: an explicit `maxPayload` **closes the socket** on violation (`ws` emits a 1009). Verify no existing frame exceeds 256 KiB before enabling — the largest today are `MESSAGES_CHUNK` / `CONTACTS_CHUNK`; **P6 must measure a real 30-day sync on a heavy phone and set the cap above the observed max, not below it.** If a real chunk approaches 256 KiB, raise the cap to 512 KiB rather than shrink the file chunk.

---

## 2. Handshake

```
sender                     relay                      receiver
  │ FILE_OFFER:{id,name,size,mime,sha256,from} ──────────►│   (arm: room.transfer[id] = {state:'offered', …})
  │                                                        │  ── UI: "Accept holiday.jpg (4.2 MB)?"
  │◄─────────────────────── FILE_ACCEPT:{id} ─────────────│   (relay: state='accepted')
  │ FILE_CHUNK:{id,seq,n,data} × n ─────────────────────► │
  │◄─────────────────────── FILE_ACK:{id,upTo} ───────────│
  │ FILE_DONE:{id} ─────────────────────────────────────► │   (receiver verifies sha256)
  │◄──────────── FILE_VERIFIED:{id} | FILE_FAILED:{id,reason}
```

| Frame | Payload | Notes |
|---|---|---|
| `FILE_OFFER` | `{id, name, size, mime, sha256, from}` | `id` = 16-byte random hex, generated by the sender. `name` is display-only and **must be sanitised at the receiver**, never used raw as a path (see §6). `sha256` is of the raw file bytes, lowercase hex. |
| `FILE_ACCEPT` | `{id}` | |
| `FILE_DECLINE` | `{id, reason}` | `reason ∈ {user_declined, too_large, type_not_allowed, busy, expired}` |
| `FILE_CHUNK` | `{id, seq, n, data}` | `seq` 0-based, `n` = total count, both present on every chunk so a receiver can size its buffer from chunk 0 alone. |
| `FILE_ACK` | `{id, upTo}` | |
| `FILE_DONE` | `{id}` | |
| `FILE_VERIFIED` | `{id}` | |
| `FILE_FAILED` | `{id, reason}` | `reason ∈ {hash_mismatch, connection_lost, relay_backpressure, cancelled, timeout, too_large, oom}` |
| `FILE_CANCEL` | `{id, by}` | Either side, any time. |

### Timeouts

- **Offer expiry: 60 s.** No `FILE_ACCEPT` in 60 s → sender emits `FILE_CANCEL:{id, by:"sender", reason:"expired"}`, receiver dismisses the prompt. The relay expires its own per-id state at **90 s** (offer) so a dead peer cannot leak a slot.
- **Stall: 30 s** with no chunk (receiver side) or no ACK (sender side) → `FILE_FAILED:{…,"timeout"}` both ways.
- **Total transfer ceiling: 10 minutes**, relay-enforced, then the id is dropped.

### Concurrency — **one transfer per pair at a time in v1**

Justified: the ACK window, the receiver's memory bound (§4) and the relay's abort-on-backpressure all reason about a single in-flight stream. Two concurrent 25 MB transfers into a browser tab is 50 MB of Blob plus 50 MB of base64 strings in flight — that is where a tab dies. A second `FILE_OFFER` while one is live is answered `FILE_DECLINE:{id, reason:"busy"}` **by the receiver**, and the relay independently refuses to arm a second id per room. Queueing in the UI ("3 files, sent one after another") is a P5 nicety over the same single-stream wire and is the right v2 answer.

### Relay behaviour — opaque forwarder with three cheap rules

The relay **never inspects `data`**. It keeps, per room, at most one small record: `{id, state, from, size, mime, startedAt, bytesForwarded}` — ~200 bytes, no content, dropped on completion/abort/room teardown. Rules:

1. **Accept-before-chunks.** A `FILE_CHUNK` whose `id` has no record in state `accepted` is **dropped and counted** (reuse `countDroppedLobbyFrame`-style per-type counters). This is the mechanical enforcement of Dennis's "must be accepted by the receiving party" — it is not left to client goodwill.
2. **Declared-size enforcement.** `bytesForwarded` is summed; exceeding `size × 1.40` (base64 + envelope headroom) aborts the transfer. A sender cannot declare 1 MB and push 200.
3. **Tier + cap gate at one chokepoint.** Extend `gateBrowserSyncFrame()` — or better, rename the concept to a `gateDataFrame()` that calls the existing sync logic plus a new file branch — so there remains **exactly one** tier chokepoint in the product (§13.7's note is explicit that this is the only one; do not create a second). `FILE_OFFER` is gated there: `{action:'drop', reason:'file_transfer_not_in_tier'}` below the entitled tier, and `size > cap` → drop with `file_too_large`. A drop must also emit `FILE_DECLINE` back to the **sender** so the UI says why instead of hanging — the existing gate silently drops, which is fine for `GET_CONTACTS` and is not fine here.

Note the gate is currently applied to browser→phone only (`server.js:2226`). **Phone→PC offers must be gated too**, which is a small extension of the existing structure, and it is the one place this feature touches a security-relevant path — flag for Security review at P6.

---

## 3. Android

**Send.** `ACTION_OPEN_DOCUMENT` (SAF) with `setType("*/*")` + `EXTRA_MIME_TYPES` from the allow-list. **No storage permission is needed** — SAF grants a per-URI read. Read via `ContentResolver.openInputStream(uri)` in 48 KiB blocks, `MessageDigest("SHA-256")` streamed over the same read (one pass to hash, a second pass to send — or hash-while-sending and send `sha256` in `FILE_DONE` instead of `FILE_OFFER`; **keep it in `FILE_OFFER`** and pay the second read, because a hash the receiver learns only at the end cannot be shown before Accept). Name/size from `DocumentsContract` / `OpenableColumns`.

**Receive.** API 29+ (which is the floor that matters — minSdk should be confirmed at build time, the repo targets 36): `MediaStore.Downloads` with `RELATIVE_PATH = Environment.DIRECTORY_DOWNLOADS`, `IS_PENDING=1` while writing, cleared on verify. **No permission at all** on 29+. API 26–28 (if minSdk is still 26): `WRITE_EXTERNAL_STORAGE` + `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)` — a runtime permission prompt and a Play-policy surface we would rather not add. **Recommendation: gate file-receive to API 29+ and show "Requires Android 10 or newer" below that.** It costs a small user slice and removes a dangerous permission from the manifest entirely.

**Permissions delta: none on API 29+.** That is a significant point in this feature's favour given the app's history with Play and high-risk permissions.

**Foreground service.** The app already runs a `specialUse` FGS for the always-on relay (build.gradle comment, v50 notes: "FGS type stays specialUse (not dataSync → no 6h daily cap"). A transfer happens inside that existing service's lifetime — **no new FGS, no new FGS type, no new manifest entry.** Add a progress notification on the existing channel. This matters: `dataSync` FGS would bring the 6h cap and a fresh Play declaration; we avoid both.

**Doze/battery.** Transfers are user-initiated and foreground-adjacent; the existing FGS keeps the socket alive. Nothing new. A transfer started and then backgrounded will continue; a transfer whose socket drops aborts per §1.

**versionCode.** Next free integer **at the time of build**, ≥ 59 — v58 is reserved for the E2E build (e2e/STATE.md P4). Per the repo's own scar-tissue comments (build.gradle.kts:208, 304, 317), check `apk-releases/` and Play's highest consumed code before picking; never reuse. **Do not bundle file transfer into v58** — v58 is the encryption build and must be shippable and reviewable on its own.

**Play Data Safety (→ Pilot).** Files transferred are **user data in transit, not collected and not shared**: they are relayed and never written to our storage (verifiable: no model in `prisma/schema.prisma`). The Data Safety form needs: *Files and docs* → collected **No**, shared **No**, with the "data is encrypted in transit" box ticked (true today via WSS; true end-to-end once E2E mode is on). **Pilot must confirm** whether Play requires a *Files and docs* declaration for pass-through relay at all, and review the store listing copy — "we do not scan files for malware" needs to appear somewhere honest.

---

## 4. Web + extension

**Send (web page).** `<input type="file">` plus drag-and-drop on the conversation surface. `File.slice(offset, offset+49152)` → `arrayBuffer()` → base64. SHA-256 via `crypto.subtle.digest` streamed over the same slices (accumulate with an incremental implementation, or hash the whole `ArrayBuffer` once for ≤25 MB — at 25 MB a single `digest()` is fine and far simpler).

**Receive (web page).** Collect chunk `ArrayBuffer`s into an array, `new Blob(parts, {type: mime})` on `FILE_DONE`, verify SHA-256 over the Blob, then `URL.createObjectURL` + a real `<a download>` click **from the page**.

**Memory bound — the honest cap.** A 25 MB file in a tab costs roughly: 25 MB of chunk buffers + ~33 MB of transient base64 strings + 25 MB of Blob = **~85 MB peak**, and the base64 strings are short-lived but GC-timing-dependent. That is comfortable. At 100 MB the same arithmetic is ~340 MB peak in a single tab alongside the app — survivable on a desktop, an OOM on a low-RAM Chromebook. **Practical caps: 25 MB safe (v1), 50 MB acceptable, 100 MB is the hard ceiling of this design, and anything above needs the File System Access API (`showSaveFilePicker` + a `WritableStream`, streaming straight to disk) which is Chromium-only and a different feature.**

**The service worker must not hold the file.** Two independent reasons, both load-bearing:
1. **A download initiated from the SW is inert.** The extension's own download path must be a `<a download>` click in a *document* — the side panel or the popped-out window. This is a known shape (see Forge memory: SW downloads / `<a download>` in sandboxed contexts).
2. MV3 workers are **evicted**, aggressively and unpredictably. A 25 MB Blob accumulating in a worker that Chrome may kill at any idle moment is a transfer that fails at random.

**Therefore:** when the extension is the receiving surface, the SW **relays the chunks to the side-panel document** (`chrome.runtime.sendMessage` / a long-lived port) and the document accumulates and downloads. **If the side panel is not open, the extension must DECLINE the offer** (`reason:"panel_closed"` — user-facing: "Open ComputerCaller to receive files") rather than accept and lose it. Sending *from* the extension is fine from the document too (the file picker needs a document anyway; a file picker is gesture-bound and a gesture does not survive the message hop to the SW — see Forge memory on gesture-across-message-hop).

**Surfaces Pixel owns (P5-class, named only, not specified here):** the send affordance + drag target on the web conversation view; the incoming-offer accept/decline sheet (name, size, type, sender — and the "we don't scan files" line); a progress bar with cancel on both sides; the completed/failed states; the same three in the extension side panel at side-panel width; the Android send sheet + receive notification + progress notification; the Free-tier upgrade modal on the send affordance.

---

## 5. E2E interaction

**Sealing.** File content is content, so once encrypted mode is ON, `FILE_CHUNK` is sealed exactly like `MESSAGES_CHUNK`. §13.7's sealed list gains **`FILE_CHUNK`** and **`FILE_OFFER`**. `FILE_OFFER` carries `name`, `size`, `mime` and `sha256` — a filename is precisely the kind of short secret the protocol exists to hide, so **the whole `FILE_OFFER` payload is sealed**, not a partial like `CALL_STATUS`. `FILE_ACCEPT / DECLINE / ACK / DONE / CANCEL / VERIFIED / FAILED` carry only an opaque id and an enum reason — **plaintext**, so the relay can enforce accept-before-chunks (§2, rule 1) without decrypting anything. That is a deliberate, stated leak: the relay learns *that* a transfer happened, its declared size, and when. It never learns the name, the type or a byte of content.

> Note: the relay's **tier gate** needs `size` from a **sealed** `FILE_OFFER` under mode ON. Resolution: `FILE_OFFER` carries a plaintext `size` field **alongside** the sealed body (`FILE_OFFER:{"size":4404019,"e":{…sealed name/mime/sha256…}}`). Size is already leaked by the chunk count; declaring it plaintext leaks nothing new and keeps the single chokepoint working under encryption. **This is the one spec point that needs Security's sign-off before implementation.**

**Padding.** §13.4: "`*_CHUNK` is exempt, **by suffix rather than by list**." `FILE_CHUNK` matches `*_CHUNK` — **the frozen rule already covers it, no amendment, no new fixed chunk size.** And the stated reason applies verbatim: "fixed-count bulk transfer already discloses its size through the chunk count, so padding each chunk costs bandwidth and hides nothing" — a file transfer with `n` in every chunk is exactly that. `FILE_OFFER` is **not** `*_CHUNK` and **does** pad, which is correct: it is a short secret (a filename) and padding is what hides its length.

**Seq / dedupe — decision: file chunks SHARE the `(kid, direction)` counter.** They do not get their own stream. Reasons:
1. §13.10.5 rule 3 makes the counter a **durably-committed, fail-closed** value. A second counter is a second durable-commit path, a second restore-from-backup failure mode, and a second chance to reuse a nonce under the same key — which §13.10.4 calls "total loss of confidentiality *and* forgery."
2. The nonce is `sessionPrefix ‖ be64(seq)` under one key. Two independent counters under the same `(kid, direction)` key **collide by construction**. Separating them would require separate keys, i.e. a key-schedule change to a frozen section.
3. The §13.5 window is 1024 wide with floor advance capped at 256 per step. 534 chunks arriving in order advance the floor smoothly; the window is not stressed. **But**: a 25 MB transfer burns 534 seq values, and concurrent messages interleave — that is fine and is exactly what a single ordered stream is for. It does mean the §13.8 rekey bound (2^32) is reached ~500× faster per MB transferred, which is still ~8 million 25 MB transfers. Non-issue.

**Mode OFF.** Identical handshake, identical relay rules, plaintext `data`. The feature does not depend on E2E; E2E just makes it better.

**Phase ordering.** File transfer must land **after P6** (regression + mixed-mode + lifecycle). Building it against a protocol still being merged (P1 merged, P2/P3/P4 open as of 2026-09-17) would mean rebasing a new frame family across every E2E merge. P6 is the first point where the sealed-frame plumbing is stable on all four surfaces and a new sealed frame type is a small, well-understood addition rather than a moving target.

---

## 6. Abuse, limits and the things we must say out loud

| Control | v1 value | Where enforced |
|---|---|---|
| Max file size | **25 MB** | Client (pre-offer, both sides) **and** relay gate on `FILE_OFFER.size` **and** relay `bytesForwarded > size × 1.40` abort. Three layers because the client's copy is advisory. |
| Mime allow-list | `image/jpeg, image/png, image/webp, image/gif, image/heic, application/pdf, text/plain, text/csv, audio/mpeg, audio/mp4, audio/ogg` + the office types if Dennis wants them | Receiver declines `type_not_allowed`; sender's picker filters. **Deliberately excludes `application/vnd.android.package-archive` (APK), `application/x-msdownload`, `.exe/.bat/.sh/.scr` and anything executable.** |
| Transfers per hour | **20 per account** | `UsageCounter` already exists in the schema — this is a counter row, **not** content storage. |
| Bytes per day | **500 MB per account** | Same counter. This is the real bandwidth control; the per-file cap alone does not bound a loop. |
| Concurrent transfers | 1 per room | Relay record + receiver `busy` decline |
| Relay memory per room | ~200 bytes of transfer metadata, **zero content bytes** | By construction: forward-and-forget, no buffering, abort on backpressure |
| Filename safety | Receiver **regenerates** the filename: strip path separators, `..`, control chars, NUL; cap at 100 chars; force the extension to match the declared mime; de-duplicate against an existing file rather than overwriting | Receiver, both platforms. A sender-supplied name is attacker-controlled input. |
| Malware | **We do not scan. At all.** | Must be stated in (a) the accept dialog or immediately below it, (b) the Play listing / Data Safety copy, (c) the ToS. The receiver seeing name + size + type before accepting is the mitigation, and it is a real one — but it is *informed consent*, not protection, and the copy must not imply otherwise. |

Two further notes. **Rate-limit `FILE_OFFER` itself** (e.g. 5 offers per minute per room) — an unaccepted offer costs nothing in bandwidth but a stream of accept dialogs is a denial-of-attention attack on the receiver. And **the decline must be sticky per session**: three declines from the same sender in a row should offer "Block file transfers from this device".

---

## 7. Effort

Assumes E2E through P6 is merged and stable. Days are working days, one specialist each.

| Component | Work | Days |
|---|---|---|
| **Relay** (`server.js`) | Frame family pass-through; per-room transfer record + state machine; accept-before-chunks drop; declared-size enforcement; `bufferedAmount` abort; `frameBuffer` exclusion via `frameType()`; explicit `maxPayload`; extend the single tier chokepoint (+ apply it phone→PC); drop counters + redacted logging | **2.5** |
| **Web hook** (`hooks/usePhoneBridge.ts` + a new `useFileTransfer.ts`) | Send: slice/base64/hash/window/watermark. Receive: accumulate → Blob → verify → `<a download>`. State machine + cancel + timeouts | **2.5** |
| **Extension** (`background.js` + side panel) | SW relays chunks to the document; document accumulates + downloads; decline when panel closed; port lifecycle across SW eviction | **2** |
| **Android** (v59) | SAF picker + streamed read + hash; MediaStore Downloads write with `IS_PENDING`; state machine on the existing FGS; progress notification; API-29 gate | **3** |
| **Pixel UI** (P5-class) | The 8 surfaces named in §4 | **2.5** |
| **Tests / harness** | Relay unit tests for the three rules; a node harness driving a full 25 MB round trip both directions; accept-before-chunks negative; abort-on-hold; hash-mismatch; oversize; mime-reject; tier-drop; sealed-mode round trip; **an instrumented Android receive test** | **2.5** |
| **Play / Pilot** | Data Safety review, listing copy, "no scanning" disclosure, v59 submission | **0.5** (Pilot) |
| **Total** | | **≈ 15.5 days** |

**Dependencies.** Follows **P6 at the earliest** (§5). The relay `maxPayload` change should be split out and shipped **before** everything else, on its own, with the P6 sync-size measurement — it is a security fix that stands alone.

**Deploys: two.** (1) Relay + web + extension — the PC half is useless without a phone that speaks the protocol, but it is harmless and lets the harness run against a real relay. (2) Android v59 to Play. **One APK** (v59); do not bundle into v58.

**Minimal v1.** Phone → PC **and** PC → phone; 25 MB; images + PDF + txt; one transfer at a time; accept/decline with name+size+type; SHA-256 verify; abort-on-disconnect with a Retry button; Plus/Pro gated; no resume, no queue, no folder, no scanning, no preview. That is the 15.5 days. Cutting to **one direction only** saves ~2 days and I do not recommend it — Dennis asked for both, and the second direction is mostly the same state machine mirrored.

---

## 8. Open questions for Dennis

1. **Tier gate — Plus/Pro only, or Free too?** *(This is the decision everything else hangs off.)* Recommendation: **Plus and Pro. Free sees the button and gets the upgrade modal.**
2. **Cap — 25 MB (recommended, safe everywhere) or 50 MB (works, tighter on low-RAM machines)?** 100 MB is the hard ceiling of this design and I would not ship it in v1.
3. **PC → phone: straight into the Downloads folder (one tap, recommended), or a "where do you want it?" picker (one more tap, but the user chooses)?** Downloads is what every other transfer tool does and it needs no permission.
4. **File types: images + PDF + text + audio (recommended), or add Office documents (.docx/.xlsx/.pptx)?** Adding them is trivial; the question is whether you want to imply document workflows we do not otherwise support.
5. **Android 10 (API 29) minimum for receiving?** It removes a dangerous storage permission from the manifest entirely and avoids a Play surface. Costs a small slice of older devices.

---

## Not in scope / not done
No code was written. No branch was created. The main checkout at `C:\Users\D\Desktop\computercaller` was read only (`git log`, `grep`, `sed -n`); no `git checkout`, no writes, no builds. No processes were started or killed.

## Addendum A — 1 GB cap (Dennis 2026-09-17 17:21 "Can we do the file transfer with lets say a 1gb limit size?") — Ken tech note
1. **Feasible without whole-file buffering anywhere**, but the 25 MB design above changes in three places. (a) Chunking stays 48 KiB raw / 65.7 KB wire (well under Forge-V's 1 MiB `maxPayload` even after the E2E seal); 1 GB = 21,846 chunks; 16-chunk ACK window ≈ 1 MB in flight; relay watermark 8 MB abort unchanged; relay memory per transfer stays ~200 B of state — the relay never holds bytes. (b) **Receiver must stream to disk, not to a Blob**: web/extension via the File System Access API (`showSaveFilePicker` on the Accept click → `FileSystemWritableFileStream.write` per chunk; Chrome desktop only, fine for us), Android via a SAF `OutputStream`. Sender streams `File.stream()` / `InputStream`. The 25 MB "browser tab holds the file" limitation disappears. (c) **Resume becomes mandatory** (a 1 GB transfer is minutes, not seconds): receiver persists `{id, sha256, bytesWritten}` beside the partial file; on reconnect `FILE_RESUME:{id, upTo}`; sender re-slices from `upTo` if it still holds the handle, else `FILE_FAILED:{cancelled}`. The "abort, do not resume" decision in §Behaviour is reversed for caps > 100 MB. Hash check at the end unchanged; partial files are named `.part` and deleted on failure.
2. **Time per 1 GB** (base64 +33 % on the wire): phone upload 10 Mbit/s → ~18 min; 25 Mbit/s → ~7 min; 50 Mbit/s → ~3.6 min. PC download is rarely the bottleneck; Hetzner egress is not. A binary frame path would cut 25 % of that time — only worth it if 1 GB transfers are common (revisit per §Recommendation "binary only past 100 MB": at 1 GB this clause triggers; budget it as v2 of the feature, not v1).
3. **Cost**: Hetzner ingress is free; egress counts once per transfer (relay → receiver) at 1.33 GB. Included allowance on the current box ≈ 20 TB/month, overage ≈ €1/TB. 100 transfers/month = 0.13 TB, 1,000 = 1.3 TB, 10,000 = 13 TB — all inside the allowance; 100,000/month ≈ 133 TB ≈ €115/month. Cost is not the catch; a single transfer saturating one relay socket for 18 minutes is (one transfer per room at a time stays the rule).
4. **Recommendation**: Free 100 MB, Plus/Pro 1 GB (tier gate is the existing size check at FILE_OFFER — one number per tier, no new gate). Flat 1 GB for Free is affordable but hands abuse a free relay; if Dennis wants flat, add fair-use (e.g. 5 GB/day per account) at the same gate.
5. **Estimate delta**: +5–7 working days on top of 13–16 (disk streaming both receivers, resume protocol + tests, progress UI with ETA and cancel, a 1 GB fixture in the gate). Still v59+, still after P6.

## Addendum A — DECIDED (Dennis 2026-09-17 17:31, verbatim: "Lets limit it to 1gb max size per file with a 2gb daily limit. The trial period will not allow transfers.")
- **Per file: 1 GB hard** (1,073,741,824 bytes of raw file; checked at FILE_OFFER against `size`; oversize ⇒ `FILE_FAILED:{too_large}` before any chunk, and the sender UI refuses the pick with "Files up to 1 GB").
- **Per account: 2 GB per UTC calendar day** (00:00–24:00 UTC, not rolling). Chosen because it is one counter with one reset the user can be told ("resets at midnight UTC"), no sliding-window bookkeeping, and it matches how the tier tables already read. Counted in raw file bytes on the **sender's** account at FILE_OFFER (offer is refused with `FILE_FAILED:{quota}` when `usedToday + size > 2 GB`; bytes are committed to the counter at FILE_DONE, released at FILE_FAILED so an aborted transfer does not burn quota). **Receiver's quota is untouched** — the receiver did not choose the file, and charging both sides would double-count every transfer; abuse control lives on the side that initiates.
- Storage: one new row per (userId, utcDate) `FileQuota{userId, day, bytes}` — no content, no filenames; deleted after 7 days. Server-enforced only (server.js at the FILE_OFFER gate, same chokepoint family as `gateBrowserSyncFrame`); the clients mirror the number for UX, never for enforcement.
- **Trial = feature OFF. Subscribed (Plus/Pro) only.** Server refuses FILE_OFFER for trial/free accounts with `FILE_FAILED:{tier}`. UX: the "Send file" control is visible but rendered as a locked state on trial — extension side panel + /app phone mode + Android share sheet target all show "Send files is included with a subscription — Upgrade" linking to the existing pricing modal (same pattern as the other tier-locked controls); the receiver side on a trial account still ACCEPTs (the subscribed sender pays quota) — if Dennis wants receive locked too, that is one flag.
- Unchanged: 1 transfer per room at a time; nothing stored on the server; no virus scan (stated in UI + listing); queued post-P6, Android v59+.

---

## Addendum B — WIRE TRUTH v1 (transcribed verbatim, E2E-P1.3 (b))

**Provenance.** The body of this addendum is `agent-memory/ken/PROJECTS/computercaller/file-transfer/WIRE-TRUTH-v1.md`, transcribed BYTE FOR BYTE. It is frozen from FT-1 `ft/1-relay` @ 4da745a under Security addenda FT-A1 / FT-A1.1 / FT-A1.2, and FT-2 / FT-3b / P3.1 build against it.

**Why it is here.** D1-PREP (c3) was told to transcribe it and could not: the source is a LEDGER file, outside the repo, and a lane cannot read across that boundary during a gate run. So the wire truth lived only in the ledger while four lanes coded against it. A frozen spec that the code cannot be diffed against is not frozen — it is remembered. This copy is the one the repo's tests and reviews cite; the ledger copy is the mirror.

**Nothing below is adjusted, reordered, or summarised.** Where it disagrees with the body of this spec above, THIS ADDENDUM WINS — the body is the 2026-09-17 feasibility study, written before FT-1 existed; the addendum is the wire as built and ratified. The known disagreement is §1/§5's plaintext `size` on `FILE_OFFER`, superseded by FT-A1: the plaintext size is the envelope hint `ft.size` (untrusted, admission-control only) and the sealed `size` is authoritative.

---

# file-transfer WIRE TRUTH v1 — frozen from FT-1 ft/1-relay @4da745a (Security FT-A1 + FT-A1.1). FT-2 / FT-3b / P3.1 build against THIS; D1-PREP (c3) transcribes it into FILE-TRANSFER-SPEC Addendum B.
Frames (wire form TYPE:{json}):
FILE_OFFER:{id,name,size,mime,sha256,from} — mode ON: sealed + plaintext hint ft:{id,size} (outside AAD)
FILE_ACCEPT:{id}
FILE_REJECT:{id,reason} — receiver-authored ONLY; the relay never mints it
FILE_CHUNK:{id,seq,n,data} — padding-exempt (*_CHUNK), sealed when ON
FILE_ACK:{id,upTo}
FILE_RESUME:{id,upTo}
FILE_DONE:{id,sha256}
FILE_FAILED:{id,reason[,relay:true]}
Sealed non-offer FILE_* carry no plaintext id — the relay matches by TYPE against the room's single live transfer (one transfer per room, keyed by ft.id).
Reason enum (11): hash_mismatch | connection_lost | relay_backpressure | cancelled | timeout | too_large | oom | quota | tier | size_mismatch | busy
Relay-owned subset (8, stamped relay:true, abort-only, accepted plaintext under mode ON): tier · quota · too_large · size_mismatch · busy · relay_backpressure · timeout · connection_lost
bad_hint = relay counter only, never a frame. Peer frames carrying a top-level relay key: rejected + counted on all eight types.
Constants: FT_MAX_FILE_BYTES 1073741824 · FT_DAILY_QUOTA_BYTES 2147483648 (UTC calendar day, sender-charged, metered WIRE bytes / FT_WIRE_B64_FACTOR 4/3 for the charge; 1.40 for the ceiling) · FT_CHUNK_RAW_BYTES 49152 · relay watermark 8 MiB · stall 30 s · FT_OFFER_TTL_MS 90000 (sender expiry 60 s) · trial/free = tier refusal.
