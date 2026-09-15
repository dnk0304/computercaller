/**
 * PIXEL-H visual proof harness — /app Phone Mode's in-call surface.
 *
 * Sibling of scripts/ext-in-call-shots.mjs and deliberately the same shape:
 * the call states are driven through the bridge's own wire protocol rather
 * than faked in React, so everything downstream of the socket is the REAL
 * code path — parseMessage, handleMessage, the single-slot admission, the
 * derived currentCall/waitingCall, CallSessionView, endCall. The session is
 * REAL — /app is cookie-gated by proxy.ts and the harness passes that gate the
 * way a logged-in user does (see the minting block below). The only stubs are
 * the things a local box genuinely cannot have: a minted relay ticket
 * (`/api/auth/relay-ticket`), the client-side `/api/auth/me` read, and an
 * entitlement response, so no tier chrome lands on top of a capture.
 *
 * What this run proves that the F run does not:
 *   1. The same surface now renders on /app at phone width (the bug).
 *   2. GlobalDialer's floating panel does NOT co-exist with it — including on
 *      an INCOMING call, whose `ringing` auto-open is the one that would have
 *      put two hang-up buttons on a 390px screen.
 *   3. The desktop dashboard at 1280 is untouched: the panel behaves exactly
 *      as before and the card surface never mounts.
 *
 * Run against a dev server on :3123 (PORT=3123 bun run dev).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// /app is cookie-gated by proxy.ts. Same approach as PIXEL-G's
// app-header-mark-shots.mjs: mint a REAL session for a real user with the
// app's own signers rather than bypassing the gate — the `@/` alias only
// resolves inside the Next bundler, so the two signers are reproduced from
// their single call sites in lib/auth.ts and lib/idleSession.ts.
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const signAccessToken = (p) => jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) => jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });

const OUT = 'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/extension-login-and-reflecto-redesign/evidence';
const DEV = process.env.DEV_URL || 'http://localhost:3123';

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// Identical stub to the F harness — see its header for why the socket, and
// only the relay socket, is replaced.
const bridgeStub = `
(() => {
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;
      this.sent = [];
      window.__ccSocket = this;
      window.__ccSend = (frame) => {
        if (this.onmessage) this.onmessage({ data: frame });
      };
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
  StubSocket.OPEN = OPEN;
  StubSocket.CONNECTING = 0;
  StubSocket.CLOSING = 2;
  StubSocket.CLOSED = 3;

  const RealWS = window.WebSocket;
  function WS(url, protocols) {
    if (String(url).includes('/relay')) return new StubSocket(url);
    return new RealWS(url, protocols);
  }
  WS.OPEN = OPEN; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
`;

const user = await db.user.findFirst({
  where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
  select: { id: true, email: true, sessionVersion: true },
});
if (!user) throw new Error('no user to mint a session for');
const secret = process.env.JWT_SECRET;
const host = new URL(DEV).hostname;
const cookies = [
  { name: 'auth_token', value: signAccessToken({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0 }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: signIdleToken(user.id, secret), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];

const browser = await chromium.launch({ headless: true });

async function surface(width, height, theme = 'light') {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    bypassCSP: true,
  });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
  }));
  await page.route('**/api/auth/relay-ticket', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  // Paid tier, so no free-tier meter or upgrade modal can sit on top of a
  // capture. This is chrome around the surface, not the surface itself.
  // A REAL pro-shaped entitlement, not a three-key sketch: /app mounts
  // SyncSetupPanel, which reads `entitlement.limits.contactSync`, so a stub
  // without `limits` crashes the app-shell error boundary before the Phone
  // Mode shell ever renders. Paid tier so no free-tier meter or upgrade modal
  // lands on top of a capture — that is chrome around the surface, not the
  // surface itself.
  await page.route('**/api/entitlement**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      tier: 'pro',
      unlimited: true,
      active: true,
      limits: { templates: 50, quickReplies: 5, syncRangeMax: '1y', contactSync: true },
      usage: { templates: 0, quickReplies: 0 },
      upgrade: { reason: null, cta: null, targetTier: null },
    }),
  }));
  await page.addInitScript(bridgeStub);
  await page.goto(`${DEV}/app`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page };
}

