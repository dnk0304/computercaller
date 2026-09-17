/**
 * ComputerCaller extension shell script — shared by popup.html + popout.html
 * (2026-09-02, forge/chrome-extension-p1; account affordance + explicit error
 * state added 2026-09-14, forge/ext-login-gate; chrome moved into the hosted
 * header 2026-09-14, pixel/ext-redesign / dispatch PIXEL-B2).
 *
 * Responsibilities (all thin plumbing; the real UI is the /extension iframe):
 *   1. Presence: open a `cc-presence` port so the background SW suppresses
 *      duplicate chrome.notifications while a popup / pop-out is open.
 *   2. Auth gate: probe /api/auth/me. THREE outcomes, never two:
 *        200 → authed  → hide overlay, load iframe, hand the email to the app.
 *        401 → anon    → show the sign-in overlay.
 *        throw / 5xx   → error → show the SAME overlay in "retry" mode with the
 *                        real message. A thrown fetch used to be swallowed by a
 *                        bare catch and rendered as "signed out", which made a
 *                        network failure indistinguishable from a real logged-out
 *                        state — undiagnosable in the field.
 *   3. Account + pop-out: the BUTTONS moved into the hosted app's header
 *      (PhoneModeHeader surface="extension"). The HANDLERS stayed right here.
 *      Before B2 the shell painted its own glass chips absolutely positioned
 *      ON TOP of the iframe — two headers fighting over the same 40px, which
 *      is a large part of why the popup read as a cropped web page. Now the
 *      shell owns no chrome at all while signed in, and the app asks it to act
 *      over postMessage. signOut() below is Forge's, unchanged and un-forked:
 *      there is still exactly one sign-out implementation in the extension.
 *
 *   4. Embedded sign-in (2026-09-15, forge/ext-embedded-login). THE POPUP NEVER
 *      AWAITS A WINDOW. It used to: runHandoff() awaited
 *      chrome.identity.launchWebAuthFlow({interactive:true}) right here in the
 *      popup document. With a session already present that resolves with no
 *      window and it worked — which is why it looked fine in testing. With NO
 *      session Chrome must SHOW the auth window, the toolbar popup loses focus,
 *      Chrome destroys this document, and the await plus everything after it
 *      (store token → notify SW → load iframe) stops existing. The user could
 *      complete the login and the extension stayed signed out. That is Dennis's
 *      "I had to do it through the webapp".
 *      Now: the signed-out gate FRAMES computercaller.com/extension/login, the
 *      password path never opens a window at all, and the one flow that still
 *      needs a window (Google) is run by the background service worker, which
 *      Chrome does not kill when the popup closes.
 *
 * postMessage contract with app/../lib/extensionBridge.ts:
 *   app   → shell : { source:'cc-ext', type:'ready' | 'open-popout' | 'sign-out' }
 *   app   → shell : { source:'cc-ext', type:'theme', theme:'light'|'dark' }
 *   login → shell : { source:'cc-ext', type:'login-ready' | 'signed-in' | 'google-sign-in' }
 *   shell → app   : { source:'cc-ext', type:'shell-hello', email, canPopout }
 * Inbound is accepted ONLY from one of our OWN two iframes' contentWindow AND
 * only from the webapp origin — a message from any other frame or origin is
 * dropped before it can reach a handler. The two frames are then held to
 * DISJOINT verb sets: the app frame cannot fake a sign-in and the login frame
 * cannot trigger `sign-out` or the window-spawning `open-popout`.
 */

