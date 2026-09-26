// tests/alert-unread.test.ts — item 8 (Dennis 2026-09-26): backfilled alerts
// are UNREAD until opened or dismissed, in the extension AND the web.
//
// RULE 30 vectors for the four traps in Ken's brief
// (DISPATCH-BRIEF-FORGE-BACKFILL-UNREAD-8.md):
//   1. a replay on every sync/reconnect must not relight an alert the user
//      already opened or dismissed (read state keyed by key + content hash,
//      persisted, applied on BOTH sides);
//   2. the badge is the size of an unread SET, never a per-frame counter;
//   3. badge and dots are ONE definition: the page model and the worker model
//      give the same number at every step of Ken's timeline;
//   4. sealed and plain share the path (the pure half: one record builder,
//      one copy of the rule; the worker half is in the badge proof).
//
//   node tests/alert-unread.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  alertEntryOf,
  addMarks,
  foldAlert,
  dropAlertKey,
  hashSig,
  alertSig,
  cleanRecords,
  UNREAD_SET_CAP,
  type AlertRecord,
} from '../lib/alertUnread.mjs';
import {
  applyNotifEvents,
  applyReadMarks,
  isUnreadAlert,
  readMarkOf,
  unreadAlertEntries,
  type NotifEvent,
} from '../lib/notificationMerge.ts';
import type { PhoneNotification } from '../hooks/usePhoneBridge.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else {
    fail += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1_700_000_000_000;

function card(i: number, over: Partial<PhoneNotification> = {}): PhoneNotification {
  return {
    id: `id${i}`,
    appName: 'WhatsApp',
    packageName: 'com.whatsapp',
    title: `Sender ${i}`,
    body: `message ${i}`,
    timestamp: T0 + i * 60_000,
    hasReply: false,
    replyKey: '',
    notificationKey: `0|com.whatsapp|${i}`,
    read: false,
    ...over,
  };
}
const back = (n: PhoneNotification): NotifEvent => ({ type: 'add', notif: { ...n, backfill: true }, backfill: true });
const live = (n: PhoneNotification): NotifEvent => ({ type: 'add', notif: n });
const removed = (key: string): NotifEvent => ({ type: 'remove', key });

/** The page, as usePhoneBridge runs it: merge, then persisted marks. */
function pageFlush(prev: PhoneNotification[], events: NotifEvent[], marks: AlertRecord[]) {
  return applyReadMarks(applyNotifEvents(prev, events), marks);
}
const pageCount = (list: PhoneNotification[]) => list.filter(isUnreadAlert).length;

/** The worker, as noteAlert/dropAlert run it (panel closed). */
function swApply(set: AlertRecord[], events: NotifEvent[], marks: AlertRecord[]) {
  let s = set;
  for (const e of events) {
    if (e.type === 'remove') s = dropAlertKey(s, e.key);
    else s = foldAlert(s, alertEntryOf(e.notif), !!e.backfill, marks);
  }
  return s;
}

const SHADE = [1, 2, 3, 4, 5].map((i) => card(i));

console.log('\nDRIFT — the worker runs a byte-identical copy of the rule');
{
  const norm = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const lib = norm('lib/alertUnread.mjs');
  const ext = norm('chrome-extension/alert-unread.js');
  check('chrome-extension/alert-unread.js === lib/alertUnread.mjs', lib === ext,
    { libBytes: lib.length, extBytes: ext.length });
  const bg = norm('chrome-extension/background.js');
  check('background.js imports the copy', bg.includes("from './alert-unread.js'"));
  check('background.js no longer early-returns on backfill',
    !/data\.backfill === true\) return;/.test(bg));
}

console.log('\nBASICS — the reversal itself');
{
  const replayed: PhoneNotification = { ...card(1), backfill: true };
  check('a backfill card IS unread (item 8 reverses fa69f8b/d8c7aa4)', isUnreadAlert(replayed));
  check('a read card is not unread', !isUnreadAlert(card(1, { read: true })));
  const synced = pageFlush([], SHADE.map(back), []);
  check('connect with 5 in the shade ⇒ web shows 5 unread', pageCount(synced) === 5, pageCount(synced));
  const sw = swApply([], SHADE.map(back), []);
  check('connect with 5 in the shade ⇒ worker set is 5', sw.length === 5, sw.length);
  check('hash is stable and content-sensitive',
    hashSig('a|b|c') === hashSig('a|b|c') && hashSig('a|b|c') !== hashSig('a|b|d')
    && /^[0-9a-f]{14}$/.test(hashSig('x')));
  check('a mark carries no notification text',
    !JSON.stringify(readMarkOf(card(1))).includes('message 1')
    && !JSON.stringify(readMarkOf(card(1))).includes('Sender'));
  check('sig normalises whitespace like notificationCompositeSig',
    alertSig({ packageName: 'p', title: ' a  b ', body: 'c\n d' }) === 'p|a b|c d');
}

