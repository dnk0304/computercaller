#!/usr/bin/env node
/**
 * ext-composer-resize-proof.mjs — the composer's height, both halves of it.
 *
 * Dennis, 2026-09-23 11:06: "in the extension, when i now write a message, the
 * text field expands, i want it to expand 20% more. Or is it possible to make
 * it so user can drag to expand it and it gets saved in his settings (that i
 * remembers it)?" Niki answered: both. So this proves both.
 *
 *   A1  the derived auto-grow cap moved +20% on every term:
 *       clamp(96, h*0.4, 168)  ->  clamp(115, h*0.48, 202)
 *   A2  a drag handle on the composer's top edge whose height is remembered
 *       per account, with a keyboard equivalent and live DOM bounds
 *
 * MODELLED ON scripts/ext-text-size-proof.mjs, including its two load-bearing
 * habits: the module under test is read (and here transpiled) at RUN TIME
 * rather than copied — a copy keeps passing after the original changes — and
 * the page is stubbed at the network boundary (fetch + WebSocket) so no DB row
 * and no relay are required to render a thread.
 *
 * WHY A TRANSPILE ARM AT ALL, instead of asserting everything through the
 * page: the per-account keying cannot be exercised from a bare /extension tab.
 * The account reaches the app through the extension shell's `shell-hello`
 * postMessage, and a bare page has no shell, so the component legitimately
 * sees email=null and only ever touches the anon key. Driving the real
 * exported functions directly is the only way to test two emails that is not
 * really testing the harness.
 *
 *   PREREQ:  a PRODUCTION server on CC_BASE_URL (default http://localhost:3123):
 *              bun run build && NODE_ENV=production PORT=3123 node server.js
 *            NODE_ENV=production is not a nicety. In dev, Next's bundles eval
 *            their source maps, the app's own CSP (script-src 'self'
 *            'unsafe-inline') refuses it, React never hydrates, and the page
 *            serves as inert HTML — every click succeeds and does nothing, so
 *            a harness pointed at a dev server fails with a selector timeout
 *            and lies to you about which selector is wrong.
 *   RUN:     node scripts/ext-composer-resize-proof.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
);
const BASE = process.env.CC_BASE_URL || 'http://localhost:3123';
const SHOTS = process.env.CC_SHOTS || path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/** A FLOOR, not a target: a run that skipped arms must fail, not pass quietly. */
export const MIN_CHECKS = 58;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** The A1 formula, restated here ON PURPOSE so the harness has its own copy to
 *  disagree with the module about. A harness that imports the number it is
 *  checking proves only that a variable equals itself. */
const expectedCap = (h) => Math.max(115, Math.min(202, Math.round(h * 0.48)));
const MIN_PX = 36;

/**
 * OPT-IN EVIDENCE ARM (deliverable A4). Unset — which is how the gate runs
 * this file — SHOTS_MODE is false and the harness behaves EXACTLY as before:
 * same arms, same checks, same floor. Set to '1' it runs ONE thing instead:
 * the real-Chrome-side-panel photographs, and exits. Nothing is shared with
 * the gate path except the page-driving helpers below.
 */
const SHOTS_MODE = process.env.CC_SIDEPANEL_SHOTS === '1';