// 0) THEME — run first, before anything can paint (dispatch PIXEL-R, 2026-09-16).
//
// WHY THIS IS HERE AND NOT IN THE APP
// The panel is two documents: this shell, and the computercaller.com/extension
// iframe filling it. Dispatch J gave the iframe a Light/Dark/System toggle in
// the account menu, keyed off `data-cc-theme` on its own <html>. The shell was
// never told. Force Light on a dark OS and the iframe turned light while the
// shell chrome around it — the title band and the 1px ring of --cc-page — kept
// asking the OS and stayed dark. Dennis saw a mismatched ring.
//
// The shell CANNOT read the site's preference directly: the choice lives in
// computercaller.com's localStorage, and a chrome-extension:// page has no
// access to another origin's storage. So the theme travels the wire that
// already exists between these two documents — the same postMessage channel,
// same `cc-ext` namespace, same origin + contentWindow gate as every other
// inbound verb. It carries a word, not a capability: the worst a forged
// `theme` message achieves is the wrong background colour.
//
// FIRST PAINT
// chrome.storage.local is async, so the stored choice cannot be read before
// the first frame. Two steps instead of one:
//   (a) synchronously, right now — matchMedia. Correct for System, which is
//       the default and the majority, and never worse than the old behaviour.
//   (b) as soon as storage resolves (sub-millisecond, and this script is
//       parser-blocking at the end of <body>) — the stored override.
// The cache is what makes (b) matter at all: without it the shell would only
// learn the theme once the iframe had loaded and announced it, which is
// hundreds of milliseconds of visibly wrong chrome on every single open.
const THEME_KEY = 'cc_theme';

function systemTheme() {
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) {
    return 'light';
  }
}

/**
 * @param {unknown} theme 'light' | 'dark' — a resolved theme, never 'system'.
 *   'System' is resolved to one of the two by whoever chose it, so this shell
 *   and shell.css have ONE code path (attribute always present) instead of two
 *   (attribute present / attribute absent, media query decides). Two paths is
 *   how a toggle ends up disagreeing with itself.
 */
function applyShellTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  document.documentElement.setAttribute('data-cc-theme', theme);
}

// (a) Synchronous best guess. Runs during parse, before the body paints.
applyShellTheme(systemTheme());

// (b) The stored override, and live updates. A change written by ANY surface
// (popup, side panel, pop-out) reaches the others through chrome.storage's own
// change event, so two open surfaces cannot show two different themes.
try {
  chrome.storage.local.get(THEME_KEY, (got) => {
    if (chrome.runtime.lastError) return;
    applyShellTheme(got && got[THEME_KEY]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[THEME_KEY]) return;
    applyShellTheme(changes[THEME_KEY].newValue);
  });
} catch (_) {
  // Storage unavailable — (a) already painted a sane System theme and the
  // iframe's `theme` message below will still correct an override once it
  // loads. A colour preference is not worth a broken panel.
}

/** Inbound `theme` from the app frame: stamp now, cache for the next open. */
function receiveTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  applyShellTheme(theme);
  try {
    chrome.storage.local.set({ [THEME_KEY]: theme });
  } catch (_) {}
}

// 1) Presence signal — the disconnect fires automatically when this page unloads.
//
// The port is now HELD rather than dropped on the floor (2026-09-15,
// forge/ext-badge-sidepanel). It was always a presence beacon; it is now also
// the unread-count channel, because it already carries exactly the right
// lifetime: it exists while a surface is on screen and dies with it. Adding a
// second runtime.onMessage channel for counts would have duplicated that
// bookkeeping and let the two disagree.
let presencePort = null;
try {
  presencePort = chrome.runtime.connect({ name: 'cc-presence' });
  presencePort.onMessage.addListener((msg) => {
    if (msg && msg.type === 'unread' && msg.unread) {
      unread = msg.unread;
      sendHello();
    }
  });
  presencePort.onDisconnect.addListener(() => { presencePort = null; });
} catch (_) {}

const frame = document.getElementById('cc-frame');
const overlay = document.getElementById('cc-signin');
const shellHeader = document.getElementById('cc-shell-header');
const signinBtn = document.getElementById('cc-signin-btn');
const signinMsg = document.getElementById('cc-signin-msg');
const signinBody = document.getElementById('cc-signin-body');
const loginFrame = document.getElementById('cc-login-frame');

const NS = 'cc-ext';

/**
 * Which of the three surfaces are we? Read from the <body> marker, with the old
 * pathname test kept as a fallback so a stale cached page still behaves.
 * @type {'popup'|'popout'|'sidepanel'}
 */
