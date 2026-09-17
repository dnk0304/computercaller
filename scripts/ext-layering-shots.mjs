/**
 * PIXEL-Q proof harness — four-level surface layering + the Alerts card list.
 *
 * Runs the REAL /extension surface out of a running server on this branch.
 * Two things are stubbed, both at the network boundary, neither of them UI:
 *
 *   1. /api/auth/me → 200, so the shell paints the signed-in surface.
 *   2. window.WebSocket → a fake relay replaying the bridge frames a connected
 *      phone would send. Without a phone there are no call logs, no threads and
 *      no notifications, and a screenshot of three empty states proves nothing
 *      about layering.
 *
 * Everything downstream — PhoneProvider, PhoneModeShell, extension.css — is the
 * shipped code. Theme is driven through the REAL mechanism Pixel-J built:
 * localStorage['cc:theme:last'], read by THEME_BOOT_SCRIPT before first paint.
 *
 *   node scripts/ext-layering-shots.mjs            # extension surface
 *   node scripts/ext-layering-shots.mjs app        # /app gate captures only
 *
 * Env: CC_BASE_URL (default http://localhost:3178), CC_OUT_TAG (default
 * "layering").
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// CC_SHOT_EMAIL is now REQUIRED (2026-09-17, dispatch
// forge/w-strip-email-literals): the personal address that used to be the
// default was a hardcoded literal in the repo. Set it when running shots.
function requireShotEmail() {
  const v = process.env.CC_SHOT_EMAIL;
  if (!v) throw new Error('CC_SHOT_EMAIL must be set (screenshot account email)');
  return v;
}


const MODE = process.argv[2] || 'ext';
const BASE = process.env.CC_BASE_URL || 'http://localhost:3178';
const TAG = process.env.CC_OUT_TAG || 'layering';
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
  { id: 'n4', appName: 'Slack', packageName: 'com.Slack', title: '#design', body: 'Vinci: the layering addendum is in §3.1 now.', timestamp: now - 9 * 60 * MIN, hasReply: true, replyKey: 'r', notificationKey: 'k4' },
];
const simList = [
  { id: 1, slot: 0, name: 'Telia', number: '+4745720075' },
  { id: 2, slot: 1, name: 'Telenor', number: '+4740201122' },
];

const FRAMES = JSON.stringify([
  ['LOBBY_STATUS', { phonePresent: true }],
  ['SIM_LIST', { sims: simList, simList }],
  ['STATUS', { connected: true, battery: 82, signal: 4 }],
  ['CONTACTS', { contacts }],
  ['MESSAGES', { messages }],
  ['CALL_LOGS', { callLogs }],
  ...notifications.map((n) => ['PHONE_NOTIFICATION', n]),
]);

/** @param {'light'|'dark'|null} theme */
const boot = (theme, authed = true) => `
(() => {
  ${theme ? `try { localStorage.setItem('cc:theme:last', '${theme}'); } catch (e) {}` : ''}
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(
        ${authed} ? JSON.stringify({ user: { email: 'dennis@computercaller.com' } }) : '{}',
        { status: ${authed ? 200 : 401}, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/auth/relay-ticket')) {
      return Promise.resolve(new Response(JSON.stringify({ ticket: 'stub-ticket' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
  const FRAMES = ${FRAMES};
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

/**
 * Reads the ladder back off the LIVE DOM as computed colours, so a band that
 * silently kept its old white is a value in the table, not a thing you have to
 * spot in a PNG.
 */
const MEASURE_LADDER = `
(() => {
  const bg = (el) => el ? getComputedStyle(el).backgroundColor : null;
  const q = (s) => document.querySelector(s);
  return {
    L0_header: bg(q('.cc-ext-header')),
    L1_tabs:   bg(q('[role="tablist"]')),
    L1_band:   bg(q('.cc-band')),
    L2_ground: bg(q('.cc-msg-view, .cc-dial-column')),
    L3_card:   bg(q('.cc-note-card, .cc-list')),
    hairline:  q('[role="tablist"]') ? getComputedStyle(q('[role="tablist"]')).borderBottomColor : null,
    wordmark_in_header: !!q('.cc-ext-header svg[data-cc-lockup], .cc-ext-header .cc-lockup'),
  };
})()
`;

const browser = await chromium.launch({ headless: true });

async function page_(theme, { authed = true, width = 400, height = 900, url = '/extension' } = {}) {
  const page = await browser.newPage();
  await page.addInitScript(boot(theme, authed));
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5200); // past the 4s notification toast, which otherwise covers the header
  return page;
}

try {
  if (MODE === 'app') {
    // ---- THE HARD GATE: /app must render byte-identically ------------------
    // /app is cookie-gated by proxy.ts, so a client-side /api/auth/me stub only
    // ever captures the LOGIN page — which would pass this gate while proving
    // nothing about the dashboard. Mint a real session the way
    // scripts/app-header-mark-shots.mjs does.
    // Best effort: a local Postgres is not always reachable from a worktree, and
    // when it is not the capture falls back to the login gate. Say which one
    // happened in the proof rather than letting an identical pair of login
    // screenshots quietly stand in for the dashboard.
    let cookies = [];
    let minted = false;
    try {
      const jwt = (await import('jsonwebtoken')).default;
      const { PrismaClient } = await import('@prisma/client');
      const db = new PrismaClient();
      const user = await db.user.findFirst({
        where: { email: requireShotEmail() },
        select: { id: true, email: true, sessionVersion: true },
      });
      const secret = process.env.JWT_SECRET;
      const host = new URL(BASE).hostname;
      if (user && secret) {
        cookies = [
          { name: 'auth_token', value: jwt.sign({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0, purpose: 'access' }, secret, { expiresIn: '30d' }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
          { name: 'idle_token', value: jwt.sign({ userId: user.id, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
        ];
        minted = true;
      }
      await db.$disconnect();
    } catch (e) {
      console.log('  (no local DB — capturing the /app login gate instead: ' + String(e).slice(0, 80) + ')');
    }
    check('/app capture is the signed-in dashboard (else: the login gate)', minted, minted ? 'session minted' : 'FALLBACK — login gate only');
    for (const [name, width, height] of [['app-desktop', 1280, 900], ['app-phonemode', 390, 820]]) {
      const ctx = await browser.newContext({ viewport: { width, height }, bypassCSP: true });
      if (cookies.length) await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.addInitScript(boot(null, true));
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(6500);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`  shot ${name}  ${width}x${height}  ${fs.statSync(file).size} B`);
      await ctx.close();
    }
  } else {
    for (const theme of ['light', 'dark']) {
      for (const width of [360, 400]) {
        // --- Dial ---------------------------------------------------------
        let p = await page_(theme, { width });
        await p.screenshot({ path: path.join(OUT, `dial-${theme}-${width}.png`) });
        if (width === 400) {
          const ladder = await p.evaluate(MEASURE_LADDER);
          console.log(`  ladder ${theme}: ` + JSON.stringify(ladder));
          // ADJACENT-distinct, not all-distinct: in light the ladder runs
          // white → grey → grey and then RETURNS to white at L3, which is the
          // point (the card is the surface furthest from its ground). L0 and
          // L3 sharing a value there is the design, not a collision — they are
          // never adjacent.
          const steps = [ladder.L0_header, ladder.L1_tabs, ladder.L2_ground, ladder.L3_card];
          const adjacentOk = steps.every((v, i) => i === 0 || v !== steps[i - 1]);
          check(`${theme}: every adjacent pair in the L0→L3 ladder differs`, adjacentOk, steps.join(' | '));
          check(`${theme}: no wordmark inside the panel header`, ladder.wordmark_in_header === false);
        }
        await p.close();

        // --- Texts + thread ------------------------------------------------
        p = await page_(theme, { width });
        await p.getByRole('tab', { name: /Texts/ }).click();
        await p.waitForTimeout(700);
        await p.screenshot({ path: path.join(OUT, `texts-${theme}-${width}.png`) });
        const thread = p.locator('li > button').first();
        if (await thread.count()) {
          await thread.click();
          await p.waitForTimeout(700);
          await p.screenshot({ path: path.join(OUT, `thread-${theme}-${width}.png`) });
        }
        await p.close();

        // --- Compose -------------------------------------------------------
        p = await page_(theme, { width });
        await p.getByRole('tab', { name: /Texts/ }).click();
        await p.waitForTimeout(500);
        await p.getByRole('button', { name: /New message/i }).click();
        await p.waitForTimeout(600);
        await p.screenshot({ path: path.join(OUT, `compose-${theme}-${width}.png`) });
        await p.close();

        // --- Alerts: cards, then search ------------------------------------
        p = await page_(theme, { width });
        await p.getByRole('tab', { name: /Alerts/ }).click();
        await p.waitForTimeout(700);
        await p.screenshot({ path: path.join(OUT, `alerts-${theme}-${width}.png`) });

        const cardsBefore = await p.locator('.cc-note-card').count();
        const search = p.locator('#cc-alerts-search');
        await search.fill('altinn');
        await p.waitForTimeout(400);
        const cardsAfter = await p.locator('.cc-note-card').count();
        await p.screenshot({ path: path.join(OUT, `alerts-search-${theme}-${width}.png`) });
        if (width === 400) {
          check(`${theme}: one card per notification`, cardsBefore === notifications.length, `${cardsBefore} cards`);
          check(`${theme}: search narrows the list`, cardsAfter === 1 && cardsAfter < cardsBefore, `${cardsBefore} → ${cardsAfter}`);
          await search.fill('zzzznope');
          await p.waitForTimeout(350);
          const empty = await p.getByText('No notifications match').count();
          check(`${theme}: empty state reads "No notifications match"`, empty === 1);
          await p.screenshot({ path: path.join(OUT, `alerts-search-empty-${theme}-${width}.png`) });
          await search.fill('');
          await p.waitForTimeout(350);

          // --- card actions still fire ------------------------------------
          await p.getByRole('button', { name: 'Reply' }).first().click();
          await p.waitForTimeout(300);
          const replyOpen = await p.locator('.cc-note-reply-field').count();
          check(`${theme}: Reply opens an inline reply field`, replyOpen === 1);
          await p.screenshot({ path: path.join(OUT, `alerts-reply-${theme}-${width}.png`) });
          await p.keyboard.press('Escape');
          await p.waitForTimeout(250);
          const n0 = await p.locator('.cc-note-card').count();
          await p.getByRole('button', { name: /^Dismiss notification from/ }).first().click();
          await p.waitForTimeout(400);
          const n1 = await p.locator('.cc-note-card').count();
          check(`${theme}: dismiss removes the card`, n1 === n0 - 1, `${n0} → ${n1}`);
        }
        await p.close();

        // --- signed out / login shell ---------------------------------------
        p = await page_(theme, { width, authed: false, url: '/extension/login' });
        await p.screenshot({ path: path.join(OUT, `signedout-${theme}-${width}.png`) });
        await p.close();
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'Q-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
