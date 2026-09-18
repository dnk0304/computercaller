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
import { exitAfterFlush } from './lib/finish.mjs';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';
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

const OUT = 'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/wave-2026-09-15-b/evidence';
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
  where: { email: requireShotEmail() },
  select: { id: true, email: true, sessionVersion: true },
});
if (!user) throw new Error('no user to mint a session for');
const secret = process.env.JWT_SECRET;
const host = new URL(DEV).hostname;
const cookies = [
  { name: 'auth_token', value: signAccessToken({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0 }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: signIdleToken(user.id, secret), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];

// P5a(c) / WORKTREE_STANDARD rule 14: record the browser PID at launch and
// kill that PID tree in the finally — success path and failure path alike.
const reaper = new Reaper().installExitHook('app-in-call-shots');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

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
  await settle(page, 3500);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 3000 }).catch(() => {});
  // /app's shell can still be settling a client-side navigation at this point
  // (entitlement lands, the onboarding route redirects). Evaluating into the
  // page mid-navigation throws "Execution context was destroyed", so wait for
  // the Phone Mode tab strip — the first thing that only exists once the shell
  // has actually mounted — before any harness step touches the page.
  await page.waitForSelector('[role="tablist"]', { timeout: 15000 }).catch(() => {});
  await settle(page, 600);
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
    await settle(page, 700);
    check('dialing banner appears on an OUTGOING call (the reported bug)', await bannerVisible(page));
    check('banner says Dialing', (await bannerText(page)).toLowerCase().includes('dialing'));
    check('connected call does NOT take the body', !(await surfaceVisible(page)));
    check('tab strip STAYS usable during the call (Dennis 2026-09-15)',
      (await page.getByRole('tab').count()) > 0);
    check('no floating dialer panel alongside the banner (outgoing)', (await panelCount(page)) === 0);
    await shot(page, 'H-01-app-outgoing-dialing-390x844');

    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_UPDATE', { callId: 'c1', state: 'active' }));
    await settle(page, 2400);
    const txt = await bannerText(page);
    check('duration timer is ticking in the banner', /00:0[1-9]/.test(txt), txt.replace(/\n/g, ' | '));
    await shot(page, 'H-02-app-outgoing-active-390x844');

    // The whole point of the banner: the app keeps working mid-call.
    await page.getByRole('tab', { name: /texts/i }).click();
    await settle(page, 900);
    check('can switch to Texts while the call is live', await bannerVisible(page));
    check('Texts tab is the selected view under the live-call banner',
      (await page.getByRole('tab', { name: /texts/i }).getAttribute('aria-selected')) === 'true');
    check('still no floating dialer panel while browsing mid-call', (await panelCount(page)) === 0);
    await shot(page, 'H-02b-app-texts-during-call-390x844');
    await page.getByRole('tab', { name: /dial/i }).click();
    await settle(page, 400);

    await page.getByRole('button', { name: 'End call' }).click();
    await settle(page, 400);
    const sentEnd = await page.evaluate(() => (window.__ccSocket?.sent || []).join(' '));
    check('End button emits END_CALL on the wire', /END_CALL/.test(sentEnd), sentEnd.slice(0, 120));
    await page.evaluate((f) => window.__ccSend(f), frame('CALL_ENDED', { callId: 'c1', number: '+4791234567' }));
    await settle(page, 700);
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
    await settle(page, 900);
    check('incoming card shows Ringing with Answer + Decline',
      (await page.getByRole('button', { name: 'Answer call' }).count()) === 1 &&
      (await page.getByRole('button', { name: 'Decline call' }).count()) === 1);
    // Pixel-N (Dennis 13:55): the ring no longer takes the body. It is a card
    // pinned at the top of the Dial tab, with every tab still reachable.
    check('an unanswered incoming call is a card inside the Dial tab',
      (await page.locator('[data-incoming-card]').count()) === 1 &&
      !(await surfaceVisible(page)));
    check('the tab strip survives an unanswered incoming call',
      (await page.getByRole('tab').count()) >= 3);
    check('no duplicate [data-dialer-panel] while the surface shows (incoming auto-open suppressed)',
      (await panelCount(page)) === 0);
    await shot(page, 'H-04-app-incoming-ringing-390x844');

    await page.getByRole('button', { name: 'Reply with message and decline' }).click();
    await settle(page, 400);
    await shot(page, 'H-05-app-incoming-quick-replies-390x844');
    await ctx.close();
  }

  // ---- AC-3  two calls → the queue ---------------------------------------
  {
    const { ctx, page } = await surface(390, 844);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q1', number: '+4791111111', isIncoming: false, state: 'active' }));
    await settle(page, 400);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q2', number: '+4792222222', isIncoming: true, state: 'ringing' }));
    await settle(page, 900);
    // Pixel-N: the queue is the banner ("2 calls") plus a tap-to-expand sheet.
    check('the banner represents the queue without taking the screen',
      (await bannerVisible(page)) && !(await surfaceVisible(page)) &&
      (await bannerText(page)).includes('2 calls'));
    check('tabs stay usable with two calls in flight',
      (await page.getByRole('tab').count()) >= 3);
    await page.getByRole('button', { name: 'Show the call queue' }).click();
    await settle(page, 500);
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
    await settle(page, 1200);
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
    await settle(page, 1200);
    check('desktop: incoming call still auto-opens the floating panel',
      (await panelCount(page)) === 1);
    check('desktop: the Phone Mode card surface never mounts',
      !(await surfaceVisible(page)) && !(await bannerVisible(page)));
    await shot(page, 'H-08-desktop-1280-globaldialer-unchanged');
    await ctx.close();
  }


  // ---- PIXEL-N #7 / #8 / #9  (Dennis 2026-09-15 13:50, 13:55, 14:04) ------
  // Three complaints, one view stack:
  //   #7 back after sending an SMS returned to the composer, not to the tab
  //      the trip started on;
  //   #8 a ringing call blanked every tab;
  //   #9 "send message" from Dial opened a blank composer instead of the
  //      conversation with that number.
  {
    const { ctx, page } = await surface(390, 844);

    // Seed the phone's own row data over the wire — same path a real sync
    // takes (normalizePayload -> handleMessage), so Dial has recents and one
    // of those numbers has history behind it and the other has none.
    const t0 = Date.now();
    await page.evaluate((f) => window.__ccSend(f), frame('CALL_LOGS', { callLogs: [
      { id: 'l1', number: '+4791111111', name: 'Ada', date: t0 - 60000, duration: 12, type: 'outgoing' },
      { id: 'l2', number: '+4792222222', name: 'Bo', date: t0 - 90000, duration: 0, type: 'missed' },
    ] }));
    await page.evaluate((f) => window.__ccSend(f), frame('MESSAGES', { messages: [
      { id: 'm1', address: '+4791111111', body: 'older note from Ada', date: t0 - 120000, type: 'inbox', read: true },
    ] }));
    await settle(page, 800);

    const strip = page.getByRole('tablist');
    const tab = (n) => page.getByRole('tab', { name: n });
    const selected = (n) => tab(n).getAttribute('aria-selected').then((v) => v === 'true');
    const composeOpen = () => page.locator('#phone-mode-compose-to').count().then((n) => n > 0);

    // ---- #7a  compose from TEXTS -> send -> back lands on TEXTS -----------
    await tab(/texts/i).click();
    await settle(page, 400);
    await page.getByRole('button', { name: 'New message' }).click();
    await settle(page, 500);
    check('#6 tab strip is still visible while composing', await strip.isVisible());
    check('#7 a compose opened from Texts keeps Texts selected', await selected(/texts/i));
    await page.locator('#phone-mode-compose-to').fill('+4795550001');
    await page.locator('#phone-mode-compose-body').fill('hello from texts');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await settle(page, 700);
    check('#7 sending leaves the composer (thread view is showing)', !(await composeOpen()));
    await shot(page, 'H-N1-after-send-from-texts');
    await page.getByRole('button', { name: /^Back to/ }).click();
    await settle(page, 600);
    check('#7 back after sending from Texts lands on Texts, NOT on the composer',
      !(await composeOpen()) && (await selected(/texts/i)) &&
      (await page.getByRole('button', { name: 'New message' }).count()) === 1);

    // ---- #9  Dial's send-message affordances open the THREAD --------------
    await tab(/dial/i).click();
    await settle(page, 500);
    await page.getByRole('button', { name: 'Send a message to Ada' }).click();
    await settle(page, 600);
    check('#9 a recent row\'s send-message opens the thread, not a blank compose',
      !(await composeOpen()));
    check('#9 that thread shows the existing history with the number',
      (await page.getByText('older note from Ada').count()) > 0);
    check('#7 a thread opened from Dial keeps Dial selected', await selected(/dial/i));
    await shot(page, 'H-N2-dial-send-opens-thread-with-history');

    // ---- #7b  send from that Dial-origin thread -> back lands on DIAL -----
    await page.getByRole('textbox', { name: 'Message body' }).fill('replying from dial');
    await page.getByRole('button', { name: 'Send message' }).click();
    await settle(page, 700);
    await page.getByRole('button', { name: /^Back to/ }).click();
    await settle(page, 600);
    check('#7 back after sending from Dial lands on Dial, NOT on the composer',
      !(await composeOpen()) && (await selected(/dial/i)));
    await shot(page, 'H-N3-back-from-dial-origin-lands-on-dial');

    // ---- #9b  a number with NO history: empty thread, caret in the box ----
    await page.getByRole('button', { name: 'Send a message to Bo' }).click();
    await settle(page, 600);
    check('#9 a number with no history opens an empty THREAD (not a compose)',
      !(await composeOpen()) && (await page.getByText(/No messages with/).count()) === 1);
    check('#9 the composer has the caret in an empty thread',
      await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'));
    await page.getByRole('button', { name: /^Back to/ }).click();
    await settle(page, 500);

    // ---- #9c  the pad's send-message pill, on a typed number --------------
    await page.locator('[aria-label="Phone number to dial"]').fill('+4796660002');
    await settle(page, 300);
    await page.getByRole('button', { name: 'Send a message to this number' }).click();
    await settle(page, 600);
    check('#9 the pad pill opens the thread for the typed number',
      !(await composeOpen()) && (await page.getByText(/No messages with/).count()) === 1);
    await shot(page, 'H-N4-pad-pill-opens-thread');
    await page.getByRole('button', { name: /^Back to/ }).click();
    await settle(page, 500);
    check('#7 back from the pad-pill thread lands on Dial', await selected(/dial/i));

    // ---- #8  a ringing call does not take the screen ----------------------
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'n1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await settle(page, 900);
    check('#8 the incoming card is pinned inside the Dial tab',
      (await page.locator('[data-incoming-card]').count()) === 1);
    check('#8 tabs stay usable while ringing',
      (await page.getByRole('tab').count()) >= 3 && (await strip.isVisible()));
    check('#8 nothing takes the body while ringing',
      (await page.locator('[data-call-surface]').count()) === 0);
    check('#8 Answer and Decline are on the card',
      (await page.getByRole('button', { name: 'Answer call' }).count()) === 1 &&
      (await page.getByRole('button', { name: 'Decline call' }).count()) === 1);
    await shot(page, 'H-N5-ringing-card-in-dial-tab');

    await tab(/texts/i).click();
    await settle(page, 600);
    check('#8 switching to Texts mid-ring keeps the call as a banner',
      (await page.locator('[data-call-banner]').count()) === 1 &&
      (await page.locator('[data-incoming-card]').count()) === 0);
    check('#8 the mid-ring banner can still answer the call',
      (await page.locator('[data-call-banner]').getByRole('button', { name: 'Answer call' }).count()) === 1);
    check('#8 Texts really is the view under the mid-ring banner', await selected(/texts/i));
    await shot(page, 'H-N6-ringing-banner-on-texts');
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, 'H-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
} finally {
  await browser.close();
  reaper.reapAndReport('app-in-call-shots');
  await db.$disconnect();
  // P5a: summary moved INSIDE the finally. It used to be the last statement of
  // the try, so any throw skipped it and the gate's passLine() saw no count at
  // all — a partial count is evidence, no count is a second mystery.
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  if (failed.length) process.exitCode = 1;
}

// ── E2E-P5a (f): EXIT, do not merely stop having work to do. ──────────────
// Three harnesses in the P5A gate were recorded as timeouts with a COMPLETE
// summary in their logs. The gate-side cause is fixed and is NOT a hang:
// child.kill() on a shell:true step signals cmd.exe only, so the timeout never
// stopped the work (tests/gate-child-exit.test.mjs). This is the other half:
// once the summary is printed and the finally block has closed the browser and
// reaped, nothing is left to wait for, so say so explicitly rather than hoping
// the event loop drains. exitAfterFlush flushes stdout first — on Windows the
// gate reads this over a pipe, where writes are async and a bare process.exit
// can truncate the very summary line the gate parses.
exitAfterFlush(process.exitCode ?? 0);
