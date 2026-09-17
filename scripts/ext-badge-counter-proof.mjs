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
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { Reaper } from './lib/reap.mjs';
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
// P5a(c) / WORKTREE_STANDARD rule 14: record what we spawn so we can kill it
// by PID in the finally below — on the failure path as well as the success one.
const reaper = new Reaper().installExitHook('ext-badge-counter-proof');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

try {
  // P5a(a): wake the MV3 worker instead of polling for one that is registered
  // but idle. `ctx.serviceWorkers()` lists only RUNNING workers, so the old
  // 60x500ms poll reported "service worker never registered" for a perfectly
  // healthy extension whenever nothing had happened to start it. The
  // assertions below are unchanged. See scripts/lib/ext-sw.mjs.
  const sw = await awaitServiceWorker(ctx, null, { extDir: EXT });
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
  // Drain the serialize() mutex the counters and the badge share.
  //
  // This used to be a flat 400ms sleep and it was FLAKY — roughly one run in
  // three, the first multi-frame feed read back {newSms:1} out of four frames
  // and failed, while a LATER assertion in the same run read the full count,
  // which is self-contradictory and the tell that the harness was racing its
  // subject rather than measuring it. bumpUnread queues each frame behind an
  // async chrome.storage read-modify-write; under a burst the queue can still
  // be draining at 400ms on a loaded machine.
  //
  // Now it waits for QUIESCENCE: poll the counters until the sum is stable
  // across two consecutive reads, then let the badge repaint settle. Bounded
  // so a genuine hang fails the run instead of spinning forever.
  const feed = (frames) => sw.evaluate(async (fs_) => {
    for (const f of fs_) handleFrame(f);
    const sum = (u) => (u.missedCalls || 0) + (u.newSms || 0) + (u.alerts || 0);
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 60 && stable < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const now = sum(await readUnread());
      stable = now === prev ? stable + 1 : 0;
      prev = now;
    }
    // The counters have settled; give the badge write that follows them a tick.
    await new Promise((r) => setTimeout(r, 150));
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

  // ---- 9. Addendum B: an OUTGOING sms must not notify and must not count ---
  //
  // Dennis 2026-09-15: "i also got a pop-up notification when sent an sms out.
  // I only want on incoming, not outgoing."
  //
  // SMS_RECEIVED is the frame for a single SMS ROW in EITHER direction — the
  // APK tags it type:"sent" for outgoing (PhoneService.kt:2667 RCS mirror,
  // :2927 ContentObserver push, :2999 MMS/backfill). The payload here uses the
  // REAL wire shape {id, from, body, time, type} rather than the test-local
  // {address, date} one above, because the direction field is the whole point.
  //
  // Both halves are asserted. A fix that suppressed only the popup would leave
  // the badge counting your own outbox, which is the same bug in a quieter
  // costume — so the notification count is captured too, by wrapping
  // chrome.notifications.create rather than by trusting the counter.
  const SMS_DIR = (id, type) => 'SMS_RECEIVED:' + JSON.stringify({
    id, from: '+4733333333', body: 'hello', time: Date.now(), type,
  });

  const armNotifSpy = () => sw.evaluate(() => {
    self.__notifSpy = 0;
    if (!self.__notifOrig) self.__notifOrig = chrome.notifications.create;
    chrome.notifications.create = function (...args) {
      self.__notifSpy += 1;
      return self.__notifOrig.apply(chrome.notifications, args);
    };
  });
  const notifCount = () => sw.evaluate(() => self.__notifSpy);

  // 9a. outgoing, every surface closed — the exact condition Dennis hit.
  await reset();
  await sw.evaluate(() => { presenceCount = 0; });
  await armNotifSpy();
  await feed([SMS_DIR(101, 'sent')]);
  b = await badge();
  check('outgoing SMS (type:"sent") ⇒ badge NOT bumped', b === '', b);
  check('outgoing SMS (type:"sent") ⇒ NO notification', (await notifCount()) === 0, await notifCount());

  // 9b. the control arm. If this does not fire, 9a proves nothing — a
  // suppressor that suppresses everything passes 9a trivially.
  await reset();
  await armNotifSpy();
  await feed([SMS_DIR(102, 'inbox')]);
  b = await badge();
  check('incoming SMS (type:"inbox") ⇒ badge bumped to "1"', b === '1', b);
  check('incoming SMS (type:"inbox") ⇒ notification raised', (await notifCount()) === 1, await notifCount());

  // 9c. a row with no direction marker at all must still notify. Defaulting to
  // "outgoing" would silently swallow real texts from any producer that omits
  // the field — fail toward the cheaper mistake.
  await reset();
  await armNotifSpy();
  await feed([SMS(7)]);
  b = await badge();
  check('SMS with NO type field still counts (defaults to incoming)', b === '1', b);
  check('SMS with NO type field still notifies', (await notifCount()) === 1, await notifCount());

  // 9d. mixed burst: only the incoming half survives.
  await reset();
  await armNotifSpy();
  await feed([SMS_DIR(103, 'sent'), SMS_DIR(104, 'inbox'), SMS_DIR(105, 'sent'), SMS_DIR(106, 'inbox')]);
  b = await badge();
  check('2 outgoing + 2 incoming ⇒ badge "2", not "4"', b === '2', b);
  check('2 outgoing + 2 incoming ⇒ exactly 2 notifications', (await notifCount()) === 2, await notifCount());

  // 9e. the wrapped shape the web layer's normalizePayload produces
  // ({message:{...}}) must be read the same way — one spelling of the marker
  // getting through is how a suppressor quietly stops working.
  await reset();
  await armNotifSpy();
  await feed(['SMS_RECEIVED:' + JSON.stringify({ message: { id: 107, from: '+47', body: 'x', type: 'sent' } })]);
  b = await badge();
  check('wrapped {message:{type:"sent"}} also suppressed', b === '' && (await notifCount()) === 0, b);

  // ---- 10. Addendum A: the MV3 keepalive HB must be inert -----------------
  //
  // The relay pushes HB to listener sockets every 15s so the worker receives a
  // real message (a protocol ws ping fires no JS event and does not reset MV3's
  // idle timer — measured: the worker was evicted twice in 5.5 min despite
  // those pings, and a frame pushed into the gap was lost).
  //
  // Arriving is its whole job, so it must do NOTHING else. The trap it has to
  // clear is background.js' `if (type !== 'PING' && type !== 'PONG')
  // notePhonePresence(true)` catch-all: an HB falling through that would turn
  // the green dot on for a room with no phone in it — the precise lie the
  // wsOpen/phonePresent split exists to prevent.
  await reset();
  await armNotifSpy();
  await sw.evaluate(() => { phonePresent = false; lastIndicator = null; });
  await feed(['HB:{}', 'HB:{}', 'HB:{}']);
  b = await badge();
  const hbState = await sw.evaluate(() => ({ phonePresent, unreadSum: null }));
  check('HB does not notify', (await notifCount()) === 0, await notifCount());
  check('HB does not bump the badge', b === '', b);
  check('HB does NOT claim a phone is present', hbState.phonePresent === false, hbState);

  // ---- 11. FORGE-O: the green dot must mean PAIRED, not "a phone exists" ---
  //
  // Dennis 2026-09-16, 10:01: "the CC extension is showing 'phone connected and
  // green dot' even though phone is not connected."
  //
  // Reproduced from Ken's relay log for room MRsNsod3. The 6eb9bc7 deploy
  // restarted the relay, which wiped the in-memory pair claim. At 09:57:06 the
  // phone joined the LOBBY; at 09:57:33 our listener joined and was handed
  // `LOBBY_STATUS:{phonePresent:true, alreadyActive:false}`. The phone then
  // pinged every 15 s for four minutes with no pair — and the dot was green the
  // whole time, over a connection that could not place a call or send a text.
  //
  // Read back through `lastIndicator`, which is the value applyIndicator
  // actually committed to chrome.action, rather than through the fact variables
  // — the bug was never in the facts, it was in the rule that mapped them.
  const indicator = () => sw.evaluate(() => lastIndicator);
  const title = () => sw.evaluate(() => chrome.action.getTitle({}));
  /** Put the worker in a known signed-in, socket-up state with no pair. */
  const armIndicator = () => sw.evaluate(async () => {
    signedIn = true; wsOpen = true;
    phonePresent = false; paired = false; held = false;
    lastIndicator = null;
    refreshIndicator();
    await new Promise((r) => setTimeout(r, 120));
  });
  const PAIR_STATE = (o) => 'PAIR_STATE:' + JSON.stringify(o);
  /** Feed one control frame and let the async applyIndicator settle. */
  const feedState = (frame) => sw.evaluate(async (f) => {
    handleFrame(f);
    await new Promise((r) => setTimeout(r, 150));
  }, frame);

  // 11a. THE REGRESSION. The exact frame the listener got at 09:57:33.
  await armIndicator();
  await feedState('LOBBY_STATUS:' + JSON.stringify({ phonePresent: true, alreadyActive: false }));
  let ind = await indicator();
  check('REGRESSION: lobby phone, no pair ⇒ NOT connected (was green)',
    ind !== 'connected', ind);
  check('REGRESSION: that state is reported as phone-unpaired',
    ind === 'phone-unpaired', ind);
  let t = await title();
  check('its tooltip tells the user to press Connect',
    /not connected/i.test(t) && /Connect/.test(t), t);

  // 11b. alreadyActive is NOT pairedness for a listener either. A pair existing
  // somewhere in the room says nothing about a listener that is not in it.
  await armIndicator();
  await feedState('LOBBY_STATUS:' + JSON.stringify({ phonePresent: true, alreadyActive: true }));
  ind = await indicator();
  check('alreadyActive alone does NOT earn green', ind !== 'connected', ind);

  // 11c. the full state table, driven through the authoritative frame.
  await armIndicator();
  await feedState(PAIR_STATE({ phonePresent: false, paired: false, held: false }));
  ind = await indicator();
  check('no phone ⇒ grey (signed-in-disconnected)', ind === 'signed-in-disconnected', ind);

  await feedState(PAIR_STATE({ phonePresent: true, paired: false, held: false }));
  ind = await indicator();
  check('phone present, unpaired ⇒ grey (phone-unpaired)', ind === 'phone-unpaired', ind);

  await feedState(PAIR_STATE({ phonePresent: true, paired: false, held: true }));
  ind = await indicator();
  check('held claim ⇒ amber (resuming), not green', ind === 'resuming', ind);

  await feedState(PAIR_STATE({ phonePresent: true, paired: true, held: false }));
  ind = await indicator();
  check('PAIRED ⇒ green. The control arm — without this the rest is vacuous',
    ind === 'connected', ind);
  t = await title();
  check('green says connected', /connected/i.test(t), t);

  // 11d. and back down again. A dot that can only go green is not an indicator.
  await feedState(PAIR_STATE({ phonePresent: true, paired: false, held: false }));
  ind = await indicator();
  check('pair torn down ⇒ leaves green immediately', ind === 'phone-unpaired', ind);

  // 11e. a malformed/empty PAIR_STATE must fail toward grey, never toward a
  // connection the user does not have.
  await armIndicator();
  await feedState(PAIR_STATE({ phonePresent: true, paired: true, held: false }));
  check('green before the malformed frame', (await indicator()) === 'connected');
  await feedState('PAIR_STATE:{');
  ind = await indicator();
  check('malformed PAIR_STATE falls back to grey, not green', ind !== 'connected', ind);

  // 11f. THE CATCH-ALL DEMOTION. background.js promotes any non-PING data frame
  // to "a phone is present" — correct, and it must stay. But it must no longer
  // imply a PAIR: server.js fans phone frames to listeners BEFORE the
  // active-pair gate precisely so notifications survive a closed panel, so an
  // SMS arriving during a HELD pair is routine and is not evidence the pair is
  // live. Inferring green here would rebuild the bug at its worst moment.
  await armIndicator();
  await feedState(PAIR_STATE({ phonePresent: true, paired: false, held: true }));
  check('held before the data frame', (await indicator()) === 'resuming');
  await feed([SMS(201)]);
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  ind = await indicator();
  check('an SMS during a HELD pair does NOT turn the dot green', ind === 'resuming', ind);

  // ---- 12. FORGE-O deliverable 3: notifications while the panel is CLOSED --
  //
  // Dennis: "I need to get notified in the extension if a message, alert or
  // call is incoming even when its closed. Is that doable?" — asserted here
  // under the FORGE-M hold state specifically, which is the hard case: panel
  // closed (presenceCount 0), pair HELD rather than active. The frames must
  // reach the listener and raise a real notification, not merely land in
  // room.frameBuffer to be replayed to a browser that is not there.
  await reset();
  await armIndicator();
  await feedState(PAIR_STATE({ phonePresent: true, paired: false, held: true }));
  await sw.evaluate(() => { presenceCount = 0; });   // panel CLOSED
  await armNotifSpy();
  await feed([SMS_DIR(301, 'inbox'), CALL, NOTIF]);
  b = await badge();
  check('HELD pair + panel CLOSED: SMS/call/alert ⇒ badge "3"', b === '3', b);
  check('HELD pair + panel CLOSED: 3 notifications raised',
    (await notifCount()) === 3, await notifCount());
  check('…and the dot still refuses to claim a live pair',
    (await indicator()) === 'resuming', await indicator());

  // 12b. the Forge-J guard, re-asserted under the hold state — an outgoing SMS
  // must stay silent here too, or the hold path becomes a way to smuggle the
  // suppressed notification back in.
  await reset();
  await armNotifSpy();
  await feed([SMS_DIR(302, 'sent')]);
  b = await badge();
  check('HELD pair + panel CLOSED: OUTGOING sms still silent',
    b === '' && (await notifCount()) === 0, { badge: b, notifs: await notifCount() });
} finally {
  await ctx.close();
  reaper.reapAndReport('ext-badge-counter-proof');
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
