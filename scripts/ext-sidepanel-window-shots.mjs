/**
 * EXT-FRAME-2 — evidence taken in the REAL Chrome side panel, with Chrome's
 * own side-panel title bar IN FRAME.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/ext-sidepanel-shots.mjs` L17 states the constraint plainly:
 * "chrome.sidePanel's own window is browser chrome and cannot be captured by
 * Playwright at all." Every extension screenshot approved since 2026-09-16
 * (`e2e-ui-proof.mjs` a-ext-menu-*, `ext-layering-shots.mjs`,
 * `ext-text-size-proof.mjs`) therefore opens `/extension` or `sidepanel.html`
 * as a PAGE. That is a faithful capture of our document and a useless capture
 * of the thing Dennis actually looks at, because the row directly above our
 * header — Chrome's grey strip carrying the extension icon and the manifest
 * `name` — is never in the picture.
 *
 * R-CH (2026-09-22 16:06Z): Dennis looked at the EXT-FRAME-2 ladder in prod and
 * asked for the previous palette back ("i dont like this grey tone"). The
 * dL* floors at the bottom of this file are therefore re-pinned to the RESTORED
 * ladder's reality (bar->header >= 8, header->body >= 6, bar->body >= 2) rather
 * than to EXT-FRAME-2's 12/6/8 target, which is closed as Dennis-overridden.
 * The harness itself is unchanged and still the only way to see Chrome's bar.
 *
 * The original finding, kept because it is still true: our dark header L0
 * #28292c (L* 16.6) sits
 * 9 L* from Chrome's bar #3c3c3c (L* 25.3) and repeated the word
 * "ComputerCaller" directly under a bar that already said it. In a page
 * screenshot that looks fine. In the side panel it reads as one grey slab with
 * the name twice, which is the complaint (Discord 2026-09-22 08:18Z).
 *
 * So this harness photographs the OS window instead of the DOM:
 *   1. a tmp copy of chrome-extension/ pointed at the local dev server
 *      (same trick as ext-sidepanel-shots.mjs L36-43);
 *   2. a REAL minted session cookie rather than a per-page fetch stub — the
 *      side panel is not a Playwright page, so there is nothing to inject
 *      into. `ctx.addCookies()` is context-wide and the panel's iframe picks
 *      it up on its own /api/auth/me. Same signer path as e2e-ui-proof.mjs;
 *   3. `chrome.sidePanel.open()` called from an extension page under a REAL
 *      trusted Playwright click — the gesture the API actually requires;
 *   4. PrintWindow(PW_RENDERFULLCONTENT) on the HWND of a process THIS script
 *      spawned, resolved by PID (scripts/lib/win-capture.ps1, protocol rule
 *      25) — never CopyFromScreen, which photographs the desktop; then the
 *      panel column is FOUND in the bitmap (scanrow/scancol walk in from the
 *      right edge) rather than guessed from Chrome frame metrics;
 *   5. the three shades — Chrome's bar, our header L0, our body — sampled from
 *      that same bitmap and asserted against the dispatch's ΔL* floors.
 *
 * That last step is the point: it turns "the frame doesn't stand out" from a
 * matter of taste into a number a gate can fail on.
 *
 * Usage:
 *   node scripts/ext-sidepanel-window-shots.mjs --theme dark --out <dir>
 *   node scripts/ext-sidepanel-window-shots.mjs --theme light --out <dir>
 *
 * Env: DATABASE_URL, JWT_SECRET (.env.local), CC_SHOT_EMAIL, DEV_URL.
 */
import { chromium } from 'playwright';
import { Reaper } from './lib/reap.mjs';
import { exitAfterFlush } from './lib/finish.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PS1 = path.join(HERE, 'lib', 'win-capture.ps1');

// ---- args -----------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const THEME = arg('theme', 'dark');
if (THEME !== 'light' && THEME !== 'dark') throw new Error('--theme must be light|dark');
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'screenshots')));
const DEV = process.env.DEV_URL || process.env.CC_BASE_URL || 'http://localhost:3123';
const PANEL_W = Number(arg('panel-width', '400'));
// A colour nothing in Chrome's UI or in our panel uses, painted on the tab
// beside the panel so the panel's edge can be found in the bitmap exactly.
const MARKER = '#ff00ff';
fs.mkdirSync(OUT, { recursive: true });

