/**
 * ComputerCaller MV3 background service worker
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * Owns the INCOMING path: a receive-only WebSocket to the relay (?role=listener)
 * that maps phone→browser frames to chrome.notifications so calls/SMS notify even
 * when the popup is closed. It never sends call/SMS commands (that is the popup's
 * iframe over its OWN active-browser WS) — this socket is passive, which is why
 * the relay keeps it out of pairing and the single-session (SESSION_SUPERSEDED)
 * kill switch. See server.js broadcastToListeners / the `?role=listener` handling.
 *
 * Lifetime: Chrome 116+ keeps an MV3 SW alive while its WebSocket has traffic;
 * the relay pings every 15s, which suffices. A ~24s keepalive alarm is a backstop
 * that reconnects if the SW was ever torn down while a session token exists.
 */

importScripts('config.js');

// ── State ──────────────────────────────────────────────────────────────────
let ws = null;
let connecting = false;
let openedAt = 0;               // ms timestamp of the last successful open
let reconnectAttempts = 0;      // drives exponential backoff
let reconnectTimer = null;
let presenceCount = 0;          // >0 ⇒ a popup / pop-out / panel is open (suppress notifs)

// ── Connection indicator state (2026-09-15, forge/ext-badge-sidepanel) ──────
// TWO independent facts, deliberately not collapsed into one boolean:
//   wsOpen       — our listener socket is up (we can hear the relay at all)
//   phonePresent — a PHONE is in this user's room (the thing Dennis actually
//                  means by "we are connected"; a relay socket with no phone
//                  on the other end can neither call nor text)
// Green requires BOTH. See deriveState().
let wsOpen = false;
let phonePresent = false;
let signedIn = false;           // a durable ext_token exists
let lastIndicator = null;       // last state pushed to chrome.action (dedupe)
/**
 * Set by applyIndicator ONLY on builds where composing the icon failed, so the
 * connection state has nowhere to live but the badge. null on every normal
 * build — the green dot is on the icon and the badge is free for the count.
 */
let badgeChipColor = null;

const MIN_OPEN_DWELL_MS = 10_000;   // reset backoff only after a stable connection
const MAX_BACKOFF_MS = 30_000;
const CALL_NOTIF_PREFIX = 'cc-call';
const SMS_NOTIF_PREFIX = 'cc-sms';
const PHONE_NOTIF_PREFIX = 'cc-notif';

// Unread counters, per surface tab. Kept in chrome.storage.session (cleared on
// browser restart, never written to disk) rather than in SW memory, because the
// SW is torn down and respawned constantly under MV3 — a module-level counter
// would silently reset itself several times an hour.
const UNREAD_KEY = 'cc_unread';
const UNREAD_ZERO = { missedCalls: 0, newSms: 0, alerts: 0 };
/** Notification id → deep-link hash, so a click survives an SW restart. */
const NOTIF_LINK_KEY = 'cc_notif_links';

const GREEN = '#16a34a';
const GREY = '#9ca3af';
/** Unread-count chip. Red because it is the one thing asking to be acted on. */
const BADGE_RED = '#dc2626';

// ── Token ──────────────────────────────────────────────────────────────────
function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(self.CC.TOKEN_KEY, (o) => resolve(o?.[self.CC.TOKEN_KEY] || null));
  });
}
function clearToken() {
  return new Promise((resolve) => chrome.storage.local.remove(self.CC.TOKEN_KEY, resolve));
}
function storeToken(token) {
  return new Promise((resolve) =>
    chrome.storage.local.set({ [self.CC.TOKEN_KEY]: token }, resolve),
  );
}

// ── Connection indicator on the toolbar icon ────────────────────────────────
/**
 * Dennis asked for "a small dot above the extension logo showing in green that
 * we are connected". Chrome gives an extension exactly two ways to mark its
 * toolbar button and NEITHER of them draws above it:
 *
 *   chrome.action.setBadgeText  — a text chip in the icon's BOTTOM-RIGHT corner.
 *   chrome.action.setIcon       — replaces the icon bitmap outright.
 *
 * We take setIcon, because a badge is a rounded rectangle of text and a dot is
 * a dot. The bitmap is composed here at runtime with OffscreenCanvas (the only
 * canvas a service worker has — there is no document to hang a <canvas> on), so
 * the indicator ships without waiting on new art. If Pixel-C later drops
 * icon{16,32,48,128}-connected.png into chrome-extension/, load those instead of
 * calling composeIcon(); nothing else in this file changes.
 *
 * setBadgeText is kept as a genuine fallback, not decoration: OffscreenCanvas
 * and createImageBitmap are both unavailable in a handful of Chromium builds,
 * and an extension that silently shows no connection state at all is worse than
 * one showing a green chip.
 */
const ICON_SIZES = [16, 32, 48, 128];
/** colour key → composed {size: ImageData}, so a flap doesn't re-render canvases. */
const iconCache = new Map();

async function composeIcon(color) {
  // `color === null` ⇒ the plain mark, no dot (signed out).
  const cached = iconCache.get(color || 'plain');
  if (cached) return cached;
  const res = await fetch(chrome.runtime.getURL('icon128.png'));
  const bitmap = await createImageBitmap(await res.blob());
  const out = {};
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, size, size);
    if (color) {
      // Bottom-right, because that is where every OS puts a presence dot and
      // because the top of our mark carries artwork. The ring around the dot is
      // PUNCHED with destination-out rather than stroked in white: the toolbar
      // is light in one theme and near-black in the other, so a white ring reads
      // as a smudge in dark mode while a transparent gap always reads as a gap.
      const r = Math.max(2, Math.round(size * 0.22));
      const cx = size - r - Math.round(size * 0.04);
      const cy = size - r - Math.round(size * 0.04);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, r + Math.max(1, Math.round(size * 0.06)), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  if (bitmap.close) bitmap.close();
  iconCache.set(color || 'plain', out);
  return out;
}

