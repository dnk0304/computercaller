// Relay tests — relink kill + frame buffer (2026-07-16, Fix 1 + Fix 2).
//
// Replaces the obsolete known-device-relink suite. Known-device auto-relink
// was REMOVED: a torn-down pair now re-forms ONLY via an explicit Connect +
// Accept handshake. The socket_closed soft-hold (RESUME_WINDOW_MS) is kept,
// and phone data-plane frames dropped during that armed window are now buffered
// and replayed to the browser on resume.
//
// server.js cannot be imported without booting Next.js, so — following the
// established pattern in the other .mjs relay tests — this file MIRRORS the
// relay's pairing state machine. If you change the logic in server.js, update
// this copy.
//
// Run: node tests/relink-kill-frame-buffer.test.mjs

const OPEN = 1;
const RESUME_WINDOW_MS = 30_000;
const FRAME_BUFFER_MAX = 200;

let NOW = 1_000_000; // fake clock
const now = () => NOW;

function makeWs(role, userId, deviceName = null) {
  return { role, userId, deviceName, readyState: OPEN, sent: [] };
}
const safeSend = (ws, msg) => { if (ws.readyState === OPEN) { ws.sent.push(msg); return true; } return false; };

function makeRoom() {
  return {
    token: 't', lobby: new Set(),
    active: { browser: null, phone: null },
    pendingPairing: null, resumable: null, pairIdentity: null,
    frameBuffer: [],
  };
}

// ── Mirrors of server.js logic (post Fix 1 + Fix 2) ────────────────────────

