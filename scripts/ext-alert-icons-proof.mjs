/**
 * ALERT-ICONS proof harness — the app's real icon on the extension's Alerts
 * cards AND its notification toast, the letter-tile fallback, the messenger
 * SVGs, persistence across a reload, and the in-place swap when an icon
 * arrives after its card.
 *
 * Same stub construction as scripts/ext-in-call-shots.mjs: the REAL /extension
 * surface from a running dev server; /api/auth/me and /api/auth/relay-ticket
 * fulfilled at the network layer; only the relay WebSocket replaced, exposing
 * window.__ccSend(frame) so the harness is the phone speaking.
 *
 * The icon is drawn on a canvas in the page and sent as the 96 px base64 PNG
 * the phone's `icon` field carries — a full-bleed square mark, the shape the
 * old 16 px `object-fit: cover` circle cropped.
 *
 * The toast check is the one built to fail on the old code: before this lane
 * the toast always drew an emoji and never read the icon.
 *
 *   CC_BASE_URL=http://localhost:3291 node scripts/ext-alert-icons-proof.mjs
 *
 * Env: CC_BASE_URL (default http://localhost:3178), CC_OUT (evidence dir),
 * CC_SHOTS=0 to skip screenshots (checks only).
 */
import { chromium } from 'playwright';
import { exitAfterFlush } from './lib/finish.mjs';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.CC_BASE_URL || 'http://localhost:3178';
const OUT = process.env.CC_OUT
  || 'C:/Users/D/.claude/agent-memory/pixel-ux-engineer/PROJECTS/computercaller/ext-alert-icons/evidence';
const SHOTS = process.env.CC_SHOTS !== '0';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const now = Date.now();
const MIN = 60_000;
const note = (id, appName, packageName, title, body, ageMin, extra = {}) => ({
  id, appName, packageName, title, body, timestamp: now - ageMin * MIN,
  hasReply: false, replyKey: '', notificationKey: `k-${id}`, ...extra,
});