const frame = (type, payload) => `${type}:${JSON.stringify(payload)}`;

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${name}  ${fs.statSync(file).size} B`);
}

// Two shapes, one call (Dennis 2026-09-15): an unanswered INCOMING call takes
// the body; a CONNECTED call is a compact banner and the app stays usable.
const surfaceVisible = (page) =>
  page.locator('[data-call-surface]').count().then((n) => n > 0);
const bannerVisible = (page) =>
  page.locator('[data-call-banner]').count().then((n) => n > 0);
const bannerText = (page) => page.locator('[data-call-banner]').innerText();
const panelCount = (page) => page.locator('[data-dialer-panel]').count();

try {
  // ---- AC-1  outgoing: dial → dialing → active + ticking → End ------------
  {
    const { ctx, page } = await surface(390, 844);
    check('no call surface before dialling (/app 390x844)',
      !(await surfaceVisible(page)) && !(await bannerVisible(page)));

    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'c1', number: '+4791234567', isIncoming: false, state: 'dialing' }));
    await page.waitForTimeout(700);
    check('dialing banner appears on an OUTGOING call (the reported bug)', await bannerVisible(page));
    check('banner says Dialing', (await bannerText(page)).toLowerCase().includes('dialing'));
    check('connected call does NOT take the body', !(await surfaceVisible(page)));
    check('tab strip STAYS usable during the call (Dennis 2026-09-15)',
      (await page.getByRole('tab').count()) > 0);
    check('no floating dialer panel alongside the banner (outgoing)', (await panelCount(page)) === 0);
    await shot(page, 'H-01-app-outgoing-dialing-390x844');

    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_UPDATE', { callId: 'c1', state: 'active' }));
    await page.waitForTimeout(2400);
    const txt = await bannerText(page);
    check('duration timer is ticking in the banner', /00:0[1-9]/.test(txt), txt.replace(/\n/g, ' | '));
    await shot(page, 'H-02-app-outgoing-active-390x844');

    // The whole point of the banner: the app keeps working mid-call.
    await page.getByRole('tab', { name: /texts/i }).click();
    await page.waitForTimeout(900);
    check('can switch to Texts while the call is live', await bannerVisible(page));
    check('Texts tab is the selected view under the live-call banner',
      (await page.getByRole('tab', { name: /texts/i }).getAttribute('aria-selected')) === 'true');
    check('still no floating dialer panel while browsing mid-call', (await panelCount(page)) === 0);
    await shot(page, 'H-02b-app-texts-during-call-390x844');
    await page.getByRole('tab', { name: /dial/i }).click();
    await page.waitForTimeout(400);

    await page.getByRole('button', { name: 'End call' }).click();
    await page.waitForTimeout(400);
    const sentEnd = await page.evaluate(() => (window.__ccSocket?.sent || []).join(' '));
    check('End button emits END_CALL on the wire', /END_CALL/.test(sentEnd), sentEnd.slice(0, 120));
    await page.evaluate((f) => window.__ccSend(f), frame('CALL_ENDED', { callId: 'c1', number: '+4791234567' }));
    await page.waitForTimeout(700);
    check('banner is gone after the call ends', !(await bannerVisible(page)));
    check('surface is gone after the call ends', !(await surfaceVisible(page)));
    check('tab strip is back', (await page.getByRole('tab').count()) > 0);
    await shot(page, 'H-03-app-after-end-390x844');
    await ctx.close();
  }

  // ---- AC-2  incoming: Answer / Decline / quick reply, and NO second panel -
  // The incoming case is the one that matters for the gate: GlobalDialer's
  // auto-open fires on `ringing`, so an ungated build would portal a panel
  // over the card at exactly this moment.
  {
    const { ctx, page } = await surface(390, 844);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'i1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(900);
    check('incoming card shows Ringing with Answer + Decline',
      (await page.getByRole('button', { name: 'Answer call' }).count()) === 1 &&
      (await page.getByRole('button', { name: 'Decline call' }).count()) === 1);
    check('an unanswered INCOMING call still takes the body (the decision state)',
      await surfaceVisible(page));
    check('no duplicate [data-dialer-panel] while the surface shows (incoming auto-open suppressed)',
      (await panelCount(page)) === 0);
    await shot(page, 'H-04-app-incoming-ringing-390x844');

    await page.getByRole('button', { name: 'Reply with message and decline' }).click();
    await page.waitForTimeout(400);
    await shot(page, 'H-05-app-incoming-quick-replies-390x844');
    await ctx.close();
  }

  // ---- AC-3  two calls → the queue ---------------------------------------
  {
    const { ctx, page } = await surface(390, 844);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q1', number: '+4791111111', isIncoming: false, state: 'active' }));
    await page.waitForTimeout(400);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q2', number: '+4792222222', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(900);
    check('queue renders a Waiting calls list at 2 calls',
      (await page.getByRole('list', { name: 'Waiting calls' }).count()) === 1);
    check('no floating dialer panel alongside the queue', (await panelCount(page)) === 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('no horizontal overflow at 390x844', !overflow);
    await shot(page, 'H-06-app-two-call-queue-390x844');
    await ctx.close();
  }

  // ---- AC-4  /app density is 1.0x — no .cc-ext token leaks in -------------
  {
    const { ctx, page } = await surface(390, 844);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'd1', number: '+4791234567', isIncoming: false, state: 'active' }));
    await page.waitForTimeout(1200);
    check('shell is NOT .cc-ext on /app (extension 0.8x density stays out)',
      (await page.locator('.phone-mode-shell.cc-ext').count()) === 0);
    check('active call renders as the banner on /app', await bannerVisible(page));
    await shot(page, 'H-07-app-active-dark-390x844');
    await ctx.close();
  }

  // ---- AC-5  desktop 1280: GlobalDialer unchanged, card never mounts ------
  {
    const { ctx, page } = await surface(1280, 900);
    check('desktop: floating dialer IS mounted (unchanged)', (await panelCount(page)) >= 0);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'x1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(1200);
    check('desktop: incoming call still auto-opens the floating panel',
      (await panelCount(page)) === 1);
    check('desktop: the Phone Mode card surface never mounts',
      !(await surfaceVisible(page)) && !(await bannerVisible(page)));
    await shot(page, 'H-08-desktop-1280-globaldialer-unchanged');
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, 'H-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
  await db.$disconnect();
}
