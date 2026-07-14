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
// no phone Accept tap. 120 s covers the observed prod gaps (42 s phone-side,
// 6 s browser-side, 2026-06-11 logs) with headroom for a slow cellular
// re-attach, while staying short enough that a genuinely-gone peer doesn't
// hold a phantom resume claim. Security: resume is scoped to the same room
// token (the shared secret both sides already authenticated with), is only
// armed by a non-user-initiated close, and expires — no new attack surface
// beyond what a normal Connect+Accept inside the same room already grants.
const RESUME_WINDOW_MS = 120_000;

// Known-device auto-relink (2026-07-10). How long after a pair ends the relay
// will still silently re-form it when the SAME authed user's phone + browser
// are both back in the lobby. Deliberately much longer than RESUME_WINDOW_MS:
// the 120s window only covers socket blips, while this covers OEM app kills
// (ColorOS killing the APK with no auto-redial on the v40 base) and user
// walk-aways — the phone can be gone for minutes before it reconnects.
// Security: the room token remains the outer shared secret; this adds no
// surface beyond what Accept already trusts (both sockets authed into the
// same room), and NARROWS it further by requiring the authed userId on both
// sockets and the phone's deviceName to match the recorded consented pair.
// 2026-07-14 (Dennis down 95 min > old 10 min): the 10-minute clock destroyed
// the pairing record while BOTH known devices sat idle-but-connected in the
// lobby, dropping a real incoming call for 95 minutes. The clock was only
// defense-in-depth; the real security barrier is the 4 hijack guards (userId
// match on both sockets, phone deviceName match, no pendingPairing, and
// phone-side user_left permanently killing the record). Two changes make
// relink effectively PERMANENT while both known devices remain reachable:
//   1. When BOTH known devices are present in the lobby, tryKnownDeviceRelink
//      relinks regardless of elapsed time — the window no longer gates that
//      path at all (see tryKnownDeviceRelink).
//   2. This window now only bounds how long the record lingers while the
//      devices are NOT both present (memory hygiene for a genuinely-gone
//      peer), and is re-armed whenever a matching known socket reappears. A
//      generous 24h ceiling covers any realistic OEM-kill / walk-away gap
//      while still letting a truly-abandoned record expire.
const KNOWN_PAIR_RELINK_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 *   room.lastPair             — { userId, phoneDeviceName, browserUa,
 *                               pairedAt, endedAt } | null. Identity of the
 *                               last CONSENTED pair, memory-only. Fuels
 *                               known-device auto-relink (2026-07-10); see
 *                               tryKnownDeviceRelink for guards/invalidation.
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
  const wss = new WebSocketServer({ noServer: true });

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

  function getRoom(token) {
    let room = rooms.get(token);
    if (!room) {
      room = {
        token,
        lobby: new Set(),
        active: { browser: null, phone: null },
        pendingPairing: null,
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
    // Known-device auto-relink: keep the room (and its lastPair record) alive
    // while a relink is still possible, so a both-sides-gone gap (OEM kill +
    // browser reload) can still relink when both return. Bounded: worst case
    // the empty room lingers KNOWN_PAIR_RELINK_WINDOW_MS past endedAt.
    if (room.lastPair && room.lastPair.endedAt != null
        && Date.now() - room.lastPair.endedAt <= KNOWN_PAIR_RELINK_WINDOW_MS) return;
    rooms.delete(room.token);
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
      else if (ws.role === 'browser') browsers++;
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
  function terminateActivePair(room, reason, opts = {}) {
    const { browser, phone } = room.active;
    if (!browser && !phone) return;

    // Known-device auto-relink (2026-07-10): stamp when the consented pair
    // ended so tryKnownDeviceRelink can gate on recency. Invalidation
    // asymmetry (deliberate): a `user_left` where the LEAVER is the PHONE
    // means the phone's owner explicitly said stop — the consent that
    // auto-relink rides on is revoked, so the record is destroyed and we
    // never auto-relink over it. A BROWSER-side `user_left` (stray
    // Disconnect/Cancel click, sign-out race) does NOT invalidate: the
    // phone's Accept still stands, and the browser re-opting-in is implicit
    // in it sitting back in the same authed room.
    if (room.lastPair) {
      if (reason === 'user_left' && opts.leaverRole === 'phone') {
        room.lastPair = null;
        console.log(`[Relay][${redactToken(room.token)}] phone user_left — lastPair invalidated (no auto-relink)`);
      } else if (room.lastPair.endedAt == null) {
        room.lastPair.endedAt = Date.now();
      }
    }

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
      room.active = { browser: browserOpen ? browser : null, phone: phoneOpen ? phone : null };
      room.resumable = {
        droppedRole,
        droppedAt: Date.now(),
        expiresAt: Date.now() + RESUME_WINDOW_MS,
        identity: room.pairIdentity ?? null,
      };
      const survivor = phoneOpen ? phone : (browserOpen ? browser : null);
      if (survivor) {
        // Non-destructive hold. The web hook treats this as "phone briefly
        // away" — it does NOT flip isConnected / wipe caches; its existing 30s
        // APP_PING stale window (>> the 5s Android lobby reconnect) covers the
        // gap. A client that doesn't know the frame simply ignores it. The
        // survivor stays in `active`, so its data plane is untouched.
        safeSend(survivor, `PEER_RECONNECTING:${JSON.stringify({ droppedRole, window: RESUME_WINDOW_MS })}`);
      }
      console.log(`[Relay][${redactToken(room.token)}] socket_closed: soft-hold survivor (droppedRole=${droppedRole}), resume window armed (${RESUME_WINDOW_MS}ms)`);
      return;
    }

    console.log(`[Relay][${redactToken(room.token)}] terminateActivePair: ${reason}`);
    room.active = { browser: null, phone: null };

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
    for (const s of room.lobby) {
      if (s.role === 'phone' && !phoneWs && s.readyState === WebSocket.OPEN) phoneWs = s;
      else if (s.role === 'browser' && !browserWs && s.readyState === WebSocket.OPEN) browserWs = s;
    }
    // Counterpart not back yet (or both dropped and only one returned) —
    // keep the claim armed and fall through to the normal lobby flow.
    if (!phoneWs || !browserWs) return false;

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
    if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
    if (!survivorPhone) safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown' })}`);
    console.log(`[Relay][${redactToken(room.token)}] auto-resumed pair after socket_closed (gap=${Date.now() - claim.droppedAt}ms, droppedRole=${claim.droppedRole}, survivorHeld=${!!(survivorPhone || survivorBrowser)})`);
    stampLastPair(room, phoneWs, browserWs);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Known-device auto-relink (2026-07-10)
  //
  // Extends Issue-3 auto-resume. Issue-3 covers a SOCKET blip (<=120s, armed
  // only by socket_closed). Two prod failure modes escape it:
  //   (A) the resume claim gets wiped by a browser-side `user_left` fired
  //       during the soft-hold (stray Disconnect click while the phone is
  //       briefly away) — the phone returns 60s later to a dead claim;
  //   (B) the phone is away LONGER than 120s (ColorOS killing the APK with no
  //       auto-redial on the v40 base) — the claim expires before it returns.
  // In both cases every frame the returning phone sends is dropped from the
  // lobby until the user manually re-runs Connect+Accept — for a pairing they
  // consented to minutes earlier.
  //
  // Fix: remember the IDENTITY of the last consented pair (room.lastPair) and,
  // when a phone + browser that BOTH carry that identity are back in the lobby
  // within KNOWN_PAIR_RELINK_WINDOW_MS of teardown, re-form the pair silently.
  // ---------------------------------------------------------------------------

  /**
   * Record the identity of the pair that just went ACTIVE. Called from every
   * pair-forming path (handleAcceptPairing, tryAutoResume, relink itself).
   * Memory-only, per-room, no persistence.
   *
   * userId is stamped only when BOTH sockets authed as the same user (they
   * always should — the room token maps to one account); a mismatch stamps
   * null, which disables relink for this pair (the userId guard can never
   * pass), failing closed.
   */
  function stampLastPair(room, phoneWs, browserWs) {
    const userId = (phoneWs.userId && phoneWs.userId === browserWs.userId) ? phoneWs.userId : null;
    room.lastPair = {
      userId,
      phoneDeviceName: phoneWs.deviceName ?? room.lastPair?.phoneDeviceName ?? null,
      browserUa: room.pairIdentity?.ua ?? null,
      pairedAt: Date.now(),
      endedAt: null,
    };
  }

  /**
   * Attempt a known-device auto-relink. Called at lobby-join time (phone and
   * browser paths, strictly AFTER tryAutoResume — Issue-3 resume keeps
   * priority) and from the phone's DEVICE_INFO handler (a rejoining phone's
   * deviceName only becomes known when that frame lands, which is after the
   * join-time attempt already ran).
   *
   * Hijack guards — ALL required before a relink fires:
   *   1. both candidate sockets' authed userId === lastPair.userId;
   *   2. the phone's deviceName === lastPair.phoneDeviceName;
   *   3. no pendingPairing — an in-flight explicit handshake always wins;
   *   4. lastPair survives teardown only if the phone did NOT leave via
   *      user_left (see terminateActivePair — phone-side Disconnect destroys
   *      the record permanently).
   * Plus state guards: the record must exist, have ended (endedAt != null)
   * within KNOWN_PAIR_RELINK_WINDOW_MS, and no active slot may be occupied
   * (an occupied slot means a live pair or an Issue-3 soft-hold — both owned
   * by existing mechanisms).
   *
   * Returns true if the pair was re-formed (caller should skip its normal
   * lobby-join messaging for the joiner, mirroring tryAutoResume).
   */
  function tryKnownDeviceRelink(room) {
    const lp = room.lastPair;
    if (!lp || lp.endedAt == null || !lp.userId) return false;
    if (room.pendingPairing) return false;           // explicit handshake wins
    if (room.active.browser || room.active.phone) return false; // live pair / soft-hold owns this

    let phoneWs = null;
    let browserWs = null;
    for (const s of room.lobby) {
      if (s.readyState !== WebSocket.OPEN) continue;
      if (s.role === 'phone' && !phoneWs
          && s.userId === lp.userId
          && (s.deviceName ?? null) === (lp.phoneDeviceName ?? null)) {
        phoneWs = s;
      } else if (s.role === 'browser' && !browserWs && s.userId === lp.userId) {
        browserWs = s;
      }
    }

    // PERMANENT-WHILE-BOTH-IDLE (2026-07-14). When BOTH known devices are
    // present in the lobby we relink no matter how long ago the pair ended —
    // this is exactly the state that stranded Dennis for 95 min. The elapsed-
    // time window is NOT consulted on this path; the 4 hijack guards
    // (userId ×2, deviceName, no-pendingPairing, phone-user_left-kills-record)
    // remain the security barrier and are all still enforced above/below.
    if (!phoneWs || !browserWs) {
      // Only ONE (or neither) known device is here. The record must not live
      // forever in this state, so the window bounds it — but re-arm endedAt
      // whenever a matching known device is present so the clock never expires
      // out from under a device that stays connected (Dennis's browser sat
      // connected the whole time). Once BOTH devices are truly gone nothing
      // re-arms and the record lapses after the (now 24h) ceiling.
      const gap = Date.now() - lp.endedAt;
      if (gap > KNOWN_PAIR_RELINK_WINDOW_MS) {
        room.lastPair = null; // lazily expire only when we couldn't relink anyway
      } else if (phoneWs || browserWs) {
        lp.endedAt = Date.now(); // one known device holds the room — slide the clock
      }
      return false;
    }

    room.lobby.delete(phoneWs);
    room.lobby.delete(browserWs);
    room.active.browser = browserWs;
    room.active.phone = phoneWs;
    room.resumable = null;

    const prevId = room.pairIdentity ?? {};
    const deviceName = phoneWs.deviceName ?? lp.phoneDeviceName ?? null;
    room.pairIdentity = { ua: prevId.ua ?? 'unknown', ip: prevId.ip ?? 'unknown', deviceLabel: prevId.deviceLabel, deviceName };
    // IDENTICAL payload shapes to handleAcceptPairing's PAIRING_ACTIVE pair —
    // both clients' existing handlers accept this without a Connect click or
    // an Accept tap, and the web side fires its quick-sync backfill on it.
    safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
    safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: prevId.ua ?? 'unknown', ip: prevId.ip ?? 'unknown' })}`);
    lp.phoneDeviceName = deviceName;
    lp.pairedAt = Date.now();
    lp.endedAt = null;
    console.log(`[Relay][${redactToken(room.token)}] known-device auto-relink (gap=${gap}ms, device=${deviceName ?? '-'})`);
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

    room.pendingPairing = { id: pairingId, browserWs, ua, ip, deviceLabel, expiresAt, timer };

    // Build forward payload omitting deviceLabel when absent so older APK
    // builds (v22 and below) parse the same shape they always did.
    const forwardPayload = deviceLabel !== undefined
      ? { pairingId, ua, ip, deviceLabel }
      : { pairingId, ua, ip };
    safeSend(phoneWs, `PAIRING_REQUEST:${JSON.stringify(forwardPayload)}`);
    console.log(`[Relay][${redactToken(room.token)}] Pairing request ${pairingId} forwarded to phone (ua=${ua.slice(0, 40)} ip=${ip} label=${deviceLabel ?? '-'})`);
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
    // Known-device auto-relink: record the consented pair's identity.
    stampLastPair(room, phoneWs, browserWs);
    safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
    safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: pending.ua, ip: pending.ip })}`);
    console.log(`[Relay][${redactToken(room.token)}] Pairing ${pending.id} ACTIVE — browser ↔ phone`);
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
    return { pathname, legacyToken, ticket };
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
    const { pathname, legacyToken, ticket } = parseConnection(req);

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

    const token = phoneToken;
    ws.userId = userId;
    ws.phoneToken = token;
    ws.authVia = authVia;
    // F-A: only browser sessions (relay-ticket) are subject to the
    // single-active-session kick. Phone sockets (legacy-token /
    // legacy-token-bearer) are NEVER indexed and NEVER kicked.
    if (authVia === 'relay-ticket') {
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
      room.lobby.add(ws);

      const lobbyCounts = countLobby(room);
      console.log(`[Relay][${redactToken(token)}] Phone joined lobby (browsers=${lobbyCounts.browsers}, active=${!!room.active.phone})`);

      // Issue 3: a phone returning within the resume window re-links
      // silently. Attempted BEFORE any lobby messaging — on resume the
      // PAIRING_ACTIVE frame REPLACES LOBBY_STATUS for this socket, so the
      // client never sees a lobby frame that could race its active state.
      // Known-device auto-relink: attempted only when Issue-3 resume did not
      // fire (resume keeps priority — it handles the armed-claim blip cases
      // exactly as before). Usually a no-op at phone-join time because the
      // fresh socket has no deviceName yet (guard 2 fails until DEVICE_INFO
      // lands, where we retry) — it fires here when lastPair recorded no name.
      const phoneResumed = tryAutoResume(room) || tryKnownDeviceRelink(room);

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
        rlog(`[Relay][${redactToken(token)}] Phone ->`, msg.substring(0, 80));

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
            // Known-device auto-relink: a REJOINING phone's deviceName only
            // becomes known here (the join-time relink attempt ran before
            // DEVICE_INFO arrived, so its deviceName guard failed). Retry now
            // that identity is complete. On success ws becomes
            // room.active.phone and the frame forwards through the pair below.
            if (ws !== room.active.phone) {
              tryKnownDeviceRelink(room);
            } else if (room.lastPair && room.lastPair.endedAt == null && ws.deviceName) {
              // Live pair learning its name post-Accept — keep the record
              // current so a later relink matches the real deviceName.
              room.lastPair.phoneDeviceName = ws.deviceName;
            }
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
            if (ws === room.active.phone) {
              // leaverRole: phone-side Disconnect permanently invalidates the
              // known-device relink record (see terminateActivePair).
              terminateActivePair(room, 'user_left', { leaverRole: 'phone' });
            } else {
              console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE from non-active phone — ignored`);
            }
          } catch (e) {
            console.error(`[Relay][${redactToken(token)}] LEAVE_ACTIVE handler crashed: ${e.message}`);
          }
          return;
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

        // Frame from a lobby phone that wasn't a recognised control frame and
        // there is no armed resume window to deliver it into. Drop + log so
        // misbehaving APKs surface in the relay log.
        //
        // Deliberately NO queue/replay of these frames (decision locked,
        // 2026-07-10): known-device auto-relink makes the lobby gap seconds
        // long, and PAIRING_ACTIVE already triggers the web quick-sync (6h
        // merge backfill) which recovers anything sent during the gap.
        // Replaying stale frames after relink risks duplicates the client
        // dedup layers were never designed for. Resume-then-resync is the
        // contract.
        console.log(`[Relay][${redactToken(token)}] Dropping lobby-phone frame: ${msg.substring(0, 60)}`);
      });

      ws.on('close', () => {
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
        console.log(`[Relay][${redactToken(token)}] Phone disconnected (was_active=${wasActive})`);
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
    // F-C: see phone-path note. Same counter semantics on the browser side.
    ws.missedPongs = 0;
    room.lobby.add(ws);

    const counts = countLobby(room);
    const alreadyActive = !!(room.active.browser || room.active.phone);
    console.log(`[Relay][${redactToken(token)}] Browser joined lobby (phones=${counts.phones}, active=${alreadyActive})`);

    // Issue 3: a browser returning within the resume window (its WS layer
    // auto-reconnects) re-links silently. Attempted BEFORE LOBBY_STATUS —
    // on resume PAIRING_ACTIVE REPLACES LOBBY_STATUS for this socket so the
    // web hook never processes a 'lobby' frame after going active.
    // Known-device auto-relink: same ordering contract as the phone path —
    // Issue-3 resume first, relink second, and on either success the
    // PAIRING_ACTIVE frame REPLACES LOBBY_STATUS for this socket.
    if (!tryAutoResume(room) && !tryKnownDeviceRelink(room)) {
      // Tell the browser whether it can act on the Connect button right away
      // and whether an active pair already exists in this room (browser will
      // render distinct copy in that case).
      safeSend(ws, `LOBBY_STATUS:${JSON.stringify({
        phonePresent: counts.phones > 0,
        alreadyActive,
      })}`);
    }

    ws.on('message', (data) => {
      // F-C: inbound traffic is liveness proof. Reset before the body runs.
      ws.missedPongs = 0;
      // F-D: same try/catch envelope as the phone branch — drop frame on
      // handler throw, keep socket alive.
      const msg = data.toString();
      rlog(`[Relay][${redactToken(token)}] Browser ->`, msg.substring(0, 80));

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
            // leaverRole: a browser-side leave does NOT invalidate the
            // known-device relink record (see terminateActivePair asymmetry).
            terminateActivePair(room, 'user_left', { leaverRole: 'browser' });
          } else {
            console.log(`[Relay][${redactToken(token)}] LEAVE_ACTIVE from non-active browser — ignored`);
          }
        } catch (e) {
          console.error(`[Relay][${redactToken(token)}] LEAVE_ACTIVE handler crashed: ${e.message}`);
        }
        return;
      }

      // Data plane — only allowed when this socket is the active browser.
      if (ws === room.active.browser) {
        try {
          if (!forwardDataPlane(room, ws, msg)) {
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
      if (!LEGACY_RESUME_TEARDOWN && deliverLobbyFrameDuringResume(room, ws, msg, 'browser', token)) {
        return;
      }

      // Anything else from a lobby browser (e.g. legacy CONNECT_TO from a
      // stale tab, stray data frames) with no armed resume window. Drop + log.
      console.log(`[Relay][${redactToken(token)}] Dropping lobby-browser frame: ${msg.substring(0, 60)}`);
    });

    ws.on('close', () => {
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
      console.log(`[Relay][${redactToken(token)}] Browser disconnected (was_active=${wasActive})`);
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
      if (!claim || Date.now() <= claim.expiresAt) return;
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