const SURFACE = document.body.dataset.surface ||
  (location.pathname.endsWith('popout.html') ? 'popout'
    : location.pathname.endsWith('sidepanel.html') ? 'sidepanel' : 'popup');

/** The docked surfaces can spawn the detached window; popout.html IS it. */
const CAN_POPOUT = SURFACE !== 'popout';
/** Only the detached window can dock — the docked ones are already home. */
const CAN_DOCK = SURFACE === 'popout';

/**
 * Deep link carried in from a notification: background.js opens
 * popout.html#tab=texts&thread=… and we pass the hash straight through to the
 * hosted surface's URL. The extension never parses it; the app owns that
 * vocabulary, so a new tab or param needs no change on this side.
 */
const DEEP_LINK = location.hash && location.hash.length > 1 ? location.hash : '';

/** Latest unread counts pushed by the SW over the presence port. */
let unread = { missedCalls: 0, newSms: 0, alerts: 0 };

const COPY_SIGNIN =
  'Sign in and your phone does the calling — you do the typing.';
const COPY_ERROR =
  "Couldn't reach ComputerCaller. Check your connection, then try again.";

/**
 * How long the boot skeleton stands in for the signed-out gate before the
 * static "Sign in" fallback takes over (dispatch PIXEL-D).
 *
 * The number is a floor on patience, not a guess at load time: below ~600ms a
 * skeleton flashes and is worse than nothing, and past ~1.5s a user with a
 * blocked or offline frame is being made to wait for a button that was
 * available the whole time. 1100ms covers a warm /extension/login round-trip
 * and still hands over a real control quickly when the frame never arrives.
 */
const BOOT_SKELETON_MS = 1100;

/** overlay: null = hidden, 'anon' = sign-in gate, 'error' = retry state. */
let overlayState = null;
/** Pending BOOT_SKELETON_MS timer, so leaving 'anon' can cancel it. */
let bootTimer = null;
/** Last known signed-in email, replayed to the iframe on its `ready`. */
let currentEmail = null;

function showOverlay(state, message) {
  overlayState = state;
  if (!overlay) return;
  overlay.style.display = state ? 'block' : 'none';
  // The shell's minimal header exists ONLY in the signed-out state. While
  // signed in, the hosted app's header is the one and only header.
  if (shellHeader) shellHeader.style.display = state ? 'flex' : 'none';
  if (!state) { unloadLoginFrame(); return; }
  if (signinBody) signinBody.textContent = state === 'error' ? COPY_ERROR : COPY_SIGNIN;
  if (signinBtn) signinBtn.textContent = state === 'error' ? 'Try again' : 'Sign in';
  if (signinMsg) signinMsg.textContent = message || '';
  if (state === 'anon') {
    // Skeleton first, fallback second, real form third — see shell.css. The
    // fallback is NOT skipped, only deferred: if the frame never reports ready
    // the timer below reveals it, so a framing/network failure still lands on
    // a visible button rather than a blank panel.
    beginBoot();
    loadLoginFrame();
  } else {
    // 'error' is "we never reached the server" — framing a page from that same
    // unreachable server would only stack a second failure on top of it.
    unloadLoginFrame();
    if (signinBtn) signinBtn.focus();
  }
}

/**
 * Show the boot skeleton and arm its handover to the static fallback.
 * Idempotent: re-arming restarts the clock, which is what a retry wants.
 */
function beginBoot() {
  if (!overlay) return;
  clearTimeout(bootTimer);
  overlay.classList.add('cc-booting');
  bootTimer = setTimeout(endBoot, BOOT_SKELETON_MS);
}

/**
 * Retire the skeleton. Called from three places on purpose — the timer, the
 * `login-ready` message, and every exit from the 'anon' state — because a
 * skeleton still animating over a signed-in surface is the exact failure this
 * whole layer is supposed to prevent.
 */
function endBoot() {
  clearTimeout(bootTimer);
  bootTimer = null;
  if (overlay) overlay.classList.remove('cc-booting');
}

/** Point the gate iframe at /extension/login. Idempotent. */
function loadLoginFrame() {
  if (!loginFrame) return;
  if (loginFrame.src !== self.CC.LOGIN_URL) loginFrame.src = self.CC.LOGIN_URL;
}

