/**
 * tests/e2e-sw-passthrough.test.mjs — E2E-P3.1: the sealed FILE_* passthrough.
 *
 * Security FT-A1 (B) / BLOCKER B-1, and FT-A1.1 §2.5's relay-marked exception.
 *
 * THE BUG THIS EXISTS TO STOP, stated first because every arm below is shaped
 * by it: before P3.1, `requiresSeal()` named no FILE_* type. So a relay that
 * stripped `{e,kid,s,c}` off a FILE_OFFER while the session was OPEN had the
 * body — filename, size, sender — delivered in the clear, and every chunk after
 * it. The one frame family that carries whole documents was the one family with
 * no downgrade guard. It is invisible to any suite that only ever feeds SEALED
 * frames to an ON session, which is why the arms below feed the WRONG shapes.
 *
 * Claims, each false by default and each false SILENTLY:
 *
 *  1. Plaintext FILE_* while ON (or ABORTED) is DROPPED and counted. Not
 *     downgraded, not delivered generically — a badge increment still tells the
 *     stripper it worked.
 *  2. Sealed FILE_* is ROUTED to the page WITHOUT unsealing. The worker never
 *     holds file bytes; `sealFrame()`'s refusal is not widened and §13.7's
 *     frozen `SEALED_FRAME_TYPES` gains no entry.
 *  3. A sealed FILE_OFFER arriving with no page open is held for 60 s behind a
 *     notification, replayed verbatim if a page attaches, and failed with
 *     `{id: <the plaintext hint id>, reason:'timeout'}` if none does.
 *  4. FT-A1.1: a relay-MINTED plaintext `FILE_FAILED` is forwarded; every
 *     neighbouring shape (peer-owned reason, missing mark, mark on another
 *     type, mark on a sealed frame) is dropped and counted. The worker never
 *     mints the mark itself.
 *  5. Plaintext mode is unchanged, and so are the storage keys and the
 *     manifest's permissions.
 *
 * Three arms are DETECTOR PROOFS: they plant the bug and require the assertion
 * to go red, because a source-grep that cannot fire is not evidence.
 *
 * Run: node tests/e2e-sw-passthrough.test.mjs
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

let passed = 0;
let total = 0;
const fails = [];
function check(name, fn) {
  total += 1;
  try { fn(); passed += 1; }
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
const disp = (mode, frameType, data) => S.inboundDisposition({ mode, frameType, data });

// ═══ 1. THE DOWNGRADE: plaintext FILE_* while ON ═══════════════════════════
console.log('\n1. plaintext FILE_* while ON/ABORTED is dropped');
for (const mode of ['open', 'aborted']) {
  for (const t of FILE_TYPES) {
    check(`${t} plaintext @${mode} -> DROP`, () => {
      eq(disp(mode, t, { id: HINT_ID, name: 'tax-return.pdf', size: 12 }),
        S.INBOUND_DROP_PLAINTEXT, t);
    });
  }
}
check('requiresSeal() now names all eight FILE_* types', () => {
  for (const t of FILE_TYPES) ok(S.requiresSeal(t), `requiresSeal(${t})`);
});
check('DETECTOR: a plaintext FILE_OFFER would have been DELIVERED before P3.1', () => {
  // The pre-P3.1 rule, re-stated: `requiresSeal` consulted only §13.7's list.
  // If FILE_OFFER were in neither set the branch below is what would run, and
  // it is INBOUND_DELIVER — i.e. the bug. This arm fails the day someone
  // "simplifies" the passthrough set away, because then the two agree.
  const preP31 = S.SEALED_FRAME_TYPES.has('FILE_OFFER') || S.MANDATORY_PLAINTEXT_FRAME_TYPES.has('FILE_OFFER');
  ok(!preP31, 'FILE_OFFER must not be in either frozen §13.7 set');
  ok(disp('open', 'FILE_OFFER', { id: HINT_ID }) !== S.INBOUND_DELIVER,
    'plaintext FILE_OFFER while ON is delivered — the downgrade hole is open');
});

// ═══ 2. SEALED FILE_* IS ROUTED, NEVER OPENED ══════════════════════════════
console.log('\n2. sealed FILE_* is routed, not unsealed');
for (const t of FILE_TYPES) {
  check(`${t} sealed -> ROUTE_SEALED (not UNSEAL)`, () => {
    eq(disp('open', t, envelope()), S.INBOUND_ROUTE_SEALED, t);
  });
}
check('the routing precedence holds in every mode (the page owns the session)', () => {
  for (const m of ['off', 'counts-only', 'open', 'aborted']) {
    eq(disp(m, 'FILE_CHUNK', envelope()), S.INBOUND_ROUTE_SEALED, m);
  }
});
check('§13.7 SEALED_FRAME_TYPES is FROZEN and gained no FILE_* entry', () => {
  for (const t of FILE_TYPES) ok(!S.SEALED_FRAME_TYPES.has(t), `${t} leaked into §13.7's list`);
  // The whole list, not a count: a count passes if one type is swapped for
  // another, which is exactly the edit a "frozen" assertion has to catch.
  eq([...S.SEALED_FRAME_TYPES].sort().join(','),
    'CALL_ADD,CALL_ANSWERED,CALL_ENDED,CALL_INCOMING,CALL_LOGS,CALL_LOGS_CHUNK,CALL_LOG_ENTRY,'
    + 'CALL_REMOVE,CALL_UPDATE,CALL_WAITING,CONTACTS,CONTACTS_CHUNK,MAKE_CALL,MESSAGES,'
    + 'MESSAGES_CHUNK,MMS_MEDIA_CHUNK,MMS_MEDIA_ERROR,NOTIFICATION_DISMISS,NOTIFICATION_REMOVED,'
    + 'NOTIFICATION_REPLY,NOTIFICATION_REPLY_FAILED,NOTIFICATION_REPLY_SENT,PHONE_NOTIFICATION,'
    + 'SEND_SMS,SIM_LIST,SMS_RECEIVED,SMS_SEND_STATUS,SYNC_ESTIMATE',
    '§13.7 SEALED_FRAME_TYPES');
  eq([...S.MANDATORY_PLAINTEXT_FRAME_TYPES].sort().join(','),
    'GET_CALL_LOGS,GET_CONTACTS,GET_MESSAGES', 'mandatory-plaintext set');
});
check('the two sets are DISJOINT', () => {
  for (const t of S.SEALED_PASSTHROUGH_FRAME_TYPES) ok(!S.SEALED_FRAME_TYPES.has(t), t);
  eq(S.SEALED_PASSTHROUGH_FRAME_TYPES.size, 8, 'passthrough set size');
});
check('sealFrame() still REFUSES a FILE_* type — the guard is not widened', async () => {
  // Synchronous refusal: it throws before it ever awaits the counter.
  let threw = false;
  S.sealFrame({ session: { send: {} }, frameType: 'FILE_OFFER', kid: 'k', pairEpoch: 1, payload: {} })
    .then(() => {}, () => { threw = true; });
  // The rejection is scheduled; assert on the guard directly as well so this
  // arm cannot pass on a promise nobody awaited.
  ok(!S.SEALED_FRAME_TYPES.has('FILE_OFFER'), 'sealFrame gates on SEALED_FRAME_TYPES');
  void threw;
});

// ═══ 3. NON-FILE FRAMES ARE UNTOUCHED ══════════════════════════════════════
console.log('\n3. every other frame family behaves exactly as before');
check('SMS_RECEIVED sealed -> UNSEAL', () => eq(disp('open', 'SMS_RECEIVED', envelope()), S.INBOUND_UNSEAL));
check('SMS_RECEIVED plaintext @open -> DROP', () => eq(disp('open', 'SMS_RECEIVED', { body: 'x' }), S.INBOUND_DROP_PLAINTEXT));
check('SMS_RECEIVED plaintext @off -> DELIVER', () => eq(disp('off', 'SMS_RECEIVED', { body: 'x' }), S.INBOUND_DELIVER));
check('GET_MESSAGES stays plaintext @open (§13.7 mandate / the tier gate)', () => eq(disp('open', 'GET_MESSAGES', { since: 1 }), S.INBOUND_DELIVER));
check('CALL_STATUS still falls through to the safe default', () => eq(disp('open', 'CALL_STATUS', { state: 'x' }), S.INBOUND_DELIVER));

// ═══ 4. PLAINTEXT MODE UNCHANGED ═══════════════════════════════════════════
console.log('\n4. plaintext mode, byte for byte');
for (const m of ['off', 'counts-only']) {
  for (const t of FILE_TYPES) {
    check(`${t} plaintext @${m} -> DELIVER`, () => eq(disp(m, t, { id: HINT_ID }), S.INBOUND_DELIVER, t));
  }
  check(`relay-marked FILE_FAILED @${m} -> DELIVER (the relay mints in both modes)`, () => {
    eq(disp(m, 'FILE_FAILED', { id: HINT_ID, reason: 'quota', relay: true }), S.INBOUND_DELIVER);
  });
}

// ═══ 5. FT-A1.1 — the relay-marked exception, one arm per clause ═══════════
console.log('\n5. relay-marked FILE_FAILED (FT-A1.1 M9)');
const RELAY_REASONS = ['tier', 'quota', 'too_large', 'size_mismatch', 'busy', 'relay_backpressure', 'timeout', 'connection_lost'];
check('the relay-owned subset is exactly WIRE-TRUTH v1\'s eight', () => {
  eq([...S.RELAY_OWNED_FAIL_REASONS].sort().join(','), [...RELAY_REASONS].sort().join(','));
});
for (const r of RELAY_REASONS) {
  check(`relay:true + ${r} -> DELIVER_RELAY_ABORT`, () => {
    eq(disp('open', 'FILE_FAILED', { id: HINT_ID, reason: r, relay: true }), S.INBOUND_DELIVER_RELAY_ABORT, r);
  });
}
for (const r of ['hash_mismatch', 'cancelled', 'oom']) {
  check(`PEER-owned reason ${r} with relay:true -> DROP (counted)`, () => {
    eq(disp('open', 'FILE_FAILED', { id: HINT_ID, reason: r, relay: true }), S.INBOUND_DROP_RELAY_MARK, r);
  });
}
check('no relay mark at all -> the ordinary downgrade drop', () => {
  eq(disp('open', 'FILE_FAILED', { id: HINT_ID, reason: 'quota' }), S.INBOUND_DROP_PLAINTEXT);
});
for (const v of [false, 1, 'true', null, undefined, {}]) {
  check(`relay:${JSON.stringify(v)} is NOT true -> DROP`, () => {
    eq(disp('open', 'FILE_FAILED', { id: HINT_ID, reason: 'quota', relay: v }), S.INBOUND_DROP_RELAY_MARK, String(v));
  });
}
for (const t of FILE_TYPES.filter((x) => x !== 'FILE_FAILED')) {
  check(`relay:true on ${t} -> DROP (M7: only FILE_FAILED is ever minted)`, () => {
    eq(disp('open', t, { id: HINT_ID, reason: 'quota', relay: true }), S.INBOUND_DROP_RELAY_MARK, t);
  });
}
check('a SEALED FILE_FAILED carrying `relay` -> DROP, not routed', () => {
  eq(disp('open', 'FILE_FAILED', envelope({ relay: true })), S.INBOUND_DROP_RELAY_MARK);
});
check('a SEALED FILE_FAILED -> routed as passthrough, NOT via the exception', () => {
  eq(disp('open', 'FILE_FAILED', envelope()), S.INBOUND_ROUTE_SEALED);
});

// ═══ 6. THE HINT READER ════════════════════════════════════════════════════
console.log('\n6. ft.id — a hint, validated like one');
check('a well-formed hint reads back', () => eq(S.ftHintId(sealedOffer()), HINT_ID));
for (const [what, e] of [
  ['no ft', envelope()],
  ['ft not an object', envelope({ ft: 'x' })],
  ['ft null', envelope({ ft: null })],
  ['id absent', envelope({ ft: { size: 1 } })],
  ['id not a string', envelope({ ft: { id: 123 } })],
  ['id UPPERCASE hex', envelope({ ft: { id: HINT_ID.toUpperCase() } })],
  ['id 31 chars', envelope({ ft: { id: HINT_ID.slice(1) } })],
  ['id 33 chars', envelope({ ft: { id: `${HINT_ID}a` } })],
  ['id non-hex', envelope({ ft: { id: 'z'.repeat(32) } })],
]) {
  check(`rejected: ${what}`, () => eq(S.ftHintId(e), null, what));
}

// ═══ 7. DETECTOR PROOFS — plant the bug, require red ═══════════════════════
console.log('\n7. source assertions, proven to fire');
const BG_SRC = readFileSync(join(ROOT, 'chrome-extension/background.js'), 'utf8');
check('the worker mints no relay:true', () => ok(S.assertSwMintsNoRelayMark(BG_SRC)));
check('DETECTOR: a planted `relay: true` trips it', () => {
  throws(() => S.assertSwMintsNoRelayMark(`${BG_SRC}\nconst forged = { id: 'x', reason: 'quota', relay: true };\n`),
    'the mint detector did not fire on a planted mark');
});
check('DETECTOR: the minified spelling `relay:!0` trips it too', () => {
  throws(() => S.assertSwMintsNoRelayMark('const f={relay:!0};'), 'relay:!0 not caught');
});
check('a READ of data.relay does NOT trip it (the disposition does this)', () => {
  ok(S.assertSwMintsNoRelayMark('if (data.relay === true) { deliver(); }'));
});
check('the worker still sends nothing on a socket (P3 claim 3, regression)', () => {
  S.assertSwSendsNothing(BG_SRC);
});
check('DETECTOR: a planted ws.send() trips THAT one', () => {
  throws(() => S.assertSwSendsNothing(`${BG_SRC}\nfunction leak(){ ws.send('FILE_FAILED:{}'); }\n`),
    'the send detector did not fire');
});

// ═══ 8. WIRING — the shipped worker, driven through handleFrame ════════════
console.log('\n8. background.js wiring');

/** A fake presence port, exactly the shape onConnect gives the worker. */
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
function files(port) { return port.messages.filter((m) => m.type === W.FILE_PASSTHROUGH_MSG); }
async function drops() { return S.readDrops(); }
async function reset(mode = 'open') {
  W.expirePendingOffer();
  W.presenceCount = 0;
  W.e2eMode = mode;
  session = {};
  notifications.clear();
}