console.log('\nTRAP 1 — a replay does not relight what was read');
{
  // Open card 2 (tap), dismiss card 4: both recorded as read marks.
  const marks = addMarks([], [readMarkOf(SHADE[1]), readMarkOf(SHADE[3])]);
  // RECONNECT / new panel page: the list starts EMPTY and the phone replays.
  // Card 4 was dismissed on the web; say its cancel has not reached the phone
  // yet, so the replay still carries it.
  const replay = pageFlush([], SHADE.map(back), marks);
  check('web: replay after reconnect ⇒ opened + dismissed stay read (3)', pageCount(replay) === 3, pageCount(replay));
  const sw = swApply([], SHADE.map(back), marks);
  check('worker: same replay with the page\'s marks ⇒ 3', sw.length === 3, sw.length);
  // Replay twice (two reconnects): nothing changes.
  const again = pageFlush(replay, SHADE.map(back), marks);
  check('web: a second replay changes nothing', pageCount(again) === 3 && again.length === 5, again.length);
  check('worker: a second replay changes nothing', swApply(sw, SHADE.map(back), marks).length === 3);
  // d8c7aa4 kept: identical live re-post of a read alert stays read …
  const repost = pageFlush(replay, [live({ ...SHADE[1], id: 'x', timestamp: T0 + 9e6 })], marks);
  check('web: identical LIVE re-post of a read alert stays read', pageCount(repost) === 3, pageCount(repost));
  check('worker: identical LIVE re-post stays read',
    swApply(sw, [live({ ...SHADE[1], id: 'x', timestamp: T0 + 9e6 })], marks).length === 3);
  // … and new content under the old key is news.
  const news = card(2, { body: 'a NEW message', id: 'y', timestamp: T0 + 9e6 });
  check('web: NEW content under a read key ⇒ unread', pageCount(pageFlush(replay, [live(news)], marks)) === 4);
  check('worker: NEW content under a read key ⇒ counted', swApply(sw, [live(news)], marks).length === 4);
  // Marks resolved late (account id arrives after the replay): applied on arrival.
  const early = pageFlush([], SHADE.map(back), []);
  const late = applyReadMarks(early, marks);
  check('web: marks applied after the list already filled ⇒ 3', pageCount(late) === 3, pageCount(late));
  check('applyReadMarks returns the SAME array when nothing changes (no re-render)',
    applyReadMarks(late, marks) === late);
  // Summary/child twin of a read card: other key, same content, within 10 s.
  const twin = { ...SHADE[1], id: 'tw', notificationKey: '0|com.whatsapp|summary', timestamp: SHADE[1].timestamp + 3_000 };
  check('web: the summary twin (other key, same content, 3 s) of a read card stays read',
    pageCount(pageFlush([], [back(twin)], marks)) === 0);
  check('worker: same twin not counted', swApply([], [back(twin)], marks).length === 0);
  // Stored marks survive a round trip through JSON (localStorage / storage.session).
  const round = cleanRecords(JSON.parse(JSON.stringify(marks)));
  check('marks round-trip through storage unchanged', JSON.stringify(round) === JSON.stringify(marks));
  check('garbage in storage is ignored, not thrown', cleanRecords([null, 1, { k: 1 }, { k: 'a', h: 'b', t: 'x' }]).length === 1);
}

console.log('\nTRAP 2 — a SET, never a per-frame counter');
{
  const one = card(7);
  const s1 = swApply([], [back(one), live({ ...one, id: 'l7' })], []);
  check('backfill + live post of the same key ⇒ 1', s1.length === 1, s1);
  const s2 = swApply([], [live(one), back(one), back(one)], []);
  check('live then the same alert replayed twice ⇒ 1', s2.length === 1, s2);
  const summary = { ...one, id: 's', notificationKey: '0|com.whatsapp|g', timestamp: one.timestamp + 1_000 };
  const s3 = swApply([], [live(one), live(summary)], []);
  check('group summary + child (two keys, same content, 1 s) ⇒ 1', s3.length === 1, s3);
  const web3 = pageFlush([], [live(one), live(summary)], []);
  check('…and the web agrees (1 card, 1 unread)', web3.length === 1 && pageCount(web3) === 1);
  const burst = Array.from({ length: 80 }, (_, i) => live(card(100 + i)));
  const s4 = swApply([], burst, []);
  check(`set is bounded at ${UNREAD_SET_CAP}, keeping the newest`,
    s4.length === UNREAD_SET_CAP && s4.every((e) => e.t >= card(130).timestamp!), s4.length);
  check('a removal for a key never counted changes nothing', dropAlertKey(s1, 'nope').length === 1);
}

