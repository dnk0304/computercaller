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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