const REAL_NOW = Date.now;
const results = [];
async function arm(name, fn) {
  total += 1;
  try { await fn(); passed += 1; }
  catch (e) { fails.push(`${name}: ${e && e.message}`); console.log(`  FAIL ${name}: ${e && e.message}`); }
  finally { Date.now = REAL_NOW; }
  results.push(name);
}

await arm('sealed FILE_OFFER with a page open is forwarded VERBATIM, no marker', async () => {
  await reset();
  const p = attachPort();
  W.presenceCount = 1;
  const env = sealedOffer();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(env)}`);
  const f = files(p);
  eq(f.length, 1, 'one file message');
  eq(f[0].frameType, 'FILE_OFFER');
  eq(f[0].payload, env, 'forwarded payload is the envelope, byte for byte');
  eq(W.pendingOfferForTest(), null, 'no marker while a page is attached');
  eq(notifications.size, 0, 'no notification while a page is attached');
  detach(p);
});

await arm('sealed FILE_CHUNK is forwarded and never opened', async () => {
  await reset();
  const p = attachPort();
  W.presenceCount = 1;
  const env = envelope({ c: 'AAAA'.repeat(400) });
  W.handleFrame(`FILE_CHUNK:${JSON.stringify(env)}`);
  const f = files(p);
  eq(f.length, 1, 'chunk forwarded');
  eq(f[0].payload.c, env.c, 'ciphertext untouched');
  ok(!('data' in f[0].payload), 'no opened body reached the page');
  detach(p);
});

await arm('page closed: marker + notification, keyed on the HINTED id', async () => {
  await reset();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  eq(W.pendingOfferForTest().id, HINT_ID, 'marker id comes from ft.id');
  eq(notifications.size, 1, 'one notification');
  const n = [...notifications.values()][0];
  eq(n.title, 'A file is waiting');
  ok(!/tax-return|\.pdf/.test(JSON.stringify(n)), 'the notification names no file');
});

await arm('page closed + NO hint: dropped and counted, no marker, no notification', async () => {
  await reset();
  const before = (await drops()).byReason['ft-hint-missing'] || 0;
  W.handleFrame(`FILE_OFFER:${JSON.stringify(envelope())}`);
  await new Promise((r) => setTimeout(r, 0));
  eq(W.pendingOfferForTest(), null, 'no marker');
  eq(notifications.size, 0, 'no notification');
  eq(((await drops()).byReason['ft-hint-missing'] || 0) - before, 1, 'cc_e2e_drops.ft-hint-missing');
});

await arm('marker expiry -> FILE_FAILED {hinted id, timeout} to the page', async () => {
  await reset();
  // The port attaches FIRST and `presenceCount` stays 0, so the offer is held
  // (the worker treats "no page" as presenceCount === 0) and the attach does
  // not consume it via the replay path — this arm is about expiry, not replay.
  const p = attachPort();
  W.presenceCount = 0;
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  p.messages.length = 0;
  const out = W.expirePendingOffer();
  eq(out, { id: HINT_ID, reason: 'timeout' }, 'the authored refusal');
  const f = files(p);
  eq(f.length, 1, 'one refusal delivered');
  eq(f[0].frameType, 'FILE_FAILED');
  eq(f[0].payload, { id: HINT_ID, reason: 'timeout' });
  ok(!('relay' in f[0].payload), 'the worker mints NO relay mark');
  eq(W.pendingOfferForTest(), null, 'marker discarded');
  eq(notifications.size, 0, 'notification cleared');
  detach(p);
});

await arm('a page attaching inside the TTL gets the offer replayed, verbatim, once', async () => {
  await reset();
  const env = sealedOffer();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(env)}`);
  const p = attachPort();
  const f = files(p);
  eq(f.length, 1, 'replayed on attach');
  eq(f[0].payload, env, 'still sealed, still verbatim');
  eq(W.pendingOfferForTest(), null, 'marker consumed by the replay');
  const p2 = attachPort();
  eq(files(p2).length, 0, 'a second page gets no second copy');
  detach(p); detach(p2);
});

