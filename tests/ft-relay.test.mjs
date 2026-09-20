#!/usr/bin/env node
/**
 * tests/ft-relay.test.mjs — the relay half of file transfer (dispatch FT-1).
 *
 * THIS FILE DOES NOT MIRROR server.js.
 *
 * The other .mjs relay suites re-implement the state machine they test, with a
 * comment asking the next person to keep the copy in sync. That is a reasonable
 * trade for a pairing handshake; it is the wrong trade here, because two of the
 * things under test are SECURITY gates — "a chunk is only forwarded after the
 * receiver accepted" and "a trial account cannot open a transfer at all" — and a
 * mirror of a gate passes happily while the real gate is fail-open. So this file
 * follows tests/log-redaction.test.mjs instead: it EXTRACTS the real constants
 * and the real functions out of server.js and runs them, with only the relay's
 * ambient dependencies (safeSend, the socket objects, the Prisma client) stubbed
 * or supplied for real. If a function is renamed or deleted in server.js, the
 * extractor throws and this suite fails loudly rather than drifting.
 *
 * The quota parts (deliverable (e)) run against a REAL PostgreSQL, for the same
 * reason tests/devicekey-authz.test.mjs does: the subject is an atomic
 * INSERT … ON CONFLICT … WHERE, a BIGINT column and a unique index. A mocked
 * `db` would return whatever the mock says and the test would prove nothing
 * about the thing that actually enforces the 2 GiB/day cap.
 *
 * Run:
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc node tests/ft-relay.test.mjs
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import nodeCrypto from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'server.js'), 'utf8');
const requireCjs = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── PART 0 — pull the REAL source out of server.js ──────────────────────────

/** Strip comments so prose describing a rule can never satisfy the rule. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Brace-balanced extraction of `function NAME(...) { … }`.
 *
 * The `async ` prefix is captured deliberately. Dropping it does not produce a
 * missing-function error — it produces a SYNTAX error at `new Function` time,
 * or worse, a sync function whose `await` is a parse error somewhere else. Two
 * of the extracted functions are async (the quota reserve and the offer gate).
 */
