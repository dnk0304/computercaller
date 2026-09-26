#!/usr/bin/env node
/**
 * tests/ext-web-dual-session.test.mjs — EXT/WEB DUAL SESSION, Option A
 * (Dennis 2026-09-25: "user should pick if he works in webapp or extension").
 *
 * One surface at a time, made SYMMETRIC: the newest sign-in wins on every
 * surface. Before this change an extension sign-in kicked the web tab, but a
 * web sign-in left the extension's listener running — the relay never indexed
 * it. This file proves both orders and every rule around them.
 *
 * ── How the relay half is tested, honestly ──────────────────────────────────
 * server.js cannot be imported (it boots Next.js). Rather than a hand-written
 * mirror, the REAL source is SLICED out of server.js — the whole index +
 * supersede block, validateTicket, and the listener-admission block — and
 * evaluated with only its I/O injected (a fake socket, a fake db, the real
 * jsonwebtoken). A change to the shipped code changes what runs here. Plant:
 * delete `indexListenerSocket(userId, ws);` from admission and sections 1-3 go
 * red (the listener is never kicked).
 *
 * The extension half imports the SHIPPED background.js under a chrome shim
 * (the tests/bat-sw.test.mjs pattern) and drives real sockets through it.
 *
 * Sections:
 *   1. order web → ext   (ext sign-in kicks the web tab; ext survives)
 *   2. order ext → web   (web sign-in kicks the ext listener AND ext frame)
 *   3. other device / other surface sign-in kicks web AND listener
 *   4. the fresh listener of the bumping session survives (version stamp)
 *   5. sign-out kills both (m2) — listener hears reason signed_out
 *   6. listener admission: stale ticket + raced DB read refused, fresh admitted
 *   7. phone sockets untouched; web wire frame byte-identical
 *   8. extension SW: 4001 terminal, reason recorded, token dropped, no retry
 *   9. extension shell / hosted gate wiring (source)
 *  10. route wiring (source)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

// ── The relay, sliced from server.js ────────────────────────────────────────
const SERVER = read('server.js');
function between(src, startMarker, endMarker, { includeEnd = false } = {}) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(a, includeEnd ? b + endMarker.length : b);
}
const INDEX_BLOCK = between(SERVER, 'const userIdToWebSockets = new Map();',
  'globalThis.__supersedeWebSessions = supersedeWebSessions;');
const VALIDATE_TICKET = between(SERVER, 'async function validateTicket(ticket) {',
  "\n  wss.on('connection'");
const ADMISSION = between(SERVER, "if (authVia === 'relay-ticket' && isListener) {",
  'console.log(`[Relay] Connection authed');
const CLOSE_UNINDEX = /if \(ws\.listener\) unindexListenerSocket\(ws\.userId, ws\);/.test(SERVER);

const OPEN = 1;
const CLOSED = 3;
const SECRET = 'x'.repeat(40);

function makeRelay(db) {
  const WebSocket = { OPEN, CLOSED };
  const quiet = { log() {}, error() {} };
  function safeSend(ws, msg) { if (ws.readyState !== OPEN) return false; ws.sent.push(msg); return true; }
  const factory = new Function('WebSocket', 'safeSend', 'console', 'jwt', 'db', 'process', `
    ${INDEX_BLOCK}
    ${VALIDATE_TICKET}
    function admit(authVia, isListener, ticketFacts, userId, ws) {
      ${ADMISSION}
      return 'admitted';
    }
    return { indexWebSocket, unindexWebSocket, unindexListenerSocket, supersedeWebSessions,
      validateTicket, admit, listenerSupersedeCount, userIdToWebSockets, userIdToListenerSockets };
  `);
  return factory(WebSocket, safeSend, quiet, jwt, db, { env: { JWT_SECRET: SECRET } });
}

function makeWs(kind) {
  const ws = { kind, readyState: OPEN, sent: [], closes: [] };
  ws.close = (code, reason) => { ws.closes.push([code, reason]); ws.readyState = CLOSED; };
  return ws;
}

/**
 * A tiny account world: the DB row, the relay, and the three things each sign
 * in does in production order — bump, supersede (naming the version, as
 * login/google/logout now do), then the new surface opens its sockets.
 */
