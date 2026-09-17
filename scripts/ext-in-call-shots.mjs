/**
 * PIXEL-F visual proof harness — the extension's in-call surface.
 *
 * There is no paired Android phone in CI, so the call states are driven
 * through the bridge's own wire protocol instead of being faked in React:
 * `window.WebSocket` is replaced with a stub that speaks the relay's
 * `TYPE:{json}` frames. Everything downstream of the socket is the REAL code
 * path — parseMessage, handleMessage, the single-slot admission, the derived
 * currentCall/waitingCall, CallSessionView, endCall. The only two things
 * stubbed are the two things a local box genuinely cannot have: a signed-in
 * session (`/api/auth/me`) and a minted relay ticket
 * (`/api/auth/relay-ticket`).
 *
 * Run against a dev server on :3123 (bun run dev with PORT=3123).
 */
import { chromium } from 'playwright';
import { Reaper } from './lib/reap.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/wave-2026-09-15-b/evidence';
const DEV = process.env.DEV_URL || 'http://localhost:3123';

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// The init script: session + ticket stubs, then a WebSocket stand-in that
// exposes window.__ccSend(frame) so the test can push relay frames at will.
// ---------------------------------------------------------------------------
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
        // Pair immediately so isConnected flips true and the surface renders.
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

  // Only the relay socket is stubbed. Next's HMR socket must stay real or the
  // dev page never finishes booting.
  const RealWS = window.WebSocket;
  function WS(url, protocols) {
    if (String(url).includes('/relay')) return new StubSocket(url);
    return new RealWS(url, protocols);
  }
  WS.OPEN = OPEN; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
`;

// P5a(c) / WORKTREE_STANDARD rule 14: record the browser PID at launch and
// kill that PID tree in the finally — success path and failure path alike.
const reaper = new Reaper().installExitHook('ext-in-call-shots');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

async function surface(width, height, theme = 'light') {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    // The app ships a strict CSP without 'unsafe-eval'; Playwright's init
    // scripts are evaluated as strings, so without this the stub never runs
    // AND the page's own bundle dies on the same violation.
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  // The session and the relay ticket are intercepted at the NETWORK layer, not
  // by patching window.fetch: Next's client bundle captures its fetch reference
  // before any init script can replace it, so a page-level override is simply
  // never called (measured — the real 401 still went out).
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
  }));
  await page.route('**/api/auth/relay-ticket', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  await page.addInitScript(bridgeStub);
  await page.goto(`${DEV}/extension`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  // Pairing legitimately auto-opens the Full Sync panel (a lobby→active edge,
  // product behaviour since Dennis asked for it). A real user dismisses it;
  // so does the harness, or it would sit on top of every capture.
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { ctx, page };
}

const frame = (type, payload) => `${type}:${JSON.stringify(payload)}`;

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${name}  ${fs.statSync(file).size} B`);
  return fs.statSync(file).size;
}

// Two shapes, one call (Dennis 2026-09-15): an unanswered INCOMING call takes
// the body; a CONNECTED call is a compact banner and the app stays usable.
const surfaceVisible = (page) =>
  page.locator('[data-call-surface]').count().then((n) => n > 0);
const bannerVisible = (page) =>
  page.locator('[data-call-banner]').count().then((n) => n > 0);
const bannerText = (page) => page.locator('[data-call-banner]').innerText();

