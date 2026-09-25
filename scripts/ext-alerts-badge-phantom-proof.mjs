/**
 * ALERTS-BADGE-PHANTOM proof (web #16c, Ken brief 2026-09-25).
 *
 * Dennis, prod be1ce49: from Texts or Dial the Alerts tab shows "1"; open
 * Alerts, nothing unread, badge gone; leave, "1" is back — every toggle.
 *
 * The page's badge is max(alertsUnread, shell.unread.alerts) and is FORCED to
 * 0 on Alerts (hooks/useExtensionTabBadges.ts), so "gone on Alerts" says
 * nothing about the inputs. This harness drives the SHIPPED worker + shell
 * (same launch recipe as ext-badge-counter-proof.mjs) and logs the three
 * numbers separately at every step:
 *   sw    — chrome.storage.session cc_unread.alerts (the worker's truth)
 *   shell — shell.js's cached `unread.alerts` (what it hands the page in
 *           every shell-hello; the page's shell.unread.alerts is this value)
 *
 * The failing arm: the presence port drops while the panel stays open (an
 * MV3 worker restart disconnects every port). The drop is induced from the
 * shell side (disconnect() + the null its own onDisconnect handler writes),
 * because a debugger-attached worker is never evicted. The shell then reports
 * `tab-viewed: alerts` down its fallback path. Before the fix the worker
 * clears its count but the shell keeps its cached 1 forever: the phantom.
 * Measured on 2cb7526+title: {"sw":0,"shell":1,"port":false} on Texts and Dial.
 *
 * Headless new-mode Chromium by default; CC_HEADED=1 for a headed run.
 *
 *   node scripts/ext-alerts-badge-phantom-proof.mjs
 */
import { chromium } from 'playwright';
import { unpackedExtensionId } from './lib/ext-sw.mjs';
import { Reaper, rmWhenUnlocked } from './lib/reap.mjs';
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-phantom-proof-'));
const reaper = new Reaper().installExitHook('ext-alerts-badge-phantom-proof');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  // New headless (channel 'chromium') loads extensions and needs no desktop
  // window; CC_HEADED=1 for the classic headed run.
  headless: process.env.CC_HEADED !== '1',
  channel: process.env.CC_HEADED === '1' ? undefined : 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // No worker handle at all: Playwright's service-worker handles went stale
  // mid-run on this box (evaluate never settled). Everything below goes through
  // the extension page, which reaches chrome.storage.session and the shell's
  // own top-level state directly, and through the worker's REAL message paths.
  // The ID comes from the worker's own URL (the computed unpacked ID did not
  // match on this box); only the URL is read, the handle is never evaluated.
  const worker = ctx.serviceWorkers()[0]
    || await ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null);
  const extId = worker ? new URL(worker.url()).host : unpackedExtensionId(EXT);
  console.log('  .. extension id', extId, worker ? '(from worker)' : '(computed)');
  // Keep the shell from loading the real web app into its frame: the shell's
  // own bookkeeping is the subject here, not the hosted page.
  await ctx.route(/^https?:\/\//, (r) => r.abort());

  const shell = await ctx.newPage();
  // The unpacked extension can take a moment to register after launch.
  for (let i = 0; ; i += 1) {
    try { await shell.goto(`chrome-extension://${extId}/sidepanel.html`); break; }
    catch (e) { if (i >= 40) throw e; await wait(500); }
  }
  console.log('  .. shell open');

  const swAlerts = () => shell.evaluate(() => new Promise((r) =>
    chrome.storage.session.get('cc_unread', (v) => r((v.cc_unread && v.cc_unread.alerts) || 0))));
  const setSw = (u) => shell.evaluate((x) => new Promise((r) =>
    chrome.storage.session.set({ cc_unread: x }, r)), u);
  const shellAlerts = () => shell.evaluate(() => unread.alerts);
  const portUp = () => shell.evaluate(() => presencePort !== null);
  const until = async (fn, want, ms = 4000) => {
    const end = Date.now() + ms;
    let v;
    while (Date.now() < end) { v = await fn(); if (v === want) return v; await wait(100); }
    return v;
  };
  const log = async (step) => {
    const row = { step, sw: await swAlerts(), shell: await shellAlerts(), port: await portUp() };
    console.log('   ', JSON.stringify(row));
    return row;
  };
  /**
   * An alert that landed while nothing was watching: the worker's count is 1
   * and the shell learns it from the worker's own broadcast. The broadcast is
   * provoked through a real path — a Texts view zeroes a pending newSms and
   * broadcasts the whole record, alerts included.
   */
  const alertWaiting = async () => {
    await setSw({ missedCalls: 0, newSms: 1, alerts: 1 });
    await shell.evaluate(() => reportTabViewed('texts'));
    return until(shellAlerts, 1);
  };

  await until(portUp, true);
  const seeded = await alertWaiting();
  const open = await log('panel open on Texts, one alert waiting');
  check('control: shell holds the waiting count', seeded === 1 && open.sw === 1, open);

  // ── Arm A: healthy port. Visit Alerts, both counts go to 0. ──────────────
  await shell.evaluate(() => reportTabViewed('alerts'));
  await until(shellAlerts, 0);
  const a = await log('A: Alerts visited, port live');
  check('A: healthy port — worker AND shell cleared after visiting Alerts', a.sw === 0 && a.shell === 0, a);

  // ── Arm B: the port drops with the panel still open. ──────────────────────
  // An MV3 worker restart disconnects every port; the shell's onDisconnect
  // handler nulls its reference. Reproduced from the shell side: disconnect()
  // tells the worker (presence-close), and the null is exactly what the
  // shell's own handler writes.
  await alertWaiting();
  await shell.evaluate(() => { presencePort.disconnect(); presencePort = null; });
  await wait(300);
  const dropped = await log('B: port dropped, panel still open');
  check('B: precondition — shell holds 1 and has no presence port', dropped.port === false && dropped.shell === 1, dropped);

  await shell.evaluate(() => reportTabViewed('alerts'));
  await until(swAlerts, 0);
  await until(shellAlerts, 0, 2500);
  const b = await log('B: Alerts visited after the drop');
  check('B: worker cleared its count', b.sw === 0, b);
  check('B: THE PHANTOM — shell cache (page badge source) cleared too', b.shell === 0, b);

  // Leave to Texts and Dial: the page's Alerts badge is max(alertsUnread, shell).
  await shell.evaluate(() => reportTabViewed('texts'));
  await wait(600);
  const t = await log('B: back on Texts');
  check('B: on Texts the Alerts badge source is 0', t.shell === 0, t);
  await shell.evaluate(() => reportTabViewed('dial'));
  await wait(600);
  const d = await log('B: on Dial');
  check('B: on Dial the Alerts badge source is 0', d.shell === 0, d);
  check('B: presence restored, so the worker stops counting behind an open panel', d.port === true, d);

  // ── C: no over-correction. A new alert still shows, and still clears. ────
  const n1 = await alertWaiting();
  check('C: a new alert still reaches the badge as 1', n1 === 1, { shell: n1 });
  await shell.evaluate(() => reportTabViewed('alerts'));
  const n0 = await until(shellAlerts, 0);
  check('C: and clears after visiting Alerts', n0 === 0, { shell: n0, sw: await swAlerts() });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  reaper.reapAndReport('ext-alerts-badge-phantom-proof');
  rmWhenUnlocked(userDataDir);
}
