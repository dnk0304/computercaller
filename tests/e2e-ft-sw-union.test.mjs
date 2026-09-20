/**
 * tests/e2e-ft-sw-union.test.mjs — FT-MERGE (c2): the background.js UNION.
 *
 * WHY THIS FILE EXISTS. `chrome-extension/background.js` was the one real
 * conflict of the FT-3a merge. Two independently-developed blocks landed at the
 * same insertion point and BOTH had to survive:
 *
 *   · P3.1 / FT-A1 sealed passthrough — SEALED_PASSTHROUGH_FRAME_TYPES (8
 *     FILE_* types), INBOUND_ROUTE_SEALED, forwardFileFrameToPage over the
 *     `cc-presence` port, the module-memory page-closed marker (60 s TTL), and
 *     FT-A1.1's relay-marked FILE_FAILED forwarding + `bad-relay-mark` counter.
 *   · FT-3a routing — FILE_ROUTED_TYPES {FILE_OFFER, FILE_DONE, FILE_FAILED},
 *     routeFileFrame() and the `case 'FILE_OFFER'/'FILE_DONE'/'FILE_FAILED'`
 *     marker inside deliverFrame's switch.
 *
 * A union is exactly the kind of edit that looks right and is not: the two
 * blocks are adjacent, they name similar things, and each has its own suite
 * that passes while the OTHER half is silently dead. e2e-sw-passthrough never
 * leaves encrypted mode, so it cannot see FT-3a's plaintext routing marker
 * disappear; e2e-ft-sw-routing reads the source and the pure router, so it
 * cannot see the sealed passthrough stop being wired. Both stayed green through
 * a resolution that dropped either block. This file is the one that would not.
 *
 * It drives the REAL shipped module — `chrome-extension/background.js`, through
 * `handleFrame(...)`, the same way tests/e2e-sw-passthrough.test.mjs and
 * tests/e2e-ft-sw-routing.test.mjs do — and proves the seven invariants the
 * FT-MERGE brief names, each by execution rather than by reading:
 *
 *   (1) the SW never constructs, mints or originates ANY FILE_* frame — no
 *       FILE_ACCEPT / REJECT / ACK / RESUME, no `relay:true`;
 *   (2) sealed FILE_* under mode ON -> INBOUND_ROUTE_SEALED, forwarded
 *       VERBATIM and never unsealed;
 *   (3) plaintext FILE_* under mode ON -> dropped and counted
 *       (`plaintext-while-on`), EXCEPT a relay-marked FILE_FAILED (FT-A1.1),
 *       which is forwarded;
 *   (4) FT-3a's routing marker still fires for OFFER/DONE/FAILED in plaintext
 *       mode — the half most at risk from this merge;
 *   (5) FILE_CHUNK takes NO routing path in ANY mode (it is forwarded sealed as
 *       an opaque envelope, and routeFileFrame refuses it outright);
 *   (6) assertSwSendsNothing / assertSwMintsNoRelayMark are unchanged AND still
 *       able to fire — each is negative-tested against a planted violation;
 *   (7) §13.7 SEALED_FRAME_TYPES is asserted as the full sorted string, not a
 *       count, and gained nothing.
 *
 * Run: node tests/e2e-ft-sw-union.test.mjs
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
const alarms = [];
const listeners = { connect: [], alarm: [], message: [], notifClick: [], notifButton: [], removed: [] };
const noop = () => {};
const chan = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

globalThis.chrome = {
  storage: {
    session: {
      get: (k, cb) => cb(k in session ? { [k]: session[k] } : {}),
      set: (o, cb) => { Object.assign(session, structuredClone(o)); if (cb) cb(); },
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
    create: (n, o) => alarms.push({ n, o }),
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    get: (n, cb) => cb(null),
    clear: (n, cb) => { if (cb) cb(true); },
  },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setIcon: noop, setTitle: noop, onClicked: chan() },
  windows: { onRemoved: chan(), create: noop, remove: noop, update: noop, getAll: (o, cb) => cb([]) },
  tabs: { query: (o, cb) => cb([]), create: noop },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve(), setOptions: () => Promise.resolve() },
  identity: { getAuthToken: noop },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.self = globalThis;
// The worker paints its toolbar icon at boot, which fetches a PNG. Nothing
// below depends on it; stubbed so the import does not leave an unhandled
// rejection that a future node could turn into a non-zero exit.
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

// ── harness ─────────────────────────────────────────────────────────────────
let passed = 0;
let total = 0;
const fails = [];
function check(name, fn) {
  total += 1;
  try { fn(); passed += 1; }
  catch (e) { fails.push(`${name}: ${e && e.message}`); console.log(`  FAIL ${name}: ${e && e.message}`); }
}
async function arm(name, fn) {
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
function throws(fn, what) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(what || 'expected a throw, got none');
}

const FILE_TYPES = [
  'FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK',
  'FILE_ACK', 'FILE_RESUME', 'FILE_DONE', 'FILE_FAILED',
];
const HINT_ID = '9f2c4b7e1a08d35c6e90b1f47a2d8c63';   // FT-A1 vector L
const envelope = (extra = {}) => ({ e: 1, kid: 'kid-ftA1', s: 42, c: 'Nar4OumTQo9eiu09dKR7Ua_6', ...extra });
const sealedOffer = () => envelope({ ft: { id: HINT_ID, size: 734003200 } });

/** A fake presence port, exactly the shape onConnect hands the worker. */
function attachPort() {
  const got = [];
  const port = {
    name: 'cc-presence',
    messages: got,
    postMessage: (m) => got.push(m),
    onMessage: { addListener: noop },
    onDisconnect: { addListener: (f) => { port._disconnect = f; } },
  };
  for (const f of listeners.connect) f(port);
  return port;
}
function detach(port) { if (port._disconnect) port._disconnect(); }

