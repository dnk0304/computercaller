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
 * postMessage contract with app/../lib/extensionBridge.ts:
 *   app  → shell : { source:'cc-ext', type:'ready' | 'open-popout' | 'sign-out' }
 *   shell → app  : { source:'cc-ext', type:'shell-hello', email, canPopout }
 * Inbound is accepted ONLY from our own iframe's contentWindow AND only from
 * the webapp origin — a message from any other frame or origin is dropped
 * before it can reach a handler. That check is what keeps `sign-out` (and the
 * window-spawning `open-popout`) from being a cross-origin trigger.
 */

// 1) Presence signal — the disconnect fires automatically when this page unloads.
try { chrome.runtime.connect({ name: 'cc-presence' }); } catch (_) {}

const frame = document.getElementById('cc-frame');
const overlay = document.getElementById('cc-signin');
const shellHeader = document.getElementById('cc-shell-header');
const signinBtn = document.getElementById('cc-signin-btn');
const signinMsg = document.getElementById('cc-signin-msg');
const signinBody = document.getElementById('cc-signin-body');

const NS = 'cc-ext';
/** popup.html can spawn the detached window; popout.html IS it. */
const CAN_POPOUT = !document.body.classList.contains('cc-is-popout')
  && location.pathname.endsWith('popup.html');

const COPY_SIGNIN =
  'Sign in and your phone does the calling — you do the typing.';
const COPY_ERROR =
  "Couldn't reach ComputerCaller. Check your connection, then try again.";

/** overlay: null = hidden, 'anon' = sign-in gate, 'error' = retry state. */
let overlayState = null;
/** Last known signed-in email, replayed to the iframe on its `ready`. */
let currentEmail = null;

function showOverlay(state, message) {
  overlayState = state;
  if (!overlay) return;
  overlay.style.display = state ? 'flex' : 'none';
  // The shell's minimal header exists ONLY in the signed-out state. While
  // signed in, the hosted app's header is the one and only header.
  if (shellHeader) shellHeader.style.display = state ? 'flex' : 'none';
  if (!state) return;
  if (signinBody) signinBody.textContent = state === 'error' ? COPY_ERROR : COPY_SIGNIN;
  if (signinBtn) signinBtn.textContent = state === 'error' ? 'Try again' : 'Sign in';
  if (signinMsg) signinMsg.textContent = message || '';
  if (signinBtn) signinBtn.focus();
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

async function runHandoff() {
  if (signinMsg) signinMsg.textContent = 'Opening sign-in…';
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({
      url: self.CC.HANDOFF_URL,
      interactive: true,
    });
    // redirect = https://<extid>.chromiumapp.org/#ext_token=<jwt>
    const hash = (redirect && redirect.split('#')[1]) || '';
    const params = new URLSearchParams(hash);
    const token = params.get('ext_token');
    if (!token) throw new Error('no token returned');
    await new Promise((r) => chrome.storage.local.set({ [self.CC.TOKEN_KEY]: token }, r));
    // Tell the SW to (re)connect its listener WS with the fresh token.
    try { await chrome.runtime.sendMessage({ type: 'auth-updated' }); } catch (_) {}
    showOverlay(null);
    loadFrame();
    // Re-probe so the account menu shows who just signed in.
    const s = await probeSession();
    currentEmail = s.state === 'authed' ? s.email : null;
    sendHello();
  } catch (e) {
    if (signinMsg) signinMsg.textContent = 'Sign-in was cancelled. Try again.';
  }
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
  // contentWindow identity). Both together mean: our frame, our app.
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.origin !== self.CC.WEBAPP_ORIGIN) return;
  const data = event.data;
  if (!data || data.source !== NS) return;

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
    // Same button, two jobs: retry the probe in the error state, run the
    // handoff in the signed-out state.
    if (overlayState === 'error') { init(); return; }
    runHandoff();
  });
}

init();
