# ComputerCaller — Chrome Extension (Phase 1 plumbing)

MV3 extension: a toolbar popup that iframes the hosted Phone Mode surface
(`https://computercaller.com/extension`) plus a background service worker that
holds a **receive-only** relay WebSocket so incoming calls/SMS fire desktop
notifications even when the popup is closed.

## Architecture (iframe-hybrid)

- `sidepanel.html` / `popup.html` / `popout.html` — three containers, ONE
  implementation: each iframes `/extension` and loads the same `shell.js`, which
  tells them apart by `<body data-surface>`. `shell.js` owns the presence
  signal, the sign-in gate, the pop-out button and the dock button.
  - `sidepanel.html` is what the toolbar icon opens (`side_panel.default_path`);
    `action.default_popup` is deliberately ABSENT, because a declared popup wins
    over `openPanelOnActionClick` and the panel would never appear.
  - `popup.html` is therefore not reachable from the toolbar today. It is kept
    because `chrome.action.openPopup()` is the dock fallback for a Chromium
    without the side panel, and restoring it is a one-line manifest change.
- `background.js` — the service worker. Opens `wss://computercaller.com/relay?ticket=…&role=listener`
  (a passive listener the relay keeps out of pairing + the single-session kill
  switch) and maps `CALL_INCOMING` / `CALL_WAITING` / `SMS_RECEIVED` /
  `PHONE_NOTIFICATION` → `chrome.notifications`. Calls/SMS are SENT by the iframe
  over its own connection — the SW never sends, so there are no mic/telephony
  permissions here (the phone does the calling).
- `config.js` — shared origins/routes.

### Connection indicator

`background.js` composes the toolbar icon at runtime (OffscreenCanvas over
`icon128.png`) and puts a dot in its bottom-right: **green** only when the
listener socket is open AND a phone is in the room, **grey** when signed in but
either of those is missing, **nothing** when signed out. Chrome cannot draw
above the icon, and `setBadgeText` only writes a text chip in the same corner —
`setIcon` is the one API that can draw a dot, with the badge kept as a fallback.

Phone presence comes from frames the relay ALREADY sends a listener — a
`?role=listener` peer sits in `room.lobby` permanently, so it receives
`LOBBY_STATUS{phonePresent, alreadyActive}`, `PHONE_PRESENT` and `PHONE_ABSENT`
through `broadcastToLobbyBrowsers()`. No relay change was needed.

### Unread counts

`{missedCalls, newSms, alerts}` in `chrome.storage.session`, counted only while
no surface holds the `cc-presence` port and zeroed per tab when a surface sends
`{type:'tab-viewed', tab}`. They travel on that same port — it already has
exactly the right lifetime. Every read-modify-write on `storage.session` goes
through one promise queue; without it a burst of frames loses updates.

### Docking (pop-out → panel)

`chrome.sidePanel.open()` is gesture-gated and **the gesture does not survive a
`runtime.sendMessage` hop into the worker** (measured — see
`scripts/ext-dock-gesture-proof.mjs`). So `shell.js` opens the panel itself,
inside the click, and the worker only removes the now-redundant pop-out window
afterwards. Anything calling `requestDock()` must do so synchronously from a
user gesture.

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
## Brand assets (PIXEL-O, 2026-09-16)

Every brand file here is **generated**, never hand-edited. Rebuild with
`bun scripts/build-brand-lockup.ts` from the repo root; it cuts all of them out
of the official artwork (`public/brand/computercaller-icon-transparent.png`,
`public/brand/computercaller-icon-square.png`, `marketing/store/app-icon-512.png`)
and writes the web, extension and Android copies in one pass.

- `lockup-inline.svg` — the header cut: mark left, wordmark right. Painted by
  `#cc-shell-header .cc-lockup`.
- `lockup.svg` — the official STACKED composition, for the signed-out hero.
- `mark.svg` — the mark alone.
- `icon16/32/48/128.png` — the toolbar/notification/side-panel-title icons, cut
  from `marketing/store/app-icon-512.png`. Chrome also draws `icon16` in the
  side panel's own title bar, which is why it had to change with the rest.

They live **inside** the extension because an MV3 page declares no
`content_security_policy`, so the default `img-src 'self'` applies and nothing
from computercaller.com will load. Each SVG carries its own
`prefers-color-scheme` block: a background-image SVG is a separate document and
`shell.css` cannot reach into it.

What was here before — `mark-mini.svg` and a redrawn `lockup.svg` — was a mark
this repo drew (a green rounded tile with a handset). Dennis rejected it on
2026-09-16: *"our official logo is not on the the extension either"*. Do not
reintroduce a drawn mark.

## Load unpacked (dev)

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Click the toolbar icon — it opens the **side panel**. Sign in there (the
   login is embedded in the panel; it sets the cookie and hands the SW its token).
3. Proof harnesses: `node scripts/ext-badge-sidepanel-proof.mjs`,
   `ext-indicator-proof.mjs`, `ext-dock-gesture-proof.mjs`,
   `ext-sw-lifetime-proof.mjs`. They need Playwright's BUNDLED Chromium —
   branded Chrome 137+ refuses `--load-extension` under automation.

Note: local dev over `http://localhost` cannot use `SameSite=None` cookies — test
the iframe against the deployed HTTPS origin, or rely on the token-handoff path.

## Icon sources

The SVG masters for the extension marks live in `design/extension-marks/` (outside this
folder on purpose). Chrome refuses to load an unpacked extension that contains any file or
directory whose name starts with `_`, and nothing here may be `_`-prefixed. Run
`bash tools/check-extension.sh` to verify.