/**
 * Drop the login frame and fall back to the static block. Called whenever the
 * overlay leaves the 'anon' state — a signed-in surface must not keep a live
 * login page parked behind it, and a re-shown gate must re-announce itself
 * rather than inherit a stale `login-ready`.
 */
function unloadLoginFrame() {
  endBoot();
  if (overlay) overlay.classList.remove('cc-has-login');
  if (loginFrame) loginFrame.removeAttribute('src');
}

/**
 * Tell the hosted app who is signed in and whether a pop-out is possible, so
 * it can render the account menu and the ⤢ button. Safe to call repeatedly;
 * the app treats it as idempotent state, not an event.
 */
function sendHello() {
  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(
      {
        source: NS,
        type: 'shell-hello',
        email: currentEmail,
        canPopout: CAN_POPOUT,
        // Additive (2026-09-15). Older app builds ignore unknown fields, so the
        // extension and the hosted app can be deployed in either order.
        canDock: CAN_DOCK,
        surface: SURFACE,
        unread,
      },
      self.CC.WEBAPP_ORIGIN,
    );
  } catch (_) {}
}

/**
 * The single auth probe. Returns a discriminated state — NEVER a bare boolean,
 * so "the server said no" and "we never reached the server" stay distinct.
 * @returns {Promise<{state:'authed',email:string|null}|{state:'anon'}|{state:'error',message:string}>}
 */
async function probeSession() {
  let res;
  try {
    res = await fetch(self.CC.ME_URL, { method: 'GET', credentials: 'include' });
  } catch (e) {
    return { state: 'error', message: (e && e.message) || 'network error' };
  }
  if (res.status === 401) return { state: 'anon' };
  if (!res.ok) return { state: 'error', message: `server returned ${res.status}` };
  let email = null;
  try {
    const body = await res.json();
    email = (body && body.user && body.user.email) || null;
  } catch (_) {
    // A 200 with an unreadable body still means authenticated; we just have no
    // email to show in the menu.
  }
  return { state: 'authed', email };
}

function loadFrame() {
  const url = self.CC.EXTENSION_URL + DEEP_LINK;
  if (frame && frame.src !== url) frame.src = url;
}

function clearFrame() {
  if (frame) frame.removeAttribute('src');
}

/**
 * The embedded login just set the auth_token cookie. Two things follow, in this
 * order and for two different consumers:
 *
 *   1. The SERVICE WORKER mints its durable ext-session token from that cookie
 *      (POST /api/auth/extension/token — no window, nothing to destroy) and
 *      reconnects its listener socket. We ask for it and we wait, but we do NOT
 *      make the UI depend on it: the SW retries on its own keepalive alarm, and
 *      the app surface below only needs the cookie.
 *   2. THIS document swaps the gate for the app surface and re-probes so the
 *      account menu knows who signed in — no reopening the popup, which is
 *      requirement (2) of the dispatch.
 */
async function completeSignIn() {
  if (signinMsg) signinMsg.textContent = 'Finishing sign-in…';
  let minted = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sign-in-complete' });
    minted = !!(res && res.ok);
  } catch (_) {
    // The SW was asleep or the channel closed. Non-fatal — see (1) above.
  }
  showOverlay(null);
  loadFrame();
  const s = await probeSession();
  currentEmail = s.state === 'authed' ? s.email : null;
  sendHello();
  if (!minted) {
    // Surfaced nowhere in the UI on purpose (the app is usable), but a field
    // report with the console open should say which half fell over.
    console.warn('[CC] signed in, but the ext-session token was not minted yet');
  }
}

/**
 * Google. The popup will almost certainly be destroyed the moment the auth
 * window appears — that is FINE and is the whole point of D1: the flow lives in
 * the service worker, so nothing is lost when this document dies. If we do
 * survive (the pop-out window does), finish the same way the password path
 * does.
 */
