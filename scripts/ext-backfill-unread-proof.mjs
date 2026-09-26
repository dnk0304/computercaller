/**
 * ITEM-8 proof, web half: backfilled alerts count as UNREAD until opened or
 * dismissed (Dennis 2026-09-26), on the REAL /extension surface.
 *
 * Ken's timeline (DISPATCH-BRIEF-FORGE-BACKFILL-UNREAD-8.md):
 *   connect with 5 shade cards → 5 → open 1 → 4 → dismiss 1 → 3
 *   → reconnect → still 3 → phone removes 1 → 2
 * plus the tab round trips Dial↔Texts↔Alerts, which must neither clear nor
 * invent a count (the d8c7aa4 phantom), and d8c7aa4's identity rule.
 *
 * Construction: same stub as scripts/ext-alert-icons-proof.mjs — the real page
 * from a running server, /api/auth/me and /api/auth/relay-ticket fulfilled at
 * the network layer, only the relay WebSocket replaced (window.__ccSend is the
 * phone). "Reconnect" is a NEW page in the SAME browser context: the list
 * starts empty and the phone replays its whole shade, exactly what a panel
 * re-open or reload does, with localStorage (the read marks) carried over.
 *
 * The extension-badge half (the worker's set + marks) is
 * scripts/ext-badge-counter-proof.mjs sections 15-16.
 *
 *   CC_BASE_URL=http://localhost:3178 node scripts/ext-backfill-unread-proof.mjs
 */
import { chromium } from 'playwright';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';

const BASE = process.env.CC_BASE_URL || 'http://localhost:3178';
const USER_ID = 'u-item8-web-proof';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + JSON.stringify(detail) : ''}`);
};

const stub = `
(() => {
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;
      window.__ccSent = window.__ccSent || [];
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify({ deviceName: 'Pixel 8' }));
      }, 0);
    }
    send(f) { window.__ccSent.push(String(f)); }
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

const T0 = Date.now() - 3 * 3_600_000;
const SHADE = [1, 2, 3, 4, 5].map((i) => ({
  id: `bf${i}`, appName: 'WhatsApp', packageName: 'com.whatsapp',
  title: `Sender ${i}`, body: `shade message number ${i}`,
  notificationKey: `0|com.whatsapp|${i}`, hasReply: false, replyKey: '',
  backfill: true, postedAt: T0 + i * 60_000,
}));
const keyOf = (i) => `0|com.whatsapp|${i}`;

const reaper = new Reaper().installExitHook('ext-backfill-unread-proof');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

const ctx = await browser.newContext({ viewport: { width: 400, height: 640 }, bypassCSP: true });
const errors = [];

async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/auth/me', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { id: USER_ID, email: 'proof@example.com' } }),
  }));
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  await page.addInitScript(stub);
  await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 3000);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 4000 }).catch(() => {});
  await settle(page, 400);
  return page;
}
const send = async (page, frames) => {
  await page.evaluate((fs) => { for (const f of fs) window.__ccSend(f); }, frames);
  await page.waitForTimeout(700); // 200 ms flush + render
};
const notif = (n) => 'PHONE_NOTIFICATION:' + JSON.stringify(n);
const replayShade = (page) => send(page, SHADE.map(notif));
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(name) });
const goTab = async (page, name) => { await tab(page, name).click(); await page.waitForTimeout(350); };
/** The Alerts tab's badge number, or 0 when no badge is rendered. */
const alertsBadge = async (page) => {
  const b = tab(page, 'Alerts').locator('.cc-tab-badge');
  if ((await b.count()) === 0) return 0;
  return Number((await b.first().textContent()) || '0');
};
const dots = (page) => page.locator('.cc-note-card[data-cc-unread="1"]').count();
const cards = (page) => page.locator('.cc-note-card').count();
const cardByTitle = (page, title) => page.locator(`.cc-note-card:has(.cc-note-title:text-is("${title}"))`);

