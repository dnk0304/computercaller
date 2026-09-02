/**
 * Chrome-extension shared constants (2026-09-02, forge/chrome-extension-p1).
 *
 * The extension ID is PINNED via the `key` field in chrome-extension/manifest.json
 * (an RSA public key committed there). A pinned key means the unpacked/dev and the
 * Web-Store build share ONE stable ID, so the CSP `frame-ancestors` allow-list and
 * the OAuth handoff redirect URL below never drift.
 *
 * Keypair: chrome-extension/key.pem is the PRIVATE half (git-ignored, NOT committed).
 * If it is ever lost, regenerate the pair AND update: this ID, the manifest `key`,
 * and the CSP entry in next.config.ts — all three must agree.
 */
export const CC_EXTENSION_ID = 'helkcjjlidcceiifjccolmppanfmcjjg';

/** The extension's page origin — used in the `/extension` route's frame-ancestors CSP. */
export const CC_EXTENSION_ORIGIN = `chrome-extension://${CC_EXTENSION_ID}`;

/**
 * The redirect target Chrome's `chrome.identity.launchWebAuthFlow` listens on.
 * Chrome intercepts any navigation to `https://<EXT_ID>.chromiumapp.org/*` and
 * returns the full URL (including the `#ext_token=…` fragment) to the extension.
 */
export const CC_EXTENSION_AUTH_REDIRECT = `https://${CC_EXTENSION_ID}.chromiumapp.org/`;