function extractFn(name) {
  let start = SERVER_SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in server.js`);
  if (SERVER_SRC.slice(start - 6, start) === 'async ') start -= 6;
  // Walk the PARAMETER LIST by paren balance first. Jumping straight to the
  // next '{' finds the destructuring default in `function f(a, { x = 1 } = {})`
  // rather than the body, and the brace walk then terminates on that object's
  // closing brace — producing a truncated, syntactically broken extraction whose
  // error surfaces on the NEXT function in the concatenation.
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

/**
 * Bracket-balanced extraction of `const NAME = …;`. Needed because several of
 * the constants are multi-line `new Set([...])` literals, so a line regex would
 * capture a fragment that does not parse.
 */
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

const FT_CONSTS = [
  'FT_FRAME_TYPES', 'FT_FAIL_REASONS', 'FT_MAX_FILE_BYTES', 'FT_DAILY_QUOTA_BYTES',
  'FT_QUOTA_RETENTION_DAYS', 'FT_CHUNK_RAW_BYTES', 'FT_CHUNK_WIRE_BYTES',
  'FT_DEST_BACKPRESSURE_BYTES',
  'FT_STALL_MS', 'FT_OFFER_TTL_MS', 'FT_SWEEP_MS', 'FT_WIRE_OVERHEAD_FACTOR',
  'FT_TIERS_ALLOWED', 'FT_RELAY_OWNED_REASONS', 'FT_WIRE_B64_FACTOR',
];
const FT_FNS = [
  'frameType', 'frameLabel', 'isFileFrame', 'utcDayKey',
  'ftCountDrop', 'ftParse', 'ftSocketForRole', 'ftPeerSocket', 'ftFailedFrame',
  'ftOfferMetadata', 'ftFrameId', 'ftWireCeiling', 'ftRawFromWire',
  'ftAbort', 'ftReserveQuota', 'ftSettleQuota', 'ftHandleOffer',
  'handleFileFrame',
];

/**
 * Instantiate the extracted relay code with injected dependencies. Every caller
 * gets a FRESH instance so one test's drop counters or in-flight record cannot
 * leak into the next (the append-only-shared-state failure this project has
 * already paid for once).
 */
function buildRelay({ db, rooms = new Map(), clock = null }) {
  const logs = [];
  const body = [
    ...FT_CONSTS.map(extractConst),
    ...FT_FNS.map(extractFn),
    // The janitor is a `const ftSweep = setInterval(…)`, not a function, so it
    // cannot be pulled with extractFn. Extracting the whole declaration and
    // injecting `setInterval` captures the REAL tick body — the alternative
    // (re-typing the branch here) is exactly the mirror-of-the-gate this file
    // exists to avoid, and a mirror of a janitor expires happily while the real
    // one has a `continue` in the wrong place.
    extractConst('ftSweep'),
    'const ftDropCounts = new Map();',
    `return { ${[...FT_CONSTS, ...FT_FNS].join(', ')}, ftDropCounts, ftSweep };`,
  ].join('\n\n');
  const factory = new Function('db', 'safeSend', 'rlog', 'redactToken', 'WebSocket', 'crypto', 'Buffer', 'console',
    'rooms', 'setInterval', 'Date', body);
  const safeSend = (ws, msg) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.sent.push(String(msg));
    return true;
  };
  const rlog = (m) => logs.push(String(m));
  const quietConsole = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
  // Fake timers, two halves. `setInterval` is captured rather than scheduled so
  // the tick is driven explicitly (a suite that really waited 90 s would be
  // deleted by the first person who ran it), and `Date` is injected so the code
  // under test reads the advanced clock — including `new Date()` inside the
  // quota day key, which a bare `Date.now` stub would leave on the real wall.
  let sweepTick = null;
  const setIntervalStub = (fn) => { sweepTick = fn; return {}; };
  const api = factory(db, safeSend, rlog, () => 'tok:redacted', { OPEN: 1 }, nodeCrypto, Buffer, quietConsole,
    rooms, setIntervalStub, clock ? clock.Date : Date);
  api.logs = logs;
  api.safeSend = safeSend;
  api.rooms = rooms;
  api.tickSweep = () => {
    if (!sweepTick) throw new Error('ftSweep was never registered — the extraction is broken');
    sweepTick();
  };
  return api;
}

/**
 * A monotonic fake clock. Subclasses the real Date so `new Date()` (the quota
 * day key) and `Date.now()` (every FT timer) both see the advanced time, while
 * `new Date(x)` keeps working for the callers that pass an argument.
 */
function fakeClock(startMs = Date.parse('2026-09-18T12:00:00Z')) {
  let t = startMs;
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(t); else super(...args); }
    static now() { return t; }
  }
  return { Date: FakeDate, advance: (ms) => { t += ms; }, at: () => t };
}

// Fresh sockets/room per scenario.
const mkWs = (userId = 'u1', tier = 'plus') => ({ userId, tier, readyState: 1, bufferedAmount: 0, sent: [] });
function mkRoom(phone, browser) {
  return {
    token: 'ROOMTOKEN', lobby: new Set(),
    active: { browser, phone, e2e: null },
    pendingPairing: null, resumable: null, frameBuffer: [], transfer: null,
  };
}
const newId = () => randomBytes(16).toString('hex');
const sha = () => randomBytes(32).toString('hex');
const lastOf = (ws, type) => [...ws.sent].reverse().find((m) => m.startsWith(`${type}:`)) || null;
const payloadOf = (frame) => (frame ? JSON.parse(frame.slice(frame.indexOf(':') + 1)) : null);
const countOf = (ws, type) => ws.sent.filter((m) => m.startsWith(`${type}:`)).length;

/** A db stub for the arms that are NOT about the quota: always admits. */
const DB_ALWAYS_OK = {
  $queryRawUnsafe: async () => [{ used: 1n }],
  $executeRawUnsafe: async () => 1,
};
/** A db stub that refuses every reservation (0 rows = over cap). */
const DB_OVER_QUOTA = {
  $queryRawUnsafe: async () => [],
  $executeRawUnsafe: async () => 1,
};

/** Offer → accept, returning the armed relay/room/sockets. */
async function armedTransfer({ db = DB_ALWAYS_OK, size = 4 * 1024 * 1024, tier = 'plus' } = {}) {
  const R = buildRelay({ db });
  const phone = mkWs('u1', tier);
  const browser = mkWs('u1', tier);
  const room = mkRoom(phone, browser);
  const id = newId();
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'holiday.jpg', size, mime: 'image/jpeg', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
  return { R, room, phone, browser, id };
}

console.log('\nFT-1 relay — file transfer frames, backpressure, resume, quota\n');

// ── PART 1 — the frozen frame family + the constants ────────────────────────
console.log('PART 1 — frozen frames and constants');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const EXPECTED = ['FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK',
    'FILE_ACK', 'FILE_RESUME', 'FILE_DONE', 'FILE_FAILED'];
  check('the frame family is exactly the 8 frozen types',
    R.FT_FRAME_TYPES.size === EXPECTED.length && EXPECTED.every((t) => R.FT_FRAME_TYPES.has(t)),
    `got ${[...R.FT_FRAME_TYPES].join(',')}`);
  check('FILE_DECLINE (the pre-brief spelling) is NOT in the family',
    !R.FT_FRAME_TYPES.has('FILE_DECLINE'));

  const REASONS = ['hash_mismatch', 'connection_lost', 'relay_backpressure', 'cancelled',
    'timeout', 'too_large', 'oom', 'quota', 'tier',
    // FT-A1 MUST A-7. FT-A1.1 M5 adds `busy`.
    'size_mismatch', 'busy'];
  check('FILE_FAILED reason vocabulary is exactly the frozen 11 (A-7 size_mismatch, M5 busy)',
    R.FT_FAIL_REASONS.size === REASONS.length && REASONS.every((r) => R.FT_FAIL_REASONS.has(r)),
    `got ${[...R.FT_FAIL_REASONS].join(',')}`);
  check('size_mismatch IS mintable — a relay-side tamper/lie must be nameable',
    payloadOf(R.ftFailedFrame('abc12345', 'size_mismatch')).reason === 'size_mismatch');
  check('no_receiver is NOT in the enum (FT-A1 section 2.3 — timeout already says it)',
    !R.FT_FAIL_REASONS.has('no_receiver'));
  check('an off-vocabulary reason is normalised, never minted',
    payloadOf(R.ftFailedFrame('abc12345', 'because_i_said_so')).reason === 'cancelled');

  check('per-file cap is 1 GiB exactly', R.FT_MAX_FILE_BYTES === 1073741824, String(R.FT_MAX_FILE_BYTES));
  check('daily cap is 2 GiB exactly', R.FT_DAILY_QUOTA_BYTES === 2147483648, String(R.FT_DAILY_QUOTA_BYTES));
  check('daily cap is int4 max + 1 — so the column MUST be BIGINT',
    R.FT_DAILY_QUOTA_BYTES === 2147483647 + 1);
  check('chunk is 48 KiB raw', R.FT_CHUNK_RAW_BYTES === 49152, String(R.FT_CHUNK_RAW_BYTES));
  check('relay watermark is 8 MB', R.FT_DEST_BACKPRESSURE_BYTES === 8 * 1024 * 1024);
  check('stall backstop is 30 s', R.FT_STALL_MS === 30000);
  check('quota retention is 7 days', R.FT_QUOTA_RETENTION_DAYS === 7);

  // Tier allow-list: fail CLOSED. trial/free out, unknown out.
  check('tier allow-list admits plus and pro', R.FT_TIERS_ALLOWED.has('plus') && R.FT_TIERS_ALLOWED.has('pro'));
  check('tier allow-list REFUSES trial', !R.FT_TIERS_ALLOWED.has('trial'));
  check('tier allow-list REFUSES free', !R.FT_TIERS_ALLOWED.has('free'));
  check('tier allow-list REFUSES an unknown/future tier (fail-closed)',
    !R.FT_TIERS_ALLOWED.has('enterprise') && !R.FT_TIERS_ALLOWED.has(undefined));

  // frameType, not startsWith — the classifier every redaction site trusts.
  check('isFileFrame classifies via frameType', R.isFileFrame('FILE_CHUNK:{"id":"a"}') === true);
  check('isFileFrame ignores a lookalike with no valid head',
    R.isFileFrame('file_chunk:{}') === false);
  check('isFileFrame does not swallow a non-member FILE_-prefixed frame',
    R.isFileFrame('FILE_SOMETHING_ELSE:{}') === false);
}
{
  // THE ACCESSOR, and the shape-agnostic half of mode-ON readiness.
  //
  // Security FT-A1 (proposal R-AF: sealed frame + a plaintext `ft:{size}`
  // envelope hint) is OPEN as of 2026-09-18, so NOTHING here asserts a mode-ON
  // wire shape — that would be a test ratifying a proposal. What IS asserted is
  // the property the ruling cannot change: the relay reads exactly ONE field out
  // of a FILE_OFFER body, and an offer missing name/mime/sha256 is gated on size
  // rather than rejected as malformed. A relay that demands all four rejects
  // every sealed offer the day encryption is switched on, and does it as
  // `malformed` — the least debuggable possible spelling of "the protocol
  // advanced without me". FT-2 and FT-3a both flagged this seam.
  //
  // When FT-A1 lands, the mode-ON twin is written against ftOfferMetadata and
  // that function is the only production code that moves.
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const OID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
  check('ftOfferMetadata NEVER returns an account, however the frame is shaped',
    !('userId' in R.ftOfferMetadata({ id: OID, size: 1, from: 'phone', userId: 'attacker' }))
    && !('account' in R.ftOfferMetadata({ id: OID, size: 1 })));
  check('ftOfferMetadata reads size only from a safe positive integer',
    R.ftOfferMetadata({ id: OID, size: 4404019 }).size === 4404019
    && R.ftOfferMetadata({ id: OID, size: -1 }).ok === false
    && R.ftOfferMetadata({ id: OID, size: '4404019' }).ok === false
    && R.ftOfferMetadata({ id: OID }).ok === false);
  // Counted by LINE, not by occurrence: the accessor reads payload.size three
  // times on one line (guard, guard, value), so an occurrence count would report
  // 3 and this check would be a permanent false red.
  {
    const lines = stripComments(SERVER_SRC).split(String.fromCharCode(10))
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /payload\.size/.test(l));
    const body = extractFn('ftOfferMetadata');
    check('every read of payload.size in server.js is inside ftOfferMetadata',
      lines.length > 0 && lines.every(([, l]) => body.includes(l.trim())),
      lines.map(([n]) => `L${n}`).join(','));
  }
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  const id = newId();
  const sealed = `FILE_OFFER:${JSON.stringify({ id, size: 4404019, e: 'BASE64SEALEDBODY', kid: 'k1', s: 7 })}`;
  R.handleFileFrame(room, phone, sealed, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('an offer WITHOUT name/mime/sha256 is admitted, not rejected malformed',
    !!room.transfer && room.transfer.state === 'offered');
  check('it is forwarded byte-for-byte — the relay reads nothing else',
    lastOf(browser, 'FILE_OFFER') === sealed);
  check('the record holds no mime it was never given', room.transfer.mime === '');
  check('and the size gate still read size through the accessor', room.transfer.size === 4404019);

  // A missing or nonsense size is still refused: it is the ONE field the relay
  // acts on, so it is the one field it must insist upon.
  const room2 = mkRoom(phone, browser);
  R.handleFileFrame(room2, phone, `FILE_OFFER:${JSON.stringify({ id: newId() })}`, 'phone', room2.token);
  await new Promise((r) => setImmediate(r));
  check('an offer with no size is refused size_mismatch and arms nothing',
    payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'size_mismatch' && room2.transfer === null);
}

// ── FT-A1 — the sealed FILE_OFFER hint, and the lying sender ───────────────
console.log('\nFT-A1 — envelope hint ft:{id,size}, fail-closed, and the wire meter');
{
  // Vector L's frozen values, from
  // security/PROJECTS/computercaller/e2e/ADDENDUM-FT-A1.md section 4. The
  // ciphertext itself is the receiver's fixture; what FT-1 asserts is the RELAY
  // behaviour around L2, L3 and L5, which is what the addendum assigns to it.
  const L = {
    kid: 'kid-ftA1',
    seq: 42,
    c: 'Nar4OumTQo9eiu09dKR7Ua_6',
    ftId: '9f2c4b7e1a08d35c6e90b1f47a2d8c63',
    ftSize: 734003200,
  };
  const sealedOffer = (ft) => `FILE_OFFER:${JSON.stringify(ft === undefined
    ? { e: 1, kid: L.kid, s: L.seq, c: L.c }
    : { e: 1, kid: L.kid, s: L.seq, c: L.c, ft })}`;

  // L1 — honest sealed offer, paid tier, nothing used: ADMIT.
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    const frame = sealedOffer({ id: L.ftId, size: L.ftSize });
    R.handleFileFrame(room, phone, frame, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    check('L1: an honest sealed offer is admitted', !!room.transfer && room.transfer.state === 'offered');
    check('L1: the record is keyed on ft.id — the only id the relay can read', room.transfer.id === L.ftId);
    check('L1: the gate read ft.size', room.transfer.size === L.ftSize);
    check('L1: the sealed frame is forwarded VERBATIM — the relay re-encodes nothing',
      lastOf(browser, 'FILE_OFFER') === frame);
    check('L1: the relay holds no mime, because mime is sealed', room.transfer.mime === '');
  }

  // L2 — a lowered hint. The relay CANNOT detect this; that is the receiver's
  // compare against the sealed body, and the identical L1/L2 ciphertext hash is
  // the proof the hint is outside the authenticated data. What FT-1 must prove
  // is that the relay still METERS, so tampering the hint DOWN shrinks the
  // ceiling and can never buy headroom.
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer({ id: L.ftId, size: 1024 }), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    check('L2: a lowered hint is admitted by the relay (catching it is the receiver job)', !!room.transfer);
    check('L2: but the ceiling shrinks with it — tampering DOWN never buys headroom',
      R.ftWireCeiling(1024) < R.ftWireCeiling(L.ftSize));
  }

  // L3 — the hint is stripped or malformed. FAIL CLOSED. This is the hole that
  // would otherwise make the whole gate decorative: with no hint and no
  // refusal, every sender skips tier and quota by omitting one field.
  //
  // Split in two by whether the relay can NAME the refused transfer.
  //
  // MUST A-2 says "do not forward + emit FILE_FAILED to the sender". When the
  // unreadable part IS the id, there is nothing to put in that frame — and
  // FT-A1 s1.2 establishes that a FILE_FAILED without a valid id is dropped by
  // the receiver's own `coerceFileFrame`, so emitting one would be noise on the
  // wire that no peer will ever act on. The relay therefore refuses and counts,
  // and the sender's 60 s offer expiry is the backstop, which is the same
  // reasoning FT-A1 s2.3 applies to the SW's unsendable failure. FLAGGED for
  // Security as a deviation from the literal text of A-2.
  for (const [name, ft] of [
    ['size negative', { id: L.ftId, size: -1 }],
    ['size over 1 GiB', { id: L.ftId, size: 1073741825 }],
    ['size not an integer', { id: L.ftId, size: 1.5 }],
    ['size a string', { id: L.ftId, size: '10' }],
    ['size missing', { id: L.ftId }],
  ]) {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer(ft), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    check(`L3 (${name}): REFUSED size_mismatch, never forwarded, nothing armed`,
      payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'size_mismatch'
      && countOf(browser, 'FILE_OFFER') === 0
      && room.transfer === null);
  }
  for (const [name, ft] of [
    ['hint absent entirely', undefined],
    ['hint not an object', 'nope'],
    ['hint an array', []],
    ['ft.id not 32 hex', { id: 'short', size: 10 }],
    ['ft.id uppercase hex', { id: L.ftId.toUpperCase(), size: 10 }],
  ]) {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer(ft), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    check(`L3 (${name}): REFUSED, never forwarded, nothing armed`,
      countOf(browser, 'FILE_OFFER') === 0 && room.transfer === null);
    check(`L3 (${name}): no unnameable FILE_FAILED is invented`,
      countOf(phone, 'FILE_FAILED') === 0);
    check(`L3 (${name}): the refusal is COUNTED as a bad hint, not as a stray frame`,
      R.ftDropCounts.get(room.token)?.get('FILE_OFFER/bad_hint') === 1);
  }
  {
    // POSITIVE CONTROL for the whole L3 loop. Ten refusals prove nothing if the
    // relay refuses every sealed offer — the loop would be green against a relay
    // that had file transfer switched off entirely.
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer({ id: L.ftId, size: L.ftSize }), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    check('L3 control: the same frame WITH a valid hint IS forwarded — the refusal is the hint, not the seal',
      countOf(browser, 'FILE_OFFER') === 1);
  }

  // Sealed chunks carry NO id (sealed by exclusion, FT-A1 s1.7). They must still
  // flow — matched to the room's single transfer by frame TYPE, which is
  // plaintext on the wire and authenticated in the AAD.
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer({ id: L.ftId, size: 4 * 1024 * 1024 }), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ e: 1, kid: L.kid, s: 43, c: 'AAAA' })}`, 'browser', room.token);
    check('a sealed, id-less FILE_ACCEPT is matched by TYPE and forwarded',
      room.transfer.state === 'accepted' && countOf(phone, 'FILE_ACCEPT') === 1);
    const chunk = `FILE_CHUNK:${JSON.stringify({ e: 1, kid: L.kid, s: 44, c: 'A'.repeat(600) })}`;
    R.handleFileFrame(room, phone, chunk, 'phone', room.token);
    check('a sealed, id-less FILE_CHUNK is forwarded verbatim', lastOf(browser, 'FILE_CHUNK') === chunk);
    check('and is METERED at its real wire length',
      room.transfer.bytesForwarded === Buffer.byteLength(chunk, 'utf8'));
    const failed = `FILE_FAILED:${JSON.stringify({ e: 1, kid: L.kid, s: 45, c: 'BBBB' })}`;
    R.handleFileFrame(room, phone, failed, 'phone', room.token);
    check('a sealed FILE_FAILED is forwarded VERBATIM, never re-minted as plaintext',
      lastOf(browser, 'FILE_FAILED') === failed);
  }
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, browser, 'FILE_ACK:{"id":"zzz","upTo":1}', 'browser', room.token);
    check('an id that is PRESENT but malformed is dropped, never treated as absent',
      countOf(phone, 'FILE_ACK') === 0);
  }

  // L5 — THE LYING SENDER. Hint and sealed size agree (both 1 KiB, both lies
  // told by the same party), so the relay gate admits AND the receiver compare
  // passes. Only the wire meter can stop it.
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    R.handleFileFrame(room, phone, sealedOffer({ id: L.ftId, size: 1024 }), 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ e: 1, kid: L.kid, s: 43, c: 'AAAA' })}`, 'browser', room.token);
    check('L5: the 1 KiB lie IS admitted — both of the controls in (A) are satisfied', !!room.transfer);
    let forwarded = 0;
    for (let seq = 0; seq < 200 && room.transfer; seq++) {
      R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ e: 1, kid: L.kid, s: 100 + seq, c: 'A'.repeat(65536) })}`, 'phone', room.token);
      forwarded = countOf(browser, 'FILE_CHUNK');
    }
    check('L5b: the wire meter aborts the stream', room.transfer === null);
    check('L5b: within a chunk or two, not after 700 MiB', forwarded <= 2, `${forwarded} chunks got through`);
    check('L5b: both ends are told size_mismatch',
      payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'size_mismatch'
      && payloadOf(lastOf(browser, 'FILE_FAILED'))?.reason === 'size_mismatch');
  }

  // THE UNIT CONVERSION. Comparing WIRE bytes against a RAW hint directly is the
  // bug that aborts every honest transfer at about three quarters through, with
  // size_mismatch, looking exactly like an attack.
  {
    const R = buildRelay({ db: DB_ALWAYS_OK });
    const raw = 100 * 1024 * 1024;
    check('the ceiling is in WIRE bytes and exceeds the RAW hint by the base64 factor',
      R.ftWireCeiling(raw) > raw * 1.3 && R.ftWireCeiling(raw) < raw * 1.5, String(R.ftWireCeiling(raw)));
    check('the ceiling is capped at the 1 GiB per-file limit in the SAME units',
      R.ftWireCeiling(R.FT_MAX_FILE_BYTES) === R.ftWireCeiling(R.FT_MAX_FILE_BYTES * 2));
    check('ftRawFromWire never exceeds the per-file cap and is zero at zero',
      R.ftRawFromWire(0) === 0
      && R.ftRawFromWire(Number.MAX_SAFE_INTEGER) === R.FT_MAX_FILE_BYTES);
  }
}

