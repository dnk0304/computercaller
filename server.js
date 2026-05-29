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

// Pairing-request TTL. The browser sends BROWSER_REQUEST_PAIRING and the
// phone has this many ms to ACCEPT or DECLINE before we auto-cancel.
// 30 s mirrors the existing 35 s defensive timeout previously used in the
// webapp for the old accept-on-connect flow, with 5 s slack for the
// browser-side fallback timer.
const PAIRING_TTL_MS = 30_000;

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
    console.log(`[Relay][${redactToken(room.token)}] terminateActivePair: ${reason}`);
    room.active = { browser: null, phone: null };

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
      safeSend(room.active.phone, msg);
      return true;
    }
    if (fromWs === room.active.phone && room.active.browser) {
      safeSend(room.active.browser, msg);
      return true;
    }
    return false;
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

      // 1. Tell the phone how many browsers are already waiting in this
      //    lobby so its UI can render an "approve incoming" affordance
      //    (if browserCount > 0) or "waiting for desktop" (if 0).
      safeSend(ws, `LOBBY_STATUS:${JSON.stringify({ browserCount: lobbyCounts.browsers })}`);
      // F-5 (2026-05-29): HELLO frame's hostname value is the only place the
      // container's real OS hostname leaked to clients. APK only matches on
      // `HELLO:` prefix — value is decorative. Use a stable literal to avoid
      // exposing infra naming (container/host names show up in support pings
      // and bug reports). Kept the frame for backward-compat with APK <=v29.
      safeSend(ws, `HELLO:${JSON.stringify({ hostname: 'computercaller' })}`);

      // 2. Tell every browser in the lobby a phone just showed up. Drives
      //    the Connect button visibility on the browser side.
      broadcastToLobbyBrowsers(room, `PHONE_PRESENT:${JSON.stringify({})}`);

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
              terminateActivePair(room, 'user_left');
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

        // Frame from a lobby phone that wasn't a recognised control frame.
        // Drop + log so misbehaving APKs surface in the relay log.
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
          // Lobby phone leaving — tell remaining lobby browsers to hide
          // the Connect affordance if this was the last phone in the lobby.
          const { phones } = countLobby(room);
          if (phones === 0) {
            broadcastToLobbyBrowsers(room, `PHONE_ABSENT:${JSON.stringify({})}`);
          }
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

    // Tell the browser whether it can act on the Connect button right away
    // and whether an active pair already exists in this room (browser will
    // render distinct copy in that case).
    safeSend(ws, `LOBBY_STATUS:${JSON.stringify({
      phonePresent: counts.phones > 0,
      alreadyActive,
    })}`);

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
            terminateActivePair(room, 'user_left');
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

      // Anything else from a lobby browser (e.g. legacy CONNECT_TO from a
      // stale tab, stray data frames). Drop + log.
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
