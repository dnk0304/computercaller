/**
 * Unread-counter badge proof (forge/dock-reconnect-sw-badge).
 *
 * Dennis: "i wont get a notifications counter on the pinned extension icon
 * when i have closed the side panel." He was right — before this branch
 * chrome.action.setBadgeText was only ever called by applyIndicator, and only
 * ever with '' or a single space. There was no number anywhere.
 *
 * This drives the SHIPPED worker with the exact frames server.js sends a
 * `?role=listener` peer and reads the badge back through chrome.action's own
 * getter, so it measures the thing the user looks at rather than a counter
 * variable. Same technique and the same reasons as ext-indicator-proof.mjs:
 * background.js is a classic service worker, so its top-level functions and
 * `let`s are reachable from an evaluate() in worker scope.
 *
 * Note on the launch flags: Playwright's default --disable-extensions wins
 * unless it is removed from the default args, and branded Chrome blocks
 * --load-extension under automation — hence launchPersistentContext on the
 * BUNDLED Chromium, exactly as the sibling harness does.
 *
 * Run: node scripts/ext-badge-counter-proof.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'chrome-extension');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + JSON.stringify(detail) : ''}`);
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-badge-proof-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});

try {
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = ctx.serviceWorkers()[0];
    if (!sw) await new Promise((r) => setTimeout(r, 500));
  }
  if (!sw) throw new Error('service worker never registered');
  await new Promise((r) => setTimeout(r, 1200));

  const reachable = await sw.evaluate(() => ({
    paintBadge: typeof paintBadge,
    bumpUnread: typeof bumpUnread,
    clearUnread: typeof clearUnread,
    handleFrame: typeof handleFrame,
  }));
  check('shipped badge writer is reachable in worker scope',
    Object.values(reachable).every((v) => v === 'function'), reachable);

  /** Zero everything, then drive frames and read the badge back. */
  const reset = () => sw.evaluate(async () => {
    presenceCount = 0;
    badgeChipColor = null;
    await new Promise((r) => chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 0, alerts: 0 } }, r));
    paintBadge({ missedCalls: 0, newSms: 0, alerts: 0 });
  });
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const feed = (frames) => sw.evaluate(async (fs_) => {
    for (const f of fs_) handleFrame(f);
    // Drain the serialize() mutex the counters and the badge share.
    await new Promise((r) => setTimeout(r, 400));
  }, frames);

  const SMS = (id) => 'SMS_RECEIVED:' + JSON.stringify({ id, address: '+4711111111', body: 'hi', date: Date.now() });
  const CALL = 'CALL_INCOMING:' + JSON.stringify({ number: '+4722222222' });
  const NOTIF = 'PHONE_NOTIFICATION:' + JSON.stringify({ id: 'n1', title: 'App', text: 'ping' });

  // ---- 1. nothing waiting ⇒ no badge ---------------------------------------
  await reset();
  check('no unread ⇒ empty badge', (await badge()) === '', await badge());

  // ---- 2. the actual ask: a number while every surface is closed -----------
  await feed([SMS(1), SMS(2), CALL, NOTIF]);
  let b = await badge();
  check('2 texts + 1 missed call + 1 alert with the panel CLOSED ⇒ "4"', b === '4', b);

  // ---- 3. it is a SUM across the three counters, not one of them -----------
  const counts = await sw.evaluate(() => readUnread());
  check('counters agree with the badge', counts.newSms === 2 && counts.missedCalls === 1 && counts.alerts === 1, counts);

  // ---- 4. viewing a tab clears that slice, badge follows -------------------
  await sw.evaluate(async () => { await clearUnread('texts'); await new Promise((r) => setTimeout(r, 200)); });
  b = await badge();
  check('viewing Texts drops the 2 texts ⇒ "2"', b === '2', b);
  await sw.evaluate(async () => { await clearUnread('dial'); await clearUnread('alerts'); await new Promise((r) => setTimeout(r, 300)); });
  b = await badge();
  check('viewing the rest clears the badge entirely', b === '', b);

  // ---- 5. an open surface is the read receipt — it must not count ----------
  await reset();
  await sw.evaluate(() => { presenceCount = 1; });
  await feed([SMS(3), SMS(4)]);
  b = await badge();
  check('panel OPEN ⇒ nothing counted, no badge', b === '', b);

  // ---- 6. the count outranks the fallback connection chip ------------------
  await reset();
  await sw.evaluate(() => { presenceCount = 0; });
  await feed([SMS(5)]);
  await sw.evaluate(async () => { badgeChipColor = '#16a34a'; await repaintBadge(); await new Promise((r) => setTimeout(r, 200)); });
  b = await badge();
  check('unread count beats the fallback colour chip', b === '1', b);
  await sw.evaluate(async () => { await clearUnread('texts'); await new Promise((r) => setTimeout(r, 300)); });
  b = await badge();
  check('chip returns once the count is read', b === ' ', b);

  // ---- 7. signing out must not leave someone else's number on the icon -----
  await reset();
  await feed([SMS(6), CALL]);
  check('two waiting before sign-out', (await badge()) === '2', await badge());
  // Sent from a PAGE, not from sw.evaluate: chrome.runtime.onMessage never
  // fires in the context that sent the message, so a worker messaging itself
  // silently exercises nothing. (It read "2" and looked like a bug.)
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'signed-out' }, () => r())));
  await new Promise((r) => setTimeout(r, 400));
  await page.close();
  await new Promise((r) => setTimeout(r, 200));
  b = await badge();
  check('sign-out clears the badge', b === '', b);

  // ---- 8. a count > 99 stays legible --------------------------------------
  await reset();
  await sw.evaluate(async () => {
    await new Promise((r) => chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 250, alerts: 0 } }, r));
    await repaintBadge();
    await new Promise((r) => setTimeout(r, 200));
  });
  b = await badge();
  check('250 unread ⇒ "99+"', b === '99+', b);
} finally {
  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