/**
 * The ONE place the toolbar indicator is written.
 * @param {'connected'|'signed-in-disconnected'|'signed-out'} state
 */
async function applyIndicator(state) {
  if (state === lastIndicator) return;
  lastIndicator = state;
  const color = state === 'connected' ? GREEN : state === 'signed-in-disconnected' ? GREY : null;
  const title = state === 'connected'
    ? 'ComputerCaller — phone connected'
    : state === 'signed-in-disconnected'
      ? 'ComputerCaller — reconnecting…'
      : 'ComputerCaller';
  try { chrome.action.setTitle({ title }); } catch (_) {}
  try {
    const imageData = await composeIcon(color);
    await chrome.action.setIcon({ imageData });
    // Composed successfully — the dot is on the icon, so the badge is not
    // needed for connection state. Release it (this also clears any chip left
    // behind by a previous run on a build that lacked OffscreenCanvas) and
    // repaint, which puts the unread count back if one is waiting.
    badgeChipColor = null;
    repaintBadge();
    return;
  } catch (e) {
    console.warn('[CC-SW] icon compose failed, falling back to badge', e);
  }
  // Fallback: a coloured chip. A single space, not a bullet — Chrome renders
  // badge glyphs small and off-centre, whereas a chip of pure colour is exactly
  // the signal we want and survives every locale and font. Handed to
  // paintBadge rather than written here, so it cannot fight the unread count
  // over the one badge the two of them share.
  badgeChipColor = color;
  repaintBadge();
}

/**
 * The ONE place chrome.action's badge is written.
 *
 * Two things want it and they must not race each other:
 *   - the unread count (missed calls + new texts + alerts), which is the only
 *     way a number reaches a user whose surfaces are all closed — Dennis:
 *     "i wont get a notifications counter on the pinned extension icon when i
 *     have closed the side panel";
 *   - applyIndicator's colour chip, which exists only as a fallback for the
 *     handful of Chromium builds without OffscreenCanvas (see composeIcon).
 *
 * The number wins whenever there is one. It carries strictly more information,
 * and on every build where the icon composes, connection state is already
 * being shown by the green dot on the icon itself — which this never touches.
 *
 * No presence check here, deliberately. Counters only ever grow while every
 * surface is closed (see bumpUnread) and a surface zeroes its tab the moment
 * the user looks at it, so the stored total is ALREADY exactly "waiting for
 * you since you last looked". Re-deriving that from presenceCount would also
 * be wrong: presenceCount is module state and resets to 0 every time MV3
 * respawns the worker, whereas the counters live in storage.session and do not.
 *
 * The badge sits in the icon's bottom-right corner, which is where the green
 * dot is drawn too, so a non-zero count covers the dot. That is the right
 * trade while the count is non-zero — it is the thing asking to be acted on —
 * and the dot reappears as soon as the user opens the panel and reads the tab.
 */
