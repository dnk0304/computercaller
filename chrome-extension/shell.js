/**
 * ComputerCaller extension shell script — shared by popup.html + popout.html
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * Responsibilities (all thin plumbing; the real UI is the /extension iframe):
 *   1. Presence: open a `cc-presence` port so the background SW suppresses
 *      duplicate chrome.notifications while a popup / pop-out is open.
 *   2. Auth gate: probe /api/auth/me. If unauthenticated, show a "Sign in"
 *      overlay whose button runs the token-handoff (launchWebAuthFlow →
 *      /api/auth/extension/handoff → #ext_token), stores the durable ext-session
 *      token, tells the SW to (re)connect, and reloads the iframe (whose cookie
 *      now exists first-party from the login).
 *   3. Pop-out button (popup only): ask the SW to open the detached window.
 */

// 1) Presence signal — the disconnect fires automatically when this page unloads.
try { chrome.runtime.connect({ name: 'cc-presence' }); } catch (_) {}

const frame = document.getElementById('cc-frame');
const overlay = document.getElementById('cc-signin');
const signinBtn = document.getElementById('cc-signin-btn');
const signinMsg = document.getElementById('cc-signin-msg');
const popoutBtn = document.getElementById('cc-popout-btn');

function showOverlay(show) {
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

async function isAuthenticated() {
  try {
    const res = await fetch(self.CC.ME_URL, { method: 'GET', credentials: 'include' });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function loadFrame() {
  if (frame && frame.src !== self.CC.EXTENSION_URL) frame.src = self.CC.EXTENSION_URL;
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
    showOverlay(false);
    loadFrame();
  } catch (e) {
    if (signinMsg) signinMsg.textContent = 'Sign-in was cancelled. Try again.';
  }
}

async function init() {
  const authed = await isAuthenticated();
  if (authed) {
    showOverlay(false);
    loadFrame();
  } else {
    showOverlay(true);
  }
}

if (signinBtn) signinBtn.addEventListener('click', runHandoff);
if (popoutBtn) {
  popoutBtn.addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'open-popout' }); } catch (_) {}
    window.close();
  });
}

init();
