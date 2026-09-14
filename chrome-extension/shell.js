/**
 * ComputerCaller extension shell script — shared by popup.html + popout.html
 * (2026-09-02, forge/chrome-extension-p1; account affordance + explicit error
 * state added 2026-09-14, forge/ext-login-gate).
 *
 * Responsibilities (all thin plumbing; the real UI is the /extension iframe):
 *   1. Presence: open a `cc-presence` port so the background SW suppresses
 *      duplicate chrome.notifications while a popup / pop-out is open.
 *   2. Auth gate: probe /api/auth/me. THREE outcomes, never two:
 *        200 → authed  → hide overlay, load iframe, render the account chip.
 *        401 → anon    → show the sign-in overlay.
 *        throw / 5xx   → error → show the SAME overlay in "retry" mode with the
 *                        real message. Previously a thrown fetch was swallowed
 *                        by a bare `catch` and rendered as "signed out", which
 *                        made a network failure indistinguishable from a real
 *                        logged-out state — undiagnosable in the field.
 *   3. Account affordance: who is signed in + a Sign out that clears BOTH
 *      credentials — the ext-session token in chrome.storage.local AND the
 *      auth_token / idle_token cookies (POST /api/auth/logout) — then drops the
 *      iframe and returns to the sign-in overlay. The iframed /extension surface
 *      (PhoneModeShell) deliberately carries no account chrome, so without this
 *      a signed-in user had NO sign-in/sign-out control anywhere in the
 *      extension. Placement here is the shell's own chrome and is provisional
 *      pending the Pixel/Vinci pass.
 *   4. Pop-out button (popup only): ask the SW to open the detached window.
 */

// 1) Presence signal — the disconnect fires automatically when this page unloads.
try { chrome.runtime.connect({ name: 'cc-presence' }); } catch (_) {}

const frame = document.getElementById('cc-frame');
const overlay = document.getElementById('cc-signin');
const signinBtn = document.getElementById('cc-signin-btn');
const signinMsg = document.getElementById('cc-signin-msg');
const signinBody = document.getElementById('cc-signin-body');
const popoutBtn = document.getElementById('cc-popout-btn');
const account = document.getElementById('cc-account');
const accountEmail = document.getElementById('cc-account-email');
const signoutBtn = document.getElementById('cc-signout-btn');

const COPY_SIGNIN =
  'Sign in to make and receive calls and texts from your browser — your phone does the calling.';
const COPY_ERROR =
  "Couldn't reach ComputerCaller. Check your connection, then try again.";

/** overlay: null = hidden, 'anon' = sign-in gate, 'error' = retry state. */
let overlayState = null;

function showOverlay(state, message) {
  overlayState = state;
  if (!overlay) return;
  overlay.style.display = state ? 'flex' : 'none';
  if (!state) return;
  if (signinBody) signinBody.textContent = state === 'error' ? COPY_ERROR : COPY_SIGNIN;
  if (signinBtn) signinBtn.textContent = state === 'error' ? 'Try again' : 'Sign in';
  if (signinMsg) signinMsg.textContent = message || '';
}

function renderAccount(email) {
  if (!account) return;
  if (email) {
    if (accountEmail) {
      accountEmail.textContent = email;
      accountEmail.title = `Signed in as ${email}`;
    }
    account.hidden = false;
  } else {
    account.hidden = true;
  }
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
    // email to show in the chip.
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
    // Re-probe so the account chip shows who just signed in.
    const s = await probeSession();
    renderAccount(s.state === 'authed' ? s.email : null);
  } catch (e) {
    if (signinMsg) signinMsg.textContent = 'Sign-in was cancelled. Try again.';
  }
}

async function signOut() {
  if (signoutBtn) signoutBtn.disabled = true;
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
  renderAccount(null);
  showOverlay('anon');
  if (signoutBtn) signoutBtn.disabled = false;
}

async function init() {
  const session = await probeSession();
  if (session.state === 'authed') {
    showOverlay(null);
    renderAccount(session.email);
    loadFrame();
  } else if (session.state === 'anon') {
    renderAccount(null);
    showOverlay('anon');
  } else {
    renderAccount(null);
    showOverlay('error', session.message);
  }
}

if (signinBtn) {
  signinBtn.addEventListener('click', () => {
    // Same button, two jobs: retry the probe in the error state, run the
    // handoff in the signed-out state.
    if (overlayState === 'error') { init(); return; }
    runHandoff();
  });
}
if (signoutBtn) signoutBtn.addEventListener('click', signOut);
if (popoutBtn) {
  popoutBtn.addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'open-popout' }); } catch (_) {}
    window.close();
  });
}

init();