function paintBadge(unread) {
  const total = (unread?.missedCalls || 0) + (unread?.newSms || 0) + (unread?.alerts || 0);
  try {
    if (total > 0) {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_RED });
      // Chrome truncates a badge to roughly four characters at this font size;
      // "99+" is the largest honest thing that always fits.
      chrome.action.setBadgeText({ text: total > 99 ? '99+' : String(total) });
    } else if (badgeChipColor) {
      chrome.action.setBadgeBackgroundColor({ color: badgeChipColor });
      chrome.action.setBadgeText({ text: ' ' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) { /* badge writes are cosmetic — never let one throw upward */ }
}

/** Repaint from storage. Used on worker boot, where nothing is in memory yet. */
function repaintBadge() {
  return readUnread().then(paintBadge).catch(() => {});
}

/** Recompute from the two facts + auth. Call after ANY of them changes. */
function refreshIndicator() {
  if (!signedIn) return applyIndicator('signed-out');
  if (wsOpen && phonePresent) return applyIndicator('connected');
  return applyIndicator('signed-in-disconnected');
}

/** Re-read the token and re-render. Cheap; called on every auth transition. */
async function refreshAuthAndIndicator() {
  signedIn = !!(await getToken());
  if (!signedIn) { wsOpen = false; phonePresent = false; }
  refreshIndicator();
}

// ── Unread counters (while every surface is closed) ─────────────────────────
// ── Serialised storage.session mutation ────────────────────────────
/**
 * Every counter and deep-link write below is a read-modify-write across an
 * `await`, and the relay delivers frames in BURSTS — a phone that reconnects
 * after a few minutes offline replays several SMS_RECEIVED frames into the same
 * turn of the event loop.
 *
 * Unserialised, all of them read the same pre-burst value, each writes its own
 * single increment, and the last write wins: four messages arrive and the badge
 * says one. (Observed, not theorised — scripts/ext-indicator-proof.mjs drove
 * 2×SMS + 1 call + 1 alert through handleFrame and got {newSms:0, alerts:1}.
 * The same race dropped two of three notification deep links.)
 *
 * A service worker is single-threaded, so a promise chain is a sufficient
 * mutex: each mutation runs to completion before the next one reads. Failures
 * are swallowed into the chain so one bad write cannot wedge every later one.
 */
let sessionQueue = Promise.resolve();
function serialize(fn) {
  const run = sessionQueue.then(fn, fn);
  sessionQueue = run.then(() => undefined, () => undefined);
  return run;
}

// ── Self-timestamping trace (off by default) ────────────────────────────────
/**
 * forge/dock-reconnect-sw-badge (2026-09-15). "How long does the listener
 * socket actually live once the panel is closed?" cannot be answered with a
 * debugger attached: Playwright (and an open DevTools pane) auto-attaches a
 * CDP session to the worker, and an attached debugger is exactly what stops
 * Chrome evicting an MV3 worker. scripts/ext-sw-lifetime-proof.mjs measured
 * its own instrument for that reason and says so in its header.
 *
 * So the worker timestamps ITSELF. Every boot, alarm, socket open and socket
 * close (with the close code, which is what distinguishes an eviction from a
 * network drop) is appended to a bounded ring in chrome.storage.local, which
 * survives the worker being torn down. Read it back from any extension PAGE —
 * whose DevTools never touches the worker:
 *
 *   chrome.storage.local.set({ cc_debug: true })     // arm, then close the panel
 *   chrome.storage.local.get('cc_trace', console.log) // 10 minutes later
 *
 * Gaps between consecutive `boot` rows ARE the worker's death/respawn timeline.
 *
 * Cost when disabled (the shipped default): one boolean read at boot and one
 * `if` per event. Nothing is written, so no disk traffic and no quota use.
 */
const TRACE_KEY = 'cc_trace';
const TRACE_FLAG = 'cc_debug';
const TRACE_MAX = 400;
let traceOn = false;
/** Distinguishes "the worker never died" from "it died and respawned quietly". */
const BOOT_ID = Math.random().toString(36).slice(2, 8);

function trace(event, detail) {
  if (!traceOn) return;
  // Same promise-chain mutex as the counters: these are read-modify-writes
  // across an await, and a burst of close/open events would otherwise lose
  // rows to last-write-wins — the precise failure the counters already hit.
  serialize(async () => {
    try {
      const o = await new Promise((r) => chrome.storage.local.get(TRACE_KEY, r));
      const rows = (o && o[TRACE_KEY]) || [];
      rows.push({ t: Date.now(), boot: BOOT_ID, e: event, ...(detail || {}) });
      while (rows.length > TRACE_MAX) rows.shift();
      await new Promise((r) => chrome.storage.local.set({ [TRACE_KEY]: rows }, r));
    } catch (_) { /* tracing must never break the worker */ }
  });
}

/** Read the flag once per worker lifetime, then emit this boot's first row. */
function initTrace() {
  try {
    chrome.storage.local.get(TRACE_FLAG, (o) => {
      traceOn = !!(o && o[TRACE_FLAG]);
      trace('boot', { presenceCount });
    });
  } catch (_) {}
}

function readUnread() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(UNREAD_KEY, (o) =>
        resolve(Object.assign({}, UNREAD_ZERO, (o && o[UNREAD_KEY]) || {})));
    } catch (_) { resolve(Object.assign({}, UNREAD_ZERO)); }
  });
}

function bumpUnread(key) {
  // Only while nothing is watching. A popup, pop-out or side panel that is open
  // IS the read receipt — counting behind it would show a badge for messages
  // the user is currently looking at. Checked INSIDE the queued body, not
  // before it: a surface can open while a burst is still draining.
  return serialize(async () => {
    if (presenceCount > 0) return;
    const cur = await readUnread();
    const next = Object.assign({}, cur, { [key]: (cur[key] || 0) + 1 });
    await new Promise((r) => {
      try { chrome.storage.session.set({ [UNREAD_KEY]: next }, r); } catch (_) { r(); }
    });
    paintBadge(next);
    broadcastUnread(next);
  });
}

/** Zero ONE tab's counter — a surface reported that tab is on screen. */
function clearUnread(tab) {
  const key = tab === 'dial' ? 'missedCalls'
    : tab === 'texts' ? 'newSms'
      : tab === 'alerts' ? 'alerts' : null;
  if (!key) return Promise.resolve(null);
  // Same queue as bumpUnread, deliberately: a 'tab-viewed' that overtook a
  // still-draining burst would zero a counter and then have the burst write the
  // old value back on top of it.
  return serialize(async () => {
    const cur = await readUnread();
    if (!cur[key]) return cur;
    const next = Object.assign({}, cur, { [key]: 0 });
    await new Promise((r) => {
      try { chrome.storage.session.set({ [UNREAD_KEY]: next }, r); } catch (_) { r(); }
    });
    paintBadge(next);
    broadcastUnread(next);
    return next;
  });
}

/**
 * Push counts down every open presence port. Deliberately NOT a second
 * messaging channel: the `cc-presence` port already exists, already tracks
 * exactly the set of live surfaces, and already tears itself down when one
 * closes. shell.js relays the payload into its app iframe as a `shell-hello`.
 */
const presencePorts = new Set();
function broadcastUnread(unread) {
  for (const port of presencePorts) {
    try { port.postMessage({ type: 'unread', unread }); } catch (_) {}
  }
}

