/**
 * ComputerCaller MV3 background service worker
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * Owns the INCOMING path: a receive-only WebSocket to the relay (?role=listener)
 * that maps phone→browser frames to toolbar badge counts so calls/SMS are counted
 * even when the popup is closed. It raises NO OS notifications (Dennis
 * 2026-09-25: "remove the chrome floating notifications from the extension").
 * It never sends call/SMS commands (that is the popup's
 * iframe over its OWN active-browser WS) — this socket is passive, which is why
 * the relay keeps it out of pairing and the single-session (SESSION_SUPERSEDED)
 * kill switch. See server.js broadcastToListeners / the `?role=listener` handling.
 *
 * Lifetime: Chrome 116+ keeps an MV3 SW alive while its WebSocket has traffic;
 * the relay pings every 15s, which suffices. A ~24s keepalive alarm is a backstop
 * that reconnects if the SW was ever torn down while a session token exists.
 */

// P3 (a): the worker is now an ES MODULE (manifest `background.type:"module"`).
// `importScripts` does not exist in a module worker, and a module worker is the
// only kind that can `import` — which is what the frozen key schedule requires,
// since lib/e2e/kdf.mjs is an .mjs with named exports and R-A forbids the build
// step that would turn it into anything else. config.js is UNCHANGED and still
// loads as a classic <script> in popup.html / popout.html / sidepanel.html; it
// assigns `self.CC`, and every reference in this file is already `self.CC.*`
// (not bare `CC`), so importing it for its side effect is exactly equivalent to
// the importScripts it replaces.
import './config.js';
// P5a-SW (a): the pure "what does a null token mean" rule. See that file's
// header for why a null is not automatically a sign-out.
import { tokenAbsenceVerdict } from './auth-absence.js';
import {
  loadOrCreateDeviceKey,
  publicIdentity,
  wipeDeviceKeyRecord,
  registerDeviceKey as registerSwDeviceKey,
  clearDeviceKeyRegistered,
} from './e2e/sw-key.js';
import {
  cacheWrap,
  readCachedWrap,
  dropSessionState,
  unwrapSessionKey,
  buildSession,
  isSealedEnvelope,
  openSealedFrame,
  admitSeq,
  markAuthenticated,
  noteDrop,
  readDrops,
  pairContextInputs,
  setOwnPairingId,
  readOwnPairingId,
  clearOwnPairingId,
  clearEpochFloors,
  inboundDisposition,
  INBOUND_UNSEAL,
  INBOUND_DROP_PLAINTEXT,
  INBOUND_ROUTE_SEALED,
  INBOUND_DELIVER_RELAY_ABORT,
  INBOUND_DROP_RELAY_MARK,
  INBOUND_DROP_BATTERY_SHAPE,
  ftHintId,
  PENDING_OFFER_TTL_MS,
  CtxRefused,
} from './e2e/sw-session.js';

// ── State ──────────────────────────────────────────────────────────────────
let ws = null;
let connecting = false;
let openedAt = 0;               // ms timestamp of the last successful open
let reconnectAttempts = 0;      // drives exponential backoff
let reconnectTimer = null;
let presenceCount = 0;          // >0 ⇒ a popup / pop-out / panel is open (suppress badge bumps)

// ── Connection indicator state ─────────────────────────────────────────────
// (2026-09-15 forge/ext-badge-sidepanel; corrected 2026-09-16 FORGE-O.)
//
// FOUR independent facts, deliberately not collapsed:
//   wsOpen       — our listener socket is up (we can hear the relay at all)
//   phonePresent — a live PHONE socket exists in this user's room
//   paired       — a phone and a browser are BOTH in the active slots right now
//   held         — no live pair, but the relay has an unexpired resume claim,
//                  i.e. this pair is mid-resume and will re-form with no Accept
//
// WHAT WAS WRONG BEFORE, AND WHY IT MATTERED. Green used to require
// `wsOpen && phonePresent`, and the comment above this line claimed phonePresent
// was "the thing Dennis actually means by we are connected". It is not. A phone
// sitting in the LOBBY is present and utterly unreachable — it is not paired
// with anything, so it can neither place a call nor send a text. On 2026-09-16
// the 6eb9bc7 deploy restarted the relay, which wiped the in-memory pair claim;
// the phone rejoined the lobby and pinged happily every 15 s with no pair, and
// this worker painted green for minutes over a dead connection. Dennis, 10:01:
// "showing 'phone connected and green dot' even though phone is not connected."
//
// Green now means PAIRED, which is the only state in which the product works.
// `held` gets its own amber rather than being rounded to either neighbour —
// rounding it up to green re-creates exactly this bug for the (common) duration
// of every panel close, and rounding it down to grey makes a normal panel close
// look like a dropout. All three come from the relay's PAIR_STATE frame; none
// of them is inferred from traffic any more. See refreshIndicator().
let wsOpen = false;
let phonePresent = false;
let paired = false;
let held = false;

/**
 * Drop every relay-derived fact back to "we know nothing" (FORGE-O).
 *
 * There are five places that invalidate this state — socket open, socket close,
 * connect() throw, sign-out, and the auth refresh — and before FORGE-O each one
 * hand-cleared `phonePresent` on its own line. Adding two more fields to five
 * independent reset sites is how one of them quietly keeps `paired = true`
 * across a reconnect and paints green over a room the worker has not heard from
 * since. One function, five callers, nothing to keep in sync.
 *
 * Does NOT touch `signedIn` (auth outlives the socket) and does NOT repaint —
 * callers decide when to call refreshIndicator(), since several of them change
 * other facts in the same breath.
 */
function clearRelayFacts() {
  wsOpen = false;
  phonePresent = false;
  paired = false;
  held = false;
}
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
// FORGE-M: ceiling for an ABNORMAL close (1006/1001 — worker/network death).
// Escalation still applies, it just tops out here instead of at 30 s, so the
// relay's panel hold regains its listener liveness signal quickly.
const ABNORMAL_CLOSE_BACKOFF_CAP_MS = 5_000;

// Unread counters, per surface tab. Kept in chrome.storage.session (cleared on
// browser restart, never written to disk) rather than in SW memory, because the
// SW is torn down and respawned constantly under MV3 — a module-level counter
// would silently reset itself several times an hour.
const UNREAD_KEY = 'cc_unread';
const UNREAD_ZERO = { missedCalls: 0, newSms: 0, alerts: 0 };
// Phone battery telemetry (BAT-2 (b)). Same storage class and the same reason
// as the counters, plus one of its own: the surfaces must be able to render a
// battery level the INSTANT the popup opens, and the last BATTERY frame may
// have arrived long before — under the phone's cadence, up to ten minutes. A
// module-level variable would be gone with the next eviction and the header
// would sit blank until the phone's next push.
//
// Record: `{pct, charging, ts, v:1}`. RESUME-PROTOCOL rule 6 — a stored record
// carries a `v` tag and an unknown-version guard that FAILS LOUDLY rather than
// "working on my machine" against an old shape: an unrecognised `v` is ignored
// AND the row is cleared, so the next frame writes a clean record instead of
// merging into one nobody can interpret.
// storage.session ONLY (BAT-A1 MUST-3): never storage.local, never disk. A
// battery reading is device telemetry scoped to who is signed in, and it is
// cleared at the sign-out and unpair sites below alongside the counters.
const BATTERY_KEY = 'cc_battery';
const BATTERY_RECORD_VERSION = 1;
// Companion row to UNREAD_KEY: the notificationKeys behind the current
// `alerts` count, so a phone-side dismissal can decrement exactly the bumps it
// owns. See bumpAlert/dropAlert.
const ALERT_KEYS = 'cc_alert_keys';

const GREEN = '#16a34a';
const GREY = '#9ca3af';
/**
 * FORGE-O — the "resuming" dot. A held pair (panel closed, or a socket blip
 * inside the resume window) is neither connected nor disconnected: the relay
 * still owns the pair and will re-form it with no Accept tap, but nothing can
 * be sent over it this instant. Amber, because the honest answer to "am I
 * connected?" in that window is "not yet, hold on" — and because a user who
 * sees green and then cannot dial has been lied to, which is the whole bug.
 */
const AMBER = '#d97706';
/** Unread-count chip. Red because it is the one thing asking to be acted on. */
const BADGE_RED = '#dc2626';

// ── Token ──────────────────────────────────────────────────────────────────
/**
 * P5a-SW (a). The three facts tokenAbsenceVerdict() needs, maintained HERE —
 * beside the only three functions that can change them — rather than at the
 * call sites that read a null and have to guess what it meant.
 *
 *   authHydrated  flipped by the first getToken() that completes, ever.
 *   tokenEverSeen flipped by any non-null read or a store.
 *   tokenRevoked  set ONLY by markTokenRevoked(): explicit sign-out, or 401/409
 *                 from the token endpoint. Retired by a store OR by simply
 *                 OBSERVING a live token — a token in storage means the
 *                 revocation no longer describes reality.
 *
 * Module scope, so all three die with the worker — which is correct: they
 * describe what THIS worker lifetime knows, and a respawn genuinely knows
 * nothing until its first read lands.
 */
let authHydrated = false;
let tokenEverSeen = false;
let tokenRevoked = false;

/** The facts snapshot handed to the pure rule. */
function authFacts() {
  return { hydrated: authHydrated, everSeen: tokenEverSeen, cleared: tokenRevoked };
}

/**
 * The ONLY way `cleared` becomes true. Two callers, both authoritative: the
 * 'signed-out' message from the popup, and mintTicket's 401/409. Nothing on
 * the wire and no timeout may reach this — a transient failure that could set
 * it would reintroduce the exact repaint this fix removes.
 */
function markTokenRevoked() {
  tokenRevoked = true;
}

function getToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(self.CC.TOKEN_KEY, (o) => {
      const token = o?.[self.CC.TOKEN_KEY] || null;
      authHydrated = true;
      if (token) {
        tokenEverSeen = true;
        // OBSERVING a live token retires an earlier revocation. `cleared`
        // means "the token we held was revoked", and a token sitting in
        // storage is that statement being out of date — someone signed back
        // in. Found by the P5a-SW control arm: the badge proof signs out in
        // block 10 and re-seeds a token in block 11 by writing storage
        // DIRECTLY, which is also what a second surface (the popup's own
        // sign-in) does. Pinning the flag to storeToken() alone would leave
        // the worker permanently convinced it was signed out while holding a
        // perfectly good token. Both revocations null the token in storage
        // first (clearToken before markTokenRevoked), so this can never
        // resurrect the one that was just refused.
        tokenRevoked = false;
      }
      resolve(token);
    });
  });
}
function clearToken() {
  return new Promise((resolve) => chrome.storage.local.remove(self.CC.TOKEN_KEY, resolve));
}
function storeToken(token) {
  tokenEverSeen = true;
  tokenRevoked = false;   // a fresh token supersedes any earlier revocation
  return new Promise((resolve) =>
    chrome.storage.local.set({ [self.CC.TOKEN_KEY]: token }, resolve),
  );
}

// ── E2E: this worker's device key (P3 (a)) ──────────────────────────────────
/**
 * The key itself lives in chrome-extension/e2e/sw-key.js; what lives here is
 * the worker's relationship to it.
 *
 * `swDeviceId` is cached in module scope ON PURPOSE even though module scope
 * does not survive an MV3 eviction: it is read on the synchronous path that
 * builds the relay URL, and re-reading IndexedDB there would mean either an
 * await in connect() before the socket exists (fine) or a stale id (not fine).
 * It is loaded once per worker boot by primeDeviceKey() below, and connect()
 * awaits that priming rather than guessing.
 *
 * FAIL SOFT, LOUDLY. If the key cannot be loaded — an unknown record version,
 * a broken IndexedDB — the worker still connects, just WITHOUT `?deviceId=`.
 * The relay then sends a PAIR_STATE with no `e2e` block, which is precisely the
 * pre-P3 behaviour every shipped build already produces and which (d) handles
 * as counts-only. Refusing to connect would cost the user their notifications
 * entirely in exchange for nothing.
 */
