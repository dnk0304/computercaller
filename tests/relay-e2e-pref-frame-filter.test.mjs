#!/usr/bin/env node
/**
 * tests/relay-e2e-pref-frame-filter.test.mjs — Security C1: the relay drops a
 * PEER-sent E2E_PREF / E2E_PREF_REFUSED in both directions.
 *
 * THIS FILE DOES NOT MIRROR server.js. It follows tests/bat-relay.test.mjs: the
 * REAL phone and browser `ws.on('message')` callback bodies are sliced out of
 * server.js and executed, together with the real forwardDataPlane,
 * broadcastToListeners, deliverLobbyFrameDuringResume, the real resume buffer,
 * the real E2E_PREF push path and the real lib/e2ePref-core.js write. Only the
 * relay's ambient dependencies (safeSend, logging, tryAutoResume, the DB, the
 * room reset) are injected. A mirror of a security filter passes happily while
 * the real filter is fail-open.
 *
 * Every case comes from tests/e2e-pref-relay-owned-frames.json — the single
 * source the Kotlin twin on the android lane also reads (RULE 30).
 *
 * The suite PROVES ITS OWN DETECTOR: every dropped case is replayed against a
 * copy of the same handlers with the filter planted out (isRelayOwnedPrefFrame
 * -> false) and must then be DELIVERED. A scenario that cannot deliver a forged
 * frame even without the filter proves nothing, and fails here.
 *
 * No database, no network. Run:  node tests/relay-e2e-pref-frame-filter.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { deepStrictEqual } from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const prefCore = requireCjs(join(ROOT, 'lib', 'e2ePref-core.js'));
// LF-normalised: server.js is CRLF in a fresh checkout and LF in some editors;
// every slice and comment strip below must behave identically on both.
const SERVER_SRC = readFileSync(join(ROOT, 'server.js'), 'utf8').replace(/\r\n?/g, '\n');
const V = JSON.parse(readFileSync(join(HERE, 'e2e-pref-relay-owned-frames.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1'))
    .join('\n');
}
const STRIPPED = stripComments(SERVER_SRC);

// ── PART 0 — slice the REAL source out of server.js ─────────────────────────

function balancedFrom(src, openAt, what) {
  let depth = 0;
  for (let j = openAt; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return j;
  }
  throw new Error(`unterminated ${what}`);
}

function extractFn(name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(async )?function ${name}\\(`).exec(SERVER_SRC);
  if (!m) throw new Error(`function ${name} not found in server.js`);
  const start = SERVER_SRC.indexOf(m[1] ? 'async function' : 'function', m.index);
  let i = SERVER_SRC.indexOf('(', start);
  for (let parens = 0; i < SERVER_SRC.length; i++) {
    if (SERVER_SRC[i] === '(') parens++;
    else if (SERVER_SRC[i] === ')' && --parens === 0) break;
  }
  const end = balancedFrom(SERVER_SRC, SERVER_SRC.indexOf('{', i), name);
  return SERVER_SRC.slice(start, end + 1);
}

function extractConst(name) {
  const m = new RegExp(`(?:^|\\n)\\s*const ${name} =`).exec(SERVER_SRC);
  if (!m) throw new Error(`const ${name} not found in server.js`);
  const start = SERVER_SRC.indexOf('const ', m.index);
  let depth = 0;
  for (let j = start; j < SERVER_SRC.length; j++) {
    const c = SERVER_SRC[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return SERVER_SRC.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

/**
 * The body of a `ws.on('message', <head> => { … })` callback. The slice must end
 * exactly at `});` followed by that socket's `ws.on('close'` — if the brace
 * walk ever lands anywhere else the extractor throws rather than testing a
 * truncated handler.
 */