// ── Deep links carried by a notification ────────────────────────────────────
// Kept in storage.session, not a Map: the SW is routinely torn down between
// raising a notification and the user clicking it, and a click that lands on a
// respawned worker must still know which thread it was about.
function rememberLink(notifId, hash) {
  if (!hash) return Promise.resolve();
  return serialize(async () => {
    try {
      const o = await new Promise((r) => chrome.storage.session.get(NOTIF_LINK_KEY, r));
      const map = (o && o[NOTIF_LINK_KEY]) || {};
      map[notifId] = hash;
      // Bound it. A user who ignores 200 notifications should not carry 200 keys.
      const ids = Object.keys(map);
      if (ids.length > 50) delete map[ids[0]];
      await new Promise((r) => chrome.storage.session.set({ [NOTIF_LINK_KEY]: map }, r));
    } catch (_) {}
  });
}
function takeLink(notifId) {
  // Queued too, and for the sharper reason: takeLink DELETES. A click landing
  // while a burst is still writing links would otherwise resurrect the entry it
  // just consumed, and the next click would reopen a stale thread.
  return serialize(async () => {
    try {
      const o = await new Promise((r) => chrome.storage.session.get(NOTIF_LINK_KEY, r));
      const map = (o && o[NOTIF_LINK_KEY]) || {};
      const hash = map[notifId] || '';
      delete map[notifId];
      await new Promise((r) => chrome.storage.session.set({ [NOTIF_LINK_KEY]: map }, r));
      return hash;
    } catch (_) { return ''; }
  });
}

// ── Sign-in (2026-09-15, forge/ext-embedded-login) ────────────────────────
// BOTH sign-in paths now terminate HERE, in the service worker, and never in
// the popup document. A toolbar popup is destroyed the instant it loses focus,
// which is exactly what happens when an auth window opens — so anything the
// popup was awaiting (store the token, notify the SW, load the app) simply
// stopped existing mid-flight. That was the bug: sign-in only ever completed
// for users who already had a session on the web app. The SW has no such
// lifetime problem.

/**
 * Password path. The embedded login (/extension/login, framed by the popup)
 * has already set the auth_token cookie same-origin, so the durable
 * ext-session token is a plain cookie-authed POST — no window anywhere.
 * credentials:'include' works from here because the extension holds
 * host_permissions for https://computercaller.com/*, which makes this a
 * privileged fetch rather than a third-party one.
 */
async function mintTokenFromCookie() {
  try {
    const res = await fetch(self.CC.EXT_TOKEN_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      console.warn('[CC-SW] ext-token mint failed:', res.status);
      return false;
    }
    const body = await res.json();
    if (!body || !body.ext_token) return false;
    await storeToken(body.ext_token);
    signedIn = true;
    refreshIndicator();
    reconnectAttempts = 0;
    connect();
    return true;
  } catch (e) {
    console.warn('[CC-SW] ext-token mint error', e);
    return false;
  }
}

/**
 * Google path. accounts.google.com sends X-Frame-Options: DENY, so its consent
 * screen cannot be embedded — this one genuinely needs a window, and the window
 * is opened from the SW so the popup's death is irrelevant. The flow returns
 * through the handoff route, which mints the same ext-session token and 302s to
 * the chromiumapp.org URL Chrome intercepts.
 */
async function runGoogleSignIn() {
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({
      url: self.CC.GOOGLE_SIGNIN_URL,
      interactive: true,
    });
    // redirect = https://<extid>.chromiumapp.org/#ext_token=<jwt>
    const hash = (redirect && redirect.split('#')[1]) || '';
    const token = new URLSearchParams(hash).get('ext_token');
    if (!token) return false;
    await storeToken(token);
    signedIn = true;
    refreshIndicator();
    reconnectAttempts = 0;
    connect();
    return true;
  } catch (e) {
    // User closed the window / cancelled. Not an error worth shouting about.
    return false;
  }
}

// ── Relay-ticket exchange (durable ext-session JWT → 30s relay ticket) ───────
async function mintTicket(token) {
  const res = await fetch(self.CC.TICKET_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 401 || res.status === 409) {
    // Token invalid or session superseded — drop it; the user must re-run the
    // handoff from the popup. Returning null stops the reconnect loop cleanly.
    await clearToken();
    signedIn = false;
    refreshIndicator();
    return null;
  }
  if (!res.ok) throw new Error(`ticket mint failed: ${res.status}`);
  const body = await res.json();
  if (!body?.ticket) throw new Error('ticket missing in response');
  return body.ticket;
}

