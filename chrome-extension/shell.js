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
 *   login → shell : { source:'cc-ext', type:'login-ready' | 'signed-in' | 'google-sign-in' }
 *   shell → app   : { source:'cc-ext', type:'shell-hello', email, canPopout }
 * Inbound is accepted ONLY from one of our OWN two iframes' contentWindow AND
 * only from the webapp origin — a message from any other frame or origin is
 * dropped before it can reach a handler. The two frames are then held to
 * DISJOINT verb sets: the app frame cannot fake a sign-in and the login frame
 * cannot trigger `sign-out` or the window-spawning `open-popout`.
 */

// 1) Presence signal — the disconnect fires automatically when this page unloads.
try { chrome.runtime.connect({ name: 'cc-presence' }); } catch (_) {}

const frame = document.getElementById('cc-frame');
const overlay = document.getElementById('cc-signin');
const shellHeader = document.getElementById('cc-shell-header');
const signinBtn = document.getElementById('cc-signin-btn');
const signinMsg = document.getElementById('cc-signin-msg');
const signinBody = document.getElementById('cc-signin-body');
const loginFrame = document.getElementById('cc-login-frame');

const NS = 'cc-ext';
/** popup.html can spawn the detached window; popout.html IS it. */
const CAN_POPOUT = !document.body.classList.contains('cc-is-popout')
  && location.pathname.endsWith('popup.html');

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
      { source: NS, type: 'shell-hello', email: currentEmail, canPopout: CAN_POPOUT },
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
  if (frame && frame.src !== self.CC.EXTENSION_URL) frame.src = self.CC.EXTENSION_URL;
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
    }
    return;
  }

  if (data.type === 'ready') {
    sendHello();
  } else if (data.type === 'open-popout') {
    if (CAN_POPOUT) openPopout();
  } else if (data.type === 'sign-out') {
    signOut();
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

init();
