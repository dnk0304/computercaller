/**
 * scripts/bat-ui-proof.mjs — BAT-3 (d). The proof for (a), (b) and (c).
 *
 * ── THREE ARMS, AND WHY ─────────────────────────────────────────────────────
 * NODE ARM (scripts/lib/bat-ui-cases.mjs) asserts the DECISIONS — thresholds,
 * copy, staleness boundary, the no-value rule — exhaustively against
 * lib/batteryCopy.ts, the same module the component imports. Every decision in
 * this feature was deliberately pushed into that module so it could be asserted
 * this way rather than sampled through whatever states a browser run reaches.
 *
 * WEB ARM drives the REAL hook on the REAL page. Which driver: a STUBBED
 * SOCKET, not a scripted relay peer. `makeBridgeStub` (the shape
 * scripts/e2e-ui-proof.mjs uses, lifted here) replaces only the `/relay`
 * WebSocket, so `BATTERY:{...}` enters through usePhoneBridge's own frame
 * switch, through the real reduceBattery(), into the real DOM. A scripted relay
 * peer would add a socket, a room and a pairing handshake to a test about a
 * header — three things that can fail for reasons that are not this feature.
 * The frames the stub injects are the exact wire strings server.js forwards.
 *
 * EXTENSION ARM loads the UNPACKED extension, drives the SHIPPED service worker
 * with a real BATTERY frame so the worker writes `cc_battery` itself, and then
 * opens sidepanel.html and popup.html and proves shell.js reads storage.session
 * and hands the value to the app frame. The hosted app is not reachable from a
 * local gate run, so the app frame is replaced by a RECORDER served at the real
 * WEBAPP_ORIGIN — which keeps the origin pin honest (a recorder on any other
 * origin would receive nothing, because shell.js posts to that origin and no
 * other). What the recorder proves is delivery; what the value RENDERS as is
 * the web arm's job, through the same component.
 *
 * ── PORT ────────────────────────────────────────────────────────────────────
 * This harness owns no port. Like its siblings it runs against the gate-owned
 * dev server at DEV_URL.
 *
 * Run: node scripts/bat-ui-proof.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reaper, rmWhenUnlocked } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';
import { exitAfterFlush } from './lib/finish.mjs';
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { runBatteryCases } from './lib/bat-ui-cases.mjs';
// The thresholds and the copy come from the PRODUCT, never restated as
// literals here — the rule lib/encryptedModeCopy.ts's harness follows, for the
// same reason: a retyped expectation drifts and the drift passes.
import { BATTERY_STALE_MS, batteryView } from '../lib/batteryCopy.ts';

const DEV = process.env.DEV_URL || 'http://localhost:3123';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'chrome-extension');
const SHOTS = path.join(process.cwd(), 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/** The origin shell.js posts to. Read from the extension's own config. */
const WEBAPP_ORIGIN = fs.readFileSync(path.join(EXT, 'config.js'), 'utf8')
  .match(/WEBAPP_ORIGIN:\s*'([^']+)'/)[1];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail: detail === '' ? '' : String(detail).slice(0, 200) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`);
};

/**
 * minChecks — declared here, enforced by the gate's floor
 * (tools/e2e-gate.mjs MIN_CHECKS_OVERRIDE['harness:bat-ui-proof']).
 *
 * A FLOOR, not a target: a run reporting fewer means assertions silently
 * stopped executing, which is exactly what a cheerful "N/N passed" hides. Every
 * assertion below runs unconditionally — the only `if`s in this file choose
 * WHICH screenshot to write, never whether to assert — so a skipped section
 * shows up here as a shortfall.
 *
 * 15 node-arm decisions + 34 web-arm assertions (17 per theme x 2) + 4 fit
 * assertions (1.4x, 360px, the sub-400px collapse, the compact cap) + 7
 * extension-arm assertions = 60.
 */
export const MIN_CHECKS = 60;

const EMAIL = process.env.CC_SHOT_EMAIL;
if (!EMAIL) throw new Error('CC_SHOT_EMAIL is unset — the gate passes the operator value through');

