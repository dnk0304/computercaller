#!/usr/bin/env node
/**
 * tests/e2e-listener-wrap.test.mjs — P1(c): PAIR_STATE carries the extension's
 * OWN wrap, and nobody else's.
 *
 * Why the listener needs this at all: the extension's MV3 service worker is
 * never room.active.browser, so PAIRING_ACTIVE never reaches it. PAIR_STATE is
 * the ONLY pairing frame it ever receives, which makes it the one chance to
 * learn the key material it needs to decrypt notification bodies with the panel
 * closed. Without it the SW degrades to count-only badges — never plaintext,
 * but never useful either.
 *
 * Why `wrap` is singular. The wraps[] list holds a sealed key for every device
 * on the account. Broadcasting the whole list to every listener would put other
 * devices' key material in a service worker that can do nothing with it —
 * sealed, useless, and permanently resident for no reason. Each listener gets
 * exactly the entry addressed to it.
 *
 * Why `recipKeys` is NOT narrowed the same way. The SAS (B9) is computed over
 * the ENTIRE static key set, so a party holding only its own key cannot
 * reproduce the code the user is being asked to compare. Narrowing this list
 * would not be defence in depth; it would disable verification. The two fields
 * look symmetric and must be treated oppositely, which is exactly the kind of
 * thing that gets "tidied" later — hence explicit assertions on both.
 *
 * The discriminating case is two listeners on one account. A test with one
 * listener passes just as happily against an implementation that broadcasts one
 * shared string to everybody, which is precisely the bug.
 *
 * server.js cannot be imported, so this mirrors derivePairState/broadcastPairState
 * and pins the mirror with a comment-stripped drift guard.
 */

import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OPEN = 1;
const CLOSED = 3;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function realKey() {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
}

const KEYS = [realKey(), realKey(), realKey()];
function block() {
  return {
    v: 1,
    mode: 1,
    kid: 'kid-listener',
    epk: realKey(),
    recipKeys: KEYS,
    wraps: [
      { deviceId: 'web-1', wrap: 'WRAP-FOR-WEB' },
      { deviceId: 'ext-A', wrap: 'WRAP-FOR-EXT-A' },
      { deviceId: 'ext-B', wrap: 'WRAP-FOR-EXT-B' },
    ],
  };
}

const makeWs = (over = {}) => ({ role: 'browser', listener: false, deviceId: null, readyState: OPEN, sent: [], ...over });
const listener = (deviceId = null) => makeWs({ listener: true, deviceId });
const safeSend = (ws, msg) => { if (ws && ws.readyState === OPEN) ws.sent.push(msg); };

function makeRoom() {
  return { token: 't', lobby: new Set(), active: { browser: null, phone: null, e2e: null }, resumable: null };
}

// ── Mirror of server.js ────────────────────────────────────────────────────

const countLivePhones = (room) => (room.active.phone && room.active.phone.readyState === OPEN ? 1 : 0);

function derivePairState(room, forWs = null) {
  const phoneOpen = !!(room.active.phone && room.active.phone.readyState === OPEN);
  const browserOpen = !!(room.active.browser && room.active.browser.readyState === OPEN);
  const paired = phoneOpen && browserOpen;
  const claimLive = !!(room.resumable && Date.now() <= room.resumable.expiresAt);
  const state = { phonePresent: countLivePhones(room) > 0, paired, held: !paired && claimLive };
  const b = paired ? room.active.e2e : null;
  if (b && forWs && forWs.deviceId) {
    const mine = b.wraps.find((w) => w.deviceId === forWs.deviceId);
    if (mine) {
      state.e2e = { kid: b.kid, epk: b.epk, mode: b.mode, recipKeys: b.recipKeys, wrap: mine.wrap };
    }
  }
  return state;
}

function broadcastToListeners(room, msg, perSocket = null) {
  for (const s of room.lobby) {
    if (s.role === 'browser' && s.listener && s.readyState === OPEN) {
      const per = perSocket ? perSocket(s) : null;
      safeSend(s, per ?? msg);
    }
  }
}

function broadcastPairState(room) {
  broadcastToListeners(
    room,
    `PAIR_STATE:${JSON.stringify(derivePairState(room))}`,
    (s2) => (s2.deviceId ? `PAIR_STATE:${JSON.stringify(derivePairState(room, s2))}` : null),
  );
}

