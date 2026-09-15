/**
 * PIXEL-M proof harness — recent-calls history + dial button, and Texts/Alerts
 * font parity with Dial.
 *
 * Runs the REAL /extension surface out of this branch's production build. Two
 * things are stubbed, both at the network boundary and neither of them UI:
 *
 *   1. /api/auth/me → 200, so the shell paints the signed-in surface instead
 *      of the login gate. Same stub scripts/ext-sidepanel-shots.mjs uses.
 *   2. window.WebSocket → a fake relay that opens and immediately replays the
 *      bridge frames a connected phone would send (`TYPE:{json}`, the exact
 *      envelope parseMessage() expects). Without a phone there are no call
 *      logs, no threads and no notifications, and a screenshot of three empty
 *      states proves nothing about type size.
 *
 * Everything downstream of those two — PhoneProvider, the merge/dedupe paths,
 * PhoneModeShell, extension.css — is the shipped code.
 *
 * Output: OUT/<tag>/{dial,texts,alerts}-{360,400}.png plus a measured
 * computed-font-size table printed to stdout, per width, per tab.
 *
 *   node scripts/ext-recent-history-fonts-proof.mjs after
 *   node scripts/ext-recent-history-fonts-proof.mjs before   (on the base ref)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.argv[2] || 'after';
const BASE = process.env.CC_BASE_URL || 'http://localhost:3123';
const OUT = path.join(
  'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/wave-2026-09-15-b/evidence',
  TAG,
);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const now = Date.now();
const MIN = 60_000;

// Two calls to the SAME number so the history accordion has more than one row
// to show, and so the id-keyed expansion is exercised against a duplicate.
const callLogs = [
  { id: 'c1', number: '+4745720075', name: 'Marta Ruiz', date: now - 8 * MIN, duration: 154, type: 'outgoing', simId: '1' },
  { id: 'c2', number: '+4745720075', name: 'Marta Ruiz', date: now - 190 * MIN, duration: 0, type: 'missed', simId: '2' },
  { id: 'c3', number: '+4791827364', name: 'Ola Nordmann', date: now - 40 * MIN, duration: 41, type: 'incoming', simId: '1' },
  { id: 'c4', number: '+34612334455', date: now - 26 * 60 * MIN, duration: 0, type: 'rejected' },
  { id: 'c5', number: '+4740201122', name: 'Skatteetaten', date: now - 3 * 60 * MIN, duration: 620, type: 'outgoing' },
];

const messages = [
  { id: 'm1', address: '+4745720075', body: 'Ringte deg nettopp — ta den når du kan.', date: now - 7 * MIN, type: 'inbox', read: true },
  { id: 'm2', address: '+4791827364', body: 'Sounds good, see you at six.', date: now - 55 * MIN, type: 'inbox', read: true },
  { id: 'm3', address: '+4740201122', body: 'Your reference number is 8842-19. Keep this message for your records.', date: now - 5 * 60 * MIN, type: 'inbox', read: true },
];

const contacts = [
  { id: 'k1', name: 'Marta Ruiz', number: '+4745720075' },
  { id: 'k2', name: 'Ola Nordmann', number: '+4791827364' },
  { id: 'k3', name: 'Skatteetaten', number: '+4740201122' },
];

const notifications = [
  { id: 'n1', appName: 'WhatsApp', packageName: 'com.whatsapp', title: 'Marta Ruiz', body: 'Ringte deg nettopp — ta den når du kan.', timestamp: now - 6 * MIN, hasReply: true, replyKey: 'r', notificationKey: 'k1' },
  { id: 'n2', appName: 'Gmail', packageName: 'com.google.android.gm', title: 'Skatteetaten', body: 'Your tax assessment for 2025 is now available in Altinn.', timestamp: now - 70 * MIN, hasReply: false, replyKey: '', notificationKey: 'k2' },
  { id: 'n3', appName: 'Telegram', packageName: 'org.telegram.messenger', title: 'Dev channel', body: 'Build 482 is green.', timestamp: now - 4 * 60 * MIN, hasReply: true, replyKey: 'r', notificationKey: 'k3' },
];

const simList = [
  { id: 1, slot: 0, name: 'Telia', number: '+4745720075' },
  { id: 2, slot: 1, name: 'Telenor', number: '+4740201122' },
];

const bootScript = `
(() => {
  // ---- session ----------------------------------------------------------
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    // The bridge refuses to open a socket until a relay ticket resolves —
    // deliberately, see usePhoneBridge's "MUST NOT attempt the WS" note. Hand
    // it one so the real connect path runs against the fake relay below.
    if (url.includes('/api/auth/relay-ticket')) {
      return Promise.resolve(new Response(JSON.stringify({ ticket: 'stub-ticket' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  // ---- fake relay -------------------------------------------------------
  const FRAMES = ${JSON.stringify([
    ['LOBBY_STATUS', { phonePresent: true }],
    ['SIM_LIST', { sims: simList, simList }],
    ['STATUS', { connected: true, battery: 82, signal: 4 }],
    ['CONTACTS', { contacts }],
    ['MESSAGES', { messages }],
    ['CALL_LOGS', { callLogs }],
    ...notifications.map((n) => ['PHONE_NOTIFICATION', n]),
  ])};

  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({});
        let t = 40;
        for (const [type, payload] of FRAMES) {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: type + ':' + JSON.stringify(payload) });
          }, t);
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

// The type tokens Dennis compared. Read as COMPUTED px off the live DOM, not
// off the class names, so a missed remap shows up as a number.
const MEASURE = `
(() => {
  const px = (el) => el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
  const q = (sel) => document.querySelector(sel);
  const out = {};
  const active = document.querySelector('[role="tabpanel"], .cc-msg-view, .cc-dial-column') || document.body;
  // First row title and first row meta line in whatever list is on screen.
  const titles = active.querySelectorAll('p.truncate, h2');
  out.heading = px(active.querySelector('h2'));
  out.rowTitle = px(titles[0] === active.querySelector('h2') ? titles[1] : titles[0]);
  const metas = active.querySelectorAll('li p:nth-of-type(2), li p + p');
  out.rowMeta = px(metas[0]);
  out.input = px(active.querySelector('input'));
  out.avatar = (() => {
    const a = active.querySelector('li div[class*="rounded-full"]');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return Math.round(r.width) + 'x' + Math.round(r.height);
  })();
  return out;
})()
`;

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [360, 400]) {
    for (const tab of ['Dial', 'Texts', 'Alerts']) {
      const page = await browser.newPage();
      await page.addInitScript(bootScript);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      if (tab !== 'Dial') {
        await page.getByRole('tab', { name: new RegExp(tab) }).click();
        await page.waitForTimeout(700);
      } else if (TAG === 'after') {
        // Open the history accordion on the first recent row so the shot
        // shows the thing Dennis asked for, not just the row.
        const row = page.locator('li [role="button"][aria-expanded]').first();
        if (await row.count()) { await row.click(); await page.waitForTimeout(500); }
      }

      const m = await page.evaluate(MEASURE);
      console.log(`  ${tab} @${width}px  ` + JSON.stringify(m));
      const file = path.join(OUT, `${tab.toLowerCase()}-${width}.png`);
      await page.screenshot({ path: file });
      const bytes = fs.statSync(file).size;
      check(`${tab} @${width}px captured`, bytes > 5000, `${bytes} B`);
      await page.close();
    }
  }

  if (TAG === 'after') {
    // ---- behaviour, proved not asserted ----------------------------------
    const page = await browser.newPage();
    await page.addInitScript(bootScript);
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const dialBtns = page.getByRole('button', { name: /^Call .+/ });
    check('recent rows carry a dial button', (await dialBtns.count()) > 0, `${await dialBtns.count()} found`);

    const box = await dialBtns.first().boundingBox();
    // Hit target, not box size: the after-pseudo bleeds it to 40px.
    const target = await dialBtns.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, '::after');
      const inset = Math.abs(parseFloat(a.insetBlockStart || a.top || '0')) || 0;
      return { w: r.width + inset * 2, h: r.height + inset * 2 };
    });
    check('dial button hit target >= 40px',
      target.w >= 39.5 && target.h >= 39.5,
      `box ${Math.round(box.width)}x${Math.round(box.height)} → target ${Math.round(target.w)}x${Math.round(target.h)}`);

    const rowBtn = page.locator('li [role="button"][aria-expanded]').first();
    check('recent row is an expandable history trigger', (await rowBtn.count()) > 0);
    await rowBtn.click();
    await page.waitForTimeout(500);
    check('row reports aria-expanded=true after tap',
      (await rowBtn.getAttribute('aria-expanded')) === 'true');
    // Marta has two calls; the accordion must show both.
    const histRows = page.locator('li ul li');
    check('history accordion lists every call with that number',
      (await histRows.count()) >= 2, `${await histRows.count()} entries`);

    // Copy affordance (2026-07-27) must survive.
    const selectable = await rowBtn.locator('p.select-text').count();
    check('click-drag-to-copy affordance survives', selectable > 0);
    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (evidence: ${OUT})`);
process.exit(failed.length ? 1 : 0);
