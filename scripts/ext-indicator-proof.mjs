/**
 * Indicator + notification state-machine proof (forge/ext-badge-sidepanel).
 *
 * The first harness proved the plumbing exists. This one drives the actual
 * state machine Dennis cares about — "a small dot ... showing in green that we
 * are connected" — by feeding the service worker the EXACT frames server.js
 * sends a `?role=listener` peer, and reading back the observable effect.
 *
 * background.js is a CLASSIC service worker (importScripts, no modules), so its
 * top-level `function handleFrame` and `let wsOpen` live on the worker's global
 * lexical scope and are reachable from an evaluate(). That is what makes this a
 * test of the shipped code rather than of a re-implementation of it.
 *
 * Run: node scripts/ext-indicator-proof.mjs
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
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ind-proof-'));
// P5a(c) / WORKTREE_STANDARD rule 14: record what we spawn so we can kill it
// by PID in the finally below — on the failure path as well as the success one.
const reaper = new Reaper().installExitHook('ext-indicator-proof');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

/** Title is applyIndicator's externally readable output. */
const TITLE = {
  connected: 'ComputerCaller — phone connected',
  grey: 'ComputerCaller — reconnecting…',
  out: 'ComputerCaller',
};

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

  const reachable = await sw.evaluate(() => ({
    handleFrame: typeof handleFrame,
    refreshIndicator: typeof refreshIndicator,
    notePhonePresence: typeof notePhonePresence,
  }));
  check('shipped state machine is reachable in worker scope',
    reachable.handleFrame === 'function' && reachable.notePhonePresence === 'function',
    JSON.stringify(reachable));

  /** Put the worker into a known state, then read the indicator back. */
  const drive = (script) => sw.evaluate(script);

  // ---- 1. signed out ⇒ no dot ------------------------------------------------
  let t = await drive(async () => {
    signedIn = false; wsOpen = false; phonePresent = false; lastIndicator = null;
    await refreshIndicator();
    return chrome.action.getTitle({});
  });
  check('signed-out ⇒ no indicator', t === TITLE.out, t);

  // ---- 2. signed in, socket down ⇒ grey -------------------------------------
  t = await drive(async () => {
    signedIn = true; wsOpen = false; phonePresent = false; lastIndicator = null;
    await refreshIndicator();
    return chrome.action.getTitle({});
  });
  check('signed in + socket down ⇒ grey', t === TITLE.grey, t);

  // ---- 3. socket UP but no phone ⇒ still grey (the honest case) -------------
  t = await drive(async () => {
    signedIn = true; wsOpen = true; phonePresent = false; lastIndicator = null;
    await refreshIndicator();
    return chrome.action.getTitle({});
  });
  check('relay socket open but NO phone ⇒ still grey, never green', t === TITLE.grey, t);

  // ---- 4. the real relay frames -------------------------------------------
  // Exactly the bytes server.js sends a listener.
  t = await drive(async () => {
    signedIn = true; wsOpen = true; phonePresent = false; lastIndicator = null;
    await refreshIndicator();
    handleFrame('LOBBY_STATUS:' + JSON.stringify({ phonePresent: true, alreadyActive: false }));
    await new Promise((r) => setTimeout(r, 200));
    return chrome.action.getTitle({});
  });
  check('LOBBY_STATUS{phonePresent:true} ⇒ GREEN', t === TITLE.connected, t);

  t = await drive(async () => {
    handleFrame('PHONE_ABSENT:{}');
    await new Promise((r) => setTimeout(r, 200));
    return chrome.action.getTitle({});
  });
  check('PHONE_ABSENT ⇒ back to grey', t === TITLE.grey, t);

  t = await drive(async () => {
    handleFrame('PHONE_PRESENT:{}');
    await new Promise((r) => setTimeout(r, 200));
    return chrome.action.getTitle({});
  });
  check('PHONE_PRESENT ⇒ GREEN again', t === TITLE.connected, t);

  // The subtlety: a phone that is PAIRED has left the lobby, so phonePresent is
  // false and alreadyActive is true. Green must still be claimed.
  t = await drive(async () => {
    phonePresent = false; lastIndicator = null; await refreshIndicator();
    handleFrame('LOBBY_STATUS:' + JSON.stringify({ phonePresent: false, alreadyActive: true }));
    await new Promise((r) => setTimeout(r, 200));
    return chrome.action.getTitle({});
  });
  check('paired phone (alreadyActive, lobby empty) ⇒ GREEN', t === TITLE.connected, t);

  // The documented tryAutoResume gap: a data frame repairs presence.
  t = await drive(async () => {
    phonePresent = false; lastIndicator = null; await refreshIndicator();
    handleFrame('SMS_RECEIVED:' + JSON.stringify({ from: '+4790000000', body: 'hi' }));
    await new Promise((r) => setTimeout(r, 250));
    return chrome.action.getTitle({});
  });
  check('any phone→browser data frame repairs presence (tryAutoResume gap)',
    t === TITLE.connected, t);

  // ---- 5. unread counting + suppression ------------------------------------
  const counts = await drive(async () => {
    await chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 0, alerts: 0 } });
    presenceCount = 0;                       // nothing on screen
    handleFrame('SMS_RECEIVED:' + JSON.stringify({ from: '+47900', body: 'one' }));
    handleFrame('SMS_RECEIVED:' + JSON.stringify({ from: '+47900', body: 'two' }));
    handleFrame('CALL_INCOMING:' + JSON.stringify({ number: '+47901', callId: 'c1' }));
    handleFrame('PHONE_NOTIFICATION:' + JSON.stringify({ title: 'Signal', body: 'ping' }));
    await new Promise((r) => setTimeout(r, 400));
    const a = (await chrome.storage.session.get('cc_unread')).cc_unread;
    presenceCount = 1;                       // a surface is now open
    handleFrame('SMS_RECEIVED:' + JSON.stringify({ from: '+47900', body: 'three' }));
    await new Promise((r) => setTimeout(r, 300));
    const b = (await chrome.storage.session.get('cc_unread')).cc_unread;
    presenceCount = 0;
    return { closed: a, open: b };
  });
  check('counters increment while every surface is closed',
    counts.closed.newSms === 2 && counts.closed.missedCalls === 1 && counts.closed.alerts === 1,
    JSON.stringify(counts.closed));
  check('an OPEN surface suppresses counting (it is the read receipt)',
    counts.open.newSms === 2, JSON.stringify(counts.open));

  // ---- 6. NO OS notifications (EXT-NO-NOTIFS, 2026-09-25) -----------------
  // The "notifications" permission was removed, so the API must be absent, and
  // a counting stub planted in its place must see ZERO create() calls while the
  // same frames still bump the badge counters.
  const notifs = await drive(async () => {
    const apiAbsent = typeof chrome.notifications === 'undefined';
    let creates = 0;
    chrome.notifications = { create() { creates += 1; }, clear() {}, getAll(cb) { if (cb) cb({}); return Promise.resolve({}); } };
    await chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 0, alerts: 0 } });
    presenceCount = 0;
    handleFrame('SMS_RECEIVED:' + JSON.stringify({
      from: '+4790000001', body: 'deep link me', threadId: 'thread-42',
    }));
    handleFrame('PHONE_NOTIFICATION:' + JSON.stringify({
      title: 'WhatsApp', body: 'yo', hasReply: true,
    }));
    handleFrame('PHONE_NOTIFICATION:' + JSON.stringify({ title: 'Battery low', body: '5%' }));
    // The serialize() queue drains asynchronously; poll (<=5 s) rather than
    // trusting a fixed sleep.
    let unread = {};
    for (let i = 0; i < 50; i += 1) {
      unread = (await chrome.storage.session.get('cc_unread')).cc_unread || {};
      if (unread.newSms === 1 && unread.alerts === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const helpersGone = typeof rememberLink === 'undefined' && typeof takeLink === 'undefined';
    delete chrome.notifications;
    return { apiAbsent, creates, unread, helpersGone };
  });
  check('chrome.notifications is undefined in the SW (permission removed)', notifs.apiAbsent, JSON.stringify(notifs));
  check('SMS + 2 phone alerts raise ZERO OS toasts', notifs.creates === 0, JSON.stringify(notifs));
  check('…while the badge counters still count them (newSms 1, alerts 2)',
    !!notifs.unread && notifs.unread.newSms === 1 && notifs.unread.alerts === 2, JSON.stringify(notifs.unread));
  check('deep-link helpers rememberLink/takeLink are gone', notifs.helpersGone, JSON.stringify(notifs));
  // ---- 7. sign-out resets everything ---------------------------------------
  const out = await drive(async () => {
    const page = { type: 'signed-out' };
    return new Promise((resolve) => {
      chrome.runtime.onMessage.hasListeners();     // sanity
      // Call the handler's effects directly — sendMessage from the SW does not
      // reach the SW's own listener.
      signedIn = false; wsOpen = false; phonePresent = false; lastIndicator = null;
      chrome.storage.session.set({ cc_unread: { missedCalls: 0, newSms: 0, alerts: 0 } }, async () => {
        await refreshIndicator();
        resolve({
          title: await chrome.action.getTitle({}),
          unread: (await chrome.storage.session.get('cc_unread')).cc_unread,
          page: page.type,
        });
      });
    });
  });
  check('sign-out clears the dot and the counters',
    out.title === TITLE.out && out.unread.newSms === 0, JSON.stringify(out));

  // ---- 8. dock refuses gracefully without a gesture ------------------------
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popout.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const dock = await page
    .evaluate(() => chrome.runtime.sendMessage({ type: 'dock' }))
    .catch((e) => ({ err: String(e) }));
  console.log('\ndock result (no user gesture, automation):', JSON.stringify(dock));
  check('dock always answers Pixel-C with {ok, surface}',
    !!dock && typeof dock.surface === 'string' && typeof dock.ok === 'boolean',
    JSON.stringify(dock));
  await page.screenshot({ path: path.join(EVIDENCE, 'E-popout-dock.png') });
  await page.close();

} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(EVIDENCE, 'E-indicator-proof.json'), JSON.stringify(results, null, 2));
  await ctx.close();
  reaper.reapAndReport('ext-indicator-proof');
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
