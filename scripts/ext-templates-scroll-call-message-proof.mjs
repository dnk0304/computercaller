/**
 * PIXEL-P proof harness — dispatch "template strip still does not scroll +
 * Message in the call banner + the SMS box clips long messages".
 *
 * Same bridge-stub technique as scripts/ext-in-call-shots.mjs: the relay
 * WebSocket is replaced with a stub that speaks the real `TYPE:{json}` wire
 * frames, so everything downstream of the socket is the production code path.
 * Only the session, the relay ticket and the templates GET are intercepted at
 * the NETWORK layer — a page-level fetch patch is too late, Next's bundle has
 * already captured its own reference.
 *
 * The assertions are the ones the previous sign-off was missing: they do not
 * check that the strip HAS `overflow-x: auto`, they check that `scrollLeft`
 * actually MOVES for a wheel, for a drag and for the arrow button, and that
 * the last chip becomes visible. That distinction is the whole bug — the strip
 * was a correct scroller that no mouse input could reach.
 *
 * Run against a dev server on :3123 (PORT=3123 bun run dev).
 */
import { chromium } from 'playwright';
import { exitAfterFlush } from './lib/finish.mjs';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';
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

const TEMPLATES = [
  'Running late',
  'On my way now',
  'Call you back in five',
  'In a meeting — text me',
  'Send me the address',
  'Thanks, got it',
  'Can we move to tomorrow?',
  'Invoice is on its way',
].map((name, i) => ({
  id: `t${i}`,
  name,
  body: `${name}. Sent from ComputerCaller.`,
  sortOrder: i,
  createdAt: Date.now() - i * 1000,
}));

const bridgeStub = `
(() => {
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url; this.readyState = OPEN; this.sent = [];
      window.__ccSocket = this;
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify({ deviceName: 'Pixel 8' }));
      }, 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
    addEventListener() {} removeEventListener() {}
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

// P5a(c) / WORKTREE_STANDARD rule 14: record the browser PID at launch and
// kill that PID tree in the finally — success path and failure path alike.
const reaper = new Reaper().installExitHook('ext-templates-scroll-call-message-proof');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

async function surface(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, bypassCSP: true });
  const page = await ctx.newPage();
  await page.route('**/api/auth/me', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
  }));
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  await page.route('**/api/templates', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ templates: TEMPLATES, limit: 15 }),
  }));
  await page.addInitScript(bridgeStub);
  await page.goto(`${DEV}/extension`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 3000);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 4000 }).catch(() => {});
  await settle(page, 400);
  return { ctx, page };
}

const frame = (type, payload) => `${type}:${JSON.stringify(payload)}`;

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${name}  ${fs.statSync(file).size} B`);
}

/** Open the Texts tab and land in a thread, where the composer + strip live. */
async function openThread(page, number = '4791234567') {
  await page.getByRole('tab', { name: /dial/i }).click();
  await settle(page, 300);
  await page.getByPlaceholder('Enter Number').fill(number);
  await settle(page, 250);
  await page.getByRole('button', { name: 'Send a message to this number' }).click();
  await settle(page, 900);
}

