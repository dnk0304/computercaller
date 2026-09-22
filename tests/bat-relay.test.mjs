#!/usr/bin/env node
/**
 * tests/bat-relay.test.mjs — the relay half of BATTERY (dispatch BAT-2 (a)).
 *
 * THIS FILE DOES NOT MIRROR server.js. It follows tests/ft-relay.test.mjs: the
 * real constants, the real functions and — for the one behaviour that lives
 * inside the ws.on('message') closure rather than in a named function — the
 * real SOURCE BLOCK are extracted out of server.js and executed, with only the
 * relay's ambient dependencies injected. A mirror of a security gate passes
 * happily while the real gate is fail-open, and three of the four things under
 * test here are Security MUSTs (GATE1 Addendum BAT-A1).
 *
 * No database: nothing in the BATTERY path touches Prisma.
 *
 * Run:  node tests/bat-relay.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── PART 0 — pull the REAL source out of server.js ──────────────────────────

/**
 * Strip comments so prose describing a rule can never satisfy the rule.
 *
 * The `\r\n? -> \n` normalisation FIRST is load-bearing and is not cosmetic:
 * server.js is CRLF in the working tree, and in /(^|[^:'"])\/\/.*$/ — no `m`
 * flag — `$` anchors after that CR, so on a CRLF file the line-comment branch
 * matches nothing and every `//` comment survives untouched. That is how an
 * earlier suite in this repo came to read a COMMENT as if it were code. Same
 * stripper, same reason, deliberately duplicated rather than imported so this
 * file has no test-to-test coupling.
 */
function stripComments(src) {
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1'))
    .join('\n');
}
const STRIPPED = stripComments(SERVER_SRC);