// ── Connection lifecycle ─────────────────────────────────────────────────────
async function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  connecting = true;
  try {
    const token = await getToken();
    signedIn = !!token;
    if (!token) { connecting = false; refreshIndicator(); return; }   // not signed in — idle
    const ticket = await mintTicket(token);
    if (!ticket) { connecting = false; return; }          // token dropped

    const url = `${self.CC.RELAY_BASE}?ticket=${encodeURIComponent(ticket)}&role=listener`;
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      openedAt = Date.now();
      connecting = false;
      wsOpen = true;
      trace('ws-open', { attempts: reconnectAttempts });
      // phonePresent stays whatever LOBBY_STATUS tells us next. We do NOT
      // optimistically assume a phone: a relay socket with no phone behind it
      // is precisely the state a green dot must not claim.
      phonePresent = false;
      refreshIndicator();
      // NOTE: backoff is reset in onclose only after a MIN_OPEN_DWELL_MS-stable
      // connection, NOT here — a socket that dies right after open must keep
      // escalating its backoff instead of resetting the budget every attempt
      // (avoids a reconnect storm).
    };
    sock.onmessage = (ev) => {
      try { handleFrame(typeof ev.data === 'string' ? ev.data : ''); }
      catch (e) { console.warn('[CC-SW] frame handler error', e); }
    };
    sock.onclose = (ev) => {
      const dwell = Date.now() - openedAt;
      // The close CODE is the discriminator the measurement needs: 1001/1006
      // with no close frame is the worker (or the network) going away under
      // us, whereas 1000 is a deliberate close.
      trace('ws-close', { code: ev?.code ?? null, reason: ev?.reason || '', dwellMs: openedAt ? dwell : null });
      // Capture BEFORE nulling: a stale socket closing behind a live
      // replacement must not turn the indicator grey while we are connected.
      const wasCurrent = ws === sock;
      if (wasCurrent) ws = null;
      connecting = false;
      if (wasCurrent) { wsOpen = false; phonePresent = false; refreshIndicator(); }
      if (openedAt && dwell >= MIN_OPEN_DWELL_MS) reconnectAttempts = 0; // stable → reset
      // Reset lobby (dispatch FORGE-J, 2026-09-15). 4010 `room_reset` is the
      // relay deliberately emptying this user's room, so the listener must come
      // straight back with NO backoff penalty — the MIN_OPEN_DWELL_MS rule
      // above is the wrong guard here: a reset that lands moments after a
      // reconnect would otherwise leave reconnectAttempts elevated and park the
      // SW's listener for up to MAX_BACKOFF_MS, silently losing every frame in
      // the gap. The server asked for this close; there is nothing to back off
      // from, and unlike the /app socket the SW has no user watching it
      // reconnect.
      if (ev && (ev.code === 4010 || ev.reason === 'room_reset')) {
        reconnectAttempts = 0;
      }
      openedAt = 0;
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  } catch (e) {
    console.warn('[CC-SW] connect error', e);
    connecting = false;
    wsOpen = false;
    phonePresent = false;
    refreshIndicator();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const token = await getToken();
    if (token) connect();   // only retry if still signed in
  }, delay);
}

// ── Frame → notification mapping ─────────────────────────────────────────────
function splitFrame(msg) {
  const i = msg.indexOf(':');
  if (i < 0) return { type: msg, data: {} };
  const type = msg.slice(0, i);
  let data = {};
  try { data = JSON.parse(msg.slice(i + 1)); } catch (_) { data = {}; }
  return { type, data };
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  return '';
}

/**
 * Relay presence → the green dot (2026-09-15, forge/ext-badge-sidepanel).
 *
 * The listener socket is NOT presence-blind: server.js puts a `?role=listener`
 * peer in room.lobby as a browser and leaves it there forever, so it receives
 *   LOBBY_STATUS:{phonePresent, alreadyActive}   once, on join
 *   PHONE_PRESENT:{}                             a phone joined the lobby
 *   PHONE_ABSENT:{}                              the last live phone went away
 * via broadcastToLobbyBrowsers(). No server change was needed for the indicator.
 *
 * `alreadyActive` matters as much as `phonePresent`: a phone that is PAIRED
 * with a web-app browser has left the lobby, so countLobby() reports zero
 * phones while the phone is very much connected. Green must mean "a phone is
 * reachable", not "a phone is idle and pairable".
 *
 * KNOWN GAP (reported, not papered over): server.js skips the PHONE_PRESENT
 * broadcast when a phone rejoins through tryAutoResume() inside the 180s resume
 * window. A phone that blips and auto-resumes while our listener is already
 * connected therefore raises no presence frame. The catch-all below closes it:
 * ANY phone→browser data frame reaching broadcastToListeners() is proof a phone
 * is on the other end, so the first call/SMS/sync frame repairs the state.
 */
function notePhonePresence(present) {
  if (phonePresent === present) return;
  phonePresent = present;
  refreshIndicator();
}

/**
 * Is this SMS_RECEIVED payload an OUTGOING message? (Addendum B, 2026-09-15.)
 *
 * The APK sends the row FLAT — {id, from, body, time, type:'sent'|'inbox'} —
 * which is the shape that matters in production. We also read `message.type`
 * and a `direction` field because the web layer's normalizePayload wraps the
 * row under `message`, and older/other producers have used `direction`; a
 * notification suppressor that only knows ONE of the three spellings is a
 * suppressor that silently stops working the next time a producer changes.
 *
 * DEFAULT IS INCOMING. An unrecognised or absent marker must notify: missing a
 * real incoming text is a product failure, whereas one stray notification for
 * an outgoing one is the bug we are fixing — an annoyance. Fail toward the
 * cheaper mistake.
 */
function isOutgoingSms(data) {
  if (!data || typeof data !== 'object') return false;
  const row = (data.message && typeof data.message === 'object') ? data.message : data;
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (type === 'sent' || type === 'outbox' || type === 'outgoing' || type === 'queued') return true;
  const dir = typeof row.direction === 'string' ? row.direction.toLowerCase() : '';
  if (dir === 'sent' || dir === 'out' || dir === 'outgoing') return true;
  return false;
}

