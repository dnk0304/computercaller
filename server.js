/**
 * Custom Next.js server that also runs the relay WebSocket server in the same process.
 *
 * Why this exists: previously `npm run dev` only started Next.js, and users had to run
 * `npm run dev:all` (which used concurrently) to also bring up the relay. That setup was
 * brittle — the relay could fail silently and users wouldn't notice until the QR scan
 * stopped working. Embedding the relay here means a single `npm run dev` always brings
 * both up together, with one set of logs.
 *
 * Multi-tenant rooms:
 *   The relay maintains a `rooms` Map keyed by `phoneToken` (User.phoneToken in Prisma).
 *   Browser opens `wss://host/relay?token=<phoneToken>`; phone opens
 *   `wss://host/relay/phone?token=<phoneToken>`. Each room is completely isolated.
 *   Dispatch #28 (2026-05-24): connections without a valid token are CLOSED with
 *   code 4401. The legacy 'default' room is gone.
 *   Dispatch #32 (2026-05-25): the auto-pair model is GONE. See startRelay() docblock.
 */

const next = require('next');
const http = require('http');
const { parse } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

// Shared entitlement core (2026-07-27). The SAME runtime module the TS layer
// re-exports (lib/entitlement.ts → lib/entitlement-core.js), so the relay's
// money gate and the browser gate can never drift. Closes the broken-access-
// control leak where the raw-phoneToken relay doors admitted unentitled users.
const { evaluateUserEntitlement } = require('./lib/entitlement-core.js');

// Shared tier map (2026-07-27, dispatch feature/tier-gating). SAME CJS module
// the TS routes re-export (lib/tiers.ts → lib/tiers-core.js), so the tier used to
// gate relay frames is identical to the tier the browser/entitlement endpoint
// sees. syncSinceFloorMs derives the oldest `since` a tier may pull.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain-Node server (matches the require block above); keeps the eslint baseline unchanged.
const { syncSinceFloorMsFromLimits } = require('./lib/tiers-core.js');

// Dispatch FORGE-J (2026-09-15) — "Reset lobby". The primitive that empties one
// room and drops every socket in it lives in lib/roomReset-core.js so BOTH entry
// points (the RESET_ROOM WS frame below and the POST /api/relay/reset Route
// Handler) run the exact same code, and so tests/reset-room.test.mjs can import
// the real thing instead of hand-mirroring it the way the older relay tests do.
// Kept on ONE line: eslint-disable-NEXT-LINE covers exactly one line, so a
// multi-line destructure leaves the require() itself un-suppressed and adds an
// error to the baseline (and an "unused directive" warning on top).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain-Node server (matches the require block above); keeps the eslint baseline unchanged.
const { resetRoom: resetRoomCore, createResetRateLimiter } = require('./lib/roomReset-core.js');

// P1 — the e2e pairing block's size cap and key-encoding pin. Same rationale as
// roomReset-core above: the real implementation lives in a module so
// tests/e2e-passthrough.test.mjs exercises it rather than a mirror of it.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain-Node server (matches the require block above); keeps the eslint baseline unchanged.
const { validateE2eBlock, e2eRequestKeys, e2eAcceptKeys } = require('./lib/e2eBlock-core.js');
// T-RESUME-PHONE-RESTART-DESYNC. The resume-eligibility predicate and the
// LEAVE_ACTIVE-during-hold predicate live in their own module so the contract
// test drives the REAL rule rather than a mirror of it. See the file header for
// the prod incident that produced them.
const {
  readPhoneSessionParam,
  resumeGateVerdict,
  leaveActiveHonouredDuringHold,
} = require('./lib/resumeGate-core.js');

// Bundle A (2026-05-28) — Phase 4 security review fix (H7).
// Every server.js log site that previously included the raw phoneToken (and
// every site that includes any user-supplied token, including the new
// relay-ticket path) now runs the token through redactToken() first. Coolify
// keeps container logs accessible at :8000 with the Coolify panel open, so
// raw bearers in stdout were directly exfil-able by anyone who got panel
// access — and the relay logs every connection event and every dropped
// frame, so a single connect produced 5–10 raw-token lines per peer.
//
// Format: first 8 chars of the bearer + ':' + first 8 hex chars of
// sha256(bearer). 8+8 is enough entropy to disambiguate users in a log
// while being totally non-reversible (the hash is the truncated digest of
// the full 32-byte token, not a prefix lookup). Matches the standard
// convention used by other audited log redactions (Stripe, GitHub APIs).
/**
 * WS close reason as a short, PII-safe string.
 *
 * `reason` is a Buffer that is EMPTY for most real-world closes — notably 1006
 * (abnormal closure), where no close frame was ever received. That absence is
 * itself diagnostic, so it renders as '(none)' rather than as a blank field
 * that reads like a logging bug.
 */
function decodeCloseReason(reason) {
  try {
    const txt = reason ? reason.toString('utf8').trim() : '';
    return txt ? txt.substring(0, 80) : '(none)';
  } catch { return '(undecodable)'; }
}

/**
 * Dropped lobby frames, counted by frame TYPE per room.
 *
 * Ken's note is right: a rate is a signal, a line is an anecdote. Printing one
 * line per dropped frame told us frames were being dropped but never how many,
 * of what, or whether it was one burst or a steady leak — and with only 79 log
 * lines in 24h the individual lines were sparse enough to look incidental.
 */
const droppedLobbyFrameCounts = new Map(); // token -> Map(type -> count)

/**
 * PII-safe label for a relay frame: TYPE and byte length, never content.
 *
 * Relay frames are `TYPE:{json}`. The payload of SMS_RECEIVED, SEND_SMS,
 * PHONE_NOTIFICATION, CONTACTS and CALL_INCOMING carries message bodies,
 * contact names, phone numbers and 2FA codes. Printing even a 40-char prefix
 * put a sender + the start of an SMS body into container logs, which Docker /
 * Coolify retain — so every frame print site goes through this instead.
 *
 * The type is validated against a strict shape rather than trusted: a frame
 * with no colon (or a junk/garbled one) would otherwise make `split(':')[0]`
 * return the ENTIRE frame, turning the redaction helper into the leak.
 */
function frameType(msg) {
  const head = String(msg).split(':', 1)[0];
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(head) ? head : 'UNKNOWN';
}

function frameLabel(msg) {
  return `type=${frameType(msg)} bytes=${Buffer.byteLength(String(msg), 'utf8')}`;
}

function countDroppedLobbyFrame(token, msg) {
  const type = frameType(msg);
  let perRoom = droppedLobbyFrameCounts.get(token);
  if (!perRoom) { perRoom = new Map(); droppedLobbyFrameCounts.set(token, perRoom); }
  const n = (perRoom.get(type) ?? 0) + 1;
  perRoom.set(type, n);
  return { type, n, summary: [...perRoom].map(([t, c]) => `${t}=${c}`).join(' ') };
}

function redactToken(t) {
  if (!t || typeof t !== 'string') return '<no-token>';
  const prefix = t.slice(0, 8);
  const hash = crypto.createHash('sha256').update(t).digest('hex').slice(0, 8);
  return `${prefix}:${hash}`;
}

const NEXT_PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001', 10);
// F-5 (2026-05-29): we no longer expose os.hostname() to clients; HELLO frames
// use a stable literal instead (see the HELLO emit site).
const dev = process.env.NODE_ENV !== 'production';

// LEGACY_RELAY_PORT=1 opt-in safety net (dispatch #26, 2026-05-24).
//
// As of the path-based mount, the relay is exposed at `/relay` on the same
// HTTP server as Next.js — no separate port is needed in production. Coolify
// proxies WSS on :443 → /relay → Node :3000, single TLS endpoint, public QR
// works over the internet.
//
// If anything explodes in prod we want a 5-second revert. Setting this env
// var to "1" makes server.js ALSO start the old standalone listener on
// RELAY_PORT (default 3001), restoring the pre-refactor behavior. Default
// OFF — production should never need it after the deploy is verified.
const LEGACY_RELAY_PORT = process.env.LEGACY_RELAY_PORT === '1';

// LEGACY_RESUME_TEARDOWN=1 kill-switch (connection-stability fix, 2026-06-16).
//
// Default OFF → new "soft hold" behavior: when ONE side of an active pair drops
// its socket (reason 'socket_closed' — a transient mobile blip, NAT rebind, CF
// idle, single missed ping), the relay keeps the SURVIVING side in `active` and
// sends it a non-destructive PEER_RECONNECTING frame instead of tearing it down.
// tryAutoResume then re-slots the returning socket without the survivor ever
// leaving active / wiping its data caches. This stops the "reconnect storm"
// where every phone blip forced the browser back to the lobby + a full re-sync
// (regression from 0250586, 2026-06-11; the silent-resume design tore the
// survivor down a beat before re-linking, so resume could never be silent).
//
// Set to "1" to restore the pre-fix behavior: socket_closed fully tears the
// pair down (PAIRING_TERMINATED to both, both back to lobby) and relies on
// tryAutoResume re-forming from the lobby. A 5-second revert if the soft-hold
// path misbehaves in prod.
const LEGACY_RESUME_TEARDOWN = process.env.LEGACY_RESUME_TEARDOWN === '1';

/**
 * N-1 KILL SWITCH. `E2E_PAIRING_ENABLED` gates SAS-BLOCKING encrypted pairing.
 *
 * DEFAULT OFF (D1-PREP (c)). D1 is the first production deploy of the E2E
 * stack and it ships DARK: the code goes out, the feature does not, and Ken
 * flips the env var to `1` afterwards with no redeploy (D1-PLAN §2 step 6).
 * Fail-closed is the only correct default for a first deploy of a crypto
 * handshake — an unset variable must not turn a feature on in production.
 *
 * ── THE DEFECT THIS REPLACES (found in D1-PREP, and it was live) ───────────
 * The predicate used to be `process.env.E2E_PAIRING_ENABLED !== 'false'`:
 * default ON, and disabled ONLY by the exact nine characters "false".
 *
 * Every instruction in the D1 runbook says to set `E2E_PAIRING_ENABLED=0`.
 * Under the old predicate `'0' !== 'false'` is TRUE, so the variable Ken sets
 * to ship dark would have shipped the feature ENABLED — and the old
 * tests/e2e-kill-switch.test.mjs asserted that outcome as correct ("\"0\" =>
 * enabled"), so nothing would have caught it. A kill switch whose documented
 * OFF value means ON is worse than no kill switch: it is a false sense of one.
 *
 * ── WHY IT IS NOW ONE EXACT STRING (E2E-P1.3 (a)) ─────────────────────────
 * D1-PREP replaced the defect with a trimmed, case-folded ON-list of `['1',
 * 'true']`. That fixed the default, but it widened the ON side, and Security
 * ratified the narrow form instead: GATE2-PRE-A5 "N-1.1 — ack" reads
 * `E2E_PAIRING_ENABLED === '1'` enables NEW encrypted pairings, anything else
 * refuses them — "an allow-list on one exact string, fail-closed on
 * absent/typo/`'true'`". `'true'` is named there as a value that must FAIL
 * CLOSED, so the ON-list contradicted the ruling it was written to satisfy.
 *
 * So: exactly `'1'`. Unset, "", "0", "false", "no", "true", "TRUE", " 1 " and
 * every typo leave it OFF. The asymmetry is the whole point — the failure mode
 * of an unrecognised value must be "the feature stayed dark", never "the
 * feature went live" — and a single literal is the only predicate with no
 * second value to reason about at 3am. The padding case is deliberate too:
 * if a Coolify env value ever arrives as " 1 " the feature stays dark and the
 * boot log says so, which is the safe way to be wrong.
 *
 * READ TIMING: read ONCE at module load (boot), not per request. Flipping the
 * env var therefore takes a relay restart, not merely a request — D1-PLAN §2
 * step 6's flip is an env change plus a restart, and the boot log below is the
 * confirmation that the new value took. Per-request reads were NOT introduced
 * here: a switch whose state can change between the validation and the gate
 * inside one handler is harder to reason about than one that cannot.
 *
 * Refs: E2E-PLAN N-1; GATE2-PRE-A5 N-1.1 ack; FIRE "E2E P1.3 / the D1-FINAL
 * lane" (2026-09-18), which narrows D1-PREP's 612837a to the ratified form.
 *
 * What it does NOT do, deliberately (B6): it never strips an e2e block, and it
 * never forwards a MODIFIED one. A relay that quietly removed key material
 * would be indistinguishable on the wire from an attacker doing the same thing,
 * which would make the downgrade attack the SAS exists to catch into a
 * first-party feature. So a mode=1 request is REFUSED OUTRIGHT — the browser is
 * told, in as many words, that encrypted pairing is unavailable, and the user
 * decides what to do about it.
 *
 * mode=0 requests are forwarded with their block INTACT. mode=0 means "seal if
 * you can, but do not block on the SAS", so the phone may still encrypt; only
 * the mode that would hold a pairing hostage to a verification step is refused.
 *
 * Live pairs are untouched: this gates the handshake, not the data plane.
 * Flipping it mid-incident must not drop anyone who is already connected.
 */
const E2E_PAIRING_ENABLED = process.env.E2E_PAIRING_ENABLED === '1';
// Say which way the switch is set, once, at boot. D1-PLAN §2 step 5 verifies
// the deploy by reading this line out of the relay log — a switch whose state
// you cannot observe from outside the process is not operable during an
// incident, which is the one moment it exists for. The OFF line names the
// PREDICATE rather than echoing the value, because the interesting fact during
// an incident is "it is not the one string that turns this on", and echoing an
// arbitrary env value into a log line invites someone to read a typo as a mode.
console.log(
  E2E_PAIRING_ENABLED
    ? "[e2e] encrypted pairing ENABLED (E2E_PAIRING_ENABLED === '1')"
    : "[e2e] encrypted pairing DISABLED (E2E_PAIRING_ENABLED != '1')",
);

// One Prisma client for the whole relay process. server.js is a long-lived
// custom server (not Next.js runtime), so it can't import the TS singleton from
// lib/db.ts directly — instantiating here is fine because we never hot-reload
// this file. Connection pool is per-process so a single client is enough.
const db = new PrismaClient({ log: dev ? ['error'] : [] });

// Verbose relay logging — off by default to avoid blocking the Node.js event
// loop with synchronous console.log on every WS event. Set RELAY_VERBOSE=1
// in env to re-enable for debugging.
const RELAY_VERBOSE = process.env.RELAY_VERBOSE === '1';
const rlog = (...args) => { if (RELAY_VERBOSE) console.log(...args); };