function makeWorld() {
  const user = { id: 'u1', phoneToken: 'pt', sessionVersion: 1 };
  let gate = null;       // optional promise the fake DB read waits on (race test)
  const db = {
    user: {
      findUnique: async ({ where }) => {
        if (gate) await gate;
        return where.id === user.id ? { ...user } : null;
      },
    },
  };
  const relay = makeRelay(db);
  const mintExtTicket = () => jwt.sign(
    { userId: user.id, purpose: 'relay-ticket', ver: user.sessionVersion }, SECRET, { algorithm: 'HS256', expiresIn: '30s' });
  async function openListener() {
    const ws = makeWs('listener');
    ws.listener = true;
    const facts = await relay.validateTicket(mintExtTicket());
    ws.admission = relay.admit('relay-ticket', true, facts, user.id, ws);
    return ws;
  }
  function openWeb(kind = 'web') {
    const ws = makeWs(kind);
    relay.indexWebSocket(user.id, ws);   // relay-ticket, !isListener
    return ws;
  }
  function signIn() {
    user.sessionVersion += 1;
    relay.supersedeWebSessions(user.id, { sessionVersion: user.sessionVersion, reason: 'superseded' });
  }
  function signOut() {
    user.sessionVersion += 1;
    relay.supersedeWebSessions(user.id, { sessionVersion: user.sessionVersion, reason: 'signed_out' });
  }
  return { user, relay, db, openListener, openWeb, signIn, signOut, setGate: (g) => { gate = g; }, mintExtTicket };
}

const WEB_FRAME = 'SESSION_SUPERSEDED:{"reason":"signed_in_elsewhere"}';
const LISTENER_SUPERSEDED = 'SESSION_SUPERSEDED:{"reason":"superseded"}';
const LISTENER_SIGNED_OUT = 'SESSION_SUPERSEDED:{"reason":"signed_out"}';
const kicked = (ws) => ws.closes.length === 1 && ws.closes[0][0] === 4001 && ws.closes[0][1] === 'session_superseded';
const alive = (ws) => ws.closes.length === 0 && ws.readyState === OPEN;

check('0.1 the index block was sliced', INDEX_BLOCK.includes('function supersedeListenerSessions'), String(INDEX_BLOCK.length));
check('0.2 the admission block was sliced', ADMISSION.includes('indexListenerSocket'), String(ADMISSION.length));
check('0.3 the close handler scrubs the listener index', CLOSE_UNINDEX);

// 1. web → ext ---------------------------------------------------------------
{
  const w = makeWorld();
  w.signIn();                               // web signs in
  const web = w.openWeb();
  w.signIn();                               // then the extension signs in
  const extFrame = w.openWeb('ext-frame');  // the /extension iframe's own socket
  const listener = await w.openListener();
  check('1.1 web tab kicked with 4001', kicked(web), JSON.stringify(web.closes));
  check('1.2 web tab got the unchanged web frame first', web.sent[0] === WEB_FRAME, web.sent[0]);
  check('1.3 extension listener admitted', listener.admission === 'admitted', listener.admission);
  check('1.4 extension listener alive', alive(listener));
  check('1.5 extension frame alive', alive(extFrame));
}

// 2. ext → web (the order that used to be silent) ----------------------------
{
  const w = makeWorld();
  w.signIn();                               // extension signs in
  const extFrame = w.openWeb('ext-frame');
  const listener = await w.openListener();
  w.signIn();                               // then the web app signs in
  const web = w.openWeb();
  check('2.1 extension listener KICKED by the web sign-in', kicked(listener), JSON.stringify(listener.closes));
  check('2.2 listener got the frame BEFORE the close, reason superseded', listener.sent[0] === LISTENER_SUPERSEDED, listener.sent[0]);
  check('2.3 extension frame socket kicked (its KickedSessionGate shows)', kicked(extFrame));
  check('2.4 the new web tab is alive', alive(web));
  check('2.5 kicked listener left the index', !w.relay.userIdToListenerSockets.has('u1'));
  // "Sign back in here" on the extension → an extension sign-in → web kicked.
  w.signIn();
  const listener2 = await w.openListener();
  check('2.6 sign back in on the extension kicks the web tab', kicked(web));
  check('2.7 …and the extension is live again', alive(listener2) && listener2.admission === 'admitted');
}

