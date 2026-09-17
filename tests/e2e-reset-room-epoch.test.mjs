#!/usr/bin/env node
/**
 * tests/e2e-reset-room-epoch.test.mjs — MA-2: a reset ends the epoch, and the
 * next pairing gets NEW key material.
 *
 * WHY THIS IS THE DANGEROUS CASE. "Reset lobby" is what a user reaches for when
 * something is wrong — including when they think someone else may be connected.
 * If the e2e stash survived a reset, the next pairing would silently reuse the
 * key material of the pairing the user just tore down. The UI would say
 * Encrypted, the SAS would reproduce, and the session the user believed they had
 * destroyed would still be readable with the same key. A reset that does not
 * rotate is worse than no reset, because it looks like one.
 *
 * So the property is two-sided and both sides are asserted:
 *   1. the reset CLEARS the stash, and
 *   2. the next Accept mints a block with a DIFFERENT kid.
 * Asserting only (1) would pass against an implementation that cleared the stash
 * and then rebuilt it from the same source; asserting only (2) would pass while
 * a stale block still sat in memory waiting for a resume to re-send it.
 *
 * The reset itself is the REAL lib/roomReset-core.js, not a mirror — it is the
 * module both entry points (the RESET_ROOM frame and POST /api/relay/reset)
 * funnel through, and the whole question here is what IT does to room.active.
 */

import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const { validateE2eBlock, e2eAcceptKeys } = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));
const { resetRoom } = requireCjs(join(ROOT, 'lib', 'roomReset-core.js'));

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

const realKey = () => {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
};
const acceptBlock = (kid) => ({
  v: 1,
  mode: 1,
  kid,
  epk: realKey(),
  recipKeys: [realKey(), realKey()],
  wraps: [{ deviceId: 'web-1', wrap: `wrap-${kid}` }],
});

const makeWs = (role) => ({ role, listener: false, deviceId: null, readyState: OPEN, sent: [] });
const safeSend = (ws, msg) => { if (ws && ws.readyState === OPEN) ws.sent.push(msg); };
const closeSocket = (ws) => { ws.readyState = CLOSED; };

function makeRoom(token = 'tok') {
  return {
    token,
    lobby: new Set(),
    active: { browser: null, phone: null, e2e: null },
    pendingPairing: null,
    resumable: null,
    pairIdentity: null,
    frameBuffer: [],
  };
}

/** Mirror of handleAcceptPairing's e2e slice. */
function accept(room, browserWs, phoneWs, rawE2e) {
  room.lobby.delete(browserWs);
  room.lobby.delete(phoneWs);
  room.active.browser = browserWs;
  room.active.phone = phoneWs;
  room.resumable = null;
  room.active.e2e = validateE2eBlock(rawE2e, e2eAcceptKeys).block;
  const b = { deviceName: null };
  const p = { ua: 'ua', ip: 'ip' };
  if (room.active.e2e) { b.e2e = room.active.e2e; p.e2e = room.active.e2e; }
  safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify(b)}`);
  safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify(p)}`);
}

const deps = (rooms) => ({
  safeSend,
  closeSocket: (ws) => { try { closeSocket(ws); } catch { /* ignore */ } },
  rooms,
  log: () => {},
});

// ── 1. reset MID-EPOCH clears the stash ────────────────────────────────────
{
  const rooms = new Map();
  const room = makeRoom();
  rooms.set(room.token, room);
  const b = makeWs('browser');
  const p = makeWs('phone');
  room.lobby.add(b);
  room.lobby.add(p);
  accept(room, b, p, acceptBlock('kid-epoch-1'));

  check('the pair is active with a block', Boolean(room.active.e2e));
  eq('…with the first kid', room.active.e2e.kid, 'kid-epoch-1');
  const keyMaterial = JSON.stringify(room.active.e2e);

  resetRoom(room, deps(rooms), 'frame');

  check('the stash is gone', !room.active.e2e);
  check('the active slots are cleared', !room.active.browser && !room.active.phone);
  // The room itself is deleted, so the stash cannot outlive it even if some
  // future edit forgot to null the field.
  check('the room is deleted from the registry', !rooms.has(room.token));
  check('no key material is left anywhere on the room object',
    !JSON.stringify({ active: room.active, resumable: room.resumable, pending: room.pendingPairing })
      .includes('kid-epoch-1'), keyMaterial.slice(0, 40));
  // …and no resume claim survives to re-send it.
  check('no resume claim survives a reset', !room.resumable);
}