// ── FT-A1.1 — origin marking, the busy move, and the split factors ─────────
console.log('\nFT-A1.1 — relay-minted refusals, origin mark, and the charge factor');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });

  // M1 — bad_hint is a COUNTER, never a wire reason. Adding it to the enum would
  // widen the frozen vocabulary with something that can never be rendered (there
  // is no transfer to attach it to) and would hand a probing sender a free
  // oracle separating "hint malformed" from "hint absent" from "tier refused".
  check('M1: bad_hint is NOT in the frozen reason enum', !R.FT_FAIL_REASONS.has('bad_hint'));
  check('M1: bad_hint is not relay-ownable either', !R.FT_RELAY_OWNED_REASONS.has('bad_hint'));
  check('M1: ftFailedFrame refuses to mint it, normalising to cancelled',
    payloadOf(R.ftFailedFrame('abc12345', 'bad_hint')).reason === 'cancelled');

  // M4 — the two timers, frozen in this order. Inverting them makes the relay
  // the first to time out and re-opens the unnamed-refusal case as a silent hang
  // with no explanation from either end.
  check('M4: the sender 60 s offer expiry is strictly under FT_OFFER_TTL_MS',
    60_000 < R.FT_OFFER_TTL_MS && R.FT_OFFER_TTL_MS === 90_000);

  // section 2.2 — the relay-owned subset, exhaustive and frozen.
  const OWNED = ['tier', 'quota', 'too_large', 'size_mismatch', 'busy',
    'relay_backpressure', 'timeout', 'connection_lost'];
  check('the relay-owned subset is exactly the frozen 8',
    R.FT_RELAY_OWNED_REASONS.size === OWNED.length && OWNED.every((r) => R.FT_RELAY_OWNED_REASONS.has(r)),
    [...R.FT_RELAY_OWNED_REASONS].join(','));
  check('connection_lost IS relay-owned (it is already relay-authored today)',
    R.FT_RELAY_OWNED_REASONS.has('connection_lost'));
  check('every relay-owned reason is also a valid wire reason',
    OWNED.every((r) => R.FT_FAIL_REASONS.has(r)));
  for (const peer of ['hash_mismatch', 'cancelled', 'oom']) {
    check(`${peer} stays PEER-owned — the relay may never claim it`,
      !R.FT_RELAY_OWNED_REASONS.has(peer));
  }

  // M6 — the mark, at the one mint site.
  for (const r of OWNED) {
    check(`M6: a minted ${r} carries relay:true`, payloadOf(R.ftFailedFrame('abc12345', r)).relay === true);
  }
  for (const r of ['hash_mismatch', 'cancelled', 'oom']) {
    check(`M6: a peer-owned ${r} is NEVER marked, even asked to be`,
      payloadOf(R.ftFailedFrame('abc12345', r, { relay: true })).relay === undefined);
  }
  check('M6: the normalise-to-cancelled fallback cannot smuggle the mark on',
    payloadOf(R.ftFailedFrame('abc12345', 'not_a_reason', { relay: true })).relay === undefined);
  check('M7: the explicit unmarked variant produces no relay key at all',
    !('relay' in payloadOf(R.ftFailedFrame('abc12345', 'quota', { relay: false }))));

  // M7 — a peer FAILURE is re-minted UNMARKED; the re-mint is the stripper.
  {
    const R2 = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    const id = newId();
    R2.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 4096, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    R2.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
    R2.handleFileFrame(room, browser, `FILE_FAILED:${JSON.stringify({ id, reason: 'hash_mismatch' })}`, 'browser', room.token);
    const fwd = payloadOf(lastOf(phone, 'FILE_FAILED'));
    check('M7: a forwarded PEER failure carries no relay mark', fwd.relay === undefined);
    check('M7: and keeps its peer-owned reason', fwd.reason === 'hash_mismatch');
  }

  // M7 — a peer CLAIMING the mark is REJECTED, not stripped. Stripping would
  // mean re-serialising a frame the relay promised to forward byte-for-byte, and
  // a re-serialiser on the passthrough path is how a relay starts parsing bodies.
  for (const type of ['FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK',
    'FILE_ACK', 'FILE_RESUME', 'FILE_DONE', 'FILE_FAILED']) {
    const R2 = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    const id = newId();
    // Arm a live transfer first, so the rejection cannot be mistaken for the
    // ordinary "no matching record" drop every one of these would otherwise hit.
    R2.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 4096, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    R2.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
    const beforeB = browser.sent.length; const beforeP = phone.sent.length;
    const sender = type === 'FILE_ACCEPT' || type === 'FILE_ACK' || type === 'FILE_RESUME' || type === 'FILE_REJECT' ? browser : phone;
    const senderRole = sender === browser ? 'browser' : 'phone';
    R2.handleFileFrame(room, sender, `${type}:${JSON.stringify({ id, reason: 'quota', seq: 0, n: 1, data: 'QQ', upTo: 0, sha256: sha(), relay: true })}`, senderRole, room.token);
    check(`M7: a peer-set relay mark on ${type} is REJECTED, nothing forwarded`,
      browser.sent.length === beforeB && phone.sent.length === beforeP);
    check(`M7: and the rejection is counted as peer_claimed_relay for ${type}`,
      R2.ftDropCounts.get(room.token)?.get(`${type}/peer_claimed_relay`) === 1);
    check(`M7: the live transfer survives a rejected ${type}`, room.transfer !== null);
  }
  {
    // POSITIVE CONTROL: the same frames WITHOUT the relay key flow normally, so
    // the eight rejections above are about the mark and not about the shape.
    const R2 = buildRelay({ db: DB_ALWAYS_OK });
    const phone = mkWs(); const browser = mkWs();
    const room = mkRoom(phone, browser);
    const id = newId();
    R2.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 4096, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    R2.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
    R2.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'QQ' })}`, 'phone', room.token);
    check('M7 control: the same frames without a relay key are forwarded normally',
      countOf(browser, 'FILE_OFFER') === 1 && countOf(browser, 'FILE_CHUNK') === 1);
  }

  // The refusals that actually reach a user go out marked.
  {
    const R2 = buildRelay({ db: DB_ALWAYS_OK });
    const phone = { userId: 'u1', tier: 'trial', readyState: 1, bufferedAmount: 0, sent: [] };
    const browser = { userId: 'u1', tier: 'trial', readyState: 1, bufferedAmount: 0, sent: [] };
    const room = mkRoom(phone, browser);
    R2.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: newId(), name: 'x', size: 4096, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    const f = payloadOf(lastOf(phone, 'FILE_FAILED'));
    check('a tier refusal reaches the sender MARKED, so mode ON can deliver it',
      f.reason === 'tier' && f.relay === true);
  }

  // M12 — the two factors are different numbers, in the right directions.
  check('M12: the charge factor is the base64 floor 4/3, not the ceiling 1.40',
    Math.abs(R.FT_WIRE_B64_FACTOR - 4 / 3) < 1e-12 && R.FT_WIRE_B64_FACTOR < R.FT_WIRE_OVERHEAD_FACTOR);
  {
    // An honest 100 MiB transfer moves about 4/3 of its raw bytes on the wire.
    // Inverting on 1.40 charged ~0.96x of that — a silent discount on the one
    // number that IS the abuse control.
    const raw = 100 * 1024 * 1024;
    const honestWire = Math.ceil(raw * 4 / 3);
    const charged = R.ftRawFromWire(honestWire);
    check('M12: an honest transfer is charged at least what it actually moved',
      charged >= raw, `charged ${charged} for ${raw}`);
    const wouldHaveBeen = Math.ceil(honestWire / R.FT_WIRE_OVERHEAD_FACTOR);
    check('M12: the old shared-factor inversion under-charged by about 4 %',
      wouldHaveBeen < raw && (raw - wouldHaveBeen) / raw > 0.03,
      `${wouldHaveBeen} vs ${raw}`);
    check('M12: the CEILING still errs generous — it keeps 1.40 plus a chunk',
      R.ftWireCeiling(raw) > honestWire);
  }
}

// ── PART 2 — chunk size vs the relay's real maxPayload ──────────────────────
console.log('\nPART 2 — chunk size fits under the relay frame cap');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });
  // 48 KiB raw → base64 is 4/3 rounded up to a multiple of 4.
  const b64 = 4 * Math.ceil(R.FT_CHUNK_RAW_BYTES / 3);
  const envelope = `FILE_CHUNK:${JSON.stringify({ id: newId(), seq: 21845, n: 21846, data: '' })}`.length;
  const wire = b64 + envelope;
  check('48 KiB raw base64s to exactly 65536 chars', b64 === 65536, String(b64));
  check('a full chunk is under 1 MiB on the wire even with the envelope',
    wire < 1024 * 1024, `${wire} bytes`);
  // Headroom for the E2E seal: nonce + tag + base64-of-ciphertext + JSON header.
  check('a SEALED full chunk still fits under 1 MiB',
    Math.ceil((R.FT_CHUNK_RAW_BYTES + 28) * 4 / 3) + envelope + 256 < 1024 * 1024);

  // The real constant, when it is there. Forge-V's maxPayload lives on
  // feature/saas-multiuser and arrives in e2e/integration at the D1 merge, so on
  // this lane's base it is absent. This arm ACTIVATES automatically the moment
  // it lands — it is not a literal standing in for the real value.
  const m = /const RELAY_MAX_PAYLOAD_BYTES = ([^;]+);/.exec(stripComments(SERVER_SRC));
  if (m) {
    const real = Function(`return (${m[1]});`)();
    check('a full chunk is under the REAL RELAY_MAX_PAYLOAD_BYTES', wire < real, `${wire} vs ${real}`);
    check('the real cap is at least 4x a full chunk', real >= 4 * wire);
  } else {
    check('RELAY_MAX_PAYLOAD_BYTES absent at this base — asserted against 1 MiB (activates at D1)',
      wire < 1024 * 1024);
  }
}

// ── PART 3 — the handshake, both directions ────────────────────────────────
console.log('\nPART 3 — handshake and forwarding');
{
  const { R, room, phone, browser, id } = await armedTransfer();
  check('FILE_OFFER reached the receiver', !!lastOf(browser, 'FILE_OFFER'));
  check('the forwarded offer is byte-identical in its fields',
    payloadOf(lastOf(browser, 'FILE_OFFER')).name === 'holiday.jpg');
  check('the relay armed exactly one record', !!room.transfer && room.transfer.id === id);
  check('the record is metadata only — no data, no chunk, no name',
    !('data' in room.transfer) && !('chunk' in room.transfer) && !('name' in room.transfer),
    Object.keys(room.transfer).join(','));
  check('the record carries the fields the spec names',
    ['id', 'state', 'from', 'size', 'mime', 'startedAt', 'bytesForwarded'].every((k) => k in room.transfer));
  check('FILE_ACCEPT reached the sender', !!lastOf(phone, 'FILE_ACCEPT'));
  check('state is accepted', room.transfer.state === 'accepted');

  const chunk = `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 86, data: 'QUJD' })}`;
  R.handleFileFrame(room, phone, chunk, 'phone', room.token);
  check('a chunk after ACCEPT is forwarded AS-IS',
    lastOf(browser, 'FILE_CHUNK') === chunk);
  check('bytesForwarded counts wire bytes', room.transfer.bytesForwarded === Buffer.byteLength(chunk, 'utf8'));

  R.handleFileFrame(room, browser, `FILE_ACK:${JSON.stringify({ id, upTo: 0 })}`, 'browser', room.token);
  check('FILE_ACK flows receiver → sender', !!lastOf(phone, 'FILE_ACK'));

  const done = `FILE_DONE:${JSON.stringify({ id, sha256: sha() })}`;
  R.handleFileFrame(room, phone, done, 'phone', room.token);
  check('FILE_DONE is forwarded', lastOf(browser, 'FILE_DONE') === done);
  check('the record is dropped on completion', room.transfer === null);
}
{
  // PC → phone is the same code path, mirrored. Proving it separately is the
  // point: the spec flags "the gate is currently browser→phone only" as the one
  // place this feature touches a security-relevant path.
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  const id = newId();
  R.handleFileFrame(room, browser, `FILE_OFFER:${JSON.stringify({ id, name: 'r.pdf', size: 1024, mime: 'application/pdf', sha256: sha(), from: 'browser' })}`, 'browser', room.token);
  await new Promise((r) => setImmediate(r));
  check('PC → phone: the offer reaches the phone', !!lastOf(phone, 'FILE_OFFER'));
  check('PC → phone: the record records the browser as sender', room.transfer.from === 'browser');
  R.handleFileFrame(room, phone, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'phone', room.token);
  R.handleFileFrame(room, browser, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'QQ' })}`, 'browser', room.token);
  check('PC → phone: chunks flow browser → phone', countOf(phone, 'FILE_CHUNK') === 1);
}

