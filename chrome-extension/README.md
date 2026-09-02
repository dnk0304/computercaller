# ComputerCaller — Chrome Extension (Phase 1 plumbing)

MV3 extension: a toolbar popup that iframes the hosted Phone Mode surface
(`https://computercaller.com/extension`) plus a background service worker that
holds a **receive-only** relay WebSocket so incoming calls/SMS fire desktop
notifications even when the popup is closed.

## Architecture (iframe-hybrid)

- `popup.html` / `popout.html` — iframe of `/extension`; `shell.js` owns the
  presence signal, the sign-in gate, and the pop-out button.
- `background.js` — the service worker. Opens `wss://computercaller.com/relay?ticket=…&role=listener`
  (a passive listener the relay keeps out of pairing + the single-session kill
  switch) and maps `CALL_INCOMING` / `CALL_WAITING` / `SMS_RECEIVED` /
  `PHONE_NOTIFICATION` → `chrome.notifications`. Calls/SMS are SENT by the iframe
  over its own connection — the SW never sends, so there are no mic/telephony
  permissions here (the phone does the calling).
- `config.js` — shared origins/routes.

## Auth

- **Iframe:** the webapp session cookie (`auth_token`, `SameSite=None; Secure`)
  rides into the third-party iframe.
- **Service worker:** a durable `ext-session` JWT obtained once via
  `chrome.identity.launchWebAuthFlow` → `/api/auth/extension/handoff`, stored in
  `chrome.storage.local`, and exchanged for 30s relay tickets at
  `/api/auth/relay-ticket/extension`.

## Pinned identity

- Extension ID: `helkcjjlidcceiifjccolmppanfmcjjg` (pinned via the manifest `key`).
- `key.pem` is the **private** half — git-ignored, never commit it. Ken/Pilot use
  it to package the `.crx`/Web-Store build so dev and prod share one ID.
- `icon*.png` are **placeholders** (git-ignored). Pixel supplies finals (brief 2).

## Load unpacked (dev)

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Sign in via the popup (opens the CC login, sets the cookie, hands the SW its token).

Note: local dev over `http://localhost` cannot use `SameSite=None` cookies — test
the iframe against the deployed HTTPS origin, or rely on the token-handoff path.