let swDeviceId = null;
let swPubKey = null;
let deviceKeyError = null;
let deviceKeyPrimed = null;
/**
 * INC-0923 B-1. Whether swPubKey is LIVE IN THE §13.6 PIN REGISTRY, which is a
 * different question from whether we hold it, and the one that decides whether
 * it may be advertised as a pairing recipient. See publicIdentity() in
 * e2e/sw-key.js for why an unregistered advert is worse than no advert.
 *
 * Read off the persisted record on every prime, so it survives an MV3 eviction
 * the way the key itself does — this must NOT be worker-lifetime state that a
 * respawn silently resets to false (a respawn would then withhold a key that
 * IS registered and downgrade the user for no reason).
 */
let swRegistered = false;
/** The last registration refusal, for the panel header. Null = nothing wrong. */
let deviceKeyRegisterError = null;

/**
 * Re-read the key rather than trusting the last answer. Deliverable (e) / M-C:
 * an IndexedDB wipe must produce a NEW deviceId on the next reconnect, and a
 * module-level cache that outlives the wipe would keep announcing a deviceId
 * whose private key no longer exists — the relay would keep handing this worker
 * wraps it can never open, which looks identical to a crypto bug and is not one.
 * Called from connect(), which is already serialised by `connecting`.
 */
function refreshDeviceKey() {
  deviceKeyPrimed = null;
  return primeDeviceKey();
}

/**
 * The signed-in userId, for A3's pairContext.
 *
 * A3: `userId` is deliberately NOT transmitted. Each side uses its own
 * AUTHENTICATED session identity, so a mismatch fails closed — transmitting it
 * would let the relay propose an identity and the derivation would agree with
 * the relay instead of with the session. Vector I.3 pins the cost of getting
 * this wrong: one character of drift gives total key divergence.
 *
 * So it comes from `/api/auth/me` with the session cookie and from nowhere
 * else. Cached in storage.session (not local) because it is scoped to who is
 * signed in right now, and re-fetched on every worker boot and auth change.
 */
const USER_ID_KEY = 'cc_e2e_user_id';
let cachedUserId = null;

async function localUserId() {
  if (cachedUserId) return cachedUserId;
  const stored = await new Promise((r) => {
    try { chrome.storage.session.get(USER_ID_KEY, (o) => r((o && o[USER_ID_KEY]) || null)); }
    catch { r(null); }
  });
  if (stored) { cachedUserId = stored; return stored; }
  try {
    const res = await fetch(self.CC.ME_URL, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json();
    const id = body?.user?.id || body?.id || null;
    if (typeof id === 'string' && id) {
      cachedUserId = id;
      try { chrome.storage.session.set({ [USER_ID_KEY]: id }); } catch { /* best effort */ }
      return id;
    }
  } catch { /* offline — counts-only until the next attempt, which is correct */ }
  return null;
}

/**
 * Security A5 / M-A5-3: WHY this reply carries no key, as a token the page may
 * branch on.
 *
 * Null is not one situation. "The worker has no key yet" and "the worker had a
 * key and loading it threw" are the same `pub: null` on the wire and want
 * different page behaviour -- the first is an extension that is simply not part
 * of this pairing (badge it absent, 2 recipients, honest), the second is a
 * broken worker where the honest move is to WAIT rather than to present a SAS
 * that silently excludes it. A5's null arm forbids exactly one thing: showing a
 * 2-key code as though it covered the SW.
 *
 * Tokens are stable and short by design; `error` keeps the diagnostic text.
 */
function nullKeyReason() {
  if (swPubKey && swRegistered) return null;
  // INC-0923 B-1. A THIRD situation, and it has to be its own token: we hold a
  // perfectly good key and are withholding it on purpose, because the pin
  // registry has no live row for it and the phone would read the advert as a
  // substituted key rather than an unverified one. "Broken worker, wait" is the
  // wrong response to this and "no extension in this pairing" is the right one,
  // so the page must be able to tell it from both of the others.
  if (swPubKey && !swRegistered) return 'not-registered';
  if (deviceKeyError) return 'key-unavailable';
  return 'not-hydrated';
}

/**
 * The identity fields for the page bridge: the key, or nulls.
 *
 * ONE place, because this reply has two arms (the happy path and the catch)
 * that must agree — a withheld key on one and an advertised one on the other
 * is exactly the bug class this whole change removes.
 */
function bridgeIdentityFields() {
  const advertise = !!swPubKey && swRegistered;
  return {
    deviceId: advertise ? swDeviceId : null,
    pub: advertise ? swPubKey : null,
    error: deviceKeyError,
    reason: nullKeyReason(),
  };
}

function primeDeviceKey() {
  if (!deviceKeyPrimed) {
    deviceKeyPrimed = publicIdentity()
      .then((id) => {
        if (swDeviceId && swDeviceId !== id.deviceId) {
          // The key was regenerated under us (M-C). Every cached wrap was
          // sealed to the key that is now gone, so keeping them would mean
          // re-deriving garbage on the next wake. Drop them and say counts-only
          // until a pairing includes the new key.
          dropSessionState().catch(() => {});
          setCountsOnly('device-key-regenerated');
          trace('e2e-key-regen', { from: swDeviceId, to: id.deviceId });
        }
        swDeviceId = id.deviceId;
        swPubKey = id.pub;
        swRegistered = id.registered === true;
        deviceKeyError = null;
        trace('e2e-key', { deviceId: id.deviceId, registered: swRegistered });
        return id;
      })
      .catch((e) => {
        // Never cached as a resolved value: the message is the whole diagnostic
        // and an unknown-version record must keep saying so on every boot.
        swDeviceId = null;
        swPubKey = null;
        swRegistered = false;
        deviceKeyError = String((e && e.message) || e);
        console.warn('[CC-SW] e2e device key unavailable — counts-only:', deviceKeyError);
        trace('e2e-key-fail', { why: deviceKeyError.slice(0, 120) });
        return null;
      });
  }
  return deviceKeyPrimed;
}

/**
 * Register the key in the DeviceKey pin registry (§13.6). Best effort by
 * design: the registry is a CHECK, and the channel that actually puts this key
 * into a pairing is the page bridge. A failure downgrades the pair to
 * UNVERIFIED and is logged; it never blocks the socket and never throws.
 */
async function registerDeviceKeyBestEffort() {
  const token = await getToken();
  if (!token) {
    // INC-0923 B-2 (a). Signed out is a REASON, not a silent return. It is also
    // usually temporary: at SW boot chrome.storage.local may simply not have
    // been read yet, or the ext-session token is being re-minted after an idle
    // logout. The old code returned here and left registration to two other
    // call sites that a reload does not reach.
    deviceKeyRegisterError = 'signed-out';
    trace('e2e-register-skip', { why: 'no-token' });
    broadcastE2eStatus();
    return { ok: false, reason: 'signed-out', retryable: true };
  }
  const r = await registerSwDeviceKey({ webappOrigin: self.CC.WEBAPP_ORIGIN, token });
  if (!r.ok) {
    // 409 pairing_in_flight (B-2 b) is the one refusal that is CORRECT and
    // self-clearing: the route refuses for the ~30 s a handshake is open so the
    // key set cannot change under a SAS the user is reading. Retrying past it
    // is the whole remedy — it is not an error state to show anybody.
    const inFlight = r.status === 409;
    deviceKeyRegisterError = inFlight ? null : String(r.reason);
    console.warn('[CC-SW] device key registration failed (SW key withheld from pairing):', r.reason);
    trace('e2e-register-fail', { reason: String(r.reason).slice(0, 40) });
    broadcastE2eStatus();
    return { ok: false, reason: String(r.reason), retryable: true };
  }
  swRegistered = true;
  deviceKeyRegisterError = null;
  trace('e2e-register', { rotated: !!r.rotated });
  broadcastE2eStatus();
  return { ok: true };
}

/**
 * INC-0923 B-2 (c). Registration with backoff, single-flight.
 *
 * WHY A RETRY AT ALL. Every reason the row can be missing is transient —
 * no token yet at SW boot, a 409 while a handshake is open, a network blip —
 * and the old code had exactly one attempt per trigger with three triggers, one
 * of which (SW boot) is the least likely moment for a token to be readable. A
 * user whose single attempt lost the race stayed unregistered until they
 * happened to sign in again, which is why the workaround in ROOT-CAUSE.md is
 * "sign out and back in".
 *
 * BOUNDED, because an unbounded retry in an MV3 worker is a wakelock. Five
 * attempts, 2 s doubling to 32 s, then it stops and says so in the header; the
 * next trigger (sign-in, panel open, pairing start) starts a fresh ladder.
 */
const REGISTER_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
let registerInFlight = null;

function registerDeviceKeyWithRetry(why) {
  if (registerInFlight) return registerInFlight;
  registerInFlight = (async () => {
    for (let attempt = 0; attempt <= REGISTER_BACKOFF_MS.length; attempt += 1) {
      // Already live (another trigger won, or a previous worker registered and
      // the flag is on the persisted record): nothing to do, and re-POSTing
      // would be a pointless write on the pairing's critical path.
      if (swRegistered) return true;
      const r = await registerDeviceKeyBestEffort();
      if (r.ok) {
        trace('e2e-register-ok', { why, attempt });
        return true;
      }
      if (attempt === REGISTER_BACKOFF_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, REGISTER_BACKOFF_MS[attempt]));
    }
    trace('e2e-register-gave-up', { why, attempts: REGISTER_BACKOFF_MS.length + 1 });
    return false;
  })();
  const settle = () => { registerInFlight = null; };
  registerInFlight.then(settle, settle);
  return registerInFlight;
}

/**
 * The header's copy for the current registration state, or null when there is
 * nothing a USER can act on.
 *
 * Null for 'signed-out' and for a 409: the first resolves itself the moment the
 * token lands and the second is the route CORRECTLY refusing for the ~30 s a
 * handshake is open. Telling a user to sign out and back in over either would
 * be telling them to fix a thing that is not broken.
 */
function e2eRegisterWarning() {
  if (swRegistered) return null;
  if (!deviceKeyRegisterError || deviceKeyRegisterError === 'signed-out') return null;
  return 'extension not verified — sign out and back in';
}

/**
 * Push the e2e registration state to every open surface, over the SAME
 * `cc-presence` port the unread counts and the battery use.
 *
 * The port, and NOT chrome.runtime.sendMessage: the header this ends up in is
 * React inside the app iframe (components/PhoneModeHeader.tsx), so the value
 * has to travel SW -> shell.js -> frame postMessage -> extensionBridge, and the
 * port is the only one of the two channels with surface lifetime. A one-shot
 * sendMessage with no listening surface rejects, which would make "nobody is
 * looking" indistinguishable from a real failure.
 */
function e2eStatusMessage() {
  return { type: 'e2e-status', registered: swRegistered, warning: e2eRegisterWarning() };
}

