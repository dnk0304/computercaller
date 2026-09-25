#!/usr/bin/env node
/**
 * tests/e2e-resume-carries-block.test.mjs — P1(b): a resume re-sends the SAME
 * block, and a teardown does not.
 *
 * The bug this exists to prevent is quiet and expensive. A hold/dock/resume is
 * NOT a re-pair: nobody tapped Accept, so no new key material exists, and the
 * returning socket carries none of its own. If the relay mints a block here it
 * invents keys nobody holds; if it omits one, the pair silently continues in
 * plaintext while both UIs still say Encrypted. Either way the failure appears
 * only on reconnect, only in Encrypted mode, and looks like "it works on my
 * machine" to anyone who pairs once and never blips.
 *
 * So the contract is byte-identity, asserted as BYTES and not as "same kid":
 * a block with the right kid and a re-ordered wraps array would pass a kid check
 * and still break every party that hashed the original into its SAS transcript.
 *
 * The second half is the lifecycle. The stash lives and dies with the RESUME
 * CLAIM — surviving exactly the drops that will silently re-form this pair, and
 * cleared by every deliberate teardown. That is one condition, not two, which is
 * the point: a separate rule for the block would be a second thing to keep in
 * step with room.resumable, and the two would drift.
 *
 * server.js cannot be imported without booting the server, so — following the
 * established pattern in the other .mjs relay tests (dock-resume, pair-state,
 * session-superseded) — this file MIRRORS the relevant state machine, and then
 * pins the mirror to the real thing with a comment-stripped drift guard over
 * server.js's source. The mirror alone would only prove the mirror is
 * self-consistent.
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

const OPEN = 1;
const CLOSED = 3;
let NOW = 1_000_000;
const now = () => NOW;

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
function acceptBlock(kid = 'kid-1') {
  return {
    v: 1,
    mode: 1,
    kid,
    epk: realKey(),
    recipKeys: [realKey(), realKey(), realKey()],
    wraps: [
      { deviceId: 'web-1', wrap: 'd2ViLXdyYXA' },
      { deviceId: 'ext-1', wrap: 'ZXh0LXdyYXA' },
    ],
  };
}

const makeWs = (role, over = {}) => ({ role, listener: false, deviceName: null, readyState: OPEN, sent: [], ...over });
const safeSend = (ws, msg) => { if (ws && ws.readyState === OPEN) ws.sent.push(msg); };
const framesOf = (ws, prefix) => ws.sent.filter((m) => m.startsWith(prefix));
const payloadOf = (frame, prefix) => JSON.parse(frame.slice(prefix.length));

function makeRoom() {
  return {
    token: 't',
    lobby: new Set(),
    active: { browser: null, phone: null, e2e: null },
    pendingPairing: null,
    resumable: null,
    pairIdentity: null,
    frameBuffer: [],
  };
}

// ── Mirror of server.js (the e2e-relevant slices only) ─────────────────────

function mirrorAccept(room, browserWs, phoneWs, rawE2e) {
  room.active.browser = browserWs;
  room.active.phone = phoneWs;
  room.pairIdentity = { ua: 'ua', ip: 'ip', deviceLabel: null, deviceName: null };
  room.resumable = null;
  const acceptCheck = validateE2eBlock(rawE2e, e2eAcceptKeys);
  room.active.e2e = acceptCheck.block;
  const browserActive = { deviceName: null };
  const phoneActive = { ua: 'ua', ip: 'ip' };
  if (room.active.e2e) {
    browserActive.e2e = room.active.e2e;
    phoneActive.e2e = room.active.e2e;
  }
  safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify(browserActive)}`);
  safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify(phoneActive)}`);
  return acceptCheck;
}

function mirrorTerminate(room, reason, { legacy = false } = {}) {
  const { browser, phone } = room.active;
  if (!browser && !phone) return;
  const priorE2e = room.active.e2e ?? null;
  if (reason === 'socket_closed' && !legacy) {
    const phoneOpen = !!phone && phone.readyState === OPEN;
    const browserOpen = !!browser && browser.readyState === OPEN;
    const droppedRole = !phoneOpen ? 'phone' : 'browser';
    room.active = { browser: browserOpen ? browser : null, phone: phoneOpen ? phone : null, e2e: priorE2e };
    room.resumable = {
      droppedRole, droppedAt: now(), expiresAt: now() + 180_000,
      panelHold: false, identity: room.pairIdentity ?? null,
    };
    return;
  }
  room.active = { browser: null, phone: null, e2e: reason === 'socket_closed' ? priorE2e : null };
  room.resumable = reason === 'socket_closed'
    ? { droppedRole: 'browser', droppedAt: now(), expiresAt: now() + 180_000, identity: room.pairIdentity ?? null }
    : null;
}

function mirrorResume(room, browserWs, phoneWs, { survivorBrowser = false, survivorPhone = false } = {}) {
  room.active.browser = browserWs;
  room.active.phone = phoneWs;
  const id = room.resumable?.identity ?? {};
  const resumeMark = { resumed: true, held: true, gapMs: 10 };
  const e2eResume = room.active.e2e ? { e2e: room.active.e2e } : {};
  if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName: null, ...e2eResume, ...resumeMark })}`);
  if (!survivorPhone) safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', ...e2eResume, ...resumeMark })}`);
  room.resumable = null;
}

// ── 1. Accept carries the block to BOTH sides ──────────────────────────────
{
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  const block = acceptBlock();
  const out = mirrorAccept(room, b, p, block);
  eq('the accept block validates', out.reason, null);
  const bp = payloadOf(framesOf(b, 'PAIRING_ACTIVE:')[0], 'PAIRING_ACTIVE:');
  const pp = payloadOf(framesOf(p, 'PAIRING_ACTIVE:')[0], 'PAIRING_ACTIVE:');
  check('the browser got the block', Boolean(bp.e2e));
  check('the phone got the block', Boolean(pp.e2e));
  eq('both sides got the SAME bytes', JSON.stringify(bp.e2e), JSON.stringify(pp.e2e));
  eq('the block is unchanged from what the phone sent', JSON.stringify(bp.e2e), JSON.stringify(block));
  // The existing plaintext fields must be untouched — a v55 APK and the /app
  // web client parse these and know nothing about e2e.
  eq('the browser payload keeps deviceName', 'deviceName' in bp, true);
  eq('the phone payload keeps ua', pp.ua, 'ua');
  eq('the phone payload keeps ip', pp.ip, 'ip');
  check('the stash holds the same object the frames carried', room.active.e2e === block);
}

// ── 2. no block => the frames are byte-identical to the plaintext shape ────
// This is the backward-compatibility assertion. Every pairing that exists today
// is plaintext, and none of them may change by a single byte.
{
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  mirrorAccept(room, b, p, undefined);
  eq('plaintext browser PAIRING_ACTIVE is unchanged',
    framesOf(b, 'PAIRING_ACTIVE:')[0], `PAIRING_ACTIVE:${JSON.stringify({ deviceName: null })}`);
  eq('plaintext phone PAIRING_ACTIVE is unchanged',
    framesOf(p, 'PAIRING_ACTIVE:')[0], `PAIRING_ACTIVE:${JSON.stringify({ ua: 'ua', ip: 'ip' })}`);
  eq('no stash', room.active.e2e, null);
}

// ── 3. a MALFORMED accept block degrades to plaintext, it does not fail ────
{
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  const bad = acceptBlock();
  bad.epk = 'not-a-key';
  const out = mirrorAccept(room, b, p, bad);
  eq('a bad epk is reported as badkey', out.reason, 'badkey');
  eq('no stash', room.active.e2e, null);
  const bp = payloadOf(framesOf(b, 'PAIRING_ACTIVE:')[0], 'PAIRING_ACTIVE:');
  check('the pair still formed, in plaintext', !('e2e' in bp));
}
// Duplicate deviceIds in wraps must be refused: the relay is the only party
// that sees the whole list, and P1(c) has to pick out "the extension's own
// wrap" from it. Two wraps for one deviceId makes that pick ambiguous.
{
  const dup = acceptBlock();
  dup.wraps = [{ deviceId: 'ext-1', wrap: 'aa' }, { deviceId: 'ext-1', wrap: 'bb' }];
  eq('duplicate wrap deviceIds are badshape', validateE2eBlock(dup, e2eAcceptKeys).reason, 'badshape');
}

// ── 4. HOLD → RESUME re-sends byte-identical bytes, same kid ───────────────
for (const legacy of [false, true]) {
  const label = legacy ? 'legacy full teardown' : 'soft hold';
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  const block = acceptBlock('kid-resume');
  mirrorAccept(room, b, p, block);
  const original = framesOf(b, 'PAIRING_ACTIVE:')[0];
  const originalE2eBytes = JSON.stringify(payloadOf(original, 'PAIRING_ACTIVE:').e2e);

  // the browser blips
  b.readyState = CLOSED;
  mirrorTerminate(room, 'socket_closed', { legacy });
  check(`${label}: the stash survives the drop`, Boolean(room.active.e2e));
  check(`${label}: a resume claim is armed`, Boolean(room.resumable));

  NOW += 10;
  const b2 = makeWs('browser');
  mirrorResume(room, b2, p, { survivorPhone: !legacy });
  const resumed = framesOf(b2, 'PAIRING_ACTIVE:')[0];
  check(`${label}: the returning socket got a PAIRING_ACTIVE`, Boolean(resumed));
  const rp = payloadOf(resumed, 'PAIRING_ACTIVE:');
  check(`${label}: the resume carries a block`, Boolean(rp.e2e));
  eq(`${label}: the resumed block is BYTE-identical`, JSON.stringify(rp.e2e), originalE2eBytes);
  eq(`${label}: same kid`, rp.e2e.kid, 'kid-resume');
  // …and the resume marker still rides alongside it, unchanged.
  eq(`${label}: resumed marker preserved`, rp.resumed, true);
  check(`${label}: gapMs preserved`, typeof rp.gapMs === 'number');
}

// ── 4b. byte-identity is stronger than "same kid" ──────────────────────────
// A re-ordered wraps array has the same kid and different bytes. If the relay
// ever rebuilt the block instead of re-sending the stashed object, this is the
// shape the bug would take — and a kid-only assertion would wave it through.
{
  const a = acceptBlock('kid-x');
  const reordered = { ...a, wraps: [...a.wraps].reverse() };
  eq('control: the re-ordered block has the same kid', reordered.kid, a.kid);
  check('control: …but NOT the same bytes', JSON.stringify(reordered) !== JSON.stringify(a));
}

// ── 5. the stash dies with the claim ───────────────────────────────────────
for (const reason of ['user_left', 'resume_expired', 'something_else']) {
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  mirrorAccept(room, b, p, acceptBlock());
  check(`stash present before ${reason}`, Boolean(room.active.e2e));
  mirrorTerminate(room, reason);
  eq(`${reason} CLEARS the stash`, room.active.e2e, null);
  eq(`${reason} clears the resume claim too`, room.resumable, null);
}
// The discriminating pair: the SAME teardown function keeps it for
// socket_closed. Without this, "clears the stash" would be satisfiable by a
// function that clears it unconditionally — which would break every resume.
{
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  mirrorAccept(room, b, p, acceptBlock());
  b.readyState = CLOSED;
  mirrorTerminate(room, 'socket_closed', { legacy: true });
  check('socket_closed KEEPS the stash (the discriminating case)', Boolean(room.active.e2e));
}
// Reset lobby: roomReset-core replaces room.active wholesale and deletes the
// room. Asserted against the REAL module, not a mirror.
{
  const roomReset = requireCjs(join(ROOT, 'lib', 'roomReset-core.js'));
  const rooms = new Map();
  const room = makeRoom();
  const b = makeWs('browser');
  const p = makeWs('phone');
  mirrorAccept(room, b, p, acceptBlock());
  rooms.set(room.token, room);
  roomReset.resetRoom(room, {
    safeSend,
    closeSocket: (ws) => { ws.readyState = CLOSED; },
    rooms,
    log: () => {},
  }, 'test');
  check('reset lobby drops the stash', !room.active.e2e);
  check('reset lobby deletes the room, so the stash cannot outlive it', !rooms.has(room.token));
}

// ── 6. drift guard: the mirror above matches the real server.js ────────────
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function terminateActivePair/.test(src));
  check('the accept path validates with the accept extractor',
    /validateE2eBlock\(payload\?\.e2e,\s*e2eAcceptKeys\)/.test(src));
  check('the stash is assigned from the validated block',
    /room\.active\.e2e = acceptCheck\.block;/.test(src));
  check('both PAIRING_ACTIVE payloads get the SAME stash object',
    /browserActive\.e2e = room\.active\.e2e;/.test(src) && /phoneActive\.e2e = room\.active\.e2e;/.test(src));
  check('the room declares the stash slot up front',
    /active: \{ browser: null, phone: null, e2e: null \}/.test(src));
  check('terminateActivePair captures the stash before reassigning room.active',
    /const priorE2e = room\.active\.e2e \?\? null;/.test(src));
  check('the soft-hold path KEEPS the stash', /phoneOpen \? phone : null, e2e: priorE2e \}/.test(src));
  check('the teardown path keeps it ONLY for socket_closed',
    /e2e: reason === 'socket_closed' \? priorE2e : null \}/.test(src));
  check('the resume path re-sends the stashed object itself',
    /const e2eResume = room\.active\.e2e \? \{ e2e: room\.active\.e2e \} : \{\};/.test(src));
  // T-RESUME-PHONE-RESTART-DESYNC. The phone's payload now spreads `phoneMark`,
  // which is `resumeMark` with `peerSession` destructured OUT: peerSession is
  // the PAGE's re-verification input and the phone has no use for a report
  // about itself. The e2e block half — which is ALL this suite is about — is
  // unchanged and still the same stash object on both sends, so the count
  // control stays at 2 and only the phone-side marker name moves.
  check('BOTH resume sends carry it',
    (src.match(/\.\.\.e2eResume, \.\.\.(resumeMark|phoneMark)/g) || []).length === 2);
  // ...and the split is real, not a rename: the browser gets resumeMark, the
  // phone gets the stripped copy. Pinned so peerSession cannot quietly start
  // travelling to the phone, or stop travelling to the browser.
  check('the BROWSER send carries the full marker and the PHONE send the stripped one',
    /\.\.\.e2eResume, \.\.\.resumeMark \}\)\}`\);/.test(src)
    && /const phoneMark = \{ resumed: resumeMark\.resumed, held: resumeMark\.held, gapMs: resumeMark\.gapMs \};/.test(src));
  check('the resume path never rebuilds a block',
    !/kid:\s*/.test(src.slice(src.indexOf('const e2eResume'), src.indexOf('const e2eResume') + 800)));
}

const total = passed + failed;
console.log(`e2e-resume-carries-block: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