async function startGoogleSignIn() {
  if (signinMsg) signinMsg.textContent = 'Opening Google sign-in…';
  let ok = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'google-sign-in' });
    ok = !!(res && res.ok);
  } catch (_) {
    // Document torn down, or the SW went away. The SW's flow continues either
    // way; reopening the popup picks up the finished session.
    return;
  }
  if (!ok) {
    if (signinMsg) signinMsg.textContent = 'Google sign-in was cancelled. Try again.';
    return;
  }
  showOverlay(null);
  loadFrame();
  const s = await probeSession();
  currentEmail = s.state === 'authed' ? s.email : null;
  sendHello();
}

/**
 * Password path, WINDOWED — the saved-password escape hatch
 * (2026-09-15, forge/ext-login-autofill).
 *
 * Chrome's password manager is keyed off the WebContents' PRIMARY MAIN FRAME
 * URL, and `chrome-extension://` is excluded from it, so inside
 * #cc-login-frame there is no saved-password dropdown however the form is
 * marked up (see runPasswordSignIn() in background.js for the Chromium
 * references). Address autofill is a different subsystem and is NOT excluded,
 * which is why the email field fills and the password field does not — the bug
 * as Dennis reported it.
 *
 * So: hand the job to a real window owned by the SERVICE WORKER, whose main
 * frame IS https://computercaller.com. We do not await it from here on the
 * docked surfaces — a toolbar popup is destroyed the moment the window takes
 * focus and the await would never resume. The SW finishes the flow on its own
 * (it polls the cookie-authed mint), so reopening the popup lands signed in.
 * The pop-out window survives, so there we do wait and swap in place.
 */
async function startPasswordWindowSignIn() {
  const btn = pwEscapeBtn;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Opening sign-in window…'; }
  let ok = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'password-sign-in' });
    ok = !!(res && res.ok);
  } catch (_) {
    // This document was torn down (popup lost focus to the new window) or the
    // SW went away mid-flight. The SW's flow continues either way.
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (!ok) return;          // Cancelled or timed out; the inline form is still there.
  showOverlay(null);
  loadFrame();
  const s = await probeSession();
  currentEmail = s.state === 'authed' ? s.email : null;
  sendHello();
}

/**
 * Forge's sign-out, unchanged. Clears BOTH credentials — the ext-session token
 * in chrome.storage.local AND the auth_token / idle_token cookies — then drops
 * the iframe and returns to the sign-in overlay. Triggered from the app's
 * account menu now, but still the only implementation.
 */
async function signOut() {
  // Cookie credential (auth_token + idle_token). The extension page origin is
  // explicitly allowed by the logout route's CSRF gate; credentials:'include'
  // is required because the cookie is SameSite=None in prod.
  try {
    await fetch(self.CC.LOGOUT_URL, { method: 'POST', credentials: 'include' });
  } catch (_) {
    // Network failure still clears the local token below; the cookie will be
    // rejected on its next use anyway if the session was revoked server-side.
  }
  // Durable ext-session token used by the background SW.
  try {
    await new Promise((r) => chrome.storage.local.remove(self.CC.TOKEN_KEY, r));
  } catch (_) {}
  try { await chrome.runtime.sendMessage({ type: 'signed-out' }); } catch (_) {}
  clearFrame();
  currentEmail = null;
  showOverlay('anon');
}

async function openPopout() {
  // Unchanged SW contract: {type:'open-popout'}. The trigger moved; the
  // message did not.
  try { await chrome.runtime.sendMessage({ type: 'open-popout' }); } catch (_) {}
  window.close();
}

