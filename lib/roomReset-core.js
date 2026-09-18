/**
 * lib/roomReset-core.js — "Reset lobby": empty ONE relay room completely.
 *
 * Dispatch FORGE-J (2026-09-15). Dennis: "we need to add a reset lobby which is
 * like totally emptying lobby so phone can re-join and u can connect again."
 *
 * WHY THIS IS NOT `terminateActivePair`
 * -------------------------------------
 * The device-pill "Disconnect" sends LEAVE_ACTIVE, which calls
 * terminateActivePair('user_left'). That moves both peers BACK INTO THE LOBBY
 * on the SAME sockets. Every wedged thing survives it:
 *   - a half-dead phone socket that the 15s ping hasn't reaped yet stays in
 *     room.lobby and keeps countLobby() reporting phonePresent:true, so the
 *     browser shows "Connect" and the Connect handshake times out forever;
 *   - room.resumable can re-form a pair silently with the corpse;
 *   - room.frameBuffer replays stale frames onto the next pair;
 *   - room.pendingPairing keeps its 30s TTL timer holding the room.
 * Reset is the bigger hammer: drop the STATE, then drop the SOCKETS, then reap
 * the room object itself. The next thing either side does is a fresh connect.
 *
 * CLOSE CODES — role-split, and this is load-bearing (verified read-only in
 * dnkdialer-android/PhoneClient.kt:69-81 + PhoneService.kt:3119-3183):
 *
 *   PHONE  → 1000 "room_reset"
 *     PhoneClient.onClose invokes onConnectionChange(false) for EVERY code,
 *     which schedules the fixed 5s lobby reconnect. It ALSO invokes
 *     onConnectionError for any code != 1000, which flips the APK to
 *     RelayPhase.FAILED and surfaces an error state to the user. A reset is
 *     not a failure, so we pay nothing to avoid that: 1000 reconnects in the
 *     same 5s (there is no exponential backoff in v18 — the delay is a flat,
 *     stateless 5000ms) and leaves the phone's UI calm.
 *     The ONE code we must never send is 4401 — PhoneService special-cases it
 *     as "relay rejected token" and cancels the reconnect timer permanently.
 *
 *   BROWSER / LISTENER → 4010 "room_reset"
 *     A distinct code the web hook and the extension SW can classify. Both
 *     treat it as RETRY-IMMEDIATELY: reconnect without consuming a backoff
 *     step, because the server asked for this and there is nothing to back off
 *     from. 4010 is deliberately NOT 4001 (session_superseded), which is
 *     terminal on the browser side and would strand the user on the kicked
 *     card.
 *
 * ORDERING: frames first, state second, close third. The RESET_ROOM_ACK /
 * PAIRING_TERMINATED frames have to be queued onto a socket that is still OPEN,
 * and clearing state before closing means a close handler that fires
 * synchronously (ws does this in some versions) finds an already-empty room and
 * short-circuits instead of racing us.
 *
 * Kept as plain CJS in lib/*-core.js (the established split, same as
 * entitlement-core / tiers-core) for two reasons: server.js is plain JS and
 * cannot import TS, and tests/reset-room.test.mjs imports THIS module rather
 * than mirroring it — the other relay .mjs tests hand-copy server.js logic and
 * that copy is free to drift. This one cannot.
 */

/** Close code sent to the phone. 1000 = clean; APK redials in 5s, no error UI. */
const RESET_CLOSE_CODE_PHONE = 1000;
/** Close code sent to browsers + listeners. Non-terminal, no backoff penalty. */
const RESET_CLOSE_CODE_BROWSER = 4010;
const RESET_CLOSE_REASON = 'room_reset';

/** Minimum gap between two resets for one user. */
const RESET_RATE_LIMIT_MS = 5_000;

/**
 * Per-user rate limiter. userId -> last accepted reset timestamp (ms).
 *
 * In-memory and single-process on purpose: the relay IS a single Node process
 * (server.js hosts both the WS server and the Next.js handler — the same reason
 * supersedeWebSessions can hang off globalThis), so there is no second replica
 * to coordinate with. If this ever goes multi-replica the limiter needs Redis,
 * but so does the room Map, and the room Map is the bigger problem.
 */
function createResetRateLimiter(limitMs = RESET_RATE_LIMIT_MS) {
  const lastAt = new Map();
  return {
    /**
     * @returns {{allowed: boolean, retryAfterMs: number}}
     */
    check(userId, now = Date.now()) {
      if (!userId) return { allowed: true, retryAfterMs: 0 };
      const prev = lastAt.get(userId);
      if (prev !== undefined && now - prev < limitMs) {
        return { allowed: false, retryAfterMs: limitMs - (now - prev) };
      }
      lastAt.set(userId, now);
      return { allowed: true, retryAfterMs: 0 };
    },
    /** Drop entries older than 10x the window so the Map cannot grow forever. */
    sweep(now = Date.now()) {
      for (const [userId, at] of lastAt) {
        if (now - at > limitMs * 10) lastAt.delete(userId);
      }
    },
    size() { return lastAt.size; },
  };
}