try {
  // ---- AC-1  outgoing: dial → dialing card → active + ticking timer → End --
  {
    const { ctx, page } = await surface(400, 600);
    check('no call surface before dialling', !(await surfaceVisible(page)));

    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'c1', number: '+4791234567', isIncoming: false, state: 'dialing' }));
    await page.waitForTimeout(600);
    check('dialing banner appears on an OUTGOING call (the reported bug)', await bannerVisible(page));
    check('banner says Dialing', (await bannerText(page)).toLowerCase().includes('dialing'));
    check('connected call does NOT take the body', !(await surfaceVisible(page)));
    check('tab strip STAYS usable during the call (Dennis 2026-09-15)',
      (await page.getByRole('tab').count()) > 0);
    await shot(page, 'F-01-outgoing-dialing-400x600');

    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_UPDATE', { callId: 'c1', state: 'active' }));
    await page.waitForTimeout(2400);
    const txt = await bannerText(page);
    check('duration timer is ticking in the banner', /00:0[1-9]/.test(txt), txt.replace(/\n/g, ' | '));
    await shot(page, 'F-02-outgoing-active-400x600');

    // The whole point of the banner: the app keeps working mid-call.
    await page.getByRole('tab', { name: /texts/i }).click();
    await page.waitForTimeout(800);
    check('can switch to Texts while the call is live', await bannerVisible(page));
    check('Texts tab is the selected view under the live-call banner',
      (await page.getByRole('tab', { name: /texts/i }).getAttribute('aria-selected')) === 'true');
    await shot(page, 'F-02b-texts-during-call-400x600');
    await page.getByRole('tab', { name: /dial/i }).click();
    await page.waitForTimeout(400);

    // End from the extension — the half Dennis could not do at all.
    await page.getByRole('button', { name: 'End call' }).click();
    await page.waitForTimeout(400);
    const sentEnd = await page.evaluate(() => (window.__ccSocket?.sent || []).join(' '));
    check('End button emits END_CALL on the wire', /END_CALL/.test(sentEnd), sentEnd.slice(0, 120));
    await page.evaluate((f) => window.__ccSend(f), frame('CALL_ENDED', { callId: 'c1', number: '+4791234567' }));
    await page.waitForTimeout(700);
    check('banner is gone after the call ends', !(await bannerVisible(page)));
    check('surface is gone after the call ends', !(await surfaceVisible(page)));
    check('tab strip is back', (await page.getByRole('tab').count()) > 0);
    await shot(page, 'F-03-after-end-back-to-dial-400x600');
    await ctx.close();
  }

  // ---- AC-2  incoming: Answer / Decline / quick reply ----------------------
  {
    const { ctx, page } = await surface(400, 900);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'i1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(700);
    check('incoming card shows Ringing with Answer + Decline',
      (await page.getByRole('button', { name: 'Answer call' }).count()) === 1 &&
      (await page.getByRole('button', { name: 'Decline call' }).count()) === 1);
    // Pixel-N: the ring is a CARD at the top of Dial now, never a takeover.
    check('an unanswered incoming call is a card inside the Dial tab',
      (await page.locator('[data-incoming-card]').count()) === 1 &&
      (await page.locator('[data-call-surface]').count()) === 0);
    check('the tab strip survives an unanswered incoming call',
      (await page.getByRole('tab').count()) >= 3);
    await shot(page, 'F-04-incoming-ringing-400x900');

    await page.getByRole('button', { name: 'Reply with message and decline' }).click();
    await page.waitForTimeout(400);
    await shot(page, 'F-05-incoming-quick-replies-400x900');
    await ctx.close();
  }

  // ---- AC-3  two calls → the queue ---------------------------------------
  {
    const { ctx, page } = await surface(400, 900);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q1', number: '+4791111111', isIncoming: false, state: 'active' }));
    await page.waitForTimeout(400);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'q2', number: '+4792222222', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(700);
    // Pixel-N: the queue is the banner ("2 calls") plus a tap-to-expand
    // sheet — no takeover. The list only exists once the sheet is open.
    check('the banner represents the queue without taking the screen',
      (await page.locator('[data-call-banner]').count()) === 1 &&
      (await page.locator('[data-call-surface]').count()) === 0 &&
      (await page.locator('[data-call-banner]').innerText()).includes('2 calls'));
    check('tabs stay usable with two calls in flight',
      (await page.getByRole('tab').count()) >= 3);
    await page.getByRole('button', { name: 'Show the call queue' }).click();
    await page.waitForTimeout(500);
    check('queue renders a Waiting calls list at 2 calls',
      (await page.getByRole('list', { name: 'Waiting calls' }).count()) === 1);
    await shot(page, 'F-06-two-call-queue-400x900');
    await ctx.close();
  }

  // ---- AC-4  geometry + theme: nothing assumes a height -------------------
  for (const [w, h, theme, name] of [
    [400, 420, 'light', 'F-07-active-short-400x420-light'],
    [400, 900, 'dark', 'F-08-active-400x900-dark'],
    [760, 900, 'light', 'F-09-active-760x900-light'],
    [760, 900, 'dark', 'F-10-active-760x900-dark'],
  ]) {
    const { ctx, page } = await surface(w, h, theme);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'g1', number: '+4791234567', isIncoming: false, state: 'active' }));
    await page.waitForTimeout(1400);
    check(`call banner holds at ${w}x${h} (${theme})`, await bannerVisible(page));
    // A surface taller than its own frame is the AC-2-class bug this guards.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`no horizontal overflow at ${w}x${h}`, !overflow);
    await shot(page, name);
    await ctx.close();
  }

  // ---- AC-5  GlobalDialer is NOT mounted under /extension ------------------
  {
    const { ctx, page } = await surface(400, 900);
    check('no floating dialer panel on /extension (idle)',
      (await page.locator('[data-dialer-panel]').count()) === 0);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'r1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(900);
    check('no floating dialer panel on /extension (incoming auto-open suppressed)',
      (await page.locator('[data-dialer-panel]').count()) === 0);
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
    const { ctx, page } = await surface(400, 900);

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
    await page.waitForTimeout(800);

    const strip = page.getByRole('tablist');
    const tab = (n) => page.getByRole('tab', { name: n });
    const selected = (n) => tab(n).getAttribute('aria-selected').then((v) => v === 'true');
    const composeOpen = () => page.locator('#phone-mode-compose-to').count().then((n) => n > 0);

    // ---- #7a  compose from TEXTS -> send -> back lands on TEXTS -----------
    await tab(/texts/i).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'New message' }).click();
    await page.waitForTimeout(500);
    check('#6 tab strip is still visible while composing', await strip.isVisible());
    check('#7 a compose opened from Texts keeps Texts selected', await selected(/texts/i));
    await page.locator('#phone-mode-compose-to').fill('+4795550001');
    await page.locator('#phone-mode-compose-body').fill('hello from texts');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForTimeout(700);
    check('#7 sending leaves the composer (thread view is showing)', !(await composeOpen()));
    await shot(page, 'F-N1-after-send-from-texts');
    await page.getByRole('button', { name: /^Back to/ }).click();
    await page.waitForTimeout(600);
    check('#7 back after sending from Texts lands on Texts, NOT on the composer',
      !(await composeOpen()) && (await selected(/texts/i)) &&
      (await page.getByRole('button', { name: 'New message' }).count()) === 1);

    // ---- #9  Dial's send-message affordances open the THREAD --------------
    await tab(/dial/i).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Send a message to Ada' }).click();
    await page.waitForTimeout(600);
    check('#9 a recent row\'s send-message opens the thread, not a blank compose',
      !(await composeOpen()));
    check('#9 that thread shows the existing history with the number',
      (await page.getByText('older note from Ada').count()) > 0);
    check('#7 a thread opened from Dial keeps Dial selected', await selected(/dial/i));
    await shot(page, 'F-N2-dial-send-opens-thread-with-history');

    // ---- #7b  send from that Dial-origin thread -> back lands on DIAL -----
    await page.getByRole('textbox', { name: 'Message body' }).fill('replying from dial');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /^Back to/ }).click();
    await page.waitForTimeout(600);
    check('#7 back after sending from Dial lands on Dial, NOT on the composer',
      !(await composeOpen()) && (await selected(/dial/i)));
    await shot(page, 'F-N3-back-from-dial-origin-lands-on-dial');

    // ---- #9b  a number with NO history: empty thread, caret in the box ----
    await page.getByRole('button', { name: 'Send a message to Bo' }).click();
    await page.waitForTimeout(600);
    check('#9 a number with no history opens an empty THREAD (not a compose)',
      !(await composeOpen()) && (await page.getByText(/No messages with/).count()) === 1);
    check('#9 the composer has the caret in an empty thread',
      await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'));
    await page.getByRole('button', { name: /^Back to/ }).click();
    await page.waitForTimeout(500);

    // ---- #9c  the pad's send-message pill, on a typed number --------------
    await page.locator('.cc-dial-column input[type="text"]').fill('+4796660002');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Send a message to this number' }).click();
    await page.waitForTimeout(600);
    check('#9 the pad pill opens the thread for the typed number',
      !(await composeOpen()) && (await page.getByText(/No messages with/).count()) === 1);
    await shot(page, 'F-N4-pad-pill-opens-thread');
    await page.getByRole('button', { name: /^Back to/ }).click();
    await page.waitForTimeout(500);
    check('#7 back from the pad-pill thread lands on Dial', await selected(/dial/i));

    // ---- #8  a ringing call does not take the screen ----------------------
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'n1', number: '+4790011223', isIncoming: true, state: 'ringing' }));
    await page.waitForTimeout(900);
    check('#8 the incoming card is pinned inside the Dial tab',
      (await page.locator('[data-incoming-card]').count()) === 1);
    check('#8 tabs stay usable while ringing',
      (await page.getByRole('tab').count()) >= 3 && (await strip.isVisible()));
    check('#8 nothing takes the body while ringing',
      (await page.locator('[data-call-surface]').count()) === 0);
    check('#8 Answer and Decline are on the card',
      (await page.getByRole('button', { name: 'Answer call' }).count()) === 1 &&
      (await page.getByRole('button', { name: 'Decline call' }).count()) === 1);
    await shot(page, 'F-N5-ringing-card-in-dial-tab');

    await tab(/texts/i).click();
    await page.waitForTimeout(600);
    check('#8 switching to Texts mid-ring keeps the call as a banner',
      (await page.locator('[data-call-banner]').count()) === 1 &&
      (await page.locator('[data-incoming-card]').count()) === 0);
    check('#8 the mid-ring banner can still answer the call',
      (await page.locator('[data-call-banner]').getByRole('button', { name: 'Answer call' }).count()) === 1);
    check('#8 Texts really is the view under the mid-ring banner', await selected(/texts/i));
    await shot(page, 'F-N6-ringing-banner-on-texts');
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, 'F-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
  reaper.reapAndReport('ext-in-call-shots');
}