// ===========================================================================
// A) THE MODULE — transpiled from the real .ts at run time and imported.
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-composer-proof-'));
// Skipped in SHOTS_MODE on purpose: the BEFORE pass photographs a tree where
// lib/extensionComposerHeight.ts DOES NOT EXIST yet, so transpiling it would
// throw before a single pixel was taken.
if (!SHOTS_MODE) {
  const src = path.join(REPO, 'lib', 'extensionComposerHeight.ts');
  // `node <tsc's JS entry>`, not the .bin shim: spawning a .cmd without a
  // shell is EINVAL on Node >= 20 on Windows, and spawning it WITH a shell is
  // a quoting hazard for no benefit.
  execFileSync(
    process.execPath,
    [
      path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'),
      src, '--outDir', TMP,
      '--target', 'es2020', '--module', 'es2020', '--moduleResolution', 'bundler', '--skipLibCheck',
    ],
    { stdio: 'pipe' },
  );
  const mod = await import(pathToFileURL(path.join(TMP, 'extensionComposerHeight.js')).href);

  check('COMPOSER_MIN_PX is still 36 — one line, untouched by this dispatch', mod.COMPOSER_MIN_PX === MIN_PX, String(mod.COMPOSER_MIN_PX));
  check('autoCapFor(560) = 202 — the +20% ceiling in a 560px panel', mod.autoCapFor(560) === 202, String(mod.autoCapFor(560)));
  check('autoCapFor(400) = 192 — the A1 formula, neither clamp engaged', mod.autoCapFor(400) === expectedCap(400) && mod.autoCapFor(400) === 192, String(mod.autoCapFor(400)));
  check('autoCapFor(200) = 115 — the +20% FLOOR in a short pop-out', mod.autoCapFor(200) === 115, String(mod.autoCapFor(200)));
  check('autoCapFor(1400) = 202 — the ceiling holds on a tall window', mod.autoCapFor(1400) === 202, String(mod.autoCapFor(1400)));
  check('autoCapFor(NaN) falls back to the 560px panel, not to NaN', mod.autoCapFor(Number.NaN) === 202, String(mod.autoCapFor(Number.NaN)));
  check(
    'every derived cap is exactly 1.2x the 2026-09-16 cap it replaces',
    [360, 400, 560, 900].every((h) => {
      const old = Math.max(96, Math.min(168, Math.round(h * 0.4)));
      return mod.autoCapFor(h) === Math.max(115, Math.min(202, Math.round(h * 0.48))) && mod.autoCapFor(h) > old;
    }),
  );

  // A localStorage stand-in. The functions are the shipped ones; only the
  // storage under them is local, which is the only part a node process lacks.
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };

  const A = 'alice@computercaller.com';
  const B = 'bob@computercaller.com';
  mod.writeStoredHeight(A, 120);
  mod.writeStoredHeight(B, 200);
  check('per-account isolation — two emails keep two heights', mod.readStoredHeight(A) === 120 && mod.readStoredHeight(B) === 200, `${mod.readStoredHeight(A)} / ${mod.readStoredHeight(B)}`);
  check('the keys are the text-size plumbing, per email', store.has(`cc:composer:${A}`) && store.has(`cc:composer:${B}`) && store.has('cc:composer:last'), [...store.keys()].join(','));
  check('the key is case-folded, as cc:size: is', mod.readStoredHeight('ALICE@ComputerCaller.com') === 120);
  check('an unknown account reads null, not the last account\'s height', mod.readStoredHeight('nobody@computercaller.com') === null);
  check('no email at all is the anon key, not a crash', mod.readStoredHeight(null) === null);

  store.set(`cc:composer:${A}`, 'not-a-number');
  check('a non-numeric record is ignored, not coerced', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '10');
  check('a record below the 36px minimum is ignored', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '99999');
  check('an absurd record is ignored rather than filling the panel', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '148.7');
  check('a fractional record is read as whole px', mod.readStoredHeight(A) === 148);

  mod.writeStoredHeight(A, 150);
  mod.clearStoredHeight(A);
  check('clearStoredHeight returns that account to auto', mod.readStoredHeight(A) === null && mod.readStoredHeight(B) === 200);

  check('clampHeight rounds and clamps in one place', mod.clampHeight(1e4, 36, 202) === 202 && mod.clampHeight(-5, 36, 202) === 36 && mod.clampHeight(90.6, 36, 202) === 91 && mod.clampHeight(Number.NaN, 36, 202) === 36);

  delete globalThis.window;

  // The component must go THROUGH the module. A second hardcoded 0.4 in
  // PhoneModeShell is exactly how the two would drift apart.
  const shellSrc = fs.readFileSync(path.join(REPO, 'components', 'PhoneModeShell.tsx'), 'utf8');
  const autosizeBody = shellSrc.slice(shellSrc.indexOf('function autosize('), shellSrc.indexOf('function formatHmm('));
  check('autosize() derives its cap from autoCapFor, with no second formula', /autoCapFor\(viewport\)/.test(autosizeBody) && !/0\.4\b/.test(autosizeBody) && !/\b168\b/.test(autosizeBody));
  check('the 2026-09-16 comment block survived the edit', /if the message is big\n \* i cannot see it/.test(shellSrc) || /if the message is big/.test(shellSrc));
  check('lib/extensionComposerHeight.ts ships no boot script (the composer is not first paint)', !/BOOT_SCRIPT/.test(fs.readFileSync(path.join(REPO, 'lib', 'extensionComposerHeight.ts'), 'utf8')));

  // /app, by construction rather than by promise.
  const gitOut = execFileSync('git', ['diff', '--name-only', 'origin/e2e/integration', '--', 'components/Dashboard.tsx'], { cwd: REPO, encoding: 'utf8' }).trim();
  check('components/Dashboard.tsx — /app\'s own composer — is byte-identical to base', gitOut === '', gitOut || 'unchanged');
  const css = fs.readFileSync(path.join(REPO, 'app', 'extension', 'extension.css'), 'utf8');
  const gripRules = css.split('\n').filter((l) => /cc-composer-grip/.test(l) && /^\s*[.:@]/.test(l));
  check('every composer-grip rule is scoped under .cc-ext, so /app cannot match one', gripRules.length > 0 && gripRules.every((l) => l.includes('.cc-ext')), `${gripRules.length} selectors`);
  check('--cc-grip is defined in BOTH themes', /--cc-grip:\s*#86868c/.test(css) && /--cc-grip:\s*#72727a/.test(css));
}

// ===========================================================================
// B) THE SURFACE.
// ===========================================================================
const now = Date.now();
const MIN = 60_000;
const contacts = [
  { id: 'k1', name: 'Marta Ruiz', number: '+4745720075' },
  { id: 'k2', name: 'Ola Nordmann', number: '+4791827364' },
];
const messages = [
  { id: 'm1', address: '+4745720075', body: 'Ringte deg nettopp — ta den når du kan.', date: now - 7 * MIN, type: 'inbox', read: true },
  { id: 'm2', address: '+4745720075', body: 'Og send meg adressen når du vet den.', date: now - 6 * MIN, type: 'inbox', read: true },
  { id: 'm3', address: '+4745720075', body: 'Ja, gjør det.', date: now - 5 * MIN, type: 'sent', read: true },
  { id: 'm4', address: '+4745720075', body: 'Takk!', date: now - 4 * MIN, type: 'inbox', read: true },
  { id: 'm5', address: '+4791827364', body: 'Sounds good, see you at six.', date: now - 55 * MIN, type: 'inbox', read: true },
];
const FRAMES = [
  ['LOBBY_STATUS', { phonePresent: true }],
  ['PAIRING_ACTIVE', { deviceName: 'Samsung Galaxy S24 Ultra' }],
  ['SIM_LIST', { sims: [{ id: 1, slot: 0, name: 'Telia', number: '+4745720075' }] }],
  ['STATUS', { connected: true, battery: 82, signal: 4 }],
  ['CONTACTS', { contacts }],
  ['MESSAGES', { messages }],
  ['CALL_LOGS', { callLogs: [] }],
];