/**
 * The reverse of openPopout — Dennis's "there is no button again for me to
 * reconnect it to the extension browser window" (addendum 2026-09-15).
 *
 * THE OPEN HAPPENS HERE, IN THE PAGE. Not in the service worker, and that is a
 * measured correction to the dispatch's proposed design. Both docking calls are
 * gesture-gated, and the gesture DOES NOT survive a runtime.sendMessage hop.
 * From a real trusted click, in the bundled Chromium
 * (scripts/ext-dock-gesture-proof.mjs):
 *
 *   this page → SW → sidePanel.open()
 *       → "`sidePanel.open()` may only be called in response to a user gesture."
 *   this page → sidePanel.open()
 *       → opened.
 *
 * So the page opens, and the worker closes. The split is not arbitrary: opening
 * needs the gesture the click gave US, and closing this window is the one half
 * that must NOT run here, because removing our own window mid-handler races our
 * own teardown.
 *
 * An `await` before open() is fine — verified, the gesture survives an await
 * inside the same handler — which is what lets us resolve the target window
 * first.
 *
 * If Chrome refuses everything we stay open and tell the app, which shows the
 * "Click the toolbar icon" hint rather than pretending the click did nothing.
 */
async function requestDock() {
  let result = { ok: false, surface: 'none' };

  // 1. Page-side, gesture-bound. The primary path.
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (win && typeof win.id === 'number') {
        await chrome.sidePanel.open({ windowId: win.id });
        result = { ok: true, surface: 'sidepanel' };
      }
    }
  } catch (_) { /* fall through */ }

  // 2. The toolbar popup, for a build without the side panel. Only meaningful
  //    while a default_popup exists; it does not today, so this is inert unless
  //    the manifest changes back.
  if (!result.ok) {
    try {
      if (chrome.action && chrome.action.openPopup) {
        await chrome.action.openPopup();
        result = { ok: true, surface: 'popup' };
      }
    } catch (_) { /* fall through */ }
  }

  // 3. Last resort: let the worker try. Expected to fail for the gesture reason
  //    above, but it costs one message and it returns a clean answer.
  if (!result.ok) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'dock' });
      if (res && typeof res.surface === 'string' && res.ok) result = res;
    } catch (_) {}
  }

  if (result.ok) {
    // Docked. Ask the worker to remove THIS window — see above on why not here.
    try { await chrome.runtime.sendMessage({ type: 'dock-close' }); } catch (_) {}
    // Belt and braces for a surface the worker could not identify (no sender.tab).
    try { window.close(); } catch (_) {}
    return;
  }

  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(
      { source: NS, type: 'dock-result', ok: result.ok, surface: result.surface },
      self.CC.WEBAPP_ORIGIN,
    );
  } catch (_) {}
}

/**
 * P3 (a) — publish the SERVICE WORKER's E2E public key to the app frame.
 *
 * The SW is a recipient of the pairing's session key (§13.3 B9: the SAS covers
 * the whole key set, SW key included), but it is not `room.active.browser` and
 * therefore never takes part in the pairing handshake itself. The page does
 * that. So the page has to learn this key from somewhere, and the only channel
 * between a service worker and the pairing page is this bridge.
 *
 * Contract (agreed with P2 through Ken):
 *   { source:'cc-ext', type:'e2e-pubkey', v:1, deviceId:string|null, pub:string|null,
 *     pairingId:string|null, rid?:string }
 *
 * `pairingId` is A4.1 (Ken's ruling R-T). It travels PAGE → SW: the page owns
 * the pairing and is the only authoritative source of its id, and the SW cannot
 * learn it from the relay (PAIR_STATE carries it only INSIDE `ctx`, and
 * checking `ctx.pairingId` against itself is a check that cannot fail). The
 * page therefore puts its `pairingId` on the REQUEST; the worker pins it, and
 * the reply carries back the value the worker now holds so the page can see
 * that the hand-over landed rather than assume it. Its null arm is the same
 * deliberate arm as `pub`'s: "the worker holds no pairingId yet" and "no reply
 * arrived" are different states and must stay tellable apart.
 *
 * It is a CONSISTENCY pin, never an anchor: A4 clause (b) — the SW's own wrap
 * opening under KEK(ctx, its own static key) — remains the cryptographic proof
 * of membership, and nothing here weakens it.
 * `pub` is SEC1 uncompressed P-256, 65 bytes, 0x04-prefixed, base64url unpadded.
 * `deviceId` matches the relay's listener charset exactly.
 *
 * THE NULL ARM IS NOT AN ERROR PATH. A worker with no key still publishes
 * `{deviceId:null, pub:null}`, because "the SW has no key — pair without it,
 * it will show counts only" (m-G) and "the message has not arrived yet — wait"
 * are different states that a consumer must be able to tell apart. Sending
 * nothing collapses them into one and the page would wait forever.
 *
 * Sent with the SAME targetOrigin pin as every other shell→app message. This
 * is a public key, so it is not a secret — but the pin is what stops a
 * navigated frame from being told which device to expect, which is the
 * substitution B9's SAS exists to make visible.
 */