function handleFrame(msg) {
  if (!msg) return;
  const { type, data } = splitFrame(msg);

  // Presence first, and OUTSIDE the notification switch: these frames must be
  // processed whether or not a surface is open, and they raise no notification.
  if (type === 'LOBBY_STATUS') {
    notePhonePresence(data.phonePresent === true || data.alreadyActive === true);
    return;
  }
  if (type === 'PHONE_PRESENT') { notePhonePresence(true); return; }
  if (type === 'PHONE_ABSENT') { notePhonePresence(false); return; }
  // Reset lobby (dispatch FORGE-J, 2026-09-15). The relay is about to close
  // every socket in this room, phone included. Handled HERE, above the
  // catch-all below, because that catch-all would otherwise read a ROOM_RESET
  // as proof of a live phone and leave the green dot on through the teardown —
  // the dot would go stale for the whole reconnect window.
  if (type === 'ROOM_RESET') { notePhonePresence(false); return; }
  // MV3 keepalive heartbeat (dispatch FORGE-J addendum A, 2026-09-15). The
  // relay pushes HB to LISTENER sockets every 15s purely so this worker
  // receives a real message: a protocol-level ws ping is answered below the JS
  // layer and fires no event, so it does not reset MV3's 30s idle timer —
  // measured, the worker was evicted twice in 5.5 minutes despite those pings,
  // and a frame pushed into the gap was lost silently.
  //
  // Handled HERE, above the catch-all, and answered with NOTHING. Two reasons:
  // an HB is not evidence of a phone (the catch-all below would turn the green
  // dot on for a room with no phone in it, which is the exact lie the
  // wsOpen/phonePresent split exists to prevent), and merely ARRIVING is the
  // whole job — the inbound message is what keeps the worker alive, so a reply
  // would be pure wire noise.
  if (type === 'HB') return;
  // Catch-all for the tryAutoResume gap documented above.
  if (type !== 'PING' && type !== 'PONG') notePhonePresence(true);

  switch (type) {
    case 'CALL_INCOMING':
    case 'CALL_WAITING': {
      // Clear/lifecycle frames are still processed below even when suppressed,
      // but the visible notification is skipped if a popup/pop-out is open.
      bumpUnread('missedCalls');
      if (presenceCount > 0) return;
      const who = pick(data, ['name', 'contactName', 'displayName']) ||
                  pick(data, ['number', 'from', 'phoneNumber', 'msisdn']) || 'Unknown number';
      const callId = pick(data, ['callId', 'id']) || String(Date.now());
      chrome.notifications.create(`${CALL_NOTIF_PREFIX}:${callId}`, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: type === 'CALL_WAITING' ? 'Call waiting' : 'Incoming call',
        message: who,
        contextMessage: 'ComputerCaller',
        priority: 2,
        requireInteraction: true,
        buttons: [{ title: 'Open ComputerCaller' }],
      });
      rememberLink(`${CALL_NOTIF_PREFIX}:${callId}`, '#tab=dial');
      return;
    }
    case 'SMS_RECEIVED': {
      // Addendum B (Dennis 2026-09-15): "i also got a pop-up notification when
      // sent an sms out. I only want on incoming, not outgoing."
      //
      // SMS_RECEIVED is a misnomer on the wire: it is the APK's frame for a
      // single SMS ROW, in EITHER direction. Three phone-side producers push
      // sent rows through it —
      //   PhoneService.kt:2667  RCS/Google-Messages mirror, which detects a
      //                         "You: …" notification and tags type="sent";
      //   PhoneService.kt:2927  the new-message ContentObserver push, which
      //                         maps MESSAGE_TYPE_SENT → "sent";
      //   PhoneService.kt:2999  the MMS/backfill push, same mapping.
      // So every SMS the user sends from the phone (and every echo of one sent
      // from the browser, once the provider row lands) arrived here and both
      // raised a notification AND bumped the unread badge.
      //
      // The direction check has to come BEFORE bumpUnread, not just before the
      // notifications.create: the badge is a count of things needing attention
      // and your own outbox needs none. Suppressing only the popup would leave
      // the badge lying, which is the same bug wearing a different hat.
      if (isOutgoingSms(data)) return;
      bumpUnread('newSms');
      if (presenceCount > 0) return;
      const who = pick(data, ['name', 'contactName']) ||
                  pick(data, ['from', 'sender', 'number', 'address']) || 'New message';
      const body = pick(data, ['body', 'text', 'message', 'preview']) || '';
      // Thread identity, best-effort: the relay's SMS payload shape varies by
      // APK version, so we take the first field that looks like a thread and
      // fall back to the sender's address — which is what the app threads on
      // anyway. An empty id simply deep-links to the Texts tab.
      const thread = pick(data, ['threadId', 'thread', 'conversationId']) ||
                     pick(data, ['from', 'sender', 'number', 'address']) || '';
      const smsId = `${SMS_NOTIF_PREFIX}:${Date.now()}`;
      chrome.notifications.create(smsId, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: who,
        message: body || 'Sent you a message',
        contextMessage: 'ComputerCaller · SMS',
        priority: 1,
        // Button 1 is "Reply", NOT a reply box. chrome.notifications has no
        // inline text input on any platform — the only notification API that
        // ever did was the deprecated Rich Notifications 'textPrompt', which
        // Chrome removed. "Reply" therefore means "open the surface with this
        // thread already selected", which is one click from typing.
        buttons: [{ title: 'Open ComputerCaller' }, { title: 'Reply' }],
      });
      rememberLink(smsId, thread
        ? `#tab=texts&thread=${encodeURIComponent(thread)}`
        : '#tab=texts');
      return;
    }
    case 'PHONE_NOTIFICATION': {
      bumpUnread('alerts');
      if (presenceCount > 0) return;
      // Mirror the phone's own notification. Respect an explicit opt-out flag if
      // the phone sends one; otherwise show it.
      if (data && (data.suppressMirror === true || data.mirror === false)) return;
      const title = pick(data, ['title', 'appName', 'app']) || 'Phone notification';
      const body = pick(data, ['body', 'text', 'message', 'content']) || '';
      const notifId = `${PHONE_NOTIF_PREFIX}:${Date.now()}`;
      // The phone tells us whether the mirrored notification is actionable.
      // Only then do we offer Reply — a Reply button on a battery warning is
      // noise, and worse, a promise we cannot keep.
      const canReply = !!(data && (data.hasReply === true || data.canReply === true));
      chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title,
        message: body,
        contextMessage: 'ComputerCaller',
        priority: 0,
        buttons: canReply
          ? [{ title: 'Open ComputerCaller' }, { title: 'Reply' }]
          : [{ title: 'Open ComputerCaller' }],
      });
      rememberLink(notifId, '#tab=alerts');
      return;
    }
    case 'CALL_ANSWERED':
    case 'CALL_ENDED': {
      // The call is handled/over — clear any lingering incoming-call notifs.
      chrome.notifications.getAll((all) => {
        Object.keys(all || {}).forEach((id) => {
          if (id.startsWith(`${CALL_NOTIF_PREFIX}:`)) chrome.notifications.clear(id);
        });
      });
      return;
    }
    default:
      // Everything else (control frames, sync data) is not a notification.
      return;
  }
}