// 3. any other sign-in kicks web AND listener --------------------------------
{
  const w = makeWorld();
  w.signIn();
  const web = w.openWeb();
  const listener = await w.openListener();   // same version: both "current"
  w.signIn();                                // other device
  check('3.1 other-device sign-in kicks the web tab', kicked(web));
  check('3.2 other-device sign-in kicks the listener', kicked(listener));
  const w2 = makeWorld();
  w2.signIn();
  const l2 = await w2.openListener();
  w2.relay.supersedeWebSessions('u1');       // change-password style caller
  check('3.4 a caller that names no version kicks every listener', kicked(l2));
}

// 4. the fresh listener of the bumping session survives -----------------------
{
  const w = makeWorld();
  w.signIn();
  const old = await w.openListener();        // minted at v2
  w.user.sessionVersion += 1;                // bump to v3 ...
  // ... a v3 listener already present (the fresh session's own socket)
  const fresh = makeWs('listener'); fresh.listener = true;
  fresh.admission = w.relay.admit('relay-ticket', true,
    { ticketVer: 3, currentVer: 3, supersedeSeqAtRead: w.relay.listenerSupersedeCount('u1') }, 'u1', fresh);
  w.relay.supersedeWebSessions('u1', { sessionVersion: 3, reason: 'superseded' });
  check('4.1 the older listener is kicked', kicked(old));
  check('4.2 the listener minted AT the new version survives', alive(fresh), JSON.stringify(fresh.closes));
  const unknown = makeWs('listener'); unknown.listener = true;
  w.relay.admit('relay-ticket', true, { ticketVer: null, currentVer: 3,
    supersedeSeqAtRead: w.relay.listenerSupersedeCount('u1') }, 'u1', unknown);
  w.relay.supersedeWebSessions('u1', { sessionVersion: 3, reason: 'superseded' });
  check('4.3 a listener with NO stamped version is kicked (unknown = stale)', kicked(unknown));
}

// 5. sign-out kills both -------------------------------------------------------
{
  const w = makeWorld();
  w.signIn();
  const web = w.openWeb();
  const extFrame = w.openWeb('ext-frame');
  const listener = await w.openListener();
  w.signOut();
  check('5.1 sign-out kicks the web tab', kicked(web));
  check('5.2 sign-out kicks the extension frame', kicked(extFrame));
  check('5.3 sign-out kicks the listener', kicked(listener));
  check('5.4 the listener hears reason signed_out', listener.sent[0] === LISTENER_SIGNED_OUT, listener.sent[0]);
  check('5.5 the web wire frame is unchanged on sign-out', web.sent[0] === WEB_FRAME, web.sent[0]);
}

// 6. admission ---------------------------------------------------------------
{
  const w = makeWorld();
  w.signIn();
  const staleTicket = w.mintExtTicket();     // minted at v2 ...
  w.signIn();                                // ... then a sign-in elsewhere (v3)
  const ws = makeWs('listener'); ws.listener = true;
  const facts = await w.relay.validateTicket(staleTicket);
  check('6.1 validateTicket reports the ticket and current versions', facts && facts.ticketVer === 2 && facts.currentVer === 3, JSON.stringify(facts));
  const res = w.relay.admit('relay-ticket', true, facts, 'u1', ws);
  check('6.2 a stale-version listener is refused', res === undefined && kicked(ws), JSON.stringify(ws.closes));
  check('6.3 …with the kick frame first', ws.sent[0] === LISTENER_SUPERSEDED, ws.sent[0]);
  check('6.4 …and is not indexed', !w.relay.userIdToListenerSockets.has('u1'));

  // The race: the DB read happens BEFORE a bump, the index AFTER the kick.
  const w2 = makeWorld();
  w2.signIn();
  const ticket = w2.mintExtTicket();
  let release;
  w2.setGate(new Promise((r) => { release = r; }));
  const pending = w2.relay.validateTicket(ticket);   // counter snapshotted now
  w2.user.sessionVersion += 1;                       // sign-in elsewhere lands
  w2.relay.supersedeWebSessions('u1', { sessionVersion: w2.user.sessionVersion, reason: 'superseded' });
  w2.user.sessionVersion -= 1;                       // the read "saw" the old row
  release();
  const racedFacts = await pending;
  w2.setGate(null);
  const r2 = makeWs('listener'); r2.listener = true;
  const res2 = w2.relay.admit('relay-ticket', true, racedFacts, 'u1', r2);
  check('6.5 a listener whose DB read raced a supersede is refused', res2 === undefined && kicked(r2), JSON.stringify({ racedFacts, closes: r2.closes }));

  const w3 = makeWorld();
  w3.signIn();
  const ok = await w3.openListener();
  check('6.6 a fresh listener is admitted and indexed', ok.admission === 'admitted' && w3.relay.userIdToListenerSockets.get('u1')?.has(ok));
  check('6.7 …stamped with its ticket version', ok.sessionVer === 2, String(ok.sessionVer));
  const notListener = makeWs('web');
  check('6.8 admission is a no-op for a non-listener', w3.relay.admit('relay-ticket', false, {}, 'u1', notListener) === 'admitted' && alive(notListener));
  check('6.9 listeners never enter the web index', ![...(w3.relay.userIdToWebSockets.get('u1') || [])].some((s) => s.listener));
}