function extractOnMessageBody(head) {
  const at = SERVER_SRC.indexOf(head);
  if (at === -1 || SERVER_SRC.indexOf(head, at + 1) !== -1) throw new Error(`message handler "${head}" not found exactly once`);
  const open = at + head.length - 1;
  const close = balancedFrom(SERVER_SRC, open, head);
  if (!/^\);\s*\n\s*ws\.on\('close'/.test(SERVER_SRC.slice(close + 1, close + 200))) {
    throw new Error(`message handler "${head}": slice did not end at the ws.on('close') boundary`);
  }
  return SERVER_SRC.slice(open + 1, close);
}

const PHONE_BODY = extractOnMessageBody("ws.on('message', (data) => {");
const BROWSER_BODY = extractOnMessageBody("ws.on('message', async (data) => {");

const CONSTS = ['FT_FRAME_TYPES', 'BATTERY_MIN_INTERVAL_MS', 'FRAME_BUFFER_MAX', 'RELAY_OWNED_PREF_FRAME_PREFIXES'];
const FNS = [
  'frameType', 'frameLabel', 'countDroppedLobbyFrame', 'isFileFrame', 'isBatteryFrame', 'batteryCountDrop', 'batteryGate',
  'isRelayOwnedPrefFrame', 'forwardDataPlane', 'broadcastToListeners', 'deliverLobbyFrameDuringResume', 'gateBrowserSyncFrame',
  'e2ePrefRecipients', 'loadE2ePrefTarget', 'sendE2ePrefToRoom', 'applyE2ePrefChangeForUser', 'handlePhoneE2ePrefFrame',
];

/**
 * A fresh relay instance. `plant: true` replaces the real isRelayOwnedPrefFrame
 * with one that never matches — the mutation every dropped case must detect.
 */
function buildRelay({ plant = false, db = null, rooms = new Map() } = {}) {
  const logs = [];
  const resets = [];
  const fnSrc = FNS.map((n) => (plant && n === 'isRelayOwnedPrefFrame')
    ? 'function isRelayOwnedPrefFrame(msg) { return false; }'
    : extractFn(n));
  const body = [
    ...CONSTS.map(extractConst),
    'const batteryDropCounts = new Map();',
    'const droppedLobbyFrameCounts = new Map();',
    ...fnSrc,
    `function phoneOnMessage(ws, room, token, data) {\n${PHONE_BODY}\n}`,
    `async function browserOnMessage(ws, room, token, peerIp, data) {\n${BROWSER_BODY}\n}`,
    `return { ${[...CONSTS, ...FNS].join(', ')}, phoneOnMessage, browserOnMessage };`,
  ].join('\n\n');

  const safeSend = (ws, msg) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.sent.push(String(msg));
    return true;
  };
  const deps = {
    safeSend,
    rlog: (...a) => logs.push(a.join(' ')),
    redactToken: () => 'tok:redacted',
    redactUserId: () => 'user:redacted',
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(`ERROR ${a.join(' ')}`), warn: (...a) => logs.push(a.join(' ')) },
    Buffer, Date, JSON,
    WebSocket: { OPEN: 1 },
    LEGACY_RESUME_TEARDOWN: false,
    logNotifFrame: () => {},
    ftCountDrop: () => {},
    handleFileFrame: () => { throw new Error('handleFileFrame must not be reached by these frames'); },
    // Re-form stub: the room names the socket that is "returning"; tryAutoResume
    // slots it into its active role exactly as the real one does on success.
    tryAutoResume: (room) => {
      if (!room.__reform) return false;
      const ws = room.__reform;
      room.lobby.delete(ws);
      room.active[ws.role] = ws;
      room.resumable = null;
      return true;
    },
    db,
    rooms,
    resolveE2ePref: prefCore.resolveE2ePref,
    e2ePrefEnv: prefCore.e2ePrefEnv,
    e2ePrefFrame: prefCore.e2ePrefFrame,
    setE2ePrefCore: prefCore.setE2ePref,
    seedE2ePrefCore: prefCore.seedE2ePref,
    doResetRoom: (token, origin) => { resets.push({ token, origin }); return { closed: 0 }; },
  };
  const names = Object.keys(deps);
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  api.logs = logs;
  api.resets = resets;
  return api;
}

// ── sockets and rooms ───────────────────────────────────────────────────────