// ── Pop-out window (persistent in-call UI) ───────────────────────────────────
function openPopout(hash) {
  // A detached extension window that iframes /extension (popout.html). As an
  // extension page it can signal presence + reuse the sign-in flow, and it
  // survives the popup blur that kills the toolbar popup — the persistent
  // in-call surface.
  chrome.windows.create({
    // The hash is the deep link a notification carried (#tab=texts&thread=…).
    // popout.html hands it to the app iframe's URL, so the surface opens on the
    // conversation the toast was about instead of on whatever tab was last used.
    url: chrome.runtime.getURL('popout.html') + (hash || ''),
    type: 'popup',
    // 800 × 620 (was 400 × 640), dispatch PIXEL-B2 / AC-1. The detached window
    // is NOT a taller popup: it is free of Chrome's 600px popup ceiling, so the
    // extra width is what stops the header device pill and the call-log filter
    // strip from competing for the same row. 620 keeps it comfortably inside a
    // 768px-tall laptop screen once the OS titlebar is counted.
    width: 800,
    height: 620,
    focused: true,
  });
}

// ── Notification interactions → open the pop-out, then clear ─────────────────
chrome.notifications.onClicked.addListener(async (id) => {
  openPopout(await takeLink(id));
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  const hash = await takeLink(id);
  // Button 0 = "Open ComputerCaller" (the surface, wherever it was).
  // Button 1 = "Reply" (the surface, deep-linked at the thread).
  // Both open the same window; only the landing spot differs. There is no
  // reply-from-toast anywhere in this file because Chrome has no API for one.
  openPopout(buttonIndex === 1 ? hash : '');
  chrome.notifications.clear(id);
});

// ── Presence: popup / pop-out connect a port so we suppress duplicate notifs ──
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cc-presence') return;
  presenceCount += 1;
  presencePorts.add(port);
  trace('presence-open', { presenceCount });
  // Hand the newcomer the current counts immediately. A surface that opens
  // while three texts are waiting must render their badge on its first paint,
  // not on the next inbound frame.
  readUnread().then((unread) => {
    try { port.postMessage({ type: 'unread', unread }); } catch (_) {}
  });
  port.onMessage.addListener((msg) => {
    // The surface reports which tab the user is looking at. This is the ONLY
    // thing that zeroes a counter — the SW never guesses that a message was
    // read because a window happened to be open.
    if (msg && msg.type === 'tab-viewed') clearUnread(msg.tab);
  });
  port.onDisconnect.addListener(() => {
    presencePorts.delete(port);
    presenceCount = Math.max(0, presenceCount - 1);
    trace('presence-close', { presenceCount });
  });
});

// ── Dock: put the pop-out back where it came from ──────────────────────
/**
 * Addendum 2026-09-15: "there is no button again for me to reconnect it to the
 * extension browser window". The reverse of open-popout.
 *
 * THIS IS THE FALLBACK PATH, NOT THE PRIMARY ONE — and that is a measured
 * finding, not a preference. The dispatch proposed opening the panel from here,
 * on the assumption that a runtime.onMessage from an extension page carries the
 * user's gesture into the worker. It does not. Measured in the bundled
 * Chromium (scripts/ext-dock-gesture-proof.mjs), from a REAL trusted click:
 *
 *   page → sendMessage → SW → sidePanel.open()
 *       → "`sidePanel.open()` may only be called in response to a user gesture."
 *   page → sidePanel.open() directly, inside the click handler
 *       → opened.
 *
 * The gesture does not survive the message hop. So shell.js opens the panel
 * itself (see requestDock there) and then sends `dock-close` to have this
 * worker remove the pop-out window — closing a window needs no gesture, and
 * doing it from the page would race the page's own teardown.
 *
 * What remains here is the last resort for a surface that cannot reach
 * chrome.sidePanel at all. It will usually fail for exactly the reason above;
 * it fails CLEANLY, reporting {ok:false, surface:'none'} so Pixel-C can show
 * "Click the toolbar icon" instead of leaving a dead button.
 *
 * @returns {Promise<{ok:boolean, surface:'sidepanel'|'popup'|'none', error?:string}>}
 */