function broadcastE2eStatus() {
  const msg = e2eStatusMessage();
  for (const port of presencePorts) {
    try { port.postMessage(msg); } catch { /* port closed */ }
  }
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
 *
 * FORGE-O widened the vocabulary from three states to five. `phone-unpaired` and
 * `signed-in-disconnected` share the grey dot deliberately — the DOT only has to
 * answer "can I use this right now?", and for both the answer is no — but they
 * get different TITLES, because the required user action differs sharply: one
 * needs you to click Connect, the other needs you to wait. Collapsing them to one
 * tooltip is what left Dennis with no way to tell "your phone is right here,
 * press the button" from "the relay is down".
 *
 * @param {'connected'|'resuming'|'phone-unpaired'|'signed-in-disconnected'|'signed-out'} state
 */
async function applyIndicator(state) {
  if (state === lastIndicator) return;
  lastIndicator = state;
  const color =
    state === 'connected' ? GREEN :
    state === 'resuming' ? AMBER :
    (state === 'phone-unpaired' || state === 'signed-in-disconnected') ? GREY :
    null;
  const title =
    state === 'connected' ? 'ComputerCaller — phone connected' :
    state === 'resuming' ? 'ComputerCaller — reconnecting…' :
    state === 'phone-unpaired' ? 'ComputerCaller — phone nearby, not connected. Open the panel and press Connect.' :
    state === 'signed-in-disconnected' ? 'ComputerCaller — waiting for phone' :
    'ComputerCaller';
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

/**
 * Recompute from the four facts + auth. Call after ANY of them changes.
 *
 * The full table (FORGE-O), which is also the table the panel copy follows:
 *
 *   signedIn  wsOpen  phonePresent  paired  held │ dot    title / pill
 *   ─────────────────────────────────────────────┼──────────────────────────────
 *   false     –       –             –       –    │ none   (signed out)
 *   true      false   –             –       –    │ grey   Reconnecting to relay
 *   true      true    false         false   false│ grey   Waiting for phone
 *   true      true    true          false   false│ grey   Phone nearby — not connected
 *   true      true    –             false   true │ amber  Reconnecting…
 *   true      true    true          true    –    │ GREEN  Connected
 *
 * `paired` is checked before `held` because the relay can briefly report both
 * during a resume (the claim is cleared after PAIRING_ACTIVE goes out); a live
 * pair always wins. `phonePresent` never reaches green on its own any more —
 * that was the bug.
 */
function refreshIndicator() {
  if (!signedIn) return applyIndicator('signed-out');
  if (!wsOpen) return applyIndicator('signed-in-disconnected');
  if (paired) return applyIndicator('connected');
  if (held) return applyIndicator('resuming');
  if (phonePresent) return applyIndicator('phone-unpaired');
  return applyIndicator('signed-in-disconnected');
}

/**
 * A4.1-M1 (Security addendum A4.1, RATIFIED 2026-09-17). The PROVENANCE of the
 * SW's own-pairingId pin, derived from the existing `cc_e2e_own_pairing`
 * record — no new storage key, and nothing here writes.
 *
 * Why it must exist: `e2e-pubkey-get` echoes the pin's `pairingId` back, so a
 * page that hands its pairingId over the pinned bridge cannot tell its
 * hand-over LANDED from a TOFU pin being echoed straight back at it. The two
 * replies are byte-identical today. D1 has to assert "hand-over landed" and
 * P6(b) has to assert the epoch-reset re-pin; without the source, both can
 * only infer it.
 *
 * DIAGNOSTICS ONLY, and that constraint is normative (A4.1-M1 + m-G): never
 * rendered to a user, never gates a code path, never changes `mode`. A4.1-M2
 * says why it must not: the pin is a consistency hint that a wire-delivered
 * ROOM_RESET can erase, so it confers no authenticity — the SW's membership
 * proof is A4 clause (b), the own-wrap unwrap under KEK(ctx, own static key).
 * Gating on this would be gating on a field an attacker can clear at will.
 *
 * 'none' rather than null for the absent case, so the three states form one
 * closed set a harness can assert exhaustively.
 */
function pinProvenance(own) {
  const source = own && (own.source === 'bridge' || own.source === 'tofu') ? own.source : 'none';
  const epoch = own && own.pairEpoch != null ? String(own.pairEpoch) : null;
  return { pairingIdSource: source, pairingIdEpoch: epoch };
}

/**
 * Re-read the token and re-render. Cheap; called on every auth transition.
 *
 * P5a-SW (a): a null no longer means "signed out" on its own. When the rule
 * says KEEP, this function paints NOTHING — the last committed indicator
 * stands, which is the honest rendering of "we do not know yet" and needs no
 * new visual state for the user to misread. `signedIn` is likewise left alone
 * rather than being asserted in either direction.
 */
async function refreshAuthAndIndicator() {
  const token = await getToken();
  if (token) {
    signedIn = true;
  } else if (tokenAbsenceVerdict(authFacts()) === 'clear') {
    signedIn = false;
    clearRelayFacts();
  } else {
    return;   // unknown yet — keep the last painted state
  }
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

function writeSession(obj) {
  return new Promise((r) => {
    try { chrome.storage.session.set(obj, r); } catch { r(); }
  });
}

// ── Phone battery (BAT-2 (b); GATE1 Addendum BAT-A1) ────────────────────────
/**
 * Read the stored battery record, or null.
 *
 * RESUME-PROTOCOL rule 6, the unknown-version guard: a record whose `v` is not
 * BATTERY_RECORD_VERSION is not "probably close enough" — it was written by a
 * shape this build does not know, and rendering it would be the "works on my
 * machine against an old record" failure the rule exists to prevent. It is
 * ignored AND the row is cleared, so the next frame starts clean.
 *
 * DISPLAY-ONLY (MUST-3). Nothing in this worker reads the result into mode,
 * pairing, tier, quota or session state; the only consumers are the surfaces.
 */
function readBattery() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(BATTERY_KEY, (o) => {
        const rec = o && o[BATTERY_KEY];
        if (!rec || typeof rec !== 'object') { resolve(null); return; }
        if (rec.v !== BATTERY_RECORD_VERSION) {
          try { chrome.storage.session.remove(BATTERY_KEY); } catch { /* best effort */ }
          resolve(null);
          return;
        }
        resolve(rec);
      });
    } catch { resolve(null); }
  });
}

/**
 * Record one BATTERY frame.
 *
 * Runs inside `serialize` for the same reason every other storage.session
 * mutation does: this is a read-modify-write across an await, and the relay
 * delivers in bursts. Unserialised, two frames in one turn both read the
 * pre-burst value and the older one can win.
 *
 * Older `ts` loses. The relay may reorder nothing today, but a resume that
 * re-forms a pair while a frame is in flight can deliver yesterday's reading
 * after today's, and a battery percentage that jumps backwards is a bug the
 * user sees. Equal `ts` also loses: a duplicate is not news.
 *
 * The frame has already passed `inboundDisposition`'s shape gate, so the three
 * fields are known good here; they are copied FIELD BY FIELD rather than spread
 * so an unknown extra key on the wire cannot land in storage.
 */
function noteBattery(data) {
  return serialize(async () => {
    try {
      const prev = await readBattery();
      if (prev && typeof prev.ts === 'number' && data.ts <= prev.ts) return;
      const rec = { pct: data.pct, charging: data.charging, ts: data.ts, v: BATTERY_RECORD_VERSION };
      await writeSession({ [BATTERY_KEY]: rec });
      broadcastBattery(rec);
    } catch { /* telemetry must never break the worker */ }
  });
}

/** §13.8 — sign-out and unpair drop it, alongside the unread counters. */
function clearBattery() {
  return serialize(async () => {
    try {
      await new Promise((r) => { try { chrome.storage.session.remove(BATTERY_KEY, r); } catch { r(); } });
      broadcastBattery(null);
    } catch { /* best effort */ }
  });
}

/** Live push to any open surface, so an open panel does not wait for a re-open. */
function broadcastBattery(battery) {
  for (const port of presencePorts) {
    try { port.postMessage({ type: 'battery', battery }); } catch { /* port closed */ }
  }
}

/**
 * The notificationKeys whose `alerts` bump is still standing.
 *
 * Kept in storage.session next to the counter rather than in a module-level
 * Set: the worker is routinely evicted between a notification arriving and the
 * phone-side dismissal that takes it back, and a decrement that lands on a
 * respawned worker with an empty Set would be silently dropped — leaving the
 * badge permanently one too high, which is the bug this exists to prevent.
 */
function readAlertKeys() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(ALERT_KEYS, (o) => {
        const v = o && o[ALERT_KEYS];
        resolve(Array.isArray(v) ? v.slice() : []);
      });
    } catch { resolve([]); }
  });
}

/** The phone's identity for one notification, across the spellings the APK uses. */
function notifKeyOf(data) {
  if (!data || typeof data !== 'object') return '';
  const k = data.notificationKey || data.key || data.id;
  return typeof k === 'string' || typeof k === 'number' ? String(k) : '';
}

/**
 * bumpUnread('alerts'), plus a record of WHICH notification the bump was for.
 *
 * Same serialize() queue and the same presence gate as bumpUnread, and the two
 * writes go out as ONE storage.session.set: if the counter and the key set
 * could be written separately an eviction between them would leave a count
 * nothing can decrement, or a key that decrements a count it never raised.
 */
function bumpAlert(notificationKey) {
  return serialize(async () => {
    if (presenceCount > 0) return;
    const cur = await readUnread();
    const next = Object.assign({}, cur, { alerts: (cur.alerts || 0) + 1 });
    const keys = await readAlertKeys();
    if (notificationKey && keys.indexOf(notificationKey) === -1) keys.push(notificationKey);
    // Bounded. A phone that posts hundreds of notifications behind a closed
    // panel must not grow this row without limit; the oldest keys are the ones
    // least likely to still be dismissible.
    await writeSession({ [UNREAD_KEY]: next, [ALERT_KEYS]: keys.slice(-200) });
    paintBadge(next);
    broadcastUnread(next);
  });
}

/**
 * A notification was dismissed ON THE PHONE (NOTIFICATION_REMOVED). Take the
 * `alerts` bump back — but ONLY if this exact key is one we actually counted.
 *
 * The guard is the whole point. A dismissal can arrive for a notification that
 * was never counted here: it landed while the panel was open (bumpUnread's
 * presence gate declined it), or it arrived as a v58 backfill replay, or its
 * bump was already cleared by the user viewing the Alerts tab. Decrementing
 * blind on any of those drives the badge below the number of things actually
 * waiting — a badge that undercounts is worse than one that is merely stale,
 * because it hides real messages.
 */