const lastState = (ws) => {
  const f = ws.sent.filter((m) => m.startsWith('PAIR_STATE:')).pop();
  return f ? JSON.parse(f.slice('PAIR_STATE:'.length)) : null;
};

function activeRoom(withBlock = true) {
  const room = makeRoom();
  room.active.browser = makeWs();
  room.active.phone = makeWs({ role: 'phone' });
  room.active.e2e = withBlock ? block() : null;
  return room;
}

// ── 1. THE discriminating case: two listeners, two different wraps ─────────
{
  const room = activeRoom();
  const a = listener('ext-A');
  const b = listener('ext-B');
  room.lobby.add(a);
  room.lobby.add(b);
  broadcastPairState(room);

  const sa = lastState(a);
  const sb = lastState(b);
  check('listener A got a block', Boolean(sa?.e2e));
  check('listener B got a block', Boolean(sb?.e2e));
  eq('A got A’s wrap', sa.e2e.wrap, 'WRAP-FOR-EXT-A');
  eq('B got B’s wrap', sb.e2e.wrap, 'WRAP-FOR-EXT-B');
  check('the two listeners got DIFFERENT frames', a.sent[a.sent.length - 1] !== b.sent[b.sent.length - 1]);

  // The leak assertions, stated as absence over the SERIALIZED frame so a
  // nested or renamed field cannot hide from a property check.
  const frameA = a.sent[a.sent.length - 1];
  check('A’s frame does not contain B’s wrap', !frameA.includes('WRAP-FOR-EXT-B'));
  check('A’s frame does not contain the web wrap', !frameA.includes('WRAP-FOR-WEB'));
  check('A’s frame carries no wraps[] array at all', !('wraps' in sa.e2e));
  eq('wrap is a single string', typeof sa.e2e.wrap, 'string');
}

// ── 2. recipKeys is the FULL set — the opposite treatment, deliberately ────
{
  const room = activeRoom();
  const a = listener('ext-A');
  room.lobby.add(a);
  broadcastPairState(room);
  const s = lastState(a);
  eq('recipKeys carries every static key', s.e2e.recipKeys.length, 3);
  eq('recipKeys is the pairing’s whole key set', JSON.stringify(s.e2e.recipKeys), JSON.stringify(KEYS));
  // Control: narrowing recipKeys the way wraps is narrowed would break the SAS.
  // This asserts the two fields really do differ in size, so a future "tidy"
  // that makes them symmetric fails here rather than in a user's hands.
  check('recipKeys is NOT narrowed to one entry', s.e2e.recipKeys.length > 1);
  eq('kid is carried', s.e2e.kid, 'kid-listener');
  eq('mode is carried', s.e2e.mode, 1);
  check('epk is carried', typeof s.e2e.epk === 'string' && s.e2e.epk.length === 87);
  eq('exactly the five documented fields', Object.keys(s.e2e).sort().join(','), 'epk,kid,mode,recipKeys,wrap');
}

// ── 3. absent in every case it should be absent ───────────────────────────
{
  // (a) no block in the room
  {
    const room = activeRoom(false);
    const a = listener('ext-A');
    room.lobby.add(a);
    broadcastPairState(room);
    check('no block => no e2e', !('e2e' in lastState(a)));
  }
  // (b) listener declared no deviceId (every extension build before P3)
  {
    const room = activeRoom();
    const a = listener(null);
    room.lobby.add(a);
    broadcastPairState(room);
    const s = lastState(a);
    check('no deviceId => no e2e', !('e2e' in s));
    // …and the frame is byte-identical to the pre-P1 shape.
    eq('the legacy listener frame is unchanged',
      a.sent[a.sent.length - 1],
      `PAIR_STATE:${JSON.stringify({ phonePresent: true, paired: true, held: false })}`);
  }
  // (c) a deviceId with no wrap addressed to it
  {
    const room = activeRoom();
    const a = listener('ext-NOBODY');
    room.lobby.add(a);
    broadcastPairState(room);
    const s = lastState(a);
    check('an unrecognised deviceId gets NO e2e', !('e2e' in s));
    check('…and certainly not somebody else’s wrap',
      !a.sent[a.sent.length - 1].includes('WRAP-FOR'));
  }
  // (d) not paired — held, or plainly down. A block from a previous epoch must
  //     not ride out on a PAIR_STATE that says paired:false.
  for (const [name, mutate] of [
    ['browser closed', (r) => { r.active.browser.readyState = CLOSED; }],
    ['phone closed', (r) => { r.active.phone.readyState = CLOSED; }],
    ['both gone', (r) => { r.active.browser = null; r.active.phone = null; }],
  ]) {
    const room = activeRoom();
    const a = listener('ext-A');
    room.lobby.add(a);
    mutate(room);
    broadcastPairState(room);
    const s = lastState(a);
    eq(`${name}: paired is false`, s.paired, false);
    check(`${name}: no e2e while unpaired`, !('e2e' in s));
    check(`${name}: no wrap on the wire`, !a.sent[a.sent.length - 1].includes('WRAP-FOR'));
  }
}