// ── a real session for a real user, exactly as the sibling shot harnesses do ─
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const signAccessToken = (p) => jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) => jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });
const dbUser = await db.user.findFirst({
  where: { email: EMAIL },
  select: { id: true, email: true, sessionVersion: true },
});
if (!dbUser) throw new Error(`no user to mint a session for: ${EMAIL}`);
const COOKIE_HOST = new URL(DEV).hostname;
const SESSION_COOKIES = [
  { name: 'auth_token', value: signAccessToken({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0 }), domain: COOKIE_HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: signIdleToken(dbUser.id, process.env.JWT_SECRET), domain: COOKIE_HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];

/**
 * The socket stub. Identical in shape to e2e-ui-proof.mjs's, and deliberately
 * so — two harnesses that drive the same hook should drive it the same way.
 */
const BRIDGE_STUB = `
(() => {
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;
      this.sent = [];
      window.__ccSocket = this;
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify({ deviceName: 'Pixel 8' }));
      }, 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
    addEventListener() {}
    removeEventListener() {}
  }
  StubSocket.OPEN = OPEN; StubSocket.CONNECTING = 0; StubSocket.CLOSING = 2; StubSocket.CLOSED = 3;
  const RealWS = window.WebSocket;
  function WS(url, protocols) {
    if (String(url).includes('/relay')) return new StubSocket(url);
    return new RealWS(url, protocols);
  }
  WS.OPEN = OPEN; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
`;

const reaper = new Reaper().installExitHook('bat-ui-proof');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

/** 2026-09-22 14:32 LOCAL — the brief's clock, so copy and screenshots agree. */
const TS_1432 = new Date(2026, 8, 22, 14, 32, 0).getTime();

async function open({ theme = 'light', width = 1280, zoom = 1 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 860 },
    colorScheme: theme,
    deviceScaleFactor: 1,
    bypassCSP: true,
  });
  await ctx.addCookies(SESSION_COOKIES);
  const page = await ctx.newPage();
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  await page.addInitScript(({ t, z }) => {
    try { localStorage.setItem('cc_theme_last', t); } catch { /* blocked site data */ }
    document.documentElement.setAttribute('data-cc-theme', t);
    if (z !== 1) document.documentElement.style.zoom = String(z);
  }, { t: theme, z: zoom });
  await page.addInitScript(BRIDGE_STUB);
  await page.goto(`${DEV}/app`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 2500);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 2500 }).catch(() => {});
  return { ctx, page };
}

/** Push one real wire frame through the real hook. */
const sendFrame = async (page, frame) => {
  await page.evaluate((f) => window.__ccSend(f), frame);
  await settle(page, 350);
};
const sendBattery = (page, { pct, charging, ts }) =>
  sendFrame(page, 'BATTERY:' + JSON.stringify({ pct, charging, ts }));