const TOKEN = 'ROOMTOKEN';
const USER = 'user-1';
const mk = (role, extra = {}) => ({ role, readyState: 1, sent: [], userId: USER, missedPongs: 0, ...extra });
const mkPhone = () => mk('phone', { phoneToken: TOKEN });
const mkBrowser = () => mk('browser', { tier: 'pro', tierLimits: { contactSync: true } });
const mkListener = () => mk('browser', { listener: true });

/**
 * Build the room for a pairState and return { room, sender, watchers, targets }:
 * `watchers` are every socket that must NOT see a dropped frame, `targets` the
 * socket(s) a forwarded frame must reach (empty for resume-buffer, where
 * "delivered" means it entered room.frameBuffer for replay).
 */
function scenario(from, pairState) {
  const phone = mkPhone(); const browser = mkBrowser(); const listener = mkListener();
  const room = {
    token: TOKEN, lobby: new Set([listener]), active: { browser: null, phone: null, e2e: null },
    pendingPairing: null, resumable: null, frameBuffer: [], transfer: null,
  };
  const armed = () => ({ droppedRole: from === 'phone' ? 'phone' : 'browser', droppedAt: Date.now(), expiresAt: Date.now() + 30_000 });
  let sender; let targets;
  if (from === 'listener') {
    room.active = { browser, phone, e2e: null };
    sender = listener; targets = [phone];
  } else if (pairState === 'active' || pairState === 'listener-mirror') {
    room.active = { browser, phone, e2e: null };
    sender = from === 'phone' ? phone : browser;
    targets = from === 'phone' ? (pairState === 'listener-mirror' ? [listener] : [browser]) : [phone];
  } else if (pairState === 'resume' || pairState === 'resume-reform') {
    // The sender is a returning socket in the LOBBY; the opposite peer is the
    // soft-held survivor in room.active under an armed claim.
    sender = from === 'phone' ? phone : browser;
    const survivor = from === 'phone' ? browser : phone;
    room.active[survivor.role] = survivor;
    room.lobby.add(sender);
    room.resumable = armed();
    if (pairState === 'resume-reform') room.__reform = sender;
    targets = [survivor];
  } else if (pairState === 'resume-buffer') {
    if (from !== 'phone') throw new Error('resume-buffer is a phone-side state');
    sender = phone; room.lobby.add(phone); room.resumable = armed();
    targets = [];
  } else {
    throw new Error(`unknown pairState ${pairState}`);
  }
  const watchers = [phone, browser, listener].filter((s) => s !== sender);
  return { room, sender, watchers, targets };
}

async function deliver(api, from, pairState, frame) {
  const s = scenario(from, pairState);
  if (from === 'phone') api.phoneOnMessage(s.sender, s.room, TOKEN, Buffer.from(frame));
  else await api.browserOnMessage(s.sender, s.room, TOKEN, '203.0.113.9', Buffer.from(frame));
  const seenBy = s.watchers.filter((w) => w.sent.includes(frame));
  const buffered = s.room.frameBuffer.some((e) => e.msg === frame);
  const reached = s.targets.length ? s.targets.every((t) => t.sent.includes(frame)) : buffered;
  return { ...s, seenBy, buffered, reached, echoed: s.sender.sent.length };
}

console.log('\ntests/relay-e2e-pref-frame-filter.test.mjs — Security C1: peer-sent E2E_PREF / E2E_PREF_REFUSED dropped both ways\n');

// ── (0) the extraction is real ──────────────────────────────────────────────
{
  const api = buildRelay();
  check('(0) both message handlers sliced from server.js',
    PHONE_BODY.includes('broadcastToListeners(room, msg)') && BROWSER_BODY.includes('forwardDataPlane(room, ws, forwardMsg)'));
  check('(0) isRelayOwnedPrefFrame loaded from server.js', typeof api.isRelayOwnedPrefFrame === 'function');
  check('(0) vector ids unique', new Set(V.cases.map((c) => c.id)).size === V.cases.length);
  for (const p of ['a', 'b', 'c', 'd', 'e', 'g', 'n']) {
    check(`(0) vectors cover group (${p})`, V.cases.some((c) => c.id.startsWith(p)));
  }
}

