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
import { BATTERY_STALE_MS, batteryClock, batteryView } from '../lib/batteryCopy.ts';

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
 * assertions (four each at 1.4x and at 360px) + 7 extension-arm assertions =
 * 64. The
 * figure is MEASURED from a full green run, never incremented by arithmetic.
 */
export const MIN_CHECKS = 64;

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

/**
 * Every web-arm frame needs a ts that is STRICTLY NEWER than the last one, or
 * the product correctly drops it as stale and the next assertion reads the
 * previous value. (It cost this harness its first run: readings were stamped
 * `base + pct*1000`, so 50% arrived "older" than 100% and never rendered — the
 * product was right and the test was wrong.)
 *
 * The clock starts an hour in the PAST so that a deliberately stale reading can
 * still be the newest one this page has seen. `at()` is the one way a frame in
 * this file gets a timestamp.
 */
let clock = 0;
/** A fresh page gets a fresh clock; the stale case is always sent first. */
const resetClock = () => { clock = Date.now() - 30 * 60 * 1000; };
/** Jump the clock forward to "a few minutes ago" — comfortably inside the
 *  staleness window, so everything sent after this reads as a live value. */
const freshen = () => { clock = Math.max(clock + 1, Date.now() - 2 * 60 * 1000); };
/** @param {number} [absolute] pin the reading to a specific moment instead. */
const at = (absolute) => {
  clock = absolute === undefined ? clock + 1000 : Math.max(absolute, clock + 1);
  return clock;
};

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
    // Each theme is a fresh page, so it gets a fresh clock. The stale reading
    // is sent FIRST and every later frame is fresher, which is the only order
    // in which both a stale case and a live case can be driven through a
    // reducer that (correctly) drops anything older than what it holds.
    resetClock();
    const { ctx, page } = await open({ theme });
    try {
      // (b) nothing received yet ⇒ NOTHING rendered. First, because it is the
      // only moment in the run when "absent" is not also "I broke the page".
      check(`[${theme}] paired with no BATTERY frame renders no indicator at all`,
        (await readIndicator(page)) === null);

      // (b) stale: value kept, tooltip admits when it is from.
      const staleTs = at(Date.now() - BATTERY_STALE_MS - 60_000);
      await sendBattery(page, { pct: 47, charging: false, ts: staleTs });
      const stale = await readIndicator(page);
      check(`[${theme}] a reading older than the stale window keeps its VALUE`,
        stale !== null && stale.text === '47%', JSON.stringify(stale));
      check(`[${theme}] …and its tooltip gains "as of ${batteryClock(staleTs)}"`,
        stale.label === `Phone battery 47%, not charging, as of ${batteryClock(staleTs)}`,
        stale.label);

      // Everything from here on is a FRESH reading.
      freshen();

      // (a) the four levels, through the real hook.
      for (const pct of [100, 50, 20, 10]) {
        const ts = at();
        await sendBattery(page, { pct, charging: false, ts });
        const i = await readIndicator(page);
        // The expectation is the product's own, evaluated at the real clock —
        // never a literal, which would assert the machine's wall time.
        const want = batteryView({ pct, charging: false, ts }, true, Date.now());
        check(`[${theme}] ${pct}% renders "${want.text}" with tone ${want.tone} and the product's own label`,
          i !== null && i.text === want.text && i.tone === want.tone && i.label === want.label,
          JSON.stringify(i));
      }

      // Proportional fill — measured off the rendered SVG, not asserted of the
      // function that produced it (the node arm already owns that).
      await sendBattery(page, { pct: 100, charging: false, ts: at() });
      const full = (await readIndicator(page)).fillWidth;
      await sendBattery(page, { pct: 25, charging: false, ts: at() });
      const quarter = (await readIndicator(page)).fillWidth;
      check(`[${theme}] the glyph fill is PROPORTIONAL — 25% draws a quarter of what 100% draws`,
        full > 0 && Math.abs(quarter / full - 0.25) < 0.02, `${quarter}/${full}`);

      // (a) charging: an icon change, not only a colour change.
      await sendBattery(page, { pct: 47, charging: true, ts: at() });
      const charging = await readIndicator(page);
      check(`[${theme}] charging draws the bolt (a mask + an extra path), and says so`,
        charging.hasMask === true && charging.label === 'Phone battery 47%, charging',
        JSON.stringify({ mask: charging.hasMask, label: charging.label }));
      await sendBattery(page, { pct: 47, charging: false, ts: at() });
      const notCharging = await readIndicator(page);
      check(`[${theme}] not charging drops the bolt and the mask with it`,
        notCharging.hasMask === false && notCharging.label === 'Phone battery 47%, not charging',
        JSON.stringify({ mask: notCharging.hasMask, label: notCharging.label }));

      // (a) low / critical change the ICON as well as the colour.
      await sendBattery(page, { pct: 15, charging: false, ts: at() });
      const low = await readIndicator(page);
      await sendBattery(page, { pct: 80, charging: false, ts: at() });
      const normal = await readIndicator(page);
      check(`[${theme}] at 20% or below the glyph gains a mark — the change is never colour alone`,
        low.tone === 'low' && normal.tone === 'normal' && low.paths > normal.paths,
        `low ${low.paths} paths / normal ${normal.paths}`);

      // (c) a11y: one name, read once. No aria-live on this element.
      check(`[${theme}] the indicator is one labelled image with NO aria-live`,
        normal.role === 'img' && !!normal.label && normal.ariaLive === null,
        JSON.stringify({ role: normal.role, live: normal.ariaLive }));

      // Screenshots are taken HERE, while the pair is still ACTIVE — the state
      // the feature is actually for. Taking them at the end of the block put a
      // torn-down lobby pill in bat-web.png, which is a picture of the wrong
      // thing and cost a review round.
      if (theme === 'light') {
        await sendBattery(page, { pct: 62, charging: true, ts: at() });
        await shot(page, 'bat-web');
        await sendBattery(page, { pct: 8, charging: false, ts: at() });
        await shot(page, 'bat-low');
      }

      // The colour of a LIVE reading, kept so the greying below is a measured
      // change rather than an assertion about a class name.
      const liveColour = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.cc-battery')).color);

      // (b) phone gone: ROOM_RESET is a transport teardown that KEEPS the pair,
      // which is precisely the "last seen" case. (PAIRING_TERMINATED nulls the
      // value instead — that is unpair, and is asserted right after.)
      const goneTs = at();
      await sendBattery(page, { pct: 47, charging: false, ts: goneTs });
      await sendFrame(page, 'ROOM_RESET:' + JSON.stringify({ reason: 'harness' }));
      const gone = await readIndicator(page);
      const wantGone = batteryView({ pct: 47, charging: false, ts: goneTs }, false, Date.now());
      check(`[${theme}] phone gone ⇒ "${wantGone.text}" in the lobby pill`,
        gone !== null && gone.kind === 'lastSeen' && gone.text === wantGone.text,
        JSON.stringify(gone));
      check(`[${theme}] …and its accessible name says last seen, not a present tense`,
        gone.label === wantGone.label && / last seen /.test(gone.label), gone.label);
      const goneColour = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.cc-battery')).color);
      check(`[${theme}] …and it is GREYED — a departed phone's level is history, not a live fact`,
        goneColour !== liveColour, `${liveColour} -> ${goneColour}`);

      // MUST-3: an unpair clears it. If this fails, the header is showing
      // another device's telemetry.
      await sendFrame(page, 'PAIRING_TERMINATED:' + JSON.stringify({ reason: 'harness' }));
      check(`[${theme}] an unpair CLEARS the reading — no last-seen for an ex-pair`,
        (await readIndicator(page)) === null);

      // CONTROL. Every "renders nothing" assertion above is vacuous if the
      // reader cannot see an indicator that IS there.
      await sendBattery(page, { pct: 42, charging: false, ts: at() });
      check(`[${theme}] CONTROL: the reader still finds an indicator when one exists`,
        (await readIndicator(page)) !== null);

    } finally {
      await ctx.close();
    }
  }

  // ══ FIT: 1.4x, 360px, the collapse ═══════════════════════════════════════
  //
  // What "fit" means here is precise: the battery must not make the header row
  // WRAP or make the page scroll sideways. It is measured as a BEFORE/AFTER on
  // the same page — the pill's height with no reading, then with one — because
  // that is the only comparison that attributes a change to this feature.
  //
  // Recorded because it will be asked: at 1280px the dashboard header already
  // overruns its viewport WITHOUT any battery (the pill row measures ~1500px
  // against a 1280px window; "Forget this computer" is clipped on a clean
  // checkout). BAT-3 adds 40px to that row and changes nothing about it. That
  // is a pre-existing header-density defect, reported rather than absorbed
  // here, and it is why this arm asserts wrapping and document overflow rather
  // than "the row fits", which would fail on a fault this lane did not cause.
  console.log('\n── fit ──');
  const pillBox = (page) => page.evaluate(() => {
    const pill = document.querySelector('[data-cc-pill="active"]');
    return pill ? { h: Math.round(pill.getBoundingClientRect().height) } : null;
  });

  for (const [label, width, zoom] of [['Large text 1.4x', 1280, 1.4], ['360px at 1.4x', 360, 1.4]]) {
    const { ctx, page } = await open({ theme: 'light', width, zoom });
    try {
      const before = await pillBox(page);
      await sendBattery(page, { pct: 47, charging: true, ts: at(Date.now()) });
      const after = await pillBox(page);
      const i = await readIndicator(page);
      const doc = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label}: the header row does not grow taller — the battery never makes it wrap`,
        before !== null && after !== null && after.h === before.h, `${before?.h} -> ${after?.h}`);
      check(`${label}: the page gains no horizontal scroll`, doc <= 1, `overflow ${doc}`);
      check(`${label}: the indicator renders, and the value is whole in its accessible name`,
        i !== null && /^Phone battery 47%, charging/.test(i.label || ''), i && i.label);
      check(`${label}: the indicator is narrow enough to sit beside a name (< 90 CSS px)`,
        i !== null && i.width > 0 && i.width < 90, `${i && i.width}px`);
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
   *
   * What this arm does NOT prove is the RENDER inside the extension, because
   * the hosted app is not reachable from a gate run. It does not need to: the
   * extension header is <ConnectionStatus variant="compact" />, the same
   * component the web arm drives through every state above. The seam between
   * the two — storage.session to the component — is what is measured here, and
   * that seam is the only part the web arm cannot reach.
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
    await settle(page, 3500);
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