function dropAlert(notificationKey) {
  if (!notificationKey) return Promise.resolve();
  return serialize(async () => {
    const keys = await readAlertKeys();
    const i = keys.indexOf(notificationKey);
    if (i === -1) return;            // never counted ⇒ badge unchanged
    keys.splice(i, 1);
    const cur = await readUnread();
    const next = Object.assign({}, cur, { alerts: Math.max(0, (cur.alerts || 0) - 1) });
    await writeSession({ [UNREAD_KEY]: next, [ALERT_KEYS]: keys });
    paintBadge(next);
    broadcastUnread(next);
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
    // Zeroing `alerts` retires every bump behind it, so the key set has to go
    // with it — otherwise a later phone-side dismissal would find its key
    // still listed and decrement a count that is already 0.
    const write = { [UNREAD_KEY]: next };
    if (key === 'alerts') write[ALERT_KEYS] = [];
    await writeSession(write);
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

// ── P3.1 / FT-A1 §2 — sealed FILE_* passthrough ─────────────────────────────
//
// Read this whole block before adding anything to it.
//
// The page — /app in the side panel or the pop-out — holds its OWN socket and
// runs the entire transfer there. This worker's socket is the notification side
// channel and it exists here for exactly one reason: a sealed FILE_OFFER can
// arrive while no page is open, and something has to keep it alive long enough
// for the user to open one.
//
// What this worker does NOT do, and must never be extended to do:
//   · it does not UNSEAL a FILE_* frame (it forwards `{e,kid,s,c}` verbatim);
//   · it does not SEAL one (`sealFrame()` refuses every type outside §13.7's
//     frozen list, and that refusal is not widened);
//   · it does not hold file bytes — a FILE_CHUNK is forwarded as the opaque
//     envelope it arrived as and is never parsed, buffered or stored;
//   · it does not originate FILE_ACCEPT / REJECT / ACK / RESUME. The page owns
//     every reply because the page owns the transfer.
// The last one is not a preference: `assertSwSendsNothing()` pins it, and the
// relay drops anything a `?role=listener` socket sends anyway (server.js, the
// `if (ws.listener) return` short-circuit above the whole data plane).
const FILE_PASSTHROUGH_MSG = 'file-passthrough';

/**
 * The single pending sealed offer. One at a time — one transfer per room, by
 * rule — and a second offer replaces the first, failing it with `timeout`.
 *
 * MODULE MEMORY, NOT `storage.session`, AND THAT IS THE DELIBERATE CHOICE.
 * MUST B-4 says the marker holds only `{ft.id, receivedAt}` plus the opaque
 * envelope and must not leak across an MV3 eviction. Module memory gives that
 * for free: an eviction discards the marker and the envelope together, which is
 * the SAFE direction — no replay happens, and the sender's own 30 s stall timer
 * fails the transfer correctly and independently. Writing it to storage would
 * buy a rescue we do not need and put an untrusted opaque blob in a durable
 * store, and it would add an `cc_e2e_*` key that the P3 storage-surface
 * assertion would then have to be widened for.
 *
 * @type {{id: string, receivedAt: number, envelope: object, timer: any} | null}
 */
let pendingSealedOffer = null;

/** Push one file-transfer event down every open presence port, verbatim. */
function forwardFileFrameToPage(frameType, payload) {
  let delivered = 0;
  for (const port of presencePorts) {
    // `catch {}` rather than this file's older `catch (_) {}` so the addition
    // raises no new no-unused-vars warning against the lint floor.
    try { port.postMessage({ type: FILE_PASSTHROUGH_MSG, frameType, payload }); delivered += 1; }
    catch { /* port closed between the presence check and here */ }
  }
  return delivered;
}

/** Forget the marker and stop its timer. Never emits anything by itself. */
function clearPendingOffer() {
  if (!pendingSealedOffer) return null;
  const was = pendingSealedOffer;
  try { clearTimeout(was.timer); } catch { /* not a timer host */ }
  pendingSealedOffer = null;
  return was;
}

/**
 * MUST B-3, as far as it can honestly be taken — and a flag where it cannot.
 *
 * B-3 says the worker emits `FILE_FAILED {id, reason:'timeout'}` **to the
 * phone**. It cannot, and the gap is structural rather than a missing line:
 *
 *   1. NO CHANNEL. `server.js` short-circuits `if (ws.listener) return` at the
 *      top of the browser message handler, above pairing and above the data
 *      plane, so every frame this socket sends is dropped by the relay before
 *      it can be routed anywhere. The listener socket is receive-only by
 *      construction, which is also why the extension is allowed to hold one.
 *   2. NO SEND PATH. `assertSwSendsNothing()` (tests/e2e-sw-chokepoint claim 3)
 *      pins that this worker calls `.send(` on no socket at all.
 *   3. IT WOULD BE DROPPED ANYWAY. The frame would be plaintext, and a
 *      plaintext FILE_FAILED under mode ON is refused by the phone's own B-1
 *      guard unless it carries `relay:true` — which only the relay may mint
 *      (FT-A1.1 M6) and which this worker must never forge. Sealing it instead
 *      is forbidden by FT-A1 §2.1/§2.2.
 *
 * So the refusal is emitted to the PAGE, which is the party that owns transfer
 * state and holds a socket that can actually speak. A page that attaches after
 * the marker died learns the offer is dead instead of being handed a stale
 * envelope to prompt on. Flagged to Ken + Security as an FT-A1 §2.3 amendment;
 * §2.3 already notes the sender's 30 s stall fires first and independently, so
 * nothing is left unhandled on the wire — only the reason arrives later.
 */
function expirePendingOffer() {
  const was = clearPendingOffer();
  if (!was) return null;
  // Authored here, so it is authored in full and with no `relay` mark: this
  // worker is not the relay. `assertSwMintsNoRelayMark()` pins that.
  const payload = { id: was.id, reason: 'timeout' };
  forwardFileFrameToPage('FILE_FAILED', payload);
  trace('ft-offer-expired', { id: was.id });
  return payload;
}

/** Expire lazily too: a throttled worker's timers are not a correctness basis. */
function pendingOfferIfLive(now = Date.now()) {
  if (!pendingSealedOffer) return null;
  if (now - pendingSealedOffer.receivedAt >= PENDING_OFFER_TTL_MS) { expirePendingOffer(); return null; }
  return pendingSealedOffer;
}

/**
 * A sealed FILE_* frame, routed. Never opened.
 *
 * With a page attached this is a pure forward. With none, only FILE_OFFER is
 * worth holding: the other seven are moves inside a transfer no page is running
 * and a replayed FILE_CHUNK would be file bytes held in a worker.
 */
function routeSealedFileFrame(frameType, envelope) {
  if (presenceCount > 0 && forwardFileFrameToPage(frameType, envelope) > 0) {
    // A page is here and took it. Any offer we were holding is now moot.
    if (frameType === 'FILE_OFFER') clearPendingOffer();
    return 'forwarded';
  }
  if (frameType !== 'FILE_OFFER') return 'no-page';

  // MUST A-1 / MUST B-2: the id comes from the plaintext hint and nowhere else
  // — the real one is sealed and this worker does not open it. No hint means no
  // name for the refusal we would later have to author, so there is nothing to
  // hold: drop and count, exactly as the relay does for `bad_hint`.
  const id = ftHintId(envelope);
  if (!id) {
    noteDrop('ft-hint-missing').catch(() => {});
    trace('ft-offer-no-hint', {});
    return 'dropped';
  }
  // One at a time. The one being replaced fails with `timeout` rather than
  // vanishing, so the page (and the trace) sees a terminal state for it.
  if (pendingSealedOffer) expirePendingOffer();
  const receivedAt = Date.now();
  pendingSealedOffer = {
    id,
    receivedAt,
    envelope,     // opaque. Never parsed, never logged, never written to disk.
    timer: setTimeout(() => { expirePendingOffer(); }, PENDING_OFFER_TTL_MS),
  };
  trace('ft-offer-pending', { id });
  return 'pending';
}

/**
 * A page attached. Replay the held offer once, if it is still inside its TTL.
 *
 * VERBATIM, and still sealed: the page unseals it with its own session and
 * applies MUST A-5's compare. Consumed on replay — a marker that survived being
 * delivered would prompt again on the next panel open.
 */
function replayPendingOfferTo(port) {
  const live = pendingOfferIfLive();
  if (!live) return false;
  try { port.postMessage({ type: FILE_PASSTHROUGH_MSG, frameType: 'FILE_OFFER', payload: live.envelope }); }
  catch { return false; }
  clearPendingOffer();
  trace('ft-offer-replayed', { id: live.id });
  return true;
}

/** Test/diagnostics accessor. Returns no envelope — it is not ours to publish. */
function pendingOfferForTest() {
  return pendingSealedOffer
    ? { id: pendingSealedOffer.id, receivedAt: pendingSealedOffer.receivedAt }
    : null;
}

// ── FT-3a: file-transfer routing (ROUTING ONLY) ─────────────────────────────
//
// Read this before extending it.
//
// The page — /app in the side panel or the pop-out — holds its OWN socket to
// the relay and runs the whole transfer there (hooks/useFileTransfer). This
// worker's socket is the notification side channel, and it is a PINNED
// invariant that it sends nothing (tests/e2e-sw-chokepoint.test.mjs claim 3),
// so nothing here originates FILE_ACCEPT / FILE_REJECT / FILE_ACK /
// FILE_RESUME. That is the page's job and it stays the page's job.
//
// What this worker does is narrower: when an offer arrives and the panel is
// not open, note that ONE marker so the surface can show there is a file
// waiting. FILE_CHUNK is deliberately absent from every path below — a worker
// that touched chunk bodies would be holding file bytes, which is the one
// thing the 1 GB design exists to prevent.
const FILE_ROUTED_TYPES = new Set(['FILE_OFFER', 'FILE_DONE', 'FILE_FAILED']);

/** The single pending-offer marker. No queue: one transfer per room, by rule. */
let pendingFileOffer = null;

function broadcastFileEvent(event) {
  for (const port of presencePorts) {
    // `catch {}` rather than the file's older `catch (_) {}` so this addition
    // does not raise the no-unused-vars warning count.
    try { port.postMessage({ type: 'file', event }); } catch { /* port closed */ }
  }
}

/**
 * @param {string} type one of FILE_ROUTED_TYPES
 * @param {object} data the frame body, or {} when it arrived sealed
 * @param {boolean} sealed true when the body could not be opened
 */
function routeFileFrame(type, data, sealed) {
  if (type === 'FILE_CHUNK') return;             // never, under any condition
  if (!FILE_ROUTED_TYPES.has(type)) return;

  if (type === 'FILE_OFFER') {
    // Under encrypted mode the name and mime are sealed and we do not have
    // them. Say so rather than inventing a filename: the page will render the
    // real offer from its own socket, and this marker only has to say "a file
    // is waiting".
    pendingFileOffer = {
      id: typeof data.id === 'string' ? data.id : null,
      sealed,
      at: Date.now(),
    };
  } else if (pendingFileOffer && (data.id === undefined || data.id === pendingFileOffer.id)) {
    pendingFileOffer = null;
  }
  broadcastFileEvent({ kind: type, pending: pendingFileOffer });
}

/** Test/diagnostics accessor. Never a source of truth for the page. */
function pendingFileOfferForTest() {
  return pendingFileOffer;
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
/**
 * #18 Fix C (T-SW-REGISTER-ON-TYPED-SIGNIN). A sign-in must re-register the
 * SW key, because the sign-out before it CLEARED the registration (see the
 * 'signed-out' handler: clearDeviceKeyRegistered + swRegistered=false) and the
 * key is withheld from the pairing advert until it is live again (INC-0923
 * B-1). The only sign-in that registered was the retired 'auth-updated'
 * message, which nothing sends any more; the typed, cookie and Google paths
 * all land here and in runGoogleSignIn, and registered nothing. The one ladder
 * that could catch it ran from `surface-open` BEFORE the user signed in, found
 * no token and gave up. Prod 2026-09-26 08:16:12Z / 08:22:43Z: panel sign-out
 * (page_unload + listener close 1005), sign-in 9 s later, and every encrypted
 * pair after it advertised `recipients=1` - the extension SW could not open a
 * sealed PHONE_NOTIFICATION. Registration success broadcasts e2e-status, and
 * shell.js pushes the key to the page on that edge, so the page's advert
 * carries the SW key from the next pairing on.
 */
function registerAfterSignIn(why) {
  registerDeviceKeyWithRetry(why).catch(() => {});
}

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
    registerAfterSignIn('sign-in-cookie');
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
    registerAfterSignIn('sign-in-google');
    connect();
    return true;
  } catch (e) {
    // User closed the window / cancelled. Not an error worth shouting about.
    return false;
  }
}

/**
 * Password path, WINDOWED (2026-09-15, forge/ext-login-autofill).
 *
 * WHY: Chrome's password manager never runs inside #cc-login-frame. Its
 * enablement and its UI both key off the WebContents' PRIMARY MAIN FRAME URL,
 * which for the toolbar popup / side panel is `chrome-extension://<id>/…` — a
 * scheme chrome_password_manager_client.cc explicitly excludes
 * (`scheme != extensions::kExtensionScheme` in CanShowBubbleOnURL;
 * IsFillingEnabled → IsPasswordManagementEnabledForCurrentPage on the
 * last-committed URL). ADDRESS autofill still fills the email field, which is
 * why the bug reads as "email is filled, the password dropdown never appears".
 * No form markup can change this, so the escape hatch is a real window whose
 * main frame is https://computercaller.com.
 *
 * The window is owned by THIS worker, never by the popup document: a toolbar
 * popup is destroyed the moment it loses focus, and an `await` spanning the
 * window would never resume. Same rule, same reason, as runGoogleSignIn().
 *
 * We do not need the page to talk back. The login POST sets the auth_token
 * cookie in this profile, and the SW's mint is cookie-authed, so polling the
 * mint IS the completion signal — no externally_connectable, no new
 * permissions, and it works even if the user finishes in a tab we lost track
 * of. chrome.runtime.getPlatformInfo() on each tick is an extension-API call
 * purely to reset the worker's 30s idle timer; a bare setInterval does not.
 */
const PW_WINDOW_POLL_MS = 2500;
const PW_WINDOW_MAX_POLLS = 120; // 5 minutes, then we stop nagging the server.

async function runPasswordSignIn() {
  let win = null;
  try {
    win = await chrome.windows.create({
      url: self.CC.LOGIN_WINDOW_URL,
      type: 'popup',
      width: 460,
      height: 700,
      focused: true,
    });
  } catch (e) {
    console.warn('[CC-SW] password window failed to open', e);
    return false;
  }
  const winId = win && win.id;
  if (typeof winId !== 'number') return false;

  return new Promise((resolve) => {
    let settled = false;
    let polls = 0;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { chrome.windows.onRemoved.removeListener(onRemoved); } catch (_) {}
      resolve(ok);
    };

    // The user closed the window themselves. They may well have signed in
    // first (Chrome closes nothing on submit), so mint once more before
    // calling it a cancel.
    const onRemoved = (id) => {
      if (id !== winId) return;
      mintTokenFromCookie().then(finish, () => finish(false));
    };
    chrome.windows.onRemoved.addListener(onRemoved);

    const timer = setInterval(async () => {
      if (settled) return;
      try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
      if ((polls += 1) > PW_WINDOW_MAX_POLLS) { finish(false); return; }
      let ok = false;
      try { ok = await mintTokenFromCookie(); } catch (_) { ok = false; }
      if (!ok) return;
      finish(true);
      // Signed in — take the window away. The surface that asked for it swaps
      // itself; a toolbar popup that died on blur picks the session up on its
      // next open.
      try { await chrome.windows.remove(winId); } catch (_) {}
    }, PW_WINDOW_POLL_MS);
  });
}

// ── Account Encrypted-mode write (T-E2E-ACCOUNT-PREF step 3) ────────────────
/**
 * PUT /api/prefs/e2e {value} or POST /api/prefs/e2e/seed {value:'on'} with the
 * ext-session token in the Authorization header ONLY — `credentials:'omit'` so
 * no cookie rides along and the server's `ext-token` arm (lib/deviceKeyAuth.ts)
 * is what authenticates it, recording `updatedBy: ext`. Returns the HTTP status
 * and JSON body verbatim for the frame to classify; never throws. No token =
 * 401 without a request.
 */
async function writeE2ePref(op, value) {
  const isSeed = op === 'seed';
  if (!(op === 'put' || isSeed) || !(value === 'on' || value === 'off') || (isSeed && value !== 'on')) {
    return { status: 400, body: null };
  }
  const token = await getToken();
  if (!token) return { status: 401, body: null };
  try {
    const res = await fetch(isSeed ? self.CC.E2E_PREF_SEED_URL : self.CC.E2E_PREF_URL, {
      method: isSeed ? 'POST' : 'PUT',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    trace('e2e-pref-write', { op, status: res.status });
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
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
    // P5a-SW (a): a 401/409 from the token endpoint is one of the only two
    // authoritative revocations. Recording it is what lets the keepalive path
    // treat every OTHER null as "unknown yet" without ever getting stuck
    // showing signed-in for a session the server has already refused.
    markTokenRevoked();
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
    if (!token) {
      // P5a-SW (a). This is the keepalive path: the `cc-keepalive` alarm calls
      // connect() every 30 s, so this branch runs constantly and used to
      // repaint 'signed-out' on EVERY transient null — over a live session.
      connecting = false;
      if (tokenAbsenceVerdict(authFacts()) === 'clear') {
        signedIn = false;
        refreshIndicator();       // genuinely signed out — idle, no retry
      } else {
        scheduleReconnect();      // unknown yet — keep the paint, come back
      }
      return;
    }
    signedIn = true;
    const ticket = await mintTicket(token);
    if (!ticket) { connecting = false; return; }          // token dropped

    // P3 (a). `?deviceId=` is what makes the relay hand THIS listener its own
    // key wrap: derivePairState() splices `e2e` into PAIR_STATE only
    // `if (block && forWs && forWs.deviceId)`. Without it the socket is
    // byte-for-byte the pre-P3 listener and gets no wrap at all — which is a
    // legal state (d), not an error, and is exactly what happens if the key
    // failed to load. Appended ONLY when we have one, so the URL of a
    // keyless worker is unchanged rather than carrying `deviceId=null`.
    await refreshDeviceKey();
    const url = `${self.CC.RELAY_BASE}?ticket=${encodeURIComponent(ticket)}&role=listener`
      + (swDeviceId ? `&deviceId=${encodeURIComponent(swDeviceId)}` : '');
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      openedAt = Date.now();
      connecting = false;
      wsOpen = true;
      trace('ws-open', { attempts: reconnectAttempts });
      // Pairing facts stay false until the relay tells us otherwise — the
      // PAIR_STATE frame the relay sends on listener join arrives within a
      // round-trip. We do NOT optimistically assume a phone or a pair: a relay
      // socket with no phone behind it is precisely the state a green dot must
      // not claim, and a socket that just reopened knows nothing about the room
      // it left. clearRelayFacts() then re-set wsOpen, in that order, because
      // the clear is about the ROOM and the socket genuinely is open.
      clearRelayFacts();
      wsOpen = true;
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
      if (wasCurrent) { clearRelayFacts(); refreshIndicator(); }
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
      // FORGE-M (2026-09-16). An ABNORMAL close (1006 — no close frame; 1001 —
      // going away) is the worker or the network dying under us, not the relay
      // refusing us. Those are exactly the closes where a long backoff is pure
      // cost: nobody is watching the listener reconnect, and while it is away
      // the relay's panel hold has no liveness signal and burns its grace.
      //
      // We deliberately do NOT reset reconnectAttempts here — a socket that
      // dies immediately on open must keep escalating, or a relay that is down
      // gets hammered (the storm the MIN_OPEN_DWELL_MS rule above exists to
      // prevent). We only CAP the delay, so escalation still happens but the
      // listener is never parked for the full 30 s ceiling on a link blip.
      const abnormal = !!ev && (ev.code === 1006 || ev.code === 1001);
      openedAt = 0;
      scheduleReconnect(abnormal ? ABNORMAL_CLOSE_BACKOFF_CAP_MS : MAX_BACKOFF_MS);
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  } catch (e) {
    console.warn('[CC-SW] connect error', e);
    connecting = false;
    clearRelayFacts();
    refreshIndicator();
    scheduleReconnect();
  }
}

function scheduleReconnect(ceilingMs = MAX_BACKOFF_MS) {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), ceilingMs);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const token = await getToken();
    // P5a-SW (a): "still signed in" is no longer "a token is present right
    // now". A null we are not entitled to call a sign-out must come back — the
    // scheduled retry IS the retry half of the keep verdict, and dropping it
    // here would park the listener forever on one unlucky read.
    if (token || tokenAbsenceVerdict(authFacts()) === 'keep') connect();
  }, delay);
}

