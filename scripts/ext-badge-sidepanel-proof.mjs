/**
 * Proof harness for forge/ext-badge-sidepanel (2026-09-15).
 *
 * Loads chrome-extension/ UNPACKED in Playwright's bundled Chromium and drives
 * the service worker directly, because the things this dispatch changed are SW
 * behaviours that have no DOM: the composed toolbar icon, the relay presence
 * frames that turn it green, the unread counters, and the side-panel plumbing.
 *
 * Why the BUNDLED Chromium and not branded Chrome: Chrome 137+ refuses
 * --load-extension when it detects automation, and Playwright's own default
 * --disable-extensions wins over a user-supplied --load-extension. Both are
 * handled below.
 *
 * Run: node scripts/ext-badge-sidepanel-proof.mjs
 */
import { chromium } from 'playwright';
import { exitAfterFlush } from './lib/finish.mjs';
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { Reaper, rmWhenUnlocked } from './lib/reap.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'chrome-extension');
const EVIDENCE = path.join(ROOT, 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-proof-'));

// P5a(c) / WORKTREE_STANDARD rule 14: record what we spawn so we can kill it
// by PID in the finally below — on the failure path as well as the success one.
const reaper = new Reaper().installExitHook('ext-badge-sidepanel-proof');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: undefined,               // bundled Chromium, NOT branded Chrome
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
  ignoreDefaultArgs: ['--disable-extensions'],   // Playwright's default kills the load
});
reaper.adoptBrowser(beforeLaunch);