async function sendE2ePubKey(rid, pairingId) {
  if (!frame || !frame.contentWindow) return;
  let identity = { v: 1, deviceId: null, pub: null, pairingId: null };
  try {
    // The hand-over rides the request that was already being made. A second
    // round trip would open a window in which the page had published a key it
    // had not yet told the worker which pairing that key belongs to.
    const r = await chrome.runtime.sendMessage({
      type: 'e2e-pubkey-get',
      ...(pairingId === undefined ? {} : { pairingId }),
    });
    if (r && r.ok) {
      identity = { v: 1, deviceId: r.deviceId ?? null, pub: r.pub ?? null, pairingId: r.pairingId ?? null };
    }
  } catch {
    // Worker asleep or mid-respawn. Fall through with the null arm rather than
    // going silent — the page can ask again.
  }
  // Re-checked AFTER the await: the frame can be torn down while the worker
  // answers, and postMessage on a dead contentWindow throws.
  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(
      // `rid` is echoed ONLY when the app supplied one (P2's request, 2026-09-17).
      // Spread last and conditionally, so an unsolicited emission carries no
      // `rid: undefined` field that a strict consumer might read as a reply to
      // a request it never made.
      { source: NS, type: 'e2e-pubkey', ...identity, ...(rid === undefined ? {} : { rid }) },
      self.CC.WEBAPP_ORIGIN,
    );
  } catch {}
}

/**
 * The app says which tab is on screen; the SW zeroes that counter. Sent over
 * the presence port (not runtime.sendMessage) so it shares the exact lifetime
 * of the surface reporting it.
 */
function reportTabViewed(tab) {
  if (typeof tab !== 'string' || !tab) return;
  if (presencePort) {
    try { presencePort.postMessage({ type: 'tab-viewed', tab }); return; } catch (_) {}
  }
  // Port lost (SW recycled). One-shot fallback so a view is never silently lost.
  try { chrome.runtime.sendMessage({ type: 'tab-viewed', tab }); } catch (_) {}
}