function terminateActivePair(room, reason) {
  const { browser, phone } = room.active;
  if (!browser && !phone) return;

  if (reason === 'socket_closed') { // soft-hold (LEGACY_RESUME_TEARDOWN off)
    const phoneOpen = !!phone && phone.readyState === OPEN;
    const browserOpen = !!browser && browser.readyState === OPEN;
    const droppedRole = !phoneOpen ? 'phone' : 'browser';
    room.active = { browser: browserOpen ? browser : null, phone: phoneOpen ? phone : null };
    room.resumable = {
      droppedRole, droppedAt: now(), expiresAt: now() + RESUME_WINDOW_MS,
      identity: room.pairIdentity ?? null,
    };
    return;
  }

  room.active = { browser: null, phone: null };
  room.frameBuffer = []; // Fix 2: genuine teardown drops any buffered frames
  room.resumable = null; // non-socket_closed reasons clear the claim

  if (browser) { safeSend(browser, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (browser.readyState === OPEN) room.lobby.add(browser); }
  if (phone)   { safeSend(phone,   `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (phone.readyState === OPEN) room.lobby.add(phone); }
}

function tryAutoResume(room) {
  const claim = room.resumable;
  if (!claim) return false;
  if (now() > claim.expiresAt) { room.resumable = null; room.frameBuffer = []; return false; }
  if (room.pendingPairing) { room.resumable = null; return false; }
  let phoneWs = room.active.phone && room.active.phone.readyState === OPEN ? room.active.phone : null;
  let browserWs = room.active.browser && room.active.browser.readyState === OPEN ? room.active.browser : null;
  const survivorPhone = phoneWs, survivorBrowser = browserWs;
  for (const s of room.lobby) {
    if (s.role === 'phone' && !phoneWs && s.readyState === OPEN) phoneWs = s;
    else if (s.role === 'browser' && !browserWs && s.readyState === OPEN) browserWs = s;
  }
  if (!phoneWs || !browserWs) return false;
  room.lobby.delete(phoneWs); room.lobby.delete(browserWs);
  room.active.browser = browserWs; room.active.phone = phoneWs;
  room.resumable = null;
  const id = claim.identity ?? {};
  const deviceName = phoneWs.deviceName ?? id.deviceName ?? null;
  room.pairIdentity = { ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', deviceLabel: id.deviceLabel, deviceName };
  if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
  if (!survivorPhone) safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown' })}`);
  // Fix 2: replay buffered phone→browser frames in order, discard stale.
  if (room.frameBuffer && room.frameBuffer.length) {
    const cutoff = now() - RESUME_WINDOW_MS;
    for (const entry of room.frameBuffer) {
      if (entry.at < cutoff) continue;
      safeSend(browserWs, entry.msg);
    }
    room.frameBuffer = [];
  }
  return true;
}

// Drop-site mirror: a data frame from a lobby phone with no active peer.
function lobbyPhoneFrame(room, msg) {
  const claim = room.resumable;
  if (claim && now() <= claim.expiresAt) {
    if (!room.frameBuffer) room.frameBuffer = [];
    room.frameBuffer.push({ msg, at: now() });
    if (room.frameBuffer.length > FRAME_BUFFER_MAX) room.frameBuffer.shift();
    return 'buffered';
  }
  return 'dropped';
}

// ── Call-site mirrors ──────────────────────────────────────────────────────

function phoneJoin(room, ws) {              // phone-path lobby join (Fix 1: resume only)
  room.lobby.add(ws);
  return tryAutoResume(room);
}
function browserJoin(room, ws) {            // browser-path lobby join (Fix 1: resume only)
  room.lobby.add(ws);
  return tryAutoResume(room);
}
function deviceInfo(room, ws, name) {       // DEVICE_INFO handler (Fix 1: no relink)
  ws.deviceName = name;
  // deviceName captured; no silent relink.
}
function acceptPairing(room, phoneWs, browserWs) { // handleAcceptPairing core
  room.pendingPairing = null;
  room.lobby.delete(browserWs); room.lobby.delete(phoneWs);
  room.active.browser = browserWs; room.active.phone = phoneWs;
  room.pairIdentity = { ua: 'Chrome', ip: '1.2.3.4', deviceLabel: 'Desk', deviceName: phoneWs.deviceName ?? null };
  room.resumable = null;
}
function phoneSocketClosed(room, ws) {      // phone ws.on('close') active branch
  room.lobby.delete(ws);
  ws.readyState = 3;
  if (ws === room.active.phone) terminateActivePair(room, 'socket_closed');
}

function pairedRoom() {
  const room = makeRoom();
  const phone = makeWs('phone', 'U1');
  const browser = makeWs('browser', 'U1');
  room.lobby.add(phone); room.lobby.add(browser);
  acceptPairing(room, phone, browser);
  deviceInfo(room, phone, 'OPPO CPH2791');
  return { room, phone, browser };
}

// ── Test runner ────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
const isActive = (room, phone, browser) =>
  room.active.phone === phone && room.active.browser === browser;

// (a) NO relink after teardown — two idle lobby sockets do NOT auto-pair.
{
  NOW = 1_000_000;
  const { room, browser } = pairedRoom();
  // Full teardown (phone Disconnect). Both sides land back in the lobby.
  terminateActivePair(room, 'user_left');
  check('a1: no active pair after teardown', !room.active.phone && !room.active.browser);
  check('a2: no resume claim after user_left', room.resumable === null);
  // Both idle in lobby, minutes pass, a fresh phone rejoins with same identity.
  NOW += 5 * 60 * 1000;
  const phone2 = makeWs('phone', 'U1');
  const joined = phoneJoin(room, phone2);
  deviceInfo(room, phone2, 'OPPO CPH2791');
  check('a3: idle lobby sockets do NOT auto-relink', joined === false && !room.active.phone && !room.active.browser);
  // Only an explicit Connect + Accept re-forms the pair.
  room.pendingPairing = { id: 'p1' };
  acceptPairing(room, phone2, browser);
  check('a4: explicit Connect+Accept re-forms the pair', isActive(room, phone2, browser));
}

// (b) Buffered frames replay on soft-hold resume within window.
{
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  browser.sent = []; // clear pair-time frames
  phoneSocketClosed(room, phone);                 // t0: blip → soft-hold, claim armed, browser survives
  NOW += 5_000;
  // Phone re-attaches as a NEW lobby socket and streams frames before resume.
  const phone2 = makeWs('phone', 'U1');
  room.lobby.add(phone2);
  check('b1: frame buffered during armed window', lobbyPhoneFrame(room, 'SMS_RECEIVED:{"id":1}') === 'buffered');
  check('b2: second frame buffered', lobbyPhoneFrame(room, 'PHONE_NOTIFICATION:{"id":2}') === 'buffered');
  check('b3: buffer holds 2', room.frameBuffer.length === 2);
  // Resume fires (both roles present).
  const resumed = tryAutoResume(room);
  check('b4: resumed', resumed === true && isActive(room, phone2, browser));
  check('b5: both buffered frames replayed to browser in order',
    browser.sent.includes('SMS_RECEIVED:{"id":1}') &&
    browser.sent.includes('PHONE_NOTIFICATION:{"id":2}') &&
    browser.sent.indexOf('SMS_RECEIVED:{"id":1}') < browser.sent.indexOf('PHONE_NOTIFICATION:{"id":2}'));
  check('b6: buffer cleared after replay', room.frameBuffer.length === 0);
}

// (b') Overflow — buffer is bounded at FRAME_BUFFER_MAX (drop-oldest).
{
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  for (let i = 0; i < FRAME_BUFFER_MAX + 50; i++) lobbyPhoneFrame(room, `SMS_RECEIVED:{"id":${i}}`);
  check('b7: buffer capped at FRAME_BUFFER_MAX', room.frameBuffer.length === FRAME_BUFFER_MAX);
  check('b8: oldest dropped, newest kept', room.frameBuffer[room.frameBuffer.length - 1].msg === `SMS_RECEIVED:{"id":${FRAME_BUFFER_MAX + 49}}`);
}

// (c) Buffer cleared on teardown / claim expiry.
{
  // c-teardown: full teardown while frames are buffered clears them.
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  lobbyPhoneFrame(room, 'SMS_RECEIVED:{"id":1}');
  check('c1: frame buffered', room.frameBuffer.length === 1);
  terminateActivePair(room, 'resume_expired');    // genuine teardown
  check('c2: buffer cleared on teardown', room.frameBuffer.length === 0);

  // c-expiry: no active peer at all → a frame past the window is dropped, buffer stays empty.
  NOW = 1_000_000;
  const { room: room2, phone: phone2 } = pairedRoom();
  phoneSocketClosed(room2, phone2);
  NOW += RESUME_WINDOW_MS + 1_000;                 // claim lapsed
  check('c3: frame dropped once claim expired', lobbyPhoneFrame(room2, 'SMS_RECEIVED:{"id":9}') === 'dropped');
  check('c4: buffer stays empty when no armed claim', room2.frameBuffer.length === 0);
  // A subsequent tryAutoResume sees the lapsed claim and clears buffer defensively.
  tryAutoResume(room2);
  check('c5: lapsed-claim resume clears buffer', room2.frameBuffer.length === 0);
}

// (d) Soft-hold (Issue-3) resume still works for a genuine <30s blip.
{
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  phoneSocketClosed(room, phone);                  // soft-hold, claim armed
  NOW += 10_000;
  const phone2 = makeWs('phone', 'U1');
  const joined = phoneJoin(room, phone2);          // tryAutoResume must catch it
  check('d1: soft-hold resume fires within window', joined === true && isActive(room, phone2, browser));
}

void browserJoin; // mirror kept for parity with server.js browser-join call site


// ── (e) the sealed twin: Fix 1 + Fix 2 are MODE-BLIND, and a relink KILLS the
//        sealed frame buffer (E2E-P6 (a)) ──────────────────────────────────────
//
// §13.7 keeps the frame TYPE and replaces only the BODY, so every decision the
// mirrors above make — buffer or drop, resume or refuse, replay or clear — is
// made on bytes that a session does not change. This section runs each of those
// scenarios twice over the SAME mirrors and requires the transcripts to agree.
//
// It also carries the one assertion here that is a security property rather
// than a compatibility property: a frame sealed under kid K must not survive
// into a pair that is no longer using K. A buffered ciphertext that outlives its
// kid is a frame the new browser cannot open and the old one should never see
// again, and "it will just fail to decrypt" is not a containment argument — the
// bytes should not be reachable at all.
//
// SCOPE: this twins the MIRROR. It proves the modelled state machine has no
// body-dependent branch; it is not evidence about the shipped relay (P6 (g) is).
// See tests/lib/sealed-twin.mjs's header.

import { twin, transcript, openBody, assertNoPlaintext, makeTestSession, sealBody } from './lib/sealed-twin.mjs';

const CANARY = 'CANARY-RELINK-9c2f4b71 a buffered body must never outlive its kid';

/** Every place a frame could still be sitting after the state machine moved. */
function reachableFrames(room, sockets) {
  const out = [];
  for (const e of room.frameBuffer || []) out.push(e.msg);
  for (const s of sockets) for (const m of s.sent) out.push(m);
  for (const s of room.lobby) for (const m of s.sent) out.push(m);
  if (room.active.phone) out.push(...room.active.phone.sent);
  if (room.active.browser) out.push(...room.active.browser.sent);
  return out;
}

// (e1) The soft-hold buffer/replay path, twinned.
{
  const scn = twin((mode) => {
    NOW = 1_000_000;
    const { room, phone, browser } = pairedRoom();
    browser.sent = [];
    phoneSocketClosed(room, phone);            // blip → soft-hold, claim armed
    NOW += 5_000;
    const phone2 = makeWs('phone', 'U1');
    room.lobby.add(phone2);
    const bodies = [
      mode.body('SMS_RECEIVED', { from: '+4791234567', body: CANARY }),
      mode.body('PHONE_NOTIFICATION', { title: `${CANARY}-title` }),
    ];
    const r1 = lobbyPhoneFrame(room, `SMS_RECEIVED:${JSON.stringify(bodies[0])}`);
    const r2 = lobbyPhoneFrame(room, `PHONE_NOTIFICATION:${JSON.stringify(bodies[1])}`);
    const buffered = room.frameBuffer.length;
    const resumed = tryAutoResume(room);
    return { room, phone, phone2, browser, bodies, r1, r2, buffered, resumed };
  });

  const r = scn.agrees((o) => o.browser.sent);
  check('e1: replayed transcript is identical plaintext vs sealed' + (r.equal ? '' : ` — ${JSON.stringify(r)}`), r.equal);
  check('e2: the buffer/drop decision is identical',
    scn.plain.r1 === scn.sealed.r1 && scn.plain.r2 === scn.sealed.r2 && scn.sealed.r1 === 'buffered');
  check('e3: the resume decision is identical',
    scn.plain.resumed === scn.sealed.resumed && scn.sealed.resumed === true);
  check('e4: the same number of frames was buffered',
    scn.plain.buffered === scn.sealed.buffered && scn.sealed.buffered === 2);
  // The control arm — without it every assertion above would hold over an empty
  // transcript produced by a mirror that replayed nothing.
  check('e5: the replayed transcript is NOT empty',
    transcript(scn.sealed.browser.sent).length === 2 &&
    transcript(scn.sealed.browser.sent)[0].type === 'SMS_RECEIVED');
  // Verbatim passthrough: the relay buffered bytes and handed back those bytes.
  {
    const out = JSON.parse(scn.sealed.browser.sent[0].slice('SMS_RECEIVED:'.length));
    let opened = null;
    try { opened = openBody(scn.session, 'SMS_RECEIVED', out); } catch (e) { opened = { err: String(e) }; }
    check('e6: the replayed envelope equals the buffered envelope, byte for byte',
      JSON.stringify(out) === JSON.stringify(scn.sealed.bodies[0]));
    check('e7: …and it still opens after buffering + replay',
      opened && opened.body === CANARY && opened.from === '+4791234567');
  }
  // No plaintext anywhere the relay held it.
  {
    const hay = JSON.stringify({
      replayed: scn.sealed.browser.sent,
      buffer: scn.sealed.room.frameBuffer,
      lobby: [...scn.sealed.room.lobby].map((s) => s.sent),
    });
    const secrets = { from: '+4791234567', body: CANARY, title: `${CANARY}-title` };
    const res = assertNoPlaintext(hay, secrets);
    check('e8: no fragment of a sealed body survives in the relay\'s buffer or replay' +
      (res.clean ? '' : ` — ${JSON.stringify(res.leaked)}`), res.clean);
    const ctrl = assertNoPlaintext(JSON.stringify(scn.plain.browser.sent), secrets);
    check('e9: …and the plaintext arm genuinely does leak it (the detector works)',
      ctrl.clean === false && ctrl.leaked.includes(CANARY));
  }
}

// (e10) Fix 1 — a teardown kills the pair, and no idle relink re-forms it. Mode
//       must not change that: a relay that "helpfully" kept a pair alive because
//       a session existed would be the exact bug Fix 1 removed.
{
  const scn = twin((mode) => {
    NOW = 1_000_000;
    const { room, browser } = pairedRoom();
    const body = mode.body('SMS_RECEIVED', { body: CANARY });
    phoneSocketClosed(room, room.active.phone);
    lobbyPhoneFrame(room, `SMS_RECEIVED:${JSON.stringify(body)}`);
    const bufferedBefore = room.frameBuffer.length;
    terminateActivePair(room, 'user_left');                 // genuine teardown
    NOW += 5 * 60 * 1000;
    const phone2 = makeWs('phone', 'U1');
    const joined = phoneJoin(room, phone2);                 // must NOT relink
    return { room, browser, phone2, joined, bufferedBefore, body };
  });
  check('e10: a frame was genuinely buffered before the teardown',
    scn.plain.bufferedBefore === 1 && scn.sealed.bufferedBefore === 1);
  check('e11: the relink decision is identical with and without a session',
    scn.plain.joined === scn.sealed.joined && scn.sealed.joined === false);
  check('e12: no pair re-formed in either arm',
    !scn.sealed.room.active.phone && !scn.sealed.room.active.browser &&
    !scn.plain.room.active.phone && !scn.plain.room.active.browser);
  const r = scn.agrees((o) => o.browser.sent);
  check('e13: the browser transcript across teardown is identical' + (r.equal ? '' : ` — ${JSON.stringify(r)}`), r.equal);
  check('e14: that transcript is NOT empty (PAIRING_TERMINATED really was sent)',
    transcript(scn.sealed.browser.sent).some((t) => t.type === 'PAIRING_TERMINATED'));
}

// (e15) THE security twin. A relink must KILL the sealed frame buffer: after the
//       pair re-forms under a NEW kid, not one frame sealed under the OLD kid may
//       remain reachable from anywhere.
{
  NOW = 1_000_000;
  const oldSession = makeTestSession({ kid: 'kid-OLD-relink', secret: 'p6-old-epoch' });
  const newSession = makeTestSession({ kid: 'kid-NEW-relink', secret: 'p6-new-epoch' });

  const { room, phone, browser } = pairedRoom();
  browser.sent = [];
  phoneSocketClosed(room, phone);                            // soft-hold
  // Three frames sealed under the OLD kid pile up in the buffer.
  const oldWire = [0, 1, 2].map((i) =>
    `SMS_RECEIVED:${JSON.stringify(sealBody(oldSession, 'SMS_RECEIVED', { i, body: `${CANARY}-${i}` }))}`);
  for (const w of oldWire) lobbyPhoneFrame(room, w);
  check('e15: three OLD-kid frames are buffered during the hold', room.frameBuffer.length === 3);
  check('e16: they really do carry the old kid',
    room.frameBuffer.every((e) => JSON.parse(e.msg.slice('SMS_RECEIVED:'.length)).kid === 'kid-OLD-relink'));

  // The relink: a genuine teardown, then an explicit Connect + Accept under a
  // new epoch. This is the ONLY way a pair re-forms after Fix 1.
  terminateActivePair(room, 'user_left');
  check('e17: the teardown killed the buffer', room.frameBuffer.length === 0);

  NOW += 60_000;
  const phone2 = makeWs('phone', 'U1');
  const browser2 = makeWs('browser', 'U1');
  room.lobby.add(phone2); room.lobby.add(browser2);
  room.pendingPairing = { id: 'p-new' };
  acceptPairing(room, phone2, browser2);
  check('e18: the new pair is live', isActive(room, phone2, browser2));

  // A frame under the NEW kid flows normally — the control arm proving the new
  // pair is genuinely carrying traffic, so e19/e20 are not green by paralysis.
  const newWire = `SMS_RECEIVED:${JSON.stringify(sealBody(newSession, 'SMS_RECEIVED', { i: 99, body: `${CANARY}-new` }))}`;
  safeSend(browser2, newWire);
  check('e19: the new pair carries a NEW-kid frame', browser2.sent.includes(newWire));

  // THE assertion. Every place a frame could still be: buffer, both survivors,
  // both new sockets, every lobby socket.
  const reachable = reachableFrames(room, [browser, phone, phone2, browser2]);
  const staleKids = reachable
    .filter((m) => m.startsWith('SMS_RECEIVED:'))
    .map((m) => { try { return JSON.parse(m.slice('SMS_RECEIVED:'.length)).kid; } catch { return null; } })
    .filter((k) => k === 'kid-OLD-relink');
  check(`e20: after the relink NO frame sealed under the old kid is reachable anywhere (found ${staleKids.length})`,
    staleKids.length === 0);
  check('e21: and the old ciphertext bytes are gone too, not merely unparsed',
    oldWire.every((w) => !reachable.includes(w)));
  // The resume path is the other way a buffered frame could escape: arm a claim
  // again and confirm nothing old comes back out.
  browser2.sent = [];
  room.resumable = { droppedRole: 'phone', droppedAt: now(), expiresAt: now() + RESUME_WINDOW_MS, identity: null };
  tryAutoResume(room);
  check('e22: a later resume replays nothing from the dead epoch',
    !browser2.sent.some((m) => m.includes('kid-OLD-relink')));
  // And the plaintext of those old bodies never existed on the wire at all.
  const res = assertNoPlaintext(JSON.stringify(reachable.concat(browser2.sent)), {
    a: `${CANARY}-0`, b: `${CANARY}-1`, c: `${CANARY}-2`, d: `${CANARY}-new`,
  });
  check('e23: no old or new sealed body leaked in plaintext' + (res.clean ? '' : ` — ${JSON.stringify(res.leaked)}`), res.clean);
}

// (e24) Claim expiry is mode-blind too — the other path that must drop bytes.
{
  const scn = twin((mode) => {
    NOW = 1_000_000;
    const { room, phone } = pairedRoom();
    phoneSocketClosed(room, phone);
    const body = mode.body('SMS_RECEIVED', { body: CANARY });
    NOW += RESUME_WINDOW_MS + 1_000;                        // claim lapsed
    const verdict = lobbyPhoneFrame(room, `SMS_RECEIVED:${JSON.stringify(body)}`);
    tryAutoResume(room);
    return { room, verdict };
  });
  check('e24: an expired claim drops the frame in both arms',
    scn.plain.verdict === 'dropped' && scn.sealed.verdict === 'dropped');
  check('e25: the buffer is empty in both arms',
    scn.plain.room.frameBuffer.length === 0 && scn.sealed.room.frameBuffer.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