// 7. phone untouched ---------------------------------------------------------
{
  const w = makeWorld();
  w.signIn();
  const phone = makeWs('phone');   // legacy-token: never indexed anywhere
  await w.openListener();
  w.signIn();
  w.signOut();
  check('7.1 the phone socket is never touched', alive(phone) && phone.sent.length === 0);
}

// ── 8. the extension service worker ─────────────────────────────────────────
let local = {};
let session = {};
const msgListeners = [];
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
    onChanged: chan(),
  },
  runtime: {
    id: 'test', lastError: null,
    getURL: (p) => `chrome-extension://test/${p}`,
    onConnect: chan(), onMessage: { addListener: (f) => msgListeners.push(f) },
    onStartup: chan(), onInstalled: chan(), sendMessage: noop,
    getPlatformInfo: () => Promise.resolve({}),
  },
  notifications: { create: noop, clear: noop, onClicked: chan(), onButtonClicked: chan() },
  alarms: { create: noop, onAlarm: chan(), get: (n, cb) => cb(null), clear: (n, cb) => { if (cb) cb(true); } },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setIcon: noop, setTitle: noop, onClicked: chan() },
  windows: { onRemoved: chan(), create: noop, remove: noop, update: noop, getAll: (o, cb) => cb([]) },
  tabs: { query: (o, cb) => cb([]), create: noop },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve(), setOptions: () => Promise.resolve() },
  identity: { getAuthToken: noop },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.self = globalThis;
