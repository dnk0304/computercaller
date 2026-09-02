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
let presenceCount = 0;          // >0 ⇒ a popup / pop-out is open (suppress notifs)

const MIN_OPEN_DWELL_MS = 10_000;   // reset backoff only after a stable connection
const MAX_BACKOFF_MS = 30_000;
const CALL_NOTIF_PREFIX = 'cc-call';
const SMS_NOTIF_PREFIX = 'cc-sms';
const PHONE_NOTIF_PREFIX = 'cc-notif';

// ── Token ──────────────────────────────────────────────────────────────────
function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(self.CC.TOKEN_KEY, (o) => resolve(o?.[self.CC.TOKEN_KEY] || null));
  });
}
function clearToken() {
  return new Promise((resolve) => chrome.storage.local.remove(self.CC.TOKEN_KEY, resolve));
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
    if (!token) { connecting = false; return; }          // not signed in — idle
    const ticket = await mintTicket(token);
    if (!ticket) { connecting = false; return; }          // token dropped

    const url = `${self.CC.RELAY_BASE}?ticket=${encodeURIComponent(ticket)}&role=listener`;
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      openedAt = Date.now();
      connecting = false;
      // NOTE: backoff is reset in onclose only after a MIN_OPEN_DWELL_MS-stable
      // connection, NOT here — a socket that dies right after open must keep
      // escalating its backoff instead of resetting the budget every attempt
      // (avoids a reconnect storm).
    };
    sock.onmessage = (ev) => {
      try { handleFrame(typeof ev.data === 'string' ? ev.data : ''); }
      catch (e) { console.warn('[CC-SW] frame handler error', e); }
    };
    sock.onclose = () => {
      const dwell = Date.now() - openedAt;
      if (ws === sock) ws = null;
      connecting = false;
      if (openedAt && dwell >= MIN_OPEN_DWELL_MS) reconnectAttempts = 0; // stable → reset
      openedAt = 0;
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  } catch (e) {
    console.warn('[CC-SW] connect error', e);
    connecting = false;
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

function handleFrame(msg) {
  if (!msg) return;
  const { type, data } = splitFrame(msg);

  switch (type) {
    case 'CALL_INCOMING':
    case 'CALL_WAITING': {
      // Clear/lifecycle frames are still processed below even when suppressed,
      // but the visible notification is skipped if a popup/pop-out is open.
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
      return;
    }
    case 'SMS_RECEIVED': {
      if (presenceCount > 0) return;
      const who = pick(data, ['name', 'contactName']) ||
                  pick(data, ['from', 'sender', 'number', 'address']) || 'New message';
      const body = pick(data, ['body', 'text', 'message', 'preview']) || '';
      chrome.notifications.create(`${SMS_NOTIF_PREFIX}:${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: who,
        message: body || 'Sent you a message',
        contextMessage: 'ComputerCaller · SMS',
        priority: 1,
        buttons: [{ title: 'Open ComputerCaller' }],
      });
      return;
    }
    case 'PHONE_NOTIFICATION': {
      if (presenceCount > 0) return;
      // Mirror the phone's own notification. Respect an explicit opt-out flag if
      // the phone sends one; otherwise show it.
      if (data && (data.suppressMirror === true || data.mirror === false)) return;
      const title = pick(data, ['title', 'appName', 'app']) || 'Phone notification';
      const body = pick(data, ['body', 'text', 'message', 'content']) || '';
      chrome.notifications.create(`${PHONE_NOTIF_PREFIX}:${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon128.png',
        title,
        message: body,
        contextMessage: 'ComputerCaller',
        priority: 0,
      });
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
function openPopout() {
  // A detached extension window that iframes /extension (popout.html). As an
  // extension page it can signal presence + reuse the sign-in flow, and it
  // survives the popup blur that kills the toolbar popup — the persistent
  // in-call surface.
  chrome.windows.create({
    url: chrome.runtime.getURL('popout.html'),
    type: 'popup',
    width: 400,
    height: 640,
    focused: true,
  });
}

// ── Notification interactions → open the pop-out, then clear ─────────────────
chrome.notifications.onClicked.addListener((id) => {
  openPopout();
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener((id) => {
  openPopout();
  chrome.notifications.clear(id);
});

// ── Presence: popup / pop-out connect a port so we suppress duplicate notifs ──
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cc-presence') return;
  presenceCount += 1;
  port.onDisconnect.addListener(() => {
    presenceCount = Math.max(0, presenceCount - 1);
  });
});

// ── Messages from popup (auth updated, request pop-out) ──────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'auth-updated') {
    reconnectAttempts = 0;
    connect();
    sendResponse?.({ ok: true });
  } else if (message?.type === 'open-popout') {
    openPopout();
    sendResponse?.({ ok: true });
  } else if (message?.type === 'signed-out') {
    try { ws && ws.close(); } catch (_) {}
    sendResponse?.({ ok: true });
  }
  return true;
});

// ── Keepalive / reconnect backstop ───────────────────────────────────────────
chrome.alarms.create('cc-keepalive', { periodInMinutes: 0.5 }); // 30s (chrome min)
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cc-keepalive') connect(); // no-op if already open
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Kick a connection on SW wake.
connect();