// ── Frame → notification mapping ─────────────────────────────────────────────
// ── E2E session state (P3 (b)/(c)/(d)) ──────────────────────────────────────
/**
 * SK NEVER LEAVES THIS VARIABLE. It is module scope, which under MV3 means it
 * dies with the worker — and that is the intended lifetime. What survives an
 * eviction is the WRAP in chrome.storage.session, from which `ensureSession()`
 * re-derives SK on the next boot without waiting for a fresh PAIR_STATE. A
 * worker that had to wait would miss exactly the notifications it exists for.
 */
let e2eSession = null;
let e2eKid = null;
let e2ePairEpoch = null;
/** 'off' | 'counts-only' | 'open' | 'aborted' — what the UI/tests can observe. */
let e2eMode = 'off';
/** Why we are in counts-only, for the trace. Never shown to the user (m-G). */
let e2eWhy = null;
/** The kid whose wrap failed to open (A4-M3). Only a DIFFERENT kid clears it. */
let e2eAbortedKid = null;

function setCountsOnly(why) {
  e2eSession = null;
  e2eMode = 'counts-only';
  e2eWhy = why;
  trace('e2e-counts-only', { why: String(why).slice(0, 60) });
}

/**
 * A4-M3 — a wrap that fails to open is a PAIRING ABORT, never a degrade.
 *
 * §13.2 row 2 grants counts-only badges to a recipient that never had a key.
 * It does NOT cover one whose wrap failed to open: that is a tampered or
 * mismatched pairing, and the two must not share an outcome. Counts-only says
 * "I cannot read this one, carry on"; an abort says "this pairing is wrong",
 * and the difference is the whole content of A4-M3.
 *
 * STICKY, and that is the point. The cached wrap is dropped, so an ensureSession
 * that simply re-ran would find no wrap and land in counts-only('no-wrap') —
 * silently converting the abort into exactly the degrade A4-M3 forbids, one
 * frame later. It is pinned to the kid that failed; a block bearing a DIFFERENT
 * kid is a new pairing (a rekey always mints a fresh kid, A2 MUST 1) and clears
 * it, so a re-pair recovers with no user action and a replay of the same broken
 * block recovers nothing.
 *
 * A4-M5: the trace names the canonical peer we derived from and our own
 * deviceId — ids only, never key material and never `ctx` in full. Without it
 * the multi-recipient failure mode is a tag error with no attribution.
 */
function setAborted(why, { kid, canonicalPeer } = {}) {
  e2eSession = null;
  e2eKid = null;
  e2ePairEpoch = null;
  e2eMode = 'aborted';
  e2eWhy = why;
  e2eAbortedKid = kid || null;
  dropSessionState().catch(() => {});
  trace('e2e-abort', {
    why: String(why).slice(0, 60),
    kid: kid || null,
    canonicalPeer: canonicalPeer || null,   // A4-M5 — ids only
    ownDeviceId: swDeviceId || null,
  });
}

function clearAborted() {
  if (e2eMode !== 'aborted') return;
  e2eMode = 'off';
  e2eWhy = null;
  e2eAbortedKid = null;
}

/**
 * Re-derive SK from the cached wrap, or explain why we cannot.
 *
 * NEVER THROWS. Every failure path lands in counts-only, because the honest
 * behaviour when we cannot read a body is to say "New message on your phone"
 * and increment the badge — not to show an error, and above all not to fall
 * back to a plaintext preview (m-G). Fail toward the cheaper mistake.
 */
async function ensureSession(kid) {
  if (e2eSession && (!kid || kid === e2eKid)) return e2eSession;
  // A4-M3, the sticky half. Re-deriving the SAME aborted kid would walk
  // straight back into counts-only via the no-wrap branch below.
  if (e2eMode === 'aborted' && (!kid || kid === e2eAbortedKid)) return null;
  const cached = await readCachedWrap(kid);
  if (!cached) { setCountsOnly('no-wrap'); return null; }
  let rec;
  let ctxInputs;
  try {
    rec = await loadOrCreateDeviceKey();
    // ONE function, and today it always refuses — see the OPEN SPEC GAP note in
    // sw-session.js. When the ruling lands, this line starts returning values
    // and everything below it already works.
    const userId = await localUserId();
    // `ownDeviceId` is NOT passed: A4 deleted the peerDeviceId==own refusal and
    // `pairContextInputs` now REJECTS the option rather than ignoring it, so a
    // call site cannot keep believing a membership check runs at ingest. The
    // SW's membership proof is the unwrap below — clause (b).
    ctxInputs = await pairContextInputs({ block: cached, userId });
  } catch (e) {
    // ── BRANCH 1: ctx refused. UNCHANGED. ────────────────────────────────────
    // A CtxRefused is a DECISION, not a malfunction: a stale epoch (A3-M2), a
    // foreign pairingId (A3-M3(a) / A4.1), a mode=1 block with no ctx (A3-M4).
    // All of them land in counts-only with the reason recorded for the trace
    // and never shown to the user (m-G).
    setCountsOnly(e instanceof CtxRefused ? `ctx:${e.why}` : (e && e.message) || 'ctx-failed');
    return null;
  }

  // ── BRANCH 2: the unwrap. A FAILURE HERE IS AN ABORT, NEVER COUNTS-ONLY. ──
  // A4-M3, and the reason this catch is split out of the one above at all. The
  // single catch that used to wrap ctx AND unwrap routed every failure to
  // setCountsOnly, which is correct for a refusal and WRONG for a wrap that did
  // not open: clause (b) makes the opening wrap the cryptographic proof of
  // membership, so its failure means this device is not the recipient the phone
  // addressed, or the block was tampered with. Degrading that to a badge would
  // present a broken pairing as a working one that happens to be quiet.
  let sk;
  try {
    sk = await unwrapSessionKey({
      block: cached,
      privateKey: rec.priv,
      ownPub: rec.pub,
      ownDeviceId: rec.deviceId,     // genuinely used here — it keys the wrap PREFIX
      ctxInputs,
    });
  } catch (e) {
    setAborted(`unwrap:${(e && e.message) || 'failed'}`, {
      kid: cached.kid,
      canonicalPeer: ctxInputs.peerDeviceId,    // A4-M5 attribution
    });
    return null;
  }

  // ── BRANCH 3: local session construction. Counts-only, unchanged. ────────
  try {
    e2eSession = await buildSession({ pairingId: ctxInputs.pairingId, sessionKey: sk, ctxInputs });
    sk.fill(0);                       // §2.1 control 4 — drop the raw bytes
    e2eKid = cached.kid;
    e2ePairEpoch = ctxInputs.pairEpoch;
    e2eMode = 'open';
    e2eWhy = null;
    e2eAbortedKid = null;
    trace('e2e-open', { kid: e2eKid });
    return e2eSession;
  } catch (e) {
    try { sk.fill(0); } catch { /* best effort */ }
    setCountsOnly((e && e.message) || 'session-build-failed');
    return null;
  }
}

