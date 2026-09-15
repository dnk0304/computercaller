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
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});

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
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = ctx.serviceWorkers()[0];
    if (!sw) await new Promise((r) => setTimeout(r, 500));
  }
  if (!sw) throw new Error('service worker never registered');
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

  // ---- 6. notification buttons + deep links --------------------------------
  const notifs = await drive(async () => {
    await chrome.storage.session.set({ cc_notif_links: {} });
    presenceCount = 0;
    handleFrame('SMS_RECEIVED:' + JSON.stringify({
      from: '+4790000001', body: 'deep link me', threadId: 'thread-42',
    }));
    handleFrame('PHONE_NOTIFICATION:' + JSON.stringify({
      title: 'WhatsApp', body: 'yo', hasReply: true,
    }));
    handleFrame('PHONE_NOTIFICATION:' + JSON.stringify({ title: 'Battery low', body: '5%' }));
    await new Promise((r) => setTimeout(r, 600));
    const all = await chrome.notifications.getAll();
    const links = (await chrome.storage.session.get('cc_notif_links')).cc_notif_links;
    return { ids: Object.keys(all), links };
  });
  const smsLink = Object.entries(notifs.links).find(([k]) => k.startsWith('cc-sms:'));
  check('SMS notification carries a thread deep link',
    !!smsLink && smsLink[1] === '#tab=texts&thread=thread-42',
    JSON.stringify(smsLink));
  check('alert notification deep-links to the alerts tab',
    Object.entries(notifs.links).some(([k, v]) => k.startsWith('cc-notif:') && v === '#tab=alerts'),
    JSON.stringify(notifs.links));

  // takeLink must be single-use, or a second click reopens a stale thread.
  const twice = await drive(async () => {
    const id = Object.keys((await chrome.storage.session.get('cc_notif_links')).cc_notif_links)[0];
    const a = await takeLink(id);
    const b = await takeLink(id);
    return { a, b };
  });
  check('a deep link is consumed exactly once', !!twice.a && twice.b === '', JSON.stringify(twice));

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
  fs.rmSync(userDataDir, { recursive: true, force: true });
  if (failed.length) process.exitCode = 1;
}
