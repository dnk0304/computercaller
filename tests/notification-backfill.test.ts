// Unit tests for lib/notificationMerge.ts — the Alerts-list merge, and in
// particular the v58 BACKFILL path (dispatch Forge-T, 2026-09-17).
//
// Dennis, 2026-09-17 10:52: "when we sync phone, it should fetch all
// notifications that currently are visible on the phone as well."
//
// The phone answers that by replaying its current shade as ordinary
// PHONE_NOTIFICATION frames tagged `backfill:true` with the original
// `postedAt`. Everything that makes a replay different from news lives in the
// merge: it must not displace a card the user is looking at, must not
// duplicate one already on screen, and must land at its real position in time
// rather than at the top.
//
// Runner-less by design — this repo has no Jest/Vitest harness. Run with
// Node's native type stripping:
//
//   node tests/notification-backfill.test.ts
//
// Exits non-zero if any assertion fails.

import {
  applyNotifEvents,
  isSameNotification,
  notificationCompositeSig,
  NOTIFICATION_COMPOSITE_WINDOW_MS,
  NOTIFICATION_LIST_CAP,
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

const T0 = 1_700_000_000_000;

function notif(over: Partial<PhoneNotification> = {}): PhoneNotification {
  return {
    id: 'id',
    appName: 'WhatsApp',
    packageName: 'com.whatsapp',
    title: 'Ana',
    body: 'hei',
    timestamp: T0,
    hasReply: false,
    replyKey: '',
    notificationKey: '0|com.whatsapp|1',
    read: false,
    ...over,
  };
}

const add = (n: PhoneNotification): NotifEvent => ({ type: 'add', notif: n });
const back = (n: PhoneNotification): NotifEvent => ({ type: 'add', notif: n, backfill: true });
const keys = (l: PhoneNotification[]) => l.map((n) => n.notificationKey);
const times = (l: PhoneNotification[]) => l.map((n) => n.timestamp);

// ── PART 1 — the live path is untouched ─────────────────────────────────────
// Every backfill assertion below is worthless if the guard changed the live
// behaviour on the way in, so establish that first.

console.log('\nPART 1 — live path (regression guard)');

{
  const a = notif({ notificationKey: 'k1', timestamp: T0 });
  const b = notif({ notificationKey: 'k2', title: 'Bo', body: 'yo', timestamp: T0 + 1000 });
  const out = applyNotifEvents([], [add(a), add(b)]);
  check('live adds prepend — newest frame on top', keys(out).join() === 'k2,k1', keys(out));
}

{
  // Axis 1: same sbn.key re-posted (a MessagingStyle in-place update).
  const first = notif({ notificationKey: 'k1', body: 'one' });
  const update = notif({ notificationKey: 'k1', body: 'one two', timestamp: T0 + 500 });
  const out = applyNotifEvents([first], [add(update)]);
  check('live re-post of the same key collapses to one card', out.length === 1, out.length);
  check('…and the card is the newer one', out[0].body === 'one two', out[0].body);
}

{
  // Axis 2: group-summary vs per-conversation child — identical text, DIFFERENT key.
  const child = notif({ notificationKey: '0|com.whatsapp|child' });
  const summary = notif({ notificationKey: '0|com.whatsapp|summary', timestamp: T0 + 200 });
  const out = applyNotifEvents([child], [add(summary)]);
  check('live content-identity dup collapses across different keys', out.length === 1, keys(out));
}

{
  const now = notif({ notificationKey: 'k1', timestamp: T0 });
  const later = notif({ notificationKey: 'k2', timestamp: T0 + NOTIFICATION_COMPOSITE_WINDOW_MS + 1 });
  const out = applyNotifEvents([now], [add(later)]);
  check('identical text OUTSIDE the composite window keeps both cards', out.length === 2, keys(out));
}

{
  const out = applyNotifEvents([notif({ notificationKey: 'k1' })], [{ type: 'remove', key: 'k1' }]);
  check('remove drops the exact key', out.length === 0, keys(out));
}

{
  const sibling = notif({ notificationKey: 'k2', body: 'different' });
  const out = applyNotifEvents([notif({ notificationKey: 'k1' }), sibling], [{ type: 'remove', key: 'k1' }]);
  check('remove does NOT widen to the content composite', keys(out).join() === 'k2', keys(out));
}

// ── PART 2 — backfill ordering ──────────────────────────────────────────────

console.log('\nPART 2 — backfill merges chronologically');

{
  // A sync into an empty list: the phone sends newest-first; the rendered list
  // must come out newest-first regardless of the order the frames arrive in.
  const shade = [
    back(notif({ notificationKey: 'old', timestamp: T0 - 60_000, body: 'old' })),
    back(notif({ notificationKey: 'new', timestamp: T0, body: 'new' })),
    back(notif({ notificationKey: 'mid', timestamp: T0 - 30_000, body: 'mid' })),
  ];
  const out = applyNotifEvents([], shade);
  check('backfill into an empty list sorts by postedAt, newest first',
    keys(out).join() === 'new,mid,old', keys(out));
}

{
  // The case that matters: a live card is already on screen. A replayed card
  // older than it must land BELOW it — not at the top, where the live path
  // would have put it.
  const live = notif({ notificationKey: 'live', body: 'just now', timestamp: T0 });
  const older = notif({ notificationKey: 'old', body: 'an hour ago', timestamp: T0 - 3_600_000 });
  const out = applyNotifEvents([live], [back(older)]);
  check('an older backfill card does NOT displace a live card',
    keys(out).join() === 'live,old', keys(out));
}

{
  // …and a replayed card NEWER than what is on screen sorts above it. Without
  // this arm the previous check would also pass for a merge that simply
  // appends everything, which would prove nothing about ordering.
  const live = notif({ notificationKey: 'live', body: 'stale card', timestamp: T0 - 3_600_000 });
  const newer = notif({ notificationKey: 'fresh', body: 'newer', timestamp: T0 });
  const out = applyNotifEvents([live], [back(newer)]);
  check('a newer backfill card sorts ABOVE an older live card',
    keys(out).join() === 'fresh,live', keys(out));
}

{
  const live = notif({ notificationKey: 'live', body: 'x', timestamp: T0 });
  const tie = notif({ notificationKey: 'tie', body: 'y', timestamp: T0 });
  const out = applyNotifEvents([live], [back(tie)]);
  check('on an exact timestamp tie the incumbent keeps the higher slot',
    keys(out).join() === 'live,tie', keys(out));
}

{
  const list = [
    notif({ notificationKey: 'a', body: 'a', timestamp: T0 }),
    notif({ notificationKey: 'c', body: 'c', timestamp: T0 - 20_000 }),
  ];
  const out = applyNotifEvents(list, [back(notif({ notificationKey: 'b', body: 'b', timestamp: T0 - 10_000 }))]);
  check('a backfill card slots BETWEEN two existing cards', keys(out).join() === 'a,b,c', keys(out));
  check('…and nothing else moved', times(out).join() === [T0, T0 - 10_000, T0 - 20_000].join(), times(out));
}

// ── PART 3 — backfill dedupe (the duplicate-card risk) ──────────────────────

console.log('\nPART 3 — backfill dedupe against what is already there');

{
  // The common case: the panel was open when the message arrived, then the user
  // hits sync. The shade still holds it, so it comes back as a backfill frame
  // carrying the SAME sbn.key. One card, not two.
  const live = notif({ notificationKey: '0|com.whatsapp|7', body: 'hei', timestamp: T0 });
  const replay = notif({ notificationKey: '0|com.whatsapp|7', body: 'hei', timestamp: T0 });
  const out = applyNotifEvents([live], [back(replay)]);
  check('backfill of an already-present key ⇒ one card', out.length === 1, keys(out));
}

{
  // The existing card must WIN, not be replaced: it is the one the user has
  // been looking at (and it carries whatever read/reply state the session put
  // on it), while the replay is the same content arriving second.
  const live = notif({ notificationKey: 'k', body: 'hei', read: true, replyKey: 'rk-live' });
  const replay = notif({ notificationKey: 'k', body: 'hei', read: false, replyKey: '' });
  const out = applyNotifEvents([live], [back(replay)]);
  check('the incumbent card survives a backfill replay, not the replay',
    out[0].replyKey === 'rk-live' && out[0].read === true, out[0]);
}

{
  // Content-identity axis, same as live: the shade holds BOTH the group summary
  // and the child, so a sync replays two frames for one logical message.
  const out = applyNotifEvents([], [
    back(notif({ notificationKey: '0|com.whatsapp|child', timestamp: T0 })),
    back(notif({ notificationKey: '0|com.whatsapp|summary', timestamp: T0 + 300 })),
  ]);
  check('two backfill frames for one logical message collapse to one card',
    out.length === 1, keys(out));
}

{
  const out = applyNotifEvents([], [
    back(notif({ notificationKey: 'k1', body: 'first', timestamp: T0 })),
    back(notif({ notificationKey: 'k2', body: 'second', timestamp: T0 - 1000 })),
  ]);
  check('genuinely different backfill cards are NOT collapsed', out.length === 2, keys(out));
}

{
  // Backfill and live must agree on identity, or a sync duplicates every card.
  const a = notif({ notificationKey: 'k1', body: 'same' });
  const b = notif({ notificationKey: 'k2', body: 'same', timestamp: T0 + 100 });
  check('isSameNotification is the one identity both paths use',
    isSameNotification(a, b) === true
    && notificationCompositeSig(a) === notificationCompositeSig(b));
}

{
  // A backfill card with an EMPTY notificationKey must not match every other
  // empty-keyed card by axis 1 — the content axis has to carry it.
  const a = notif({ notificationKey: '', body: 'alpha' });
  const b = notif({ notificationKey: '', body: 'beta' });
  check('two empty-key cards with different bodies stay distinct',
    isSameNotification(a, b) === false);
  const out = applyNotifEvents([a], [back(b)]);
  check('…and both survive the merge', out.length === 2, out.map((n) => n.body));
}

// ── PART 4 — cap and interleaving ───────────────────────────────────────────

console.log('\nPART 4 — cap + mixed batches');

{
  const shade = Array.from({ length: 60 }, (_, i) =>
    back(notif({ notificationKey: `k${i}`, body: `m${i}`, timestamp: T0 - i * 60_000 })));
  const out = applyNotifEvents([], shade);
  check(`a 60-card shade is capped at ${NOTIFICATION_LIST_CAP}`, out.length === NOTIFICATION_LIST_CAP, out.length);
  check('the cap keeps the NEWEST cards', keys(out)[0] === 'k0' && keys(out)[49] === 'k49', [keys(out)[0], keys(out)[49]]);
}

{
  // A live frame arriving mid-sync still wins the top slot — the phone is not
  // allowed to bury news under its own history.
  const out = applyNotifEvents([], [
    back(notif({ notificationKey: 'h1', body: 'history', timestamp: T0 - 3_600_000 })),
    add(notif({ notificationKey: 'live', body: 'incoming now', timestamp: T0 })),
    back(notif({ notificationKey: 'h2', body: 'history 2', timestamp: T0 - 7_200_000 })),
  ]);
  check('a live frame interleaved with a sync still lands on top',
    keys(out).join() === 'live,h1,h2', keys(out));
}

{
  // A dismissal that arrives in the same batch as the replay of the thing it
  // dismissed must still win, whatever the order.
  const out = applyNotifEvents([], [
    back(notif({ notificationKey: 'k1', timestamp: T0 })),
    { type: 'remove', key: 'k1' },
  ]);
  check('a removal in the same batch clears the backfilled card', out.length === 0, keys(out));
}

{
  const out = applyNotifEvents([notif({ notificationKey: 'k1' })], []);
  check('an empty batch is a no-op', out.length === 1);
}

{
  // The flag has to survive onto the rendered card, not just steer the merge:
  // PhoneModeShell's toast effect fires on "the newest card changed", and a
  // sync can legitimately put a replayed card at the top. Without a flag on the
  // card there is nothing there to tell history from news.
  const out = applyNotifEvents([], [back(notif({ notificationKey: 'k1', backfill: true }))]);
  check('the backfill flag reaches the rendered card', out[0].backfill === true, out[0]);
  const live = applyNotifEvents([], [add(notif({ notificationKey: 'k2' }))]);
  check('a live card carries no backfill flag', !live[0].backfill, live[0]);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