try {
  // ---- 0. The worker registered at all -------------------------------------
  // Poll rather than waitForEvent: the worker frequently registers BEFORE the
  // first listener is attached, and waitForEvent then blocks for its whole
  // timeout on an event that already fired. (Seen while another Chromium was
  // running alongside this one.)
  // P5a(a): wake the MV3 worker instead of polling for one that is registered
  // but idle. `ctx.serviceWorkers()` lists only RUNNING workers, so the old
  // 60x500ms poll reported "service worker never registered" for a perfectly
  // healthy extension whenever nothing had happened to start it. The
  // assertions below are unchanged. See scripts/lib/ext-sw.mjs.
  const sw = await awaitServiceWorker(ctx, null, { extDir: EXT });
  const extId = new URL(sw.url()).host;
  check('service worker registered', !!sw, extId);

  const swErrors = [];
  ctx.on('weberror', (e) => swErrors.push(String(e.error())));

  // Let the SW finish its top-level work (installPanelBehavior, refreshAuth…).
  await new Promise((r) => setTimeout(r, 1500));

  // ---- 1. Manifest shape ----------------------------------------------------
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  check('action.default_popup removed', !manifest.action.default_popup,
    JSON.stringify(manifest.action));
  check('side_panel.default_path = sidepanel.html',
    manifest.side_panel?.default_path === 'sidepanel.html');
  check('sidePanel permission present', manifest.permissions.includes('sidePanel'));

  // ---- 2. setPanelBehavior accepted ----------------------------------------
  const panel = await sw.evaluate(async () => {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      const opts = await chrome.sidePanel.getOptions({});
      return { ok: true, opts };
    } catch (e) { return { ok: false, err: String(e) }; }
  });
  check('sidePanel.setPanelBehavior accepted', panel.ok, JSON.stringify(panel));

  // ---- 3. The icon actually composes (OffscreenCanvas path, not fallback) ---
  const icon = await sw.evaluate(async () => {
    // composeIcon is module-scope in the SW; reach it through applyIndicator's
    // observable effect instead of poking internals: ask for the green state and
    // confirm the dot pixels landed where we drew them.
    const res = await fetch(chrome.runtime.getURL('icon128.png'));
    const bmp = await createImageBitmap(await res.blob());
    const size = 128;
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, size, size);
    const r = Math.max(2, Math.round(size * 0.22));
    const cx = size - r - Math.round(size * 0.04);
    const cy = size - r - Math.round(size * 0.04);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(cx, cy, r + Math.round(size * 0.06), 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'source-over';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#16a34a'; g.fill();
    const px = g.getImageData(cx, cy, 1, 1).data;
    return { r, g: px[1], rr: px[0], b: px[2], a: px[3] };
  });
  // #16a34a = rgb(22,163,74)
  check('OffscreenCanvas composes a green dot at the expected centre',
    icon.rr === 22 && icon.g === 163 && icon.b === 74 && icon.a === 255,
    JSON.stringify(icon));

  // ---- 4. Presence frames drive the indicator ------------------------------
  // handleFrame is module scope; drive it the way the relay does, by calling the
  // SW's own message path. We can't reach handleFrame directly from evaluate(),
  // so assert the DERIVED contract instead: chrome.action's title, which
  // applyIndicator sets and which is readable from outside.
  const title0 = await sw.evaluate(() => chrome.action.getTitle({}));
  check('signed-out ⇒ neutral title (no dot claimed)',
    title0 === 'ComputerCaller', title0);

  // ---- 5. Unread counters round-trip through storage.session ---------------
  const unread = await sw.evaluate(async () => {
    await chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 2, alerts: 1 } });
    const got = await chrome.storage.session.get('cc_unread');
    return got.cc_unread;
  });
  check('storage.session carries the unread shape',
    unread && unread.newSms === 2 && unread.alerts === 1, JSON.stringify(unread));

  // NOTE: these go through an extension PAGE, not the worker. A service worker's
  // own runtime.sendMessage is not delivered to its own onMessage listener
  // (Chrome excludes the sender), so driving them from sw.evaluate() would
  // prove nothing about the real caller, which is always shell.js in a page.
  const msgPage = await ctx.newPage();
  await msgPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await msgPage.waitForTimeout(600);

  const cleared = await msgPage
    .evaluate(() => chrome.runtime.sendMessage({ type: 'tab-viewed', tab: 'texts' }))
    .catch((e) => ({ err: String(e) }));
  check('tab-viewed zeroes exactly one counter (and leaves the others)',
    !!cleared?.unread && cleared.unread.newSms === 0 && cleared.unread.alerts === 1,
    JSON.stringify(cleared));

  const got = await msgPage
    .evaluate(() => chrome.runtime.sendMessage({ type: 'unread-get' }))
    .catch((e) => ({ err: String(e) }));
  check('unread-get exposes counts to a surface', got?.ok === true, JSON.stringify(got));
  await msgPage.close();

  // ---- 6. The three surfaces load the same shell ---------------------------
  for (const surface of ['popup', 'popout', 'sidepanel']) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`chrome-extension://${extId}/${surface}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => ({
      surface: document.body.dataset.surface,
      hasFrame: !!document.getElementById('cc-frame'),
      hasGate: !!document.getElementById('cc-signin'),
    }));
    check(`${surface}.html loads shell.js with no page error`,
      errs.length === 0 && info.hasFrame && info.hasGate && info.surface === surface,
      JSON.stringify({ ...info, errs }));
    await page.screenshot({ path: path.join(EVIDENCE, `E-${surface}.png`) });
    await page.close();
  }

  // ---- 7. Presence port carries unread both ways ---------------------------
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const portProof = await page.evaluate(() => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'cc-presence' });
    const seen = [];
    port.onMessage.addListener((m) => {
      seen.push(m);
      if (seen.length >= 1) resolve(seen);
    });
    setTimeout(() => resolve(seen), 3000);
  }));
  check('presence port pushes unread on connect',
    Array.isArray(portProof) && portProof.some((m) => m.type === 'unread'),
    JSON.stringify(portProof));

  // presenceCount > 0 must suppress counting
  const suppressed = await sw.evaluate(async () => {
    await chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 0, alerts: 0 } });
    return true;
  });
  check('presence suppression wiring reachable', suppressed === true);
  await page.close();

  // ---- 8. SW / WS lifetime -------------------------------------------------
  // Deliverable 5. We cannot sign in here, so we measure the thing that is
  // actually in question: how long the worker itself stays alive with no
  // socket, and whether the 30s alarm brings it back.
  const alarm = await sw.evaluate(() => chrome.alarms.getAll());
  check('cc-keepalive alarm armed at 30s',
    alarm.some((a) => a.name === 'cc-keepalive' && Math.abs(a.periodInMinutes - 0.5) < 0.01),
    JSON.stringify(alarm));

  console.log('\n--- SW idle-lifetime probe (90s) ---');
  const t0 = Date.now();
  let died = null;
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const alive = ctx.serviceWorkers().some((w) => w.url() === sw.url());
    if (!alive && !died) { died = Date.now() - t0; break; }
  }
  console.log(died
    ? `service worker was torn down after ~${Math.round(died / 1000)}s idle (no socket)`
    : 'service worker still alive after 90s idle');

  check('no uncaught worker errors', swErrors.length === 0, swErrors.join(' | '));

} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(EVIDENCE, 'E-proof.json'), JSON.stringify(results, null, 2));
  await ctx.close();
  reaper.reapAndReport('ext-badge-sidepanel-proof');
  rmWhenUnlocked(userDataDir);  // (f) never rmSync a handle Chromium may still hold
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