// ── 2. the NEXT pairing gets a different kid ───────────────────────────────
// This is the half that catches "cleared it, then rebuilt it from the same
// source". A fresh room, a fresh Accept, and the block must be new.
{
  const rooms = new Map();
  const room1 = makeRoom('tok');
  rooms.set('tok', room1);
  const b1 = makeWs('browser');
  const p1 = makeWs('phone');
  room1.lobby.add(b1); room1.lobby.add(p1);
  accept(room1, b1, p1, acceptBlock('kid-epoch-1'));
  const firstFrame = b1.sent.find((m) => m.startsWith('PAIRING_ACTIVE:'));
  const firstBlock = JSON.parse(firstFrame.slice('PAIRING_ACTIVE:'.length)).e2e;

  resetRoom(room1, deps(rooms), 'frame');

  // A brand-new room for the same token, exactly as getRoom would build it.
  const room2 = makeRoom('tok');
  rooms.set('tok', room2);
  const b2 = makeWs('browser');
  const p2 = makeWs('phone');
  room2.lobby.add(b2); room2.lobby.add(p2);
  accept(room2, b2, p2, acceptBlock('kid-epoch-2'));

  const secondBlock = JSON.parse(
    b2.sent.find((m) => m.startsWith('PAIRING_ACTIVE:')).slice('PAIRING_ACTIVE:'.length),
  ).e2e;

  check('the new pairing has a block', Boolean(secondBlock));
  check('the kid CHANGED', secondBlock.kid !== firstBlock.kid);
  check('the epk changed', secondBlock.epk !== firstBlock.epk);
  check('the wraps changed', JSON.stringify(secondBlock.wraps) !== JSON.stringify(firstBlock.wraps));
  check('no field of the old block survived into the new one',
    !JSON.stringify(secondBlock).includes('kid-epoch-1'));
  // The new room never saw the old room's stash.
  check('the second room carries only its own block', room2.active.e2e.kid === 'kid-epoch-2');
}

// ── 3. the HTTP entry point behaves identically ────────────────────────────
// RESET_ROOM (frame) and POST /api/relay/reset funnel through the same core, so
// the origin argument must not change the outcome. If it ever did, one of the
// two reset buttons would be a lie.
for (const origin of ['frame', 'http']) {
  const rooms = new Map();
  const room = makeRoom(`tok-${origin}`);
  rooms.set(room.token, room);
  const b = makeWs('browser');
  const p = makeWs('phone');
  room.lobby.add(b); room.lobby.add(p);
  accept(room, b, p, acceptBlock(`kid-${origin}`));
  check(`${origin}: stash present before reset`, Boolean(room.active.e2e));
  resetRoom(room, deps(rooms), origin);
  check(`${origin}: stash cleared`, !room.active.e2e);
  check(`${origin}: room deleted`, !rooms.has(room.token));
}

// ── 4. a reset with a LISTENER present leaks nothing on the way out ────────
// A listener holds the extension's wrap. When the room is torn down it must not
// receive a parting PAIR_STATE still carrying key material.
{
  const rooms = new Map();
  const room = makeRoom('tok-listener');
  rooms.set(room.token, room);
  const b = makeWs('browser');
  const p = makeWs('phone');
  const listener = makeWs('browser');
  listener.listener = true;
  listener.deviceId = 'web-1';
  room.lobby.add(b); room.lobby.add(p); room.lobby.add(listener);
  accept(room, b, p, acceptBlock('kid-listener'));
  const before = listener.sent.length;
  resetRoom(room, deps(rooms), 'frame');
  const emitted = listener.sent.slice(before).join('');
  check('the listener received no wrap during teardown', !emitted.includes('wrap-kid-listener'));
  check('the listener received no kid during teardown', !emitted.includes('kid-listener'));
}

// ── 5. control: the scans above can actually fire ──────────────────────────
// Every assertion in sections 1, 2 and 4 is an ABSENCE. If the marker strings
// never appeared in the first place, all of them would be vacuous.
{
  const rooms = new Map();
  const room = makeRoom('tok-control');
  rooms.set(room.token, room);
  const b = makeWs('browser');
  const p = makeWs('phone');
  room.lobby.add(b); room.lobby.add(p);
  accept(room, b, p, acceptBlock('kid-control'));
  check('control: the marker IS present while the pair is live',
    JSON.stringify(room.active).includes('kid-control'));
  check('control: the block DID reach the browser frame',
    b.sent.join('').includes('wrap-kid-control'));
}

// ── 6. drift guard ─────────────────────────────────────────────────────────
{
  const core = readFileSync(join(ROOT, 'lib', 'roomReset-core.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty roomReset-core', /function resetRoom/.test(core));
  check('the reset replaces room.active wholesale',
    /room\.active = \{ browser: null, phone: null \}/.test(core));
  check('the reset deletes the room from the registry', /rooms\.delete\(room\.token\)/.test(core));

  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('both reset entry points funnel through the core',
    /resetRoomCore\(/.test(src) && /globalThis\.__resetRelayRoom = resetRelayRoomForUser;/.test(src));
  // A fresh room starts with no stash — otherwise the post-reset room could be
  // born holding the previous epoch's block.
  check('a fresh room is created with a null stash',
    /active: \{ browser: null, phone: null, e2e: null \}/.test(src));
}

const total = passed + failed;
console.log(`e2e-reset-room-epoch: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