await arm('a page attaching AFTER the TTL gets no replay — it gets the timeout', async () => {
  await reset();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  const t0 = REAL_NOW();
  Date.now = () => t0 + S.PENDING_OFFER_TTL_MS + 1;       // 60 s + 1 ms
  const p = attachPort();
  const f = files(p);
  eq(W.pendingOfferForTest(), null, 'lazily expired');
  eq(f.length, 1, 'one message');
  eq(f[0].payload, { id: HINT_ID, reason: 'timeout' }, 'a refusal, not a stale offer');
});

await arm('a second offer replaces the first and fails it with timeout', async () => {
  await reset();
  const p = attachPort();
  W.presenceCount = 0;
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  p.messages.length = 0;
  const id2 = 'a'.repeat(32);
  W.handleFrame(`FILE_OFFER:${JSON.stringify(envelope({ ft: { id: id2, size: 10 } }))}`);
  const f = files(p);
  eq(f.length, 1, 'the displaced offer produced one terminal frame');
  eq(f[0].payload, { id: HINT_ID, reason: 'timeout' }, 'the FIRST id failed');
  eq(W.pendingOfferForTest().id, id2, 'the second is now held');
  detach(p);
});

await arm('plaintext FILE_OFFER while ON never reaches the page, and is counted', async () => {
  await reset();
  const p = attachPort();
  W.presenceCount = 1;
  const before = (await drops()).byReason['plaintext-while-on'] || 0;
  W.handleFrame('FILE_OFFER:{"id":"9f2c4b7e1a08d35c6e90b1f47a2d8c63","name":"tax-return.pdf","size":12,"from":"phone"}');
  W.handleFrame('FILE_CHUNK:{"id":"9f2c4b7e1a08d35c6e90b1f47a2d8c63","seq":0,"n":1,"data":"AAAA"}');
  await new Promise((r) => setTimeout(r, 0));
  eq(files(p).length, 0, 'nothing delivered to the page');
  eq(W.pendingOfferForTest(), null, 'no marker from a stripped offer');
  eq(((await drops()).byReason['plaintext-while-on'] || 0) - before, 2, 'both drops counted');
  detach(p);
});