// ---- Inbound from the hosted app -------------------------------------------
window.addEventListener('message', (event) => {
  // Two independent gates. Origin alone is not enough (any frame we host could
  // claim it); source alone is not enough (a navigated iframe keeps its
  // contentWindow identity). Both together mean: one of OUR frames, our app.
  if (event.origin !== self.CC.WEBAPP_ORIGIN) return;
  const fromApp = !!frame && event.source === frame.contentWindow;
  const fromLogin = !!loginFrame && event.source === loginFrame.contentWindow;
  if (!fromApp && !fromLogin) return;
  const data = event.data;
  if (!data || data.source !== NS) return;

  // DISJOINT verb sets per frame. The app surface can never claim a sign-in it
  // did not perform, and the signed-out login page can never reach `sign-out`
  // or the window-spawning `open-popout`.
  if (fromLogin) {
    if (data.type === 'login-ready') {
      // The embedded form rendered — retire the skeleton and the static block.
      endBoot();
      if (overlay) overlay.classList.add('cc-has-login');
      if (signinMsg) signinMsg.textContent = '';
    } else if (data.type === 'signed-in') {
      completeSignIn();
    } else if (data.type === 'google-sign-in') {
      startGoogleSignIn();
    } else if (data.type === 'password-window') {
      startPasswordWindowSignIn();
    }
    return;
  }

  if (data.type === 'ready') {
    sendHello();
    // Unsolicited on every `ready` so a reloaded app re-learns the key without
    // having to know it should ask.
    sendE2ePubKey();
  } else if (data.type === 'e2e-pubkey-request') {
    // On demand. Reachable ONLY from the app frame — this branch sits inside
    // the `fromApp` verb set, and the login frame's set above is disjoint and
    // returns before it. The signed-out login page must never be able to probe
    // for device identity.
    //
    // An optional `rid` is echoed back on the reply so the page can match a
    // reply to its own request rather than to an unsolicited emission. It is
    // an OPAQUE CORRELATOR, not a credential: it is echoed, never interpreted,
    // never used to decide anything, and a request without one still works.
    // Bounded and type-checked before it goes anywhere, so a hostile page
    // cannot use it to push an unbounded string back through the bridge.
    //
    // A4.1: an optional `pairingId` on the REQUEST is the page's hand-over.
    // Bounded and type-checked here for the same reason `rid` is — this branch
    // is reachable from the app frame, so nothing arriving on it goes to the
    // worker unvalidated. 255 is the u8 length prefix `pairContext` gives the
    // field; anything longer could not be a real pairingId.
    sendE2ePubKey(
      (typeof data.rid === 'string' && data.rid.length > 0 && data.rid.length <= 64)
        ? data.rid
        : undefined,
      (typeof data.pairingId === 'string' && data.pairingId.length > 0 && data.pairingId.length <= 255)
        ? data.pairingId
        : undefined,
    );
  } else if (data.type === 'open-popout') {
    if (CAN_POPOUT) openPopout();
  } else if (data.type === 'dock') {
    // Guarded by surface, not by trust: a docked surface asking to dock would
    // close the user's only window to reopen the same thing.
    if (CAN_DOCK) requestDock();
  } else if (data.type === 'tab-viewed') {
    reportTabViewed(data.tab);
  } else if (data.type === 'sign-out') {
    signOut();
  } else if (data.type === 'theme') {
    // Posted by lib/extensionTheme.ts: once from the blocking boot script on
    // every /extension load, and again on every toggle. Already resolved to
    // light|dark on the sender's side.
    receiveTheme(data.theme);
  }
});

async function init() {
  const session = await probeSession();
  if (session.state === 'authed') {
    currentEmail = session.email;
    showOverlay(null);
    loadFrame();
    // The iframe may not have loaded yet; it announces `ready` when it has, and
    // this covers the case where it loaded before we got here.
    sendHello();
  } else if (session.state === 'anon') {
    currentEmail = null;
    showOverlay('anon');
  } else {
    currentEmail = null;
    showOverlay('error', session.message);
  }
}

if (frame) frame.addEventListener('load', sendHello);

if (signinBtn) {
  signinBtn.addEventListener('click', () => {
    // Same button, two jobs — neither of which opens a window any more:
    // retry the session probe in the error state, retry the embedded login in
    // the signed-out state (this button is only reachable while the login
    // frame has NOT reported ready, i.e. it failed to load).
    if (overlayState === 'error') { init(); return; }
    if (signinMsg) signinMsg.textContent = 'Loading sign-in…';
    if (loginFrame) loginFrame.removeAttribute('src');
    beginBoot();
    loadLoginFrame();
  });
}

/**
 * The saved-password affordance. Built HERE rather than in the three HTML
 * surfaces on purpose: it belongs to the gate's behaviour, all three carry the
 * same #cc-signin, and keeping it out of the markup keeps this dispatch off
 * files other seats are editing. CSS shows it only with .cc-has-login — i.e.
 * only while the inline form is actually up, never over the fallback or the
 * boot skeleton, where it would be a second competing button.
 *
 * The inline form stays exactly as it is: people who type their password are
 * unaffected, and this is the one extra click for people whose password lives
 * in Chrome.
 */
const pwEscapeBtn = (() => {
  if (!overlay) return null;
  const wrap = document.createElement('div');
  wrap.className = 'cc-pw-escape';
  const hint = document.createElement('span');
  hint.textContent = 'Password saved in Chrome?';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'cc-pw-escape-btn';
  btn.textContent = 'Use a saved password';
  btn.addEventListener('click', startPasswordWindowSignIn);
  wrap.append(hint, btn);
  overlay.appendChild(wrap);
  return btn;
})();

init();