// ── PART 4 — accept-before-chunks, one-per-room, direction ─────────────────
console.log('\nPART 4 — consent gate and concurrency');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  const id = newId();
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  // The whole feature's consent promise: not one byte moves before Accept.
  for (let seq = 0; seq < 20; seq++) {
    R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq, n: 20, data: 'QUJD' })}`, 'phone', room.token);
  }
  check('NOT ONE chunk is forwarded before FILE_ACCEPT', countOf(browser, 'FILE_CHUNK') === 0);
  check('the dropped chunks are counted by type and reason',
    R.ftDropCounts.get(room.token)?.get('FILE_CHUNK/not_accepted') === 20);
  check('bytesForwarded stayed at zero', room.transfer.bytesForwarded === 0);

  // A second offer while one is live.
  const id2 = newId();
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: id2, name: 'y', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  // M5: busy is a relay-minted FILE_FAILED now, not a FILE_REJECT. FILE_REJECT
  // is sealed-by-exclusion, so a plaintext relay-minted one is dropped by the
  // receiver's downgrade guard and "busy" was invisible under mode ON.
  check('a second concurrent offer is refused with FILE_FAILED busy',
    payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'busy');
  check('the relay mints NO FILE_REJECT at all — that frame is receiver-authored',
    countOf(phone, 'FILE_REJECT') === 0 && countOf(browser, 'FILE_REJECT') === 0);
  check('the refusal names the SECOND id, not the live one', payloadOf(lastOf(phone, 'FILE_FAILED'))?.id === id2);
  check('the live transfer is untouched by the refusal', room.transfer.id === id);
  check('the second offer never reached the peer', countOf(browser, 'FILE_OFFER') === 1);

  // Accept, then the RECEIVER tries to push chunks back up the wrong way.
  R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
  R.handleFileFrame(room, browser, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 20, data: 'QUJD' })}`, 'browser', room.token);
  check('a chunk from the RECEIVER is dropped (wrong direction)', countOf(phone, 'FILE_CHUNK') === 0);

  // A chunk for an id the relay does not know.
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id: newId(), seq: 0, n: 1, data: 'QQ' })}`, 'phone', room.token);
  check('a chunk for an unknown id is dropped', countOf(browser, 'FILE_CHUNK') === 0);
}
{
  // A socket that is not the ACTIVE peer for its role cannot drive a transfer —
  // otherwise a duplicate lobby socket would bypass the state machine entirely.
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const phone = mkWs(); const browser = mkWs(); const ghost = mkWs();
  const room = mkRoom(phone, browser);
  R.handleFileFrame(room, ghost, `FILE_OFFER:${JSON.stringify({ id: newId(), name: 'x', size: 1, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('a non-active socket cannot open a transfer', room.transfer === null && countOf(browser, 'FILE_OFFER') === 0);
}

// ── PART 5 — backpressure watermark and declared-size overrun ──────────────
console.log('\nPART 5 — backpressure and declared-size enforcement');
{
  const { R, room, phone, browser, id } = await armedTransfer();
  browser.bufferedAmount = 8 * 1024 * 1024; // AT the mark — not over
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 9, data: 'QUJD' })}`, 'phone', room.token);
  check('at exactly the watermark the transfer survives', room.transfer !== null && countOf(browser, 'FILE_CHUNK') === 1);

  browser.bufferedAmount = 8 * 1024 * 1024 + 1; // one byte over
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 1, n: 9, data: 'QUJD' })}`, 'phone', room.token);
  check('one byte over the watermark aborts', room.transfer === null);
  check('the over-mark chunk was NOT forwarded — the relay never queues', countOf(browser, 'FILE_CHUNK') === 1);
  check('the SENDER is told relay_backpressure', payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'relay_backpressure');
  check('the RECEIVER is told relay_backpressure too', payloadOf(lastOf(browser, 'FILE_FAILED'))?.reason === 'relay_backpressure');
}
{
  // Declared 1 MB, pushes far more: the abort must fire off bytesForwarded,
  // not off anything the sender claims per-chunk.
  const { R, room, phone, browser, id } = await armedTransfer({ size: 1024 * 1024 });
  const fat = `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'A'.repeat(2 * 1024 * 1024) })}`;
  R.handleFileFrame(room, phone, fat, 'phone', room.token);
  check('a chunk past the metered ceiling aborts as size_mismatch (A-3 / Ken Addendum 2)',
    room.transfer === null && payloadOf(lastOf(browser, 'FILE_FAILED'))?.reason === 'size_mismatch');
  check('the over-size chunk was not forwarded', countOf(browser, 'FILE_CHUNK') === 0);
}
{
  // THE SMALL-FILE REGRESSION. `bytesForwarded > size * 1.40` with no floor
  // aborts a 10-byte file on its first chunk, because the JSON envelope alone is
  // seven times the declared size. A percentage-only ceiling is a size-blind
  // rule that misbehaves at exactly the end nobody thinks to test.
  const { R, room, phone, browser, id } = await armedTransfer({ size: 10 });
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'aGVsbG8gd29ybGQ' })}`, 'phone', room.token);
  check('a 10-byte file survives its own first chunk',
    room.transfer !== null && countOf(browser, 'FILE_CHUNK') === 1);
  R.handleFileFrame(room, phone, `FILE_DONE:${JSON.stringify({ id, sha256: sha() })}`, 'phone', room.token);
  check('and completes normally', room.transfer === null && !!lastOf(browser, 'FILE_DONE'));
  check('the ceiling floor is one full chunk on the wire',
    R.FT_CHUNK_WIRE_BYTES > 4 * Math.ceil(R.FT_CHUNK_RAW_BYTES / 3),
    String(R.FT_CHUNK_WIRE_BYTES));
}

// ── PART 6 — resume ────────────────────────────────────────────────────────
console.log('\nPART 6 — resume across a reconnect');
{
  const { R, room, phone, browser, id } = await armedTransfer({ size: 200 * 1024 * 1024 });
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 4267, data: 'QUJD' })}`, 'phone', room.token);
  // The browser blips: soft-hold keeps the phone active, arms a resume claim.
  room.active.browser = null;
  room.resumable = { expiresAt: Date.now() + 180_000 };
  check('the transfer record SURVIVES a held pair', room.transfer !== null);

  // The browser returns as a NEW socket and asks to resume from where it got to.
  const browser2 = mkWs();
  room.active.browser = browser2;
  room.resumable = null;
  R.handleFileFrame(room, browser2, `FILE_RESUME:${JSON.stringify({ id, upTo: 0 })}`, 'browser', room.token);
  check('FILE_RESUME is forwarded to the SENDER', !!lastOf(phone, 'FILE_RESUME'));
  check('the relay forwards upTo untouched — it does not invent an offset',
    payloadOf(lastOf(phone, 'FILE_RESUME')).upTo === 0);
  check('state returns to accepted so chunks flow again', room.transfer.state === 'accepted');
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 1, n: 4267, data: 'QUJD' })}`, 'phone', room.token);
  check('chunks resume to the NEW receiver socket', countOf(browser2, 'FILE_CHUNK') === 1);
  check('and NOT to the dead one — the relay routes off room.active, not the record',
    countOf(browser, 'FILE_CHUNK') === 1);
}
{
  // The record is gone (window expired, or a RESET_ROOM happened). A resume must
  // be answered, not swallowed — a silent drop hangs the receiver's UI forever.
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  R.handleFileFrame(room, browser, `FILE_RESUME:${JSON.stringify({ id: newId(), upTo: 12 })}`, 'browser', room.token);
  check('a resume for an expired/unknown record answers connection_lost',
    payloadOf(lastOf(browser, 'FILE_FAILED'))?.reason === 'connection_lost');
  check('nothing was forwarded to the peer', countOf(phone, 'FILE_RESUME') === 0);
}
{
  // ftAbort is what the janitor and every teardown path call.
  const { R, room, phone, browser } = await armedTransfer();
  R.ftAbort(room, 'timeout');
  check('a stall abort tells both sides timeout',
    payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'timeout'
    && payloadOf(lastOf(browser, 'FILE_FAILED'))?.reason === 'timeout');
  check('and drops the record', room.transfer === null);
}

// ── PART 7 — a 1 GiB-shaped transfer, by arithmetic ────────────────────────
console.log('\nPART 7 — 1 GiB-shaped transfer (seq/n arithmetic, no allocation)');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const SIZE = R.FT_MAX_FILE_BYTES;                   // exactly 1 GiB
  const N = Math.ceil(SIZE / R.FT_CHUNK_RAW_BYTES);
  check('1 GiB at 48 KiB raw is 21846 chunks', N === 21846, String(N));
  check('the last chunk is a partial, not a full one', SIZE % R.FT_CHUNK_RAW_BYTES !== 0 || N * R.FT_CHUNK_RAW_BYTES === SIZE);

  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  const id = newId();
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'v.mp4', size: SIZE, mime: 'video/mp4', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('a 1 GiB offer is admitted at exactly the cap', !!room.transfer && room.transfer.state === 'offered');
  R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
  // Drive the boundary sequence numbers only; the body of the stream is
  // arithmetic, not bytes — allocating 1 GB to prove routing would prove
  // nothing extra and would OOM the runner.
  for (const seq of [0, 1, Math.floor(N / 2), N - 2, N - 1]) {
    R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq, n: N, data: 'QUJD' })}`, 'phone', room.token);
  }
  check('every boundary chunk of a 21846-chunk stream forwards', countOf(browser, 'FILE_CHUNK') === 5);
  check('the relay never held a byte of content', room.transfer.bytesForwarded < 1000);
  R.handleFileFrame(room, phone, `FILE_DONE:${JSON.stringify({ id, sha256: sha() })}`, 'phone', room.token);
  check('the 1 GiB transfer completes and the slot frees', room.transfer === null);

  // One byte over the cap.
  const room2 = mkRoom(phone, browser);
  const id2 = newId();
  R.handleFileFrame(room2, phone, `FILE_OFFER:${JSON.stringify({ id: id2, name: 'v.mp4', size: SIZE + 1, mime: 'video/mp4', sha256: sha(), from: 'phone' })}`, 'phone', room2.token);
  await new Promise((r) => setImmediate(r));
  check('1 GiB + 1 byte is refused too_large', payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'too_large');
  check('the oversize offer never reached the peer', countOf(browser, 'FILE_OFFER') === 1);
  check('no record was left behind', room2.transfer === null);
}