/** @param {{size?:string, theme?:string, height?:number|null, email?:string}} o */
const bootScript = (o) => `
(() => {
  try {
    localStorage.setItem('cc:theme:last', ${JSON.stringify(o.theme || 'light')});
    localStorage.setItem('cc:size:last', ${JSON.stringify(o.size || 'medium')});
    localStorage.setItem('cc:size:anon', ${JSON.stringify(o.size || 'medium')});
    ${o.height != null ? `localStorage.setItem('cc:composer:anon', ${JSON.stringify(String(o.height))});` : ''}
  } catch (e) {}
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/auth/relay-ticket')) {
      return Promise.resolve(new Response(JSON.stringify({ ticket: 'stub-ticket' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
  const FRAMES = ${JSON.stringify(FRAMES)};
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({});
        let t = 40;
        for (const [type, payload] of FRAMES) {
          setTimeout(() => { this.onmessage && this.onmessage({ data: type + ':' + JSON.stringify(payload) }); }, t);
          t += 25;
        }
      }, 30);
    }
    send() {}
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason: 'stub' }); }
    addEventListener(ev, fn) { this['on' + ev] = fn; }
    removeEventListener(ev) { this['on' + ev] = null; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
})();
`;

const settle = async (page, ms = 600) => {
  const x = page.locator('.cc-toast button').last();
  for (let i = 0; i < 4 && (await x.count()); i += 1) {
    await x.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(ms);
};

/** Texts tab -> the Marta Ruiz thread -> the composer. */
const openThread = async (page) => {
  await page.getByRole('tab', { name: /texts/i }).click({ timeout: 8000 }).catch(() => {});
  await settle(page, 900);
  await page.getByRole('button', { name: /Marta Ruiz|Takk!|\+4745720075/ }).first().click({ timeout: 8000 }).catch(() => {});
  await settle(page, 900);
  await page.locator('textarea[aria-label="Message body"]').waitFor({ timeout: 15_000 });
};

const taHeight = (page) =>
  page.locator('textarea[aria-label="Message body"]').evaluate((el) => Math.round(el.getBoundingClientRect().height));
const grip = (page) => page.locator('[data-cc-composer-grip]');

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long message that has to wrap`).join('\n');

// ===========================================================================
// A4) THE OPT-IN SIDE-PANEL EVIDENCE ARM  (CC_SIDEPANEL_SHOTS=1)
// ===========================================================================
// WHY THE LAUNCH RECIPE IS DUPLICATED FROM ext-sidepanel-window-shots.mjs
// RATHER THAN IMPORTED — deliberate, do not "fix" it:
// this lane's gate runs a scope-diff that only permits the files the dispatch
// already touched. ext-sidepanel-window-shots.mjs is NOT one of them, so
// refactoring its recipe into a shared lib (or importing from it, which would
// run its top-level side effects — it mints cookies and launches Chrome at
// import time) is out of scope for this deliverable. The copy below is the
// same recipe, line for line, kept inside a permitted file. If that harness's
// recipe changes, this copy must be re-synced by hand; that cost is accepted
// in exchange for touching nothing outside the lane.
//
// RULE 25 is preserved verbatim: capture is PrintWindow via
// scripts/lib/win-capture.ps1 on the HWND of a process THIS script spawned,
// resolved by PID, with the strict-parentage guard that throws unless
// Win32_Process ParentProcessId === process.pid. No CopyFromScreen, ever —
// the operator's own chrome.exe must never be photographed or reaped.
if (SHOTS_MODE) {
  const { Reaper } = await import('./lib/reap.mjs');
  const PS1 = path.join(REPO, 'scripts', 'lib', 'win-capture.ps1');
  const OUT_DIR = path.resolve(process.env.CC_SIDEPANEL_OUT || SHOTS);
  // 'after' = branch code, 'before' = the base-code pass (see the dispatch).
  const PHASE = process.env.CC_SIDEPANEL_PHASE === 'before' ? 'before' : 'after';
  const MARKER = '#ff00ff';
  const PANEL_W = 400;
  const CDP_PORT = Number(process.env.CC_CDP_PORT || 9333);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // .env.local, loaded the way ft-ui-proof.mjs / ext-sidepanel-window-shots.mjs
  // load it: JWT_SECRET from the file, DATABASE_URL only from the real env.
  {
    const envPath = path.join(REPO, '.env.local');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[1] !== 'DATABASE_URL' && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  const EMAIL = process.env.CC_SHOT_EMAIL;
  if (!EMAIL) throw new Error('CC_SHOT_EMAIL must be set (screenshot account email)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');

  const ps = (...a) => execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...a],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const psJson = (...a) => JSON.parse(ps(...a));
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const near = (a, b, tol = 24) => {
    const [ar, ag, ab] = rgb(a); const [br, bg, bb] = rgb(b);
    return Math.abs(ar - br) <= tol && Math.abs(ag - bg) <= tol && Math.abs(ab - bb) <= tol;
  };
  const scan = (line) => line.split(/\s+/).filter(Boolean).map((h) => `#${h}`);

  // --- the tmp extension copy, repointed at the local server ---------------
  const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-a4-ext-'));
  fs.cpSync(path.join(REPO, 'chrome-extension'), EXT, { recursive: true });
  fs.writeFileSync(path.join(EXT, 'config.js'),
    fs.readFileSync(path.join(EXT, 'config.js'), 'utf8')
      .replaceAll('https://computercaller.com', BASE).replace('wss://', 'ws://'));
  {
    const mfPath = path.join(EXT, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    mf.host_permissions = [`${BASE}/*`];
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  }

  // --- a REAL session cookie, SameSite=None + Secure ----------------------
  // The panel's iframe issues /api/auth/me from a chrome-extension:// origin,
  // which is cross-site by definition; a Lax cookie is simply not sent and the
  // shell paints SIGNED-OUT. localhost counts as trustworthy, so Secure is
  // honoured without TLS.
  const jwt = (await import('jsonwebtoken')).default;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const dbUser = await db.user.findFirst({
    where: { email: EMAIL }, select: { id: true, email: true, sessionVersion: true },
  });
  await db.$disconnect();
  if (!dbUser) throw new Error(`no user ${EMAIL} to mint a session for`);
  const COOKIE_HOST = new URL(BASE).hostname;
  const SESSION_COOKIES = [
    {
      name: 'auth_token',
      value: jwt.sign({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0, purpose: 'access' },
        process.env.JWT_SECRET, { expiresIn: '30d' }),
      domain: COOKIE_HOST, path: '/', httpOnly: true, secure: true, sameSite: 'None',
    },
    {
      name: 'idle_token',
      value: jwt.sign({ userId: dbUser.id, purpose: 'idle' }, process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: 4 * 60 * 60 }),
      domain: COOKIE_HOST, path: '/', httpOnly: true, secure: true, sameSite: 'None',
    },
  ];

  const written = [];

  for (const THEME of ['light', 'dark']) {
    // browser.theme.color_scheme themes Chrome's OWN UI (GM3 "Appearance");
    // --force-dark-mode is the Windows flag that flips the native strip. Both,
    // because they are two different settings. side_panel.width is pinned so a
    // fresh profile does not open a 130px panel.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-a4-profile-'));
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
      browser: { theme: { color_scheme: THEME === 'dark' ? 2 : 1 } },
      side_panel: { width: PANEL_W + 140 },
    }));

    let cdpBrowser = null;
    let cdpBrowser2 = null;
    const reaper = new Reaper().installExitHook('ext-composer-resize-proof:a4');
    const beforeLaunch = reaper.mark();
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--window-size=1900,1150',
        '--force-device-scale-factor=1',
        '--window-position=40,40',
        // Playwright does NOT surface the side panel in ctx.pages() (measured:
        // pages=about:blank only, backgroundPages empty) because it never
        // attaches to that target. A second client over CDP does see it — it is
        // an ordinary type:"page" target — so the panel is driven through a
        // connectOverCDP handle to the SAME browser this script spawned. No
        // extra process, and the capture PID is still the spawned one.
        `--remote-debugging-port=${CDP_PORT}`,
        ...(THEME === 'dark' ? ['--force-dark-mode'] : []),
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
      viewport: null,
    });
    const browserPids = reaper.adoptBrowser(beforeLaunch);
    if (!browserPids.length) throw new Error('could not identify the Chromium browser PID to photograph');
    {
      const ppidOf = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${browserPids[0]}").ParentProcessId`],
      { encoding: 'utf8' }).trim();
      if (Number(ppidOf) !== process.pid) {
        throw new Error(`refusing to photograph PID ${browserPids[0]}: its parent is ${ppidOf}, not this harness (${process.pid})`);
      }
    }

    try {
      await ctx.addCookies(SESSION_COOKIES);
      // The SAME network stub the gate arms use, installed context-wide so the
      // panel's /extension iframe gets it too. The cookie above proves the real
      // signed-in shell renders; the stub supplies the CONVERSATION, which
      // otherwise requires a physically paired handset on the relay. The pixels
      // under test are the composer's, and those are ours either way.
      await ctx.addInitScript(bootScript({ theme: THEME }));
      // The side panel is NOT a page of `ctx` (Playwright never attaches to
      // that target), so ctx.addInitScript does not reach the panel's iframe.
      // Connect the second CDP client HERE — before the panel is opened — and
      // install the same stub on its context, which does cover the panel.
      cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      for (const c of cdpBrowser.contexts()) await c.addInitScript(bootScript({ theme: THEME }));

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
      await sw.evaluate(async (t) => { await chrome.storage.local.set({ cc_theme: t }); }, THEME);

      const tab = ctx.pages()[0] || await ctx.newPage();
      for (const p of ctx.pages()) if (p !== tab) await p.close().catch(() => {});

      // localStorage['cc:theme:last'] on the APP origin, before the panel
      // opens — the hosted app reads it before first paint. (bootScript also
      // writes it, but only once a page on that origin has loaded, so visit it.)
      await tab.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await tab.evaluate((t) => { try { localStorage.setItem('cc:theme:last', t); } catch {} }, THEME);

      // The trusted-click open: chrome.sidePanel.open() needs a real user
      // gesture, and Playwright's click is genuine OS-level input.
      await tab.goto(`chrome-extension://${EXT_ID}/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await tab.waitForTimeout(800);
      await tab.evaluate(() => {
        const b = document.createElement('button');
        b.id = '__cc_open_panel';
        b.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:2147483647;width:240px;height:64px';
        b.addEventListener('click', async () => {
          try {
            const w = await chrome.windows.getLastFocused();
            await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
            await chrome.sidePanel.open({ windowId: w.id });
            b.dataset.ccResult = 'ok';
          } catch (e) { b.dataset.ccResult = 'err:' + (e && e.message ? e.message : String(e)); }
        });
        document.body.appendChild(b);
      });
      await tab.click('#__cc_open_panel');
      let openDetail = '';
      for (let i = 0; i < 40 && !openDetail; i++) {
        openDetail = await tab.evaluate(() => document.getElementById('__cc_open_panel')?.dataset.ccResult || '');
        if (!openDetail) await tab.waitForTimeout(250);
      }
      if (openDetail !== 'ok') throw new Error(`side panel did not open: ${openDetail || 'no result'}`);

      // The opener tab MUST stay alive — closing the last tab closes the window
      // and takes the panel with it. It is painted one impossible colour so the
      // panel's left edge can be READ OFF THE BITMAP instead of guessed from
      // Chrome frame metrics.
      await tab.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await tab.evaluate((c) => {
        document.documentElement.style.cssText = `background:${c};height:100%;color-scheme:light`;
        document.body.style.cssText = `background:${c};margin:0;height:100%`;
      }, MARKER);
      await tab.waitForTimeout(5000);

      // --- the panel page and its inner app frame --------------------------
      // A SECOND, later CDP client purely for discovery: the first one was
      // connected before the panel existed and does not surface the target
      // that appeared after it. A fresh connect enumerates what is there now.
      cdpBrowser2 = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const allPages = () => cdpBrowser2.contexts().flatMap((c) => c.pages());
      let panel = null;
      for (let i = 0; i < 40 && !panel; i++) {
        panel = allPages().find((p) => p.url().includes(`${EXT_ID}/sidepanel.html`)) || null;
        if (!panel) await tab.waitForTimeout(250);
      }
      if (!panel) {
        throw new Error('side-panel page target never appeared in ctx.pages(); pages=' +
          allPages().map((p) => p.url()).join(' | '));
      }
      // The panel's /extension iframe is an OOPIF whose url Playwright can
      // report as '' over a CDP handle, so frames are identified by ASKING
      // each one where it is.
      const findApp = async () => {
        for (let i = 0; i < 80; i++) {
          for (const f of panel.frames()) {
            const here = await f.evaluate(() => location.href).catch(() => '');
            if (here.startsWith(BASE) && here.includes('/extension')) return f;
          }
          await panel.waitForTimeout(500);
        }
        return null;
      };
      let app = await findApp();
      if (!app) throw new Error(`panel app frame never appeared (frames: ${panel.frames().map((f) => f.url()).join(' | ')})`);

      // ctx.addInitScript never reaches this iframe (ctx does not own the panel
      // target), and the second CDP client attached after it had already
      // loaded. So install the stub on the PANEL page and re-navigate the
      // iframe, which is the only moment a document-start script can land.
      // The real session cookie above is what makes the SHELL sign in; the stub
      // is what supplies a conversation without a physically paired handset.
      await panel.addInitScript(bootScript({ theme: THEME }));
      await panel.evaluate(() => {
        const f = document.querySelector('iframe');
        if (f) f.src = f.src;
      });
      await panel.waitForTimeout(1500);
      app = await findApp();
      if (!app) throw new Error('panel app frame did not come back after the stub reload');
      await panel.waitForTimeout(3000);

      console.log('  app frame diag: ' + JSON.stringify(await app.evaluate(() => ({
        stubbed: window.WebSocket && window.WebSocket.name === 'FakeWS',
        theme: (() => { try { return localStorage.getItem('cc:theme:last'); } catch { return 'x'; } })(),
        tabs: [...document.querySelectorAll('[role=tab]')].map((e) => e.textContent.trim()),
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
      })).catch((e) => String(e))));
      await app.getByRole('tab', { name: /texts/i }).click({ timeout: 15_000 }).catch(() => {});
      await panel.waitForTimeout(1200);
      await app.getByRole('button', { name: /Marta Ruiz|Takk!|\+4745720075/ }).first()
        .click({ timeout: 15_000 }).catch(() => {});
      await panel.waitForTimeout(1200);
      const ta = app.locator('textarea[aria-label="Message body"]');
      await ta.waitFor({ timeout: 20_000 });

      // --- locate the panel column ONCE, then crop every state to it -------
      const pid = browserPids[0];
      const probe = path.join(OUT_DIR, `_full-${PHASE}-${THEME}.png`);
      const cap = psJson('-Action', 'capture', '-ProcessId', String(pid), '-Out', probe);
      const markRow = scan(ps('-Action', 'scanrow', '-In', probe, '-Y', String(Math.round(cap.height * 0.6))));
      let lastMark = -1;
      for (let i = 0; i < markRow.length; i++) if (near(markRow[i], MARKER)) lastMark = i;
      if (lastMark < 0) throw new Error('marker colour not found in the capture');
      const panelLeft = lastMark + 4;
      const panelW = cap.width - 6 - panelLeft;
      const markCol = scan(ps('-Action', 'scancol', '-In', probe, '-X', String(Math.round(lastMark / 2))));
      let panelTop = markCol.findIndex((c) => near(c, MARKER));
      if (panelTop < 0) panelTop = 0;
      // The FULL panel column, not a 640/720px slice: the composer lives at the
      // panel's BOTTOM edge, and a short crop photographs the conversation and
      // cuts off the only thing this evidence is about (measured: the first run
      // produced six handsome screenshots with no composer in any of them).
      const cropH = cap.height - panelTop - 8;

      const shoot = async (state) => {
        const full = path.join(OUT_DIR, `_full-${PHASE}-${THEME}-${state}.png`);
        psJson('-Action', 'capture', '-ProcessId', String(pid), '-Out', full);
        const dest = path.join(OUT_DIR, `composer-${PHASE}-${THEME}-${state}.png`);
        const c = psJson('-Action', 'crop', '-In', full, '-Out', dest,
          '-X', String(panelLeft), '-Y', String(panelTop), '-W', String(panelW), '-H', String(cropH));
        fs.rmSync(full, { force: true });
        const bytes = fs.statSync(dest).size;
        written.push({ file: dest, bytes, px: `${c.width}x${c.height}` });
        console.log(`WROTE ${dest}  ${c.width}x${c.height}  ${bytes} B`);
      };

      // single — empty composer, one line
      await ta.fill('');
      await panel.waitForTimeout(700);
      await shoot('single');

      // grown — a long draft, auto-grown to the cap
      await ta.fill(LONG);
      await panel.waitForTimeout(1200);
      await shoot('grown');

      // max — the grip dragged (keyboard End) to the LIVE maximum.
      // On the BEFORE code there is no [data-cc-composer-grip] at all, so this
      // state cannot be produced: its absence IS the before-state. The same
      // thread view is photographed under the before name so the ladder has
      // twelve comparable frames; the report says plainly that the before
      // "max" is the old auto-grown cap, not a dragged maximum.
      await ta.fill('');
      await panel.waitForTimeout(500);
      const gripCount = await app.locator('[data-cc-composer-grip]').count();
      if (gripCount > 0) {
        await app.locator('[data-cc-composer-grip]').focus();
        await panel.keyboard.press('End');
        await panel.waitForTimeout(900);
      } else {
        console.log('NOTE  no [data-cc-composer-grip] in this tree — BEFORE has no max state; capturing the auto-grown cap instead');
        await ta.fill(LONG);
        await panel.waitForTimeout(1200);
      }
      await shoot('max');
    } finally {
      if (cdpBrowser2) await cdpBrowser2.close().catch(() => {});
      if (cdpBrowser) await cdpBrowser.close().catch(() => {});
      await ctx.close().catch(() => {});
      reaper.reapAndReport('ext-composer-resize-proof:a4');
      fs.rmSync(path.join(OUT_DIR, `_full-${PHASE}-${THEME}.png`), { force: true });
    }
  }

  console.log(`\nA4 side-panel evidence (${PHASE}): ${written.length} PNG(s)`);
  for (const w of written) console.log(`  ${w.file}  ${w.px}  ${w.bytes} B`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(written.length === 6 ? 0 : 1);
}

const browser = await chromium.launch({ headless: true });
try {
  // ---- B1. the A1 cap, at two panel heights -------------------------------
  for (const [panelH, wantCap] of [[560, 202], [400, expectedCap(400)]]) {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'light' }));
    await page.setViewportSize({ width: 400, height: panelH });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);

    const rest = await taHeight(page);
    check(`${panelH}px panel: an empty composer is one line`, rest === MIN_PX, `${rest}px`);

    await page.locator('textarea[aria-label="Message body"]').fill(LONG);
    await page.waitForTimeout(400);
    const grown = await taHeight(page);
    const scrolls = await page.locator('textarea[aria-label="Message body"]').evaluate((el) => el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY === 'auto');
    check(`${panelH}px panel: auto-grow caps at ${wantCap}px (was ${Math.round(wantCap / 1.2)}px)`, Math.abs(grown - wantCap) <= 1, `${grown}px`);
    check(`${panelH}px panel: past the cap it still scrolls internally (2026-09-16 fix intact)`, scrolls);
    await page.screenshot({ path: path.join(SHOTS, `ext-composer-autogrow-${panelH}.png`) });
    await page.close();
  }

  // ---- B2. the handle: pointer, persistence, keyboard, reset --------------
  {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'light' }));
    await page.setViewportSize({ width: 400, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);

    const g = grip(page);
    check('the handle exists on the extension surface', (await g.count()) === 1, `${await g.count()} found`);
    const aria = await g.evaluate((el) => ({
      role: el.getAttribute('role'),
      orient: el.getAttribute('aria-orientation'),
      label: el.getAttribute('aria-label'),
      min: el.getAttribute('aria-valuemin'),
      max: el.getAttribute('aria-valuemax'),
      now: el.getAttribute('aria-valuenow'),
      tab: el.getAttribute('tabindex'),
      touch: getComputedStyle(el).touchAction,
      cursor: getComputedStyle(el).cursor,
    }));
    check(
      'it is the ARIA separator pattern, focusable, row-resize, touch-action:none',
      aria.role === 'separator' && aria.orient === 'horizontal' && aria.label === 'Resize message box' &&
        aria.tab === '0' && aria.touch === 'none' && aria.cursor === 'row-resize',
      JSON.stringify(aria),
    );
    // NOT "> 202". The live ceiling in a 560px panel is 173 — smaller than the
    // A1 auto cap, because it is what is actually LEFT after the header, the
    // tab strip, the chip strip and three rows of conversation. That it is
    // below the auto cap is the point of measuring it. The 360px arm below
    // proves it is genuinely live by making it move with the text size.
    check('aria-valuemin is the 36px floor and aria-valuemax is a live DOM bound',
      Number(aria.min) === MIN_PX && Number(aria.max) > MIN_PX && Number(aria.max) < 560 &&
        Number(aria.max) !== 202 && Number(aria.max) !== 168,
      `${aria.min}..${aria.max}`);

    // Tab order: the message comes first. Send is DISABLED on an empty draft
    // and is therefore not a tab stop, so walk forward rather than counting
    // presses — counting was the first version and it asserted the state of
    // the Send button, which is not what this check is about.
    await page.locator('textarea[aria-label="Message body"]').focus();
    let reached = false;
    for (let i = 0; i < 4 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await g.evaluate((el) => el === document.activeElement);
    }
    const afterInDom = await page.evaluate(() => {
      const ta = document.querySelector('textarea[aria-label="Message body"]');
      const h = document.querySelector('[data-cc-composer-grip]');
      // DOCUMENT_POSITION_FOLLOWING
      return !!(ta && h) && (ta.compareDocumentPosition(h) & 4) !== 0;
    });
    check('the handle is reachable by Tab and comes AFTER the textarea in the DOM', reached && afterInDom, `tab ${reached}, dom-after ${afterInDom}`);

    // Pointer drag: the handle is on the TOP edge, so up = taller.
    const box = await g.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 6 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await taHeight(page);
    check('pointer drag of 120px sets the composer height', Math.abs(dragged - (MIN_PX + 120)) <= 4, `${dragged}px`);
    const stored = await page.evaluate(() => localStorage.getItem('cc:composer:anon'));
    check('the drag was written to storage', Math.abs(Number(stored) - dragged) <= 2, String(stored));
    check('aria-valuenow tracked the drag', Math.abs(Number(await g.getAttribute('aria-valuenow')) - dragged) <= 2);
    check('the mode flag says a user height is in force', (await g.getAttribute('data-cc-composer-mode')) === 'user');
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-dragged.png') });

    // Thread switch — the component is keyed by threadId, so this is a remount.
    await page.getByRole('button', { name: /back/i }).first().click({ timeout: 6000 }).catch(() => {});
    await settle(page, 700);
    await page.getByRole('button', { name: /Ola Nordmann|see you at six|\+4791827364/ }).first().click({ timeout: 8000 }).catch(() => {});
    await settle(page, 900);
    await page.locator('textarea[aria-label="Message body"]').waitFor({ timeout: 10_000 });
    check('the height survives a thread switch', Math.abs((await taHeight(page)) - dragged) <= 4, `${await taHeight(page)}px`);

    // Reload.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    check('the height survives a reload', Math.abs((await taHeight(page)) - dragged) <= 4, `${await taHeight(page)}px`);

    // Keyboard.
    const g2 = grip(page);
    await g2.focus();
    // From the FLOOR, not from wherever the drag left it: the restored 156px is
    // within 40px of the live 173px ceiling, so "+8 x 5" measured the clamp
    // instead of the step. Home first makes the step the only variable.
    await page.keyboard.press('Home');
    await page.waitForTimeout(250);
    const before = await taHeight(page);
    check('Home puts the box on its 36px floor before the step is measured', before === MIN_PX, `${before}px`);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    check('ArrowUp x5 is +40px (8px a step)', (await taHeight(page)) - before === 40, `${before} -> ${await taHeight(page)}`);
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(250);
    check('Shift+Arrow is the 32px step', (await taHeight(page)) - before === 72, `${await taHeight(page)}`);
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(250);
    check('Shift+Arrow is symmetric downward', (await taHeight(page)) - before === 40, `${await taHeight(page)}`);
    await page.keyboard.press('Home');
    await page.waitForTimeout(250);
    check('Home is the 36px minimum', (await taHeight(page)) === MIN_PX, `${await taHeight(page)}px`);
    check('aria-valuenow followed the keyboard to the floor', Number(await g2.getAttribute('aria-valuenow')) === MIN_PX);
    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    const atMax = await taHeight(page);
    const bound = Number(await g2.getAttribute('aria-valuemax'));
    check('End is the live maximum', Math.abs(atMax - bound) <= 2, `${atMax} vs aria-valuemax ${bound}`);

    // At the maximum the thread must still be a thread.
    const rows = await page.evaluate(() => {
      const s = document.querySelector('.cc-thread-scroll');
      if (!s) return -1;
      const r = s.getBoundingClientRect();
      return [...s.children].filter((c) => {
        const b = c.getBoundingClientRect();
        return b.height > 4 && b.bottom > r.top && b.top < r.bottom;
      }).length;
    });
    check('at maximum height at least 3 conversation rows are still visible', rows >= 3, `${rows} rows`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('and nothing overflows horizontally', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-max.png') });

    // Double-click resets to auto.
    await g2.dblclick();
    await page.waitForTimeout(400);
    check('double-click returns the box to auto', (await taHeight(page)) === MIN_PX && (await g2.getAttribute('data-cc-composer-mode')) === 'auto', `${await taHeight(page)}px`);
    check('and clears the stored height', (await page.evaluate(() => localStorage.getItem('cc:composer:anon'))) === null);
    check('with a polite announcement for someone who cannot see it happen',
      (await page.locator('[role="status"][aria-live="polite"]').last().innerText()).includes('Message box size reset'));
    await page.close();
  }

  // ---- B3. bounds hold at 360px and at every text size --------------------
  const boundsBySize = {};
for (const size of ['small', 'medium', 'large']) {
    const page = await browser.newPage();
    // 480px is deliberately ABOVE the live max at this panel height — a stored
    // value out of bounds must be re-clamped, never discarded.
    await page.addInitScript(bootScript({ theme: 'light', size, height: 480 }));
    await page.setViewportSize({ width: 360, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    const h = await taHeight(page);
    const bound = Number(await grip(page).getAttribute('aria-valuemax'));
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const rows = await page.evaluate(() => {
      const s = document.querySelector('.cc-thread-scroll');
      if (!s) return -1;
      const r = s.getBoundingClientRect();
      return [...s.children].filter((c) => { const b = c.getBoundingClientRect(); return b.height > 4 && b.bottom > r.top && b.top < r.bottom; }).length;
    });
    check(`${size} @360px: an out-of-bounds stored height is re-clamped, not discarded`, h > MIN_PX && h <= bound + 2, `${h}px, bound ${bound}`);
    check(`${size} @360px: still >=3 thread rows and no horizontal overflow`, rows >= 3 && ov <= 0, `${rows} rows, ${ov}px`);
    boundsBySize[size] = bound;
    await page.screenshot({ path: path.join(SHOTS, `ext-composer-360-${size}.png`) });
    await page.close();
  }
  check(
    'the maximum is genuinely computed, not a constant: it shrinks as the type grows',
    boundsBySize.small > boundsBySize.medium && boundsBySize.medium > boundsBySize.large,
    JSON.stringify(boundsBySize),
  );

  // ---- B4. dark theme contrast of the affordance --------------------------
  {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'dark' }));
    await page.setViewportSize({ width: 400, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    const seen = await page.evaluate(() => {
      const el = document.querySelector('[data-cc-composer-grip] .cc-composer-grip-pill');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
    });
    check('the dark-theme grip resolves to the 3:1 token, not to a hairline', !!seen && /114,\s*114,\s*122/.test(seen.bg), JSON.stringify(seen));
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-dark.png') });
    await page.close();
  }

  // ---- B5. /app is untouched, proved by discrimination --------------------
  {
    const measureApp = async (seed) => {
      const page = await browser.newPage();
      await page.addInitScript(`(() => { try {
        ${seed != null ? `localStorage.setItem('cc:composer:anon', '${seed}');
        localStorage.setItem('cc:composer:dennis@computercaller.com', '${seed}');` : ''}
      } catch (e) {} })();`);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const out = await page.evaluate(() => {
        const t = [...document.querySelectorAll('textarea')].filter((e) => e.offsetParent !== null);
        return {
          heights: t.map((e) => Math.round(e.getBoundingClientRect().height)),
          grips: document.querySelectorAll('[data-cc-composer-grip]').length,
          ext: document.querySelectorAll('.cc-ext').length,
        };
      });
      await page.close();
      return out;
    };
    const clean = await measureApp(null);
    const seeded = await measureApp(420);
    check('/app renders no .cc-ext and therefore no composer grip', clean.grips === 0 && clean.ext === 0, JSON.stringify(clean));
    check(
      "/app composer height is IDENTICAL with and without a stored extension height — the pref cannot reach it",
      JSON.stringify(clean.heights) === JSON.stringify(seeded.heights),
      `${JSON.stringify(clean.heights)} vs ${JSON.stringify(seeded.heights)}` +
        (clean.heights.length === 0
          ? '  [VACUOUS: /app rendered no composer for an unauthenticated harness. The /app non-regression here rests on the two checks above — Dashboard.tsx byte-identical to base, and every grip selector scoped under .cc-ext.]'
          : ''),
    );
  }
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (floor ${MIN_CHECKS}, screenshots: ${SHOTS})`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
if (results.length < MIN_CHECKS) console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
process.exit(failed.length || results.length < MIN_CHECKS ? 1 : 0);