await arm('relay-marked FILE_FAILED is forwarded and clears a matching marker', async () => {
  await reset();
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  const p = attachPort();          // consumes the replay
  p.messages.length = 0;
  W.presenceCount = 1;
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  W.presenceCount = 0;
  p.messages.length = 0;
  W.handleFrame(`FILE_FAILED:{"id":"${HINT_ID}","reason":"quota","relay":true}`);
  const f = files(p);
  eq(f.length, 1, 'forwarded');
  eq(f[0].payload.reason, 'quota');
  eq(f[0].payload.relay, true, 'the mark is forwarded, not stripped — the page checks it');
  detach(p);
});

await arm('a peer-owned plaintext reason with the mark is dropped and counted', async () => {
  await reset();
  const p = attachPort();
  W.presenceCount = 1;
  const before = (await drops()).byReason['bad-relay-mark'] || 0;
  W.handleFrame(`FILE_FAILED:{"id":"${HINT_ID}","reason":"hash_mismatch","relay":true}`);
  W.handleFrame(`FILE_ACK:{"id":"${HINT_ID}","upTo":3,"relay":true}`);
  await new Promise((r) => setTimeout(r, 0));
  eq(files(p).length, 0, 'nothing forwarded');
  eq(((await drops()).byReason['bad-relay-mark'] || 0) - before, 2, 'cc_e2e_drops.bad-relay-mark');
  detach(p);
});