// Temporary duplicate-notification diagnostic (2026-06-18). When
// DEBUG_NOTIF_RELAY=1 we log every PHONE_NOTIFICATION frame the relay
// forwards, tagged with direction + a short payload hash, so a live session
// reveals whether the relay receives/forwards ONE frame or TWO per logical
// message (splits "Android double-emits" from "web double-renders"). Default
// OFF — a no-op (single cheap prefix check) when the env flag is unset, so
// zero overhead in prod. Removable in one commit; see fix/notification-dedup.
const DEBUG_NOTIF_RELAY = process.env.DEBUG_NOTIF_RELAY === '1';
function logNotifFrame(token, direction, msg) {
  if (!DEBUG_NOTIF_RELAY) return;
  // Only PHONE_NOTIFICATION frames — string prefix check is cheap and avoids
  // parsing every data frame.
  if (typeof msg !== 'string' || !msg.startsWith('PHONE_NOTIFICATION:')) return;
  // Short FNV-1a hash of the JSON payload — enough to tell two frames apart
  // (same hash = byte-identical frame; different hash = distinct sbn.key/text)
  // without logging notification CONTENT (PII: 2FA codes, message bodies).
  const payload = msg.slice('PHONE_NOTIFICATION:'.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hash = (h >>> 0).toString(16).padStart(8, '0');
  console.log(`[NotifDiag][${redactToken(token)}] ${direction} PHONE_NOTIFICATION hash=${hash} len=${payload.length}`);
}

// ---------------------------------------------------------------------------
// REMOVED in P1(d): the always-on per-frame notification logger and its hash
// helper (logNotifLifecycle / shortHash).
//
// It printed package name, hasReply, replyKeySet, a hashed notification key and
// a reply TEXT LENGTH. It never printed a title, a body or a sender, and it was
// written carefully. It is still gone, for two reasons that only P1 makes
// decisive:
//
//   1. Under Encrypted mode the relay CANNOT parse these frames — the body is
//      sealed — so every line it emitted would become a parse failure or, worse,
//      a reason for someone to reach for the plaintext before it was sealed. A
//      logger that only works when the encryption is off is a standing argument
//      for turning the encryption off.
//   2. Its remaining output was metadata about individual notifications on a
//      user's phone, kept in container logs reachable from the Coolify panel.
//      A reply length alone separates a six-digit OTP from a sentence. The
//      product promise is that we cannot read these; keeping a per-notification
//      log of them is in tension with that regardless of which fields it omits.
//
// logNotifFrame (DEBUG_NOTIF_RELAY, off in prod, hash + byte length only) is
// deliberately KEPT: it is opt-in, it does not parse the payload, and it answers
// "did this frame arrive at all" — which stays necessary, and stays answerable,
// when the body is opaque.
//
// Do not reintroduce a payload-parsing logger on the relay data plane.
// tests/log-redaction.test.mjs asserts its absence.
// ---------------------------------------------------------------------------


// Pairing-request TTL. The browser sends BROWSER_REQUEST_PAIRING and the
// phone has this many ms to ACCEPT or DECLINE before we auto-cancel.
// 30 s mirrors the existing 35 s defensive timeout previously used in the
// webapp for the old accept-on-connect flow, with 5 s slack for the
// browser-side fallback timer.
const PAIRING_TTL_MS = 30_000;

// Auto-resume window (Issue 3, 2026-06-11). When an ACTIVE pair dies because
// a socket dropped (reason 'socket_closed' — connection blip, NOT a user
// clicking Disconnect), the relay remembers the broken pair for this long.
// If the dropped side reconnects within the window while its counterpart is
// still around, the relay silently re-links them — no browser Connect click,
// no phone Accept tap.
//
// History of this value:
//   • 120 s originally (Issue 3, 2026-06-11).
//   • Tightened 120 s → 30 s (2026-07-16, Dennis-approved) to drop a
//     genuinely-gone peer to the lobby fast rather than hold the browser.
//   • REVERSED 30 s → 180 s (2026-08-25, Dennis-approved). Reason: on
//     OPPO/ColorOS the aggressive app-freeze (background-kill) can delay the
//     phone's own dead-socket detector by ~4 min, so the phone often wakes and
//     tries to reconnect LONG after 30 s. With a 30 s window the relay had
//     already torn the pair down, forcing a full re-pair (browser Connect +
//     phone Accept). A 180 s window lets a late-waking phone (WiFi blip,
//     ColorOS/OPPO freeze, screen-off doze) resume the SAME session silently.
//     Accepted tradeoff: for a phone that is TRULY gone, the surviving browser
//     shows "reconnecting" (soft-hold, PEER_RECONNECTING) for up to 180 s
//     before dropping to the lobby — acceptable per Dennis.
// Security: resume is scoped to the same room token (the shared secret both
// sides already authenticated with), is only armed by a non-user-initiated
// close, and expires — no new attack surface beyond what a normal
// Connect+Accept inside the same room already grants. The longer window does
// not widen this surface; it only lengthens the same token-scoped hold.
const RESUME_WINDOW_MS = 180_000;

// Panel-close hold (FORGE-L, 2026-09-15). Dennis: "i would like the phone
// pairing to be kept for the same amount of time like in the official webapp.
// Not just 3 minutes."
//
// The web app stays paired for as long as its TAB is open, because that tab
// holds the interactive browser socket. In the Chrome extension the
// interactive socket lives inside the side-panel iframe, so closing the panel
// kills it and the pair had only RESUME_WINDOW_MS (180 s) to live. But the
// extension ALSO keeps a `?role=listener` socket owned by the MV3 service
// worker, and that worker is the extension's equivalent of the web app's open
// tab: it is what still receives calls/SMS while the panel is shut. Since
// FORGE-J the relay pushes a 15 s HB text frame to every listener, which keeps
// that worker alive and makes its presence a trustworthy liveness signal.
//
// So: while the dropped side is the BROWSER and a live listener is still in
// the room, the keepalive tick RENEWS the resume claim instead of letting it
// lapse — the pair is held for as long as the extension is there, exactly like
// the web tab. Only when the listener has been ABSENT continuously for
// LISTENER_HOLD_GRACE_MS does the claim fall back to normal expiry and the
// pair is released to the lobby.
//
// Why 10 minutes and not zero: an MV3 worker can still be evicted and replaced
// (measured under FORGE-J: a 33.8 s socket-less gap between boots, and up to
// ~64 s before a replacement worker connected). The grace must comfortably
// exceed the worst observed eviction gap so a routine worker respawn never
// costs the user their pairing, while a genuinely closed browser still drops
// within a bounded, human-sensible time.
//
// Deliberately NOT applied when the PHONE is the dropped side — a missing
// handset is a real absence and keeps the existing 180 s behaviour. And it
// changes nothing about explicit teardown: LEAVE_ACTIVE, RESET_ROOM, sign-out
// and phone-initiated leaves all run the non-soft-hold path, which clears the
// claim outright.
const LISTENER_HOLD_GRACE_MS = 10 * 60_000;

// Fix 2 (2026-07-16): hard cap on the per-room replay buffer. While a resume
// claim is armed (a socket blip, up to RESUME_WINDOW_MS), phone data-plane
// frames that would otherwise drop from the lobby are buffered and replayed on
// soft-hold resume. Bounded to protect memory — drop-oldest on overflow, so the
// buffer never exceeds FRAME_BUFFER_MAX entries regardless of how long the
// resume window is (memory bound is entry-count, not time).
const FRAME_BUFFER_MAX = 200;

// ── FILE TRANSFER (dispatch FT-1, 2026-09-18) ───────────────────────────────
//
// Spec: ken/PROJECTS/computercaller/FILE-TRANSFER-SPEC.md + Addendum A DECIDED
// (Dennis 2026-09-17 17:31: "Lets limit it to 1gb max size per file with a 2gb
// daily limit. The trial period will not allow transfers.").
//
// The relay is an OPAQUE FORWARDER. It never parses `data`, never buffers a
// byte of file content, and keeps at most ONE small metadata record per room.
// Everything below is either routing, a state check, or an abuse gate.
//
// The FROZEN frame family. FT-2 (android) and FT-3 (clients) build against this
// exact set in parallel — do not add, rename or reshape a member without a
// cross-lane amendment. Note the dispatch brief names FILE_REJECT where the
// original spec §2 said FILE_DECLINE; the brief's spelling is the one three
// lanes are building to, so FILE_REJECT is the wire name and FILE_DECLINE does
// not exist.
const FT_FRAME_TYPES = new Set([
  'FILE_OFFER',   // {id,name,size,mime,sha256,from}  sender → receiver
  'FILE_ACCEPT',  // {id}                             receiver → sender
  'FILE_REJECT',  // {id,reason}                      receiver → sender ONLY (FT-A1.1 M5: the relay mints none)
  'FILE_CHUNK',   // {id,seq,n,data}                  sender → receiver
  'FILE_ACK',     // {id,upTo}                        receiver → sender
  'FILE_RESUME',  // {id,upTo}                        receiver → sender (post-reconnect)
  'FILE_DONE',    // {id,sha256}                      sender → receiver
  'FILE_FAILED',  // {id,reason}                      either direction, terminal
]);

/**
 * The FROZEN `FILE_FAILED.reason` vocabulary. A reason outside this set is a
 * protocol violation: the relay refuses to MINT one, and normalises an inbound
 * unknown reason to 'cancelled' rather than forwarding an arbitrary string that
 * a client will switch on. FT-A1.1 section 2.2 splits this further: see
 * FT_RELAY_OWNED_REASONS for the subset the relay itself may author.
 * `FILE_REJECT.reason` is deliberately NOT frozen here
 * — it is receiver-authored UX ('user_declined', 'panel_closed', …) and, as of
 * FT-A1.1 M5, nothing else: 'busy' moved to the relay-minted FILE_FAILED path.
 */
const FT_FAIL_REASONS = new Set([
  'hash_mismatch', 'connection_lost', 'relay_backpressure', 'cancelled',
  'timeout', 'too_large', 'oom', 'quota', 'tier',
  // FT-A1 MUST A-7 (Security, 2026-09-18). A tamper/lie signal that the enum
  // had no word for. Reusing `cancelled` would label it user action and
  // `hash_mismatch` would label it corruption; both hide the one event the
  // control exists to surface. FT-1 owns the enum, FT-3a/3b carry the copy, and
  // this MUST land before FT-2 seals FILE_OFFER — otherwise every mismatch is
  // dropped by the receiver's own validator and presents as a 30 s hang.
  'size_mismatch',
  // FT-A1.1 MUST A1.1-M5. `busy` used to be minted as FILE_REJECT — which is
  // sealed-by-exclusion under mode ON, so a plaintext one is dropped by the
  // receiver's downgrade guard and "another transfer is already running" was
  // invisible the moment encryption went on, no matter how the origin question
  // was ruled. It is a relay-minted refusal like every other, so it lives here.
  'busy',
]);

/**
 * The EXHAUSTIVE, frozen set of reasons the RELAY may author (FT-A1.1 section 2.2).
 *
 * Everything else — hash_mismatch, cancelled, oom — is peer-owned and must stay
 * sealed under mode ON; a plaintext one is the receiver's to drop.
 *
 * This set is what `relay:true` is allowed to be stamped on. Keeping it separate
 * from FT_FAIL_REASONS is the point: the mark asserts WHO wrote the frame, so a
 * reason only a peer can legitimately give must never carry it, even by accident
 * through the normalise-to-`cancelled` fallback.
 *
 * `connection_lost` is in the subset (it is already relay-authored today: no
 * peer socket at FILE_OFFER, no sender at FILE_RESUME). `bad_hint` is NOT —
 * M1 keeps it a counter and off the wire entirely.
 */
const FT_RELAY_OWNED_REASONS = new Set([
  'tier', 'quota', 'too_large', 'size_mismatch', 'busy',
  'relay_backpressure', 'timeout', 'connection_lost',
]);

/**
 * FT-A1.1 MUST A1.1-M12. The base64 FLOOR, 4/3, used to invert the meter into
 * raw bytes for the CHARGE — and deliberately NOT the same constant as
 * FT_WIRE_OVERHEAD_FACTOR.
 *
 * The two conversions have OPPOSITE correct directions of error and must never
 * share a number. The CEILING errs generous (1.40 plus a whole chunk): a false
 * abort has no attacker behind it and costs a real user their transfer, and a
 * control that fires on honest traffic is a control someone switches off. The
 * CHARGE errs conservative: under-billing favours the one party with a motive to
 * lie about size.
 *
 * Sharing 1.40 for both meant an honest transfer (true ratio about 1.34) was
 * charged roughly 0.96x of what it actually moved — a silent ~4.3 % discount on
 * the abuse control itself, which would have grown with any future raise to the
 * ceiling factor.
 */
const FT_WIRE_B64_FACTOR = 4 / 3;

/** 1 GiB hard per-file cap (Addendum A DECIDED). Checked at FILE_OFFER. */
const FT_MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1_073_741_824

/**
 * 2 GiB per account per UTC CALENDAR day (Addendum A DECIDED) — not a rolling
 * window. Charged to the SENDER at FILE_OFFER, committed at FILE_DONE, released
 * at FILE_FAILED. See the FileQuota model for why the column is BigInt: this
 * constant is exactly int4 max + 1.
 */
const FT_DAILY_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2_147_483_648

/** Rows this old are pruned by the FileQuota janitor. Nothing reads them. */
const FT_QUOTA_RETENTION_DAYS = 7;

/**
 * 48 KiB of RAW file bytes per chunk → 65 536 chars of base64 → ~65.7 KB on the
 * wire with the JSON envelope. The relay does not enforce this (it never parses
 * `data`); it is asserted in tests/ft-relay.test.mjs against the REAL relay
 * maxPayload so a future chunk-size bump cannot silently start closing sockets.
 */
const FT_CHUNK_RAW_BYTES = 48 * 1024; // 49_152

/**
 * The wire size of ONE full chunk, with generous headroom: base64 of the raw
 * bytes, plus the JSON envelope, plus room for the E2E seal (nonce + tag +
 * base64 expansion of the ciphertext + the `{e,kid,s}` header).
 *
 * This is the FLOOR of the declared-size ceiling below, and that is not a
 * nicety. `bytesForwarded > size * 1.40` alone is wrong for small files: a
 * 10-byte text file declares size=10, so the ceiling is 14 bytes, and the very
 * first chunk — which carries a ~70-byte JSON envelope before a single payload
 * character — trips it. Every file under about 200 bytes would have aborted as
 * `too_large`, which is the opposite of what the rule is for.
 */
const FT_CHUNK_WIRE_BYTES = 4 * Math.ceil((FT_CHUNK_RAW_BYTES + 28) / 3) + 1024;

/**
 * Relay-side watermark. If the DESTINATION socket has more than this queued,
 * the transfer is aborted with `relay_backpressure` — the relay does NOT buffer.
 * A relay that queues is a relay that stores, which is the one thing this
 * feature is not allowed to become.
 */
const FT_DEST_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

/** Chunk/ACK stall backstop (spec §2). 30 s of silence mid-transfer aborts. */
const FT_STALL_MS = 30_000;

/**
 * Relay-side offer expiry. The sender's own expiry is 60 s (spec §2); the relay
 * holds its slot 30 s longer so a dead peer cannot leak the one-per-room slot,
 * and so the relay is never the side that times out a live negotiation first.
 */
const FT_OFFER_TTL_MS = 90_000;

/** How often the transfer janitor sweeps for stalls and orphaned records. */
const FT_SWEEP_MS = 5_000;

/**
 * Declared-size enforcement (spec §2 rule 2): forwarded wire bytes may exceed
 * the declared RAW size by at most this factor (base64 is +33 %, the JSON
 * envelope and any E2E seal the rest). A sender cannot declare 1 MB and push
 * 200 MB.
 */
const FT_WIRE_OVERHEAD_FACTOR = 1.40;

/**
 * Tiers entitled to file transfer. An ALLOW-list, not a deny-list, so an
 * unknown or future tier fails CLOSED rather than inheriting the feature.
 * Addendum A DECIDED: "The trial period will not allow transfers" / "Subscribed
 * (Plus/Pro) only" — so 'trial' and 'free' are out. 'solo' is in: it is the
 * grandfathered-legacy PAYING tier, and refusing a paying subscriber a feature
 * Dennis scoped as "subscribed only" would be the wrong reading of the decision.
 */
const FT_TIERS_ALLOWED = new Set(['solo', 'plus', 'pro']);

/** True for any frame in the frozen FILE_* family. Uses the validated classifier. */
function isFileFrame(msg) {
  return FT_FRAME_TYPES.has(frameType(msg));
}

// ── BATTERY telemetry (BAT-2 (a); GATE1 Addendum BAT-A1) ────────────────────
//
// `BATTERY:{"pct":<int 0..100>,"charging":<bool>,"ts":<epoch ms>}` — phone ->
// browsers only, PLAINTEXT (§13.7 presence/status family). The relay does NOT
// own this frame: it is forwarded byte-for-byte down the existing phone data
// plane, exactly like AUDIO_STATUS. The three things below are the only relay
// behaviours, and each is a Security MUST, not a convenience:
//
//   MUST-1  origin. A BATTERY frame is accepted ONLY from the paired phone
//           socket of this room. A browser-originated one, or one from a socket
//           that is not this room's phone, is dropped and counted
//           (`battery_bad_origin`). Without this the "display-only phone
//           telemetry" claim is false: any browser tab in the room could mint
//           a battery reading into the other browsers.
//   MUST-2  no relay-minted BATTERY. A frame carrying a top-level `relay` key
//           is REJECTED and counted (`battery_relay_mark`) — never stripped.
//           This mirrors §13.7.2 M6/M7 exactly: stripping would make a FORGED
//           mark indistinguishable from an absent one, which is the entire
//           property the mark exists to carry. The relay never authors a
//           BATTERY frame, so there is no legitimate marked variant.
//   MUST-3  shape. pct is an integer 0..100, charging is a strict boolean, ts
//           is a finite number. Anything else -> `battery_bad_shape`. Unknown
//           EXTRA keys are tolerated and forwarded untouched (the wire form is
//           frozen, but a forwarder that rejects on unknown fields is a
//           forward-compatibility trap); `relay` is the one named exception.
//
// Plus one defensive, non-security cap: at most one BATTERY per room per
// BATTERY_MIN_INTERVAL_MS. The phone's own policy is >=60 s between frames
// (charging flips bypass it), so 10 s is a wide floor that only fires on a
// misbehaving or hostile phone build. A dropped frame is COUNTED AND LOGGED
// ONLY — the relay never sends a frame back to the phone in response, because
// a battery reading is not worth a control-plane round trip and a back-frame
// would be a new phone-directed message type nobody has specified.
//
// NOTE ON PARSING. "Add no parser" (PLAN.md) means: do not re-serialise, do not
// rewrite, do not forward a reconstructed frame. We must still READ the payload
// to enforce MUST-2 and MUST-3. What is forwarded is always the ORIGINAL `msg`
// string; `batteryGate` returns a verdict and mutates nothing but the rate-cap
// stamp and the counters.
const BATTERY_MIN_INTERVAL_MS = 10_000;
const batteryDropCounts = new Map(); // token -> Map(reason -> count)

/** True for the BATTERY frame. Uses the validated classifier, never startsWith. */
function isBatteryFrame(msg) {
  return frameType(msg) === 'BATTERY';
}

/** Count a dropped BATTERY frame by reason. Returns the new per-room count. */
function batteryCountDrop(token, reason) {
  let perRoom = batteryDropCounts.get(token);
  if (!perRoom) { perRoom = new Map(); batteryDropCounts.set(token, perRoom); }
  const n = (perRoom.get(reason) ?? 0) + 1;
  perRoom.set(reason, n);
  return n;
}

/**
 * Decide whether a BATTERY frame must be DROPPED by the relay.
 *
 * @returns {boolean} true  -> drop it here (counted + logged); the caller returns.
 *                    false -> let the ORIGINAL msg continue down the normal
 *                             phone data plane, forwarded verbatim.
 */
function batteryGate(room, ws, msg, role, token) {
  const drop = (reason) => {
    const n = batteryCountDrop(token, reason);
    rlog(`[Relay][${redactToken(token)}] BATTERY dropped (${reason}, n=${n}): ${frameLabel(msg)}`);
    return true;
  };

  // MUST-1 — origin. `role` is the branch the frame arrived on; `phoneToken`
  // is set on a socket only when it authenticated as THIS room's phone, so the
  // two together exclude a browser socket and a phone socket belonging to some
  // other room that somehow reached this handler.
  if (role !== 'phone' || ws.phoneToken !== room.token) return drop('battery_bad_origin');

  let payload;
  try { payload = JSON.parse(msg.slice(msg.indexOf(':') + 1)); } catch { return drop('battery_bad_shape'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return drop('battery_bad_shape');

  // MUST-2 — rejected, never stripped. hasOwnProperty, not `in`: a payload that
  // merely inherits `relay` from Object.prototype is not a marked frame, and
  // `payload.relay !== undefined` would miss an explicit `{"relay":null}`.
  if (Object.prototype.hasOwnProperty.call(payload, 'relay')) return drop('battery_relay_mark');

  // MUST-3 — shape.
  if (!Number.isInteger(payload.pct) || payload.pct < 0 || payload.pct > 100) return drop('battery_bad_shape');
  if (payload.charging !== true && payload.charging !== false) return drop('battery_bad_shape');
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return drop('battery_bad_shape');

  // Rate cap — per room, not per socket: a phone that reconnects with a fresh
  // socket must not get a fresh budget.
  const at = Date.now();
  if (room.batteryLastAt != null && at - room.batteryLastAt < BATTERY_MIN_INTERVAL_MS) {
    return drop('battery_ratelimited');
  }
  room.batteryLastAt = at;
  return false;
}

/**
 * Relay state machine — Connect+Accept lobby model (dispatch #32, 2026-05-25).
 *
 * Replaces the prior auto-pair model where both sides joined a single room
 * and the relay forwarded data the instant a phone WS appeared. That model
 * caused race conditions on reload (new browser/phone collided with the prior
 * pair), reconnect loops, and shipped no explicit consent gate — both sides
 * found themselves in an active session without ever opting in.
 *
 * New model — every connected socket is in one of two slots per Room:
 *
 *   room.lobby                — Set<WS> of every socket NOT in an active pair.
 *                               Both browsers and phones land here on connect.
 *   room.active               — { browser: WS|null, phone: WS|null }
 *                               At most ONE browser ↔ ONE phone, both consented.
 *                               Data-plane forwarding ONLY happens between
 *                               active.browser and active.phone.
 *   room.pendingPairing       — { id, browserWs, ua, ip, expiresAt, timer } | null
 *                               A pairing request in flight. Browser asked,
 *                               phone has not yet answered. 30 s TTL.
 *   room.frameBuffer          — [{ msg, at }] bounded replay buffer. Phone
 *                               data-plane frames captured while a resume
 *                               claim is armed (a blip, up to RESUME_WINDOW_MS), replayed to
 *                               the browser on soft-hold resume (Fix 2). A new
 *                               pair forms ONLY via explicit Connect + Accept.
 *
 * Wire protocol — control plane:
 *
 *   Browser → Relay:
 *     BROWSER_REQUEST_PAIRING:{ua, ip}     start a pairing handshake
 *     ACCEPT_PAIRING / DECLINE_PAIRING     (NEVER sent by browser; phone-only)
 *     LEAVE_ACTIVE:{}                      explicit teardown of an active pair
 *
 *   Phone → Relay:
 *     ACCEPT_PAIRING:{pairingId}           confirm the pending request
 *     DECLINE_PAIRING:{pairingId}          reject the pending request
 *
 *   Relay → Browser:
 *     LOBBY_STATUS:{phonePresent, alreadyActive}   sent on lobby join
 *     PHONE_PRESENT:{}                              a phone just joined the lobby
 *     PHONE_ABSENT:{}                               the only phone left the lobby
 *     PAIRING_ACTIVE:{deviceName}                   request was accepted, you're active
 *     PAIRING_DECLINED:{}                           phone said no, back to lobby
 *     PAIRING_TIMEOUT:{}                            30 s elapsed, no answer
 *     PAIRING_REJECTED:{reason}                     relay said no (already_active, …)
 *     PAIRING_TERMINATED:{reason}                   active pair torn down (peer left,
 *                                                   socket closed, etc.)
 *
 *   Relay → Phone:
 *     LOBBY_STATUS:{browserCount}                   sent on lobby join
 *     PAIRING_REQUEST:{pairingId, ua, ip}           browser is asking — show prompt
 *     PAIRING_ACTIVE:{ua, ip}                       relay confirmed the pair
 *     PAIRING_CANCELLED:{pairingId}                 30 s expiry before phone answered
 *     PAIRING_TERMINATED:{reason}                   active pair torn down
 *
 * Data plane: every non-control frame from an active.browser is forwarded to
 * its active.phone, and vice-versa. Frames originating from any lobby socket
 * are DROPPED + logged — pre-consent sockets have no data-plane privileges.
 *
 * Browser disconnects send DISCONNECT_PHONE-equivalent: nothing. The ws 'close'
 * handler does the teardown. Page reloads land in the lobby fresh and must
 * click Connect to re-arm a pairing — there is no implicit reconnect.
 */

function startRelay(httpServer) {
  // noServer mode: we handle the HTTP `upgrade` event ourselves below and
  // gate by URL path. This lets us mount the relay at /relay on the SAME
  // httpServer Next.js uses — no separate port to expose through Coolify,
  // no cross-origin LAN-IP gymnastics, single WSS endpoint over :443 in prod.
  // FORGE-V (2026-09-17) — explicit inbound frame cap.
  //
  // Without `maxPayload` ws@8.21 falls back to its 100 MiB default, so a peer
  // that survives the auth gate could push 100 MiB frames that we materialise
  // via `data.toString()` (and run through frame redaction/logging) BEFORE any
  // tier or role gate looks at them. That is a free memory + CPU amplifier on
  // the relay for every authenticated socket.
  //
  // Measured largest LEGITIMATE frame today:
  //   MMS_MEDIA_CHUNK — 65536 base64 chars per slice + a ~200 B envelope
  //     (dnkdialer-android/app/src/main/java/com/dnkdialer/companion/
  //      PhoneService.kt:3988 `val chunkSize = 65536`)
  //   Everything else is smaller and page-bounded: CONTACTS_CHUNK 50/page
  //     (PhoneService.kt:3886), MESSAGES_CHUNK 25/page (:3948),
  //     CALL_LOGS_CHUNK 25/page (:3911) — all via sendChunked (:3611).
  //
  // 1 MiB = ~16x the largest real frame. Generous headroom for a future page
  // size bump or an unusually fat 25-row message page, while cutting the
  // worst-case single-frame allocation by 100x. Over-cap frames are rejected
  // by the ws receiver itself, before any application code touches the bytes:
  // ws emits 'error' (RangeError) and closes the socket with 1009.
  const RELAY_MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB
  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD_BYTES });

  /**
   * FORGE-V — one redacted line when a socket dies because it sent a frame
   * over RELAY_MAX_PAYLOAD_BYTES.
   *
   * NOTE the signal is the 'error' event, NOT close code 1009. We are the
   * RECEIVER: ws raises a RangeError on our receiver, *sends* a 1009 close
   * frame and tears the socket down without waiting for the echo — so the
   * offender sees 1009, but our own 'close' event fires with 1006 (no close
   * frame received). Gating this on `ws.closeCode === 1009` would never fire.
   * Verified against ws@8.21 in tests/ws-maxpayload.test.mjs (PART 1).
   *
   * The offending bytes are discarded by the receiver and never reach
   * application code, so there is nothing to leak here and nothing is logged
   * beyond role + redacted room. Called from the existing 'close' handlers on
   * both peer paths.
   */
  function logIfOverMaxPayload(ws, token) {
    if (!ws.overMaxPayload) return;
    console.log(`[Relay] frame over maxPayload from role=${ws.role || 'unknown'} room=${redactToken(token)}`);
  }

  // token -> Room
  const rooms = new Map();

  // F-A (2026-05-29) — single-active-session WEB enforcement.
  //
  // Index of every CURRENTLY-OPEN web browser WS, keyed by userId, used by
  // `supersedeWebSessions(userId)` to kick a stale browser the instant a new
  // login for the same userId bumps sessionVersion. We populate this index
  // ONLY for connections where authVia === 'relay-ticket' — i.e. browsers.
  // Phone APK sockets (legacy-token / legacy-token-bearer) are NEVER added
  // and NEVER kicked. apk-login deliberately does not bump sessionVersion,
  // so the phone bearer remains valid through any web login storm.
  //
  // Cardinality: typically <=1 ws per user (we kick prior ones), occasionally
  // 2 transiently during the kick (old browser still closing while new one
  // connects). A Set per user is overkill capacity but cheap and race-safe.
  //
  // Cross-process: the Next.js Route Handlers (e.g. /api/auth/login) need to
  // call into this map after the sessionVersion increment. They run in the
  // SAME Node process as this custom server, so we expose the kick function
  // via globalThis. This is the documented pattern for custom Next.js
  // servers; no IPC, no message bus, single-process atomic.
  const userIdToWebSockets = new Map();

  function indexWebSocket(userId, ws) {
    if (!userId || !ws) return;
    let set = userIdToWebSockets.get(userId);
    if (!set) {
      set = new Set();
      userIdToWebSockets.set(userId, set);
    }
    set.add(ws);
  }
  function unindexWebSocket(userId, ws) {
    if (!userId) return;
    const set = userIdToWebSockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) userIdToWebSockets.delete(userId);
  }

  /**
   * Kick every open WEB browser WS for the given userId. Sends the contract
   * frame FIRST (so the client has a reason even if the close race is lost),
   * then closes with WS code 4001 reason 'session_superseded'. Phone sockets
   * are NOT touched — they are not in this index. Idempotent: calling on a
   * userId with no open web sockets is a no-op.
   *
   * Wire contract (WIRE-CONTRACT.md §1):
   *   1. `SESSION_SUPERSEDED:{"reason":"signed_in_elsewhere"}`
   *   2. ws.close(4001, "session_superseded")
   */
  function supersedeWebSessions(userId) {
    const set = userIdToWebSockets.get(userId);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify({ reason: 'signed_in_elsewhere' });
    const frame = `SESSION_SUPERSEDED:${payload}`;
    let kicked = 0;
    // Snapshot to a list before iterating — close() triggers ws.on('close')
    // synchronously in some ws versions which mutates the Set under us.
    const snapshot = Array.from(set);
    for (const ws of snapshot) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          safeSend(ws, frame);
        }
        // Allow a tick for the frame to flush, then close. ws.close() on an
        // already-closing socket is a no-op, safe.
        try { ws.close(4001, 'session_superseded'); } catch (_) {}
        kicked += 1;
      } catch (err) {
        console.error(`[Relay] supersedeWebSessions: failed to kick ws for user=${userId}: ${err.message}`);
      }
    }
    console.log(`[Relay] supersedeWebSessions(${userId}) → kicked ${kicked} web socket(s)`);
    return kicked;
  }

  // Single-process global handle for the Route Handlers.
  // eslint-disable-next-line no-undef
  globalThis.__supersedeWebSessions = supersedeWebSessions;

  // ── Reset lobby (dispatch FORGE-J, 2026-09-15) ──────────────────────────────
  //
  // Per-user 1-per-5s limiter shared by BOTH entry points (WS frame and HTTP
  // route). Keying on userId rather than on the room token is deliberate: the
  // room is deleted by the reset itself, so a token-keyed limiter would forget
  // the previous reset the instant it succeeded and the limit would never bind.
  const resetRateLimiter = createResetRateLimiter();
  // Bound the limiter Map. 10 min matches the other janitors in this file and is
  // 120x the 5s window, so a sweep can never evict a live entry.
  const resetLimiterSweep = setInterval(() => resetRateLimiter.sweep(), 10 * 60 * 1000);
  if (typeof resetLimiterSweep.unref === 'function') resetLimiterSweep.unref();

  /**
   * Empty the room for `token` and drop every socket in it. The ONE place both
   * the RESET_ROOM frame and POST /api/relay/reset funnel through.
   *
   * @returns {{closed:number,phones:number,browsers:number,listeners:number}|null}
   *          null when there is no room for that token (already empty — which
   *          is a SUCCESS for the caller, not an error: the postcondition
   *          "this room is empty" already holds).
   */
  function doResetRoom(token, origin) {
    const room = rooms.get(token);
    if (!room) {
      console.log(`[Relay][${redactToken(token)}] resetRoom(${origin}): no room — already empty`);
      return null;
    }
    // FT-1 (d): RESET_ROOM drops the room object wholesale, which would take an
    // in-flight transfer record with it — and with it the sender's quota
    // RESERVATION, silently burning up to 1 GB of their daily allowance for a
    // transfer that never happened. Abort explicitly first so the refund runs.
    ftAbort(room, 'cancelled');
    ftDropCounts.delete(token);
    return resetRoomCore(
      room,
      {
        safeSend,
        // ws.close() is wrapped because a close on an already-CLOSING socket
        // throws in some ws versions; roomReset-core also try/catches per
        // socket, so a thrower can never abort the rest of the teardown.
        closeSocket: (ws, code, reason) => { try { ws.close(code, reason); } catch (_) {} },
        rooms,
        log: (m) => console.log(`[Relay][${redactToken(token)}] ${m}`),
      },
      origin,
    );
  }

  /**
   * Single-process global handle for POST /api/relay/reset. Same documented
   * pattern as __supersedeWebSessions above: the Next.js Route Handlers run in
   * THIS Node process, so they can call straight in — no IPC, no message bus.
   *
   * Takes a userId (what a session cookie proves) and resolves it to the room
   * key (phoneToken) here, so the route never has to touch the relay's keying
   * scheme. Rate-limited on the same limiter as the frame path, so a user
   * cannot get 2x the budget by alternating transports.
   *
   * @param {string} userId
   * @returns {Promise<{closed:number,rateLimited?:boolean,retryAfterMs?:number}|null>}
   */
  async function resetRelayRoomForUser(userId) {
    const gate = resetRateLimiter.check(userId);
    if (!gate.allowed) {
      return { closed: 0, rateLimited: true, retryAfterMs: gate.retryAfterMs };
    }
    let user;
    try {
      user = await db.user.findUnique({
        where: { id: userId },
        select: { phoneToken: true },
      });
    } catch (e) {
      console.error(`[Relay] resetRelayRoomForUser: DB lookup failed for ${userId}: ${e.message}`);
      throw e;
    }
    if (!user || !user.phoneToken) return null;
    const result = doResetRoom(user.phoneToken, 'http');
    // A missing room is not a failure — the caller asked for "empty", and empty
    // is what it is. Report zero closed rather than null so the route can always
    // answer 200.
    return result || { closed: 0, phones: 0, browsers: 0, listeners: 0 };
  }

  /**
   * Is a pairing HANDSHAKE mid-flight for this user? Published for
   * POST /api/devicekeys/register, which returns 409 when it is.
   *
   * Why registering mid-handshake is refused: the browser has already sent its
   * key set and the phone is about to compute a SAS over it. A key that lands
   * between those two moments changes the set under the user — the digits they
   * are being asked to compare would no longer describe the pairing they are
   * approving. Refusing for the ~30 s a handshake lasts costs nothing.
   *
   * An ACTIVE pair is deliberately NOT blocked. Its SK and its SAS were minted
   * at Accept over the keys that existed then; a new key does not retroactively
   * change them and only takes effect at the NEXT Accept. Blocking there would
   * mean a user with a live pair could never add a device.
   *
   * Same single-process globalThis pattern as __resetRelayRoom above: the
   * Next.js Route Handlers run in THIS Node process.
   */
  async function pairingInFlightForUser(userId) {
    let user;
    try {
      user = await db.user.findUnique({ where: { id: userId }, select: { phoneToken: true } });
    } catch (e) {
      // Fail OPEN on a DB error: this is a courtesy guard, not an authz check,
      // and it must never be the reason a user cannot register a device key.
      console.error(`[Relay] pairingInFlightForUser: lookup failed for ${userId}: ${e.message}`);
      return false;
    }
    if (!user || !user.phoneToken) return false;
    const room = rooms.get(user.phoneToken);
    return !!(room && room.pendingPairing);
  }

  globalThis.__relayPairingInFlight = pairingInFlightForUser;

  // eslint-disable-next-line no-undef
  globalThis.__resetRelayRoom = resetRelayRoomForUser;

  function getRoom(token) {
    let room = rooms.get(token);
    if (!room) {
      room = {
        token,
        lobby: new Set(),
        // P1(b) — the live pair's e2e block, or null. Declared here rather than
        // sprouting on first Accept so every reader can rely on the key
        // existing, and so the two places that REPLACE room.active wholesale
        // are visibly obliged to say what happens to it.
        active: { browser: null, phone: null, e2e: null },
        pendingPairing: null,
        frameBuffer: [],
        // FT-1: the single in-flight file-transfer record, or null. Declared
        // here rather than sprouting on first FILE_OFFER so every reader — the
        // janitor, the teardown paths, the handler — can rely on the key
        // existing, and so the places that drop a room are visibly obliged to
        // say what happens to it.
        transfer: null,
      };
      rooms.set(token, room);
    }
    return room;
  }

  /**
   * Drop empty rooms so the Map does not grow forever. A room is reapable
   * when nothing is in the lobby, no active pair exists, and no pending
   * pairing handshake is mid-flight.
   */
  function maybeReapRoom(room) {
    if (room.lobby.size > 0) return;
    if (room.active.browser || room.active.phone) return;
    if (room.pendingPairing) return;
    // Issue 3: keep the room alive while a resume claim is live so the
    // both-sides-dropped case can still auto-resume when they return.
    // Worst case the room lingers RESUME_WINDOW_MS past empty.
    if (room.resumable && Date.now() <= room.resumable.expiresAt) return;
    rooms.delete(room.token);
    ftDropCounts.delete(room.token); // FT-1: per-room drop counters die with the room
    console.log(`[Relay] Reaped empty room ${redactToken(room.token)}`);
  }

  function safeSend(ws, msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof msg === 'string' ? msg : msg.toString());
      return true;
    } catch (e) {
      console.log(`[Relay] safeSend failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Count phones / browsers in the LOBBY (excludes active sockets).
   * Used when sending LOBBY_STATUS so each side knows whether to render the
   * Connect affordance (browser side) / waiting copy (phone side).
   */
  function countLobby(room) {
    let phones = 0;
    let browsers = 0;
    for (const ws of room.lobby) {
      if (ws.role === 'phone') phones++;
      // forge/chrome-extension-p1: passive listeners (extension SW) are invisible
      // to the pairing UX — they are not an interactive browser peer, so they must
      // not inflate the browserCount the phone sees nor the "browser present"
      // signals that drive Connect-button copy.
      else if (ws.role === 'browser' && !ws.listener) browsers++;
    }
    return { phones, browsers };
  }

  /**
   * Count LIVE phones present in the room across BOTH the lobby and the
   * active slot — liveness-gated so stale / dead duplicate sockets (a
   * device that opened a second WS without the first's close firing yet)
   * don't keep "a phone is here" true after the real device is gone.
   *
   * Fix (2026-06-17): the lobby/active phonePresent signal used to read
   * `countLobby(room).phones > 0`, which (1) ignored an ACTIVE phone and
   * (2) counted lobby phone sockets regardless of readyState. Both made
   * the web Connect button stay blue after the last real phone departed.
   * This helper is the single source of truth for "does a usable phone
   * exist in this room right now" — only OPEN sockets count.
   *
   * A phone soft-held in `active` under a live resume claim IS counted as
   * present: the soft-hold's brief "phone away" window must NOT trigger a
   * false absence broadcast (confirmed 2026-06-16). Genuine absence is
   * "no OPEN phone socket anywhere", which only happens once the survivor
   * is truly gone or the resume window expires into a real teardown.
   */
  function countLivePhones(room) {
    let n = 0;
    for (const ws of room.lobby) {
      if (ws.role === 'phone' && ws.readyState === WebSocket.OPEN) n++;
    }
    if (room.active.phone && room.active.phone.readyState === WebSocket.OPEN) n++;
    return n;
  }

  /**
   * Broadcast PHONE_ABSENT to lobby browsers IFF the last real (live)
   * phone has actually departed — i.e. no OPEN phone socket remains in
   * either the lobby or the active slot. Idempotent: calling it while a
   * live phone still exists is a no-op, so every departure path can call
   * it unconditionally without first reasoning about the others.
   *
   * `excludeWs` lets a close handler ask the question as-of "after this
   * socket is gone" even if room.lobby.delete() / active clear hasn't been
   * observed yet by countLivePhones (defensive — the close handlers below
   * already delete/clear first, but excluding the departing socket makes
   * the call order-independent).
   */
  function broadcastPhoneAbsentIfLastPhoneGone(room, excludeWs) {
    let live = countLivePhones(room);
    if (excludeWs && excludeWs.role === 'phone' &&
        excludeWs.readyState === WebSocket.OPEN) {
      // The excluded socket is still OPEN but is on its way out (close in
      // progress / being torn down). Don't let it mask a genuine absence.
      const stillCountedElsewhere =
        room.active.phone === excludeWs || room.lobby.has(excludeWs);
      if (stillCountedElsewhere) live -= 1;
    }
    if (live <= 0) {
      broadcastToLobbyBrowsers(room, `PHONE_ABSENT:${JSON.stringify({})}`);
    }
    // FORGE-O: every phone departure path funnels through here, so this is the
    // one call that keeps the listener's `phonePresent` honest on the way OUT.
    // Unconditional, not inside the `live <= 0` branch: a phone leaving a room
    // that still has another phone changes nothing for PHONE_ABSENT but can
    // still change `paired` (it may have been the ACTIVE one).
    broadcastPairState(room);
  }

  /** Broadcast a message to every BROWSER currently sitting in the lobby. */
  function broadcastToLobbyBrowsers(room, msg) {
    for (const ws of room.lobby) {
      if (ws.role === 'browser') safeSend(ws, msg);
    }
  }

  /** Broadcast a message to every PHONE currently sitting in the lobby. */
  function broadcastToLobbyPhones(room, msg) {
    for (const ws of room.lobby) {
      if (ws.role === 'phone') safeSend(ws, msg);
    }
  }

  /**
   * Cancel and clear the pending pairing handshake. Does NOT notify either
   * side — callers are responsible for sending PAIRING_TIMEOUT /
   * PAIRING_DECLINED / etc. before invoking this. Safe to call when no
   * pending pairing exists.
   */
  function clearPendingPairing(room) {
    if (!room.pendingPairing) return;
    if (room.pendingPairing.timer) {
      clearTimeout(room.pendingPairing.timer);
    }
    room.pendingPairing = null;
  }

  /**
   * Tear down whatever active pair currently exists in the room. Both
   * sockets get moved back into the lobby (if still open) and each is sent
   * PAIRING_TERMINATED:{reason} so their UI can reset cleanly. Safe to
   * call when no pair is active.
   */
  function terminateActivePair(room, reason) {
    const { browser, phone } = room.active;
    if (!browser && !phone) return;
    // P1(b) — captured before either of the two wholesale reassignments below
    // can drop it. The e2e stash lives and dies with the RESUME CLAIM: a blip
    // that will silently re-form the same pair must re-send the same block
    // (same kid), and a deliberate teardown must not leave key material behind.
    // Tying it to `reason === 'socket_closed'` rather than a second rule of its
    // own means there is exactly one condition to get right, and it is already
    // the one that arms room.resumable a few lines down.
    const priorE2e = room.active.e2e ?? null;

    // Connection-stability fix (2026-06-16). socket_closed = a transient blip,
    // not a user leaving. By default we KEEP the surviving side in `active` and
    // soft-hold it (PEER_RECONNECTING) so it never drops to the lobby / wipes
    // its data while the dropped side reconnects. tryAutoResume re-slots the
    // returning socket. This eliminates the reconnect storm where every mobile
    // blip forced the browser back to lobby + a full re-sync. LEGACY_RESUME_
    // TEARDOWN=1 restores the old full-teardown path.
    if (reason === 'socket_closed' && !LEGACY_RESUME_TEARDOWN) {
      const phoneOpen = !!phone && phone.readyState === WebSocket.OPEN;
      const browserOpen = !!browser && browser.readyState === WebSocket.OPEN;
      // Exactly one side closed (its close handler called us). The OTHER side
      // is the survivor — keep it in active; drop only the closed slot.
      const droppedRole = !phoneOpen ? 'phone' : 'browser';
      // The pair is HELD, not gone — the surviving side keeps its session, so it
      // keeps its key material too. Dropping the block here would make every
      // panel close silently downgrade the next resume to plaintext.
      room.active = { browser: browserOpen ? browser : null, phone: phoneOpen ? phone : null, e2e: priorE2e };
      // FORGE-L — panel-close hold. Two ways this claim earns the extended,
      // listener-gated lifetime described at LISTENER_HOLD_GRACE_MS:
      //
      //   1. The BROWSER is the side that just went away while the extension's
      //      MV3 listener worker is still connected. That is the side-panel
      //      close: the user's extension is still there, so the pair should
      //      survive exactly as the web app's does with its tab open.
      //
      //   2. STICKY — a prior claim was already holding. Measured on the v55
      //      APK (PhoneService.kt:3134-3152): ANY phone socket drop (doze,
      //      Wi-Fi/cell handoff, java-websocket's 15 s ping timeout at :3184)
      //      clears isPairActive and redials the LOBBY only 5 s later
      //      (:3249-3255 — "a dropped active pair stays dropped"). Over a hold
      //      measured in minutes that is likely, not theoretical. It re-enters
      //      terminateActivePair with droppedRole='phone', and without this
      //      stickiness the panel hold would be silently downgraded to the
      //      plain 180 s window by the phone's own blip. The returning phone
      //      waits in the lobby and tryAutoResume re-forms the pair — sending
      //      it a fresh PAIRING_ACTIVE, which the APK accepts idempotently
      //      (PhoneService.kt:3657-3670, no already-paired guard).
      //
      // Note this only ever LENGTHENS how long a claim may be resumed. It does
      // not change WHO may resume it: tryAutoResume still requires a live
      // phone and a live interactive browser in the same token-scoped room.
      const prior = room.resumable;
      const panelHold =
        (droppedRole === 'browser' && hasLiveListener(room)) ||
        (!!prior && prior.panelHold === true);
      // FORGE-M (2026-09-16) — heldSince: when the SECOND side also drops
      // during a hold (measured on Dennis's machine: the v55 APK closes its
      // socket cleanly ~3 s after the panel's page_unload, every time), this
      // re-entry REPLACES the claim and `droppedAt` jumps forward to now.
      // Two things silently broke off that:
      //
      //   1. the frame-buffer replay cutoff is `claim.droppedAt` under a hold,
      //      so every frame buffered before the phone's blip — exactly the SMS
      //      the hold exists to preserve — was discarded on resume;
      //   2. nothing recorded that this is still the SAME pair, so the resume
      //      reported survivorHeld=false and the client re-ran a first-connect
      //      sync ("it takes it up once with need to do a full sync again").
      //
      // heldSince is the moment the CHAIN of drops began, carried across every
      // re-entry while the hold is live. It is the pair's continuity marker:
      // the buffer replays from it, and tryAutoResume reports the gap from it.
      const heldSince = (panelHold && prior && prior.heldSince) ? prior.heldSince : Date.now();
      room.resumable = {
        droppedRole,
        panelHold,
        heldSince,
        droppedAt: Date.now(),
        expiresAt: Date.now() + RESUME_WINDOW_MS,
        identity: room.pairIdentity ?? null,
        // FORGE-L: set by the keepalive tick the first time no live listener is
        // seen while this claim is browser-dropped. null = a listener is (or
        // was last seen) present. See LISTENER_HOLD_GRACE_MS.
        //
        // FORGE-M: carried across a re-entry for the same reason as heldSince —
        // a phone blip must not silently restart the listener-absence grace and
        // let a genuinely-closed browser hold the pair past it.
        listenerGoneAt: (panelHold && prior) ? (prior.listenerGoneAt ?? null) : null,
      };
      const survivor = phoneOpen ? phone : (browserOpen ? browser : null);
      // Dock fix (2026-09-15, forge/dock-reconnect-sw-badge).
      //
      // tryAutoResume ran at lobby-JOIN time and NOWHERE else, so it could
      // only ever see a counterpart that arrived AFTER the drop. The side
      // panel dock is the opposite order: shell.js opens the panel FIRST
      // (its iframe joins the lobby while the pop-out is still sitting in
      // room.active.browser, so the claim is not armed yet and the joiner
      // just gets LOBBY_STATUS) and only THEN asks the worker to close the
      // pop-out window — which arms the claim here with no join left to
      // re-trigger the resume. The pair stayed broken until the user
      // reconnected by hand. That is the "it drops the connection and I have
      // to sync again" Dennis reported.
      //
      // Re-checking at ARM time closes that ordering. The join-time call is
      // kept and still covers the reverse order (old socket dies first, new
      // surface joins after), so both orderings now resume.
      //
      // Deliberately gated on droppedRole === 'browser'. Every browser in a
      // room is the same user's own surface, so handing the pair from one to
      // another IS the dock. A dropped PHONE must not be able to hand the
      // pair to a different handset that merely happened to be waiting in the
      // lobby — that still requires the phone itself to rejoin, which is the
      // only thing that proves it is the same device coming back.
      if (droppedRole === 'browser' && tryAutoResume(room)) {
        console.log(`[Relay][${redactToken(room.token)}] socket_closed: browser handed off to a surface already waiting in the lobby (dock) — resumed with no re-sync`);
        return;
      }
      if (survivor) {
        // Non-destructive hold. The web hook treats this as "phone briefly
        // away" — it does NOT flip isConnected / wipe caches; its existing 30s
        // APP_PING stale window (>> the 5s Android lobby reconnect) covers the
        // gap. A client that doesn't know the frame simply ignores it. The
        // survivor stays in `active`, so its data plane is untouched.
        safeSend(survivor, `PEER_RECONNECTING:${JSON.stringify({ droppedRole, window: RESUME_WINDOW_MS })}`);
      }
      // The dropped socket is the one that is no longer OPEN; report ITS close
      // code, because that is what says whether this was a background-kill
      // (1006, no close frame) or a deliberate leave (1000/1001).
      const droppedWs = droppedRole === 'phone' ? phone : browser;
      const dc = droppedWs ? `code=${droppedWs.closeCode ?? '?'} reason="${droppedWs.closeReason ?? '?'}"` : 'code=? reason=?';
      // FORGE-L: panelHold is in this line deliberately — it is the single
      // field that says whether this pair will survive past 180 s, and it is
      // what a cc_debug trace of a panel close needs to show.
      const hold = panelHold ? `, panelHold=YES (renewed each tick while a listener is present; grace ${LISTENER_HOLD_GRACE_MS}ms)` : '';
      console.log(`[Relay][${redactToken(room.token)}] socket_closed: soft-hold survivor (droppedRole=${droppedRole}, ${dc}), resume window armed (${RESUME_WINDOW_MS}ms)${hold}`);
      // FORGE-O: active → held. This early return is the ONLY exit that leaves a
      // pair alive-but-unsendable, and it is the common one (every panel close
      // and every phone blip lands here). Without this the listener keeps a
      // green dot over a pair that cannot carry a single frame until a peer
      // returns — the same class of lie as the lobby-presence green.
      broadcastPairState(room);
      return;
    }

    console.log(`[Relay][${redactToken(room.token)}] terminateActivePair: ${reason}`);
    // Same single condition that arms room.resumable below: the block survives
    // exactly as long as the claim that will re-form this pair does. LEAVE_ACTIVE
    // ('user_left'), resume_expired and every other deliberate reason clear it.
    // Reset lobby / sign-out never reach here — roomReset-core replaces
    // room.active wholesale AND deletes the room, so the stash goes with it.
    room.active = { browser: null, phone: null, e2e: reason === 'socket_closed' ? priorE2e : null };
    // Fix 2: a genuine (non-soft-hold) teardown means the pair is gone — a
    // fresh Connect+Accept triggers the web quick-sync backfill, so any
    // buffered frames are moot. Drop them to bound memory.
    room.frameBuffer = [];
    // FT-1 (d): the transfer record survives a SOFT HOLD (the early return
    // above) so a blip mid-1-GB-transfer can be resumed — but a genuine
    // teardown is the end of it. PAIRING_TERMINATED reached the clients a few
    // lines up; refund the sender's quota reservation and drop the record so
    // the next pair starts with an empty slot. `notify:false` because the
    // sockets are being told PAIRING_TERMINATED already, and a FILE_FAILED
    // chasing it would arrive after the UI had reset.
    ftAbort(room, 'connection_lost', { notify: false });

    // Issue 3 (2026-06-11): arm the auto-resume window ONLY for connection
    // drops. A deliberate teardown ('user_left' — Disconnect button on either
    // side, or any other explicit reason) must NEVER silently re-link, so it
    // clears any prior claim instead.
    if (reason === 'socket_closed') {
      const phoneOpen = phone && phone.readyState === WebSocket.OPEN;
      // In the socket_closed path exactly one side just closed (its close
      // handler called us). If somehow both are gone, record 'phone' — the
      // resume check itself requires BOTH roles back in the lobby, so the
      // recorded role only affects logging, not correctness.
      const droppedRole = !phoneOpen ? 'phone' : 'browser';
      room.resumable = {
        droppedRole,
        droppedAt: Date.now(),
        expiresAt: Date.now() + RESUME_WINDOW_MS,
        listenerGoneAt: null, // FORGE-L — see LISTENER_HOLD_GRACE_MS.
        // LEGACY_RESUME_TEARDOWN path only (no soft-hold, so no panel hold).
        panelHold: false,
        // Identity stash captured at pair formation (handleAcceptPairing /
        // tryAutoResume): { ua, ip, deviceLabel, deviceName }. Needed to
        // rebuild the original PAIRING_ACTIVE payloads — the rejoining
        // socket is brand new and carries none of this.
        identity: room.pairIdentity ?? null,
      };
      console.log(`[Relay][${redactToken(room.token)}] resume window armed (droppedRole=${droppedRole}, window=${RESUME_WINDOW_MS}ms)`);
    } else {
      room.resumable = null;
    }

    const payload = JSON.stringify({ reason });
    if (browser) {
      safeSend(browser, `PAIRING_TERMINATED:${payload}`);
      if (browser.readyState === WebSocket.OPEN) {
        room.lobby.add(browser);
        // Re-send LOBBY_STATUS so the browser knows whether a phone is still
        // around to try pairing again with.
        const { phones } = countLobby(room);
        safeSend(browser, `LOBBY_STATUS:${JSON.stringify({
          phonePresent: phones > 0,
          alreadyActive: false,
        })}`);
      }
    }
    if (phone) {
      safeSend(phone, `PAIRING_TERMINATED:${payload}`);
      if (phone.readyState === WebSocket.OPEN) {
        room.lobby.add(phone);
        const { browsers } = countLobby(room);
        safeSend(phone, `LOBBY_STATUS:${JSON.stringify({ browserCount: browsers })}`);
      }
    }

    // Fix (2026-06-17): a full teardown (user_left / resume_expired /
    // any non-soft-hold reason) means the pair is genuinely gone. If the
    // departing phone's socket was already closed (resume_expired after a
    // real disconnect, or user_left from the phone), it was NOT re-added
    // to the lobby above, so no live phone remains — tell lobby browsers
    // to drop the Connect affordance. countLivePhones gates this: if the
    // phone returned to the lobby OPEN, or another device is present, the
    // call is a no-op and the button stays blue. The soft-hold path above
    // returned early before reaching here, so a transient blip never trips
    // this (that's the point — absence only on genuine departure).
    // FORGE-O: this already re-broadcasts pair state for every full-teardown
    // path. The soft-hold path never reaches here — it is handled at its own
    // early return above.
    broadcastPhoneAbsentIfLastPhoneGone(room);
  }

  /**
   * Issue 3 (2026-06-11) — silent re-link after a transient connection drop.
   *
   * Called at lobby-join time (phone path and browser path). If the room has
   * a live `resumable` claim (armed by terminateActivePair on
   * 'socket_closed' only) and BOTH roles are now present in the lobby with
   * OPEN sockets, the pair is re-formed immediately: both sockets move
   * lobby → active and each receives a PAIRING_ACTIVE frame with the SAME
   * payload shape handleAcceptPairing sends — the web's and APK's existing
   * handlers accept it without a Connect click or Accept tap.
   *
   * Requiring both roles present (rather than strictly joiner.role ===
   * droppedRole) also covers the both-sides-dropped case: the first returner
   * finds no counterpart and falls through to the normal lobby flow leaving
   * the claim intact; the second returner completes the resume.
   *
   * Guards:
   *  - expired claim → cleared lazily here, normal flow.
   *  - a pendingPairing handshake in flight → the explicit human handshake
   *    wins; the resume claim is dropped.
   *  - 'user_left' never arms a claim (see terminateActivePair).
   *
   * Returns true if the pair was resumed (caller should skip its normal
   * lobby-join messaging for the joiner — PAIRING_ACTIVE replaces
   * LOBBY_STATUS so the client never sees a lobby frame after the resume).
   */
  function tryAutoResume(room) {
    const claim = room.resumable;
    if (!claim) return false;
    if (Date.now() > claim.expiresAt) {
      room.resumable = null;
      room.frameBuffer = []; // Fix 2: claim expired — buffered frames are stale.
      // FT-1 (d): the resume window is what kept the transfer record alive. It
      // just closed, so the transfer is unrecoverable — refund and drop. The
      // janitor reaches the same conclusion within FT_SWEEP_MS; doing it here
      // means the very next FILE_RESUME gets an honest connection_lost instead
      // of being forwarded to a sender that is no longer there.
      ftAbort(room, 'connection_lost');
      return false;
    }
    if (room.pendingPairing) {
      // A normal Connect→Accept handshake is mid-flight — it wins.
      room.resumable = null;
      return false;
    }
    // The survivor (soft-hold path, default) is already sitting in `active` —
    // seed from there so we only need to find the RETURNING side in the lobby.
    // In the legacy full-teardown path both slots are null and both are found
    // in the lobby, exactly as before.
    let phoneWs = room.active.phone && room.active.phone.readyState === WebSocket.OPEN ? room.active.phone : null;
    let browserWs = room.active.browser && room.active.browser.readyState === WebSocket.OPEN ? room.active.browser : null;
    const survivorPhone = phoneWs;       // non-null ⇒ phone survived, browser is returning
    const survivorBrowser = browserWs;   // non-null ⇒ browser survived, phone is returning
    // FORGE-L: when more than one of the user's own handsets is waiting in the
    // lobby, prefer the one that was actually in this pair. Previously the
    // first phone found won; over a panel hold (minutes, not seconds) the odds
    // of a second device being present are higher, so match on the deviceName
    // stashed at pair formation. Purely a preference — if nothing matches we
    // fall through to the historical first-found behaviour, so this can never
    // block a legitimate resume (e.g. a rejoined phone whose DEVICE_INFO has
    // not landed yet).
    const wantDeviceName = claim.identity ? claim.identity.deviceName : null;
    if (!phoneWs && wantDeviceName) {
      for (const s of room.lobby) {
        if (s.role === 'phone' && s.readyState === WebSocket.OPEN && s.deviceName === wantDeviceName) { phoneWs = s; break; }
      }
    }
    for (const s of room.lobby) {
      if (s.role === 'phone' && !phoneWs && s.readyState === WebSocket.OPEN) phoneWs = s;
      // forge/chrome-extension-p1: NEVER auto-promote a passive listener (the
      // extension SW) into the active browser slot — it is receive-only and must
      // not become the pair, or it would occupy active.browser and block the real
      // popup/tab from pairing. Only true interactive browsers are eligible here.
      else if (s.role === 'browser' && !s.listener && !browserWs && s.readyState === WebSocket.OPEN) browserWs = s;
    }
    // Counterpart not back yet (or both dropped and only one returned) —
    // keep the claim armed and fall through to the normal lobby flow.
    if (!phoneWs || !browserWs) return false;

    // ── T-RESUME-PHONE-RESTART-DESYNC ────────────────────────────────────────
    // Both roles are back and everything ABOVE this line says "resume". The one
    // thing none of it proves is that the returning PHONE still holds the E2E
    // session this resume is about to re-send it (P1(b) re-sends the SAME block
    // — same kid, same bytes — precisely because a resume mints nothing).
    //
    // A force-stopped app is a fresh process with `e2eSession = null`, and it
    // rejoins the lobby in milliseconds, so every guard here read as a blip. It
    // resumed into a pair it could not decrypt, the web stayed sealed-expecting
    // and silently dropped the phone's plaintext SMS_RECEIVED, and the phone's
    // own Disconnect was ignored for the full 180 s.
    //
    // So the phone must SAY it still holds the session, and name it. The gate
    // is pure and lives in lib/resumeGate-core.js with the whole rule table.
    // A terminate here is not a failure mode — it is the honest outcome: both
    // sides to the lobby, the browser told WHY, and the user re-pairs with a
    // fresh SAS. There is deliberately no silent re-handshake: a verified pair
    // means a code two people compared, and new key material must be compared
    // again.
    const gate = resumeGateVerdict({
      phoneReturning: !survivorPhone,
      roomKid: room.active.e2e ? room.active.e2e.kid : null,
      phoneSession: phoneWs.phoneSession,
    });
    if (gate.action === 'terminate') {
      console.log(
        `[Relay][${redactToken(room.token)}] resume REFUSED (droppedRole=${claim.droppedRole}, phoneReturning=true,`
        + ` reason=${gate.reason}, detail=${gate.detail}) — terminating the held pair`,
      );
      // Clear the claim FIRST. terminateActivePair's non-socket_closed path
      // does this too, but doing it here means the claim is gone before any
      // frame this call sends can re-enter a resume path — a re-armed claim
      // over a pair we have just declared dead is exactly the wedge we are
      // removing.
      room.resumable = null;
      // TWO shapes reach here and only one of them has an active slot left.
      //
      //  (1) A SURVIVOR is still held (the ordinary force-stop: the browser
      //      never went away). terminateActivePair does the whole job — drops
      //      room.active.e2e, empties the frame buffer, sends
      //      PAIRING_TERMINATED:{reason:'phone_restarted'} and returns the
      //      survivor to the lobby with a fresh LOBBY_STATUS.
      //
      //  (2) BOTH sides had already dropped and are back in the lobby (phone
      //      restarted, then the browser reloaded). room.active holds nothing,
      //      so terminateActivePair's `if (!browser && !phone) return;` guard
      //      fires and it tells NOBODY — the browser would sit in the lobby
      //      having been silently refused, which is the original wedge wearing
      //      a different hat. The returning browser is a live socket we are
      //      holding right here, so it is told directly.
      //
      // The returning PHONE needs nothing either way: it is still in room.lobby
      // and the join path below sends it LOBBY_STATUS, because we return false.
      if (room.active.browser || room.active.phone) {
        terminateActivePair(room, gate.reason);
      } else {
        room.active = { browser: null, phone: null, e2e: null };
        room.frameBuffer = [];
        ftAbort(room, 'connection_lost', { notify: false });
        safeSend(browserWs, `PAIRING_TERMINATED:${JSON.stringify({ reason: gate.reason })}`);
        const { phones } = countLobby(room);
        safeSend(browserWs, `LOBBY_STATUS:${JSON.stringify({ phonePresent: phones > 0, alreadyActive: false })}`);
      }
      return false;
    }

    room.lobby.delete(phoneWs);
    room.lobby.delete(browserWs);
    room.active.browser = browserWs;
    room.active.phone = phoneWs;
    room.resumable = null;

    const id = claim.identity ?? {};
    // Prefer the live socket's deviceName (a surviving phone keeps it); fall
    // back to the pair-time stash for a rejoined phone whose DEVICE_INFO
    // hasn't arrived yet.
    const deviceName = phoneWs.deviceName ?? id.deviceName ?? null;
    room.pairIdentity = { ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', deviceLabel: id.deviceLabel, deviceName };
    // IDENTICAL payload shapes to handleAcceptPairing's PAIRING_ACTIVE pair.
    // A survivor (soft-hold path) never left active and already holds correct
    // state — re-sending PAIRING_ACTIVE to it would needlessly re-trigger its
    // quicksync, so we send only to the side that actually returned. In the
    // legacy full-teardown path BOTH are freshly resumed ⇒ both get the frame.
    // FORGE-M (2026-09-16) — survivor semantics and the resume marker.
    //
    // `survivorHeld` used to mean only "a socket stayed in room.active". Under
    // a panel hold that is too narrow: both peers may legitimately be away at
    // once (panel closed, then the phone blips) while the extension's listener
    // keeps the pair alive, and the pair that re-forms is the SAME pair — the
    // relay never released it, never sent PAIRING_TERMINATED, and never asked
    // anyone to re-accept. A live hold is therefore survivor-preserving in its
    // own right, from whichever side comes back first.
    const held = !!(survivorPhone || survivorBrowser) || claim.panelHold === true;
    // The client cannot tell a resume from a first connect by the frame alone,
    // so it ran its visible first-connect quicksync every time the panel was
    // reopened — Dennis: "need to do a full sync again once we open the
    // extension again". `resumed` says the relay CONFIRMS this is a
    // continuation; `gapMs` is how long the pair was held, so the client can
    // size a silent merge backfill instead. handleAcceptPairing deliberately
    // does NOT set these: a genuine first connect must stay a first connect.
    const gapMs = Date.now() - (claim.heldSince ?? claim.droppedAt);
    const resumeMark = { resumed: true, held, gapMs };
    // T-RESUME-PHONE-RESTART-DESYNC — what the page needs to re-verify the peer
    // for itself. The gate above already refuses the bad rows, so this is
    // defence in depth, and it is worth having for the reason A3 gives about
    // `userId`: a page that trusts the relay's verdict and holds no fact of its
    // own has delegated its session lifetime to the relay.
    //
    // Sent ONLY when the phone is the side that RETURNED, and only when that
    // phone declared something. A SURVIVING phone's declaration is from its own
    // join — which for a pair formed after that join is stale by construction —
    // so reporting it would be worse than saying nothing. Absent therefore
    // means "not checkable here", never "no session": the page treats an absent
    // field as a non-event, exactly as it treats a relay that predates it.
    const returningPhoneSession = (!survivorPhone && phoneWs.phoneSession && phoneWs.phoneSession.declared)
      ? { present: !!phoneWs.phoneSession.present, kid: phoneWs.phoneSession.kid }
      : null;
    if (returningPhoneSession) resumeMark.peerSession = returningPhoneSession;
    // P1(b) — the SAME e2e block, same kid, same bytes. This is a resume, not a
    // re-pair: no new Accept happened, so no new key material exists, and the
    // returning socket has none of its own. Minting or omitting a block here
    // would silently downgrade every reconnect to plaintext while the UI still
    // said Encrypted. The stash is the same OBJECT the Accept path sent, so
    // byte-identity is structural rather than something a copy has to maintain
    // (tests/e2e-resume-carries-block.test.mjs asserts it as bytes).
    const e2eResume = room.active.e2e ? { e2e: room.active.e2e } : {};
    if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName, ...e2eResume, ...resumeMark })}`);
    // The phone is not told about its own declaration — peerSession is the
    // PAGE's re-verification input and nothing else, so it is stripped here
    // rather than travelling as noise the APK has to learn to ignore.
    if (!survivorPhone) {
      const phoneMark = { resumed: resumeMark.resumed, held: resumeMark.held, gapMs: resumeMark.gapMs };
      safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', ...e2eResume, ...phoneMark })}`);
    }
    console.log(`[Relay][${redactToken(room.token)}] auto-resumed pair after socket_closed (gap=${Date.now() - claim.droppedAt}ms, heldFor=${gapMs}ms, droppedRole=${claim.droppedRole}, panelHold=${claim.panelHold === true}, survivorHeld=${held}, gate=${gate.reason}, peerSession=${returningPhoneSession ? (returningPhoneSession.present ? 'present' : 'absent') : 'not-reported'})`);

    // Fix 2: replay phone→browser frames buffered during the blip, in order,
    // to the now-active browser. Discard entries older than RESUME_WINDOW_MS
    // (stale) — the browser's own dedup (notification-key / message-id) absorbs
    // any overlap with its quick-sync. Then clear the buffer.
    if (room.frameBuffer && room.frameBuffer.length) {
      // FORGE-L: the cutoff must track the claim's ACTUAL lifetime, not the
      // fixed 180 s window. Under a panel hold a claim legitimately lives for
      // minutes, and a flat now-RESUME_WINDOW_MS cutoff would silently discard
      // every frame buffered more than 3 minutes ago — exactly the SMS the
      // feature exists to preserve. Every entry in frameBuffer already belongs
      // to the current claim (the buffer is reset when a claim is armed at
      // :808 and when one expires at :906), so replaying from droppedAt is
      // sound, and FRAME_BUFFER_MAX still bounds it. Non-held claims keep the
      // historical cutoff exactly.
      // FORGE-M: replay from heldSince, not droppedAt. When the phone also
      // blipped during the hold, droppedAt jumped forward to that blip and
      // every frame buffered before it — the SMS this feature exists to
      // preserve — was silently discarded here.
      const cutoff = claim.panelHold ? (claim.heldSince ?? claim.droppedAt) : Date.now() - RESUME_WINDOW_MS;
      let replayed = 0;
      for (const entry of room.frameBuffer) {
        if (entry.at < cutoff) continue;
        if (safeSend(browserWs, entry.msg)) replayed += 1;
      }
      console.log(`[Relay][${redactToken(room.token)}] replayed ${replayed}/${room.frameBuffer.length} buffered frame(s) on resume`);
      room.frameBuffer = [];
    }
    // FORGE-O: the pair just went held → active. The listener is the ONE peer
    // that gets no PAIRING_ACTIVE here (it is not an active slot), so without
    // this it would sit on a stale `held` until the next data frame.
    broadcastPairState(room);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pairing handshake
  // ---------------------------------------------------------------------------

  /**
   * Browser asked for a pairing. Validate state, assign a pairingId, start
   * the 30 s timer, forward PAIRING_REQUEST to the phone (there should be
   * exactly one in the lobby once we reach here; if there are several, the
   * first found wins — multi-phone-per-account is not a supported use case
   * today, but we still log it).
   */
  function handleBrowserRequestPairing(room, browserWs, payload, browserIp) {
    if (room.active.browser || room.active.phone) {
      safeSend(browserWs, `PAIRING_REJECTED:${JSON.stringify({ reason: 'already_active' })}`);
      return;
    }
    if (room.pendingPairing) {
      safeSend(browserWs, `PAIRING_REJECTED:${JSON.stringify({ reason: 'already_pending' })}`);
      return;
    }
    // Find a phone in the lobby. Without one we can't pair — surface a
    // distinct reason so the browser can render meaningful copy ("phone not
    // present yet"). The current contract bundles this under
    // 'already_pending' — not exposed in the spec, so map it to a sensible
    // existing reason rather than invent a new one.
    let phoneWs = null;
    for (const ws of room.lobby) {
      if (ws.role === 'phone') { phoneWs = ws; break; }
    }
    if (!phoneWs) {
      // No phone in room. Treat as a transient reject — the browser's UI
      // should already be gating BROWSER_REQUEST_PAIRING on phonePresent,
      // so we hit this only on a race. Reuse already_pending for now.
      safeSend(browserWs, `PAIRING_REJECTED:${JSON.stringify({ reason: 'already_pending' })}`);
      return;
    }

    const ua = typeof payload?.ua === 'string' ? payload.ua.slice(0, 256) : 'unknown';
    // The relay is the only authority on the browser's IP — never trust the
    // client-supplied value. ua is allowed to be client-supplied (it's just
    // a UI hint for the phone's accept prompt).
    const ip = browserIp;

    // Dispatch FORGE-1 (2026-05-26) — friendly browser-identity label shown
    // on the APK Accept dialog. Browser-supplied; we sanitize (strip control
    // chars, cap to 60 chars) as belt-and-braces defense in case the browser
    // sanitizer is bypassed or stale. Absent/blank → forward as undefined so
    // the APK falls back to its generic copy (backward compat with v22).
    let deviceLabel;
    if (typeof payload?.deviceLabel === 'string') {
      // eslint-disable-next-line no-control-regex
      const cleaned = payload.deviceLabel.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 60);
      if (cleaned.length > 0) deviceLabel = cleaned;
    }

    // P1(a) — the opaque e2e block. Validated for SIZE and key SHAPE only (see
    // validateE2eBlock); anything failing either check is dropped and the
    // pairing continues in plaintext rather than failing. The block is
    // forwarded VERBATIM: we pass the parsed object straight through, so any
    // field the relay does not know about survives untouched, which is what
    // lets P2/P3/P4 extend the block without a relay change.
    const e2eCheck = validateE2eBlock(payload?.e2e, e2eRequestKeys);
    if (e2eCheck.reason) {
      console.log(
        `[Relay][${redactToken(room.token)}] type=BROWSER_REQUEST_PAIRING e2e=${e2eCheck.reason}` +
        (e2eCheck.bytes !== undefined ? ` bytes=${e2eCheck.bytes}` : '') +
        ' — block dropped, pairing continues plaintext',
      );
    }
    const e2eBlock = e2eCheck.block;

    // N-1 — refuse, never silently downgrade. Checked against the VALIDATED
    // block: a block we already dropped for shape is not a mode=1 request, it
    // is a malformed one, and it has already fallen back to plaintext.
    if (!E2E_PAIRING_ENABLED && e2eBlock && e2eBlock.mode === 1) {
      console.log(`[Relay][${redactToken(room.token)}] type=BROWSER_REQUEST_PAIRING e2e=kill-switch — mode=1 REFUSED (E2E_PAIRING_ENABLED != '1')`);
      safeSend(browserWs, `PAIRING_E2E_UNAVAILABLE:${JSON.stringify({ reason: 'kill-switch' })}`);
      return;
    }

    const pairingId = crypto.randomUUID();
    const expiresAt = Date.now() + PAIRING_TTL_MS;

    const timer = setTimeout(() => {
      // 30 s elapsed with no answer. Tell both sides and clear state.
      if (room.pendingPairing?.id !== pairingId) return; // raced — already resolved
      console.log(`[Relay][${redactToken(room.token)}] Pairing ${pairingId} timed out`);
      const pending = room.pendingPairing;
      room.pendingPairing = null;
      safeSend(pending.browserWs, `PAIRING_TIMEOUT:${JSON.stringify({})}`);
      safeSend(phoneWs, `PAIRING_CANCELLED:${JSON.stringify({ pairingId })}`);
      maybeReapRoom(room);
    }, PAIRING_TTL_MS);

    room.pendingPairing = { id: pairingId, browserWs, ua, ip, deviceLabel, expiresAt, timer, e2e: e2eBlock };

    // Build forward payload omitting deviceLabel when absent so older APK
    // builds (v22 and below) parse the same shape they always did.
    const forwardPayload = deviceLabel !== undefined
      ? { pairingId, ua, ip, deviceLabel }
      : { pairingId, ua, ip };
    // Added only when present, so a plaintext pairing forwards byte-identically
    // to what v55 and every older APK have always parsed.
    if (e2eBlock) forwardPayload.e2e = e2eBlock;
    safeSend(phoneWs, `PAIRING_REQUEST:${JSON.stringify(forwardPayload)}`);
    console.log(`[Relay][${redactToken(room.token)}] Pairing request ${pairingId} forwarded to phone (ua=${ua.slice(0, 40)} ip=${ip} label=${deviceLabel ?? '-'} e2e=${e2eBlock ? `v${e2eBlock.v}/mode${e2eBlock.mode}/recips${e2eBlock.recips.length}` : 'none'})`);
    // INC-0923 B-1 (relay), OBSERVATIONAL ONLY. The relay does not decide
    // anything about keys — the phone's pin does — so this never refuses, never
    // edits the block and never delays the forward: it runs after the frame is
    // already on the wire. What it buys is the thing this incident cost a
    // morning to establish by hand: whether an advertised recipient had a live
    // registry row, visible in the relay log beside the pairing it belongs to,
    // instead of reconstructible only by querying prod afterwards.
    logUnregisteredRecipients(room, pairingId, e2eBlock);
  }

  /**
   * INC-0923 B-1 (relay). Say, in the log, which advertised recipients the
   * DeviceKey registry has no live row for.
   *
   * NO REFUSAL, by design and by brief. The phone's `E2eKeyPin.verify` is the
   * authority on whether an advertised key is acceptable, and a second opinion
   * on the relay is how two components end up disagreeing about the same fact.
   * This only names what the phone is about to see.
   *
   * Fire-and-forget: the caller does not await it, and every failure path is a
   * silent return. A DeviceKey query must never be able to delay, fail or
   * change a pairing.
   */
  function logUnregisteredRecipients(room, pairingId, e2eBlock) {
    try {
      const recips = e2eBlock && Array.isArray(e2eBlock.recips) ? e2eBlock.recips : null;
      if (!recips || recips.length === 0) return;
      // validateE2eBlock already caps the list at 8; re-derived here so this
      // function is safe to call from anywhere, not just behind that check.
      const ids = recips
        .map((r) => (r && typeof r.deviceId === 'string' ? r.deviceId : null))
        .filter((id) => id !== null)
        .slice(0, 8);
      if (ids.length === 0) return;
      db.deviceKey
        .findMany({ where: { deviceId: { in: ids }, revokedAt: null }, select: { deviceId: true } })
        .then((rows) => {
          const live = new Set(rows.map((r) => r.deviceId));
          const missing = recips.filter((r) => r && !live.has(r.deviceId));
          if (missing.length === 0) return;
          console.log(
            `[Relay][${redactToken(room.token)}] Pairing ${pairingId} e2e=UNREGISTERED-RECIPIENT`
            + ` ${missing.map((r) => `${r.kind || '?'}:${r.deviceId}`).join(' ')}`
            + ' — no live DeviceKey row; the phone reads this as a substituted key'
            + ' and is expected to DECLINE (INC-0923). Relay does not refuse.',
          );
        })
        .catch(() => { /* observability must never be a failure mode */ });
    } catch { /* ditto */ }
  }

  /**
   * Phone accepted the pending pairing. Validate id matches, move both
   * sockets lobby → active, fire PAIRING_ACTIVE to each side with the
   * peer's identifiers.
   */
  function handleAcceptPairing(room, phoneWs, payload) {
    const pending = room.pendingPairing;
    if (!pending) {
      console.log(`[Relay][${redactToken(room.token)}] ACCEPT_PAIRING ignored — no pending`);
      return;
    }
    if (!payload?.pairingId || payload.pairingId !== pending.id) {
      console.log(`[Relay][${redactToken(room.token)}] ACCEPT_PAIRING ignored — id mismatch (got=${payload?.pairingId} expected=${pending.id})`);
      return;
    }
    const browserWs = pending.browserWs;
    clearPendingPairing(room);

    // If the browser disappeared between request and accept, surface a
    // termination to the phone immediately — accepting an empty handshake
    // would leave the phone stuck in "active" while the browser is gone.
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      console.log(`[Relay][${redactToken(room.token)}] ACCEPT_PAIRING but browser is gone — notifying phone`);
      safeSend(phoneWs, `PAIRING_TERMINATED:${JSON.stringify({ reason: 'browser_gone' })}`);
      maybeReapRoom(room);
      return;
    }

    room.lobby.delete(browserWs);
    room.lobby.delete(phoneWs);
    room.active.browser = browserWs;
    room.active.phone = phoneWs;

    // The phone may have sent a DEVICE_INFO frame earlier (relay used to
    // capture deviceName); we don't have a stable cache for it here. The
    // browser can read it from the post-pairing data plane when the phone
    // sends DEVICE_INFO; for the initial PAIRING_ACTIVE payload we omit it
    // unless we already have it stashed on ws.deviceName.
    const deviceName = phoneWs.deviceName ?? null;
    // Issue 3: stash the pair's identity fields on the room so a later
    // socket_closed teardown can rebuild both PAIRING_ACTIVE payloads for a
    // silent resume (the rejoining socket carries none of this). A freshly
    // completed normal handshake also supersedes any stale resume claim.
    room.pairIdentity = { ua: pending.ua, ip: pending.ip, deviceLabel: pending.deviceLabel, deviceName };
    room.resumable = null;

    // P1(b) — the phone's sealed key material. Same opaque treatment as the
    // request block: size cap + the 65-byte 0x04 encoding pin on epk and every
    // recipKey, nothing about their meaning. `wraps` and `kid` are bounded, not
    // pinned — a wrap is ciphertext, not a point.
    //
    // recipKeys is the FULL static key set (phone + web + SW), not this
    // recipient's key: B9's SAS covers the whole set, so every party needs the
    // whole list to compute the code it is being asked to compare.
    const acceptCheck = validateE2eBlock(payload?.e2e, e2eAcceptKeys);
    if (acceptCheck.reason) {
      console.log(
        `[Relay][${redactToken(room.token)}] type=ACCEPT_PAIRING e2e=${acceptCheck.reason}` +
        (acceptCheck.bytes !== undefined ? ` bytes=${acceptCheck.bytes}` : '') +
        ' — block dropped, pairing continues plaintext',
      );
    }
    // The stash. ONE object, shared by both PAIRING_ACTIVE payloads, by
    // PAIR_STATE, and by every later resume — so "the resume re-sends the same
    // block" is true by construction (same reference, same JSON) rather than by
    // a copy that has to be kept in step.
    room.active.e2e = acceptCheck.block;

    const browserActive = { deviceName };
    const phoneActive = { ua: pending.ua, ip: pending.ip };
    if (room.active.e2e) {
      browserActive.e2e = room.active.e2e;
      phoneActive.e2e = room.active.e2e;
    }
    safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify(browserActive)}`);
    safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify(phoneActive)}`);
    console.log(`[Relay][${redactToken(room.token)}] Pairing ${pending.id} ACTIVE — browser ↔ phone`);
    // FORGE-O: the one moment green is actually earned. The listener gets no
    // PAIRING_ACTIVE of its own (it is not an active slot), so this is how it
    // learns the pair formed.
    broadcastPairState(room);
  }

  /**
   * Phone declined the pending pairing. Browser is told and stays in lobby.
   */
  function handleDeclinePairing(room, phoneWs, payload) {
    const pending = room.pendingPairing;
    if (!pending) return;
    if (!payload?.pairingId || payload.pairingId !== pending.id) return;
    const browserWs = pending.browserWs;
    clearPendingPairing(room);
    if (browserWs) {
      safeSend(browserWs, `PAIRING_DECLINED:${JSON.stringify({})}`);
    }
    console.log(`[Relay][${redactToken(room.token)}] Pairing ${pending.id} declined by phone`);
    maybeReapRoom(room);
  }

  /**
   * Forward a non-control data-plane frame between the two halves of the
   * active pair. Returns true if the frame was forwarded, false otherwise
   * (caller logs the drop).
   */
  /**
   * Fan a phone→browser data frame out to every passive listener in the room
   * (2026-09-02, forge/chrome-extension-p1). Listeners (extension SWs) are NOT
   * the active browser, so forwardDataPlane never reaches them; this is their
   * only delivery path. Called for EVERY phone-originated data frame regardless
   * of active-pair state, so a listener still receives CALL_INCOMING /
   * SMS_RECEIVED / PHONE_NOTIFICATION when the popup (the active browser) is
   * closed or the pair is in a resume gap. Broadcasting to the SAME-user room is
   * not a leak — the listener authenticated into this exact room (phoneToken).
   */
  /**
   * True when at least one passive listener (an extension MV3 service worker
   * on `?role=listener`) is currently connected to this room with an OPEN
   * socket. FORGE-L uses this as the "the user's extension is still there"
   * signal that holds a pairing across a side-panel close — see
   * LISTENER_HOLD_GRACE_MS. Listeners only ever live in room.lobby (they are
   * never promoted into room.active — see tryAutoResume).
   */
  function hasLiveListener(room) {
    if (!room || !room.lobby) return false;
    for (const s of room.lobby) {
      if (s.role === 'browser' && s.listener && s.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  function broadcastToListeners(room, msg, perSocket = null) {
    if (!room || !room.lobby) return;
    for (const s of room.lobby) {
      if (s.role === 'browser' && s.listener && s.readyState === WebSocket.OPEN) {
        // P1(c) — `perSocket` lets ONE frame type (PAIR_STATE) differ per
        // listener, because each listener's e2e.wrap is its own and a shared
        // string would hand one device another device's wrap. Returning null
        // falls back to the shared `msg`, so every existing caller and every
        // listener that declared no deviceId is byte-for-byte unaffected.
        const per = perSocket ? perSocket(s) : null;
        safeSend(s, per ?? msg);
      }
    }
  }

  /**
   * FORGE-O (2026-09-16) — the listener's view of pairing truth.
   *
   * THE BUG THIS EXISTS TO KILL. The extension's MV3 worker joins as
   * `?role=listener` and sits in room.lobby forever: it is never promoted to
   * room.active.browser, so it never receives PAIRING_ACTIVE or
   * PAIRING_TERMINATED (those are sent to the ACTIVE sockets by name). The only
   * pairing-ish frames it could ever see were LOBBY_STATUS on join and
   * PHONE_PRESENT / PHONE_ABSENT broadcasts — all of which answer "is a phone in
   * this room", never "is a phone PAIRED with a browser". The worker had no
   * choice but to paint its green dot from presence, and presence is not
   * connection: after the 6eb9bc7 relay restart the phone was in the lobby and
   * pinging every 15 s with NO active pair, and the dot was green for minutes.
   * Dennis, 10:01: "showing 'phone connected and green dot' even though phone is
   * not connected."
   *
   * So the listener needs the three facts it cannot derive, stated explicitly:
   *   phonePresent — a live phone socket exists (lobby or active slot)
   *   paired       — BOTH active slots hold an OPEN socket right now
   *   held         — no live pair, but a resume claim is armed and unexpired,
   *                  i.e. this pair is legitimately mid-resume (FORGE-L panel
   *                  hold, or a socket blip inside RESUME_WINDOW_MS)
   *
   * `held` is deliberately a THIRD state and not folded into `paired`. A held
   * claim is a real, already-consented pair that the relay still owns and will
   * re-form without anyone tapping Accept — showing it as hard-disconnected
   * would make every panel close look like a dropout. But it is also not a live
   * pair: nothing can be sent over it until a peer returns. Grey-vs-green cannot
   * express that; a distinct "resuming" state can.
   *
   * WHY A NEW FRAME RATHER THAN FIELDS ON LOBBY_STATUS. PAIR_STATE goes to
   * LISTENERS ONLY (broadcastToListeners, not broadcastToLobbyBrowsers), so the
   * /app web client and the v55 APK never receive it and cannot be destabilised
   * by it — no APK change, no web-client change, nothing to version. LOBBY_STATUS
   * keeps its exact existing shape for both of those consumers.
   */
  function derivePairState(room, forWs = null) {
    const phoneOpen = !!(room.active.phone && room.active.phone.readyState === WebSocket.OPEN);
    const browserOpen = !!(room.active.browser && room.active.browser.readyState === WebSocket.OPEN);
    const paired = phoneOpen && browserOpen;
    // Unexpired claim only. An expired-but-not-yet-reaped claim is a torn-down
    // pair wearing a live one's clothes, which is the whole class of lie here.
    const claimLive = !!(room.resumable && Date.now() <= room.resumable.expiresAt);
    const state = {
      phonePresent: countLivePhones(room) > 0,
      paired,
      held: !paired && claimLive,
    };
    // P1(c) — the listener's slice of the e2e block. PAIR_STATE is the only
    // pairing frame a listener ever receives (it is never room.active.browser,
    // so PAIRING_ACTIVE never reaches it), which makes this its one chance to
    // learn the key material it needs to decrypt notification bodies with the
    // panel closed.
    //
    // It gets `wrap` — SINGULAR, its own, selected by deviceId — and never the
    // others. The whole wraps[] list would hand every listener the sealed keys
    // of every other device on the account: still sealed, still useless to
    // them, and still a pile of other devices' key material sitting in a
    // service worker for no reason. recipKeys IS the full set, because B9's SAS
    // is computed over the entire key set and a party holding only its own key
    // could not reproduce the code the user is being asked to compare.
    //
    // The block is ABSENT (not null, not partial) whenever any of its
    // preconditions fails, so a plaintext room's PAIR_STATE is byte-identical
    // to what shipped before this commit.
    const block = paired ? room.active.e2e : null;
    if (block && forWs && forWs.deviceId) {
      const mine = block.wraps.find((w) => w.deviceId === forWs.deviceId);
      if (mine) {
        state.e2e = {
          kid: block.kid,
          epk: block.epk,
          mode: block.mode,
          recipKeys: block.recipKeys,
          wrap: mine.wrap,
          // GATE1 Addendum A3-M1. `ctx` is the pair context the endpoints derive
          // their traffic keys from: {pairingId, phoneDeviceId, peerDeviceId,
          // pairEpoch}. ACCEPT_PAIRING -> PAIRING_ACTIVE forwards the block
          // whole, so those two recipients get it for free; THIS slice is an
          // explicit allowlist, so without this line the listener — the one
          // recipient whose whole job is decrypting with the panel closed —
          // would derive from a context it cannot obtain, and every frame it
          // received would fail authentication.
          //
          // Unlike `wrap`, ctx is pair-scoped and NOT device-scoped: every
          // recipient gets the identical object. The relay is a byte-carrier
          // here and validates nothing beyond what validateE2eBlock already
          // enforces (shape + 4 KB cap) — the `pairEpoch` decimal-string rule,
          // the peerDeviceId match and the epoch floor are all RECEIVER-side
          // MUSTs (A3-M2..M4). A relay that parsed ctx would be a relay that
          // could propose one.
          //
          // `block.ctx` is undefined on a block that carries none, and
          // JSON.stringify drops an undefined value: a pre-A3 block's
          // PAIR_STATE frame stays byte-identical to what shipped before.
          ctx: block.ctx,
        };
      }
    }
    return state;
  }

  /**
   * Push the current pairing truth to every listener. Cheap and idempotent —
   * the worker dedupes identical states before touching chrome.action — so
   * every transition site can call it unconditionally rather than each one
   * reasoning about whether the state actually moved.
   */
  function broadcastPairState(room) {
    if (!room || !room.lobby) return;
    // The base state is built ONCE and serves every listener that declared no
    // deviceId — which is every extension build shipped before P3, so the
    // common path is exactly what it was. A listener that DID declare one gets
    // its own frame with its own wrap spliced in; sharing one string across
    // listeners would mean handing one device another device's wrap.
    broadcastToListeners(
      room,
      `PAIR_STATE:${JSON.stringify(derivePairState(room))}`,
      (s2) => (s2.deviceId ? `PAIR_STATE:${JSON.stringify(derivePairState(room, s2))}` : null),
    );
  }

  function forwardDataPlane(room, fromWs, msg) {
    if (fromWs === room.active.browser && room.active.phone) {
      logNotifFrame(room.token, 'browser→phone (active)', msg);
      safeSend(room.active.phone, msg);
      return true;
    }
    if (fromWs === room.active.phone && room.active.browser) {
      logNotifFrame(room.token, 'phone→browser (active)', msg);
      safeSend(room.active.browser, msg);
      return true;
    }
    return false;
  }

  /**
   * 'YYYY-MM-DD' in UTC for a Date — the file-transfer daily-quota bucket key
   * (FT-1). Introduced 2026-08-28 for the free-tier daily call/SMS counters;
   * those were removed 2026-09-21 (trial-caps-purge) and the FT quota is now
   * its only caller.
   */
  function utcDayKey(d) {
    return d.toISOString().slice(0, 10);
  }

  // REMOVED 2026-09-21 (trial-caps-purge, SPEC-TRIAL-RULES-2026-09-21 §3): the
  // free-tier daily OUTBOUND cap gate and its next-UTC-midnight helper (20
  // calls / 10 messages, forge/free-tier-p1 2026-08-28). Dennis's rule of
  // record is "No call / sms limits for incoming/outgoing calls" — so the relay
  // does not meter MAKE_CALL / SEND_SMS at all any more, for any tier, in
  // either direction. There is no replacement gate and no feature flag around
  // the removal.
  //
  // Nothing writes the usage-counter table any more. The Prisma model and the
  // table itself stay: FILE-TRANSFER-SPEC Addendum A claimed them for a
  // per-account daily-BYTES counter.
  //
  // The removed gate's two identifiers are deliberately not spelled out here.
  // tests/no-daily-caps.test.js asserts this file contains neither of them as a
  // plain substring, and a pin that has to strip comments before it can be
  // trusted is a pin with a second thing that can quietly break.

  /**
   * Tier-gate a BROWSER→phone frame (2026-07-27, dispatch feature/tier-gating).
   * The relay is the ONLY server chokepoint for contact-sync + sync-range: the
   * browser talks to the phone directly over this WS (no REST), so a client-side
   * cap can be bypassed and MUST be enforced here, server-authoritative.
   *
   * Only the three sync frames are touched; every other frame (pairing, call
   * control, SMS send, notifications, DEVICE_INFO, …) passes through
   * BYTE-FOR-BYTE — this must not perturb any other relay routing.
   *
   *   GET_CONTACTS            → dropped unless the tier has contactSync.
   *   GET_MESSAGES / GET_CALL_LOGS
   *                           → `since` clamped UP to the tier's syncRangeMax
   *                             floor (now − window), so a Solo user cannot pull
   *                             history older than 30 days. Frames without an
   *                             absolute `since` (address / `before` cursor
   *                             pagination within an already-synced thread) are
   *                             left untouched — they do not widen the window.
   *
   * Fail-CLOSED on the feature flag (unknown/Solo tier → contactSync false →
   * drop). Fail-OPEN on a JSON parse error (forward unchanged): the tier is
   * already resolved to a concrete cap at admission (Solo default), so a
   * malformed payload — which the phone would ignore anyway — is not a bypass.
   *
   * @returns {{action:'pass'|'clamp'|'drop', msg?:string, reason?:string, floor?:number}}
   */
  function gateBrowserSyncFrame(ws, msg) {
    const limits = ws.tierLimits || {};

    // Contact book pull (Plus/Pro only). Frame is `GET_CONTACTS:{}` or
    // `GET_CONTACTS` — match the prefix without the colon to cover both.
    if (msg.startsWith('GET_CONTACTS')) {
      if (!limits.contactSync) return { action: 'drop', reason: 'contact_sync_not_in_tier' };
      return { action: 'pass', msg };
    }

    // Sync-range window clamp for bulk history pulls.
    if (msg.startsWith('GET_MESSAGES:') || msg.startsWith('GET_CALL_LOGS:')) {
      const colon = msg.indexOf(':');
      const prefix = msg.substring(0, colon);
      let payload;
      try {
        payload = JSON.parse(msg.substring(colon + 1));
      } catch {
        return { action: 'pass', msg }; // fail-open on parse error
      }
      if (!payload || typeof payload !== 'object') return { action: 'pass', msg };
      if (typeof payload.since === 'number' && Number.isFinite(payload.since)) {
        // Derive the floor from the EXACT limits this socket was admitted with
        // (ws.tierLimits, cached off the entitlement result) — NOT re-derived
        // from `tier` against the NEW map. This honors a grandfathered Plus
        // user's 6mo window and a limited-trial user's 3d window, both of which
        // differ from the new-map value for their tier key (2026-08-17).
        const floor = syncSinceFloorMsFromLimits(limits);
        if (payload.since < floor) {
          const clamped = Object.assign({}, payload, { since: floor });
          return { action: 'clamp', msg: `${prefix}:${JSON.stringify(clamped)}`, floor };
        }
      }
      return { action: 'pass', msg };
    }

    return { action: 'pass', msg };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILE TRANSFER — relay half (dispatch FT-1, 2026-09-18)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Everything the relay knows about a transfer lives in ONE record per room,
  // `room.transfer`. It is metadata only: an id, a state, which role is sending,
  // the DECLARED size and mime, timestamps, a running count of forwarded WIRE
  // bytes, and the bookkeeping needed to release a quota reservation exactly
  // once. It never holds `data`, never holds a chunk, and never holds the file
  // name — the name is in the FILE_OFFER the relay forwards byte-for-byte and
  // then forgets, and under E2E mode ON it is sealed and the relay could not
  // read it if it wanted to.
  //
  // The record is dropped on completion, on abort, on RESET_ROOM, on a
  // deliberate PAIRING_TERMINATED, and on resume-window expiry. It SURVIVES a
  // soft-held pair for the length of the resume claim, which is the whole point
  // of (d): a 1 GB transfer is minutes long, so a socket blip mid-transfer must
  // be resumable rather than fatal (Addendum A reverses the 25 MB spec's
  // "abort, do not resume" for caps over 100 MB).
  //
  // THE ONE RULE THAT IS NOT NEGOTIABLE: a FILE_CHUNK whose id has no record in
  // state 'accepted' is dropped. That is the mechanical enforcement of Dennis's
  // "the file transfer must be accepted by the receiving party" — it is not left
  // to client goodwill, because a client is the thing an attacker controls.

  /** Per-room counters for dropped FILE_* frames. Keyed by room token. */
  const ftDropCounts = new Map();

  function ftCountDrop(token, type, why) {
    let perRoom = ftDropCounts.get(token);
    if (!perRoom) { perRoom = new Map(); ftDropCounts.set(token, perRoom); }
    const key = `${type}/${why}`;
    const n = (perRoom.get(key) ?? 0) + 1;
    perRoom.set(key, n);
    return n;
  }

  /**
   * Parse a FILE_* frame into `{type, payload}`, or null when it is not a file
   * frame or is malformed.
   *
   * Validation is deliberately SHALLOW: the id shape and the presence of a JSON
   * object, nothing more. The relay is a forwarder; deep validation of a field
   * it does not act on would be a second, divergent copy of the clients' rules.
   * The fields it DOES act on (size, seq bookkeeping) are validated where they
   * are used, in ftHandleOffer.
   *
   * The `id` shape is enforced because the id is the record key and the join
   * between four frame types — a junk id is the one field that can desynchronise
   * the state machine. 16 random bytes as lowercase hex is what the spec says a
   * sender generates; the range is widened to 8-64 hex chars so a client that
   * picks a different random width is not silently broken by the relay.
   */
  function ftParse(msg) {
    const type = frameType(msg);
    if (!FT_FRAME_TYPES.has(type)) return null;
    const s = String(msg);
    const colon = s.indexOf(':');
    if (colon === -1) return { type, payload: null };
    let payload;
    try { payload = JSON.parse(s.slice(colon + 1)); } catch { return { type, payload: null }; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { type, payload: null };
    // NOTE an id is NOT required here, and that changed with FT-A1.
    //
    // Under Encrypted mode ON every FILE_* frame except FILE_OFFER is "sealed by
    // exclusion" and arrives as {e,kid,s,c} with NO readable id — the id is
    // inside the ciphertext. Requiring one would have dropped every chunk of
    // every encrypted transfer as malformed. FT-A1 section 1.7 is explicit that the
    // relay drives its per-room record from the frame TYPE alone, which is
    // plaintext on the wire and authenticated in the AAD, so an id-less frame is
    // matched to the room's single in-flight transfer rather than by key.
    //
    // ftFrameId() below is where "is there a usable id, and is it well-formed"
    // is decided, so a MALFORMED id is still rejected — it just is not confused
    // with an ABSENT one.
    return { type, payload };
  }

  /**
   * The transfer id a FILE_* frame identifies, or null when the frame carries
   * none (the sealed case, see ftParse).
   *
   * Under mode OFF the id is the top-level `id`. Under mode ON, FILE_OFFER's id
   * is in the plaintext envelope hint `ft.id` (FT-A1 MUST A-1) and no other
   * FILE_* frame carries one at all.
   *
   * @returns {string|null|false}  a valid id, null when absent, false when present-but-malformed
   */
  function ftFrameId(payload) {
    if (typeof payload.id === 'string') {
      return /^[0-9a-fA-F]{8,64}$/.test(payload.id) ? payload.id : false;
    }
    const ft = payload.ft;
    if (ft && typeof ft === 'object' && typeof ft.id === 'string') {
      return /^[0-9a-f]{32}$/.test(ft.id) ? ft.id : false;
    }
    return null;
  }

  /** The ACTIVE socket for a role, or null. */
  function ftSocketForRole(room, role) {
    return role === 'phone' ? room.active.phone : room.active.browser;
  }

  /** The active socket opposite `role`, or null. */
  function ftPeerSocket(room, role) {
    return ftSocketForRole(room, role === 'phone' ? 'browser' : 'phone');
  }

  /** Mint a FILE_FAILED frame. Refuses to emit a reason outside the frozen set. */
  function ftFailedFrame(id, reason, { relay = true } = {}) {
    const r = FT_FAIL_REASONS.has(reason) ? reason : 'cancelled';
    // FT-A1.1 MUST A1.1-M6 — the ONE mint site, and therefore the one place the
    // origin mark can be applied. Under mode ON a relay-authored frame is
    // necessarily plaintext (the relay holds no keys), so without a mark the
    // receiver's downgrade guard cannot tell a legitimate refusal from an
    // injected one and correctly drops both — which would hide exactly the
    // events the tier, quota and tamper controls exist to surface.
    //
    // `relay:false` is the RE-MINT path (M7): a plaintext peer failure is rebuilt
    // here from two scalars, which is what strips every other field the peer put
    // on it. That rebuild must not inherit the mark, and it must not copy a
    // `relay` field out of the payload either — the caller says which it is.
    //
    // The subset check is not decoration. `r` may have just been normalised to
    // `cancelled`, which is PEER-owned; stamping that would have the relay
    // claiming authorship of a reason only a peer can legitimately give.
    const mark = relay && FT_RELAY_OWNED_REASONS.has(r);
    return `FILE_FAILED:${JSON.stringify(mark ? { id, reason: r, relay: true } : { id, reason: r })}`;
  }

  /**
   * Terminal abort. Releases the sender's quota reservation (exactly once),
   * tells BOTH still-open sides, and drops the record.
   *
   * `notify` lets a caller suppress the outbound frames when the frame that
   * caused the abort is itself a FILE_FAILED being forwarded — otherwise the
   * peer would receive two.
   */
  function ftAbort(room, reason, { notify = true } = {}) {
    const rec = room.transfer;
    if (!rec) return;
    room.transfer = null;
    ftSettleQuota(rec);
    if (!notify) return;
    const frame = ftFailedFrame(rec.id, reason);
    for (const role of ['phone', 'browser']) {
      safeSend(ftSocketForRole(room, role), frame);
    }
    rlog(`[Relay][${redactToken(room.token)}] FILE transfer aborted id=${rec.id} reason=${reason} bytes=${rec.bytesForwarded}`);
  }

  /**
   * Reserve `size` raw bytes against the sender's UTC-day quota.
   *
   * ATOMIC check-and-increment in a single statement (INSERT … ON CONFLICT DO
   * UPDATE … WHERE bytes + size <= cap RETURNING): two offers racing on one
   * account must never both slip past the cap, which a read-then-write cannot
   * guarantee.
   *
   * This gate fails CLOSED. (The now-removed free-tier call/SMS meter failed
   * OPEN, because blocking a phone call over a counter-store blip was worse
   * than one uncounted call.) A single admitted
   * offer here is up to 1 GB of relay egress, and the cap IS the abuse control —
   * failing open turns a DB outage into unbounded bandwidth. The cost of failing
   * closed is one retry after the blip; the cost of failing open is a bill.
   *
   * The INSERT branch (first row of the day) carries no WHERE and therefore no
   * cap check, which is safe ONLY because `size` is already known to be <=
   * FT_MAX_FILE_BYTES (1 GiB) < FT_DAILY_QUOTA_BYTES (2 GiB) by the time we get
   * here. The explicit guard below makes that dependency non-silent rather than
   * leaving it as a comment about call order.
   *
   * @returns {Promise<{ok:true, day:string} | {ok:false, reason:'quota'}>}
   */
  async function ftReserveQuota(userId, size, day) {
    if (size > FT_DAILY_QUOTA_BYTES) return { ok: false, reason: 'quota' };
    try {
      const rows = await db.$queryRawUnsafe(
        `INSERT INTO "FileQuota" ("id","userId","day","bytes","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4::bigint,now(),now())
         ON CONFLICT ("userId","day")
         DO UPDATE SET "bytes" = "FileQuota"."bytes" + $4::bigint, "updatedAt" = now()
         WHERE "FileQuota"."bytes" + $4::bigint <= $5::bigint
         RETURNING "bytes" AS used`,
        crypto.randomUUID(),
        userId,
        day,
        String(size),
        String(FT_DAILY_QUOTA_BYTES),
      );
      if (!rows || rows.length === 0) return { ok: false, reason: 'quota' };
      return { ok: true, day };
    } catch (e) {
      console.error(`[Relay] FileQuota reserve FAILED-CLOSED (user=${userId} size=${size} day=${day}): ${e.message}`);
      return { ok: false, reason: 'quota' };
    }
  }

  /**
   * TERMINAL SETTLE — the one place a transfer's quota reaches its final value,
   * whether it ended in FILE_DONE or FILE_FAILED.
   *
   * FT-A1 MUST A-4 + Ken's Addendum 2: the daily quota is charged on METERED
   * bytes, not on the hinted size, and a transfer aborted at the meter still
   * pays for what it burned. That makes DONE and FAILED the same operation:
   * adjust the reservation to what was actually relayed. A transfer that failed
   * before a single chunk settles to zero — a full refund, which is the
   * "released on FILE_FAILED" behaviour Addendum A asked for — and one that
   * streamed 700 MiB against a 1 KiB lie settles to 700 MiB, which is the
   * abuse budget vector L5 exists to protect.
   *
   * Idempotent via `rec.quotaSettled`: a stall sweep racing an inbound
   * FILE_FAILED must settle once, not twice.
   *
   * The decrement targets the day the reservation was MADE on (`rec.quotaDay`),
   * never "today". A transfer that starts at 23:59:50 UTC and fails at 00:00:10
   * would otherwise refund a day that was never charged and leave yesterday's
   * row inflated forever.
   *
   * GREATEST(0, …) because a refund must never drive a counter negative, which
   * would hand the account free quota tomorrow if a row somehow double-refunded.
   */
  function ftSettleQuota(rec) {
    if (!rec || rec.quotaSettled || !rec.quotaDay || !rec.senderUserId) return;
    rec.quotaSettled = true;
    const { senderUserId, quotaDay, size } = rec;
    // MUST A-4: the account is charged what it actually MOVED, never what it
    // claimed it would move. The reservation made at FILE_OFFER was admission
    // control on an untrusted number; this is the correction to the truth.
    // `bytesForwarded` IS the MUST A-3 meter: every FILE_CHUNK's actual wire
    // length, summed, for this (room, id). It is deliberately one field and not
    // a second `metered` counter alongside it — two names for one quantity is
    // how one of them stops being incremented.
    const actual = ftRawFromWire(rec.bytesForwarded);
    const delta = actual - size;                 // negative = refund the unused part
    rec.settledRaw = actual;
    if (delta === 0) return;
    const sql = delta > 0
      ? `UPDATE "FileQuota" SET "bytes" = "bytes" + $3::bigint, "updatedAt" = now()
         WHERE "userId" = $1 AND "day" = $2`
      // GREATEST(0, ...) because a refund must never drive a counter negative,
      // which would hand the account free quota tomorrow.
      : `UPDATE "FileQuota" SET "bytes" = GREATEST(0::bigint, "bytes" - $3::bigint), "updatedAt" = now()
         WHERE "userId" = $1 AND "day" = $2`;
    db.$executeRawUnsafe(sql, senderUserId, quotaDay, String(Math.abs(delta))).catch((e) => {
      console.error(`[Relay] FileQuota settle failed (user=${senderUserId} day=${quotaDay}): ${e.message}`);
    });
  }

  /**
   * THE ONE PLACE the relay reads anything out of a FILE_OFFER body.
   *
   * Spec line 176 flags the sealing of FILE_OFFER for Security sign-off. That
   * ruling — Security FT-A1, proposal R-AF: a sealed frame plus ONE plaintext
   * envelope hint `ft:{size}`, the receiver refusing if the sealed size
   * disagrees with the hint — is OPEN as of 2026-09-18, and Ken's instruction is
   * to HOLD the mode-ON shape. So this function implements the RULED plaintext
   * path and guesses at nothing: no `ft` hint is read, because reading a field
   * whose name is still a proposal is how a lane ends up shipping a wire format
   * nobody ratified.
   *
   * WHEN FT-A1 LANDS, this is the only function that changes. `size` is read
   * here and nowhere else; the chunk path, the abort path and every log line
   * take it off the record this builds.
   *
   * So every read the gate performs goes through here. When the ruling arrives,
   * changing where `size` lives is a change to THIS FUNCTION and nothing else:
   * no second parse site in the chunk path, no third one in a log line, no
   * chance of one of them being updated and another not. It already tolerates a
   * body whose name/mime/sha256 have moved inside a seal — those are returned as
   * null rather than treated as missing-and-therefore-malformed.
   *
   * WHAT IT DELIBERATELY DOES NOT RETURN: the account. The sender is
   * `ws.userId`, proven at the WS upgrade by the relay ticket / phone token, and
   * a quota gate that could be pointed at another account by a payload field is
   * not a quota gate. The `from` field in the frame is a UI hint for the
   * receiver and the relay must never resolve an identity from it — which is
   * precisely why this accessor cannot hand one back, no matter how the sealing
   * ruling lands.
   *
   * @returns {{size:number|null, mime:string|null, sealed:boolean}}
   */
  function ftOfferMetadata(payload) {
    const none = { id: null, size: null, mime: null, sealed: false, ok: false };
    if (!payload || typeof payload !== 'object') return none;

    // A sealed frame is the E2E envelope {e,kid,s,c}. `c` is the ciphertext and
    // `e` is the version marker — a NUMBER (1), not a string; vector L's
    // envelope is {"e":1,"kid":"kid-ftA1","s":42,"c":"..."}. Keying the check on
    // `c` being a non-empty string is what makes it independent of how `e` is
    // spelled if the envelope version ever moves.
    const sealed = typeof payload.c === 'string' && payload.c.length > 0 && payload.e !== undefined;

    if (sealed) {
      // MUST A-2 — FAIL CLOSED on a missing or malformed hint. This is the hole
      // that would otherwise make the entire gate decorative: with no hint and
      // no refusal, EVERY sender bypasses tier and quota by omitting one field.
      // Vector L3.
      // `sealed: true` is carried on the REFUSAL too. Returning the bare `none`
      // here reported every bad hint as an ordinary malformed plaintext frame,
      // so the one counter that distinguishes "someone is stripping hints" from
      // "a client sent junk" never moved. A refusal that cannot be told apart
      // from noise is a refusal nobody will ever notice firing.
      const bad = { id: null, size: null, mime: null, sealed: true, ok: false };
      const ft = payload.ft;
      if (!ft || typeof ft !== 'object' || Array.isArray(ft)) return bad;
      if (typeof ft.id !== 'string' || !/^[0-9a-f]{32}$/.test(ft.id)) return bad;
      if (!Number.isSafeInteger(ft.size) || ft.size < 0 || ft.size > FT_MAX_FILE_BYTES) return bad;
      // mime is SEALED under mode ON and the relay does not get one. It never
      // needed it — it is a log-line nicety, not an input to any decision.
      return { id: ft.id, size: ft.size, mime: null, sealed: true, ok: true };
    }

    // Mode OFF: the body is the plaintext FileOffer.
    const id = typeof payload.id === 'string' && /^[0-9a-fA-F]{8,64}$/.test(payload.id) ? payload.id : null;
    const size = Number.isSafeInteger(payload.size) && payload.size > 0 ? payload.size : null;
    const mime = typeof payload.mime === 'string' ? payload.mime.slice(0, 128) : null;
    if (id === null || size === null) return none;
    return { id, size, mime, sealed: false, ok: true };
  }

  /**
   * MUST A-3 — the wire-byte ceiling for a transfer that declared `size` RAW
   * bytes, and the single most unit-sensitive number in this file.
   *
   * `size` is RAW file bytes. The meter counts WIRE bytes: base64 is +33 %
   * before the JSON envelope, before any E2E seal. Comparing the two directly —
   * which is what "metered bytes exceeding the hint" reads like in English —
   * would abort every HONEST transfer at roughly three quarters of the way
   * through, with `size_mismatch`, and the bug would look exactly like an
   * attack. So the hint is converted into its wire equivalent first, and the
   * slack is one whole chunk on top (a transfer is not over budget for
   * overshooting by less than the quantum it sends in).
   *
   * The second term applies the 1 GiB PER-FILE cap in the same units, so a
   * sender that hints 1 GiB and then streams forever is stopped at the cap
   * rather than at 1.4x the cap.
   */
  function ftWireCeiling(size) {
    const hinted = Math.ceil(size * FT_WIRE_OVERHEAD_FACTOR) + FT_CHUNK_WIRE_BYTES;
    const hardCap = Math.ceil(FT_MAX_FILE_BYTES * FT_WIRE_OVERHEAD_FACTOR) + FT_CHUNK_WIRE_BYTES;
    return Math.min(hinted, hardCap);
  }

  /**
   * MUST A-4 — the RAW-byte equivalent of what was actually relayed, which is
   * what the daily quota is charged on.
   *
   * `ft.size` is an admission-control ESTIMATE supplied by the party being
   * charged; vector L5 is the attack where a sender hints 1 KiB, passes the
   * gate and the receiver's compare (both values are lies told by the same
   * party), and streams 700 MiB for 1 KiB of quota. The meter is the truth.
   *
   * Inverting the wire overhead is itself an estimate, but it is an estimate
   * derived from a MEASUREMENT rather than from the sender's claim, and it errs
   * within one chunk of the real figure. It is clamped to the per-file cap so a
   * settle can never charge more than a file is allowed to be.
   */
  function ftRawFromWire(wireBytes) {
    if (!wireBytes) return 0;
    // Inverted on the base64 FLOOR (4/3), never on the ceiling's 1.40 — see
    // FT_WIRE_B64_FACTOR. Dividing by the larger number returns FEWER raw bytes
    // than were really moved, which is the wrong direction of error for a charge.
    return Math.min(Math.ceil(wireBytes / FT_WIRE_B64_FACTOR), FT_MAX_FILE_BYTES);
  }

  /**
   * FILE_OFFER — the single chokepoint. Tier, then size, then quota, in that
   * order: cheapest and most decisive first, so a trial account never causes a
   * DB write and an oversize pick never consumes a reservation it cannot use.
   *
   * THE ACCOUNT IS `ws.userId` — proven at the WS upgrade by the relay ticket /
   * phone token. It is never read from the payload. A `from` field exists in the
   * frame for the receiver's UI and the relay does not trust it for anything.
   *
   * The record is armed SYNCHRONOUSLY, in state 'gating', BEFORE the first
   * await. Two FILE_OFFERs arriving back-to-back would otherwise both observe
   * "no transfer in flight", both pass the gate and both reserve quota, and the
   * one-per-room rule would be decided by which DB round-trip returned first.
   */
  async function ftHandleOffer(room, ws, role, payload, token) {
    // THE ACCESSOR RUNS FIRST, before any other check, because under mode ON it
    // is also where the transfer's ID comes from. Under mode OFF the id is the
    // plaintext `id`; under mode ON it is `ft.id`, and there is no other
    // readable one — so nothing that needs to NAME this transfer (the busy
    // reject, the no-peer failure) can run ahead of it.
    //
    // It FAILS CLOSED when a sealed offer's hint is absent or malformed
    // (MUST A-2, vector L3). That refusal is the whole gate: without it, every
    // sender skips tier and quota by omitting one field.
    const meta = ftOfferMetadata(payload);
    if (!meta.ok) {
      // size_mismatch, not a bare `malformed` reject: under mode ON this IS the
      // tamper signal. L3 is literally "the relay strips ft", and the receiver
      // answers that same case with that same reason. One event, one word, both
      // ends of the wire.
      //
      // When the id itself is the unreadable part there is nothing to name, and
      // a FILE_FAILED without a valid id is dropped by the receiver's own
      // validator anyway — so the frame is not invented. The sender's 60 s offer
      // expiry is the backstop, which is the same reasoning FT-A1 section 2.3 uses
      // for the SW's unsendable failure.
      const nameable = ftFrameId(payload);
      if (nameable) safeSend(ws, ftFailedFrame(nameable, 'size_mismatch'));
      ftCountDrop(token, 'FILE_OFFER', meta.sealed ? 'bad_hint' : 'malformed');
      rlog(`[Relay][${redactToken(token)}] FILE_OFFER refused (hint absent or malformed) sealed=${meta.sealed} nameable=${!!nameable}`);
      return;
    }
    const id = meta.id;
    const size = meta.size;

    const dest = ftPeerSocket(room, role);
    if (!dest) {
      safeSend(ws, ftFailedFrame(id, 'connection_lost'));
      return;
    }
    // One transfer per room at a time, keyed by the transfer id.
    if (room.transfer) {
      // M5: FILE_FAILED, not FILE_REJECT. FILE_REJECT is receiver-authored and
      // sealed-by-exclusion, so a relay-minted plaintext one is invisible under
      // mode ON. Every relay refusal goes through the one marked mint path.
      safeSend(ws, ftFailedFrame(id, 'busy'));
      rlog(`[Relay][${redactToken(token)}] FILE_OFFER refused busy id=${id} (in-flight id=${room.transfer.id})`);
      return;
    }

    const now = Date.now();
    const rec = {
      id,
      state: 'gating',
      from: role,
      size,
      mime: meta.mime ?? '',
      startedAt: now,
      bytesForwarded: 0,
      lastActivityAt: now,
      // The AUTHENTICATED account, from the socket. Never from the payload, and
      // ftOfferMetadata cannot supply one even if a future frame shape carried
      // a plausible-looking field.
      senderUserId: ws.userId,
      quotaDay: null,
      quotaSettled: false,
    };
    room.transfer = rec;

    // (1) Tier. Addendum A: trial/free are OFF. Fail-closed allow-list.
    if (!FT_TIERS_ALLOWED.has(ws.tier)) {
      room.transfer = null;
      safeSend(ws, ftFailedFrame(id, 'tier'));
      rlog(`[Relay][${redactToken(token)}] FILE_OFFER refused tier id=${id} tier=${ws.tier}`);
      return;
    }
    // (2) Per-file hard cap.
    if (size > FT_MAX_FILE_BYTES) {
      room.transfer = null;
      safeSend(ws, ftFailedFrame(id, 'too_large'));
      rlog(`[Relay][${redactToken(token)}] FILE_OFFER refused too_large id=${id} size=${size}`);
      return;
    }
    // (3) Daily quota — reserved now, committed at FILE_DONE, released on abort.
    const day = utcDayKey(new Date());
    const reserved = await ftReserveQuota(ws.userId, size, day);
    if (!reserved.ok) {
      room.transfer = null;
      safeSend(ws, ftFailedFrame(id, 'quota'));
      rlog(`[Relay][${redactToken(token)}] FILE_OFFER refused quota id=${id} size=${size} day=${day}`);
      return;
    }
    rec.quotaDay = day;

    // The await above yielded; the room may have been reset or the pair torn
    // down underneath us. Re-check both, and refund if we are too late.
    if (room.transfer !== rec) { ftSettleQuota(rec); return; }
    const destNow = ftPeerSocket(room, role);
    if (!destNow || destNow.readyState !== WebSocket.OPEN) {
      room.transfer = null;
      ftSettleQuota(rec);
      safeSend(ws, ftFailedFrame(id, 'connection_lost'));
      return;
    }

    rec.state = 'offered';
    rec.lastActivityAt = Date.now();
    safeSend(destNow, `FILE_OFFER:${JSON.stringify(payload)}`);
    rlog(`[Relay][${redactToken(token)}] FILE_OFFER armed id=${id} from=${role} size=${size}`);
  }

  /**
   * The FILE_* data plane. Called from BOTH the phone and browser message
   * handlers, so phone→PC and PC→phone are the same code and cannot drift into
   * two gates of which one is fail-open.
   *
   * Returns true when the frame was consumed (the caller must NOT fall through
   * to its normal forward/drop path).
   */
  function handleFileFrame(room, ws, msg, role, token) {
    const parsed = ftParse(msg);
    if (!parsed) return false;               // not a FILE_* frame at all
    const { type, payload } = parsed;
    if (!payload) {
      ftCountDrop(token, type, 'malformed');
      rlog(`[Relay][${redactToken(token)}] FILE frame dropped (malformed): ${frameLabel(msg)}`);
      return true;
    }
    // A FILE_* frame is data plane: only the ACTIVE socket for this role may
    // send one. A lobby/duplicate socket streaming chunks would bypass the whole
    // state machine, so these are dropped rather than passed to the resume
    // passthrough that non-file data frames get.
    // FT-A1.1 MUST A1.1-M7 — a peer may not claim relay authorship. Checked for
    // EVERY FILE_* type, before anything else looks at the frame.
    //
    // REJECTED, not stripped, and the distinction is load-bearing: stripping
    // means re-serialising a frame the relay has promised to forward
    // byte-for-byte, and a re-serialiser on the passthrough path is how a relay
    // eventually starts parsing chunk bodies. Refusing costs an attacker one
    // frame and costs an honest client nothing, because no honest client sends
    // this field.
    if (Object.prototype.hasOwnProperty.call(payload, 'relay')) {
      ftCountDrop(token, type, 'peer_claimed_relay');
      rlog(`[Relay][${redactToken(token)}] FILE frame REJECTED (peer set the relay origin mark): ${frameLabel(msg)}`);
      return true;
    }

    if (ws !== ftSocketForRole(room, role)) {
      ftCountDrop(token, type, 'not_active');
      rlog(`[Relay][${redactToken(token)}] FILE frame dropped (socket not active ${role}): ${frameLabel(msg)}`);
      return true;
    }

    // The id this frame names, or null when it carries none. Under Encrypted
    // mode ON every FILE_* frame except FILE_OFFER is sealed by exclusion and
    // has no readable id (FT-A1 section 1.7) — those are matched to the room's
    // single in-flight transfer by TYPE, which is plaintext on the wire and
    // authenticated in the AAD. `false` means an id was present and malformed,
    // which is never matched to anything.
    const frameId = ftFrameId(payload);
    // NOTE the malformed-id drop is BELOW the FILE_OFFER branch, not above it.
    // A sealed offer whose ft.id is malformed must reach ftHandleOffer so that
    // MUST A-2's fail-closed refusal runs and is COUNTED as a bad hint; dropping
    // it here would look identical in the logs to a stray frame and would hide
    // the one event the hint gate exists to surface.
    if (type === 'FILE_OFFER') {
      ftHandleOffer(room, ws, role, payload, token).catch((e) => {
        console.error(`[Relay][${redactToken(token)}] FILE_OFFER gate crashed: ${e.message}`);
        if (room.transfer && room.transfer.id === frameId) ftAbort(room, 'cancelled');
      });
      return true;
    }

    if (frameId === false) {
      ftCountDrop(token, type, 'bad_id');
      rlog(`[Relay][${redactToken(token)}] FILE frame dropped (malformed id): ${frameLabel(msg)}`);
      return true;
    }

    const rec = room.transfer;
    const dest = ftPeerSocket(room, role);

    // Every remaining frame type is about an EXISTING transfer. No record — or a
    // record for a DIFFERENT id, when the frame names one at all — means the
    // frame is stale (a late ACK after an abort, a chunk from a cancelled
    // transfer) or forged. Drop and count.
    if (!rec || (frameId !== null && rec.id !== frameId)) {
      ftCountDrop(token, type, 'no_record');
      rlog(`[Relay][${redactToken(token)}] FILE frame dropped (no matching transfer): ${frameLabel(msg)}`);
      // A resume for a transfer the relay no longer knows about is the one case
      // the sender must hear about, or its UI hangs waiting for chunks that will
      // never come (deliverable (d)). With a sealed, id-less resume there is
      // nothing to name, so the failure is addressed to the id the relay would
      // have used — and when there is none, the sender's own stall timer is the
      // backstop and no frame is invented.
      if (type === 'FILE_RESUME' && frameId) safeSend(ws, ftFailedFrame(frameId, 'connection_lost'));
      return true;
    }

    const isSender = rec.from === role;

    switch (type) {
      case 'FILE_ACCEPT': {
        if (isSender || rec.state !== 'offered') {
          ftCountDrop(token, type, 'bad_state');
          return true;
        }
        rec.state = 'accepted';
        rec.lastActivityAt = Date.now();
        safeSend(dest, msg);
        rlog(`[Relay][${redactToken(token)}] FILE_ACCEPT id=${rec.id} — chunks now admitted`);
        return true;
      }

      case 'FILE_REJECT': {
        if (isSender) { ftCountDrop(token, type, 'bad_state'); return true; }
        room.transfer = null;
        ftSettleQuota(rec);
        safeSend(dest, msg);
        rlog(`[Relay][${redactToken(token)}] FILE_REJECT id=${rec.id} — record dropped, quota released`);
        return true;
      }

      case 'FILE_CHUNK': {
        // ACCEPT-BEFORE-CHUNKS. This branch is the feature's consent gate.
        if (!isSender || rec.state !== 'accepted') {
          const n = ftCountDrop(token, type, rec.state === 'accepted' ? 'wrong_direction' : 'not_accepted');
          rlog(`[Relay][${redactToken(token)}] FILE_CHUNK dropped (state=${rec.state} sender=${isSender}) id=${rec.id} count=${n}`);
          return true;
        }
        if (!dest || dest.readyState !== WebSocket.OPEN) {
          ftCountDrop(token, type, 'no_dest');
          return true;
        }
        // Relay-side watermark. The relay does NOT queue — a relay that queues
        // is a relay that stores. Over the mark, both sides are told and the
        // transfer is over.
        const queued = typeof dest.bufferedAmount === 'number' ? dest.bufferedAmount : 0;
        if (queued > FT_DEST_BACKPRESSURE_BYTES) {
          rlog(`[Relay][${redactToken(token)}] FILE_CHUNK backpressure abort id=${rec.id} bufferedAmount=${queued}`);
          ftAbort(room, 'relay_backpressure');
          return true;
        }
        // MUST A-3 — THE WIRE METER. This is the control that defends against a
        // LYING SENDER, which is the party the quota is charged to and therefore
        // the party with the motive. Vector L5: a sender seals `size: 1024` AND
        // hints `ft.size: 1024`, so the relay's admission gate passes and the
        // receiver's compare passes too — both values are lies told by the same
        // party — and then it streams 700 MiB for 1 KiB of quota, indefinitely.
        // Nothing in the hint/sealed compare can see that; only counting the
        // bytes as they go past can.
        //
        // FILE_CHUNK is padding-exempt (`_CHUNK` suffix), so the count is exact
        // and costs no crypto and no parsing.
        const wire = Buffer.byteLength(msg, 'utf8');
        // ftWireCeiling converts the RAW hint into WIRE bytes before comparing.
        // Comparing them directly would abort every honest transfer at about
        // three quarters through — and it would look like an attack.
        const ceiling = ftWireCeiling(rec.size);
        if (rec.bytesForwarded + wire > ceiling) {
          rlog(`[Relay][${redactToken(token)}] FILE_CHUNK over metered ceiling id=${rec.id} hinted=${rec.size} metered=${rec.bytesForwarded} ceiling=${ceiling}`);
          // `size_mismatch` per Ken's Addendum 2, which is the binding text and
          // is also the more precise word: what happened is that the declared
          // size and the actual stream disagree. Security's A-3 says `quota`;
          // that reason is kept for the case it describes exactly — the account
          // having no allowance left — rather than being overloaded onto this.
          // The metered bytes are CHARGED on the way out: ftAbort settles.
          ftAbort(room, 'size_mismatch');
          return true;
        }
        rec.bytesForwarded += wire;
        rec.lastActivityAt = Date.now();
        // Forwarded AS-IS. The relay does not parse, re-encode, inspect or log
        // `data` — under E2E mode ON it could not read it anyway.
        safeSend(dest, msg);
        return true;
      }

      case 'FILE_ACK': {
        if (isSender) { ftCountDrop(token, type, 'bad_state'); return true; }
        rec.lastActivityAt = Date.now();
        safeSend(dest, msg);
        return true;
      }

      case 'FILE_RESUME': {
        // Receiver → sender after a reconnect. The record survived the held
        // pair (see the janitor + terminateActivePair), so the sender is told
        // where to re-slice from. The relay forwards `upTo` untouched: it has
        // no idea how many chunks the receiver actually wrote, and guessing
        // would be the relay inventing content state it must not hold.
        if (isSender) { ftCountDrop(token, type, 'bad_state'); return true; }
        const sender = ftSocketForRole(room, rec.from);
        if (!sender || sender.readyState !== WebSocket.OPEN) {
          ftCountDrop(token, type, 'no_sender');
          safeSend(ws, ftFailedFrame(rec.id, 'connection_lost'));
          return true;
        }
        rec.state = 'accepted';
        rec.lastActivityAt = Date.now();
        safeSend(sender, msg);
        // The sending ROLE is deliberately NOT interpolated here. The record's
        // field is named `from` (the shape the spec froze), and `.from` is on
        // the redaction suite's PII field list because that is what a sender
        // ADDRESS is called on every other frame in this relay. A role is not
        // PII — but a log line that has to be argued about is a log line that
        // will eventually be copied to one that does leak. The id is the
        // debugging handle, and the direction is recoverable from the FILE_OFFER
        // line a few seconds earlier.
        rlog(`[Relay][${redactToken(token)}] FILE_RESUME id=${rec.id} forwarded to sender`);
        return true;
      }

      case 'FILE_DONE': {
        if (!isSender) { ftCountDrop(token, type, 'bad_state'); return true; }
        room.transfer = null;
        ftSettleQuota(rec);  // charge what was METERED, not what was hinted
        safeSend(dest, msg);
        rlog(`[Relay][${redactToken(token)}] FILE_DONE id=${rec.id} bytes=${rec.bytesForwarded} — quota committed`);
        return true;
      }

      case 'FILE_FAILED': {
        // Either side, terminal.
        room.transfer = null;
        ftSettleQuota(rec);
        // A SEALED failure is forwarded VERBATIM. Its reason is inside the
        // ciphertext, so re-minting the frame would (a) invent a reason the
        // sender never gave and (b) turn a sealed frame into a plaintext one —
        // which the receiver is required to DROP while the session is ON
        // (FT-A1 MUST B-1's downgrade guard). The relay would have silently
        // converted "the transfer failed" into "nothing ever arrived".
        //
        // A PLAINTEXT failure is normalised, so a client-authored string can
        // never widen the frozen vocabulary on its way through.
        const sealed = typeof payload.c === 'string' && payload.e !== undefined;
        // M7: the re-mint IS the stripper — it rebuilds the frame from two
        // scalars and discards everything else the peer attached, including any
        // `relay` key. `{relay:false}` keeps it from acquiring the mark on the
        // way through: this frame's author is the peer, not us.
        safeSend(dest, sealed ? msg : ftFailedFrame(rec.id, payload.reason, { relay: false }));
        rlog(`[Relay][${redactToken(token)}] FILE_FAILED id=${rec.id} sealed=${sealed} — quota settled`);
        return true;
      }

      default:
        return true;
    }
  }

  /**
   * Transfer janitor. Three jobs, all of them about not leaking:
   *
   *  1. A pair that is HELD (soft-hold, resume claim armed) keeps its record —
   *     that is what makes FILE_RESUME possible at all. Once the claim expires,
   *     or if there was never one, the transfer is dead: abort and refund.
   *  2. An offer nobody answers expires at FT_OFFER_TTL_MS so the one-per-room
   *     slot cannot be held hostage by a peer that went away mid-prompt.
   *
   *     SECURITY FT-A1.2, RATIFIED (A) 2026-09-18: this branch IS the
   *     no-receiver timeout, and it is RELAY-owned on purpose. The proposal to
   *     put it in the service worker (B-3) was STRUCK as unsatisfiable, not
   *     merely hard: listener sockets have no send path into the relay, and a
   *     SW-authored frame would be plaintext-and-unmarked, which the phone's
   *     B-1 downgrade guard is REQUIRED to drop. Giving the SW a send path to
   *     fix that converts a receive-only component into a wire participant and
   *     turns its frame-type filter into a security boundary. So the timeout is
   *     minted here, where the relay mark already comes from one place, and
   *     `ftAbort` fans it out to BOTH endpoints (M14) — the receiver's copy is
   *     admissible under A1.1-M9 because a receiver that never answered still
   *     holds a record for that id. `timeout` stays relay-owned (M15): a peer's
   *     own plaintext expiry naming a record we have already dropped is a
   *     `no_record` drop, never a forward.
   *
   *     FROZEN timer hierarchy (A1.2, extending A1.1 M4) — changing any number
   *     here is a cross-lane amendment, not a tuning exercise:
   *
   *       sender-local   60 s  PRIMARY        the sender gives up on its own
   *       SW marker      60 s  INFORMATIONAL  notification only; sends NOTHING (M13)
   *       FT_OFFER_TTL   90 s  BACKSTOP       this branch: frees slot + quota
   *       FT_STALL_MS    30 s  post-ACCEPT    branch 3 below, never this one
   *
   *     The 30 s gap between the sender's 60 s and this 90 s is what stops the
   *     relay racing an honest sender into a spurious `timeout`. Pinned by
   *     tests/ft-relay.test.mjs PART 12.
   *  3. An accepted transfer that goes FT_STALL_MS without a chunk or an ACK is
   *     timed out. This is the relay's BACKSTOP for the receiver-side stall the
   *     clients also enforce — a client that simply stops is not a client that
   *     gets to pin a room's transfer slot open forever.
   */
  const ftSweep = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const rec = room.transfer;
      if (!rec) continue;
      if (rec.state === 'gating') continue;   // a DB round-trip owns it
      const bothActive = !!(room.active.phone && room.active.browser);
      if (!bothActive) {
        const claim = room.resumable;
        if (claim && now <= claim.expiresAt) continue;   // held — keep for resume
        ftAbort(room, 'connection_lost');
        continue;
      }
      const ttl = rec.state === 'offered' ? FT_OFFER_TTL_MS : FT_STALL_MS;
      if (now - rec.lastActivityAt > ttl) ftAbort(room, 'timeout');
    }
  }, FT_SWEEP_MS);
  if (typeof ftSweep.unref === 'function') ftSweep.unref();

  /**
   * FileQuota janitor. One ranged DELETE every 6 h against the `day` index.
   *
   * There was no existing DB housekeeping path in the relay to hang this on
   * (the only other janitors are in-memory Map sweeps), so this is a new one
   * built to the same shape: unref'd so it can never hold the process open,
   * fail-soft so a DB blip logs and retries in 6 h rather than crashing the
   * relay, and cheap enough that its cost is irrelevant next to a single chunk.
   */
  const ftQuotaPrune = setInterval(() => {
    const cutoff = utcDayKey(new Date(Date.now() - FT_QUOTA_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    db.$executeRawUnsafe(`DELETE FROM "FileQuota" WHERE "day" < $1`, cutoff)
      .then((n) => { if (n) console.log(`[Relay] FileQuota janitor pruned ${n} row(s) older than ${cutoff}`); })
      .catch((e) => console.error(`[Relay] FileQuota janitor failed (retry in 6h): ${e.message}`));
  }, 6 * 60 * 60 * 1000);
  if (typeof ftQuotaPrune.unref === 'function') ftQuotaPrune.unref();

  /**
   * Live-sync resume fix (2026-06-16) — Bug A backstop + duplicate-lobby-socket
   * delivery (hotfix 2026-06-16b).
   *
   * Called for a data-plane frame that arrived from a socket still in the
   * LOBBY (i.e. NOT yet the active phone/browser). By the time a frame reaches
   * here every recognised control frame has already been handled and returned,
   * so `msg` is genuine data-plane traffic (a CALL_LOG_ENTRY, SMS_RECEIVED,
   * PHONE_NOTIFICATION, CALL_*, etc.) that we would otherwise silently drop.
   *
   * THE LIVE BUG THIS HOTFIX REPAIRS: the physical phone routinely holds MORE
   * THAN ONE socket to a room (a fresh connect while the prior socket is still
   * draining; soft-hold keeps the old one in `active` while new ones pile into
   * the lobby). Exactly one socket is `room.active.phone`; the OTHERS sit in
   * the lobby and ALSO stream live SMS / notification / call-log frames. Those
   * lobby frames were dropped — so on the web client, incoming SMS and phone
   * notifications stopped appearing even though an active browser was paired.
   * Observed live: repeated `Dropping lobby-phone frame: SMS_RECEIVED:...` with
   * a healthy `room.active.browser` present.
   *
   * Delivery rule (in priority order):
   *   1. If a resume claim is armed and this returning socket lets the pair
   *      re-form, do it via tryAutoResume and forward through the fresh pair.
   *   2. Otherwise, if the OPPOSITE role is held active (a paired survivor — OR
   *      simply the live active peer while this is a duplicate lobby socket of
   *      the same physical device), forward the frame straight to it so the live
   *      SMS / notification / call frame reaches the web client. This is the
   *      case that fixes the notification-fetch regression: it no longer
   *      requires an armed `resumable` claim — a live active opposite peer is
   *      sufficient.
   *
   * Returns true if the frame was handled (re-formed+forwarded, or delivered to
   * the active opposite peer); false only when there is NO active opposite peer
   * to deliver to (caller falls through to its drop+log).
   *
   * NEVER called in the LEGACY_RESUME_TEARDOWN path — the caller gates on it —
   * because that path holds no survivor in active, so there is nothing to
   * deliver to and the historical drop behavior is preserved.
   */
  function deliverLobbyFrameDuringResume(room, fromWs, msg, role, token) {
    // The peer we'd deliver to is the OPPOSITE role, held in active. A live
    // active opposite peer is the ONLY precondition for delivery — an armed
    // resume claim is no longer required (the duplicate-lobby-socket case has
    // no claim once the pair has already re-formed).
    const survivor = role === 'phone' ? room.active.browser : room.active.phone;
    if (!survivor || survivor.readyState !== WebSocket.OPEN) return false;

    const claim = room.resumable;
    const claimArmed = !!claim && Date.now() <= claim.expiresAt;

    // 1. If a resume window is armed, try to re-form the pair now that this
    //    returning socket is here.
    if (claimArmed && tryAutoResume(room)) {
      // The pair re-formed; this socket is now the active phone/browser. Forward
      // the frame that triggered the re-form through the normal data plane so it
      // is not lost.
      const active = role === 'phone' ? room.active.phone : room.active.browser;
      if (fromWs === active) {
        forwardDataPlane(room, fromWs, msg);
      } else {
        // Defensive: a different socket won the resume (e.g. duplicate). Still
        // deliver to the survivor so the frame survives.
        safeSend(survivor, msg);
      }
      console.log(`[Relay][${redactToken(token)}] resume re-formed pair on inbound ${role} frame; forwarded`);
      return true;
    }

    // 2. No re-form (no armed claim, or the counterpart isn't back in the
    //    lobby) — but a live active opposite peer IS present. Forward the frame
    //    straight to it. This covers BOTH the armed-window passthrough (survivor
    //    held during a blip) AND the duplicate-lobby-socket case (a second
    //    socket of the same physical phone streaming live SMS / notification /
    //    call frames while another socket is the active phone). Without this,
    //    those frames drop and the web client stops receiving notifications.
    logNotifFrame(token, `${role}→${role === 'phone' ? 'browser' : 'phone'} (dup-socket)`, msg);
    safeSend(survivor, msg);
    rlog(`[Relay][${redactToken(token)}] lobby-${role} data frame → active ${role === 'phone' ? 'browser' : 'phone'} (dup-socket/passthrough)`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Connection-level helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the auth material from a relay upgrade request.
   *
   * Bundle A (2026-05-28) — accepts TWO distinct credentials:
   *   • legacyToken — ?token=<phoneToken>           the long-lived bearer
   *                                                  every v29 APK already
   *                                                  has in its TokenStore.
   *   • ticket     — ?ticket=<jwt>                   a 30s HS256 JWT minted
   *                  OR Authorization: Bearer <jwt>  by /api/auth/relay-
   *                                                  ticket. Used by the
   *                                                  browser today, and by
   *                                                  Bundle-C v30 APK.
   *
   * The Authorization header path exists for symmetry / future native
   * clients — current browsers cannot set Authorization on a WS upgrade
   * via JS, so the ?ticket= path is what the browser actually uses.
   *
   * Routing layout (unchanged):
   *   /relay         → '/' (browser)
   *   /relay/phone   → '/phone' (phone)
   *
   * Returns nulls for absent fields. Validation happens in the caller.
   */
  function parseConnection(req) {
    const parsed = parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';
    const rawLegacy = parsed.query?.token;
    const rawTicketQ = parsed.query?.ticket;
    const legacyToken = (typeof rawLegacy === 'string' && rawLegacy.trim().length > 0)
      ? rawLegacy.trim()
      : null;
    const ticketQuery = (typeof rawTicketQ === 'string' && rawTicketQ.trim().length > 0)
      ? rawTicketQ.trim()
      : null;
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    const ticketHeader = (typeof authHeader === 'string' && authHeader.startsWith('Bearer '))
      ? authHeader.slice('Bearer '.length).trim()
      : null;
    // Query wins if both present (deterministic; ticketHeader is here for
    // future native clients that prefer headers).
    const ticket = ticketQuery || ticketHeader;
    // Chrome-extension passive listener (2026-09-02, forge/chrome-extension-p1).
    // `?role=listener` marks a RECEIVE-ONLY browser peer — the extension's
    // background service worker's WS. It authenticates like any browser
    // (relay-ticket) but is deliberately kept OUT of pairing, the active pair,
    // and the single-active-session (SESSION_SUPERSEDED) index, and it only ever
    // receives phone→browser frames. See the browser-path role assignment below.
    const rawRole = parsed.query?.role;
    const isListener = (typeof rawRole === 'string' && rawRole.trim().toLowerCase() === 'listener');
    // T-RESUME-PHONE-RESTART-DESYNC. `?session=<kid>` — the PHONE's declaration
    // that it still holds an E2E session for this room, and WHICH one. Read
    // here rather than from a later frame because tryAutoResume runs at
    // lobby-JOIN time, synchronously, before the phone has sent a single
    // message: a bit that arrives after the resume decision is a bit that
    // cannot inform it. Absent on every APK shipped before vc68; see
    // lib/resumeGate-core.js for why silence is treated as "no session".
    //
    // T-RELEASE-LOG-TOKEN INVENTORY (Security C2, ack 2026-09-25). The phone's
    // /relay/phone dial URL carries THREE pieces of query-string material, and
    // any logging of that URL — on the relay OR in Android logcat — exposes all
    // three: `?token=<phoneToken>` (the long-lived BEARER — the actual severity
    // of that ticket), `?deviceName=` where sent, and now `?session=<kid>`. The
    // kid is a PUBLIC label, not key material: kdf.mjs derives traffic keys from
    // {pairingId, sessionKey, context} and never from the kid, the relay already
    // holds it (room.active.e2e.kid) and already re-sends it inside every
    // PAIRING_ACTIVE, and it rides on every sealed envelope. It is listed here
    // so the inventory is COMPLETE, not because it raises that ticket's
    // severity. It is deliberately never written to a relay log: the refusal log
    // prints gate.reason/gate.detail (fixed strings) and the resume log prints
    // peerSession=present|absent|not-reported. Keep it that way — and note the
    // parser now charset-pins the value anyway (Security MINOR 1).
    const phoneSession = readPhoneSessionParam(parsed.query?.session);
    // P1(c) — a listener may declare WHICH device it is (`?deviceId=…`). It is
    // the only way the relay can hand a listener its OWN key wrap and nobody
    // else's: PAIR_STATE is the listener's only pairing frame, and the wraps
    // list is keyed by deviceId. Purely additive — a listener that sends none
    // (every extension build shipped so far) simply gets a PAIR_STATE with no
    // e2e block, which P3(d) already tolerates.
    //
    // This is an IDENTIFIER, not a credential: the socket is already
    // authenticated into this user's room by relay-ticket, and every wrap in
    // the room belongs to that same user. Claiming another deviceId gets you a
    // wrap you cannot unwrap — the sealing keys are the access control, not
    // this string. It is bounded and charset-limited so it cannot become a log
    // or memory problem.
    const rawDeviceId = parsed.query?.deviceId;
    const listenerDeviceId = (typeof rawDeviceId === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(rawDeviceId.trim()))
      ? rawDeviceId.trim()
      : null;
    return { pathname, legacyToken, ticket, isListener, listenerDeviceId, phoneSession };
  }

  /**
   * Validate a phoneToken against the User table.
   * Returns the userId on success, null on miss. Errors are logged and surface
   * as null so a transient DB blip doesn't crash the relay; the caller closes
   * the socket and the client retries.
   */
  async function validateToken(token) {
    try {
      const user = await db.user.findUnique({
        where: { phoneToken: token },
        select: { id: true },
      });
      return user ? user.id : null;
    } catch (err) {
      console.error(`[Relay] Token lookup failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Bundle A (2026-05-28) — resolve a relay-ticket JWT to a phoneToken.
   *
   * The relay's room key is the user's phoneToken (preserved for back-compat
   * with the legacy ?token= path, which lands rooms keyed by that value).
   * When a ticket-authed peer connects we resolve userId → phoneToken so
   * legacy + ticket peers for the same account always land in the SAME room.
   *
   * Returns null on:
   *   • signature failure / expired ticket
   *   • alg confusion (only HS256 accepted)
   *   • wrong purpose claim
   *   • user row missing
   *   • DB error (treat as auth fail — same belt-and-braces stance
   *     validateSessionToken in lib/auth.ts uses)
   */
  async function validateTicket(ticket) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      // lib/auth.ts enforces this at every signing site, but server.js is
      // a separate Node process with its own require graph — fail closed if
      // someone deploys without the env var rather than accepting unsigned
      // tokens. Mirror the lib/auth.ts behaviour exactly.
      console.error('[Relay] JWT_SECRET unset or <32 chars — refusing all ticket auth');
      return null;
    }
    let claims;
    try {
      claims = jwt.verify(ticket, secret, { algorithms: ['HS256'] });
    } catch (err) {
      console.log(`[Relay] Ticket verify failed: ${err.message}`);
      return null;
    }
    if (!claims || typeof claims !== 'object') return null;
    if (claims.purpose !== 'relay-ticket') {
      console.log(`[Relay] Ticket rejected — wrong purpose: ${claims.purpose}`);
      return null;
    }
    if (!claims.userId || typeof claims.userId !== 'string') return null;
    try {
      const user = await db.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, phoneToken: true },
      });
      return user ? { userId: user.id, phoneToken: user.phoneToken } : null;
    } catch (err) {
      console.error(`[Relay] Ticket user lookup failed: ${err.message}`);
      return null;
    }
  }

  wss.on('connection', async (ws, req) => {
    // FORGE-V — flag an over-maxPayload frame the moment the receiver rejects
    // it. Attached synchronously, before the auth gate's first await, so a
    // peer that opens and immediately blasts an oversized frame is still
    // recorded (and never lands an unhandled 'error' on the socket). The
    // per-path 'error' handlers below stay as they are; 'error' is multicast.
    ws.on('error', (err) => {
      if (err && err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') ws.overMaxPayload = true;
    });

    const { pathname, legacyToken, ticket, isListener, listenerDeviceId, phoneSession } = parseConnection(req);

    // Auth gate. Both paths produce a (userId, phoneToken) pair — the
    // phoneToken serves as the relay room key in either case so legacy
    // (?token=) and new (?ticket=) peers for the same account always pair
    // in the same room.
    let userId;
    let phoneToken;
    let authVia;
    if (legacyToken) {
      authVia = 'legacy-token';
      const resolvedUserId = await validateToken(legacyToken);
      if (!resolvedUserId) {
        console.log(`[Relay] Rejecting connection — invalid legacy token ${redactToken(legacyToken)}`);
        try { ws.close(4401, 'invalid_token'); } catch (e) {}
        return;
      }
      userId = resolvedUserId;
      phoneToken = legacyToken;
    } else if (ticket) {
      // Try ticket-JWT validation first (the browser + future native clients).
      const resolved = await validateTicket(ticket);
      if (resolved) {
        authVia = 'relay-ticket';
        userId = resolved.userId;
        phoneToken = resolved.phoneToken;
      } else {
        // Bundle C (2026-05-28) — v30 APK fallback. The Android client sends
        // its long-lived phoneToken via `Authorization: Bearer <phoneToken>`
        // (M3 closes "phoneToken in WS URL query"). If JWT verify fails the
        // value can't be a relay-ticket — validate it as a legacy phoneToken
        // before rejecting. Symmetric with the legacyToken/?token= branch
        // above; same lookup, same room key, just sourced from the header.
        const resolvedUserId = await validateToken(ticket);
        if (!resolvedUserId) {
          console.log(`[Relay] Rejecting connection — invalid bearer ${redactToken(ticket)}`);
          try { ws.close(4401, 'invalid_token'); } catch (e) {}
          return;
        }
        authVia = 'legacy-token-bearer';
        userId = resolvedUserId;
        phoneToken = ticket;
      }
    } else {
      console.log('[Relay] Rejecting connection — no auth in query/header');
      try { ws.close(4401, 'invalid_token'); } catch (e) {}
      return;
    }

    // ── Relay entitlement chokepoint (2026-07-27) — THE MONEY GATE ────────────
    //
    // Every admission path above (?token= legacy phoneToken, Authorization:
    // Bearer phoneToken, and ?ticket= JWT — browser AND phone/APK) funnels
    // through this single check, so the relay can NEVER admit an unentitled peer.
    // This closes the broken-access-control leak: a logged-in-but-unpaid user who
    // grabbed their phoneToken could open this WS and drive the phone for free
    // indefinitely because server.js had no entitlement check at all.
    //
    // Uses the EXACT decision logic the browser gate uses (lib/entitlement-core.js,
    // required by both this plain-Node server and the TS layer) — no drift.
    //
    // Fail-SAFE for admin + allowlist: evaluateUserEntitlement → evaluateEntitlement
    // rules (1)/(2) short-circuit to allowed for Dennis (isAdmin) and the
    // ENTITLEMENT_ALLOWLIST emails regardless of subscription state, so a paying
    // user's phone bridge and Dennis/reviewer access are never blocked.
    // Fail-CLOSED on the money path: a missing user row OR a DB throw returns
    // allowed:false ⇒ the upgrade is REJECTED (this IS the paywall, unlike the
    // UX-only proxy which may fail open).
    const ent = await evaluateUserEntitlement(db, userId);
    if (!ent.allowed) {
      console.log(`[Relay] Rejecting connection — not entitled (user=${userId} via ${authVia} reason=${ent.reason})`);
      try { ws.close(4403, 'subscription_required'); } catch (e) {}
      return;
    }

    const token = phoneToken;
    ws.userId = userId;
    ws.phoneToken = token;
    ws.authVia = authVia;
    // Cache the tier + limits from the SAME admission entitlement result
    // (2026-07-27, dispatch feature/tier-gating) so the browser→phone frame gate
    // reads them WITHOUT a second DB lookup. evaluateUserEntitlement decorated
    // `ent` with tier/limits (fail-closed → Solo on any error). Defensive
    // fallbacks keep the relay working even if a future core change omits them.
    ws.tier = ent.tier || 'solo';
    ws.tierLimits =
      ent.limits && typeof ent.limits === 'object'
        ? ent.limits
        : { templates: 3, quickReplies: 1, syncRangeMax: '30d', contactSync: false };
    // F-A: only browser sessions (relay-ticket) are subject to the
    // single-active-session kick. Phone sockets (legacy-token /
    // legacy-token-bearer) are NEVER indexed and NEVER kicked.
    //
    // forge/chrome-extension-p1 (2026-09-02): a `?role=listener` peer (the
    // extension SW) is ALSO never indexed. Indexing is what SESSION_SUPERSEDED
    // walks (userIdToWebSockets) — a listener is a SECOND browser-side socket
    // for the same user and must neither be kicked by, nor trigger, the
    // single-active-web-session kill switch. It is passive; the user's real web
    // session (popup/tab) remains the one true indexed session.
    if (authVia === 'relay-ticket' && !isListener) {
      indexWebSocket(userId, ws);
    }
    console.log(`[Relay] Connection authed user=${userId} via ${authVia} room=${redactToken(token)}`);

    const room = getRoom(token);

    // Resolve the connecting peer's IP. req.socket.remoteAddress may be
    // IPv6-mapped (::ffff:192.168.x.x) — strip the prefix. Used in
    // PAIRING_REQUEST so the user sees the actual origin on their phone.
    const rawIp = req.socket?.remoteAddress || '';
    const peerIp = rawIp.replace(/^::ffff:/, '').trim() || 'unknown';

    // ---- PHONE PATH ---------------------------------------------------------
    if (pathname === '/phone') {
      ws.role = 'phone';
      // F-C (2026-05-29): replaced one-shot isAlive boolean with a missed-pong
      // counter. We terminate at >=2 missed pongs (~30s tolerance @ 15s tick)
      // instead of 1. Cellular phones routinely miss one ping on background-
      // app transitions or carrier handoff; killing the socket on a single
      // miss caused user-visible disconnect blips even when the line was fine.
      // Any inbound DATA frame ALSO resets the counter (live traffic is
      // stronger proof of liveness than a pong).
      ws.missedPongs = 0;
      ws.deviceName = null;
      // T-RESUME-PHONE-RESTART-DESYNC. Stashed BEFORE room.lobby.add, because
      // tryAutoResume finds this socket by walking room.lobby and reads the
      // declaration off it. Set on every phone socket, including the ones that
      // declared nothing — the shape is uniform so the gate never has to guess
      // whether a missing field means "old APK" or "we forgot to set it".
      ws.phoneSession = phoneSession;
      room.lobby.add(ws);

      const lobbyCounts = countLobby(room);
      console.log(`[Relay][${redactToken(token)}] Phone joined lobby (browsers=${lobbyCounts.browsers}, active=${!!room.active.phone})`);

      // Issue 3: a phone returning within the resume window re-links
      // silently. Attempted BEFORE any lobby messaging — on resume the
      // PAIRING_ACTIVE frame REPLACES LOBBY_STATUS for this socket, so the
      // client never sees a lobby frame that could race its active state.
      // NOTE: this is the ONLY silent re-form path — armed by socket_closed
      // only (a <=30s blip). A genuinely torn-down pair re-forms ONLY via an
      // explicit Connect + Accept handshake (known-device relink removed
      // 2026-07-16, Fix 1).
      const phoneResumed = tryAutoResume(room);

      if (!phoneResumed) {
        // 1. Tell the phone how many browsers are already waiting in this
        //    lobby so its UI can render an "approve incoming" affordance
        //    (if browserCount > 0) or "waiting for desktop" (if 0).
        safeSend(ws, `LOBBY_STATUS:${JSON.stringify({ browserCount: lobbyCounts.browsers })}`);
      }
      // F-5 (2026-05-29): HELLO frame's hostname value is the only place the
      // container's real OS hostname leaked to clients. APK only matches on
      // `HELLO:` prefix — value is decorative. Use a stable literal to avoid
      // exposing infra naming (container/host names show up in support pings
      // and bug reports). Kept the frame for backward-compat with APK <=v29.
      safeSend(ws, `HELLO:${JSON.stringify({ hostname: 'computercaller' })}`);

      if (!phoneResumed) {
        // 2. Tell every browser in the lobby a phone just showed up. Drives
        //    the Connect button visibility on the browser side. Skipped on
        //    resume — the phone went straight to active, lobby browsers
        //    (there are none involved in the resumed pair) must not be told
        //    a pairable phone is present.
        broadcastToLobbyBrowsers(room, `PHONE_PRESENT:${JSON.stringify({})}`);
      }
      // FORGE-O: and unconditionally tell listeners the new truth — INCLUDING on
      // the `phoneResumed` path, which deliberately skips PHONE_PRESENT above.
      // That skip is exactly the "KNOWN GAP" the worker documented and papered
      // over with a catch-all that promoted any data frame to green; a resumed
      // phone is now reported properly (phonePresent AND paired) instead of
      // being inferred from traffic.
      broadcastPairState(room);

      ws.on('message', (data) => {
        // F-C: inbound traffic is liveness proof. Reset before the body runs.
        ws.missedPongs = 0;
        // F-D (2026-05-29): wrap each handler branch body in try/catch so a
        // throw inside (e.g. forwardDataPlane sees a closing peer, JSON parse
        // explodes, handleAcceptPairing hits an unexpected state) logs and
        // drops THE FRAME — not the socket. The 'ws' lib bubbles handler
        // exceptions up to the connection and tears it down; we don't want
        // a bad single message to evict a healthy peer.
        const msg = data.toString();
        rlog(`[Relay][${redactToken(token)}] Phone -> ${frameLabel(msg)}`);

        // DEVICE_INFO is special — capture deviceName so a subsequent
        // PAIRING_ACTIVE can include it. Phones send DEVICE_INFO inside
        // an active session for stateful UI, but the frame can also arrive
        // pre-pairing depending on APK timing; in that case we just stash
        // the name and drop the frame (no data-plane forwarding allowed
        // from the lobby).
        if (msg.startsWith('DEVICE_INFO:')) {
          try {
            try {
              const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
              if (payload?.deviceName) ws.deviceName = String(payload.deviceName).slice(0, 128);
              console.log(`[Relay][${redactToken(token)}] Phone device name: ${ws.deviceName}`);
            } catch (e) { /* ignore malformed payload */ }
            // deviceName is captured on ws above so PAIRING_ACTIVE can carry it.
            // No silent relink here (removed 2026-07-16, Fix 1) — a rejoining
            // phone re-pairs only via explicit Connect + Accept.
            if (ws === room.active.phone) {
              forwardDataPlane(room, ws, msg);
            }
          } catch (err) {
            console.error(`[Relay][${redactToken(token)}] DEVICE_INFO handler crashed: ${err.message}`);
          }
          return;
        }

        // Control plane — pairing handshake responses.
        if (msg.startsWith('ACCEPT_PAIRING:')) {
          try {
            const payload = JSON.parse(msg.substring('ACCEPT_PAIRING:'.length));
            handleAcceptPairing(room, ws, payload);
          } catch (e) {
            console.log(`[Relay][${redactToken(token)}] ACCEPT_PAIRING handler dropped frame: ${e.message}`);
          }
          return;
        }
        if (msg.startsWith('DECLINE_PAIRING:')) {
          try {
            const payload = JSON.parse(msg.substring('DECLINE_PAIRING:'.length));
            handleDeclinePairing(room, ws, payload);
          } catch (e) {
            console.log(`[Relay][${redactToken(token)}] DECLINE_PAIRING handler dropped frame: ${e.message}`);
          }
          return;
        }
        // Control plane — explicit user-leaves-pair signal from the phone
        // (APK Disconnect button, v20+). Symmetric to the browser-side
        // handler below. terminateActivePair will broadcast
        // PAIRING_TERMINATED:{reason:'user_left'} to the browser so its UI
        // flips back to the lobby state.
        if (msg.startsWith('LEAVE_ACTIVE:')) {
          try {
            // T-RESUME-PHONE-RESTART-DESYNC. During a SURVIVOR HOLD the phone
            // is, by definition, not in room.active.phone — it is the side that
            // dropped. The strict `ws === room.active.phone` test therefore
            // turned the user's own Disconnect into
            // "LEAVE_ACTIVE from non-active phone — ignored" for the full 180 s
            // of the hold, which is the three minutes of nothing Dennis saw.
            //
            // A held pair is still this room's pair and the phone is still a
            // party to it, so the Disconnect is HONOURED and tears the hold
            // down. The ignored branch keeps exactly its original job: a phone
            // that is in no active pair and no live hold cannot end one.
            const claim = room.resumable;
            const claimLive = !!claim && Date.now() <= claim.expiresAt;
            // Security MINOR 4 (ack 2026-09-25): the hold branch must honour
            // only the phone the hold is ABOUT. There is no stable phone
            // deviceId on this wire (`?deviceId=` is listener-only and
            // ws.deviceName is self-declared), and the sender is a NEW socket
            // from the redial, so the sound discriminator is cardinality: the
            // sender is honoured only when it is the SOLE phone socket in the
            // room — the only candidate tryAutoResume could pick. A second
            // same-account handset in the lobby makes the room ambiguous and
            // is refused. See lib/resumeGate-core.js for the full reasoning.
            let roomPhoneCount = 0;
            for (const s of room.lobby) {
              if (s.role === 'phone' && s.readyState === WebSocket.OPEN) roomPhoneCount += 1;
            }
            if (room.active.phone && room.active.phone.readyState === WebSocket.OPEN
              && !room.lobby.has(room.active.phone)) roomPhoneCount += 1;
            const senderIsSoleRoomPhone = roomPhoneCount === 1
              && ws.readyState === WebSocket.OPEN;
            const honoured = leaveActiveHonouredDuringHold({
              isActivePhone: ws === room.active.phone,
              claimLive,
              claimDroppedRole: claim ? claim.droppedRole : null,
              survivorPresent: !!(room.active.browser || room.active.phone),
              senderIsSoleRoomPhone,
            });
            if (honoured) {
              if (ws !== room.active.phone) {
                console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE from a phone under a survivor hold — HONOURED (droppedRole=${claim.droppedRole})`);
              }
              terminateActivePair(room, 'user_left');
            } else if (claimLive && claim.droppedRole === 'phone' && !senderIsSoleRoomPhone) {
              // The MINOR-4 refusal, logged distinctly from the historical one:
              // this phone would have torn down a hold it may not be a party to.
              console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE under a phone-dropped hold from one of ${roomPhoneCount} phone sockets — ignored (sender not identifiable as the held phone)`);
            } else {
              console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE from non-active phone — ignored`);
            }
          } catch (e) {
            console.error(`[Relay][${redactToken(token)}] LEAVE_ACTIVE handler crashed: ${e.message}`);
          }
          return;
        }

        // FILE TRANSFER (FT-1). Handled BEFORE the listener mirror and before
        // the active-pair data plane, by the same function the browser branch
        // calls — phone→PC and PC→phone go through ONE gate, which is the only
        // way the tier/quota check cannot end up fail-open on one side.
        //
        // Deliberately ABOVE broadcastToListeners: a 1 GB transfer is ~21 800
        // chunks, and mirroring every one of them into every passive extension
        // SW would be a bandwidth multiplier into exactly the context that MV3
        // evicts mid-stream. A listener is a notification surface, not a file
        // sink; the receiving extension participates as the ACTIVE browser.
        if (isFileFrame(msg)) {
          try {
            if (handleFileFrame(room, ws, msg, 'phone', token)) return;
          } catch (e) {
            console.error(`[Relay][${redactToken(token)}] FILE frame handler crashed: ${e.message}`);
            return;
          }
        }

        // BATTERY (BAT-2 (a), BAT-A1 MUSTs 1-3). Gated ABOVE the listener
        // mirror so one verdict covers every recipient — passive extension SWs,
        // the active browser and the resume passthrough alike. A frame that
        // survives the gate is forwarded VERBATIM by the code below; nothing
        // here rewrites it.
        if (isBatteryFrame(msg) && batteryGate(room, ws, msg, 'phone', token)) return;

        // forge/chrome-extension-p1: mirror EVERY phone-originated data frame to
        // passive listeners (extension SWs) BEFORE the active-pair gate, so the
        // background SW fires notifications for incoming calls/SMS even when the
        // popup is closed or the pair is momentarily unformed. Listeners are
        // receive-only and same-user, so this neither mutates room state nor
        // leaks across tenants. Control frames from the phone (LEAVE_ACTIVE, etc.)
        // already returned above; only data frames reach here.
        if (ws.phoneToken === room.token) {
          broadcastToListeners(room, msg);
        }

        // Data plane — only allowed when this socket is the active phone.
        if (ws === room.active.phone) {
          try {
            if (!forwardDataPlane(room, ws, msg)) {
              rlog(`[Relay][${redactToken(token)}] Phone data frame dropped — no active browser`);
            }
          } catch (e) {
            console.error(`[Relay][${redactToken(token)}] forwardDataPlane crashed: ${e.message}`);
          }
          return;
        }

        // Live-sync resume fix (2026-06-16). A data frame arriving from a phone
        // still in the LOBBY while a soft-held survivor browser is waiting means
        // the pair hasn't re-formed yet — the phone re-attached but tryAutoResume
        // didn't fire because the two roles missed each other's lobby window.
        // Bug A: this branch used to silently DROP such frames (live SMS / call-
        // log entries lost). Instead:
        //   1. Try to re-form the pair NOW (this returning phone IS present, and
        //      the survivor browser is held in active). On success the phone
        //      becomes room.active.phone and we forward through the normal pair.
        //   2. If still unpaired but a survivor browser is held under a live
        //      resume claim, forward the frame to that survivor (armed-window
        //      passthrough) so nothing is lost during the gap.
        // Skipped entirely in the LEGACY_RESUME_TEARDOWN path (no soft-hold, so
        // there is no held survivor to forward to — preserve old drop behavior).
        if (!LEGACY_RESUME_TEARDOWN && deliverLobbyFrameDuringResume(room, ws, msg, 'phone', token)) {
          return;
        }

        // Frame from a lobby phone with no active opposite peer.
        //
        // Fix 2 (2026-07-16): if a resume claim is armed (a <=30s socket blip,
        // the soft-hold window), BUFFER the frame instead of dropping it — it
        // will be replayed in order to the browser when tryAutoResume re-forms
        // the pair. Bounded hard at FRAME_BUFFER_MAX (drop-oldest on overflow)
        // to protect memory. The browser's existing dedup (notification-key /
        // message-id) absorbs any overlap with its quick-sync backfill.
        //
        // If NO claim is armed the pair is genuinely torn down — keep the
        // historical drop+log. A fresh Connect+Accept triggers the web
        // quick-sync backfill, so buffering a dead pair is pointless.
        const claim = room.resumable;
        if (claim && Date.now() <= claim.expiresAt) {
          // FT-1 (c): FILE_* frames NEVER enter the replay buffer.
          //
          // frameBuffer is a 200-ENTRY (not byte-bounded) replay buffer whose
          // whole job is to preserve real messages across a socket blip. A
          // single 1 GB transfer is ~21 800 chunks; even a 25 MB one is 534.
          // Either would flush every SMS, notification and call-log entry out of
          // a 200-slot buffer in under a second — the classic shape-keyed
          // failure, where a size-blind buffer is silently emptied by a big
          // payload and the feature it exists for stops working with no error
          // anywhere. Chunks are also worthless to replay: the transfer's own
          // FILE_RESUME protocol (deliverable (d)) is how a blip is recovered,
          // and a chunk replayed out of that protocol's sight would corrupt the
          // receiver's offset.
          //
          // Classified with frameType() via isFileFrame(), never startsWith():
          // startsWith('FILE_') would also swallow a future FILE_-prefixed frame
          // nobody meant to exclude, and frameType() is the already-validated
          // classifier every redaction site in this file trusts.
          if (isFileFrame(msg)) {
            ftCountDrop(token, frameType(msg), 'not_buffered');
            rlog(`[Relay][${redactToken(token)}] FILE frame NOT buffered during resume window: ${frameLabel(msg)}`);
            return;
          }
          // BAT-2 (a) / BAT-A1 MUST-3: BATTERY never enters the replay buffer
          // either — same exemption class as HB, for a different reason than
          // FILE_*. A battery reading is a SNAPSHOT, not an event: replaying a
          // 30-second-old one on resume paints a stale percentage over a fresh
          // reading the phone is about to send anyway (it re-sends BATTERY
          // immediately on every (re)connect, PLAN.md cadence (1)). Losing it
          // here costs nothing; replaying it shows the user a wrong number.
          if (isBatteryFrame(msg)) {
            batteryCountDrop(token, 'battery_not_buffered');
            rlog(`[Relay][${redactToken(token)}] BATTERY NOT buffered during resume window: ${frameLabel(msg)}`);
            return;
          }
          if (!room.frameBuffer) room.frameBuffer = [];
          room.frameBuffer.push({ msg, at: Date.now() });
          if (room.frameBuffer.length > FRAME_BUFFER_MAX) room.frameBuffer.shift();
          rlog(`[Relay][${redactToken(token)}] Buffered lobby-phone frame during resume window (buffer=${room.frameBuffer.length}): ${frameLabel(msg)}`);
          return;
        }
        // Counted by type, not just printed — see countDroppedLobbyFrame.
        // NOTE for anyone reading a log full of these: NOTIFICATION_PERMISSION
        // and PERMISSIONS_STATUS are PERMISSION-STATE frames, not notifications.
        // Dropping them does NOT drop a user's notification, and it cannot make
        // a delivered notification un-replyable — `hasReply`/`replyKey` travel
        // inside the PHONE_NOTIFICATION frame itself, and there is no backfill
        // path that re-materialises a notification without them.
        const dropStat = countDroppedLobbyFrame(token, msg);
        console.log(
          `[Relay][${redactToken(token)}] Dropping lobby-phone frame: bytes=${Buffer.byteLength(msg, 'utf8')} ` +
          `(type=${dropStat.type} count=${dropStat.n}; room totals: ${dropStat.summary})`,
        );
      });

      ws.on('close', (closeCode, closeReason) => {
        // OBSERVABILITY (2026-08-10): capture the WS close code + reason.
        //
        // This is the single field that would have discriminated a
        // client-initiated close (1000/1001 — app backgrounded, user left) from
        // a keepalive timeout (1006 — no close frame ever arrived, the classic
        // background-kill signature) from a server/proxy close (1012/1013).
        // Every prior `socket_closed` line recorded NEITHER, so a device being
        // killed by the OS and a user tapping Disconnect looked identical.
        // Stashed on the socket so terminateActivePair can report it too.
        ws.closeCode = closeCode;
        ws.closeReason = decodeCloseReason(closeReason);
        logIfOverMaxPayload(ws, token);
        // F-A: defensive — phone branch will not have indexed itself, but
        // unindex is a no-op when absent.
        if (ws.authVia === 'relay-ticket') unindexWebSocket(ws.userId, ws);
        room.lobby.delete(ws);
        const wasActive = (ws === room.active.phone);
        const wasPendingPhone = !!room.pendingPairing && room.pendingPairing.phoneWs === ws;
        // PAIRING_CANCELLED to the browser if the phone closed while a
        // request was waiting for its answer.
        if (room.pendingPairing && wasPendingPhone) {
          const pending = room.pendingPairing;
          clearPendingPairing(room);
          safeSend(pending.browserWs, `PAIRING_TIMEOUT:${JSON.stringify({})}`);
        }
        if (wasActive) {
          terminateActivePair(room, 'socket_closed');
        } else {
          // Lobby phone leaving — tell remaining lobby browsers to hide the
          // Connect affordance if this was the last LIVE phone anywhere in
          // the room. Fix (2026-06-17): was `countLobby(room).phones === 0`,
          // which counted stale/dead duplicate lobby sockets (a device that
          // opened a 2nd WS before this close fired) and ignored any active
          // phone — so the button stayed blue. countLivePhones / the helper
          // is liveness-gated and spans lobby+active, and we exclude THIS
          // closing socket so a not-yet-observed delete can't mask absence.
          broadcastPhoneAbsentIfLastPhoneGone(room, ws);
        }
        console.log(`[Relay][${redactToken(token)}] Phone disconnected (was_active=${wasActive}, code=${ws.closeCode ?? '?'}, reason="${ws.closeReason ?? '?'}")`);
        maybeReapRoom(room);
      });

      ws.on('error', (err) => {
        console.log(`[Relay][${redactToken(token)}] Phone error: ${err.message}`);
      });

      ws.on('pong', () => {
        ws.missedPongs = 0;
        rlog(`[Relay][${redactToken(token)}] Phone pong received`);
      });

      return;
    }

    // ---- BROWSER PATH -------------------------------------------------------
    ws.role = 'browser';
    // forge/chrome-extension-p1: mark passive listeners. A listener sits in the
    // lobby forever, is never promoted to room.active.browser, never sends
    // control/data frames (see the receive-only short-circuit in its message
    // handler), and receives phone→browser data frames via broadcastToListeners.
    ws.listener = !!isListener;
    // Only meaningful on a listener; left null everywhere else so no other code
    // path can start depending on it.
    ws.deviceId = isListener ? (listenerDeviceId ?? null) : null;
    // F-C: see phone-path note. Same counter semantics on the browser side.
    ws.missedPongs = 0;
    room.lobby.add(ws);
    if (ws.listener) {
      console.log(`[Relay][${redactToken(token)}] Listener (extension SW) joined lobby — receive-only (deviceId=${ws.deviceId ?? '-'})`);
    }

    const counts = countLobby(room);
    const alreadyActive = !!(room.active.browser || room.active.phone);
    // `claim` tells the dock story in one line: a browser joining with NO
    // armed claim while a pair is already active is the first half of a dock
    // (panel opens before the pop-out closes); the resume for it now happens
    // at arm time in terminateActivePair, not here.
    const joinClaim = room.resumable ? `armed(droppedRole=${room.resumable.droppedRole})` : 'none';
    console.log(`[Relay][${redactToken(token)}] Browser joined lobby (phones=${counts.phones}, active=${alreadyActive}, listener=${ws.listener}, claim=${joinClaim})`);

    // Issue 3: a browser returning within the resume window (its WS layer
    // auto-reconnects) re-links silently. Attempted BEFORE LOBBY_STATUS —
    // on resume PAIRING_ACTIVE REPLACES LOBBY_STATUS for this socket so the
    // web hook never processes a 'lobby' frame after going active.
    // Only the socket_closed soft-hold resume can silently re-form here; a
    // torn-down pair requires an explicit Connect + Accept (Fix 1).
    if (!tryAutoResume(room)) {
      // Tell the browser whether it can act on the Connect button right away
      // and whether an active pair already exists in this room (browser will
      // render distinct copy in that case).
      safeSend(ws, `LOBBY_STATUS:${JSON.stringify({
        phonePresent: counts.phones > 0,
        alreadyActive,
      })}`);
    }

    // FORGE-O: the false-green origin, stated exactly. In Ken's 09:57 capture the
    // listener joined a room holding a lobby phone and NO active pair, got
    // `LOBBY_STATUS:{phonePresent:true, alreadyActive:false}`, and painted green
    // off `phonePresent` — for minutes, while nothing could be dialled or texted.
    // A joining listener now also gets the full truth, so its FIRST paint is
    // correct rather than a presence-shaped guess it has to walk back later.
    // Sent unconditionally (outside the tryAutoResume branch above): a listener
    // is never promoted by tryAutoResume, so it must be told either way.
    if (ws.listener) broadcastPairState(room);

    ws.on('message', async (data) => {
      // F-C: inbound traffic is liveness proof. Reset before the body runs.
      ws.missedPongs = 0;
      // F-D: same try/catch envelope as the phone branch — drop frame on
      // handler throw, keep socket alive.
      // ASYNC (2026-08-28, forge/free-tier-p1): the handler is async so the
      // free-tier daily-cap gate can await an atomic DB check-and-increment
      // before forwarding MAKE_CALL/SEND_SMS. Every OTHER frame path has no
      // await and runs exactly as before (synchronously to its `return`); the
      // ws 'message' listener ignores the returned promise.
      const msg = data.toString();
      // forge/chrome-extension-p1: listeners are strictly receive-only. Drop any
      // frame they send (they should send none) BEFORE it can reach pairing,
      // LEAVE_ACTIVE, or the data plane — a listener must never mutate room
      // state. missedPongs was already reset above, so its liveness still counts.
      if (ws.listener) {
        return;
      }
      rlog(`[Relay][${redactToken(token)}] Browser -> ${frameLabel(msg)}`);

      // Control plane — pairing kickoff.
      if (msg.startsWith('BROWSER_REQUEST_PAIRING:')) {
        try {
          const payload = JSON.parse(msg.substring('BROWSER_REQUEST_PAIRING:'.length));
          handleBrowserRequestPairing(room, ws, payload, peerIp);
        } catch (e) {
          console.log(`[Relay][${redactToken(token)}] BROWSER_REQUEST_PAIRING handler dropped frame: ${e.message}`);
        }
        return;
      }
      // Control plane — explicit user-leaves-pair signal.
      if (msg.startsWith('LEAVE_ACTIVE:')) {
        try {
          if (ws === room.active.browser) {
            terminateActivePair(room, 'user_left');
          } else {
            console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE from non-active browser — ignored`);
          }
        } catch (e) {
          console.error(`[Relay][${redactToken(token)}] LEAVE_ACTIVE handler crashed: ${e.message}`);
        }
        return;
      }
      // Control plane — "Reset lobby" (dispatch FORGE-J, 2026-09-15).
      //
      // Unlike LEAVE_ACTIVE this is NOT gated on `ws === room.active.browser`.
      // That gate is exactly why Disconnect cannot rescue a wedged room: the
      // states a user reaches for Reset from — a phantom phone in the lobby, a
      // pendingPairing that will not resolve, a browser that never got promoted
      // — are precisely the states where this socket is NOT the active browser.
      // The authorisation that matters already happened at the WS upgrade: this
      // socket authenticated into THIS room (its phoneToken IS the room key), so
      // it can only ever reset its own user's room. Listeners are excluded by
      // the receive-only short-circuit far above (`if (ws.listener) return`)
      // before any frame reaches here — a passive extension SW must never
      // mutate room state, and least of all destroy it.
      if (msg.startsWith('RESET_ROOM:')) {
        try {
          const gate = resetRateLimiter.check(ws.userId);
          if (!gate.allowed) {
            console.log(`[Relay][${redactToken(token)}] RESET_ROOM rate-limited (retry in ${gate.retryAfterMs}ms)`);
            safeSend(ws, `RESET_ROOM_ACK:${JSON.stringify({ ok: false, reason: 'rate_limited', retryAfterMs: gate.retryAfterMs })}`);
            return;
          }
          // ACK BEFORE the teardown: doResetRoom closes this very socket, so an
          // ack queued afterwards would be written to a CLOSING socket and
          // dropped. The client treats ack-then-close and close-alone
          // identically (both route to "reconnect"), but the ack is what lets it
          // distinguish a served reset from a network failure.
          safeSend(ws, `RESET_ROOM_ACK:${JSON.stringify({ ok: true })}`);
          doResetRoom(token, 'frame');
        } catch (e) {
          console.error(`[Relay][${redactToken(token)}] RESET_ROOM handler crashed: ${e.message}`);
        }
        return;
      }

      // FILE TRANSFER (FT-1) — the mirror image of the phone branch above, same
      // function, same gate. Placed ahead of gateBrowserSyncFrame and the
      // tier gate because it does not match a FILE_* frame (gateBrowserSyncFrame
      // passes anything that is not GET_CONTACTS / GET_MESSAGES /
      // GET_CALL_LOGS) — running a 21 800-chunk stream through it only to be
      // told "pass" once per chunk is work with no decision attached to it.
      // (It also used to sit ahead of the free-tier outbound meter, removed
      // 2026-09-21 by trial-caps-purge.)
      //
      // Passive listeners never reach here: the `if (ws.listener) return` far
      // above short-circuits them, so a receive-only extension SW cannot open,
      // accept or feed a transfer.
      // BATTERY is phone->browser ONLY (BAT-A1 MUST-1). A browser socket has no
      // business originating one; there is no GET_BATTERY and the phone pushes.
      // Dropped and counted here, never forwarded to the phone.
      if (isBatteryFrame(msg) && batteryGate(room, ws, msg, 'browser', token)) return;

      if (isFileFrame(msg)) {
        try {
          if (handleFileFrame(room, ws, msg, 'browser', token)) return;
        } catch (e) {
          console.error(`[Relay][${redactToken(token)}] FILE frame handler crashed: ${e.message}`);
          return;
        }
      }

      // Tier gate (2026-07-27) — enforce contact-sync + sync-range on the
      // browser→phone sync frames BEFORE they are forwarded to the phone. This
      // is the ONLY server chokepoint for these (sync is WS, not REST), so it
      // must be server-authoritative. Non-sync frames pass through unchanged;
      // see gateBrowserSyncFrame. Applied to BOTH the active-pair forward and
      // the resume passthrough below so a clamped/dropped frame can't sneak
      // through either path.
      let forwardMsg = msg;
      {
        const gate = gateBrowserSyncFrame(ws, msg);
        if (gate.action === 'drop') {
          rlog(`[Relay][${redactToken(token)}] Tier-gated frame DROPPED (tier=${ws.tier} reason=${gate.reason}): ${frameLabel(msg)}`);
          return;
        }
        if (gate.action === 'clamp') {
          rlog(`[Relay][${redactToken(token)}] Tier-clamped since (tier=${ws.tier} floor=${gate.floor}): ${frameLabel(msg)}`);
          forwardMsg = gate.msg;
        }
      }

      // Data plane — only allowed when this socket is the active browser.
      if (ws === room.active.browser) {
        // No outbound metering here (trial-caps-purge 2026-09-21). MAKE_CALL /
        // SEND_SMS are forwarded like any other data frame; the tier gate above
        // still applies to the sync frames it owns.
        try {
          if (!forwardDataPlane(room, ws, forwardMsg)) {
            rlog(`[Relay][${redactToken(token)}] Browser data frame dropped — no active phone`);
          }
        } catch (e) {
          console.error(`[Relay][${redactToken(token)}] forwardDataPlane crashed: ${e.message}`);
        }
        return;
      }

      // Live-sync resume fix (2026-06-16) — symmetric to the phone branch.
      // A frame from a lobby browser while a soft-held survivor phone is waiting
      // means the pair hasn't re-formed yet. Re-form now, or passthrough to the
      // held survivor phone, instead of dropping (Bug A, browser→phone half).
      //
      // The free-tier meter that used to sit here (so a capped MAKE_CALL /
      // SEND_SMS could not be slipped through mid-reconnect) is gone with the
      // caps themselves — trial-caps-purge 2026-09-21.
      if (!LEGACY_RESUME_TEARDOWN) {
        if (deliverLobbyFrameDuringResume(room, ws, forwardMsg, 'browser', token)) {
          return;
        }
      }

      // Anything else from a lobby browser (e.g. legacy CONNECT_TO from a
      // stale tab, stray data frames) with no armed resume window. Drop + log.
      console.log(`[Relay][${redactToken(token)}] Dropping lobby-browser frame: ${frameLabel(msg)}`);
    });

    ws.on('close', (closeCode, closeReason) => {
      // Same capture as the phone branch — a browser close code distinguishes a
      // tab being closed (1001) from a network drop (1006), which matters when
      // deciding whether a viewport-driven remount could be tearing the socket
      // down. See the phone handler for the full rationale.
      ws.closeCode = closeCode;
      ws.closeReason = decodeCloseReason(closeReason);
      logIfOverMaxPayload(ws, token);
      // F-A: scrub the userId → ws index so the next supersede call doesn't
      // try to re-kick a half-closed socket.
      if (ws.authVia === 'relay-ticket') unindexWebSocket(ws.userId, ws);
      room.lobby.delete(ws);
      const wasActive = (ws === room.active.browser);
      const wasPendingBrowser = !!room.pendingPairing && room.pendingPairing.browserWs === ws;
      if (wasPendingBrowser) {
        // Browser bailed mid-handshake — tell the phone to drop the prompt.
        const pending = room.pendingPairing;
        clearPendingPairing(room);
        // The phone is still in the lobby (the request didn't move it),
        // so we need to find it via the pending record-side data: we don't
        // store the phoneWs on pending, so just broadcast PAIRING_CANCELLED
        // to all lobby phones. There's at most one phone per room in the
        // realistic case.
        broadcastToLobbyPhones(room, `PAIRING_CANCELLED:${JSON.stringify({ pairingId: pending.id })}`);
      }
      if (wasActive) {
        terminateActivePair(room, 'socket_closed');
      }
      console.log(`[Relay][${redactToken(token)}] Browser disconnected (was_active=${wasActive}, code=${ws.closeCode ?? '?'}, reason="${ws.closeReason ?? '?'}")`);
      maybeReapRoom(room);
    });

    ws.on('error', (err) => {
      console.log(`[Relay][${redactToken(token)}] Browser error: ${err.message}`);
    });

    ws.on('pong', () => {
      ws.missedPongs = 0;
    });
  });

  // Attach the relay to the shared httpServer via 'upgrade'. We only claim
  // upgrades whose pathname starts with /relay so Next.js HMR sockets
  // (/_next/webpack-hmr, etc.) flow through Next's own upgrade handler
  // untouched. Path layout:
  //   /relay         → browser room socket
  //   /relay/phone   → phone room socket (sign-in mode)
  // The query string (?token=…) is preserved verbatim. Before handing off
  // to the existing connection handler, we strip the /relay prefix from
  // req.url so parseConnection() sees the same pathnames it used to see on
  // the standalone port (/ for browser, /phone for phone).
  function handleRelayUpgrade(request, socket, head) {
    const parsed = parse(request.url || '/', true);
    const pathname = parsed.pathname || '/';
    if (pathname !== '/relay' && pathname !== '/relay/phone') {
      return false;
    }
    const rewritten = pathname === '/relay/phone' ? '/phone' : '/';
    const search = request.url.includes('?')
      ? request.url.slice(request.url.indexOf('?'))
      : '';
    request.url = rewritten + search;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return true;
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const parsed = parse(request.url || '/', true);
    const pathname = parsed.pathname || '/';
    if (pathname === '/relay' || pathname === '/relay/phone') {
      handleRelayUpgrade(request, socket, head);
      return;
    }
    // Anything else (e.g. Next.js HMR) — Next's handler picks it up.
  });

  console.log(`[Relay] Mounted on shared httpServer at /relay (browser) and /relay/phone (sign-in). Connect+Accept lobby model active (dispatch #32).`);

  // Optional backward-compat: ALSO bring up the old standalone listener on
  // RELAY_PORT when LEGACY_RELAY_PORT=1. Same wss instance, just a second
  // entry point. Safe revert path if anything regresses in prod.
  if (LEGACY_RELAY_PORT) {
    const legacyServer = http.createServer();
    legacyServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
    legacyServer.listen(RELAY_PORT, () => {
      console.log(`[Relay] LEGACY_RELAY_PORT=1 — also listening on ws://localhost:${RELAY_PORT} for backward compat.`);
    });
    legacyServer.on('error', (err) => {
      console.error(`[Relay] Legacy listener error: ${err.message}`);
    });
  }

  // Keep every connection alive and detect silent disconnects. We ping
  // both lobby and active sockets — a stale phone in either slot needs to
  // surface as gone so its peers can update.
  //
  // F-C (2026-05-29): two-strike policy. Each tick:
  //   1. terminate any socket whose missedPongs is already >=2
  //   2. otherwise, increment its missedPongs and send a fresh ping
  // 'pong' handler and inbound message handler both reset missedPongs=0.
  // Net effect: a socket must be silent across TWO 15s ticks (>= 30s) before
  // termination, instead of the previous one-tick guillotine.
  const MAX_MISSED_PONGS = 2;
  const keepaliveInterval = setInterval(() => {
    // Connection-stability fix (2026-06-16): expire stale soft-holds. If a
    // resume window lapsed while one side is still held in `active` (the
    // dropped peer never came back), give the survivor a real teardown so it
    // returns to the lobby instead of being held forever against a ghost.
    rooms.forEach((room) => {
      const claim = room.resumable;
      if (!claim) return;
      // ── FORGE-L: panel-close hold ─────────────────────────────────────────
      // Renew a held claim on every tick so the pair survives a closed side
      // panel for as long as the extension itself is there — the extension's
      // equivalent of the web app keeping its tab open. Renewal (rather than a
      // second, parallel deadline) is deliberate: every other reader of a claim
      // already tests `expiresAt` (tryAutoResume, the lobby-frame buffer,
      // maybeReapRoom), so they all inherit the hold with no change. The 15 s
      // tick renews a 180 s window, a 12x margin.
      if (claim.panelHold) {
        const now = Date.now();
        if (hasLiveListener(room)) {
          if (claim.listenerGoneAt !== null) {
            console.log(`[Relay][${redactToken(room.token)}] panel hold: listener back after ${now - claim.listenerGoneAt}ms — pairing kept`);
            claim.listenerGoneAt = null;
          }
          claim.expiresAt = now + RESUME_WINDOW_MS;
          return;
        }
        // No listener right now. An MV3 worker is routinely evicted and
        // replaced (FORGE-J measured a 33.8 s socket-less gap, ~64 s to the
        // replacement's connect), so absence is only meaningful once it has
        // lasted LISTENER_HOLD_GRACE_MS continuously.
        if (claim.listenerGoneAt === null) {
          claim.listenerGoneAt = now;
          console.log(`[Relay][${redactToken(room.token)}] panel hold: no listener — grace started (${LISTENER_HOLD_GRACE_MS}ms)`);
        }
        if (now - claim.listenerGoneAt <= LISTENER_HOLD_GRACE_MS) {
          claim.expiresAt = now + RESUME_WINDOW_MS;
          return;
        }
        // Grace burned — the extension is genuinely gone (browser closed,
        // extension disabled, machine asleep). Drop the hold and let the
        // ordinary expiry below release the pair on this same tick.
        console.log(`[Relay][${redactToken(room.token)}] panel hold: listener absent > ${LISTENER_HOLD_GRACE_MS}ms — releasing pairing`);
        claim.panelHold = false;
        claim.expiresAt = now;
      }
      if (Date.now() <= claim.expiresAt) return;
      const onlyOneActive =
        (!!room.active.browser) !== (!!room.active.phone); // exactly one side held
      if (onlyOneActive) {
        console.log(`[Relay][${redactToken(room.token)}] resume window expired with survivor held — releasing to lobby`);
        room.resumable = null;
        terminateActivePair(room, 'resume_expired');
      } else {
        // No survivor held (both-dropped case) — just let the claim lapse.
        room.resumable = null;
      }
      maybeReapRoom(room);
    });

    const allSockets = [];
    rooms.forEach((room) => {
      room.lobby.forEach((ws) => allSockets.push(ws));
      if (room.active.browser) allSockets.push(room.active.browser);
      if (room.active.phone) allSockets.push(room.active.phone);
    });
    for (const ws of allSockets) {
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      if (typeof ws.missedPongs !== 'number') ws.missedPongs = 0;
      if (ws.missedPongs >= MAX_MISSED_PONGS) {
        console.log(`[Relay] ${ws.role} missed ${ws.missedPongs} heartbeats — terminating stale connection`);
        ws.terminate(); // fires 'close' → cleanup
        continue;
      }
      ws.missedPongs += 1;
      try { ws.ping(); } catch (e) { /* ignore */ }
      // ── MV3 listener heartbeat (dispatch FORGE-J addendum A, 2026-09-15) ──
      //
      // MEASURED, not assumed. With cc_debug tracing and NO debugger attached
      // (Playwright's CDP attach suppresses MV3 eviction, which is why the
      // earlier ext-sw-lifetime-proof harness returned a false negative), the
      // extension's listener worker was evicted TWICE in a 5.5-minute window:
      // boot s61juy died after ~150s, boot fi8wxv replaced it ~64s later. A
      // relay frame pushed into that gap was lost silently — the socket was
      // gone, no ws-close row was ever written (the worker died before its own
      // onclose could run), and frameBuffer does not help because it serves
      // active pairs only, never listeners.
      //
      // The 15s ws.ping() above did NOT prevent it. A protocol-level ping is
      // answered by the browser's WS stack below the JS layer — it fires no
      // event in the worker, so it is not extension activity and does not
      // reset MV3's idle timer. THIS frame is a real text message: it fires
      // sock.onmessage, which is exactly the activity Chrome 116+ documents as
      // extending an extension service worker's life.
      //
      // Scoped to listeners because they are the only sockets owned by a
      // worker Chrome evicts — /app's socket lives in a page. Piggy-backed on
      // this existing 15s loop rather than a new timer: 15s < the 30s idle
      // window with a full tick of margin, and it costs one extra frame per
      // listener per tick and nothing else.
      //
      // The SW answers nothing. A reply would prove liveness to US, but the
      // problem is keeping the worker ALIVE, and it is the INBOUND frame that
      // does that — an ack would be pure wire noise.
      if (ws.role === 'browser' && ws.listener) {
        try { safeSend(ws, `HB:${JSON.stringify({})}`); } catch (e) { /* ignore */ }
      }
    }
  }, 15000);

  wss.on('close', () => {
    clearInterval(keepaliveInterval);
  });

  wss.on('error', (err) => {
    console.error(`[Relay] Server error: ${err.message}`);
  });

  // F-B (2026-05-29) — Graceful drain on deploy.
  //
  // Coolify rolling deploys send SIGTERM to the old container before swapping
  // it for the new one. Without this handler the close manifests on the
  // client as a hard transport error (code 1006) — indistinguishable from a
  // phone going to sleep, which made every deploy look like the phone
  // disconnected. With the SERVER_RESTART frame + close 1012 the client knows
  // it's a deploy and reconnects calmly (WIRE-CONTRACT.md §2 + §3 RETRY).
  //
  // Idempotent — multiple SIGTERMs (or SIGINT in dev) collapse to one drain.
  // 400ms flush window: enough for a TLS-layer SERVER_RESTART frame to clear
  // the socket buffer on a slow link, short enough that Coolify's 10s SIGKILL
  // timer never triggers. process.exit(0) is the success path.
  let draining = false;
  function gracefulDrain(signal) {
    if (draining) return;
    draining = true;
    console.log(`[Relay] ${signal} received — draining ${userIdToWebSockets.size} indexed users, broadcasting SERVER_RESTART`);
    const allSockets = [];
    rooms.forEach((room) => {
      room.lobby.forEach((ws) => allSockets.push(ws));
      if (room.active.browser) allSockets.push(room.active.browser);
      if (room.active.phone) allSockets.push(room.active.phone);
    });
    const frame = `SERVER_RESTART:${JSON.stringify({})}`;
    for (const ws of allSockets) {
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      try { safeSend(ws, frame); } catch (_) {}
      try { ws.close(1012, 'server_restart'); } catch (_) {}
    }
    // Give the close frames ~400ms to flush before exiting. setTimeout keeps
    // the loop alive long enough for the writes to complete on slow links.
    setTimeout(() => {
      try { clearInterval(keepaliveInterval); } catch (_) {}
      console.log('[Relay] Drain complete — exiting');
      process.exit(0);
    }, 400);
  }
  // Guard against double-binding under hot reload. We tag the listener on
  // the function object itself so subsequent startRelay() invocations skip
  // re-registration. (Process-wide flag — not per-wss — because process
  // signals are global.)
  function sigtermListener() { gracefulDrain('SIGTERM'); }
  function sigintListener() { gracefulDrain('SIGINT'); }
  sigtermListener.__forgeDrain = true;
  sigintListener.__forgeDrain = true;
  if (!process.listeners('SIGTERM').some((fn) => fn.__forgeDrain)) {
    process.on('SIGTERM', sigtermListener);
  }
  if (!process.listeners('SIGINT').some((fn) => fn.__forgeDrain)) {
    // SIGINT (Ctrl-C) in dev gets the same treatment so the local tester
    // sees the SERVER_RESTART path without spinning up a deploy.
    process.on('SIGINT', sigintListener);
  }

  return wss;
}

// ---------------------------------------------------------------------------
// Staging access gate (2026-06-03)
//
// Private preview environment guard for staging.computercaller.com. Active
// ONLY when `process.env.STAGING === 'true'`. When STAGING is unset/false the
// wrapper is a pure pass-through — production runs the same binary and is
// byte-for-byte unaffected (the wrapper short-circuits before touching the
// response).
//
// When STAGING === 'true', every inbound HTTP request:
//   1. Gets `X-Robots-Tag: noindex, nofollow` on the response (keeps the
//      preview out of Google's index even if a link leaks).
//   2. Must carry valid HTTP Basic credentials matching env
//      `STAGING_BASIC_AUTH_USER` / `STAGING_BASIC_AUTH_PASS`. Missing/wrong
//      creds → 401 with `WWW-Authenticate: Basic realm="ComputerCaller Staging"`.
//   3. Carve-outs (bypass auth, still get the noindex header):
//        • /api/health, /health — Coolify/uptime probes. No-op if route
//          doesn't exist (Next.js still returns its own 404, just unauthed).
//      The WebSocket upgrade path is NOT touched by this wrapper — it lives
//      on the same httpServer but `upgrade` is a distinct event handled by
//      startRelay() above. Basic-auth on a WS upgrade would break the phone
//      bridge, so by construction the upgrade path is excluded.
//
// Constant-time compare on equal-length buffers — matches the security bar
// already set by redactToken() / lib/auth.ts.
// ---------------------------------------------------------------------------

const STAGING_GATE_ENABLED = process.env.STAGING === 'true';
const STAGING_BASIC_AUTH_USER = process.env.STAGING_BASIC_AUTH_USER || '';
const STAGING_BASIC_AUTH_PASS = process.env.STAGING_BASIC_AUTH_PASS || '';
const STAGING_HEALTH_PATHS = new Set(['/api/health', '/health']);

function stagingCredsMatch(suppliedUser, suppliedPass) {
  // Length-guard first — timingSafeEqual throws on size mismatch. Comparing
  // the lengths leaks length only, not content, which is acceptable here:
  // an attacker who already knows the expected username/password length is
  // no closer to guessing the secret.
  if (typeof suppliedUser !== 'string' || typeof suppliedPass !== 'string') return false;
  const expU = Buffer.from(STAGING_BASIC_AUTH_USER, 'utf8');
  const expP = Buffer.from(STAGING_BASIC_AUTH_PASS, 'utf8');
  const gotU = Buffer.from(suppliedUser, 'utf8');
  const gotP = Buffer.from(suppliedPass, 'utf8');
  if (gotU.length !== expU.length) return false;
  if (gotP.length !== expP.length) return false;
  // Both compares MUST run regardless of the first result — early-return on
  // user-mismatch would leak via timing which half failed.
  const userOk = crypto.timingSafeEqual(gotU, expU);
  const passOk = crypto.timingSafeEqual(gotP, expP);
  return userOk && passOk;
}

function parseBasicAuthHeader(authHeader) {
  if (typeof authHeader !== 'string') return null;
  if (!authHeader.startsWith('Basic ')) return null;
  const b64 = authHeader.slice('Basic '.length).trim();
  if (!b64) return null;
  let decoded;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/**
 * Apply the staging gate to a single HTTP request. Returns true when the
 * gate has fully handled the response (request must NOT be passed on to
 * Next.js), false when the caller should continue normal handling.
 *
 * No-op (returns false immediately) when STAGING_GATE_ENABLED is false.
 */
function applyStagingGate(req, res) {
  if (!STAGING_GATE_ENABLED) return false;

  // noindex on every response — set it BEFORE any branch can return early,
  // including the 401 path. Search engines that hit the 401 still see the
  // header on the error response.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // Carve-out: health probes bypass the auth check (still get noindex).
  // We parse pathname defensively — a malformed URL shouldn't crash the gate.
  let pathname = '/';
  try {
    pathname = parse(req.url || '/', true).pathname || '/';
  } catch (_) { /* fall through with default */ }
  if (STAGING_HEALTH_PATHS.has(pathname)) return false;

  const supplied = parseBasicAuthHeader(req.headers?.authorization);
  if (supplied && stagingCredsMatch(supplied.user, supplied.pass)) {
    // Authed — let Next.js handle it (noindex already set above).
    return false;
  }

  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="ComputerCaller Staging"');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Staging — authorized access only\n');
  return true;
}

// ---------------------------------------------------------------------------
// Next.js + relay startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('[Server] Starting ComputerCaller...');
  console.log(`[Server] Mode: ${dev ? 'development' : 'production'}`);

  console.log(`[Server] Preparing Next.js on port ${NEXT_PORT}...`);
  // webpack: true — Turbopack panics on Windows when bundling Prisma's
  // native client (tries to symlink `@prisma/client` into the build chunks;
  // hits `os error 1314 / SeCreateSymbolicLinkPrivilege` for non-admin users).
  // IMPORTANT: Next 16's `next()` factory silently ignores `turbopack: false`
  // (only checks truthy). To actually opt OUT of Turbopack you must pass
  // `webpack: true`. Verified 2026-05-19 in the saas-test rig.
  const app = next({ dev, webpack: true });
  const handle = app.getRequestHandler();
  await app.prepare();

  // ── CC-RELAY-1006 FIX (2026-08-27) ─────────────────────────────────────────
  // Next's programmatic server lazily attaches its OWN `httpServer.on('upgrade')`
  // listener the FIRST time getRequestHandler() serves an HTTP request
  // (NextServer.setupWebSocketHandler → next/dist/server/next.js). That Next
  // upgrade path exists only for dev HMR; in production, for any path it does
  // not own (like our /relay) it tears down the already-upgraded socket. Result:
  // every browser relay WS got a clean 101 Switching Protocols and then an
  // immediate FIN — the client saw code 1006 with ZERO application frames
  // (LOBBY_STATUS never reached the wire), ~1-7ms after open.
  //
  // Because Next attaches that listener LAZILY (only after the first HTTP request
  // has been served), the relay worked on a cold process and broke the instant
  // ANY page/asset/health request had gone through Next — which is exactly why
  // this looked environmental/latent even though the relay WS code (last touched
  // e2d1a01) never changed.
  //
  // We own /relay upgrades ourselves via startRelay()'s httpServer.on('upgrade').
  // Next has no upgrade responsibilities in production, so we set its internal
  // setup guard to true BEFORE any request is served — Next then never registers
  // its competing 'upgrade' listener and the relay socket survives. Verified
  // in-container against the deployed Next build: without this the browser WS
  // dies 1006 in ~1-7ms; with it the socket holds and LOBBY_STATUS is delivered.
  //
  // Prod-only: in dev, Next legitimately needs this listener for the
  // webpack-HMR websocket, so we leave dev untouched.
  if (!dev && app && typeof app === 'object') {
    app.didWebSocketSetup = true;
  }

  const httpServer = http.createServer((req, res) => {
    // Staging gate (2026-06-03): no-op when STAGING !== 'true'. When the gate
    // takes over (401 response on missing/wrong creds) it returns true and we
    // do NOT forward to Next.js. The WS upgrade path is on a separate
    // `upgrade` event handler in startRelay() and is NOT routed through here,
    // so the phone bridge is structurally outside the gate.
    if (applyStagingGate(req, res)) return;
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  console.log(`[Server] Mounting relay WebSocket server on shared httpServer at /relay...`);
  startRelay(httpServer);

  httpServer.listen(NEXT_PORT, (err) => {
    if (err) throw err;
    console.log(`[Server] Next.js ready on http://localhost:${NEXT_PORT}`);
    console.log(`[Server] Relay WebSocket ready on ws://localhost:${NEXT_PORT}/relay (browser) and /relay/phone (phone).`);
    if (LEGACY_RELAY_PORT) {
      console.log(`[Server] Legacy port ${RELAY_PORT} also active (LEGACY_RELAY_PORT=1).`);
    }
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