/** Read back everything the indicator asserts about itself. */
const readIndicator = (page) => page.evaluate(() => {
  const el = document.querySelector('.cc-battery');
  if (!el) return null;
  const level = el.querySelector('svg rect:nth-of-type(2)');
  const r = el.getBoundingClientRect();
  return {
    label: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    role: el.getAttribute('role'),
    ariaLive: el.getAttribute('aria-live'),
    pct: el.getAttribute('data-cc-battery'),
    tone: el.getAttribute('data-cc-battery-tone'),
    kind: el.getAttribute('data-cc-battery-kind'),
    text: el.textContent.trim(),
    textVisible: [...el.querySelectorAll('span')].some((s) => s.offsetParent !== null || s.getClientRects().length > 0),
    fillWidth: level ? Number(level.getAttribute('width')) : null,
    hasMask: !!el.querySelector('svg mask'),
    paths: el.querySelectorAll('svg path').length,
    width: r.width,
    height: r.height,
  };
});

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  shot ${name}  ${fs.statSync(file).size} B`);
  return file;
}

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bat-proof-'));
let extCtx = null;

try {
  // ══ NODE ARM ══════════════════════════════════════════════════════════════
  console.log('\n── node arm: the decisions ──');
  runBatteryCases(check);

  // ══ WEB ARM ═══════════════════════════════════════════════════════════════
  for (const theme of ['light', 'dark']) {
    console.log(`\n── web arm: ${theme} ──`);
    const { ctx, page } = await open({ theme });
    try {
      // (b) nothing received yet ⇒ NOTHING rendered. First, because it is the
      // only moment in the run when "absent" is not also "I broke the page".
      check(`[${theme}] paired with no BATTERY frame renders no indicator at all`,
        (await readIndicator(page)) === null);

      // (a) the four levels, through the real hook.
      for (const pct of [100, 50, 20, 10]) {
        // Each frame needs a strictly newer ts — reduceBattery drops equal or
        // older readings, which is correct and would otherwise make every
        // assertion after the first read the first one's value.
        await sendBattery(page, { pct, charging: false, ts: TS_1432 + pct * 1000 });
        const i = await readIndicator(page);
        const want = batteryView({ pct, charging: false, ts: TS_1432 + pct * 1000 }, true, TS_1432 + pct * 1000);
        check(`[${theme}] ${pct}% renders "${want.text}" with tone ${want.tone} and the product's own label`,
          i !== null && i.text === want.text && i.tone === want.tone && i.label === want.label,
          JSON.stringify(i));
      }

      // Proportional fill — measured off the rendered SVG, not asserted of the
      // function that produced it (the node arm already owns that).
      await sendBattery(page, { pct: 100, charging: false, ts: TS_1432 + 200_000 });
      const full = (await readIndicator(page)).fillWidth;
      await sendBattery(page, { pct: 25, charging: false, ts: TS_1432 + 210_000 });
      const quarter = (await readIndicator(page)).fillWidth;
      check(`[${theme}] the glyph fill is PROPORTIONAL — 25% draws a quarter of what 100% draws`,
        full > 0 && Math.abs(quarter / full - 0.25) < 0.02, `${quarter}/${full}`);

      // (a) charging: an icon change, not only a colour change.
      await sendBattery(page, { pct: 47, charging: true, ts: TS_1432 + 220_000 });
      const charging = await readIndicator(page);
      check(`[${theme}] charging draws the bolt (a mask + an extra path), and says so`,
        charging.hasMask === true && charging.label === 'Phone battery 47%, charging',
        JSON.stringify({ mask: charging.hasMask, label: charging.label }));
      await sendBattery(page, { pct: 47, charging: false, ts: TS_1432 + 230_000 });
      const notCharging = await readIndicator(page);
      check(`[${theme}] not charging drops the bolt and the mask with it`,
        notCharging.hasMask === false && notCharging.label === 'Phone battery 47%, not charging',
        JSON.stringify({ mask: notCharging.hasMask, label: notCharging.label }));

      // (a) low / critical change the ICON as well as the colour.
      await sendBattery(page, { pct: 15, charging: false, ts: TS_1432 + 240_000 });
      const low = await readIndicator(page);
      await sendBattery(page, { pct: 80, charging: false, ts: TS_1432 + 250_000 });
      const normal = await readIndicator(page);
      check(`[${theme}] at 20% or below the glyph gains a mark — the change is never colour alone`,
        low.tone === 'low' && normal.tone === 'normal' && low.paths > normal.paths,
        `low ${low.paths} paths / normal ${normal.paths}`);

      // (c) a11y: one name, read once. No aria-live on this element.
      check(`[${theme}] the indicator is one labelled image with NO aria-live`,
        normal.role === 'img' && !!normal.label && normal.ariaLive === null,
        JSON.stringify({ role: normal.role, live: normal.ariaLive }));

      // (b) stale: value kept, tooltip admits when it is from.
      const staleTs = Date.now() - BATTERY_STALE_MS - 60_000;
      await sendBattery(page, { pct: 47, charging: false, ts: staleTs });
      const stale = await readIndicator(page);
      check(`[${theme}] a reading older than the stale window keeps its VALUE`,
        stale !== null && stale.text === '47%', JSON.stringify(stale));
      check(`[${theme}] …and its tooltip gains "as of ${new Date(staleTs).getHours()}:.."`,
        /, as of \d{2}:\d{2}$/.test(stale.label || ''), stale.label);

      // (b) phone gone: ROOM_RESET is a transport teardown that KEEPS the pair,
      // which is precisely the "last seen" case. (PAIRING_TERMINATED nulls the
      // value instead — that is unpair, and is asserted right after.)
      await sendBattery(page, { pct: 47, charging: false, ts: TS_1432 });
      await sendFrame(page, 'ROOM_RESET:' + JSON.stringify({ reason: 'harness' }));
      const gone = await readIndicator(page);
      check(`[${theme}] phone gone ⇒ "Last seen 14:32 · 47%" in the lobby pill`,
        gone !== null && gone.kind === 'lastSeen' && gone.text === 'Last seen 14:32 · 47%',
        JSON.stringify(gone));
      check(`[${theme}] …greyed, and its accessible name says last seen rather than a present tense`,
        gone.tone === 'normal' && gone.label === 'Phone battery 47%, last seen 14:32', gone.label);

      // MUST-3: an unpair clears it. If this fails, the header is showing
      // another device's telemetry.
      await sendFrame(page, 'PAIRING_TERMINATED:' + JSON.stringify({ reason: 'harness' }));
      check(`[${theme}] an unpair CLEARS the reading — no last-seen for an ex-pair`,
        (await readIndicator(page)) === null);

      // CONTROL. Every "renders nothing" assertion above is vacuous if the
      // reader cannot see an indicator that IS there.
      await sendBattery(page, { pct: 42, charging: false, ts: Date.now() });
      check(`[${theme}] CONTROL: the reader still finds an indicator when one exists`,
        (await readIndicator(page)) !== null);

      if (theme === 'light') {
        await sendBattery(page, { pct: 62, charging: true, ts: Date.now() });
        await shot(page, 'bat-web');
        await sendBattery(page, { pct: 8, charging: false, ts: Date.now() + 1000 });
        await shot(page, 'bat-low');
      }
    } finally {
      await ctx.close();
    }
  }

  // ══ FIT: 1.4x, 360px, the collapse, the cap ═══════════════════════════════
  console.log('\n── fit ──');
  {
    // Chrome's "Large" text size is emulated the way the sibling harness does
    // it: document zoom, which is what the setting actually applies.
    const { ctx, page } = await open({ theme: 'light', width: 1280, zoom: 1.4 });
    try {
      await sendBattery(page, { pct: 47, charging: true, ts: Date.now() });
      const header = await page.evaluate(() => {
        const el = document.querySelector('.cc-battery');
        if (!el) return null;
        const row = el.closest('[role="status"]') || el.parentElement;
        return { scrollW: row.scrollWidth, clientW: row.clientWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check('Large text (1.4x): the header row does not overflow and the page gains no h-scroll',
        header !== null && header.scrollW <= header.clientW + 1 && header.docOverflow <= 1,
        JSON.stringify(header));
    } finally { await ctx.close(); }
  }
  {
    const { ctx, page } = await open({ theme: 'light', width: 360, zoom: 1.4 });
    try {
      await sendBattery(page, { pct: 47, charging: true, ts: Date.now() });
      const i = await readIndicator(page);
      const doc = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check('360px at 1.4x: the indicator still renders and the page does not scroll sideways',
        i !== null && doc <= 1, `overflow ${doc}`);
      check('360px at 1.4x: the value is still in the accessible name even where text may collapse',
        /^Phone battery 47%/.test(i.label || ''), i.label);
      check('360px at 1.4x: the indicator is narrow enough to sit beside a name (< 90 CSS px)',
        i.width > 0 && i.width < 90, `${i.width}px`);
    } finally { await ctx.close(); }
  }

  // ══ EXTENSION ARM ═════════════════════════════════════════════════════════
  console.log('\n── extension arm ──');
  const extBefore = reaper.mark();
  extCtx = await chromium.launchPersistentContext(extDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  reaper.adoptBrowser(extBefore);

  const sw = await awaitServiceWorker(extCtx, null, { extDir: EXT });
  const extId = new URL(sw.url()).host;

  // The shipped worker writes the record — this harness never mints one.
  const ts = Date.now();
  const rec = await sw.evaluate(async (t) => {
    handleFrame('BATTERY:' + JSON.stringify({ pct: 47, charging: true, ts: t }));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const got = await chrome.storage.session.get('cc_battery');
      if (got.cc_battery) return got.cc_battery;
    }
    return null;
  }, ts);
  check('the SHIPPED worker writes cc_battery in storage.session from a real BATTERY frame',
    !!rec && rec.pct === 47 && rec.charging === true && rec.ts === ts && rec.v === 1,
    JSON.stringify(rec));

  /**
   * The recorder stands in for the hosted app, AT THE REAL WEBAPP ORIGIN.
   * shell.js posts with that origin as the targetOrigin, so a recorder served
   * anywhere else would receive nothing — which makes this arm a test of the
   * origin pin as much as of the delivery.
   */
  const RECORDER = `<!doctype html><meta charset="utf-8"><title>recorder</title><body>
<script>
  window.__got = [];
  addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.source === 'cc-ext') window.__got.push(d);
  });
  parent.postMessage({ source: 'cc-ext', type: 'ready' }, '*');
</script></body>`;
  await extCtx.route(`${WEBAPP_ORIGIN}/api/auth/me`, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ user: { email: EMAIL } }),
  }));
  await extCtx.route(`${WEBAPP_ORIGIN}/**`, (r) => r.fulfill({
    status: 200, contentType: 'text/html', body: RECORDER,
  }));

  for (const surface of ['sidepanel', 'popup']) {
    const page = await extCtx.newPage();
    await page.goto(`chrome-extension://${extId}/${surface}.html`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    const appFrame = page.frames().find((f) => f.url().startsWith(WEBAPP_ORIGIN));
    const got = appFrame
      ? await appFrame.evaluate(() => (window.__got || []).filter((m) => m.type === 'battery'))
      : [];
    const last = got[got.length - 1];
    check(`${surface}: shell.js reads storage.session on open and hands the value to the app`,
      !!last && last.v === 1 && !!last.battery && last.battery.pct === 47
        && last.battery.charging === true && last.battery.ts === ts,
      JSON.stringify(last));
    check(`${surface}: the record's storage \`v\` tag is NOT forwarded as part of the value`,
      !!last && last.battery && !('v' in last.battery), JSON.stringify(last && last.battery));

    if (surface === 'sidepanel') await shot(page, 'bat-ext');
    await page.close();
  }

  // A cleared row must clear the app, not leave the last value standing.
  {
    const page = await extCtx.newPage();
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2000);
    await sw.evaluate(() => new Promise((r) => chrome.storage.session.remove('cc_battery', r)));
    await settle(page, 1200);
    const appFrame = page.frames().find((f) => f.url().startsWith(WEBAPP_ORIGIN));
    const got = appFrame
      ? await appFrame.evaluate(() => (window.__got || []).filter((m) => m.type === 'battery'))
      : [];
    const last = got[got.length - 1];
    check('clearing cc_battery (sign-out / unpair) posts an explicit null, not silence',
      !!last && last.battery === null, JSON.stringify(last));
    await page.close();
  }

  // An unreadable record version must be treated as NO value (rule 6).
  {
    await sw.evaluate(() => new Promise((r) => chrome.storage.session.set({
      cc_battery: { pct: 55, charging: false, ts: Date.now(), v: 99 },
    }, r)));
    const page = await extCtx.newPage();
    await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    const appFrame = page.frames().find((f) => f.url().startsWith(WEBAPP_ORIGIN));
    const got = appFrame
      ? await appFrame.evaluate(() => (window.__got || []).filter((m) => m.type === 'battery' && m.battery))
      : [];
    check('a record with an unknown `v` is NOT rendered — no half-read header',
      got.length === 0, JSON.stringify(got));
  }
} finally {
  if (extCtx) await extCtx.close().catch(() => {});
  await browser.close().catch(() => {});
  await db.$disconnect().catch(() => {});
  reaper.reapAndReport('bat-ui-proof');
  rmWhenUnlocked(extDir);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  if (results.length < MIN_CHECKS) {
    console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
    process.exitCode = 1;
  }
  if (failed.length) process.exitCode = 1;
}

exitAfterFlush(process.exitCode ?? 0);