globalThis.createImageBitmap = () => Promise.reject(new Error('no bitmaps'));
globalThis.OffscreenCanvas = class {
  getContext() {
    return { clearRect: noop, fillRect: noop, beginPath: noop, arc: noop, fill: noop,
      fillText: noop, measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }) };
  }
};
const sockets = [];
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  close() { this.readyState = 3; }
};
globalThis.WebSocket.OPEN = 1;
let ticketStatus = 200;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/api/auth/relay-ticket/extension')) {
    return { ok: ticketStatus === 200, status: ticketStatus, json: async () => ({ ticket: 'tk' }) };
  }
  if (u.endsWith('/api/auth/extension/token')) {
    return { ok: true, status: 200, json: async () => ({ ext_token: 'T-fresh' }) };
  }
  return { ok: false, status: 503, json: async () => ({}) };
};
// The worker logs freely (icon compose, IndexedDB-less key load) — none of it
// is under test here, so it is silenced; this file's own output is console.error.
console.warn = noop;
console.log = ((log) => (...a) => { if (String(a[0]).startsWith('ext-web-dual-session')) log(...a); })(console.log);
await import('../chrome-extension/background.js');
const W = globalThis.self;
const KICK = await import('../chrome-extension/session-kick.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(5); await W.serialize(async () => {}); await sleep(5); };
const TOKEN_KEY = W.CC.TOKEN_KEY;

async function openSock(token) {
  local = { [TOKEN_KEY]: token };
  W.ws = null;
  await W.connect();
  await sleep(5);
  const s = sockets[sockets.length - 1];
  s.readyState = 1;
  if (s.onopen) s.onopen();
  return s;
}

{
  const s = await openSock('T1');
  check('8.0 the worker opened a listener socket', s && /role=listener/.test(s.url), s && s.url);
  s.onmessage({ data: 'SESSION_SUPERSEDED:{"reason":"superseded"}' });
  const before = sockets.length;
  s.readyState = 3;
  s.onclose({ code: 4001, reason: 'session_superseded' });
  await settle();
  check('8.1 kick recorded with reason superseded', local[KICK.KICKED_KEY]?.reason === 'superseded', JSON.stringify(local));
  check('8.2 the dead token is dropped', !(TOKEN_KEY in local));
  check('8.3 the worker reports signed out', W.authFacts().cleared === true, JSON.stringify(W.authFacts()));
  await sleep(1300);   // past the shortest reconnect backoff
  check('8.4 4001 is terminal — no reconnect attempt', sockets.length === before, `${before} → ${sockets.length}`);
}
{
  const s = await openSock('T2');
  s.onmessage({ data: 'SESSION_SUPERSEDED:{"reason":"signed_out"}' });
  s.onclose({ code: 4001, reason: 'session_superseded' });
  await settle();
  check('8.5 a sign-out elsewhere is recorded as signed_out', local[KICK.KICKED_KEY]?.reason === 'signed_out', JSON.stringify(local));
}
{
  const s = await openSock('T3');
  s.onclose({ code: 4001, reason: 'session_superseded' });   // close with no frame
  await settle();
  check('8.6 a bare 4001 means superseded', local[KICK.KICKED_KEY]?.reason === 'superseded');
}
{
  const s = await openSock('T4');
  local[TOKEN_KEY] = 'T5-newer';                             // a sign-in replaced it
  delete local[KICK.KICKED_KEY];
  s.onmessage({ data: 'SESSION_SUPERSEDED:{"reason":"superseded"}' });
  s.onclose({ code: 4001, reason: 'session_superseded' });
  await settle();
  check('8.7 a kick of a REPLACED token leaves the newer token alone', local[TOKEN_KEY] === 'T5-newer', JSON.stringify(local));
  check('8.8 …and records no kick', !(KICK.KICKED_KEY in local));
}
{
  local = { [TOKEN_KEY]: 'T6', [KICK.KICKED_KEY]: { reason: 'superseded', at: 1 } };
  ticketStatus = 409;
  const t = await W.mintTicket('T6');
  ticketStatus = 200;
  await settle();
  check('8.9 a 409 at ticket mint (worker was asleep for the kick) returns no ticket', t === null);
  check('8.10 …and is recorded as a kick, not a silent sign-out', local[KICK.KICKED_KEY]?.reason === 'superseded' && !(TOKEN_KEY in local), JSON.stringify(local));
}
{
  local = { [KICK.KICKED_KEY]: { reason: 'superseded', at: 1 } };
  await new Promise((r) => { for (const f of msgListeners) f({ type: 'sign-in-complete' }, {}, r); });
  await settle();
  check('8.11 signing back in on the extension clears the kick', !(KICK.KICKED_KEY in local) && local[TOKEN_KEY] === 'T-fresh', JSON.stringify(local));
}
{
  local = { [KICK.KICKED_KEY]: { reason: 'signed_out', at: 1 } };
  for (const f of msgListeners) f({ type: 'signed-out' }, {}, noop);
  await settle();
  check('8.12 an explicit sign-out here clears any kick record', !(KICK.KICKED_KEY in local));
}
{
  const s = await openSock('T7');
  const before = sockets.length;
  s.onclose({ code: 1006, reason: '' });
  await sleep(1300);
  check('8.13 control: an ordinary drop still reconnects', sockets.length > before, `${before} → ${sockets.length}`);
  check('8.14 control: an ordinary drop records no kick', !(KICK.KICKED_KEY in local));
}
// pure rules
check('8.15 kickReasonFromFrame', KICK.kickReasonFromFrame({ reason: 'signed_out' }) === 'signed_out'
  && KICK.kickReasonFromFrame({ reason: 'signed_in_elsewhere' }) === 'superseded'
  && KICK.kickReasonFromFrame(null) === 'superseded');
check('8.16 isKickClose', KICK.isKickClose({ code: 4001 }) && KICK.isKickClose({ code: 1000, reason: 'session_superseded' })
  && !KICK.isKickClose({ code: 4010 }) && !KICK.isKickClose(null));
check('8.17 shouldHonourKick', KICK.shouldHonourKick('a', 'a') && !KICK.shouldHonourKick('b', 'a')
  && !KICK.shouldHonourKick(null, 'a') && !KICK.shouldHonourKick(null, null));

// ── 9. shell + hosted gate wiring (source) ──────────────────────────────────
{
  const shell = read('chrome-extension/shell.js');
  const config = read('chrome-extension/config.js');
  check('9.1 config KICKED_KEY equals session-kick KICKED_KEY', config.includes(`KICKED_KEY: '${KICK.KICKED_KEY}'`));
  // The shell's inline view rule is the module's, evaluated over a table.
  const fnSrc = between(shell, 'function kickedViewOf(record) {', '\n}\n', { includeEnd: true });
  const shellView = new Function(`${fnSrc}; return kickedViewOf;`)();
  const table = [null, undefined, 'x', {}, { reason: 'superseded' }, { reason: 'signed_out' }, { reason: 'other' }];
  check('9.2 shell kickedViewOf == session-kick kickedView', table.every((r) => shellView(r) === KICK.kickedView(r)));
  const init = between(shell, 'async function init() {', '\n}\n');
  check('9.3 init consults the kick record BEFORE the cookie probe',
    init.indexOf('readKicked()') >= 0 && init.indexOf('readKicked()') < init.indexOf('probeSession()'));
  check('9.4 the kicked card uses the web card heading', shell.includes(`"You're now signed in on another device."`));
  check('9.5 "Sign back in here" on the card opens the embedded sign-in',
    /overlayState === 'kicked'\) \{ showOverlay\('anon'\)/.test(shell));
  const loginVerbs = between(shell, 'if (fromLogin) {', '    return;\n  }');
  check('9.6 sign-back-in is an APP-frame verb, never a login-frame verb',
    shell.includes("data.type === 'sign-back-in'") && !loginVerbs.includes('sign-back-in'));
  check('9.7 every successful sign-in path clears the record', (shell.match(/clearKickedRecord\(\);/g) || []).length >= 3);

  const gate = read('components/KickedSessionGate.tsx');
  const extBranch = between(gate, '{isExtension ? (', ') : (');
  check('9.8 the extension gate button asks the shell, not /auth/login',
    extBranch.includes('onClick={requestSignBackIn}') && !extBranch.includes('/auth/login'));
  check('9.9 the web gate still links /auth/login', /href="\/auth\/login"/.test(gate));
  const prov = read('app/extension/ExtensionProviders.tsx');
  check('9.10 the extension surface mounts the gate', /<KickedSessionGate surface="extension">/.test(prov));
  check('9.11 /app keeps its default (web) gate', /<KickedSessionGate>/.test(read('app/app/layout.tsx')));
  check('9.12 bridge exposes sign-back-in', /postToShell\('sign-back-in'\)/.test(read('lib/extensionBridge.ts')));
}

// ── 10. route wiring (source) ───────────────────────────────────────────────
{
  const mint = read('app/api/auth/relay-ticket/extension/route.ts');
  check('10.1 the extension ticket is stamped with sessionVersion', /purpose: 'relay-ticket', ver: sessionVersion \}/.test(mint));
  check('10.2 login names the bumped version', /supersede\(user\.id, \{ sessionVersion: bumped\.sessionVersion, reason: 'superseded' \}\)/.test(read('app/api/auth/login/route.ts')));
  check('10.3 google sign-in names the bumped version', /supersede\(user\.id, \{ sessionVersion: bumped\.sessionVersion, reason: 'superseded' \}\)/.test(read('app/api/auth/google/callback/route.ts')));
  check('10.4 logout sends reason signed_out', /reason: 'signed_out'/.test(read('app/api/auth/logout/route.ts')));
  check('10.5 the listener still never enters the web index',
    /if \(authVia === 'relay-ticket' && !isListener\) \{\n\s+indexWebSocket\(userId, ws\);/.test(SERVER));
}

const total = passed + failed;
console.log(`ext-web-dual-session: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