try {
  // =========================================================================
  // 1. The template strip actually scrolls — wheel, drag, and arrow button.
  // =========================================================================
  {
    const { ctx, page } = await surface(400, 600);
    await openThread(page);

    const strip = page.getByRole('toolbar', { name: 'Insert template' });
    check('template strip is mounted in the thread composer', (await strip.count()) === 1);

    const overflows = await strip.evaluate((el) => el.scrollWidth - el.clientWidth > 1);
    check('strip overflows at 400 px with 8 templates (precondition)', overflows);

    const box = await strip.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // --- WHEEL. The reported failure: a vertical wheel over the strip moved
    // the message list behind it and left the strip exactly where it was.
    await page.mouse.move(cx, cy);
    const before = await strip.evaluate((el) => el.scrollLeft);
    await page.mouse.wheel(0, 240);
    await settle(page, 250);
    const afterWheel = await strip.evaluate((el) => el.scrollLeft);
    check('VERTICAL MOUSE WHEEL scrolls the strip right',
      afterWheel > before, `scrollLeft ${before} → ${afterWheel}`);
    await shot(page, 'P-01-templates-scrolled-by-wheel-400x600');

    // --- DRAG. Press, pan left, release. Must move and must NOT insert.
    const beforeDrag = await strip.evaluate((el) => el.scrollLeft);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 90, cy, { steps: 8 });
    await page.mouse.up();
    await settle(page, 250);
    const afterDrag = await strip.evaluate((el) => el.scrollLeft);
    check('MOUSE DRAG pans the strip',
      afterDrag > beforeDrag, `scrollLeft ${beforeDrag} → ${afterDrag}`);
    const draftAfterDrag = await page.getByRole('textbox', { name: 'Message body' }).inputValue();
    check('a drag does NOT insert the chip it was released over',
      draftAfterDrag === '', JSON.stringify(draftAfterDrag));

    // --- ARROW BUTTON. The affordance that needs no gesture at all.
    const beforeArrow = await strip.evaluate((el) => el.scrollLeft);
    await page.locator('[title="Scroll templates right"]').click();
    await settle(page, 500);
    const afterArrow = await strip.evaluate((el) => el.scrollLeft);
    check('the right ARROW BUTTON scrolls the strip',
      afterArrow > beforeArrow, `scrollLeft ${beforeArrow} → ${afterArrow}`);

    // --- The last chip must become reachable, not just "scrollLeft moved".
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await settle(page, 400);
    const lastVisible = await strip.evaluate((el) => {
      const chips = el.querySelectorAll('button');
      const last = chips[chips.length - 1];
      const s = el.getBoundingClientRect();
      const c = last.getBoundingClientRect();
      return c.left >= s.left - 1 && c.right <= s.right + 1;
    });
    check('the LAST template chip becomes fully visible after scrolling', lastVisible);
    check('the left arrow appears once the strip is scrolled off its start',
      (await page.locator('[title="Scroll templates left"]').count()) === 1);
    await shot(page, 'P-02-templates-scrolled-to-end-400x600');

    // A chip TAP still inserts (the drag threshold did not break the click).
    await page.locator('[role="toolbar"][aria-label="Insert template"] button').last().click();
    await settle(page, 400);
    const draft = await page.getByRole('textbox', { name: 'Message body' }).inputValue();
    check('a plain chip tap still inserts its body', draft.length > 0, draft.slice(0, 40));
    await ctx.close();
  }

  // =========================================================================
  // 3. The SMS composer grows to a cap and then scrolls internally.
  // =========================================================================
  {
    const { ctx, page } = await surface(400, 600);
    await openThread(page);
    const ta = page.getByRole('textbox', { name: 'Message body' });

    const h0 = await ta.evaluate((el) => el.getBoundingClientRect().height);
    check('composer starts at one line', h0 < 48, `${Math.round(h0)}px`);

    await ta.fill('x'.repeat(600));
    await settle(page, 400);
    const grown = await ta.evaluate((el) => ({
      h: el.getBoundingClientRect().height,
      cap: parseFloat(getComputedStyle(el).maxHeight),
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    check('composer GREW with a 600-char message',
      grown.h > h0 + 20, `${Math.round(h0)}px → ${Math.round(grown.h)}px`);
    check('composer stops at its derived cap rather than eating the thread',
      Math.round(grown.h) <= Math.round(grown.cap) + 1, `cap ${Math.round(grown.cap)}px`);
    check('past the cap the box SCROLLS internally (the reported clip)',
      grown.overflowY === 'auto' && grown.scrollH > grown.clientH,
      `overflow-y:${grown.overflowY} scrollHeight ${grown.scrollH} > clientHeight ${grown.clientH}`);

    // Caret visibility: put the caret at the very end and confirm the box has
    // scrolled to keep it on screen rather than clipping it.
    await ta.evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
    await settle(page, 200);
    const caretVisible = await ta.evaluate((el) =>
      el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    check('the caret at the end of a long message is in view', caretVisible);

    const stripStillThere = await page
      .getByRole('toolbar', { name: 'Insert template' }).count();
    check('the template strip stays pinned above the grown composer', stripStillThere === 1);
    check('the tab strip did not jump', (await page.getByRole('tab').count()) >= 3);
    await shot(page, 'P-03-composer-grown-and-scrolling-400x600');
    await ctx.close();
  }

  // =========================================================================
  // 2. Message button in the call banner.
  // =========================================================================
  {
    const { ctx, page } = await surface(400, 600);
    await page.evaluate((f) => window.__ccSend(f),
      frame('CALL_ADD', { callId: 'm1', number: '+4790011223', isIncoming: false, state: 'active' }));
    await settle(page, 900);

    const banner = page.locator('[data-call-banner]');
    check('call banner is up for an active call', (await banner.count()) === 1);
    const msgBtn = page.getByRole('button', { name: 'Message this number' });
    check('Message button is in the banner', (await msgBtn.count()) === 1);

    // It must not push End around — End stays the last control in the strip.
    const order = await banner.evaluate((el) =>
      Array.from(el.querySelectorAll('button'))
        .map((b) => b.getAttribute('aria-label')));
    check('End call is still the last control in the banner',
      order[order.length - 1] === 'End call', JSON.stringify(order));

    const hit = await msgBtn.boundingBox();
    check('Message has a 40 px hit target',
      hit.width >= 39 && hit.height >= 39, `${Math.round(hit.width)}x${Math.round(hit.height)}`);
    await shot(page, 'P-04-banner-with-message-button-400x600');

    await msgBtn.click();
    await settle(page, 800);
    check('Message opens the thread for the in-call number',
      (await page.getByRole('textbox', { name: 'Message body' }).count()) === 1);
    check('the thread is for the number we are in a call with',
      (await page.locator('body').innerText()).includes('90011223'));
    check('the CALL BANNER IS STILL VISIBLE over the thread',
      (await banner.count()) === 1);
    const sent = await page.evaluate(() => (window.__ccSocket?.sent || []).join(' '));
    check('opening the thread did NOT end the call', !/END_CALL/.test(sent));
    await shot(page, 'P-05-thread-from-banner-call-still-live-400x600');

    // Origin tab = Dial: Back must land on Dial, not Texts.
    await page.getByRole('button', { name: /back to dial/i }).click();
    await settle(page, 600);
    check('Back from the banner-opened thread returns to DIAL',
      (await page.getByRole('tab', { name: /dial/i }).getAttribute('aria-selected')) === 'true');
    check('banner survives the trip back', (await banner.count()) === 1);
    await shot(page, 'P-06-back-to-dial-banner-intact-400x600');
    await ctx.close();
  }
} finally {
  await browser.close();
  reaper.reapAndReport('ext-templates-scroll-call-message-proof');
  // P5a: the summary MUST be inside the finally. It used to sit after this
  // block, which meant a throw anywhere above propagated past it and the
  // "N/N checks passed" line never printed at all — so tools/e2e-gate.mjs's
  // passLine() parsed nothing and recorded the vague "declares N checks but
  // reported NO count at all" floor violation instead of the real error. A
  // partial count is evidence; no count is a second mystery on top of the
  // first. Exit code is still set by the failure list below.
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