/** P3.1 half: sealed passthrough messages (`type: 'file-passthrough'`). */
function passthrough(port) { return port.messages.filter((m) => m.type === W.FILE_PASSTHROUGH_MSG); }
/** FT-3a half: routing-marker messages (`type: 'file'`). */
function routed(port) { return port.messages.filter((m) => m.type === 'file'); }

async function reset(mode = 'open') {
  W.expirePendingOffer();
  W.routeFileFrame('FILE_DONE', {}, false);   // clears any FT-3a marker
  W.presenceCount = 0;
  W.e2eMode = mode;
  session = {};
  notifications.clear();
}
const dropCount = async (reason) => ((await S.readDrops()).byReason[reason] || 0);

const BG_SRC = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');

// ═══ 0. THE UNION IS PRESENT AT ALL ════════════════════════════════════════
// Cheap, and the first thing to fail if a future resolution keeps only one
// block. Asserted on the LIVE module surface, not on the source text: a block
// can survive `git merge` intact and still be unreachable.
console.log('\n0. both halves are wired into the shipped module');
for (const [what, fn] of [
  ['P3.1 forwardFileFrameToPage', () => W.forwardFileFrameToPage],
  ['P3.1 routeSealedFileFrame', () => W.routeSealedFileFrame],
  ['P3.1 expirePendingOffer', () => W.expirePendingOffer],
  ['P3.1 replayPendingOfferTo', () => W.replayPendingOfferTo],
  ['P3.1 pendingOfferIfLive', () => W.pendingOfferIfLive],
  ['P3.1 pendingOfferForTest', () => W.pendingOfferForTest],
  ['FT-3a routeFileFrame', () => W.routeFileFrame],
  ['FT-3a pendingFileOfferForTest', () => W.pendingFileOfferForTest],
]) {
  check(`${what} is exported by the union`, () => eq(typeof fn(), 'function', what));
}
check('FILE_PASSTHROUGH_MSG survived the union', () => eq(W.FILE_PASSTHROUGH_MSG, 'file-passthrough'));
check('the FT-3a switch marker is still inside deliverFrame', () => {
  const re = /case 'FILE_OFFER':\s*case 'FILE_DONE':\s*case 'FILE_FAILED':\s*routeFileFrame\(/;
  ok(re.test(BG_SRC), "deliverFrame's FILE_* case block is gone");
  // The same grep, against a source where the call is renamed away: if this
  // still matched, the assertion above could never go red and is not evidence.
  ok(!re.test(BG_SRC.replace(/routeFileFrame\(/g, 'noop(')), 'that regex cannot fire');
});

// ═══ (1) THE SW ORIGINATES NOTHING ═════════════════════════════════════════
console.log('\n(1) the worker mints/originates no FILE_* frame');
check('it sends nothing on any socket (P3 chokepoint claim 3)', () => S.assertSwSendsNothing(BG_SRC));
check('it mints no relay:true', () => ok(S.assertSwMintsNoRelayMark(BG_SRC)));
for (const t of ['FILE_ACCEPT', 'FILE_REJECT', 'FILE_ACK', 'FILE_RESUME']) {
  check(`no ${t} literal is authored anywhere in the worker`, () => {
    // The page owns every reply. A worker that names one of these in a string
    // literal is a worker that is one line away from sending it.
    const authored = new RegExp(`['"\`]${t}['"\`]`).test(BG_SRC);
    ok(!authored, `${t} is authored in background.js — the page owns replies`);
  });
}
await arm('driving every FILE_* type through the worker emits nothing outbound', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  const sent = [];
  W.__testSocket = { send: (x) => sent.push(x) };
  for (const t of FILE_TYPES) W.handleFrame(`${t}:${JSON.stringify(sealedOffer())}`);
  await new Promise((r) => setTimeout(r, 0));
  eq(sent.length, 0, 'the worker sent something');
  for (const m of passthrough(p)) ok(FILE_TYPES.includes(m.frameType), `unexpected frameType ${m.frameType}`);
  detach(p);
  delete W.__testSocket;
});

// ═══ (2) SEALED FILE_* UNDER ON -> ROUTE_SEALED, VERBATIM ══════════════════
console.log('\n(2) sealed FILE_* @ON is forwarded verbatim, never unsealed');
for (const t of FILE_TYPES) {
  check(`${t} sealed @open -> INBOUND_ROUTE_SEALED`, () => {
    eq(S.inboundDisposition({ mode: 'open', frameType: t, data: envelope() }), S.INBOUND_ROUTE_SEALED, t);
  });
}
await arm('sealed FILE_OFFER @ON with a page open -> forwarded byte for byte', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  const env = sealedOffer();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(env)}`);
  const f = passthrough(p);
  eq(f.length, 1, 'exactly one passthrough message');
  eq(f[0].frameType, 'FILE_OFFER');
  eq(f[0].payload, env, 'the envelope is forwarded unchanged');
  ok(!('name' in f[0].payload), 'a body field appeared — the worker unsealed it');
  eq(W.pendingOfferForTest(), null, 'no marker is held while a page is attached');
  // The FT-3a half must NOT fire on a sealed frame: it never reaches
  // deliverFrame, because INBOUND_ROUTE_SEALED returns above it.
  eq(routed(p).length, 0, 'the plaintext routing marker fired on a sealed frame');
  detach(p);
});

// ═══ (3) PLAINTEXT FILE_* UNDER ON -> DROPPED + COUNTED ════════════════════
console.log('\n(3) plaintext FILE_* @ON is dropped and counted');
await arm('plaintext FILE_OFFER @ON -> dropped, counted, nothing reaches the page', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  const before = await dropCount('plaintext-while-on');
  W.handleFrame(`FILE_OFFER:${JSON.stringify({ id: HINT_ID, name: 'tax-return.pdf', size: 12 })}`);
  await new Promise((r) => setTimeout(r, 0));
  eq((await dropCount('plaintext-while-on')) - before, 1, 'cc_e2e_drops.plaintext-while-on');
  eq(passthrough(p).length, 0, 'a downgraded offer was forwarded');
  eq(routed(p).length, 0, 'a downgraded offer reached the FT-3a routing marker');
  eq(W.pendingOfferForTest(), null, 'a downgraded offer left a P3.1 marker');
  eq(W.pendingFileOfferForTest(), null, 'a downgraded offer left an FT-3a marker');
  detach(p);
});
await arm('EXCEPTION: a relay-MINTED plaintext FILE_FAILED @ON is forwarded', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  W.handleFrame(`FILE_FAILED:${JSON.stringify({ id: HINT_ID, reason: 'quota', relay: true })}`);
  await new Promise((r) => setTimeout(r, 0));
  const f = passthrough(p);
  eq(f.length, 1, 'the relay abort was not forwarded');
  eq(f[0].frameType, 'FILE_FAILED');
  eq(f[0].payload.reason, 'quota');
  detach(p);
});
await arm('a FORGED relay mark (peer-owned reason) is dropped as bad-relay-mark', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  const before = await dropCount('bad-relay-mark');
  W.handleFrame(`FILE_FAILED:${JSON.stringify({ id: HINT_ID, reason: 'hash_mismatch', relay: true })}`);
  await new Promise((r) => setTimeout(r, 0));
  eq((await dropCount('bad-relay-mark')) - before, 1, 'cc_e2e_drops.bad-relay-mark');
  eq(passthrough(p).length, 0, 'a forged relay mark was forwarded');
  detach(p);
});

// ═══ (4) FT-3a's ROUTING MARKER STILL FIRES IN PLAINTEXT MODE ══════════════
// The half this merge was most likely to kill silently: e2e-sw-passthrough
// never leaves encrypted mode, so nothing else here would have noticed.
console.log('\n(4) FT-3a routing marker fires for OFFER/DONE/FAILED @OFF');
await arm('plaintext FILE_OFFER @OFF -> FT-3a routing marker, pending set', async () => {
  await reset('off');
  const p = attachPort();
  W.presenceCount = 1;
  W.handleFrame(`FILE_OFFER:${JSON.stringify({ id: HINT_ID, name: 'q3.pdf', size: 12 })}`);
  const r = routed(p);
  eq(r.length, 1, 'no FT-3a routing marker — the FT-3a half is dead');
  eq(r[0].event.kind, 'FILE_OFFER');
  eq(r[0].event.pending.id, HINT_ID, 'the marker carries the offer id');
  eq(r[0].event.pending.sealed, false, 'a plaintext offer was marked sealed');
  eq(W.pendingFileOfferForTest().id, HINT_ID);
  // And the P3.1 half correctly stays out of it: nothing was sealed.
  eq(passthrough(p).length, 0, 'the sealed passthrough fired on a plaintext frame');
  detach(p);
});
for (const t of ['FILE_DONE', 'FILE_FAILED']) {
  await arm(`plaintext ${t} @OFF clears the FT-3a marker and emits one event`, async () => {
    await reset('off');
    const p = attachPort();
    W.presenceCount = 1;
    W.handleFrame(`FILE_OFFER:${JSON.stringify({ id: HINT_ID })}`);
    p.messages.length = 0;
    W.handleFrame(`${t}:${JSON.stringify({ id: HINT_ID })}`);
    const r = routed(p);
    eq(r.length, 1, `no routing marker for ${t}`);
    eq(r[0].event.kind, t);
    eq(r[0].event.pending, null, 'the marker was not cleared');
    eq(W.pendingFileOfferForTest(), null, 'pendingFileOffer survived a terminal frame');
    detach(p);
  });
}
check('FILE_ROUTED_TYPES is exactly the three terminal/opening types', () => {
  // The whole sorted list, not a count: a count still passes if FILE_CHUNK is
  // swapped in for FILE_DONE, which is the edit that matters.
  const m = BG_SRC.match(/const FILE_ROUTED_TYPES = new Set\(\[([^\]]*)\]\)/);
  ok(m, 'FILE_ROUTED_TYPES is gone from the union');
  eq(m[1].match(/'[A-Z_]+'/g).sort().join(','), "'FILE_DONE','FILE_FAILED','FILE_OFFER'");
});

// ═══ (5) FILE_CHUNK TAKES NO ROUTING PATH IN ANY MODE ══════════════════════
console.log('\n(5) FILE_CHUNK is never routed, in any mode');
await arm('sealed FILE_CHUNK @ON: forwarded opaque, no marker, no FT-3a event', async () => {
  await reset('open');
  const p = attachPort();
  W.presenceCount = 1;
  const env = envelope({ c: 'AAAA'.repeat(400) });
  W.handleFrame(`FILE_CHUNK:${JSON.stringify(env)}`);
  const f = passthrough(p);
  eq(f.length, 1, 'the chunk was not forwarded');
  eq(f[0].payload.c, env.c, 'the ciphertext was touched');
  ok(!('data' in f[0].payload), 'an opened chunk body reached the page');
  eq(routed(p).length, 0, 'FILE_CHUNK took the FT-3a routing path');
  eq(W.pendingFileOfferForTest(), null, 'FILE_CHUNK set an FT-3a marker');
  eq(W.pendingOfferForTest(), null, 'FILE_CHUNK was held as a P3.1 marker');
  detach(p);
});
for (const mode of ['off', 'counts-only']) {
  await arm(`plaintext FILE_CHUNK @${mode}: no FT-3a event, no marker`, async () => {
    await reset(mode);
    const p = attachPort();
    W.presenceCount = 1;
    W.handleFrame(`FILE_CHUNK:${JSON.stringify({ id: HINT_ID, seq: 0, b: 'AAAA' })}`);
    eq(routed(p).length, 0, `FILE_CHUNK was routed @${mode}`);
    eq(W.pendingFileOfferForTest(), null, `FILE_CHUNK set a marker @${mode}`);
    detach(p);
  });
}
check('routeFileFrame refuses FILE_CHUNK even when called DIRECTLY', () => {
  // The switch never hands it one, but the function is exported and the guard
  // inside it is the real invariant.
  W.routeFileFrame('FILE_CHUNK', { id: HINT_ID }, false);
  eq(W.pendingFileOfferForTest(), null, 'a direct FILE_CHUNK call set the marker');
});

// ═══ (6) THE SOURCE ASSERTIONS, PROVEN TO FIRE ═════════════════════════════
console.log('\n(6) assertSwSendsNothing / assertSwMintsNoRelayMark still fire');
check('DETECTOR: a planted ws.send() trips assertSwSendsNothing', () => {
  throws(() => S.assertSwSendsNothing(`${BG_SRC}\nfunction leak(){ ws.send('FILE_ACCEPT:{}'); }\n`),
    'the send detector did not fire on the UNIONED source');
});
check('DETECTOR: a planted relay:true trips assertSwMintsNoRelayMark', () => {
  throws(() => S.assertSwMintsNoRelayMark(`${BG_SRC}\nconst forged = { id: 'x', reason: 'quota', relay: true };\n`),
    'the mint detector did not fire on the UNIONED source');
});
check('DETECTOR: the minified spelling relay:!0 trips it too', () => {
  throws(() => S.assertSwMintsNoRelayMark('const f={relay:!0};'), 'relay:!0 not caught');
});
check('a READ of data.relay does NOT trip it (the disposition does exactly this)', () => {
  ok(S.assertSwMintsNoRelayMark('if (data.relay === true) { deliver(); }'));
});

// ═══ (7) §13.7 IS FROZEN — THE WHOLE STRING, NOT A COUNT ═══════════════════
console.log('\n(7) §13.7 SEALED_FRAME_TYPES unchanged');
check('SEALED_FRAME_TYPES is the full sorted list, byte for byte', () => {
  eq([...S.SEALED_FRAME_TYPES].sort().join(','),
    'CALL_ADD,CALL_ANSWERED,CALL_ENDED,CALL_INCOMING,CALL_LOGS,CALL_LOGS_CHUNK,CALL_LOG_ENTRY,'
    + 'CALL_REMOVE,CALL_UPDATE,CALL_WAITING,CONTACTS,CONTACTS_CHUNK,MAKE_CALL,MESSAGES,'
    + 'MESSAGES_CHUNK,MMS_MEDIA_CHUNK,MMS_MEDIA_ERROR,NOTIFICATION_DISMISS,NOTIFICATION_REMOVED,'
    + 'NOTIFICATION_REPLY,NOTIFICATION_REPLY_FAILED,NOTIFICATION_REPLY_SENT,PHONE_NOTIFICATION,'
    + 'SEND_SMS,SIM_LIST,SMS_RECEIVED,SMS_SEND_STATUS,SYNC_ESTIMATE',
    '§13.7 SEALED_FRAME_TYPES');
});
check('no FILE_* type leaked into §13.7', () => {
  for (const t of FILE_TYPES) ok(!S.SEALED_FRAME_TYPES.has(t), `${t} leaked into §13.7's frozen list`);
});
check('the passthrough set is still the disjoint EIGHT', () => {
  eq(S.SEALED_PASSTHROUGH_FRAME_TYPES.size, 8, 'passthrough set size');
  for (const t of FILE_TYPES) ok(S.SEALED_PASSTHROUGH_FRAME_TYPES.has(t), `${t} missing from the passthrough set`);
  for (const t of S.SEALED_PASSTHROUGH_FRAME_TYPES) ok(!S.SEALED_FRAME_TYPES.has(t), `${t} is in both sets`);
});

console.log(`\ne2e-ft-sw-union: ${passed}/${total} checks passed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
