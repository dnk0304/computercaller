/**
 * tests/notif-icon-store.test.ts — the app-icon store (ALERT-ICONS) and the
 * letter-tile fallback it pairs with.
 *
 * Pinned: set/get, the localStorage mirror and its reload, the 60-app LRU cap,
 * the 24 KB skip, sign-out clearing BOTH copies, listeners firing only on a
 * real change, storage that THROWS on every call, and the tile's contrast
 * (white letter >= 4.5:1 on every fill) plus its stability.
 *
 *   node tests/notif-icon-store.test.ts
 */

import {
  NOTIF_ICON_STORAGE_KEY,
  NOTIF_ICON_MAX_ENTRIES,
  NOTIF_ICON_MAX_BYTES,
  getNotificationIcon,
  setNotificationIcon,
  clearNotificationIcons,
  subscribeNotificationIcons,
  __resetNotificationIconsForTest,
} from '../lib/notifIconStore.ts';
import { TILE_FILLS, tileFill, tileLetter, messengerIconFor } from '../lib/appTile.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

interface StubStorage {
  map: Map<string, string>;
  writes: number;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
function stubStorage(throwAll = false): StubStorage {
  const s: StubStorage = {
    map: new Map<string, string>(),
    writes: 0,
    getItem: (k) => { if (throwAll) throw new Error('blocked'); return s.map.has(k) ? (s.map.get(k) as string) : null; },
    setItem: (k, v) => { if (throwAll) throw new Error('blocked'); s.writes += 1; s.map.set(k, String(v)); },
    removeItem: (k) => { if (throwAll) throw new Error('blocked'); s.map.delete(k); },
  };
  return s;
}
/** Fresh module state on a given storage — what a page load looks like. */
function boot(storage: StubStorage | null): void {
  __resetNotificationIconsForTest();
  (globalThis as unknown as { window?: unknown }).window = storage ? { localStorage: storage } : {};
}
const persisted = (s: StubStorage): [string, string][] =>
  JSON.parse(s.map.get(NOTIF_ICON_STORAGE_KEY) ?? '[]') as [string, string][];

// ── set / get ───────────────────────────────────────────────────────────────
{
  const s = stubStorage();
  boot(s);
  eq('unknown package reads undefined', getNotificationIcon('com.slack'), undefined);
  setNotificationIcon('com.slack', 'AAAA');
  eq('a set icon reads back', getNotificationIcon('com.slack'), 'AAAA');
  setNotificationIcon('', 'BBBB');
  setNotificationIcon('com.x', '');
  eq('empty package or icon is ignored', persisted(s).length, 1);
}

// ── persist + reload (no fallback flash after a reload) ─────────────────────
{
  const s = stubStorage();
  boot(s);
  setNotificationIcon('com.slack', 'AAAA');
  setNotificationIcon('com.google.android.gm', 'GGGG');
  eq('mirrored under the exported key', persisted(s).length, 2);
  boot(s); // reload: memory gone, storage kept
  eq('reload restores icon 1 from storage', getNotificationIcon('com.slack'), 'AAAA');
  eq('reload restores icon 2 from storage', getNotificationIcon('com.google.android.gm'), 'GGGG');
}

// ── no-op sets do not write or notify ───────────────────────────────────────
{
  const s = stubStorage();
  boot(s);
  let calls = 0;
  const off = subscribeNotificationIcons(() => { calls += 1; });
  setNotificationIcon('com.slack', 'AAAA');
  eq('first set notifies once', calls, 1);
  const w = s.writes;
  setNotificationIcon('com.slack', 'AAAA');
  eq('same icon again: no storage write', s.writes, w);
  eq('same icon again: no re-render', calls, 1);
  setNotificationIcon('com.slack', 'ZZZZ');
  eq('a changed icon notifies', calls, 2);
  off();
  setNotificationIcon('com.slack', 'YYYY');
  eq('unsubscribed listener is not called', calls, 2);
}

// ── LRU cap ─────────────────────────────────────────────────────────────────
{
  const s = stubStorage();
  boot(s);
  for (let i = 0; i < NOTIF_ICON_MAX_ENTRIES; i++) setNotificationIcon(`app.${i}`, `I${i}`);
  setNotificationIcon('app.0', 'I0'); // app.0 used again: now the newest
  setNotificationIcon('app.new', 'NEW');
  eq('cap is 60', NOTIF_ICON_MAX_ENTRIES, 60);
  eq('never more than the cap in storage', persisted(s).length, NOTIF_ICON_MAX_ENTRIES);
  eq('least recently set (app.1) is evicted', getNotificationIcon('app.1'), undefined);
  eq('re-set app.0 survived', getNotificationIcon('app.0'), 'I0');
  eq('newest is kept', getNotificationIcon('app.new'), 'NEW');
  boot(s);
  eq('reload keeps the eviction', getNotificationIcon('app.1'), undefined);
}

// ── size skip ───────────────────────────────────────────────────────────────
{
  const s = stubStorage();
  boot(s);
  eq('cap is 24 KB of base64', NOTIF_ICON_MAX_BYTES, 24 * 1024);
  setNotificationIcon('com.big', 'A'.repeat(NOTIF_ICON_MAX_BYTES));
  eq('exactly 24 KB is kept', getNotificationIcon('com.big')?.length, NOTIF_ICON_MAX_BYTES);
  setNotificationIcon('com.big', 'B'.repeat(NOTIF_ICON_MAX_BYTES + 1));
  eq('over 24 KB is skipped, previous icon kept', getNotificationIcon('com.big')?.[0], 'A');
  setNotificationIcon('com.huge', 'C'.repeat(NOTIF_ICON_MAX_BYTES + 1));
  eq('over 24 KB never lands', getNotificationIcon('com.huge'), undefined);
  s.map.set(NOTIF_ICON_STORAGE_KEY, JSON.stringify([['com.old', 'D'.repeat(NOTIF_ICON_MAX_BYTES + 1)], ['com.ok', 'OK']]));
  boot(s);
  eq('an oversize entry already on disk is dropped at load', getNotificationIcon('com.old'), undefined);
  eq('its neighbours still load', getNotificationIcon('com.ok'), 'OK');
}

// ── sign-out clear ──────────────────────────────────────────────────────────
{
  const s = stubStorage();
  boot(s);
  setNotificationIcon('com.slack', 'AAAA');
  let calls = 0;
  subscribeNotificationIcons(() => { calls += 1; });
  clearNotificationIcons();
  eq('memory cleared', getNotificationIcon('com.slack'), undefined);
  check('storage key removed', !s.map.has(NOTIF_ICON_STORAGE_KEY));
  eq('subscribers re-render to the fallback', calls, 1);
  boot(s);
  eq('a reload after sign-out finds nothing', getNotificationIcon('com.slack'), undefined);
}

// ── storage throwing / absent / corrupt ─────────────────────────────────────
{
  const s = stubStorage(true);
  boot(s);
  let threw = false;
  try {
    eq('read with throwing storage is undefined', getNotificationIcon('com.slack'), undefined);
    setNotificationIcon('com.slack', 'AAAA');
    eq('memory still serves the session', getNotificationIcon('com.slack'), 'AAAA');
    clearNotificationIcons();
    eq('clear still clears memory', getNotificationIcon('com.slack'), undefined);
  } catch { threw = true; }
  check('no call throws when storage throws', !threw);

  boot(null); // no localStorage at all (SSR-like)
  setNotificationIcon('com.slack', 'AAAA');
  eq('works without any storage', getNotificationIcon('com.slack'), 'AAAA');

  const c = stubStorage();
  c.map.set(NOTIF_ICON_STORAGE_KEY, '{not json');
  boot(c);
  eq('corrupt JSON loads as empty', getNotificationIcon('com.slack'), undefined);
  setNotificationIcon('com.slack', 'AAAA');
  eq('and is overwritten by the next set', persisted(c).length, 1);
}

// ── letter tile ─────────────────────────────────────────────────────────────
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
for (const fill of TILE_FILLS) {
  const ratio = (1 + 0.05) / (lum(fill) + 0.05);
  check(`white on ${fill} >= 4.5:1`, ratio >= 4.5, ratio.toFixed(2));
}
eq('tile colour is stable per package', tileFill('com.Slack'), tileFill('com.Slack'));
check('tile colour is one of the fills', TILE_FILLS.includes(tileFill('com.google.android.gm')));
check('different packages spread across fills',
  new Set(['com.Slack', 'com.google.android.gm', 'com.spotify.music', 'com.instagram.android', 'no.dnb.android', 'com.linkedin.android'].map(tileFill)).size >= 3);
eq('letter is the first letter, upper-cased', tileLetter('gmail'), 'G');
eq('leading punctuation is skipped', tileLetter('#design'), 'D');
eq('non-Latin letters work', tileLetter('Ølbutikken'), 'Ø');
eq('empty app name falls back to the package tail', tileLetter('', 'com.spotify.music'), 'M');
eq('nothing at all is "?"', tileLetter('', ''), '?');
eq('WhatsApp uses the shipped svg', messengerIconFor('com.whatsapp'), '/messenger-icons/whatsapp.svg');
eq('Telegram uses the shipped svg', messengerIconFor('org.telegram.messenger'), '/messenger-icons/telegram.svg');
eq('Viber uses the shipped svg', messengerIconFor('com.viber.voip'), '/messenger-icons/viber.svg');
eq('Discord uses the shipped svg', messengerIconFor('com.discord'), '/messenger-icons/discord.svg');
eq('other apps have no svg', messengerIconFor('com.whatsapp.w4b'), undefined);

delete (globalThis as unknown as { window?: unknown }).window;
console.log(`\nnotif-icon-store: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