/** Brace-balanced extraction of `function NAME(...) { … }` (indented or not). */
function extractFn(name) {
  let start = SERVER_SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in server.js`);
  if (SERVER_SRC.slice(start - 6, start) === 'async ') start -= 6;
  let i = SERVER_SRC.indexOf('(', SERVER_SRC.indexOf(name, start));
  let parens = 0;
  for (; i < SERVER_SRC.length; i++) {
    if (SERVER_SRC[i] === '(') parens++;
    else if (SERVER_SRC[i] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let j = SERVER_SRC.indexOf('{', i); j < SERVER_SRC.length; j++) {
    if (SERVER_SRC[j] === '{') depth++;
    else if (SERVER_SRC[j] === '}' && --depth === 0) return SERVER_SRC.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

/** Bracket-balanced extraction of `const NAME = …;`. */
function extractConst(name) {
  const re = new RegExp(`(?:^|\\n)\\s*const ${name} =`);
  const m = re.exec(SERVER_SRC);
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
 * The resume-window buffering branch, extracted as a runnable block.
 *
 * This is the one behaviour under test that has no name: it is the
 * `if (claim && Date.now() <= claim.expiresAt) { … }` body inside the phone
 * ws.on('message') handler. Re-typing it would make the exemption test assert
 * MY copy of the exemption, which is precisely the plant this deliverable has
 * to be able to catch — so the block is sliced out of the file and executed.
 *
 * The anchor is the FILE_* exemption comment's own guard (`if (isFileFrame(msg))`
 * immediately after `const claim = room.resumable;`), located by walking from
 * the LAST `const claim = room.resumable;` that is followed within 400 chars by
 * `room.frameBuffer.push(` — the file has five `const claim` sites and only this one
 * buffers. If the anchor is ever lost the extractor throws and this suite fails
 * loudly rather than testing nothing.
 */
function extractBufferBranch() {
  let at = -1;
  for (let k = 0; ; ) {
    const i = SERVER_SRC.indexOf('const claim = room.resumable;', k);
    if (i === -1) break;
    if (SERVER_SRC.slice(i, i + 6000).includes('room.frameBuffer.push(')) { at = i; break; }
    k = i + 1;
  }
  if (at === -1) throw new Error('the resume-window buffering branch was not found in server.js');
  const ifAt = SERVER_SRC.indexOf('if (claim', at);
  if (ifAt === -1) throw new Error('buffering branch: `if (claim` not found after the claim binding');
  let depth = 0;
  for (let j = SERVER_SRC.indexOf('{', ifAt); j < SERVER_SRC.length; j++) {
    if (SERVER_SRC[j] === '{') depth++;
    else if (SERVER_SRC[j] === '}' && --depth === 0) {
      return SERVER_SRC.slice(at, j + 1);
    }
  }
  throw new Error('buffering branch: unterminated');
}

const CONSTS = ['FT_FRAME_TYPES', 'BATTERY_MIN_INTERVAL_MS', 'FRAME_BUFFER_MAX'];
const FNS = ['frameType', 'frameLabel', 'isFileFrame', 'isBatteryFrame', 'batteryCountDrop', 'batteryGate'];

/**
 * Instantiate the extracted relay code with injected dependencies. Every caller
 * gets a FRESH instance so one scenario's drop counters cannot leak into the
 * next.
 */
function buildRelay({ clock = null } = {}) {
  const logs = [];
  const body = [
    ...CONSTS.map(extractConst),
    'const batteryDropCounts = new Map();',
    ...FNS.map(extractFn),
    extractFn('forwardDataPlane'),
    // The nameless buffering branch, wrapped in a function of its own. The
    // wrapper supplies only the two bindings the branch reads from its enclosing
    // scope (`room`, `msg`, `token`); everything else it calls is injected or
    // extracted above.
    'function bufferPhoneFrame(room, msg, token) {\n' + extractBufferBranch() + '\n  return "fellthrough";\n}',
    `return { ${[...CONSTS, ...FNS].join(', ')}, forwardDataPlane, bufferPhoneFrame, batteryDropCounts };`,
  ].join('\n\n');

  const sent = [];
  const safeSend = (ws, msg) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.sent.push(String(msg));
    sent.push({ ws, msg: String(msg) });
    return true;
  };
  const factory = new Function(
    'safeSend', 'rlog', 'redactToken', 'Buffer', 'console', 'Date',
    'ftCountDrop', 'logNotifFrame',
    body,
  );
  const api = factory(
    safeSend,
    (m) => logs.push(String(m)),
    () => 'tok:redacted',
    Buffer,
    { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    clock ? clock.Date : Date,
    (token, type, why) => logs.push(`ftDrop ${type}/${why}`),
    () => {},
  );
  api.logs = logs;
  api.safeSend = safeSend;
  return api;
}

/** A monotonic fake clock (subclasses Date so `new Date()` sees it too). */
function fakeClock(startMs = Date.parse('2026-09-22T09:00:00Z')) {
  let t = startMs;
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(t); else super(...args); }
    static now() { return t; }
  }
  return { Date: FakeDate, advance: (ms) => { t += ms; }, at: () => t };
}

const TOKEN = 'ROOMTOKEN';
const mkPhone = (token = TOKEN) => ({ phoneToken: token, readyState: 1, sent: [] });
const mkBrowser = () => ({ readyState: 1, sent: [] });
function mkRoom(phone, browser, extra = {}) {
  return {
    token: TOKEN, lobby: new Set(),
    active: { browser, phone, e2e: null },
    pendingPairing: null, resumable: null, frameBuffer: [], transfer: null,
    ...extra,
  };
}
const BAT = (o) => `BATTERY:${JSON.stringify(o)}`;
const GOOD = { pct: 47, charging: false, ts: 1_758_531_600_000 };
const countOf = (api, reason) => (api.batteryDropCounts.get(TOKEN)?.get(reason) ?? 0);

console.log('\ntests/bat-relay.test.mjs — BAT-2 (a): relay passthrough, origin, relay-mark, rate cap, resume exemption\n');

// ── (0) the extraction itself is real ──────────────────────────────────────
{
  const api = buildRelay();
  check('(0) isBatteryFrame / batteryGate loaded from server.js',
    typeof api.isBatteryFrame === 'function' && typeof api.batteryGate === 'function');
  eq('(0) BATTERY_MIN_INTERVAL_MS is the shipped 10 s', api.BATTERY_MIN_INTERVAL_MS, 10_000);
  check('(0) isBatteryFrame uses the validated classifier, not startsWith',
    api.isBatteryFrame(BAT(GOOD)) === true
    && api.isBatteryFrame('BATTERY_SOMETHING_ELSE:{}') === false
    && api.isBatteryFrame('SMS_RECEIVED:{}') === false);
  // The gate must be reached BEFORE the listener mirror, or a rejected frame
  // would still be delivered to every passive extension SW.
  const gateAt = STRIPPED.indexOf("batteryGate(room, ws, msg, 'phone'");
  const mirrorAt = STRIPPED.indexOf('broadcastToListeners(room, msg);');
  check('(0) the phone-side BATTERY gate runs before broadcastToListeners',
    gateAt > 0 && mirrorAt > 0 && gateAt < mirrorAt, `gate@${gateAt} mirror@${mirrorAt}`);
}

// ── (a) forwarded verbatim, phone -> browser, under mode OFF and mode ON ───
{
  for (const [label, e2e] of [['mode OFF', null], ['mode ON', { mode: 'on', kid: 'k1' }]]) {
    const api = buildRelay();
    const phone = mkPhone(); const browser = mkBrowser();
    const room = mkRoom(phone, browser); room.active.e2e = e2e;
    const frame = BAT(GOOD);
    eq(`(a) ${label}: the gate lets a well-formed BATTERY through`,
      api.batteryGate(room, phone, frame, 'phone', TOKEN), false);
    eq(`(a) ${label}: forwardDataPlane forwards it`,
      api.forwardDataPlane(room, phone, frame), true);
    eq(`(a) ${label}: the browser received it BYTE-FOR-BYTE`, browser.sent.at(-1), frame);
    eq(`(a) ${label}: exactly one frame reached the browser`, browser.sent.length, 1);
    eq(`(a) ${label}: nothing was sent back to the phone`, phone.sent.length, 0);
  }
  // Mode is not a parameter of the forward: the same room, the same function,
  // the same bytes. That is what "plaintext under §13.7" means at the relay.
  check('(a) the relay has no BATTERY-specific seal/mode branch',
    !/requiresSeal|SEALED_[A-Z_]*\b[^\n]*BATTERY/.test(STRIPPED)
    && !/BATTERY[^\n]*(requiresSeal|SEALED_)/.test(STRIPPED));
}

// ── MUST-1 — origin: browser-originated BATTERY is dropped + counted ───────
{
  const api = buildRelay();
  const phone = mkPhone(); const browser = mkBrowser();
  const room = mkRoom(phone, browser);
  eq('(MUST-1) a browser-originated BATTERY is DROPPED',
    api.batteryGate(room, browser, BAT(GOOD), 'browser', TOKEN), true);
  eq('(MUST-1) ...and counted as battery_bad_origin', countOf(api, 'battery_bad_origin'), 1);
  eq('(MUST-1) ...and nothing was forwarded to the phone', phone.sent.length, 0);

  // A phone socket carrying ANOTHER room's token is not this room's paired peer.
  const foreign = mkPhone('SOMEOTHERROOM');
  eq('(MUST-1) a phone socket from another room is DROPPED',
    api.batteryGate(room, foreign, BAT(GOOD), 'phone', TOKEN), true);
  eq('(MUST-1) ...counted as battery_bad_origin (2)', countOf(api, 'battery_bad_origin'), 2);

  // A socket with no phoneToken at all (a lobby browser that reached the phone
  // branch, or an unauthenticated socket) is likewise refused.
  eq('(MUST-1) a socket with no phoneToken is DROPPED',
    api.batteryGate(room, { readyState: 1, sent: [] }, BAT(GOOD), 'phone', TOKEN), true);
  eq('(MUST-1) ...counted as battery_bad_origin (3)', countOf(api, 'battery_bad_origin'), 3);
  eq('(MUST-1) no other counter moved', countOf(api, 'battery_relay_mark') + countOf(api, 'battery_ratelimited'), 0);
  // Source-level: the browser branch gates BATTERY before it can reach the
  // browser->phone forward.
  const bGate = STRIPPED.indexOf("batteryGate(room, ws, msg, 'browser'");
  const bFwd = STRIPPED.indexOf('forwardDataPlane(room, ws, forwardMsg)');
  check('(MUST-1) the browser branch gates BATTERY before the browser->phone forward',
    bGate > 0 && bFwd > 0 && bGate < bFwd, `gate@${bGate} forward@${bFwd}`);
}

// ── MUST-2 — a top-level `relay` key is REJECTED, never stripped ───────────
{
  const api = buildRelay();
  const phone = mkPhone(); const browser = mkBrowser();
  const room = mkRoom(phone, browser);
  for (const mark of [true, false, null, 0, 'x', {}]) {
    const frame = BAT({ ...GOOD, relay: mark });
    eq(`(MUST-2) relay:${JSON.stringify(mark)} is REJECTED`,
      api.batteryGate(room, phone, frame, 'phone', TOKEN), true);
  }
  eq('(MUST-2) each rejection is counted as battery_relay_mark', countOf(api, 'battery_relay_mark'), 6);
  eq('(MUST-2) nothing reached the browser', browser.sent.length, 0);

  // NEVER STRIPPED. The gate mutates nothing, and the forward path only ever
  // carries the original string — so there is no code path on which a marked
  // frame becomes an unmarked one. Proven by re-reading the frame after the
  // gate ran, and by the gate's own return type (a boolean, not a frame).
  const marked = BAT({ ...GOOD, relay: true });
  const before = marked;
  api.batteryGate(room, phone, marked, 'phone', TOKEN);
  eq('(MUST-2) the frame string is unchanged (rejected, not rewritten)', marked, before);
  check('(MUST-2) batteryGate returns a verdict, never a frame',
    typeof api.batteryGate(room, phone, BAT(GOOD), 'phone', TOKEN) === 'boolean');
  check('(MUST-2) the relay never authors a BATTERY frame',
    !/safeSend\([^)]*`BATTERY:/.test(STRIPPED) && !/['"`]BATTERY:\$\{/.test(STRIPPED));

  // An inherited `relay` is not a marked frame — the guard is hasOwnProperty.
  check('(MUST-2) the guard is hasOwnProperty, not `in`',
    /hasOwnProperty\.call\(payload, 'relay'\)/.test(STRIPPED));
}

// ── MUST-3 — shape validation ──────────────────────────────────────────────
{
  const api = buildRelay();
  const phone = mkPhone(); const room = mkRoom(phone, mkBrowser());
  const bad = [
    ['pct not an integer', { ...GOOD, pct: 47.5 }],
    ['pct below 0', { ...GOOD, pct: -1 }],
    ['pct above 100', { ...GOOD, pct: 101 }],
    ['pct a numeric string', { ...GOOD, pct: '47' }],
    ['pct missing', { charging: false, ts: GOOD.ts }],
    ['charging truthy but not a boolean', { ...GOOD, charging: 1 }],
    ['charging a string', { ...GOOD, charging: 'true' }],
    ['charging missing', { pct: 47, ts: GOOD.ts }],
    ['ts a string', { ...GOOD, ts: String(GOOD.ts) }],
    ['ts NaN', { ...GOOD, ts: NaN }],
    ['ts missing', { pct: 47, charging: false }],
  ];
  let n = 0;
  for (const [label, payload] of bad) {
    n++;
    eq(`(MUST-3) ${label} -> dropped`, api.batteryGate(room, phone, BAT(payload), 'phone', TOKEN), true);
  }
  // Non-object and unparseable payloads.
  for (const [label, frame] of [
    ['malformed JSON', 'BATTERY:{not json'],
    ['a JSON array', 'BATTERY:[47,false,1]'],
    ['a bare number', 'BATTERY:47'],
    ['null', 'BATTERY:null'],
    ['an empty payload', 'BATTERY:'],
  ]) {
    n++;
    eq(`(MUST-3) ${label} -> dropped`, api.batteryGate(room, phone, frame, 'phone', TOKEN), true);
  }
  eq('(MUST-3) every malformed frame counted as battery_bad_shape', countOf(api, 'battery_bad_shape'), n);

  // Forward compatibility: an UNKNOWN extra key is tolerated and forwarded.
  // A forwarder that rejects on unknown fields freezes the wire against its own
  // future; `relay` is the one named exception and is covered above.
  const api2 = buildRelay();
  const room2 = mkRoom(mkPhone(), mkBrowser());
  eq('(MUST-3) an unknown extra key is tolerated',
    api2.batteryGate(room2, room2.active.phone, BAT({ ...GOOD, temp: 31 }), 'phone', TOKEN), false);
  eq('(MUST-3) pct 0 is valid', api2.batteryGate(mkRoom(mkPhone(), mkBrowser()), mkPhone(), BAT({ ...GOOD, pct: 0 }), 'phone', TOKEN), false);
  eq('(MUST-3) pct 100 is valid', api2.batteryGate(mkRoom(mkPhone(), mkBrowser()), mkPhone(), BAT({ ...GOOD, pct: 100 }), 'phone', TOKEN), false);
}

// ── rate cap: > 1 BATTERY / 10 s from the phone -> drop + count ────────────
{
  const clock = fakeClock();
  const api = buildRelay({ clock });
  const phone = mkPhone(); const browser = mkBrowser();
  const room = mkRoom(phone, browser);

  eq('(cap) the first frame passes', api.batteryGate(room, phone, BAT(GOOD), 'phone', TOKEN), false);
  clock.advance(1_000);
  eq('(cap) a second frame 1 s later is DROPPED', api.batteryGate(room, phone, BAT(GOOD), 'phone', TOKEN), true);
  eq('(cap) ...counted as battery_ratelimited', countOf(api, 'battery_ratelimited'), 1);
  clock.advance(8_999); // t = 9.999 s
  eq('(cap) still dropped at 9.999 s', api.batteryGate(room, phone, BAT(GOOD), 'phone', TOKEN), true);
  eq('(cap) counter = 2', countOf(api, 'battery_ratelimited'), 2);
  clock.advance(1); // t = 10.000 s — the boundary is inclusive-pass
  eq('(cap) passes again at exactly 10 s', api.batteryGate(room, phone, BAT(GOOD), 'phone', TOKEN), false);
  eq('(cap) counter did not move on the pass', countOf(api, 'battery_ratelimited'), 2);

  // NEVER a frame back to the phone. A rate-limited phone learns nothing from
  // the relay; the cap is a defensive drop, not a protocol.
  eq('(cap) nothing was ever sent to the phone', phone.sent.length, 0);
  eq('(cap) the drop is log-only (no browser traffic either)', browser.sent.length, 0);

  // The budget is per ROOM, not per socket: a phone that reconnects with a
  // fresh socket inside the window does not get a fresh budget.
  clock.advance(1_000);
  const phone2 = mkPhone();
  eq('(cap) a reconnected phone socket inherits the room budget',
    api.batteryGate(room, phone2, BAT(GOOD), 'phone', TOKEN), true);
  eq('(cap) counter = 3', countOf(api, 'battery_ratelimited'), 3);

  // A REJECTED frame must not consume the budget slot — otherwise one malformed
  // frame would suppress the next ten seconds of good ones.
  const api3 = buildRelay({ clock });
  const room3 = mkRoom(mkPhone(), mkBrowser());
  api3.batteryGate(room3, room3.active.phone, BAT({ ...GOOD, pct: 999 }), 'phone', TOKEN);
  eq('(cap) a malformed frame does not consume the rate-cap slot',
    api3.batteryGate(room3, room3.active.phone, BAT(GOOD), 'phone', TOKEN), false);
}

// ── resume buffer: BATTERY is EXEMPT (MUST-3 / PLAN.md (b)) ────────────────
{
  const clock = fakeClock();
  const api = buildRelay({ clock });
  const room = mkRoom(null, null);
  room.resumable = { droppedRole: 'browser', droppedAt: clock.at(), expiresAt: clock.at() + 30_000 };

  // Control first: a normal phone data frame in the same window IS buffered.
  // Without this cell a broken extractor (a block that early-returns before it
  // can buffer anything) would make the exemption assertion pass for free.
  api.bufferPhoneFrame(room, 'SMS_RECEIVED:{"id":1}', TOKEN);
  eq('(resume) control: a normal phone frame IS buffered', room.frameBuffer.length, 1);

  api.bufferPhoneFrame(room, BAT(GOOD), TOKEN);
  eq('(resume) BATTERY is NOT buffered', room.frameBuffer.length, 1);
  eq('(resume) ...and the buffer still holds only the control frame',
    room.frameBuffer[0].msg, 'SMS_RECEIVED:{"id":1}');
  eq('(resume) the exemption is counted as battery_not_buffered',
    countOf(api, 'battery_not_buffered'), 1);

  // Repeated BATTERY frames during a long resume window never accumulate.
  for (let i = 0; i < 25; i++) api.bufferPhoneFrame(room, BAT({ ...GOOD, pct: i }), TOKEN);
  eq('(resume) 25 more BATTERY frames added nothing to the buffer', room.frameBuffer.length, 1);
  eq('(resume) ...all counted', countOf(api, 'battery_not_buffered'), 26);

  // The FILE_* exemption it sits beside must still work — this suite's block
  // extraction covers both, so a slice that lost one would be caught here.
  api.bufferPhoneFrame(room, 'FILE_CHUNK:{"id":"abc","seq":1}', TOKEN);
  eq('(resume) the FILE_* exemption still holds', room.frameBuffer.length, 1);
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\nbat-relay: ${pass}/${pass + fail} checks passed`);
if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
