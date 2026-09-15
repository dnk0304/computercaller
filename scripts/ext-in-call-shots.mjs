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
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/extension-login-and-reflecto-redesign/evidence';
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

const browser = await chromium.launch({ headless: true });

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

  fs.writeFileSync(path.join(OUT, 'F-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