// CC_SHOT_EMAIL is REQUIRED (dispatch forge/w-strip-email-literals): the
// personal address that used to be the default was a repo literal.
const EMAIL = process.env.CC_SHOT_EMAIL;
if (!EMAIL) throw new Error('CC_SHOT_EMAIL must be set (screenshot account email)');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/**
 * minChecks floor, same contract as the other harnesses: a run reporting fewer
 * means assertions stopped executing, which a bare "N/N passed" hides.
 * 6 fixed (panel located, bar found, header found, body found, shot written,
 * popup shot written) + 5 measurements asserted.
 */
export const MIN_CHECKS = 11;

// ---- CIE L* + WCAG, the two numbers this harness exists to produce ---------
const chan = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const relLum = (hex) => { const [r, g, b] = rgb(hex).map(chan); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const lstar = (hex) => { const y = relLum(hex); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };
const dL = (a, b) => Math.abs(lstar(a) - lstar(b));

// ---- PowerShell bridge ----------------------------------------------------
const ps = (...args) => execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
).trim();
const psJson = (...args) => JSON.parse(ps(...args));

// ---- extension copy, pointed at the dev server ----------------------------
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-frame2-ext-'));
fs.cpSync(path.join(REPO, 'chrome-extension'), EXT, { recursive: true });
fs.writeFileSync(
  path.join(EXT, 'config.js'),
  fs.readFileSync(path.join(EXT, 'config.js'), 'utf8')
    .replaceAll('https://computercaller.com', DEV)
    .replace('wss://', 'ws://'),
);
// host_permissions must follow config.js to the dev origin or the shell's own
// /api/auth/me probe is blocked and the panel paints the SIGNED-OUT shell —
// which is a different header (#cc-shell-header) from the one under test.
// Same patch ext-text-size-proof.mjs makes, and on the tmp copy only: the
// repo's manifest.json is never touched by this harness.
{
  const mfPath = path.join(EXT, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions = [`${DEV}/*`];
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}

// ---- a REAL session, minted the way e2e-ui-proof.mjs mints one ------------
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const dbUser = await db.user.findFirst({
  where: { email: EMAIL },
  select: { id: true, email: true, sessionVersion: true },
});
await db.$disconnect();
if (!dbUser) throw new Error(`no user ${EMAIL} to mint a session for`);
const COOKIE_HOST = new URL(DEV).hostname;
const SESSION_COOKIES = [
  {
    name: 'auth_token',
    value: jwt.sign(
      { userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0, purpose: 'access' },
      process.env.JWT_SECRET, { expiresIn: '30d' },
    ),
    domain: COOKIE_HOST, path: '/', httpOnly: true, secure: true, sameSite: 'None',
  },
  {
    name: 'idle_token',
    value: jwt.sign({ userId: dbUser.id, purpose: 'idle' }, process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: 4 * 60 * 60 }),
    domain: COOKIE_HOST, path: '/', httpOnly: true, secure: true, sameSite: 'None',
  },
];
// SameSite=None + Secure, not the Lax the /app harnesses use. The shell's
// /api/auth/me probe is issued from a chrome-extension:// origin, so it is
// cross-site by definition and a Lax cookie is simply not sent — the panel
// then paints the SIGNED-OUT shell and the header under test never renders.
// Chrome treats http://localhost as a trustworthy origin, so Secure is honoured
// here without TLS.

// ---- Chrome's OWN UI theme -------------------------------------------------
// Two different mechanisms, because they are two different settings:
//   * --force-dark-mode flips Chrome's native UI (the side-panel strip) dark.
//     On Windows this is the flag that works; there is no --force-light-mode,
//     so light is the absence of it PLUS the profile pref below.
//   * browser.theme.color_scheme (0 system / 1 light / 2 dark) is the GM3
//     "Appearance" pref. Written into Default/Preferences before first launch
//     so Chrome reads it at startup rather than being toggled afterwards.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-frame2-profile-'));
fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
fs.writeFileSync(
  path.join(userDataDir, 'Default', 'Preferences'),
  // side_panel.width is Chrome's remembered panel width, in DIP. A fresh
  // profile opens the panel far narrower than the 400 px Dennis runs it at,
  // and a 130 px panel is not evidence about a 400 px one, so it is pinned
  // here rather than left to the profile default.
  JSON.stringify({
    browser: { theme: { color_scheme: THEME === 'dark' ? 2 : 1 } },
    side_panel: { width: PANEL_W + 140 },
  }),
);