console.log('\nTRAP 3 — badge and dots are one number (Ken\'s timeline, both models)');
{
  // Worker receives the page's report while the panel is open (applyAlertsState
  // REPLACES its set with unreadAlertEntries), and folds frames itself while it
  // is closed. Both are driven here and compared at every step.
  let marks: AlertRecord[] = [];
  let web: PhoneNotification[] = [];
  let sw: AlertRecord[] = [];
  const report = () => { sw = unreadAlertEntries(web); };
  const step = (name: string, want: number) => {
    const w = pageCount(web);
    check(`${name}: web ${w} == badge ${sw.length} == ${want}`, w === want && sw.length === want, { web: w, sw: sw.length });
  };

  // Panel CLOSED at connect: the worker counts the replay itself.
  sw = swApply(sw, SHADE.map(back), marks);
  check('panel closed, 5 replayed ⇒ worker 5', sw.length === 5, sw.length);
  // Panel opens: new page, replay again, page reports.
  web = pageFlush([], SHADE.map(back), marks); report();
  step('sync 5', 5);
  // Open card 1.
  marks = addMarks(marks, [readMarkOf(web.find((n) => n.id === 'id1')!)]);
  web = web.map((n) => (n.id === 'id1' ? { ...n, read: true } : n)); report();
  step('open 1', 4);
  // Dismiss card 3 (clearNotification: mark + drop).
  marks = addMarks(marks, [readMarkOf(web.find((n) => n.id === 'id3')!)]);
  web = web.filter((n) => n.id !== 'id3'); report();
  step('dismiss 1', 3);
  // Tab round trips Dial↔Texts↔Alerts: no event, no change.
  report(); report(); step('tab round-trips', 3);
  // Panel closes; relay drops; RECONNECT replays the shade (card 3's cancel
  // not yet applied on the phone) while every surface is closed.
  sw = swApply(sw, SHADE.map(back), marks);
  check('reconnect, panel CLOSED ⇒ worker still 3', sw.length === 3, sw.length);
  // Panel reopens: fresh page, replay, report.
  web = pageFlush([], SHADE.map(back), marks); report();
  step('reconnect, panel reopened', 3);
  // Phone removes card 5 (NOTIFICATION_REMOVED).
  web = pageFlush(web, [removed(SHADE[4].notificationKey)], marks); report();
  step('phone removes 1', 2);
  // Same removal with the panel CLOSED: the worker's own path.
  const closed = swApply(swApply([], SHADE.map(back), marks), [removed(SHADE[4].notificationKey)], marks);
  check('phone removes 1, panel closed ⇒ worker 2', closed.length === 2, closed.length);
  // Worker restart: the set and marks are storage records; a respawn reads
  // the same records back (cleanRecords is exactly the read path).
  const respawned = cleanRecords(JSON.parse(JSON.stringify(sw)));
  check('worker restart ⇒ same set, same count', respawned.length === 2);
}

console.log('\nTRAP 4 — sealed and plain build the same record');
{
  // The worker unseals a sealed frame and hands the SAME object to
  // deliverFrame; the plain path hands the parsed JSON. One builder.
  const payload = { notificationKey: '0|com.whatsapp|9', id: 'n9', packageName: 'com.whatsapp', title: 'Ana', body: 'hei', timestamp: T0 };
  const viaPlain = alertEntryOf(JSON.parse(JSON.stringify(payload)));
  const viaSealed = alertEntryOf(structuredClone(payload));
  check('plain and unsealed payloads give an identical record', JSON.stringify(viaPlain) === JSON.stringify(viaSealed));
  check('the page card for that payload gives the same record too',
    JSON.stringify(readMarkOf(card(9, { notificationKey: payload.notificationKey, id: 'n9', title: 'Ana', body: 'hei', timestamp: T0 })))
      === JSON.stringify(viaPlain));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