// ── 4. only LISTENERS get PAIR_STATE ──────────────────────────────────────
{
  const room = activeRoom();
  const lob = makeWs({ listener: false, deviceId: 'ext-A' }); // ordinary lobby browser
  const lis = listener('ext-A');
  const closed = listener('ext-B');
  closed.readyState = CLOSED;
  room.lobby.add(lob);
  room.lobby.add(lis);
  room.lobby.add(closed);
  broadcastPairState(room);
  eq('a non-listener lobby browser gets nothing', lob.sent.length, 0);
  check('the listener got one', lastState(lis) !== null);
  eq('a closed listener gets nothing', closed.sent.length, 0);
  // Even though it carries a deviceId, the ordinary browser is not a listener —
  // it gets its wrap through PAIRING_ACTIVE, not here.
  check('the non-listener saw no wrap', !lob.sent.join('').includes('WRAP-FOR'));
}

// ── 5. mixed fleet: one legacy listener + one P3 listener, same room ───────
// The realistic rollout. The legacy one must be completely unaffected.
{
  const room = activeRoom();
  const legacy = listener(null);
  const modern = listener('ext-A');
  room.lobby.add(legacy);
  room.lobby.add(modern);
  broadcastPairState(room);
  check('legacy listener: unchanged frame', !('e2e' in lastState(legacy)));
  check('modern listener: gets its wrap', lastState(modern).e2e.wrap === 'WRAP-FOR-EXT-A');
  check('the legacy listener saw no key material at all',
    !legacy.sent.join('').includes('WRAP-FOR') && !legacy.sent.join('').includes(KEYS[0]));
}

// ── 6. drift guard ────────────────────────────────────────────────────────
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function derivePairState/.test(src));
  check('derivePairState takes the target socket', /function derivePairState\(room, forWs = null\)/.test(src));
  check('the block is gated on paired', /const block = paired \? room\.active\.e2e : null;/.test(src));
  check('the wrap is selected by the listener’s own deviceId',
    /block\.wraps\.find\(\(w\) => w\.deviceId === forWs\.deviceId\)/.test(src));
  check('exactly the five fields are exposed',
    /kid: block\.kid,[\s\S]{0,200}?epk: block\.epk,[\s\S]{0,200}?mode: block\.mode,[\s\S]{0,200}?recipKeys: block\.recipKeys,[\s\S]{0,200}?wrap: mine\.wrap,/.test(src));
  check('wraps[] is never spread into the listener state',
    !/wraps: block\.wraps/.test(src));
  check('PAIR_STATE still goes through broadcastToListeners (pair-state.test.mjs pins this)',
    /broadcastToListeners\(\s*\n?\s*room,\s*\n?\s*`PAIR_STATE:/.test(src));
  check('the per-socket override only fires for a declared deviceId',
    /\(s2\) => \(s2\.deviceId \? `PAIR_STATE:/.test(src));
  check('broadcastToListeners falls back to the shared message',
    /safeSend\(s, per \?\? msg\);/.test(src));
  check('the listener deviceId is parsed from the query and bounded',
    /\/\^\[A-Za-z0-9_-\]\{1,128\}\$\//.test(src));
  check('deviceId is only set on listeners',
    /ws\.deviceId = isListener \? \(listenerDeviceId \?\? null\) : null;/.test(src));
}

const total = passed + failed;
console.log(`e2e-listener-wrap: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