const reaper = new Reaper().installExitHook('ext-sidepanel-window-shots');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--window-size=1900,1150',
    '--force-device-scale-factor=1',
    '--window-position=40,40',
    ...(THEME === 'dark' ? ['--force-dark-mode'] : []),
  ],
  ignoreDefaultArgs: ['--disable-extensions'],
  viewport: null,
});
const browserPids = reaper.adoptBrowser(beforeLaunch);
if (!browserPids.length) throw new Error('could not identify the Chromium browser PID to photograph');
// STRICT parentage, asserted rather than assumed. adoptBrowser has a fallback
// that matches on process NAME when the parentage lookup comes up empty, and a
// name match on this box would happily select the operator's own chrome.exe.
// Nothing is ever photographed unless its parent is this very node process.
{
  const ppidOf = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${browserPids[0]}").ParentProcessId`],
  { encoding: 'utf8' }).trim();
  if (Number(ppidOf) !== process.pid) {
    throw new Error(`refusing to photograph PID ${browserPids[0]}: its parent is ${ppidOf}, not this harness (${process.pid})`);
  }
}

/** Walk a scanline of "rrggbb rrggbb …" into an array of #rrggbb. */
const scan = (line) => line.split(/\s+/).filter(Boolean).map((h) => `#${h}`);
/** Perceptual-enough sameness for finding band boundaries in a screenshot. */
const near = (a, b, tol = 6) => {
  const [ar, ag, ab] = rgb(a); const [br, bg, bb] = rgb(b);
  return Math.abs(ar - br) <= tol && Math.abs(ag - bg) <= tol && Math.abs(ab - bb) <= tol;
};
/** The most common colour in a slice — a band's fill, ignoring text pixels. */
const modal = (arr) => {
  const n = new Map();
  for (const c of arr) n.set(c, (n.get(c) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const measurements = {};

try {
  await ctx.addCookies(SESSION_COOKIES);

  // ctx.serviceWorkers() lists only RUNNING workers, so a registered-but-idle
  // MV3 worker reads as "never registered". Wait for it, then poke an extension
  // page to be sure it is awake before we talk to it over CDP.
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 60 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sw = ctx.serviceWorkers()[0];
  }
  if (!sw) throw new Error('extension service worker never appeared');
  const EXT_ID = new URL(sw.url()).host;
  const waker = await ctx.newPage();
  await waker.goto(`chrome-extension://${EXT_ID}/sidepanel.html`).catch(() => {});
  await waker.waitForTimeout(1500);
  await waker.close().catch(() => {});

  // Our panel's OWN theme, set explicitly to the same theme as Chrome's UI.
  // System would let the two disagree and the evidence would be unreadable.
  await sw.evaluate(async (t) => {
    await chrome.storage.local.set({ cc_theme: t });
  }, THEME);

  // ONE window, ONE tab, for the whole run. Chromium's persistent context
  // opens a first page of its own and may open more (a profile sign-in tab
  // among them); every extra page risks being an extra WINDOW, and the one we
  // photograph is then not the one holding the panel. Close the strays and
  // keep a single tab we drive by hand.
  const tab = ctx.pages()[0] || await ctx.newPage();
  for (const p of ctx.pages()) if (p !== tab) await p.close().catch(() => {});

  // --- open the side panel -------------------------------------------------
  // The dispatch's method (a) — chrome.sidePanel.open() over CDP with
  // userGesture:true on the service-worker target — is NOT reachable from
  // Playwright: ctx.newCDPSession() accepts a Page or Frame only and throws
  // "expected Page or Frame" on a Worker, so the userGesture bit cannot be set
  // on the worker at all. Recorded as tried-and-failed, not skipped.
  //
  // What works, and is strictly better evidence: an extension PAGE opened in a
  // tab, with a real trusted click. Playwright's click is genuine OS-level
  // input, so chrome.sidePanel.open() sees the gesture it actually wants, and
  // the call runs in the extension's own context rather than through an
  // injected debugger. No manifest is touched — neither the repo's nor the
  // tmp copy's — which is what rules (b) out anyway.
  let opener = null;
  let openDetail = '';
  // The panel's theme is the HOSTED app's decision, read from
  // localStorage['cc:theme:last'] on the webapp origin before first paint
  // (the THEME_BOOT_SCRIPT path ext-layering-shots.mjs drives). chrome.storage
  // only themes the SHELL. localStorage is per-origin and shared across the
  // profile, so writing it from an ordinary tab is enough — and it has to
  // happen before the panel opens, or the panel paints the other theme.
  const opnr = tab;
  await opnr.goto(`${DEV}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await opnr.evaluate((t) => { try { localStorage.setItem('cc:theme:last', t); } catch {} }, THEME);
  await opnr.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await opnr.waitForTimeout(800);
  await opnr.evaluate(() => {
    const b = document.createElement('button');
    b.id = '__cc_open_panel';
    b.textContent = 'open panel';
    b.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:2147483647;width:240px;height:64px';
    b.addEventListener('click', async () => {
      try {
        const w = await chrome.windows.getLastFocused();
        await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
        await chrome.sidePanel.open({ windowId: w.id });
        b.dataset.ccResult = 'ok';
      } catch (e) {
        b.dataset.ccResult = 'err:' + (e && e.message ? e.message : String(e));
      }
    });
    document.body.appendChild(b);
  });
  await opnr.click('#__cc_open_panel');
  for (let i = 0; i < 40 && !openDetail; i++) {
    openDetail = await opnr.evaluate(() => document.getElementById('__cc_open_panel')?.dataset.ccResult || '');
    if (!openDetail) await opnr.waitForTimeout(250);
  }
  if (openDetail === 'ok') opener = 'trusted-click';
  check('sidepanel-open', Boolean(opener),
    opener
      ? 'method (a) unreachable (newCDPSession rejects a Worker); opened by a trusted Playwright click inside popup.html'
      : `all methods failed: ${openDetail || 'no result'} — see docs/EXT-SIDEPANEL-CAPTURE.md`);
  if (!opener) throw new Error('side panel did not open — see docs/EXT-SIDEPANEL-CAPTURE.md');
  measurements.openMethod = opener;
  // The panel belongs to this WINDOW, so the tab that opened it must not be
  // closed — closing the last tab closes the window and takes the panel with
  // it (measured: the capture then photographed a stray profile-sign-in
  // window instead). Navigate it to the app and keep it.
  // The tab beside the panel is painted ONE known colour on purpose — see the
  // locator below. Its content is not evidence; only the panel column is.
  await opnr.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await opnr.evaluate((c) => {
    document.documentElement.style.cssText = `background:${c};height:100%;color-scheme:light`;
    document.body.style.cssText = `background:${c};margin:0;height:100%`;
  }, MARKER);
  await opnr.waitForTimeout(800);

  await tab.waitForTimeout(4000);   // panel iframe: shell-hello, /api/auth/me, first paint

  // --- photograph the window ----------------------------------------------
  // The root Chromium process is the one that owns MainWindowHandle; the
  // reaper already identified it by parentage, so no name matching here either.
  const pid = browserPids[0];
  const full = path.join(OUT, `_full-${THEME}.png`);
  // NOTE ON PANEL WIDTH: Chrome opens the side panel at its own default, which
  // measures 378 CSS px on this box, and the width is not settable from the
  // profile (side_panel.width is ignored) nor reachable by automation (the
  // panel is browser chrome; only a real mouse on its 4 px resize edge moves
  // it, which is not reliable enough to gate evidence on). 378 is reported in
  // the JSON as panelCssWidth because it MATTERS: our own wordmark-hide rule
  // fires at max-width 379 px, so at Chrome's default side-panel width the
  // wordmark is already hidden. It is visible only in a panel the user has
  // widened — which is the panel in Dennis's screenshot.
  // --force-device-scale-factor=1 keeps CSS px and device px the same number,
  // so every measurement below is directly comparable to a CSS breakpoint.
  const cap = psJson('-Action', 'capture', '-ProcessId', String(pid), '-Out', full);
  check('window-captured', cap.width > 800 && cap.height > 400, `${cap.width}x${cap.height}`);

  // --- locate the panel column ---------------------------------------------
  // Deriving the rect from window.screenX/innerWidth/devicePixelRatio does not
  // survive contact with a scaled Windows display: Chrome mixes CSS and device
  // pixels across those properties, and three separate attempts each put the
  // crop in a different wrong place (a 1249 px "panel", then 151 px, then
  // 71 px, all of them actually measuring Chrome's toolbar or the web page).
  //
  // So the tab beside the panel is painted a single unmistakable colour and
  // the boundary is READ OFF THE BITMAP: the panel starts where the marker
  // stops, and the panel's top row is the marker's top row. No pixel-ratio
  // arithmetic, no Chrome frame constants, and it is correct by construction
  // at any display scale.
  const midY = Math.round(cap.height * 0.6);
  const markRow = scan(ps('-Action', 'scanrow', '-In', full, '-Y', String(midY)));
  const isMark = (c) => near(c, MARKER, 24);
  let lastMark = -1;
  for (let i = 0; i < markRow.length; i++) if (isMark(markRow[i])) lastMark = i;
  if (lastMark < 0) {
    const uniq = [...new Set(markRow)].slice(0, 24).join(' ');
    throw new Error(`marker colour not found in the capture — row ${midY} holds: ${uniq}`);
  }
  // Skip the separator/scrollbar pixels between the marker and the panel fill.
  const panelLeft = lastMark + 4;
  const panelRight = cap.width - 6;
  const panelW = panelRight - panelLeft;

  const markCol = scan(ps('-Action', 'scancol', '-In', full, '-X', String(Math.round(lastMark / 2))));
  let panelTop = markCol.findIndex(isMark);
  if (panelTop < 0) panelTop = 0;

  measurements.panelCssWidth = panelW;
  check('panel-located', panelW >= 360 && panelW < 900 && panelTop > 0,
    `x=${panelLeft} y=${panelTop} w=${panelW} (marker ends x=${lastMark}, window ${cap.width}x${cap.height})`);

  // --- the three bands, down the panel's centre ----------------------------
  const midX = panelLeft + Math.round(panelW / 2);
  const col = scan(ps('-Action', 'scancol', '-In', full, '-X', String(midX)));
  const barTop = panelTop;
  const barSeed = col[barTop + 4];
  let y = barTop + 4;
  while (y < col.length && near(col[y], barSeed, 10)) y++;
  const headerTop = y;
  const barFill = modal(
    scan(ps('-Action', 'scanrow', '-In', full, '-Y', String(barTop + Math.round((headerTop - barTop) * 0.5))))
      .slice(panelLeft + 8, panelRight - 8),
  );
  // Chrome's bar and our header are both 40 CSS px tall, so the bar's measured
  // height IS the device-pixel scale — no devicePixelRatio needed. Fills are
  // read from inside each band rather than by walking to its edge: the header
  // carries icons and a hairline, and a walk stops at the first of those and
  // reports a 16 px "header".
  const barH = headerTop - barTop;
  // Fills are the MODAL colour of a horizontal slice across the panel, not of
  // a vertical one. A vertical sample down the panel's centre runs straight
  // through the device pill, which has its own --cc-field fill, and reported
  // #1f1f23 for a band that is #28292c. Across the row, the band itself is by
  // far the most common pixel and the controls are noise.
  const rowFill = (yy) => modal(
    scan(ps('-Action', 'scanrow', '-In', full, '-Y', String(yy))).slice(panelLeft + 8, panelRight - 8),
  );
  const headerFill = rowFill(headerTop + Math.round(barH * 0.12));
  let headerBottom = headerTop + Math.round(barH * 0.9);
  while (headerBottom < col.length && near(col[headerBottom], headerFill, 8)) headerBottom++;
  const bodyFill = rowFill(headerTop + Math.round(barH * 3.2));

  check('chrome-bar-found', headerTop - barTop >= 16 && headerTop - barTop <= 80,
    `bar ${barFill} rows ${barTop}..${headerTop} (h=${headerTop - barTop})`);
  check('our-header-found', headerBottom - headerTop >= 20 && headerBottom - headerTop <= 120,
    `header ${headerFill} rows ${headerTop}..${headerBottom} (h=${headerBottom - headerTop})`);
  check('our-body-found', /^#[0-9a-f]{6}$/.test(bodyFill), `body ${bodyFill}`);

  // --- the assertions the complaint becomes -------------------------------
  const dBarHdr = dL(barFill, headerFill);
  const dHdrBody = dL(headerFill, bodyFill);
  const dBarBody = dL(barFill, bodyFill);
  Object.assign(measurements, {
    theme: THEME,
    chromeBar: barFill, headerL0: headerFill, body: bodyFill,
    lstar: { bar: +lstar(barFill).toFixed(2), header: +lstar(headerFill).toFixed(2), body: +lstar(bodyFill).toFixed(2) },
    deltaL: { barToHeader: +dBarHdr.toFixed(2), headerToBody: +dHdrBody.toFixed(2), barToBody: +dBarBody.toFixed(2) },
    panel: { left: panelLeft, width: panelW, barTop, headerTop, headerBottom },
  });
  // R-CH floors. These are NOT a contrast goal any more — Dennis overrode the
  // >= 12 target — they are a REGRESSION FENCE around the palette he chose, so
  // that a future edit cannot quietly collapse the header into Chrome's bar or
  // into its own body without failing here. Measured on the restored ladder:
  // dark 8.72 / 6.38 / 2.34, light ~13 / ~5 / ~2.7.
  check('dL-bar-to-header>=8', dBarHdr >= 8, `${dBarHdr.toFixed(2)} (${barFill} -> ${headerFill})`);
  check('dL-header-to-body>=6', dHdrBody >= 6, `${dHdrBody.toFixed(2)} (${headerFill} -> ${bodyFill})`);
  check('dL-bar-to-body>=2', dBarBody >= 2, `${dBarBody.toFixed(2)} (${barFill} -> ${bodyFill})`);

  // --- the crop Dennis approves from --------------------------------------
  const cropH = Math.min(cap.height - barTop - 8, 640);
  const shot = path.join(OUT, `ext-sidepanel-real-${THEME}-400.png`);
  const cropped = psJson('-Action', 'crop', '-In', full, '-Out', shot,
    '-X', String(panelLeft), '-Y', String(barTop), '-W', String(panelW), '-H', String(cropH));
  check('sidepanel-shot-written', cropped.width > 200, `${shot} ${cropped.width}x${cropped.height}`);

  // --- the popup surface, for open question 1 ------------------------------
  // The toolbar popup has no bar of its own, which is why the wordmark stays
  // there. Dennis rules on that from this shot; it is a page, so Playwright
  // can take it the ordinary way.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: PANEL_W, height: 600 });
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await popup.waitForTimeout(4000);
  const popupShot = path.join(OUT, `ext-sidepanel-real-popup-${THEME}.png`);
  await popup.screenshot({ path: popupShot });
  await popup.close().catch(() => {});
  check('popup-shot-written', fs.existsSync(popupShot) && fs.statSync(popupShot).size > 4000,
    `${popupShot} ${fs.existsSync(popupShot) ? fs.statSync(popupShot).size : 0} B`);

  fs.writeFileSync(
    path.join(OUT, `ext-sidepanel-real-${THEME}.json`),
    JSON.stringify({ ...measurements, checks: results }, null, 2),
  );
  console.log(`full window capture kept at ${full}`);
} finally {
  await ctx.close().catch(() => {});
  reaper.reapAndReport('ext-sidepanel-window-shots');
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed  (floor ${MIN_CHECKS})`);
console.log(JSON.stringify(measurements, null, 2));
exitAfterFlush(failed === 0 && results.length >= MIN_CHECKS ? 0 : 1);