/**
 * m-G, deliverable (d). The body shown when we hold no key, or hold the wrong
 * one, or the frame does not authenticate.
 *
 * ONE constant, used by every sealed frame type, so no call site can invent a
 * chattier version that leaks what it just failed to read. "New message on your
 * phone" says a thing happened and says nothing about what.
 */
const COUNTS_ONLY_TITLE = 'ComputerCaller';
const COUNTS_ONLY_BODY = 'New message on your phone';

/**
 * Turn a sealed payload into a readable one, or into `null` for counts-only.
 *
 * `null` is NOT an error — it is the specified outcome of (d) and the caller
 * renders the generic body. A throw here would become an error toast, which
 * m-G forbids.
 */
async function openIfSealed(type, data) {
  if (!isSealedEnvelope(data)) return data;        // plaintext frame — unchanged
  const session = await ensureSession(data.kid);
  if (!session) return null;                        // counts-only
  if (data.kid !== e2eKid) { await noteDrop('wrong-kid'); return null; }
  // CAPTURED ONCE. `e2ePairEpoch` is module state and there are two awaits
  // below it; a rekey that lands mid-open would otherwise have admitSeq() and
  // markAuthenticated() reasoning about DIFFERENT epochs, and the mark for a
  // frame decrypted under the old key would be written into the new window --
  // re-arming a bound that a reset had just disarmed (M-A5-2 vector H).
  // markAuthenticated() also guards on this value, so a stale mark is a no-op.
  const epoch = e2ePairEpoch;
  // §13.5 anti-replay BEFORE the open, so a replayed frame costs no crypto.
  // A duplicate is dropped silently: frameBuffer legitimately re-sends on
  // resume, and treating that as an attack turns every reconnect into a failure.
  let admit;
  try {
    admit = await admitSeq({
      kid: data.kid, direction: 0x01, seq: data.s, pairEpoch: epoch,
    });
  } catch (e) {
    // RESUME-PROTOCOL rule 6 / M-A5-2: a stored dedupe record of an unknown
    // version has no forward-jump bound, so admitting against it would silently
    // reopen F2. Fail CLOSED and loudly; the next Accept rebuilds the record.
    console.warn('[CC-SW] dedupe record unusable — dropping frame:', String((e && e.message) || e));
    trace('e2e-dedupe-record-version', { why: String((e && e.message) || e).slice(0, 120) });
    await noteDrop('dedupe-record-version');
    return undefined;
  }
  if (!admit.ok) {
    // A forward-jump is NOT counted here. admitSeq() bumps
    // refusedForwardJump at the refusal site itself (so the count cannot be
    // lost if a caller forgets), and M-A5-2 requires that counter to be
    // distinct from droppedTotal — adding a noteDrop() here would both
    // inflate `total` and count the same refusal twice.
    if (admit.why !== 'forward-jump') await noteDrop(admit.why);
    return undefined;                                              // drop entirely
  }
  try {
    const opened = await openSealedFrame({
      session, frameType: type, envelope: data, pairEpoch: epoch,
    });
    // M-A5-2 `armRule`: the forward-jump mark is raised HERE, after the AEAD
    // tag verified, and nowhere else. admitSeq() above knows only that the
    // frame was well SHAPED; if it raised the mark, a forged envelope at a
    // huge seq would set the high-water mark itself and the bound would then
    // admit everything below it.
    await markAuthenticated({
      kid: data.kid, direction: 0x01, seq: data.s, pairEpoch: epoch,
    });
    return opened;
  } catch {
    // Tag failure. §13.5: drop the frame, NEVER close the socket. The user
    // still gets a badge and a generic body — silence would be worse.
    await noteDrop('open-failed');
    return null;
  }
}

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
 * KNOWN GAP — CLOSED PROPERLY 2026-09-16 (FORGE-O). server.js used to skip the
 * PHONE_PRESENT broadcast when a phone rejoined through tryAutoResume(), so a
 * resumed phone raised no presence frame; the catch-all below papered over it by
 * treating ANY data frame as proof of a phone. The relay now emits PAIR_STATE on
 * that path (and every other transition), so presence is reported rather than
 * guessed, and the catch-all has been demoted accordingly.
 */
function notePhonePresence(present) {
  if (phonePresent === present) return;
  phonePresent = present;
  refreshIndicator();
}

/**
 * Authoritative pairing truth from the relay (FORGE-O). One frame carries all
 * three facts so they can never disagree with each other — deriving `paired`
 * from a sequence of independent presence frames is what produced a green dot
 * over an unpaired phone in the first place.
 *
 * Absent fields are read as FALSE, not as "unchanged". A malformed or truncated
 * PAIR_STATE must fail toward grey: claiming a connection that is not there
 * costs the user a call they think they placed, whereas a spurious grey costs
 * one glance at the panel. Fail toward the cheaper mistake.
 */
function notePairState(data) {
  // P3 (b)/(d). The e2e block is handled BEFORE the early-return below: that
  // return fires when the three presence booleans are unchanged, which is
  // exactly what a RESUME looks like — same pair, same booleans, and the relay
  // re-sending the SAME e2e block (§13.8: resume/hold/dock reuse SK). Handling
  // the key material after the return would drop the wrap on every resume, and
  // the worker would silently fall to counts-only the moment a panel closed.
  noteE2eBlock(data && data.e2e);

  const nextPresent = data?.phonePresent === true;
  const nextPaired = data?.paired === true;
  const nextHeld = data?.held === true;
  if (phonePresent === nextPresent && paired === nextPaired && held === nextHeld) return;
  phonePresent = nextPresent;
  paired = nextPaired;
  held = nextHeld;
  trace('pair-state', { phonePresent, paired, held });
  refreshIndicator();
}

/**
 * The `e2e` slice of a PAIR_STATE, or its ABSENCE.
 *
 * ABSENCE IS A FIRST-CLASS, EXPECTED STATE (m-G / deliverable (d)), not a
 * failure. The relay omits the block entirely — never null, never partial —
 * whenever the room is plaintext, the phone is on a build without encrypted
 * mode, or this listener declared no deviceId. Every one of those is a normal
 * configuration, and the ONLY correct response is counts-only. The extension
 * and the phone app update through different stores on different review
 * clocks, so "the other end is older than me" is the common case, not the edge
 * case, and it must never look like an error to the user.
 */
function noteE2eBlock(block) {
  if (!block || typeof block !== 'object' || typeof block.wrap !== 'string') {
    setCountsOnly('no-e2e-block');
    return;
  }
  // A4-M3's release valve. An abort is pinned to the kid whose wrap failed to
  // open; a block bearing a DIFFERENT kid is a new pairing (a rekey always
  // mints a fresh kid, A2 MUST 1), so it clears the abort and the derivation
  // below is allowed to run. The SAME kid arriving again — a resume, or a
  // replay of the broken block — changes nothing and stays aborted.
  if (e2eMode === 'aborted' && block.kid !== e2eAbortedKid) clearAborted();

  // Cache first, derive second. The cache is what survives an eviction, so it
  // must be written even if the derivation then fails — otherwise a worker
  // evicted between PAIR_STATE and the first notification comes back with
  // nothing at all, which is the exact window (f) exists to prove.
  cacheWrap(block)
    .then(() => ensureSession(block.kid))
    .catch((e) => setCountsOnly((e && e.message) || 'cache-failed'));
}