async function dockSurface(sender) {
  let surface = 'none';
  // BOTH errors are kept. Reporting only the last one meant the side panel's
  // real refusal was masked by the popup's unrelated "no popup on the active
  // tab" — which is exactly how the gesture bug hid during the first run.
  const errors = [];

  // Target the last-focused NORMAL window. Not sender.tab.windowId — that is
  // the pop-out itself, a type:'popup' window, which has no side panel.
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (chrome.sidePanel && win && typeof win.id === 'number') {
      await chrome.sidePanel.open({ windowId: win.id });
      surface = 'sidepanel';
    } else {
      errors.push('sidePanel: no normal window');
    }
  } catch (e) {
    errors.push('sidePanel: ' + ((e && e.message) || String(e)));
  }

  if (surface === 'none') {
    try {
      if (chrome.action && chrome.action.openPopup) {
        await chrome.action.openPopup();
        surface = 'popup';
      } else {
        errors.push('openPopup: unavailable');
      }
    } catch (e) {
      errors.push('openPopup: ' + ((e && e.message) || String(e)));
    }
  }

  // Close the pop-out only once something replaced it.
  if (surface !== 'none') await closeSenderWindow(sender);

  const out = { ok: surface !== 'none', surface };
  if (surface === 'none' && errors.length) out.error = errors.join(' | ');
  return out;
}

/**
 * Remove the window a surface message came from. Split out because `dock-close`
 * needs it on its own: shell.js has already opened the panel by then, and all
 * that is left is to take the now-redundant pop-out off the screen. Closing a
 * window requires no user gesture, which is the whole reason this half lives in
 * the worker while the opening half lives in the page.
 */
async function closeSenderWindow(sender) {
  const winId = sender && sender.tab && sender.tab.windowId;
  if (typeof winId !== 'number') return false;
  try { await chrome.windows.remove(winId); return true; } catch (_) { return false; }
}

// ── Side panel behaviour ──────────────────────────────────────
/**
 * Make the toolbar icon open the side panel. Chrome's documented precedence is
 * that action.default_popup WINS over openPanelOnActionClick — if a popup is
 * declared, clicking the icon shows the popup and this setting is inert. The
 * manifest therefore no longer declares default_popup (dispatch item 4).
 *
 * Wrapped because the call rejects outright on Chromium builds without the
 * sidePanel API, and an unhandled rejection at SW top level aborts the rest of
 * this file — including connect().
 */
function installPanelBehavior() {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn('[CC-SW] setPanelBehavior refused', e));
  } catch (e) {
    console.warn('[CC-SW] sidePanel API unavailable', e);
  }
}

// Safety net: with default_popup removed, onClicked fires ONLY if the panel
// behaviour above never took effect. Without this the toolbar icon would be a
// dead button on any build that refused the side panel.
chrome.action.onClicked.addListener(() => openPopout());

// ── Messages from popup (auth updated, request pop-out) ──────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'auth-updated') {
    reconnectAttempts = 0;
    connect();
    sendResponse?.({ ok: true });
  } else if (message?.type === 'dock') {
    // Fallback only — shell.js opens the panel itself, because the user gesture
    // does not survive the hop into this worker. See dockSurface().
    dockSurface(sender).then((r) => sendResponse?.(r));
  } else if (message?.type === 'dock-close') {
    // shell.js already docked. Just take the pop-out window away.
    closeSenderWindow(sender).then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'unread-get') {
    readUnread().then((unread) => sendResponse?.({ ok: true, unread }));
  } else if (message?.type === 'tab-viewed') {
    clearUnread(message.tab).then((unread) => sendResponse?.({ ok: true, unread }));
  } else if (message?.type === 'sign-in-complete') {
    // Embedded (password) sign-in finished in the popup's login frame.
    // `return true` below keeps the channel open for this async reply.
    mintTokenFromCookie().then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'google-sign-in') {
    // The popup that sent this will very likely be destroyed when the auth
    // window opens; sendResponse then goes nowhere, which is harmless. The
    // flow itself completes here regardless.
    runGoogleSignIn().then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'open-popout') {
    openPopout(typeof message.hash === 'string' ? message.hash : '');
    sendResponse?.({ ok: true });
  } else if (message?.type === 'signed-out') {
    try { ws && ws.close(); } catch (_) {}
    signedIn = false;
    wsOpen = false;
    phonePresent = false;
    refreshIndicator();
    try { chrome.storage.session.set({ [UNREAD_KEY]: { ...UNREAD_ZERO } }); } catch (_) {}
    // Signing out clears the counts, so it must clear the number on the icon
    // too — a stale "3" on a signed-out extension is a lie about someone's
    // messages.
    paintBadge(UNREAD_ZERO);
    sendResponse?.({ ok: true });
  }
  return true;
});

// ── Keepalive / reconnect backstop ───────────────────────────────────────────
chrome.alarms.create('cc-keepalive', { periodInMinutes: 0.5 }); // 30s (chrome min)
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'cc-keepalive') return;
  // An alarm row whose `boot` id differs from the row before it is a worker
  // that was evicted and respawned by this very alarm — the gap between them
  // is how long the listener socket was down.
  trace('alarm', { wsOpen, connecting });
  connect(); // no-op if already open
});

chrome.runtime.onStartup.addListener(() => { installPanelBehavior(); connect(); });
chrome.runtime.onInstalled.addListener(() => { installPanelBehavior(); connect(); });

// Kick a connection on SW wake, and paint the indicator from whatever the
// token says before the socket has had time to answer — otherwise a signed-in
// user sees the signed-out icon for the first second of every SW respawn.
initTrace();
installPanelBehavior();
refreshAuthAndIndicator();
// Re-assert the count from storage on every worker boot. chrome.action state
// does outlive the worker, so this is usually a no-op — but it is the only
// thing that recovers the badge if a write was lost to a worker torn down
// mid-`serialize`, and it costs one storage.session read per respawn.
repaintBadge();
connect();
