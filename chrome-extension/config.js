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
  // One-time sign-in handoff (launchWebAuthFlow target).
  HANDOFF_URL: 'https://computercaller.com/api/auth/extension/handoff',
  // SW relay-ticket exchange (Bearer ext-session token → 30s relay ticket).
  TICKET_URL: 'https://computercaller.com/api/auth/relay-ticket/extension',
  // Session probe used by the popup to decide whether to show "Sign in".
  ME_URL: 'https://computercaller.com/api/auth/me',
  // chrome.storage.local key holding the durable ext-session JWT.
  TOKEN_KEY: 'ext_token',
};

// Make available to the service worker (importScripts) and window pages alike.
if (typeof self !== 'undefined') self.CC = CC;
