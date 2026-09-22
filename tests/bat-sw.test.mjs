/**
 * tests/bat-sw.test.mjs — BAT-2 (b): the extension service worker's half of
 * BATTERY. GATE1 Addendum BAT-A1, MUSTs 1-3.
 *
 * Claims, each false by default and each false SILENTLY:
 *
 *  1. `inboundDisposition({mode:'open', frameType:'BATTERY', data:plaintext})`
 *     is NOT INBOUND_DROP_PLAINTEXT. BATTERY is §13.7 plaintext, so it is in
 *     neither sealed set and `requiresSeal()` is false for it — which means
 *     this assertion passes on a source where nobody touched the sets. That is
 *     the point: it PINS the membership, so a future edit that "tidies" BATTERY
 *     into SEALED_FRAME_TYPES fails here instead of blanking the header on
 *     every encrypted pair.
 *  2. MUST-2 — a top-level `relay` key is REJECTED (INBOUND_DROP_RELAY_MARK)
 *     and counted, never stripped.
 *  3. MUST-3 — the shape is validated at the chokepoint; a bad one is
 *     INBOUND_DROP_BATTERY_SHAPE, counted under `battery-shape`.
 *  4. The frame writes `cc_battery = {pct,charging,ts,v:1}` in storage.session
 *     and NOWHERE else; a newer ts overwrites, an older or equal one does not;
 *     the value survives a simulated worker restart; an unknown `v` is ignored
 *     AND cleared (RESUME-PROTOCOL rule 6).
 *  5. Sign-out and unpair clear it.
 *  6. DISPLAY-ONLY — no badge, no notification, and no write to mode, pairing,
 *     tier, quota or session state.
 *
 * Run: node tests/bat-sw.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── The chrome shim, installed before anything imports the worker ───────────
let session = {};
let local = {};
const notifications = new Map();
const badgeTexts = [];
const listeners = { connect: [], alarm: [], message: [], notifClick: [], notifButton: [], removed: [] };
const noop = () => {};
const chan = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

globalThis.chrome = {
  storage: {
    session: {
      get: (k, cb) => cb(k in session ? { [k]: session[k] } : {}),
      set: (o, cb) => { Object.assign(session, structuredClone(o)); if (cb) cb(); },
      remove: (k, cb) => { delete session[k]; if (cb) cb(); },
    },
    local: {
      get: (k, cb) => cb(k in local ? { [k]: local[k] } : {}),
      set: (o, cb) => { Object.assign(local, structuredClone(o)); if (cb) cb(); },
      remove: (k, cb) => { delete local[k]; if (cb) cb(); },
    },
  },
  runtime: {
    id: 'test',
    lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    onConnect: { addListener: (f) => listeners.connect.push(f) },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onStartup: chan(),
    onInstalled: chan(),
    sendMessage: noop,
  },
  notifications: {
    create: (id, opts, cb) => { notifications.set(id, opts); if (cb) cb(id); },
    clear: (id, cb) => { notifications.delete(id); if (cb) cb(true); },
    onClicked: { addListener: (f) => listeners.notifClick.push(f) },
    onButtonClicked: { addListener: (f) => listeners.notifButton.push(f) },
  },
  alarms: {
    create: noop,
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    get: (n, cb) => cb(null),
    clear: (n, cb) => { if (cb) cb(true); },
  },
  action: {
    setBadgeText: (o) => badgeTexts.push(o && o.text),
    setBadgeBackgroundColor: noop, setIcon: noop, setTitle: noop, onClicked: chan(),
  },
  windows: { onRemoved: chan(), create: noop, remove: noop, update: noop, getAll: (o, cb) => cb([]) },
  tabs: { query: (o, cb) => cb([]), create: noop },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve(), setOptions: () => Promise.resolve() },
  identity: { getAuthToken: noop },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.self = globalThis;
globalThis.fetch = () => Promise.reject(new Error('no network in this harness'));
globalThis.createImageBitmap = () => Promise.reject(new Error('no bitmaps in this harness'));
if (!globalThis.WebSocket) globalThis.WebSocket = class { constructor() { this.readyState = 0; } close() {} };
if (!globalThis.OffscreenCanvas) {
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        clearRect: noop, fillRect: noop, beginPath: noop, arc: noop, fill: noop,
        fillText: noop, measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }),
      };
    }
  };
}

const S = await import('../chrome-extension/e2e/sw-session.js');
await import('../chrome-extension/background.js');
const W = globalThis.self;

let passed = 0;
let total = 0;
const fails = [];
async function check(name, fn) {
  total += 1;
  try { await fn(); passed += 1; }
  catch (e) { fails.push(`${name}: ${e && e.message}`); console.log(`  FAIL ${name}: ${e && e.message}`); }
}
function eq(a, b, what) {
  const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
  const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
  if (sa !== sb) throw new Error(`${what || 'value'}: expected ${sb}, got ${sa}`);
}
function ok(v, what) { if (!v) throw new Error(what || 'expected truthy'); }

const KEY = 'cc_battery';
const disp = (mode, frameType, data) => S.inboundDisposition({ mode, frameType, data });
const GOOD = { pct: 47, charging: false, ts: 1_758_531_600_000 };
const settle = () => W.serialize(async () => {});       // drain the mutation queue
// handleFrame takes the RAW WIRE FRAME, not (type, data) — driving it with the
// split parts would test a call signature the relay never uses.
const frame = (type, data) => `${type}:${JSON.stringify(data)}`;
const feed = (type, data) => W.handleFrame(frame(type, data));
const drops = async () => ((await S.readDrops()) || {}).byReason || {};
const tick = () => new Promise((r) => setTimeout(r, 0));

function resetStore() {
  session = {};
  local = {};
  notifications.clear();
  badgeTexts.length = 0;
}

console.log('\ntests/bat-sw.test.mjs — BAT-2 (b): SW disposition + cc_battery\n');

// ── 1. disposition: BATTERY is plaintext, in every mode ────────────────────

await check('(1) BATTERY under mode OPEN is NOT dropped as plaintext', () => {
  const d = disp('open', 'BATTERY', GOOD);
  ok(d !== S.INBOUND_DROP_PLAINTEXT, `got ${d}`);
  eq(d, S.INBOUND_DELIVER, 'open');
});

await check('(1) ...and in every other mode too', () => {
  for (const m of ['off', 'counts-only', 'aborted', undefined]) {
    eq(disp(m, 'BATTERY', GOOD), S.INBOUND_DELIVER, `mode=${m}`);
  }
});

await check('(1) the pin: BATTERY is in NEITHER sealed set and requiresSeal is false', () => {
  ok(!S.SEALED_FRAME_TYPES.has('BATTERY'), 'must not be in SEALED_FRAME_TYPES');
  ok(!S.SEALED_PASSTHROUGH_FRAME_TYPES.has('BATTERY'), 'must not be in SEALED_PASSTHROUGH_FRAME_TYPES');
  ok(!S.requiresSeal('BATTERY'), 'requiresSeal(BATTERY) must be false');
});

await check('(1) the control: a SEALED type in the clear while OPEN still drops', () => {
  // Without this cell, a source that broke the downgrade guard outright would
  // make the BATTERY assertion above pass for the wrong reason.
  eq(disp('open', 'SMS_RECEIVED', { body: 'x' }), S.INBOUND_DROP_PLAINTEXT, 'SMS_RECEIVED');
});

// ── 2. MUST-2 — the relay mark is rejected, never stripped ─────────────────

await check('(2) MUST-2: a top-level `relay` key is REJECTED', () => {
  for (const mark of [true, false, null, 0, 'x', {}]) {
    eq(disp('open', 'BATTERY', { ...GOOD, relay: mark }), S.INBOUND_DROP_RELAY_MARK, `relay:${JSON.stringify(mark)}`);
    eq(disp('off', 'BATTERY', { ...GOOD, relay: mark }), S.INBOUND_DROP_RELAY_MARK, `off relay:${JSON.stringify(mark)}`);
  }
});

await check('(2) MUST-2: rejected, NOT stripped — the payload is never rewritten', () => {
  const data = { ...GOOD, relay: true };
  disp('open', 'BATTERY', data);
  ok(Object.prototype.hasOwnProperty.call(data, 'relay'), 'the mark must still be there');
  eq(data.relay, true, 'relay');
});

await check('(2) MUST-2: an INHERITED `relay` is not a marked frame', () => {
  const data = Object.create({ relay: true });
  Object.assign(data, GOOD);
  eq(disp('open', 'BATTERY', data), S.INBOUND_DELIVER, 'inherited relay');
});

await check('(2) MUST-2: the marked frame is COUNTED', async () => {
  resetStore();
  const before = (await drops())['bad-relay-mark'] || 0;
  await feed('BATTERY', { ...GOOD, relay: true });
  await settle(); await tick();
  const after = (await drops())['bad-relay-mark'] || 0;
  eq(after, before + 1, 'bad-relay-mark count');
  eq(session[KEY], undefined, 'nothing may be stored');
});

// ── 3. MUST-3 — shape validation ───────────────────────────────────────────

await check('(3) MUST-3: the shipped predicate accepts the frozen shape', () => {
  ok(S.isValidBatteryPayload(GOOD), 'the good frame');
  ok(S.isValidBatteryPayload({ pct: 0, charging: true, ts: 1 }), 'pct 0');
  ok(S.isValidBatteryPayload({ pct: 100, charging: false, ts: 1 }), 'pct 100');
  ok(S.isValidBatteryPayload({ ...GOOD, temp: 31 }), 'an unknown extra key is tolerated');
});

await check('(3) MUST-3: every malformed shape is refused', () => {
  const bad = [
    ['pct 47.5', { ...GOOD, pct: 47.5 }],
    ['pct -1', { ...GOOD, pct: -1 }],
    ['pct 101', { ...GOOD, pct: 101 }],
    ['pct "47"', { ...GOOD, pct: '47' }],
    ['pct absent', { charging: false, ts: 1 }],
    ['charging 1', { ...GOOD, charging: 1 }],
    ['charging "true"', { ...GOOD, charging: 'true' }],
    ['charging absent', { pct: 1, ts: 1 }],
    ['ts "1"', { ...GOOD, ts: '1' }],
    ['ts NaN', { ...GOOD, ts: NaN }],
    ['ts Infinity', { ...GOOD, ts: Infinity }],
    ['ts absent', { pct: 1, charging: false }],
    ['null', null],
    ['an array', [47, false, 1]],
    ['a string', 'BATTERY'],
  ];
  for (const [label, data] of bad) {
    ok(!S.isValidBatteryPayload(data), `isValidBatteryPayload(${label})`);
    eq(disp('open', 'BATTERY', data), S.INBOUND_DROP_BATTERY_SHAPE, label);
  }
});

await check('(3) MUST-3: a sealed-looking BATTERY is refused on shape, not unsealed', () => {
  // §13.7 says this type is plaintext and sealFrame() refuses to seal it, so an
  // envelope here is a mislabelled frame or a probe — refusing it costs nothing
  // and spends no key operation.
  eq(disp('open', 'BATTERY', { e: 1, kid: 'k', s: 0, c: 'AA' }), S.INBOUND_DROP_BATTERY_SHAPE, 'envelope');
});

await check('(3) MUST-3: the bad shape is COUNTED under `battery-shape`', async () => {
  resetStore();
  const before = (await drops())['battery-shape'] || 0;
  await feed('BATTERY', { pct: '47', charging: false, ts: 1 });
  await settle(); await tick();
  const after = (await drops())['battery-shape'] || 0;
  eq(after, before + 1, 'battery-shape count');
  eq(session[KEY], undefined, 'nothing may be stored');
});

// ── 4. storage.session: write, ts ordering, restart, version guard ─────────

await check('(4) a BATTERY frame writes cc_battery = {pct,charging,ts,v:1}', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  eq(session[KEY], { pct: 47, charging: false, ts: GOOD.ts, v: 1 }, 'cc_battery');
});

await check('(4) it is the ONLY key written — storage.session, never local', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  eq(Object.keys(session).sort().join(','), KEY, 'session keys');
  eq(Object.prototype.hasOwnProperty.call(local, KEY), false, 'must not be in storage.local');
});

await check('(4) a NEWER ts overwrites', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  await feed('BATTERY', { pct: 46, charging: true, ts: GOOD.ts + 60_000 });
  await settle();
  eq(session[KEY], { pct: 46, charging: true, ts: GOOD.ts + 60_000, v: 1 }, 'cc_battery');
});

await check('(4) an OLDER ts is ignored', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  await feed('BATTERY', { pct: 99, charging: true, ts: GOOD.ts - 1 });
  await settle();
  eq(session[KEY], { pct: 47, charging: false, ts: GOOD.ts, v: 1 }, 'the older frame must not win');
});

await check('(4) an EQUAL ts is ignored (a duplicate is not news)', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  await feed('BATTERY', { pct: 99, charging: true, ts: GOOD.ts });
  await settle();
  eq(session[KEY].pct, 47, 'pct');
});

await check('(4) a BURST of frames in one turn cannot lose the newest', async () => {
  // The serialised-mutation property, stated as a test rather than as a hope:
  // unserialised, all four read the same pre-burst value and the last WRITE
  // wins, which is not the same as the newest ts winning.
  resetStore();
  await Promise.all([
    feed('BATTERY', { pct: 50, charging: false, ts: 4000 }),
    feed('BATTERY', { pct: 49, charging: false, ts: 3000 }),
    feed('BATTERY', { pct: 51, charging: true, ts: 5000 }),
    feed('BATTERY', { pct: 48, charging: false, ts: 2000 }),
  ]);
  await settle();
  eq(session[KEY], { pct: 51, charging: true, ts: 5000, v: 1 }, 'the highest ts must win');
});

await check('(4) it SURVIVES a simulated worker restart', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  const stored = structuredClone(session[KEY]);
  // An MV3 eviction destroys module memory and leaves storage.session intact.
  // That is exactly what this models: the store is preserved, every other
  // in-memory trace is discarded, and the value is read back through the
  // worker's own accessor — which is the thing the popup will call on open.
  session = { [KEY]: stored };
  eq(await W.readBattery(), { pct: 47, charging: false, ts: GOOD.ts, v: 1 }, 'read back after restart');
});

await check('(4) the reading is NOT held in module memory', async () => {
  // If it were, the restart cell above would pass on a worker that never
  // persisted anything. Wipe the store and require the accessor to say null.
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  session = {};
  eq(await W.readBattery(), null, 'a wiped store must read back as null');
});

await check('(4) rule 6: an UNKNOWN record version is ignored AND cleared', async () => {
  resetStore();
  session[KEY] = { pct: 47, charging: false, ts: GOOD.ts, v: 2 };
  eq(await W.readBattery(), null, 'an unknown v must not be rendered');
  eq(session[KEY], undefined, 'and the row must be removed, not left to rot');
});

await check('(4) rule 6: a record with NO version at all is ignored + cleared', async () => {
  resetStore();
  session[KEY] = { pct: 47, charging: false, ts: GOOD.ts };
  eq(await W.readBattery(), null, 'a v-less record must not be rendered');
  eq(session[KEY], undefined, 'removed');
});

await check('(4) an unknown-version record does not block the next good frame', async () => {
  resetStore();
  session[KEY] = { pct: 9, charging: true, ts: GOOD.ts + 999_999, v: 99 };
  await feed('BATTERY', GOOD);
  await settle();
  eq(session[KEY], { pct: 47, charging: false, ts: GOOD.ts, v: 1 },
    'the unreadable record must not win the ts comparison');
});

// ── 5. cleared on sign-out and on unpair ───────────────────────────────────

await check('(5) sign-out clears cc_battery', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  ok(session[KEY], 'precondition: it is stored');
  for (const fn of listeners.message) fn({ type: 'signed-out' }, {}, () => {});
  await settle();
  eq(session[KEY], undefined, 'cc_battery after sign-out');
});

await check('(5) unpair (ROOM_RESET) clears cc_battery', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  ok(session[KEY], 'precondition: it is stored');
  await feed('ROOM_RESET', {});
  await settle();
  eq(session[KEY], undefined, 'cc_battery after ROOM_RESET');
});

await check('(5) the clear sites are the SAME ones that clear the counters', () => {
  // Source-level, because "the same sites" is a structural claim and the
  // behavioural cells above would still pass if someone added a third,
  // divergent clear path.
  const src = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls = [...code.matchAll(/(?<!function )clearBattery\(\)/g)].length;
  eq(calls, 2, 'clearBattery() call sites (sign-out + ROOM_RESET)');
  ok(/\[UNREAD_KEY\]: \{ \.\.\.UNREAD_ZERO \}[\s\S]{0,400}clearBattery\(\)/.test(code),
    'the sign-out clear must sit with the unread reset');
  ok(/type === 'ROOM_RESET'[\s\S]{0,400}clearBattery\(\)/.test(code),
    'the unpair clear must sit in the ROOM_RESET branch');
});

// ── 6. DISPLAY-ONLY — no side effects anywhere else ────────────────────────

await check('(6) no notification and no badge change', async () => {
  resetStore();
  W.paintBadge({ missedCalls: 0, newSms: 0, alerts: 0 });
  const badgeBefore = badgeTexts.length;
  await feed('BATTERY', GOOD);
  await settle();
  eq(notifications.size, 0, 'notifications raised');
  eq(badgeTexts.length, badgeBefore, 'badge writes');
});

await check('(6) no unread counter moves', async () => {
  resetStore();
  const before = await W.readUnread();
  await feed('BATTERY', GOOD);
  await settle();
  eq(await W.readUnread(), before, 'unread counters');
});

await check('(6) mode / pairing / session state are untouched', async () => {
  resetStore();
  W.e2eMode = 'open';
  const modeBefore = W.e2eMode;
  const indicatorBefore = W.lastIndicator;
  await feed('BATTERY', GOOD);
  await settle();
  eq(W.e2eMode, modeBefore, 'e2eMode');
  eq(W.lastIndicator, indicatorBefore, 'lastIndicator (pairing paint)');
});

await check('(6) the deliverFrame case writes nothing but the battery row', () => {
  const src = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const at = code.indexOf("case 'BATTERY':");
  ok(at > 0, "deliverFrame must carry a case 'BATTERY'");
  const body = code.slice(at, code.indexOf('return;', at) + 7);
  ok(/noteBattery\(data\);/.test(body), 'it must call noteBattery(data)');
  ok(!/bumpUnread|notifications\.create|paintBadge|setCountsOnly|notePairState/.test(body),
    `the BATTERY case must have no other side effect — got: ${body.trim()}`);
});

await check('(6) a surface that opens is handed the stored value immediately', async () => {
  resetStore();
  await feed('BATTERY', GOOD);
  await settle();
  const got = [];
  const port = { name: 'cc-presence', postMessage: (m) => got.push(m), onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } };
  for (const fn of listeners.connect) fn(port);
  await settle();
  await new Promise((r) => setTimeout(r, 0));
  const msg = got.find((m) => m && m.type === 'battery');
  ok(msg, `a battery message must be pushed on connect — got ${JSON.stringify(got)}`);
  eq(msg.battery, { pct: 47, charging: false, ts: GOOD.ts, v: 1 }, 'the pushed record');
});

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\nbat-sw: ${passed}/${total} checks passed`);
if (fails.length) { console.error(`\n${fails.length} FAILED`); process.exit(1); }