// ── (h) the helper's const list IS the JSON list ────────────────────────────
{
  const api = buildRelay();
  let same = true;
  try { deepStrictEqual(api.RELAY_OWNED_PREF_FRAME_PREFIXES, V.prefixes); } catch { same = false; }
  check('(h) RELAY_OWNED_PREF_FRAME_PREFIXES deep-equals the JSON prefixes', same,
    `server ${JSON.stringify(api.RELAY_OWNED_PREF_FRAME_PREFIXES)} json ${JSON.stringify(V.prefixes)}`);
  check('(h) the prefixes are exactly the two relay-minted frame types',
    JSON.stringify(V.prefixes) === JSON.stringify(['E2E_PREF:', 'E2E_PREF_REFUSED:']));
  for (const p of V.prefixes) {
    check(`(h) "${p}{}" is relay-owned`, api.isRelayOwnedPrefFrame(`${p}{}`) === true);
  }
  check('(h) the relay itself mints exactly these prefixes',
    STRIPPED.includes('`E2E_PREF_REFUSED:${JSON.stringify(') && prefCore.e2ePrefFrame({ rev: 1 }).startsWith('E2E_PREF:'));
  check('(h) a non-string frame is not relay-owned',
    api.isRelayOwnedPrefFrame(undefined) === false && api.isRelayOwnedPrefFrame(null) === false);
}

// ── source order: each filter sits ABOVE every exit it guards ──────────────
{
  const P = stripComments(PHONE_BODY);
  const B = stripComments(BROWSER_BODY);
  const pf = P.indexOf('isRelayOwnedPrefFrame(msg)');
  const bf = B.indexOf('isRelayOwnedPrefFrame(msg)');
  check('(order) exactly one filter in each handler',
    pf > 0 && P.indexOf('isRelayOwnedPrefFrame(msg)', pf + 1) === -1 && bf > 0 && B.indexOf('isRelayOwnedPrefFrame(msg)', bf + 1) === -1);
  // `!forwardDataPlane(` is the data-plane forward; the bare call above the
  // filter belongs to the DEVICE_INFO branch, which only a DEVICE_INFO: frame
  // can enter.
  for (const exit of ['isFileFrame(msg)', 'isBatteryFrame(msg)', 'broadcastToListeners(room, msg)', 'if (!forwardDataPlane(room, ws, msg))',
    'deliverLobbyFrameDuringResume(room, ws, msg', 'room.frameBuffer.push(']) {
    const at = P.indexOf(exit);
    check(`(order) phone: filter precedes ${exit}`, at > pf, `filter@${pf} exit@${at}`);
  }
  for (const exit of ["msg.startsWith('BROWSER_REQUEST_PAIRING:')", 'isBatteryFrame(msg)', 'isFileFrame(msg)',
    'gateBrowserSyncFrame(ws, msg)', 'forwardDataPlane(room, ws, forwardMsg)', 'deliverLobbyFrameDuringResume(room, ws, forwardMsg']) {
    const at = B.indexOf(exit);
    check(`(order) browser: filter precedes ${exit}`, at > bf, `filter@${bf} exit@${at}`);
  }
  // Payload never logged: the drop line uses frameLabel (type + bytes) only.
  const dropLines = [P, B].map((s) => {
    const at = s.indexOf('isRelayOwnedPrefFrame(msg)');
    return s.slice(at, s.indexOf('return;', at));
  });
  check('(order) each drop logs frameLabel(msg) and never the raw msg',
    dropLines.every((l) => l.includes('frameLabel(msg)') && !/\$\{msg\}/.test(l)));
}

