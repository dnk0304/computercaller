/**
 * ComputerCaller extension shared config (2026-09-02, forge/chrome-extension-p1).
 *
 * Loaded by both the background service worker (importScripts) and the popup /
 * pop-out pages (<script src>). Single source of truth for origins + routes so
 * the SW, popup, and pop-out never drift. If the webapp ever moves off
 * computercaller.com, change ONLY this file (and the manifest host_permissions +
 * the /extension CSP frame-ancestors in the webapp).
 */
const CC = {
  WEBAPP_ORIGIN: 'https://computercaller.com',
  // The hosted Phone Mode surface iframed by the popup / pop-out.
  EXTENSION_URL: 'https://computercaller.com/extension',
  // Relay WebSocket. `role=listener` marks this as the receive-only SW peer that
  // the relay keeps out of pairing + the single-session kill switch.
  RELAY_BASE: 'wss://computercaller.com/relay',
  // The EMBEDDED sign-in framed by the popup / pop-out while signed out
  // (2026-09-15, forge/ext-embedded-login). Same origin as EXTENSION_URL, so
  // the shell's single origin check covers both frames.
  LOGIN_URL: 'https://computercaller.com/extension/login',
  // The SAME route, opened as a TOP-LEVEL window by the service worker
  // (2026-09-15, forge/ext-login-autofill). Chrome's password manager is keyed
  // off the PRIMARY MAIN FRAME's URL, and `chrome-extension://` is explicitly
  // excluded from it (chrome_password_manager_client.cc: CanShowBubbleOnURL
  // rejects `extensions::kExtensionScheme`, and IsFillingEnabled runs
  // IsPasswordManagementEnabledForCurrentPage on the last-committed URL of the
  // WebContents, which for the popup / side panel IS the extension page). So
  // inside #cc-login-frame there is no saved-password dropdown and no save
  // prompt — no matter what the form markup says. Here the main frame is
  // https://computercaller.com, so the manager runs normally.
  //
  // `?return=panel` is a marker for the page, not a redirect: the window has
  // nowhere to navigate. The SW watches for the cookie and closes the window.
  LOGIN_WINDOW_URL: 'https://computercaller.com/extension/login?return=panel',
  // Cookie → ext-session token, with NO auth window. Called by the BACKGROUND
  // SERVICE WORKER (credentials:'include') once the embedded login has set the
  // auth_token cookie. This is the password path's whole token exchange.
  EXT_TOKEN_URL: 'https://computercaller.com/api/auth/extension/token',
  // One-time sign-in handoff (launchWebAuthFlow target). STILL USED — the
  // Google path needs a real window (accounts.google.com refuses framing), and
  // that window is opened by the SERVICE WORKER, never by the popup document:
  // a popup loses focus the instant the window appears and Chrome destroys it
  // mid-await, which is the bug this dispatch exists to kill.
  HANDOFF_URL: 'https://computercaller.com/api/auth/extension/handoff',
  // Google sign-in entry point for the SW's launchWebAuthFlow. `next` returns
  // the flow to the handoff route, which mints the ext-session token and 302s
  // to the chromiumapp.org redirect Chrome intercepts.
  GOOGLE_SIGNIN_URL:
    'https://computercaller.com/api/auth/google/start?next=%2Fapi%2Fauth%2Fextension%2Fhandoff',
  // SW relay-ticket exchange (Bearer ext-session token → 30s relay ticket).
  TICKET_URL: 'https://computercaller.com/api/auth/relay-ticket/extension',
  // Session probe used by the popup to decide whether to show "Sign in".
  ME_URL: 'https://computercaller.com/api/auth/me',
  // Sign-out: clears the auth_token + idle_token cookies. The extension's
  // account chip POSTs here (credentials:'include') and additionally removes
  // the durable ext-session token from chrome.storage.local.
  LOGOUT_URL: 'https://computercaller.com/api/auth/logout',
  // T-E2E-ACCOUNT-PREF step 3: the account's Encrypted-mode setting. The SW
  // writes it on the app frame's behalf with the ext-session token in the
  // Authorization header ONLY (Security m2) — see background.js writeE2ePref.
  E2E_PREF_URL: 'https://computercaller.com/api/prefs/e2e',
  E2E_PREF_SEED_URL: 'https://computercaller.com/api/prefs/e2e/seed',
  // chrome.storage.local key holding the durable ext-session JWT.
  TOKEN_KEY: 'ext_token',
};

// Make available to the service worker (importScripts) and window pages alike.
if (typeof self !== 'undefined') self.CC = CC;