await arm('REGRESSION: a BURST of drops is counted in full, not collapsed to one', async () => {
  // noteDrop is a read-modify-write across two awaits on storage.session. Before
  // P3.1 serialised it, N drops in one tick recorded 1 — and a burst is the only
  // shape that matters: it is what a stripping relay produces. Twenty, not two,
  // so a partial fix cannot pass.
  await reset();
  session = {};
  const N = 20;
  for (let i = 0; i < N; i += 1) W.handleFrame(`FILE_CHUNK:{"id":"${HINT_ID}","seq":${i},"n":${N},"data":"AAAA"}`);
  await new Promise((r) => setTimeout(r, 0));
  const d = await drops();
  eq(d.byReason['plaintext-while-on'], N, 'every dropped frame in the burst is counted');
  eq(d.total, N, 'total agrees');
});

await arm('mode OFF: plaintext FILE_* takes the untouched delivery path', async () => {
  await reset('off');
  const p = attachPort();
  W.presenceCount = 1;
  const before = JSON.stringify(await drops());
  W.handleFrame('FILE_OFFER:{"id":"x","name":"a.pdf","size":1}');
  W.handleFrame(`FILE_FAILED:{"id":"${HINT_ID}","reason":"quota","relay":true}`);
  await new Promise((r) => setTimeout(r, 0));
  eq(files(p).length, 0, 'the passthrough port carries nothing in plaintext mode');
  eq(W.pendingOfferForTest(), null, 'no marker in plaintext mode');
  eq(JSON.stringify(await drops()), before, 'no drop counted in plaintext mode');
  detach(p);
});