/**
 * Is this SMS_RECEIVED payload an OUTGOING message? (Addendum B, 2026-09-15.)
 *
 * The APK sends the row FLAT — {id, from, body, time, type:'sent'|'inbox'} —
 * which is the shape that matters in production. We also read `message.type`
 * and a `direction` field because the web layer's normalizePayload wraps the
 * row under `message`, and older/other producers have used `direction`; a
 * badge suppressor that only knows ONE of the three spellings is a
 * suppressor that silently stops working the next time a producer changes.
 *
 * DEFAULT IS INCOMING. An unrecognised or absent marker must count: missing a
 * real incoming text is a product failure, whereas one stray badge count for
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
  // FORGE-O: authoritative. Handled first so it wins over any weaker inference.
  if (type === 'PAIR_STATE') { notePairState(data); return; }
  if (type === 'LOBBY_STATUS') {
    // FORGE-O: presence ONLY. This frame says nothing about pairing —
    // `alreadyActive` means "some pair exists in this room", which for a
    // passive listener is not the same as "the pair is live and usable", and
    // OR-ing the two into one green boolean is the original defect. PAIR_STATE
    // follows this frame on every listener join, so `paired`/`held` are set by
    // the frame that actually knows them.
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
  // FORGE-O: a reset tears the pair down too, not just presence.
  // §13.8: a reset drops SK on both sides. notePairState({}) already routes
  // through noteE2eBlock(undefined) → counts-only, but the CACHED wrap has to
  // go too: a wrap that outlived its room would let a respawned worker
  // re-derive a key for a pairing that no longer exists.
  if (type === 'ROOM_RESET') {
    // §13.8: a reset drops SK on both sides — and with it A4.1's pairingId pin
    // and any abort, which are both scoped to the pairing that just ended.
    dropSessionState().catch(() => {});
    clearOwnPairingId().catch(() => {});
    clearAborted();
    // BAT-A1 MUST-3: unpair clears it too. The reading belongs to a pairing
    // that no longer exists; BAT-3's "last seen" is for a phone that went
    // OFFLINE, not for one that was unpaired.
    clearBattery();
    notePairState({});
    return;
  }
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
  // P3 (c). THE DOWNGRADE GUARD. Placed HERE — above the sealed branch, above
  // deliverFrame, above every counter — because
  // "unseal before anything sees the bytes" is worth nothing if a frame that
  // was never sealed walks past the check.
  //
  // While the session is OPEN, a §13.7 sealed-list frame arriving WITHOUT an
  // envelope is a strip: a relay that removes `{e,kid,s,c}` and forwards the
  // body in the clear gets it rendered exactly as a sealed one would be, with
  // nothing thrown and nothing dropped. It is dropped and COUNTED instead
  // (cc_e2e_drops, reason `plaintext-while-on`).
  //
  // Dropped ENTIRELY, not downgraded to the generic counts-only body: a badge
  // increment still confirms to whoever stripped the envelope that the strip
  // reached us, and counts-only exists for frames we cannot read, not for
  // frames that should never have arrived in this shape.
  //
  // Scoped to `e2eMode === 'open'`. In 'off' and 'counts-only' the pair has no
  // session and plaintext is simply how this product works today — dropping
  // there would break every un-paired user. GET_MESSAGES / GET_CALL_LOGS /
  // GET_CONTACTS are exempt inside requiresSeal() by §13.7's mandate.
  // The DECISION is inboundDisposition() in sw-session.js, not a condition
  // written out here: inline, the only way to test this rule is to drive a whole
  // service worker in a browser, and a rule that can only be checked by the
  // slowest harness in the programme is one that stops being checked.
  const disposition = inboundDisposition({ mode: e2eMode, frameType: type, data });
  if (disposition === INBOUND_DROP_PLAINTEXT) {
    noteDrop('plaintext-while-on').catch(() => {});
    trace('e2e-drop-plaintext', { type });
    return;
  }
  // P3.1 / FT-A1.1 M7, receiver half. A `relay` mark on a shape the relay
  // cannot have produced — a sealed frame, a non-FILE_FAILED type, a peer-owned
  // reason, or `relay` set to anything but true. Counted separately from the
  // plain downgrade because the two say different things: one is a stripper,
  // this one is a forged or forwarded provenance mark, and a spike in either
  // should be legible on its own.
  if (disposition === INBOUND_DROP_RELAY_MARK) {
    noteDrop('bad-relay-mark').catch(() => {});
    trace('ft-drop-relay-mark', { type });
    return;
  }
  // BAT-A1 MUST-3. A BATTERY frame whose three fields are not the frozen shape.
  // Counted separately from the two above because it says a third thing: not a
  // stripper and not a forged provenance mark, but a producer — a phone build,
  // or something impersonating one — emitting a shape nobody agreed to. It is
  // dropped BEFORE notePhonePresence: a frame we refuse on shape is not
  // evidence of anything, including that a phone sent it.
  if (disposition === INBOUND_DROP_BATTERY_SHAPE) {
    noteDrop('battery-shape').catch(() => {});
    trace('battery-drop-shape', { type });
    return;
  }
  // P3.1 / FT-A1 MUST B-1. Routed, NOT opened — above notePhonePresence and
  // above deliverFrame, because nothing in this worker may see a file frame's
  // contents and the surest way to guarantee that is for the frame never to
  // reach the code that reads bodies.
  if (disposition === INBOUND_ROUTE_SEALED) {
    notePhonePresence(true);          // a phone frame is still a phone frame
    routeSealedFileFrame(type, data);
    return;
  }
  // FT-A1.1 M9. Plaintext, relay-MINTED, relay-owned reason: forwarded to the
  // page, which applies the liveness clause this worker deliberately does not
  // track. Abort-only semantics are the page's; nothing here may act on it.
  if (disposition === INBOUND_DELIVER_RELAY_ABORT) {
    notePhonePresence(true);
    forwardFileFrameToPage(type, data);
    // The transfer named in the abort is over, so a marker for it is stale.
    if (pendingSealedOffer && pendingSealedOffer.id === data.id) clearPendingOffer();
    return;
  }

  // Catch-all, DEMOTED (FORGE-O). A phone→browser data frame proves a phone is
  // on the other end, so it still repairs `phonePresent` if a presence frame was
  // ever missed. It must NOT be read as proof of a PAIR: broadcastToListeners()
  // fans phone frames to listeners "regardless of active-pair state" (server.js,
  // its own doc comment) precisely so badge counts survive a closed panel and a
  // resume gap — so an SMS arriving during a HELD pair, or from a lobby phone, is
  // routine and is not evidence the pair is live. Inferring `paired` here would
  // re-introduce the exact lie this dispatch removes, at the worst moment: the
  // held window, where the user is most likely to try to act on the dot.
  // `paired`/`held` change ONLY via PAIR_STATE.
  if (type !== 'PING' && type !== 'PONG') notePhonePresence(true);

  // P3 (c)/(d). A sealed body has to be opened before the switch below can read
  // anything out of it, and opening is async. The detour is taken ONLY for a
  // frame that actually carries an envelope, so every plaintext frame — which
  // today is all of them — runs the identical synchronous path it ran before.
  if (disposition === INBOUND_UNSEAL) {
    openIfSealed(type, data)
      .then((opened) => {
        // undefined = dropped by anti-replay; it raised no badge and must raise
        // no notification. null = we could not open it: deliverFrame renders
        // the generic body (m-G). An object = the real payload.
        if (opened === undefined) return;
        deliverFrame(type, opened);
      })
      .catch((e) => console.warn('[CC-SW] sealed frame handling failed', e));
    return;
  }
  deliverFrame(type, data);
}

/**
 * Render one phone→browser data frame.
 *
 * `data === null` means "this frame was sealed and we could not open it". That
 * is a NORMAL state (m-G / deliverable (d)), not an error: the badge still
 * counts. It must never become an error — a user whose extension is a version
 * behind their phone should see a count, not a crash report. (No OS toast is
 * raised for any frame since 2026-09-25.)
 */
function deliverFrame(type, data) {
  /** True when the body is unreadable and every field below must be generic. */
  const sealed = data === null;
  if (sealed) data = {};

  switch (type) {
    case 'CALL_INCOMING':
    case 'CALL_WAITING': {
      // Badge only. No OS notification (removed 2026-09-25).
      bumpUnread('missedCalls');
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
      // The direction check has to come BEFORE bumpUnread: the badge is a count of things needing attention
      // and your own outbox needs none. Suppressing only the popup would leave
      // the badge lying, which is the same bug wearing a different hat.
      // (The OS toast itself was removed entirely on 2026-09-25; the badge rule
      // above is what remains.)
      // A sealed row's direction marker is inside the ciphertext, so an
      // unopenable one cannot be classified. DEFAULT IS INCOMING, exactly as
      // isOutgoingSms() already defaults for an absent marker: missing a real
      // incoming text is a product failure; one stray count for an
      // outgoing one is one stray badge count. Fail toward the cheaper mistake.
      if (!sealed && isOutgoingSms(data)) return;
      bumpUnread('newSms');
      return;
    }
    case 'PHONE_NOTIFICATION': {
      // v58 BACKFILL. On sync the phone replays everything currently in its
      // shade under this same frame type, tagged `backfill:true` with the
      // original `postedAt`. That is history the user has already seen on the
      // phone, so it reaches the Alerts list (the page merges it chronologically)
      // and NOTHING else here: no badge bump, no sound. A bump per
      // card for a shade of twenty would be a badge storm on every sync.
      //
      // Only an explicit `true` takes this path. Unknown or absent — every APK
      // before v58 — falls through to today's live behaviour unchanged.
      if (data && data.backfill === true) return;
      bumpAlert(notifKeyOf(data));
      return;
    }
    case 'NOTIFICATION_REMOVED': {
      // The user swiped it away on the phone (or the source app cancelled it).
      // The page already drops the row (usePhoneBridge's NOTIFICATION_REMOVED
      // case) — but only when a surface is OPEN, and the badge exists precisely
      // for when none is. Without this, clearing your phone left the pinned
      // icon showing a count of alerts that no longer exist anywhere.
      dropAlert(notifKeyOf(data));
      return;
    }
    // FT-3a. Not a notification — a routing marker only. FILE_CHUNK never
    // reaches here: it is not in FILE_ROUTED_TYPES and routeFileFrame refuses
    // it outright, so no file bytes pass through this worker.
    case 'FILE_OFFER':
    case 'FILE_DONE':
    case 'FILE_FAILED':
      routeFileFrame(type, data, sealed);
      return;
    // BAT-2 (b). Persisted and pushed to any open surface — and NOTHING else.
    // No badge bump, no notification, no sound: a battery reading is ambient
    // status, and a toast for it would be the notification storm this file has
    // spent three dispatches removing. It is also the reason the case sits
    // here rather than beside the counters: `deliverFrame` is where a frame
    // chooses its side effects, and BATTERY's are exactly one write.
    //
    // A sealed BATTERY never reaches this line — inboundDisposition refuses it
    // on shape (§13.7 says the type is plaintext) — so `sealed` is always
    // false here and `data` always holds the validated three fields.
    case 'BATTERY':
      noteBattery(data);
      return;
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
    // Optional deep-link hash (#tab=…). popout.html hands it to the app
    // iframe's URL so the surface opens on that tab.
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

// ── Presence: popup / pop-out connect a port (badge clears, file-offer replay) ──
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
  // BAT-2 (b), same reason as the counts: the whole point of persisting the
  // reading is that a surface opening at 09:40 renders the level the phone
  // pushed at 09:31. Waiting for the next frame would blank the header for up
  // to ten minutes. `null` is a legitimate answer (nothing received yet) and
  // BAT-3 renders nothing for it — never a "--%" placeholder.
  readBattery().then((battery) => {
    // `catch {}` rather than this file's older `catch (_) {}` so this addition
    // does not raise the no-unused-vars warning count.
    try { port.postMessage({ type: 'battery', battery }); } catch { /* port closed */ }
  });
  // P3.1 / MUST B-2: the rescue this whole marker exists for. A sealed offer
  // held while no page was open is replayed VERBATIM to the first page that
  // attaches inside the 60 s TTL; the page unseals it and prompts. Outside the
  // TTL there is nothing to replay — `pendingOfferIfLive` has already expired
  // it and told the page so.
  replayPendingOfferTo(port);
  // INC-0923 B-2 (c). Same reason as the counts and the battery: a panel that
  // opens into an unregistered state must render it on its first paint, not on
  // whatever later event happens to trigger a broadcast. Opening a surface is
  // also one of the retry triggers, so the ladder starts here too.
  try { port.postMessage(e2eStatusMessage()); } catch { /* port closed */ }
  registerDeviceKeyWithRetry('surface-open').catch(() => {});
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
    // Registration needs a session, so a fresh sign-in is the moment to try.
    registerDeviceKeyWithRetry('auth-updated').catch(() => {});
    connect();
    sendResponse?.({ ok: true });
  } else if (message?.type === 'dock') {
    // Fallback only — shell.js opens the panel itself, because the user gesture
    // does not survive the hop into this worker. See dockSurface().
    dockSurface(sender).then((r) => sendResponse?.(r));
  } else if (message?.type === 'dock-close') {
    // shell.js already docked. Just take the pop-out window away.
    closeSenderWindow(sender).then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'e2e-pubkey-get') {
    // shell.js asks for the identity it is about to publish to the app frame
    // over the pinned bridge. The NULL arm is deliberate and load-bearing: a
    // worker with no key answers `{deviceId:null, pub:null}` rather than
    // failing, so the page can tell "the SW has no key" (pair without an
    // extension recipient — m-G counts-only) from "the message never arrived"
    // (wait). See the bridge contract in CHECKPOINTS.
    //
    // A4.1 (R-T), the hand-over. A `pairingId` on the REQUEST is the page
    // telling the worker which pairing it is party to — the only channel that
    // does not run through the relay, and the authoritative one, because the
    // page initiated the pairing. It is pinned as source 'bridge', which
    // outranks any TOFU pin. The reply carries the value the worker now holds,
    // null included, so the page can see the hand-over landed.
    // SECURITY A5 / M-A5-3 (F3): refreshDeviceKey(), NOT primeDeviceKey(). This
    // is the fix, and it is one word long.
    //
    // B9 is amended to "no SW SAS module -- the SW is a recipient, not a
    // verifier", and the whole of what makes that safe is that the PAGE feeds
    // the SW's key into the SAS transcript, so swapping the SW key moves the
    // digits (sas-vectors v3-3key-mode-on 50690 vs v4-3key-sw-swapped 44820).
    // That holds only if the key on THIS reply is the key the worker actually
    // holds right now. primeDeviceKey() memoises into `deviceKeyPrimed` for the
    // life of the worker, so a key rotated under us -- an IndexedDB wipe, a
    // regenerated record -- would keep answering the OLD key here until
    // something else happened to call connect(). The user would then compare a
    // code covering a key nobody holds, and the swap A5 wants visible becomes
    // invisible by the back door.
    //
    // Cost: one IndexedDB read on a path that already awaits. refreshDeviceKey()
    // also routes through primeDeviceKey()'s regeneration branch, so a rotation
    // first observed HERE still drops the stale wraps and says counts-only
    // (M-C) instead of merely reporting a new deviceId.
    refreshDeviceKey()
      .then(async () => {
        if (typeof message.pairingId === 'string' && message.pairingId) {
          await setOwnPairingId(message.pairingId);
        }
        const own = await readOwnPairingId();
        sendResponse?.({
          ok: true, v: 1, ...bridgeIdentityFields(),
          // M-A5-3's null arm, MACHINE-READABLE. `error` already carried the
          // IndexedDB exception text, but that is a diagnostic string and the
          // page must not branch on it. `reason` is null whenever `pub` is a
          // key and a short stable token otherwise, so the page can hold the
          // pairing (or badge the SW absent) WITHOUT claiming a 2-key SAS
          // covered a worker whose key it never learned. Every other field on
          // this reply is byte-identical to A4.1. INC-0923 moved `reason` (and
          // deviceId/pub/error with it) into bridgeIdentityFields() above so
          // the two arms of this reply cannot drift apart; it gained one token,
          // 'not-registered'.
          pairingId: (own && own.pairingId) || null,
          // A4.1-M1: WHERE that pairingId came from. 'bridge' is this
          // hand-over having landed; 'tofu' is the worker echoing a pin it
          // learned from a ctx, which is what the page must be able to tell
          // apart. Diagnostics only — see pinProvenance().
          pairingIdSource: pinProvenance(own).pairingIdSource,
        });
      })
      .catch(() => sendResponse?.({
        ok: true, v: 1, ...bridgeIdentityFields(),
        pairingId: null,
        pairingIdSource: 'none',
      }));
  } else if (message?.type === 'e2e-state-get') {
    // Observability for the harnesses (scripts/ext-badge-counter-proof.mjs,
    // scripts/ext-sw-lifetime-proof.mjs). §13.5 REQUIRES the drop counter to be
    // exported — "a silent dropper and a working receiver are otherwise
    // indistinguishable" — and (d)/(f) cannot be asserted from the outside
    // without knowing which mode the worker believes it is in. Read-only: it
    // reports state and changes none.
    Promise.all([readDrops(), readOwnPairingId()]).then(([drops, own]) => sendResponse?.({
      ok: true,
      mode: e2eMode,          // 'off' | 'counts-only' | 'open'
      why: e2eWhy,            // never rendered to a user (m-G); diagnostics only
      kid: e2eKid,
      deviceId: swDeviceId,
      hasKey: !!swPubKey,
      // INC-0923 B-1. `hasKey` and `registered` are different facts and the
      // gap between them is the whole incident: a worker that HAS a key the
      // registry does not know must not advertise it. Exported so a harness can
      // assert the withholding directly instead of inferring it from a recips
      // count — the same reason §13.5 requires the drop counter.
      registered: swRegistered,
      registerError: deviceKeyRegisterError,
      bootId: BOOT_ID,        // changes iff the worker died and respawned
      drops,
      // A4.1-M1. Read-only, beside mode/why/kid and under the same m-G rule.
      // `pairingIdEpoch` is what lets P6(b) assert the epoch-reset re-pin
      // directly instead of inferring it from a pairingId that changed.
      ...pinProvenance(own),
    }));
  } else if (message?.type === 'e2e-pref-write') {
    // T-E2E-ACCOUNT-PREF step 3, relayed by shell.js from the app frame. Only
    // our own extension pages may ask: a message from anywhere else (another
    // extension via an external channel) is refused without a request.
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse?.({ status: 403, body: null });
    } else {
      writeE2ePref(message.op, message.value).then((r) => sendResponse?.(r));
    }
  } else if (message?.type === 'unread-get') {
    readUnread().then((unread) => sendResponse?.({ ok: true, unread }));
  } else if (message?.type === 'tab-viewed') {
    clearUnread(message.tab).then((unread) => sendResponse?.({ ok: true, unread }));
  } else if (message?.type === 'sign-in-complete') {
    // Embedded (password) sign-in finished in the popup's login frame.
    // `return true` below keeps the channel open for this async reply.
    mintTokenFromCookie().then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'password-sign-in') {
    // Same shape as 'google-sign-in': the sender may be destroyed when the
    // window appears, sendResponse then goes nowhere, and the flow completes
    // here regardless. See runPasswordSignIn() for why a window is needed.
    runPasswordSignIn().then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'google-sign-in') {
    // The popup that sent this will very likely be destroyed when the auth
    // window opens; sendResponse then goes nowhere, which is harmless. The
    // flow itself completes here regardless.
    runGoogleSignIn().then((ok) => sendResponse?.({ ok }));
  } else if (message?.type === 'open-popout') {
    openPopout(typeof message.hash === 'string' ? message.hash : '');
    sendResponse?.({ ok: true });
  } else if (message?.type === 'signed-out') {
    // §13.8: sign-out drops SK. storage.session is cleared explicitly rather
    // than left to browser exit — a second user signing in on the same profile
    // must not inherit the first one's key material.
    dropSessionState().catch(() => {});
    // A4.1: the pairingId pin goes with it. It is NOT cleared on an abort —
    // there the pin is the one thing that was right — but a sign-out ends the
    // pairing, and a pin outliving it would refuse the next one.
    clearOwnPairingId().catch(() => {});
    // INC-0923 B-1: the registry row is scoped to the ACCOUNT that registered
    // it, so a sign-out ends this key's claim to be registered. The flag goes,
    // not the key — the key is this install's, the claim is the account's — so
    // a different user signing in on the same profile re-registers before the
    // key may be advertised, instead of inheriting a "verified" state granted
    // to somebody else.
    clearDeviceKeyRegistered().catch(() => {});
    swRegistered = false;
    deviceKeyRegisterError = 'signed-out';
    broadcastE2eStatus();
    clearAborted();
    // A3-M2: the epoch floor is cleared ONLY by an explicit user action, and
    // signing out is one. Nothing arriving on the wire may ever reach this.
    localUserId().then((uid) => clearEpochFloors(uid)).catch(() => {});
    cachedUserId = null;
    try { ws && ws.close(); } catch (_) {}
    // P5a-SW (a): the other authoritative revocation. Without this the
    // keepalive path would keep the pre-sign-out paint alive on its next null.
    markTokenRevoked();
    signedIn = false;
    clearRelayFacts();
    refreshIndicator();
    try { chrome.storage.session.set({ [UNREAD_KEY]: { ...UNREAD_ZERO }, [ALERT_KEYS]: [] }); } catch (_) {}
    // BAT-A1 MUST-3 / §13.8: the battery reading goes with the counters. It is
    // another user's device telemetry the moment a different account signs in
    // on this profile, and a stale "47%" under a new user's phone name is a
    // small lie told confidently.
    clearBattery();
    // Signing out clears the counts, so it must clear the number on the icon
    // too — a stale "3" on a signed-out extension is a lie about someone's
    // messages.
    paintBadge(UNREAD_ZERO);
    sendResponse?.({ ok: true });
  }
  return true;
});