try {
  let p = await open();

  // ── connect: the phone replays 5 cards from its shade ─────────────────────
  await replayShade(p);
  const b0 = await alertsBadge(p);
  check('connect, 5 in the shade: Alerts tab badge 5 (on Dial)', b0 === 5, b0);
  check('backfill raises no toast', (await p.locator('[role="alert"]').count()) === 0);
  await goTab(p, 'Alerts');
  check('on Alerts: 5 cards, 5 dots — visiting the tab reads nothing', (await cards(p)) === 5 && (await dots(p)) === 5,
    { cards: await cards(p), dots: await dots(p) });

  // ── tab round trips: no clear, no phantom ─────────────────────────────────
  const trip = [];
  for (const t of ['Dial', 'Texts', 'Alerts', 'Dial', 'Alerts', 'Texts']) {
    await goTab(p, t);
    trip.push({ t, badge: t === 'Alerts' ? null : await alertsBadge(p), dots: t === 'Alerts' ? await dots(p) : null });
  }
  console.log('   ', JSON.stringify(trip));
  check('tab round trips Dial↔Texts↔Alerts: badge 5 off-tab, 5 dots on-tab, every stop',
    trip.every((r) => (r.badge === null || r.badge === 5) && (r.dots === null || r.dots === 5)), trip);

  // ── open 1 ⇒ 4 ────────────────────────────────────────────────────────────
  await goTab(p, 'Alerts');
  await cardByTitle(p, 'Sender 1').locator('.cc-note-text').click();
  await p.waitForTimeout(300);
  const d1 = await dots(p);
  await goTab(p, 'Dial');
  const b1 = await alertsBadge(p);
  check('open 1 ⇒ 4 dots and badge 4 (one definition)', d1 === 4 && b1 === 4, { dots: d1, badge: b1 });

  // ── dismiss 1 ⇒ 3 ─────────────────────────────────────────────────────────
  await goTab(p, 'Alerts');
  await cardByTitle(p, 'Sender 3').locator('.cc-note-dismiss').click();
  await p.waitForTimeout(300);
  const d2 = await dots(p);
  const c2 = await cards(p);
  await goTab(p, 'Texts');
  const b2 = await alertsBadge(p);
  check('dismiss 1 ⇒ 4 cards, 3 dots, badge 3', c2 === 4 && d2 === 3 && b2 === 3, { cards: c2, dots: d2, badge: b2 });
  const sentDismiss = await p.evaluate(() => (window.__ccSent || []).some((f) => f.startsWith('NOTIFICATION_DISMISS') || f.includes('NOTIFICATION_DISMISS')));
  check('the dismissal was sent to the phone (control)', sentDismiss);

  const stored = await p.evaluate((k) => localStorage.getItem(k), `cc-alert-read:v1:${USER_ID}`);
  const marks = stored ? JSON.parse(stored) : [];
  check('read marks persisted per account: 2 records', Array.isArray(marks) && marks.length === 2, marks);
  check('marks hold no notification text', !!stored && !stored.includes('shade message') && !stored.includes('Sender'), stored);
  await p.close();

  // ── reconnect: new page, phone replays its WHOLE shade (the dismissed
  //    card included — its cancel has not reached the phone yet) ⇒ still 3 ──
  p = await open();
  await replayShade(p);
  const b3 = await alertsBadge(p);
  await goTab(p, 'Alerts');
  const d3 = await dots(p);
  check('reconnect + full replay ⇒ badge 3 and 3 dots (read stays read)', b3 === 3 && d3 === 3, { badge: b3, dots: d3 });
  const readTitles = await p.locator('.cc-note-card:not([data-cc-unread])  .cc-note-title').allTextContents();
  check('the opened and the dismissed cards are the undotted ones', readTitles.sort().join(',') === 'Sender 1,Sender 3', readTitles);
  // A second reconnect replay changes nothing.
  await replayShade(p);
  check('a second replay changes nothing', (await dots(p)) === 3 && (await cards(p)) === 5);

  // ── phone removes 1 ⇒ 2 ───────────────────────────────────────────────────
  await send(p, ['NOTIFICATION_REMOVED:' + JSON.stringify({ notificationKey: keyOf(5) })]);
  const d4 = await dots(p);
  await goTab(p, 'Dial');
  const b4 = await alertsBadge(p);
  check('phone removes 1 ⇒ 2 dots, badge 2', d4 === 2 && b4 === 2, { dots: d4, badge: b4 });

  // ── d8c7aa4 identity rule kept ────────────────────────────────────────────
  const repost = { ...SHADE[0], id: 'live1', backfill: undefined, postedAt: undefined, timestamp: Date.now() };
  await send(p, [notif(repost)]);
  check('identical LIVE re-post of the opened alert stays read ⇒ 2', (await alertsBadge(p)) === 2, await alertsBadge(p));
  await send(p, [notif({ ...repost, id: 'live2', body: 'a genuinely new message' })]);
  check('new content under the same key is news ⇒ 3', (await alertsBadge(p)) === 3, await alertsBadge(p));

  check('no page errors', errors.length === 0, errors.slice(0, 3));
} finally {
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  reaper.reapAndReport('ext-backfill-unread-proof');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