// ── (a)(b)(c)(d)(e)(g)(n) — every JSON case, real handlers, then the plant ──
for (const c of V.cases) {
  const tag = `(${c.id}) ${c.from}->${c.pairState} ${c.frame.slice(0, c.frame.indexOf(':') + 1)}`;
  const api = buildRelay();
  const r = await deliver(api, c.from, c.pairState, c.frame);
  const errs = api.logs.filter((l) => l.startsWith('ERROR'));
  check(`${tag}: no handler crash`, errs.length === 0, errs.join(' | '));
  if (c.expect === 'dropped') {
    check(`${tag}: reached NO socket`, r.seenBy.length === 0,
      `seen by ${r.seenBy.map((s) => s.role + (s.listener ? '(listener)' : '')).join(',')}`);
    check(`${tag}: not buffered for replay`, r.buffered === false);
    check(`${tag}: nothing echoed to the sender`, r.echoed === 0);
    if (c.from !== 'listener') {
      const hdr = c.from === 'phone' ? 'phone socket' : 'browser socket';
      check(`${tag}: one drop line, type+bytes only`,
        api.logs.filter((l) => l.includes(`relay-owned frame from a ${hdr}`)).length === 1
        && !api.logs.some((l) => l.includes('2147483647') || l.includes('rate_limited') || l.includes('invalid_value')));
    }
    // The plant: the SAME scenario without the filter must deliver the forgery,
    // or this case could not have gone red.
    const planted = await deliver(buildRelay({ plant: true }), c.from, c.pairState, c.frame);
    if (c.from === 'listener') {
      check(`${tag}: [plant] listener branch drops regardless (pre-existing receive-only return)`, planted.seenBy.length === 0);
    } else {
      check(`${tag}: [plant] with the filter removed the forgery IS delivered`, planted.reached === true);
    }
  } else {
    check(`${tag}: forwarded to its target`, r.reached === true,
      `targets=${r.targets.map((t) => t.role).join(',')} buffered=${r.buffered}`);
  }
}

// ── (d) the listener mirror, stated directly ────────────────────────────────
{
  const api = buildRelay();
  const forged = V.cases.find((c) => c.id === 'd1').frame;
  const r = await deliver(api, 'phone', 'listener-mirror', forged);
  const lst = [...r.room.lobby].find((s) => s.listener);
  check('(d) the passive extension listener received nothing', lst.sent.length === 0);
  check('(d) nor did the active browser', r.room.active.browser.sent.length === 0);
}

// ── (f) honest relay-minted E2E_PREF still reaches every socket ────────────
function fakeDb(state) {
  const row = () => ({ e2ePref: state.pref, e2ePrefRev: state.rev, e2ePrefUpdatedAt: null, e2ePrefUpdatedBy: state.by });
  return {
    user: {
      findUnique: async ({ where }) => (where.id === USER ? { phoneToken: TOKEN, ...row() } : null),
    },
    $transaction: async (fn) => fn({
      user: { findUnique: async () => row() },
      $queryRawUnsafe: async (_sql, want, source) => {
        if (state.pref === want) return [];
        state.pref = want; state.rev += 1; state.by = source;
        return [row()];
      },
    }),
  };
}

function accountRoom() {
  const phone = mkPhone(); const browser = mkBrowser(); const lobbyBrowser = mkBrowser(); const listener = mkListener();
  const foreign = mk('browser', { userId: 'someone-else' });
  const room = {
    token: TOKEN, lobby: new Set([lobbyBrowser, listener, foreign]), active: { browser, phone, e2e: null },
    pendingPairing: null, resumable: null, frameBuffer: [], transfer: null,
  };
  return { room, phone, browser, lobbyBrowser, listener, foreign };
}

const tick = () => new Promise((r) => setImmediate(r));
const prefFramesOf = (ws) => ws.sent.filter((m) => m.startsWith('E2E_PREF:')).map((m) => JSON.parse(m.slice('E2E_PREF:'.length)));