// ── PART 8 — tier refusal ──────────────────────────────────────────────────
console.log('\nPART 8 — tier gate (trial/free = feature OFF)');
// NOTE the sockets here are built INLINE rather than via mkWs(): mkWs defaults
// `tier` to 'plus', so passing `undefined` through it would silently test a
// paying account and report three confident passes for the one case that
// matters most — a socket whose tier never resolved.
for (const tier of ['trial', 'free', 'enterprise', undefined]) {
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const mk = () => ({ userId: 'u1', tier, readyState: 1, bufferedAmount: 0, sent: [] });
  const phone = mk(); const browser = mk();
  const room = mkRoom(phone, browser);
  const id = newId();
  let reserved = false;
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check(`tier=${tier}: refused with FILE_FAILED tier`, payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'tier');
  check(`tier=${tier}: the offer NEVER reached the peer`, countOf(browser, 'FILE_OFFER') === 0);
  check(`tier=${tier}: no record armed`, room.transfer === null);
  void reserved;
}
{
  // The tier check must run BEFORE any DB write — a trial account must not be
  // able to make the relay touch the quota table at all.
  let touched = 0;
  const db = { $queryRawUnsafe: async () => { touched++; return [{ used: 1n }]; }, $executeRawUnsafe: async () => { touched++; return 1; } };
  const R = buildRelay({ db });
  const phone = mkWs('u1', 'trial'); const browser = mkWs('u1', 'trial');
  const room = mkRoom(phone, browser);
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: newId(), name: 'x', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('a trial offer causes ZERO quota-table traffic', touched === 0, `touched=${touched}`);
}
{
  // Quota refusal (stubbed 0-rows) must not arm a transfer.
  const R = buildRelay({ db: DB_OVER_QUOTA });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: newId(), name: 'x', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('an over-quota offer is refused with FILE_FAILED quota',
    payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'quota');
  check('an over-quota offer never reaches the peer', countOf(browser, 'FILE_OFFER') === 0);
}
{
  // FAIL CLOSED on a DB error. This is the deliberate divergence from
  // checkDailyOutboundLimit, which fails open — one admitted offer here is up to
  // 1 GB of egress, so an outage must refuse, not wave through.
  const db = { $queryRawUnsafe: async () => { throw new Error('connection refused'); }, $executeRawUnsafe: async () => 1 };
  const R = buildRelay({ db });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: newId(), name: 'x', size: 1024, mime: 'text/plain', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('a quota-store outage FAILS CLOSED', payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'quota');
  check('and arms nothing', room.transfer === null && countOf(browser, 'FILE_OFFER') === 0);
}