/** @param {'light'|'dark'} theme */
const bridgeStub = (theme) => `
(() => {
  try { localStorage.setItem('cc:theme:last', '${theme}'); } catch (e) {}
  // A 96 px launcher icon: full-bleed square, white glyph, accent band.
  window.__ccIcon = () => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = '#4a154b'; g.fillRect(0, 0, 96, 96);
    g.fillStyle = '#ffffff';
    for (const x of [30, 56]) g.fillRect(x, 16, 10, 64);
    for (const y of [30, 56]) g.fillRect(16, y, 64, 10);
    g.fillStyle = '#ecb22e'; g.fillRect(0, 84, 96, 12);
    return c.toDataURL('image/png').split(',')[1];
  };
  window.__ccNotify = (n) => {
    const p = n.icon === '@ICON' ? { ...n, icon: window.__ccIcon() } : n;
    window.__ccSend('PHONE_NOTIFICATION:' + JSON.stringify(p));
  };
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify({ deviceName: 'Pixel 8' }));
      }, 0);
    }
    send() {}
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

const reaper = new Reaper().installExitHook('ext-alert-icons-proof');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

async function newCtx(theme) {
  return browser.newContext({ viewport: { width: 400, height: 640 }, colorScheme: theme, bypassCSP: true });
}
async function open(ctx, theme) {
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { email: 'proof@example.com' } }),
  }));
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  await page.addInitScript(bridgeStub(theme));
  await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 3000);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 4000 }).catch(() => {});
  await settle(page, 400);
  return page;
}
const notify = async (page, n) => { await page.evaluate((x) => window.__ccNotify(x), n); await page.waitForTimeout(120); };
const shot = async (page, name, locator) => {
  if (!SHOTS) return;
  const file = path.join(OUT, `${name}.png`);
  await page.locator(locator).first().screenshot({ path: file });
  console.log(`  shot ${name}`);
};
const toAlerts = async (page) => {
  await page.getByRole('tab', { name: /Alerts/ }).click();
  await page.waitForSelector('.cc-note-card', { timeout: 8000 }).catch(async (e) => {
    console.log('  no cards; panel reads: ' + JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300)));
    throw e;
  });
  await page.waitForTimeout(400);
};
const cardFor = (appName) => `.cc-note-card:has(.cc-note-app:text-is("${appName}"))`;
const TOAST = '[role="alert"]';
const LOGO = 'img[src^="data:image/png;base64,"]';
const boxOf = (loc) => loc.evaluate((el) => {
  const cs = getComputedStyle(el);
  return {
    w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height),
    fit: cs.objectFit, r: cs.borderRadius, alt: el.getAttribute('alt'), hidden: el.getAttribute('aria-hidden'),
    text: el.tagName === 'SPAN' ? el.textContent : null,
  };
});

try {
  for (const theme of ['light', 'dark']) {
    const T = `${theme}:`;
    const ctx = await newCtx(theme);
    let p = await open(ctx, theme);

    // ── 1. frame WITH an icon → the logo in the TOAST ───────────────────────
    await notify(p, note('n1', 'Gmail', 'com.google.android.gm', 'Skatteetaten', 'Your tax assessment for 2025 is now available in Altinn.', 70));
    await notify(p, note('n2', 'WhatsApp', 'com.whatsapp', 'Marta Ruiz', 'Ringte deg nettopp — ta den når du kan.', 30));
    await notify(p, note('n3', 'Slack', 'com.Slack', '#design', 'Vinci: the icon tiles look right at 20px.', 0, { icon: '@ICON' }));
    // Positive control first: the toast IS up, so a missing icon below is the
    // toast's rendering, not a toast that never fired.
    const toastUp = await p.waitForSelector(TOAST, { timeout: 3000 }).then(() => true, () => false);
    check(`${T} toast is shown for the new notification (control)`, toastUp);
    const toastLogo = await p.waitForSelector(`${TOAST} ${LOGO}`, { timeout: 3000 }).then(() => true, () => false);
    check(`${T} toast renders the app's real icon as an <img>`, toastLogo);
    if (toastLogo) {
      const b = await boxOf(p.locator(`${TOAST} ${LOGO}`).first());
      check(`${T} toast icon: 24px, contain, 22% rounded square, alt=""`,
        b.w === 24 && b.fit === 'contain' && b.r === '22%' && b.alt === '', JSON.stringify(b));
    }
    await shot(p, `toast-logo-${theme}`, TOAST);

    // ── 2. the CARDS: logo, letter tile, messenger svg ──────────────────────
    await toAlerts(p);
    const logo = p.locator(`${cardFor('Slack')} ${LOGO}`);
    check(`${T} Alerts card renders the app's real icon as an <img>`, (await logo.count()) === 1);
    if (await logo.count()) {
      const b = await boxOf(logo.first());
      check(`${T} card icon: 20px, contain, 22% rounded square (not a circle), alt=""`,
        b.w === 20 && b.h === 20 && b.fit === 'contain' && b.r === '22%' && b.alt === '', JSON.stringify(b));
    }
    const tile = p.locator(`${cardFor('Gmail')} [data-cc-app-icon="tile"]`);
    check(`${T} card without an icon shows a letter tile`, (await tile.count()) === 1);
    if (await tile.count()) {
      const b = await boxOf(tile.first());
      check(`${T} tile is "G", aria-hidden, same 20px rounded square`,
        b.text === 'G' && b.hidden === 'true' && b.w === 20 && b.r === '22%', JSON.stringify(b));
    }
    const wa = p.locator(`${cardFor('WhatsApp')} img[src$="/messenger-icons/whatsapp.svg"]`);
    check(`${T} WhatsApp card uses the shipped messenger svg`, (await wa.count()) === 1);
    const emoji = await p.locator('.cc-note-card .cc-note-head').evaluateAll((els) =>
      els.some((e) => /\p{Extended_Pictographic}/u.test(e.textContent || '')));
    check(`${T} no emoji glyph left on any card`, !emoji);
    await shot(p, `alerts-cards-${theme}`, '.cc-alerts-list');
    await p.close();

    // ── 3. reload: icon comes back from localStorage, no fallback flash ─────
    p = await open(ctx, theme);
    await notify(p, note('r1', 'Slack', 'com.Slack', '#design', 'After a reload, no icon on this frame.', 2));
    await toAlerts(p);
    check(`${T} after a reload the card still has the icon (persisted per device)`,
      (await p.locator(`${cardFor('Slack')} ${LOGO}`).count()) === 1);
    const stored = await p.evaluate(() => { try { return localStorage.getItem('cc_notif_icons_v1'); } catch { return null; } });
    check(`${T} persisted under cc_notif_icons_v1`, !!stored && stored.includes('com.Slack'));
    await p.close();
    await ctx.close();

    // ── 4. frame WITHOUT an icon → letter tile in the toast ─────────────────
    const ctx2 = await newCtx(theme);
    p = await open(ctx2, theme);
    await notify(p, note('m1', 'Gmail', 'com.google.android.gm', 'Skatteetaten', 'Your tax assessment for 2025 is now available in Altinn.', 0));
    const toastTile = await p.waitForSelector(`${TOAST} [data-cc-app-icon="tile"]`, { timeout: 3000 }).then(() => true, () => false);
    check(`${T} toast without an icon shows the letter tile`, toastTile);
    await shot(p, `toast-tile-${theme}`, TOAST);

    // ── 5. icon arrives LATER → the existing card swaps tile for logo ───────
    await p.waitForTimeout(4300); // let the toast go
    await notify(p, note('q1', 'Slack', 'com.Slack', '#design', 'No icon on this one.', 1));
    await toAlerts(p);
    const q1 = '.cc-note-card:has(.cc-note-title:text-is("#design"))';
    check(`${T} card starts on the tile while no icon is known`,
      (await p.locator(`${q1} [data-cc-app-icon="tile"]`).count()) === 1);
    await notify(p, note('q2', 'Slack', 'com.Slack', '#general', 'This one carries the icon.', 0, { icon: '@ICON' }));
    const swapped = await p.waitForSelector(`${q1} ${LOGO}`, { timeout: 3000 }).then(() => true, () => false);
    check(`${T} the same card swaps to the logo when the icon arrives`, swapped);
    await p.close();
    await ctx2.close();
  }

  fs.writeFileSync(path.join(OUT, 'proof.json'),
    JSON.stringify({ when: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
  reaper.reapAndReport('ext-alert-icons-proof');
}

exitAfterFlush(process.exitCode ?? 0);