const TRIGGERS = [
  ['SET_E2E_PREF from the phone', async ({ api, a }) => {
    api.phoneOnMessage(a.phone, a.room, TOKEN, Buffer.from('SET_E2E_PREF:{"value":"on"}'));
    for (let i = 0; i < 20; i++) await tick();
  }],
  // app/api/prefs/e2e/route.ts PUT calls lib setE2ePref, which hands off to the
  // relay through globalThis.__applyE2ePrefChange — the same hand-off wired here.
  ['PUT /api/prefs/e2e (lib setE2ePref, source web)', async ({ db }) => {
    await prefCore.setE2ePref(db, USER, 'on', 'web');
  }],
];
for (const [label, trigger] of TRIGGERS) {
  const state = { pref: false, rev: 4, by: null };
  const rooms = new Map();
  const db = fakeDb(state);
  const api = buildRelay({ db, rooms });
  const a = accountRoom();
  rooms.set(TOKEN, a.room);
  globalThis.__applyE2ePrefChange = api.applyE2ePrefChangeForUser;
  try {
    await trigger({ api, a, db });
  } catch (e) {
    api.logs.push(`ERROR trigger threw: ${e && e.message}`);
  }
  const errs = api.logs.filter((l) => l.startsWith('ERROR'));
  check(`(f) ${label}: no crash`, errs.length === 0, errs.join(' | '));
  check(`(f) ${label}: the write landed (rev 4 -> 5)`, state.rev === 5, `rev=${state.rev}`);
  for (const [name, ws] of [['active phone', a.phone], ['active browser', a.browser], ['lobby browser', a.lobbyBrowser], ['extension listener', a.listener]]) {
    const got = prefFramesOf(ws);
    check(`(f) ${label}: ${name} received the relay-minted E2E_PREF rev 5`,
      got.length === 1 && got[0].rev === 5 && got[0].preference === 'on', JSON.stringify(got));
  }
  check(`(f) ${label}: another account's socket received nothing`, a.foreign.sent.length === 0);
  check(`(f) ${label}: the forced e2e-pref reset ran once, after the push`,
    api.resets.length === 1 && api.resets[0].origin === 'e2e-pref');
}
delete globalThis.__applyE2ePrefChange;

// ── (g) SET/SEED behaviour unchanged ────────────────────────────────────────
for (const frame of ['SET_E2E_PREF:{"value":"off"}', 'SEED_E2E_PREF:{"value":"on"}']) {
  const api = buildRelay();
  const s = scenario('browser', 'active');
  await api.browserOnMessage(s.sender, s.room, TOKEN, '203.0.113.9', Buffer.from(frame));
  check(`(g) browser ${frame.split(':')[0]} still dropped with its own log line`,
    s.watchers.every((w) => w.sent.length === 0)
    && api.logs.some((l) => l.includes('E2E_PREF write from a browser socket — ignored'))
    && !api.logs.some((l) => l.includes('relay-owned frame')));
}
{
  const api = buildRelay();
  const s = scenario('listener', 'active');
  await api.browserOnMessage(s.sender, s.room, TOKEN, '203.0.113.9', Buffer.from('SET_E2E_PREF:{"value":"off"}'));
  check('(g) listener SET_E2E_PREF still logged as ignored and dropped',
    s.watchers.every((w) => w.sent.length === 0) && api.logs.some((l) => l.includes('E2E_PREF write from a listener — ignored')));
}
{
  // A malformed phone SET is answered with the relay's OWN E2E_PREF_REFUSED —
  // the filter stops peers sending that type, never the relay.
  const api = buildRelay();
  const s = scenario('phone', 'active');
  api.phoneOnMessage(s.sender, s.room, TOKEN, Buffer.from('SET_E2E_PREF:{"value":"maybe"}'));
  for (let i = 0; i < 5; i++) await tick();
  check('(g) phone SET with a bad value -> relay-minted E2E_PREF_REFUSED to that phone only',
    s.sender.sent.length === 1 && s.sender.sent[0] === 'E2E_PREF_REFUSED:{"op":"set","reason":"invalid_value"}'
    && s.watchers.every((w) => w.sent.length === 0), JSON.stringify(s.sender.sent));
}

console.log(`\nrelay-e2e-pref-frame-filter: ${pass}/${pass + fail} checks passed`);
if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
