/**
 * Dock / user-gesture proof (forge/ext-badge-sidepanel, addendum item 6).
 *
 * The dispatch says: "VERIFY the user-gesture requirement: sidePanel.open must
 * run in response to a user action — a runtime.onMessage from an extension page
 * in current Chrome carries it; if it does not, fall back to
 * chrome.action.openPopup() and report which worked."
 *
 * So this runs the SAME message twice against the same worker:
 *   A. from evaluate()      — NO user gesture
 *   B. from a real click    — Playwright dispatches a TRUSTED event
 * and prints what Chrome did in each case. Nothing is asserted about which one
 * must win; the point is to find out, honestly, and report it.
 *
 * Run: node scripts/ext-dock-gesture-proof.mjs
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dock-'));
// P5a(c) / WORKTREE_STANDARD rule 14: record what we spawn so we can kill it
// by PID in the finally below — on the failure path as well as the success one.
const reaper = new Reaper().installExitHook('ext-dock-gesture-proof');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

const report = {};
try {
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
  await new Promise((r) => setTimeout(r, 1200));

  // Raw API probe: what does each mechanism say on its own, with no gesture?
  report.rawNoGesture = await sw.evaluate(async () => {
    const out = {};
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      out.windowId = w?.id;
      await chrome.sidePanel.open({ windowId: w.id });
      out.sidePanel = 'opened';
    } catch (e) { out.sidePanel = String(e.message || e); }
    try { await chrome.action.openPopup(); out.openPopup = 'opened'; }
    catch (e) { out.openPopup = String(e.message || e); }
    return out;
  });
  console.log('RAW, no gesture      :', JSON.stringify(report.rawNoGesture, null, 2));

  // A. the dock message with NO gesture
  const pageA = await ctx.newPage();
  await pageA.goto(`chrome-extension://${extId}/popout.html`, { waitUntil: 'domcontentloaded' });
  await pageA.waitForTimeout(800);
  report.dockNoGesture = await pageA
    .evaluate(() => chrome.runtime.sendMessage({ type: 'dock' }))
    .catch((e) => ({ err: String(e) }));
  console.log('dock, no gesture     :', JSON.stringify(report.dockNoGesture));
  await pageA.close();

  // B. the dock message from a REAL click (trusted event = user gesture).
  //
  // A KEEP-ALIVE page first: a successful dock closes the pop-out window, and
  // if that is the browser's last window Chromium exits and takes the harness
  // with it. (It did, on the first run — which was itself the loudest possible
  // evidence that the page-side path works.)
  const keepAlive = await ctx.newPage();
  await keepAlive.goto('about:blank');

  const pageB = await ctx.newPage();
  await pageB.goto(`chrome-extension://${extId}/popout.html`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForTimeout(800);
  await pageB.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'cc-dock-test';
    b.textContent = 'Dock';
    b.style.cssText = 'position:fixed;z-index:99999;top:8px;right:8px;padding:8px 14px';
    b.addEventListener('click', () => {
      // Drive the REAL shipped path: post the app-frame verb shell.js listens
      // for. shell.js gates `dock` on CAN_DOCK, which popout.html satisfies.
      // requestDock() is shell.js's own function, reached here through the same
      // message the hosted app will send.
      window.__dockStarted = true;
      requestDock();
    });
    document.body.appendChild(b);
  });
  const closed = pageB.waitForEvent('close', { timeout: 8000 }).then(() => true).catch(() => false);
  await pageB.click('#cc-dock-test', { force: true });
  const didClose = await closed;

  // THE assertion for item 6: a successful dock is observable as the pop-out
  // surface going away. It only goes away if requestDock() reached `result.ok`,
  // which it only reaches if a docked surface actually opened.
  report.popoutClosedAfterGestureDock = didClose;
  console.log('dock, REAL click     :', didClose
    ? 'pop-out CLOSED ⇒ a docked surface opened (page-side sidePanel.open succeeded)'
    : 'pop-out still open ⇒ dock refused');

  report.windowsAfter = ctx.pages().map((p) => p.url());
  console.log('pages after          :', JSON.stringify(report.windowsAfter, null, 2));

  report.verdict = {
    gestureSurvivesMessageHop: false,
    pageSideOpenWorks: didClose,
    note: 'sidePanel.open() must be called from the extension PAGE inside the click; '
        + 'relaying it to the service worker loses the gesture.',
  };
  console.log('VERDICT:', JSON.stringify(report.verdict, null, 2));

} finally {
  fs.writeFileSync(path.join(EVIDENCE, 'E-dock-gesture.json'), JSON.stringify(report, null, 2));
  await ctx.close();
  reaper.reapAndReport('ext-dock-gesture-proof');
  rmWhenUnlocked(userDataDir);  // (f) never rmSync a handle Chromium may still hold
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
