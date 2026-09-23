# WEB-HEADER-PLAIN — before/after provenance

Dennis 2026-09-23 08:55Z: "Webapp topbar plain."

- `before/app-1280-light.png` — /app rendered from the **c55b963** source of
  `app/globals.css` + `components/AppShell.tsx` (checked out into the live dev
  server and re-rendered; a fresh capture, not a reused artifact).
  Measured live: `.cc-app-header` background `rgb(220,225,234)` = `#dce1ea`,
  border-bottom `rgb(194,202,216)` = `#c2cad8`.
- `after/app-1280-light.png` — the branch tip.
  Measured live: background `rgb(255,255,255)` = `#ffffff`,
  border-bottom `rgb(226,232,240)` = `#e2e8f0` (slate-200).

Both 1280x800, deviceScaleFactor 1, `colorScheme: 'light'`, real signed
session against the ccpix scratch database — nothing stubbed.

**Dark: N/A.** /app is light-only by design (header-dispatch D4): there is no
`prefers-color-scheme` or `data-theme` branch in `app/globals.css`,
`app/layout.tsx` or `components/AppShell.tsx`, so a dark /app surface does not
exist to photograph. No dark theme was invented for this dispatch.