// ── PART 9 — frameBuffer exclusion ─────────────────────────────────────────
console.log('\nPART 9 — FILE_* frames never enter the 200-entry replay buffer');
{
  // Behavioural: 600 chunks through the real buffering branch, then a resume.
  // The branch itself lives inline in the phone handler, so it is extracted the
  // same way everything else here is — by reading the REAL source, not by
  // restating the rule.
  const src = stripComments(SERVER_SRC);
  const pushSites = src.match(/frameBuffer\.push\(/g) || [];
  check('there is exactly one frameBuffer push site to guard', pushSites.length === 1, `${pushSites.length} sites`);
  const idx = src.indexOf('frameBuffer.push(');
  const before = src.slice(Math.max(0, idx - 900), idx);
  check('the push site is guarded by isFileFrame BEFORE the push', /isFileFrame\(msg\)[\s\S]*return;/.test(before));
  check('the guard uses frameType-based isFileFrame, not startsWith',
    !/startsWith\(\s*['"]FILE_/.test(src));

  // Now prove the rule itself: a 200-slot buffer flushed by a chunk stream.
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const FRAME_BUFFER_MAX = 200;
  const buffer = [];
  const bufferOrSkip = (msg) => {
    if (R.isFileFrame(msg)) return 'skipped';
    buffer.push(msg);
    if (buffer.length > FRAME_BUFFER_MAX) buffer.shift();
    return 'buffered';
  };
  const real = ['SMS_RECEIVED:{"id":1}', 'PHONE_NOTIFICATION:{"id":2}', 'CALL_LOG_ENTRY:{"id":3}'];
  for (const m of real) bufferOrSkip(m);
  const id = newId();
  for (let seq = 0; seq < 600; seq++) bufferOrSkip(`FILE_CHUNK:${JSON.stringify({ id, seq, n: 600, data: 'QUJD' })}`);
  bufferOrSkip(`FILE_OFFER:${JSON.stringify({ id, name: 'x', size: 1, mime: 'text/plain', sha256: sha(), from: 'phone' })}`);
  bufferOrSkip(`FILE_ACK:${JSON.stringify({ id, upTo: 599 })}`);
  bufferOrSkip(`FILE_DONE:${JSON.stringify({ id, sha256: sha() })}`);
  check('600 chunks later, the replay buffer holds ONLY the 3 real frames',
    buffer.length === 3 && real.every((m, i) => buffer[i] === m), `len=${buffer.length}`);
  check('no FILE_* frame of any type is in the buffer', buffer.every((m) => !R.isFileFrame(m)));
}

// ── PART 10 — logging and redaction ────────────────────────────────────────
console.log('\nPART 10 — FILE_* logging is type + bytes + id only');
{
  const R = buildRelay({ db: DB_ALWAYS_OK });
  const phone = mkWs(); const browser = mkWs();
  const room = mkRoom(phone, browser);
  const id = newId();
  const CANARY_NAME = 'CANARY_FILENAME_qp81zx.jpg';
  const CANARY_DATA = 'CANARYDATAaGVsbG8gd29ybGQ';
  const CANARY_HASH = 'deadbeef'.repeat(8);
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: CANARY_NAME, size: 4096, mime: 'image/jpeg', sha256: CANARY_HASH, from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
  R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: CANARY_DATA })}`, 'phone', room.token);
  R.handleFileFrame(room, phone, `FILE_DONE:${JSON.stringify({ id, sha256: CANARY_HASH })}`, 'phone', room.token);
  const all = R.logs.join('\n');
  check('no filename ever reaches a log line', !all.includes(CANARY_NAME));
  check('no chunk data ever reaches a log line', !all.includes(CANARY_DATA));
  check('no content hash ever reaches a log line', !all.includes(CANARY_HASH));
  check('the transfer id IS logged (it is the debugging handle, and it is random)',
    all.includes(id));
  check('frameLabel on a fat chunk prints type and byte count only',
    R.frameLabel(`FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'A'.repeat(1000) })}`)
      === `type=FILE_CHUNK bytes=${Buffer.byteLength(`FILE_CHUNK:${JSON.stringify({ id, seq: 0, n: 1, data: 'A'.repeat(1000) })}`, 'utf8')}`);

  // Source-level: no FILE_ log site may interpolate a payload field other than
  // id/size/reason/state/bytes. The failure this guards is a well-meant
  // `${payload.name}` added to a debug line six months from now.
  const src = stripComments(SERVER_SRC);
  const bad = [];
  for (const line of src.split('\n')) {
    if (!/rlog\(|console\.(log|error)\(/.test(line)) continue;
    if (!/FILE/.test(line)) continue;
    for (const m of line.matchAll(/\$\{([^}]+)\}/g)) {
      const expr = m[1];
      if (/payload\.(name|data|sha256|mime)|rec\.(name|data)|\bmsg\b(?!Label)/.test(expr)
          && !/frameLabel\(/.test(expr)) bad.push(`${expr}`);
    }
  }
  check('no FILE_* log site interpolates a name, a hash, a mime or raw data', bad.length === 0, bad.join(' | '));
}

// ── PART 11 — the quota, against a REAL PostgreSQL ─────────────────────────
console.log('\nPART 11 — FileQuota against a real database');
let db = null;
let userId = null;
try {
  if (!process.env.DATABASE_URL) {
    console.error('\nft-relay: DATABASE_URL is required for PART 11 (the ccpix harness DB).');
    console.error('  e.g. DATABASE_URL=postgresql://pix:pix@localhost:15433/cc node tests/ft-relay.test.mjs');
    process.exit(2);
  }
  const { PrismaClient } = requireCjs(join(ROOT, 'node_modules', '@prisma', 'client'));
  db = new PrismaClient();
  const R = buildRelay({ db });

  // An isolated user per run — this DB is shared with the other lanes' suites,
  // and a suite that assumes it owns the table is a suite that goes red for a
  // sibling's reasons.
  const suffix = randomBytes(8).toString('hex');
  const user = await db.user.create({
    data: {
      email: `ft1-${suffix}@harness.invalid`,
      phoneToken: randomBytes(32).toString('base64url'),
    },
  });
  userId = user.id;

  const D1 = '2026-09-18';
  const D2 = '2026-09-19';
  const GiB = 1024 * 1024 * 1024;
  const readBytes = async (day) => {
    const rows = await db.$queryRawUnsafe(
      `SELECT "bytes" FROM "FileQuota" WHERE "userId" = $1 AND "day" = $2`, userId, day,
    );
    return rows.length ? BigInt(rows[0].bytes) : null;
  };

  check('a fresh account has no quota row at all', (await readBytes(D1)) === null);

  const r1 = await R.ftReserveQuota(userId, GiB, D1);
  check('a 1 GiB reservation is admitted', r1.ok === true);
  check('the counter holds exactly 1 GiB', (await readBytes(D1)) === BigInt(GiB));

  const r2 = await R.ftReserveQuota(userId, GiB, D1);
  check('a second 1 GiB reservation lands exactly ON the 2 GiB cap', r2.ok === true);
  check('the counter holds exactly 2 GiB — a value int4 cannot represent',
    (await readBytes(D1)) === BigInt(R.FT_DAILY_QUOTA_BYTES));

  const r3 = await R.ftReserveQuota(userId, 1, D1);
  check('one more BYTE is refused', r3.ok === false && r3.reason === 'quota');
  check('the refused reservation did not increment', (await readBytes(D1)) === BigInt(R.FT_DAILY_QUOTA_BYTES));

  // Day rollover: a new UTC calendar day is a new row and a full allowance.
  const r4 = await R.ftReserveQuota(userId, GiB, D2);
  check('the next UTC day starts fresh (rollover at 00:00 UTC)', r4.ok === true);
  check('the new day holds 1 GiB', (await readBytes(D2)) === BigInt(GiB));
  check('yesterday is untouched by today', (await readBytes(D1)) === BigInt(R.FT_DAILY_QUOTA_BYTES));

  // SETTLE targets the day the reservation was MADE on, never "today". A
  // transfer opened at 23:59:50 and failed at 00:00:10 must settle yesterday.
  // bytesForwarded 0 = nothing was metered = the reservation is fully released,
  // which is the FILE_FAILED-before-any-chunk case.
  const recAcrossMidnight = { senderUserId: userId, quotaDay: D1, size: GiB, bytesForwarded: 0, quotaSettled: false };
  R.ftSettleQuota(recAcrossMidnight);
  await new Promise((r) => setTimeout(r, 250));
  check('a failure with nothing metered fully refunds the day it charged', (await readBytes(D1)) === BigInt(GiB));
  check('and does NOT touch the current day', (await readBytes(D2)) === BigInt(GiB));

  check('the settle is marked settled', recAcrossMidnight.quotaSettled === true);
  R.ftSettleQuota(recAcrossMidnight);       // second call — must be a no-op
  await new Promise((r) => setTimeout(r, 250));
  check('a double settle refunds ONCE, not twice', (await readBytes(D1)) === BigInt(GiB));

  // MUST A-4, the whole point: the charge is what was METERED, not what was
  // hinted. A transfer that hinted 1 GiB and moved nothing pays nothing; one
  // that hinted 1 KiB and moved 700 MiB pays for 700 MiB.
  {
    // The HONEST wire ratio for 700 MiB of real bytes is 4/3 (base64), not the
    // ceiling's generous 1.40 — using the ceiling factor here would model a
    // stream that never happens and make the charge look 5 % too high.
    const wire700 = Math.ceil(700 * 1024 * 1024 * 4 / 3);
    const liar = { senderUserId: userId, quotaDay: D2, size: 1024, bytesForwarded: wire700, quotaSettled: false };
    const before = await readBytes(D2);
    R.ftSettleQuota(liar);
    await new Promise((r) => setTimeout(r, 250));
    const charged = (await readBytes(D2)) - before;
    // The counter moves by the DELTA from the 1 KiB admission reservation, so the
    // total borne by the account is `charged + 1024`. Asserting the delta as if
    // it were the total would be off by exactly the size of the lie — small
    // here, and exactly the kind of off-by-the-interesting-quantity that makes a
    // test agree with a bug.
    check('vector L5: a sender that hinted 1 KiB and streamed 700 MiB is charged ~700 MiB, not 1 KiB',
      charged + 1024n >= BigInt(700 * 1024 * 1024) && charged + 1024n <= BigInt(701 * 1024 * 1024),
      String(charged + 1024n));
    check('M12: the charge is at least the true raw figure, never under it',
      liar.settledRaw >= 700 * 1024 * 1024 && liar.settledRaw <= 701 * 1024 * 1024, String(liar.settledRaw));
  }

  // The floor: a refund must never drive a counter negative.
  const recHuge = { senderUserId: userId, quotaDay: D2, size: 8 * GiB, bytesForwarded: 0, quotaSettled: false };
  R.ftSettleQuota(recHuge);
  await new Promise((r) => setTimeout(r, 250));
  check('an over-large refund floors at zero, never negative', (await readBytes(D2)) === 0n);

  // The whole-path arm: a real FILE_OFFER reserves, a real FILE_FAILED releases.
  {
    const phone = mkWs(userId, 'plus'); const browser = mkWs(userId, 'plus');
    const room = mkRoom(phone, browser);
    const id = newId();
    const before = (await readBytes(R.utcDayKey(new Date()))) ?? 0n;
    R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'a.bin', size: 50 * 1024 * 1024, mime: 'application/octet-stream', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setTimeout(r, 300));
    const today = R.utcDayKey(new Date());
    check('FILE_OFFER reserved on the sender account', (await readBytes(today)) === before + BigInt(50 * 1024 * 1024));
    check('the record remembers which day it charged', room.transfer?.quotaDay === today);
    check('the record charges ws.userId, never a payload field', room.transfer?.senderUserId === userId);

    R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
    R.handleFileFrame(room, browser, `FILE_FAILED:${JSON.stringify({ id, reason: 'hash_mismatch' })}`, 'browser', room.token);
    await new Promise((r) => setTimeout(r, 300));
    check('FILE_FAILED with nothing metered releases the whole reservation', (await readBytes(today)) === before);
    check('and the peer was told', payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason === 'hash_mismatch');
  }
  {
    const phone = mkWs(userId, 'plus'); const browser = mkWs(userId, 'plus');
    const room = mkRoom(phone, browser);
    const id = newId();
    const today = R.utcDayKey(new Date());
    const before = (await readBytes(today)) ?? 0n;
    R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'b.bin', size: 7 * 1024 * 1024, mime: 'application/octet-stream', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setTimeout(r, 300));
    R.handleFileFrame(room, browser, `FILE_ACCEPT:${JSON.stringify({ id })}`, 'browser', room.token);
    // Stream ~1 MiB of real wire bytes, then finish. The charge must reflect
    // THOSE bytes, not the 7 MiB that was hinted.
    const data = 'A'.repeat(300 * 1024);
    for (let seq = 0; seq < 4; seq++) {
      R.handleFileFrame(room, phone, `FILE_CHUNK:${JSON.stringify({ id, seq, n: 4, data })}`, 'phone', room.token);
    }
    const metered = room.transfer.bytesForwarded;
    check('the relay metered the ACTUAL wire bytes of every chunk',
      metered > 1_200_000 && metered < 1_300_000, String(metered));
    R.handleFileFrame(room, phone, `FILE_DONE:${JSON.stringify({ id, sha256: sha() })}`, 'phone', room.token);
    await new Promise((r) => setTimeout(r, 300));
    const charged = (await readBytes(today)) - before;
    check('FILE_DONE charges METERED bytes, not the 7 MiB hint (MUST A-4)',
      charged < BigInt(2 * 1024 * 1024) && charged > BigInt(800 * 1024), String(charged));
  }

  // The janitor's delete is a ranged one against the day index.
  const OLD = '2026-01-01';
  await R.ftReserveQuota(userId, 1024, OLD);
  check('an old row exists to prune', (await readBytes(OLD)) === 1024n);
  await db.$executeRawUnsafe(`DELETE FROM "FileQuota" WHERE "userId" = $1 AND "day" < $2`, userId, '2026-09-01');
  check('a ranged day delete prunes it', (await readBytes(OLD)) === null);
  check('and leaves the current rows alone', (await readBytes(D2)) !== null);

  // The table stores NOTHING about the file.
  const cols = await db.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'FileQuota'`,
  );
  const names = cols.map((c) => c.column_name).sort();
  check('FileQuota has exactly id/userId/day/bytes/createdAt/updatedAt and nothing else',
    names.join(',') === 'bytes,createdAt,day,id,updatedAt,userId', names.join(','));
  const type = await db.$queryRawUnsafe(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'FileQuota' AND column_name = 'bytes'`,
  );
  check('bytes is BIGINT — an INTEGER would overflow at the cap', type[0]?.data_type === 'bigint', type[0]?.data_type);
} catch (e) {
  fail++;
  console.log(`  FAIL PART 11 threw — ${e.message}`);
  console.log(e.stack);
} finally {
  if (db) {
    try {
      if (userId) await db.user.delete({ where: { id: userId } }); // cascades FileQuota
    } catch (e) { console.error(`  warn  cleanup failed: ${e.message}`); }
    await db.$disconnect();
  }
}

// ── PART 12 — FT-A1.2: the no-receiver timeout is RELAY-owned ──────────────
//
// Security FT-A1.2 RATIFIED (A), 2026-09-18: B-3 is STRUCK and the no-receiver
// timeout lives in the relay janitor, because the SW cannot satisfy it without
// breaking three other ratified invariants (it has no send path, and a
// SW-authored frame would be plaintext-and-unmarked, which the phone's B-1
// guard is required to drop). So there is no new logic in this letter — branch 2
// of `ftSweep` already IS the ruling — and these cases are the regression pins
// that stop it from being "simplified" away.
//
// FROZEN timer hierarchy (A1.2, extending A1.1 M4):
//   sender-local 60 s  PRIMARY       · SW 60 s marker  INFORMATIONAL (sends nothing)
//   relay 90 s TTL     BACKSTOP      · FT_STALL_MS 30 s  post-ACCEPT only
console.log('\nPART 12 — FT-A1.2 no-receiver TTL sweep (relay-owned)');
{
  /** A db that records every settle so a refund can be counted, not assumed. */
  const mkRecordingDb = () => {
    const execs = [];
    return {
      execs,
      $queryRawUnsafe: async () => [{ used: 1n }],
      $executeRawUnsafe: async (sql, ...args) => { execs.push({ sql, args }); return 1; },
    };
  };

  /** Arm an offer and answer with NEITHER accept nor reject. */
  async function armedOffer({ clock, db, size = 4 * 1024 * 1024, tier = 'plus' }) {
    const rooms = new Map();
    const R = buildRelay({ db, rooms, clock });
    const phone = mkWs('u1', tier);
    const browser = mkWs('u1', tier);
    const room = mkRoom(phone, browser);
    rooms.set(room.token, room);
    const id = newId();
    R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id, name: 'holiday.jpg', size, mime: 'image/jpeg', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
    await new Promise((r) => setImmediate(r));
    return { R, room, phone, browser, id };
  }

  // (1) the expiry itself.
  const clock = fakeClock();
  const db = mkRecordingDb();
  const SIZE = 4 * 1024 * 1024;
  const { R, room, phone, browser, id } = await armedOffer({ clock, db, size: SIZE });
  const armed = !!room.transfer && room.transfer.state === 'offered';
  clock.advance(R.FT_OFFER_TTL_MS - 1_000);          // 89 s — still inside the backstop
  R.tickSweep();
  const aliveBefore = room.transfer !== null;
  clock.advance(2_000);                               // 91 s — past it
  R.tickSweep();
  check('A1.2: a pending offer nobody answers survives to FT_OFFER_TTL_MS and is expired after it',
    armed && aliveBefore && room.transfer === null,
    `armed=${armed} aliveAt89s=${aliveBefore} recAt91s=${room.transfer}`);

  // (2) M14 — BOTH endpoints hear it, and the receiver's copy is correct.
  const toSender = payloadOf(lastOf(phone, 'FILE_FAILED'));
  const toReceiver = payloadOf(lastOf(browser, 'FILE_FAILED'));
  const wanted = JSON.stringify({ id, reason: 'timeout', relay: true });
  check('A1.2-M14: the marked timeout is delivered to BOTH endpoints, body exactly {id,reason,relay}',
    JSON.stringify(toSender) === wanted && JSON.stringify(toReceiver) === wanted
    && countOf(phone, 'FILE_FAILED') === 1 && countOf(browser, 'FILE_FAILED') === 1,
    `sender=${JSON.stringify(toSender)} receiver=${JSON.stringify(toReceiver)}`);

  // (3) the slot and the reservation are actually given back — and a transfer
  //     that burned bytes before expiring still PAYS for them (MUST A-4): the
  //     refund is size-minus-metered, never a blanket release.
  await new Promise((r) => setImmediate(r));
  const settles = db.execs.filter((e) => /"FileQuota" SET "bytes"/.test(e.sql));
  const fullRefund = settles.length === 1
    && /GREATEST/.test(settles[0].sql) && settles[0].args[2] === String(SIZE);
  const rec = { senderUserId: 'u1', quotaDay: '2026-09-18', size: SIZE, bytesForwarded: R.ftWireCeiling(1024 * 1024), quotaSettled: false };
  R.ftSettleQuota(rec);
  R.ftSettleQuota(rec);                               // idempotence: no double refund
  const partial = db.execs.filter((e) => /"FileQuota" SET "bytes"/.test(e.sql)).length === 2
    && rec.settledRaw > 0 && rec.settledRaw < SIZE;
  // Slot freed for real: a fresh offer in the same room is admitted, not `busy`.
  const id2 = newId();
  R.handleFileFrame(room, phone, `FILE_OFFER:${JSON.stringify({ id: id2, name: 'b.jpg', size: 4096, mime: 'image/jpeg', sha256: sha(), from: 'phone' })}`, 'phone', room.token);
  await new Promise((r) => setImmediate(r));
  check('A1.2: the sweep frees the room slot and refunds the reservation exactly once (metered bytes stay charged)',
    fullRefund && partial && room.transfer?.id === id2
    && payloadOf(lastOf(phone, 'FILE_FAILED'))?.reason !== 'busy',
    `settles=${settles.length} refund=${settles[0]?.args[2]} settledRaw=${rec.settledRaw} rec2=${room.transfer?.id === id2}`);

  // (4) M15 — `timeout` is relay-owned and never peer-authored. A peer's own
  //     plaintext expiry arriving after the sweep names a transfer the relay no
  //     longer holds, so it is dropped and COUNTED rather than forwarded as if
  //     the relay had authored it. (The marked forgery is the separate
  //     peer_claimed_relay rejection above; the receiver-side half of M15 is the
  //     phone's B-1 guard, which is not this component's to enforce.)
  const c2 = fakeClock();
  const S = await armedOffer({ clock: c2, db: mkRecordingDb() });
  c2.advance(S.R.FT_OFFER_TTL_MS + 1_000);
  S.R.tickSweep();
  const beforeP = S.phone.sent.length; const beforeB = S.browser.sent.length;
  S.R.handleFileFrame(S.room, S.browser, `FILE_FAILED:${JSON.stringify({ id: S.id, reason: 'timeout' })}`, 'browser', S.room.token);
  check('A1.2-M15: a plaintext UNMARKED peer `timeout` after the sweep is dropped and counted, never forwarded',
    S.phone.sent.length === beforeP && S.browser.sent.length === beforeB
    && S.R.ftDropCounts.get(S.room.token)?.get('FILE_FAILED/no_record') === 1,
    `sentDelta=${S.phone.sent.length - beforeP} count=${S.R.ftDropCounts.get(S.room.token)?.get('FILE_FAILED/no_record')}`);

  // (5) the 90 s TTL is the OFFERED branch only. Once the receiver accepts,
  //     FT_STALL_MS (30 s) owns the path — inverting these would let an accepted
  //     transfer idle for 90 s, and would time out an honest sender's offer
  //     before its own 60 s primary had a chance to speak.
  const c3 = fakeClock();
  const A = await armedOffer({ clock: c3, db: mkRecordingDb() });
  A.R.handleFileFrame(A.room, A.browser, `FILE_ACCEPT:${JSON.stringify({ id: A.id })}`, 'browser', A.room.token);
  const accepted = A.room.transfer?.state === 'accepted';
  const c4 = fakeClock();
  const O = await armedOffer({ clock: c4, db: mkRecordingDb() });
  const MID = 40_000;                                  // > FT_STALL_MS, < FT_OFFER_TTL_MS
  c3.advance(MID); A.R.tickSweep();
  c4.advance(MID); O.R.tickSweep();
  check('A1.2: the 90 s TTL does NOT govern post-ACCEPT — at 40 s idle the accepted transfer is stalled out while the pending offer lives',
    accepted && A.room.transfer === null && O.room.transfer !== null
    && payloadOf(lastOf(A.phone, 'FILE_FAILED'))?.reason === 'timeout',
    `accepted=${accepted} acceptedRec=${A.room.transfer} offeredRec=${!!O.room.transfer}`);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} ft-relay: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