/**
 * Empty `room` completely and close every socket in it.
 *
 * @param {object} room               the relay Room (lobby/active/pendingPairing/resumable/frameBuffer)
 * @param {object} deps
 * @param {(ws:object, msg:string)=>boolean} deps.safeSend
 * @param {(ws:object, code:number, reason:string)=>void} deps.closeSocket
 * @param {Map<string, object>} deps.rooms   the token -> Room map, so we can reap
 * @param {(msg:string)=>void} [deps.log]
 * @param {string} [origin] 'frame' | 'http' — logged only.
 * @returns {{closed:number, phones:number, browsers:number, listeners:number}}
 */
function resetRoom(room, deps, origin = 'frame') {
  const { safeSend, closeSocket, rooms, log = () => {} } = deps;
  if (!room) return { closed: 0, phones: 0, browsers: 0, listeners: 0 };

  // ── 1. Snapshot every socket in the room, exactly once ────────────────────
  // A socket can legitimately appear in BOTH room.lobby and room.active during
  // the dock handoff window, and closing the same ws twice would double-count
  // (and, worse, double-fire the 'close' handler's room mutations). A Set of
  // socket objects is the dedupe.
  const sockets = new Set();
  for (const ws of room.lobby) sockets.add(ws);
  if (room.active.browser) sockets.add(room.active.browser);
  if (room.active.phone) sockets.add(room.active.phone);
  // A pendingPairing's browser is normally also in the lobby, but the handshake
  // holds its own reference — take it too rather than assume the invariant.
  if (room.pendingPairing && room.pendingPairing.browserWs) {
    sockets.add(room.pendingPairing.browserWs);
  }

  // ── 2. Tell the active pair the pairing is over, BEFORE we tear state ─────
  // Same contract frame LEAVE_ACTIVE produces, so clients that already handle
  // PAIRING_TERMINATED need no new code path to drop their caches. The close
  // follows in step 4; a client that loses that race still got this.
  const terminated = `PAIRING_TERMINATED:${JSON.stringify({ reason: 'room_reset' })}`;
  if (room.active.browser) safeSend(room.active.browser, terminated);
  if (room.active.phone) safeSend(room.active.phone, terminated);

  // Every socket gets the explicit reset notice, including listeners — the
  // extension SW uses it to distinguish "server reset us" from a network blip
  // even when it never sees the close code (service worker torn down mid-close).
  const notice = `ROOM_RESET:${JSON.stringify({ reason: RESET_CLOSE_REASON })}`;
  for (const ws of sockets) safeSend(ws, notice);

  // ── 3. Clear ALL room state ───────────────────────────────────────────────
  // This is the part Disconnect does not do, and the whole point of the action.
  if (room.pendingPairing && room.pendingPairing.timer) {
    clearTimeout(room.pendingPairing.timer);
  }
  room.pendingPairing = null;
  room.resumable = null;       // no silent re-form with a corpse
  room.frameBuffer = [];       // no stale replay onto the next pair
  room.pairIdentity = null;
  room.active = { browser: null, phone: null };
  room.lobby.clear();

  // ── 4. Close every socket, role-split close codes (see header) ────────────
  let phones = 0, browsers = 0, listeners = 0, closed = 0;
  for (const ws of sockets) {
    const isPhone = ws.role === 'phone';
    if (isPhone) phones += 1;
    else if (ws.listener) listeners += 1;
    else browsers += 1;
    try {
      closeSocket(
        ws,
        isPhone ? RESET_CLOSE_CODE_PHONE : RESET_CLOSE_CODE_BROWSER,
        RESET_CLOSE_REASON,
      );
      closed += 1;
    } catch {
      // A close() on an already-closing socket throws in some ws versions.
      // The socket is going away either way; never let one failure abort the
      // reset and strand the REST of the room half-torn-down.
    }
  }

  // ── 5. Reap the room object itself ────────────────────────────────────────
  // Unconditional, unlike maybeReapRoom: we just emptied every field it guards,
  // so its checks would all pass anyway — but calling delete directly means a
  // 'close' handler that re-adds a socket between steps 4 and 5 cannot keep a
  // reset room alive. The next connect calls getRoom() and builds a virgin one.
  if (rooms && room.token) rooms.delete(room.token);

  log(
    `resetRoom(${origin}): closed ${closed} socket(s) ` +
    `(phones=${phones} browsers=${browsers} listeners=${listeners}), room reaped`,
  );
  return { closed, phones, browsers, listeners };
}

module.exports = {
  RESET_CLOSE_CODE_PHONE,
  RESET_CLOSE_CODE_BROWSER,
  RESET_CLOSE_REASON,
  RESET_RATE_LIMIT_MS,
  createResetRateLimiter,
  resetRoom,
};