// ── Worker-scope surface for the proof harnesses ────────────────────────────
/**
 * WHY THIS BLOCK EXISTS, AND WHY IT IS NOT TEST CODE IN PRODUCTION.
 *
 * Four harnesses — ext-badge-counter-proof, ext-indicator-proof,
 * ext-badge-sidepanel-proof and ext-sw-lifetime-proof — drive the SHIPPED
 * worker by reading and WRITING its top-level bindings through a CDP
 * `sw.evaluate()`. That is deliberate and it is the reason those proofs measure
 * the thing the user looks at rather than a reimplementation of it; each of
 * them says so in its own header ("background.js is a classic service worker,
 * so its top-level functions and `let`s are reachable from an evaluate() in
 * worker scope").
 *
 * P3 (a) made this worker an ES MODULE, because `importScripts` cannot load an
 * `.mjs` with named exports and the frozen key schedule is one. A module
 * worker's top-level declarations are MODULE-scoped, not global — so every one
 * of those evaluates would have broken. Worse than broken: a bare
 * `signedIn = true` inside an evaluate would have quietly created an unrelated
 * global and the harness would have gone on reporting PASS while measuring
 * nothing at all.
 *
 * So the surface the classic worker exposed BY ACCIDENT is republished here ON
 * PURPOSE, as accessors that proxy to the real bindings — reads see live
 * values and writes reach the module, which is exactly what the harnesses have
 * always relied on. Making it explicit is strictly better than the accident it
 * replaces: it is one list, a refactor that drops a name from it fails the
 * harness loudly, and a reader can see precisely what the proofs depend on.
 *
 * NOT A SECURITY SURFACE. A service worker's `self` is reachable only from the
 * worker itself and from a devtools/CDP session attached to it. No page, no
 * content script and no other extension can read it. This publishes no key
 * material: `e2eSession` and SK are deliberately absent from the list.
 */
for (const [name, get, set] of [
  ['ws', () => ws, (v) => { ws = v; }],
  ['wsOpen', () => wsOpen, (v) => { wsOpen = v; }],
  ['signedIn', () => signedIn, (v) => { signedIn = v; }],
  ['phonePresent', () => phonePresent, (v) => { phonePresent = v; }],
  ['paired', () => paired, (v) => { paired = v; }],
  ['held', () => held, (v) => { held = v; }],
  ['presenceCount', () => presenceCount, (v) => { presenceCount = v; }],
  // P3.1. The downgrade guard and the FILE_* passthrough are both scoped to
  // `open`/`aborted`, so a harness that cannot set the mode can only ever test
  // the branch where the rule does not apply — which is the branch that passes
  // by default. Published for the same reason as the rest of this list, and it
  // is not key material: `e2eSession`, SK and the wrap stay absent.
  ['e2eMode', () => e2eMode, (v) => { e2eMode = v; }],
  ['lastIndicator', () => lastIndicator, (v) => { lastIndicator = v; }],
  ['badgeChipColor', () => badgeChipColor, (v) => { badgeChipColor = v; }],
]) {
  Object.defineProperty(self, name, { get, set, configurable: true });
}
Object.assign(self, {
  applyIndicator,
  bumpUnread,
  clearUnread,
  composeIcon,
  connect,
  handleFrame,
  deliverFrame,
  routeFileFrame,
  pendingFileOfferForTest,
  notePhonePresence,
  notePairState,
  paintBadge,
  readUnread,
  // BAT-2 (b). Published for the same reason as the rest of this list: the
  // storage.session round trip is the thing under test and a harness cannot
  // reach it otherwise. Not key material and not a source of truth for a
  // surface — the surfaces read the port message and storage.onChanged.
  readBattery,
  noteBattery,
  clearBattery,
  refreshIndicator,
  repaintBadge,
  serialize,
  // P5a-SW (b): the badge proof's arm now VERIFIES the seeded token through
  // the worker's own auth path instead of asserting `signedIn = true` as a
  // fiction the worker is free to overwrite. authFacts is published so the
  // harness can read WHY a verdict came out the way it did when it fails.
  refreshAuthAndIndicator,
  authFacts,
  tokenAbsenceVerdict,
  GREEN,
  // P3 additions, so the new proofs can drive the E2E paths the same way.
  noteE2eBlock,
  publicIdentity,
  loadOrCreateDeviceKey,
  // (e)/M-C is proved by DOING the wipe, so the proof needs a way to do it.
  // Not a test-only path in production: it is also the honest implementation
  // of an explicit "forget this device" action, which 13.8 requires to exist.
  wipeDeviceKeyRecord,
  ensureSession,
  openIfSealed,
  isSealedEnvelope,
  setCountsOnly,
  COUNTS_ONLY_BODY,
  COUNTS_ONLY_TITLE,
  // P3.1: the passthrough surface, so a harness can drive routing and the
  // marker's lifetime without a relay. No envelope is published — see
  // pendingOfferForTest.
  routeSealedFileFrame,
  forwardFileFrameToPage,
  replayPendingOfferTo,
  expirePendingOffer,
  pendingOfferIfLive,
  pendingOfferForTest,
  FILE_PASSTHROUGH_MSG,
  e2eStateForTest: () => ({ mode: e2eMode, why: e2eWhy, kid: e2eKid, deviceId: swDeviceId }),
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
// Load (or mint) the device key before anything asks for it. Fire-and-forget:
// primeDeviceKey() swallows its own failure into the counts-only state, and
// connect() awaits the same promise rather than racing it.
primeDeviceKey();
registerDeviceKeyWithRetry('sw-boot').catch(() => {});
refreshAuthAndIndicator();
// Re-assert the count from storage on every worker boot. chrome.action state
// does outlive the worker, so this is usually a no-op — but it is the only
// thing that recovers the badge if a write was lost to a worker torn down
// mid-`serialize`, and it costs one storage.session read per respawn.
repaintBadge();
connect();