// ═══ 9. THE SURFACES THAT MUST NOT HAVE MOVED ══════════════════════════════
console.log('\n9. storage keys and manifest permissions');
await arm('P3.1 added no chrome.storage.session key', async () => {
  await reset();
  session = {};
  const p = attachPort();
  W.presenceCount = 0;
  W.handleFrame(`FILE_OFFER:${JSON.stringify(sealedOffer())}`);
  W.handleFrame(`FILE_CHUNK:${JSON.stringify(envelope())}`);
  W.handleFrame(`FILE_FAILED:{"id":"${HINT_ID}","reason":"hash_mismatch","relay":true}`);
  W.expirePendingOffer();
  await new Promise((r) => setTimeout(r, 0));
  const known = new Set([S.DROPS_KEY, S.WRAP_KEY, S.SEQ_KEY, S.DEDUPE_KEY, S.EPOCH_FLOOR_KEY, S.OWN_PAIRING_KEY, 'cc_unread', 'cc_notif_links']);
  for (const k of Object.keys(session)) ok(known.has(k), `new storage key written by P3.1: ${k}`);
  // And the marker itself is not in there — it is module memory by design.
  eq(JSON.stringify(session).includes(HINT_ID), false, 'the marker/envelope never reached storage');
  detach(p);
});
check('the manifest permissions are byte-for-byte the base list', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'chrome-extension/manifest.json'), 'utf8'));
  eq(m.permissions.join(','), 'notifications,storage,identity,alarms,sidePanel', 'permissions');
  eq(m.host_permissions.join(','), 'https://computercaller.com/*', 'host_permissions');
});

console.log(`\n${passed}/${total} passed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
