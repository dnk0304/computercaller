// Known-device auto-relink relay tests (2026-07-10).
//
// server.js cannot be imported without booting Next.js, so — following the
// established pattern in tests/repro-notification-dup.mjs — this file MIRRORS
// the relay's pairing state machine (terminateActivePair / tryAutoResume /
// stampLastPair / tryKnownDeviceRelink and the lobby-join + DEVICE_INFO call
// sites). If you change the logic in server.js, update this copy.
//
// Run: node tests/known-device-relink.test.mjs

const OPEN = 1;
const RESUME_WINDOW_MS = 120_000;
const KNOWN_PAIR_RELINK_WINDOW_MS = 10 * 60 * 1000;

let NOW = 1_000_000; // fake clock
const now = () => NOW;

function makeWs(role, userId, deviceName = null) {
  return { role, userId, deviceName, readyState: OPEN, sent: [] };
}
const safeSend = (ws, msg) => { ws.sent.push(msg); };

function makeRoom() {
  return {
    token: 't', lobby: new Set(),
    active: { browser: null, phone: null },
    pendingPairing: null, resumable: null, lastPair: null, pairIdentity: null,
  };
}

// ── Mirrors of server.js logic ─────────────────────────────────────────────

function terminateActivePair(room, reason, opts = {}) {
  const { browser, phone } = room.active;
  if (!browser && !phone) return;

  if (room.lastPair) {
    if (reason === 'user_left' && opts.leaverRole === 'phone') {
      room.lastPair = null;
    } else if (room.lastPair.endedAt == null) {
      room.lastPair.endedAt = now();
    }
  }

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
  room.resumable = null; // non-socket_closed reasons clear the claim

  if (browser) { safeSend(browser, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (browser.readyState === OPEN) room.lobby.add(browser); }
  if (phone)   { safeSend(phone,   `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (phone.readyState === OPEN) room.lobby.add(phone); }
}

// keepalive sweep half that matters: expire a lapsed claim with a held survivor
function keepaliveSweep(room) {
  const claim = room.resumable;
  if (!claim || now() <= claim.expiresAt) return;
  const onlyOneActive = (!!room.active.browser) !== (!!room.active.phone);
  if (onlyOneActive) {
    room.resumable = null;
    terminateActivePair(room, 'resume_expired');
  } else {
    room.resumable = null;
  }
}

function stampLastPair(room, phoneWs, browserWs) {
  const userId = (phoneWs.userId && phoneWs.userId === browserWs.userId) ? phoneWs.userId : null;
  room.lastPair = {
    userId,
    phoneDeviceName: phoneWs.deviceName ?? room.lastPair?.phoneDeviceName ?? null,
    browserUa: room.pairIdentity?.ua ?? null,
    pairedAt: now(), endedAt: null,
  };
}

function tryAutoResume(room) {
  const claim = room.resumable;
  if (!claim) return false;
  if (now() > claim.expiresAt) { room.resumable = null; return false; }
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
  stampLastPair(room, phoneWs, browserWs);
  return true;
}

function tryKnownDeviceRelink(room) {
  const lp = room.lastPair;
  if (!lp || lp.endedAt == null || !lp.userId) return false;
  const gap = now() - lp.endedAt;
  if (gap > KNOWN_PAIR_RELINK_WINDOW_MS) { room.lastPair = null; return false; }
  if (room.pendingPairing) return false;
  if (room.active.browser || room.active.phone) return false;
  let phoneWs = null, browserWs = null;
  for (const s of room.lobby) {
    if (s.readyState !== OPEN) continue;
    if (s.role === 'phone' && !phoneWs
        && s.userId === lp.userId
        && (s.deviceName ?? null) === (lp.phoneDeviceName ?? null)) phoneWs = s;
    else if (s.role === 'browser' && !browserWs && s.userId === lp.userId) browserWs = s;
  }
  if (!phoneWs || !browserWs) return false;
  room.lobby.delete(phoneWs); room.lobby.delete(browserWs);
  room.active.browser = browserWs; room.active.phone = phoneWs;
  room.resumable = null;
  const prevId = room.pairIdentity ?? {};
  const deviceName = phoneWs.deviceName ?? lp.phoneDeviceName ?? null;
  room.pairIdentity = { ua: prevId.ua ?? 'unknown', ip: prevId.ip ?? 'unknown', deviceLabel: prevId.deviceLabel, deviceName };
  safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
  safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: prevId.ua ?? 'unknown', ip: prevId.ip ?? 'unknown' })}`);
  lp.phoneDeviceName = deviceName;
  lp.pairedAt = now(); lp.endedAt = null;
  return true;
}

// ── Call-site mirrors ──────────────────────────────────────────────────────

function phoneJoin(room, ws) {              // phone-path lobby join
  room.lobby.add(ws);
  return tryAutoResume(room) || tryKnownDeviceRelink(room);
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- mirror kept for parity with server.js browser-join call site
function browserJoin(room, ws) {            // browser-path lobby join
  room.lobby.add(ws);
  return tryAutoResume(room) || tryKnownDeviceRelink(room);
}
function deviceInfo(room, ws, name) {       // DEVICE_INFO handler
  ws.deviceName = name;
  if (ws !== room.active.phone) {
    tryKnownDeviceRelink(room);
  } else if (room.lastPair && room.lastPair.endedAt == null && ws.deviceName) {
    room.lastPair.phoneDeviceName = ws.deviceName;
  }
}
function acceptPairing(room, phoneWs, browserWs) { // handleAcceptPairing core
  room.pendingPairing = null;
  room.lobby.delete(browserWs); room.lobby.delete(phoneWs);
  room.active.browser = browserWs; room.active.phone = phoneWs;
  room.pairIdentity = { ua: 'Chrome', ip: '1.2.3.4', deviceLabel: 'Desk', deviceName: phoneWs.deviceName ?? null };
  room.resumable = null;
  stampLastPair(room, phoneWs, browserWs);
}
function phoneSocketClosed(room, ws) {      // phone ws.on('close') active branch
  room.lobby.delete(ws);
  ws.readyState = 3;
  if (ws === room.active.phone) terminateActivePair(room, 'socket_closed');
}

// ── Scenario builder: consented pair for user U1, device "OPPO CPH2791" ───

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
const gotActive = (ws) => ws.sent.some((m) => m.startsWith('PAIRING_ACTIVE:'));

// (a) mode A — claim wiped by browser user_left during soft-hold; phone
//     rejoins at t+70s → relinked.
{
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  phoneSocketClosed(room, phone);                       // t0: blip, soft-hold
  NOW += 9_000;
  terminateActivePair(room, 'user_left', { leaverRole: 'browser' }); // stray click
  check('a1: browser user_left wiped resume claim', room.resumable === null);
  check('a2: lastPair survives browser user_left', !!room.lastPair && room.lastPair.endedAt != null);
  NOW += 61_000;                                        // t+70s
  const phone2 = makeWs('phone', 'U1');
  const joined = phoneJoin(room, phone2);               // no deviceName yet → no relink at join
  check('a3: no relink before DEVICE_INFO (deviceName guard)', joined === false);
  deviceInfo(room, phone2, 'OPPO CPH2791');
  check('a4: relinked after DEVICE_INFO', isActive(room, phone2, browser));
  check('a5: both sides got PAIRING_ACTIVE', gotActive(phone2) && gotActive(browser));
}

// (b) mode B — phone away past the 120s resume window, rejoins at t+5min →
//     relinked.
{
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  phoneSocketClosed(room, phone);                       // t0
  NOW += RESUME_WINDOW_MS + 15_000;                     // claim lapsed
  keepaliveSweep(room);                                 // survivor released to lobby
  check('b1: survivor browser back in lobby', room.lobby.has(browser) && !room.active.browser);
  check('b2: lastPair recorded ended', !!room.lastPair && room.lastPair.endedAt != null);
  NOW = 1_000_000 + 5 * 60 * 1000;                      // t+5min
  const phone2 = makeWs('phone', 'U1');
  phoneJoin(room, phone2);
  deviceInfo(room, phone2, 'OPPO CPH2791');
  check('b3: relinked at t+5min', isActive(room, phone2, browser));
  check('b4: Issue-3 claim not involved', room.resumable === null);
}

// (c) t+11min → NOT relinked, normal lobby.
{
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  NOW += RESUME_WINDOW_MS + 15_000;
  keepaliveSweep(room);
  NOW = 1_000_000 + 11 * 60 * 1000;                     // t+11min > window
  const phone2 = makeWs('phone', 'U1');
  phoneJoin(room, phone2);
  deviceInfo(room, phone2, 'OPPO CPH2791');
  check('c1: NOT relinked past window', !room.active.phone && !room.active.browser);
  check('c2: expired lastPair cleared', room.lastPair === null);
  check('c3: phone sits in normal lobby', room.lobby.has(phone2));
}

// (d) phone-side user_left → NEVER relinked, even seconds later.
{
  NOW = 1_000_000;
  const { room } = pairedRoom();
  terminateActivePair(room, 'user_left', { leaverRole: 'phone' }); // APK Disconnect
  check('d1: lastPair destroyed on phone user_left', room.lastPair === null);
  NOW += 30_000;
  const phone2 = makeWs('phone', 'U1');
  phoneJoin(room, phone2);
  deviceInfo(room, phone2, 'OPPO CPH2791');
  check('d2: NOT relinked after phone Disconnect', !room.active.phone && !room.active.browser);
}

// (e) userId mismatch → NOT relinked.
{
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  NOW += RESUME_WINDOW_MS + 15_000;
  keepaliveSweep(room);
  NOW += 60_000;
  const intruder = makeWs('phone', 'U2');               // different authed user
  phoneJoin(room, intruder);
  deviceInfo(room, intruder, 'OPPO CPH2791');           // same device name, wrong user
  check('e1: userId mismatch blocks relink', !room.active.phone && !room.active.browser);
}

// (f) deviceName mismatch → NOT relinked.
{
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  NOW += RESUME_WINDOW_MS + 15_000;
  keepaliveSweep(room);
  NOW += 60_000;
  const otherPhone = makeWs('phone', 'U1');             // same user, different handset
  phoneJoin(room, otherPhone);
  deviceInfo(room, otherPhone, 'Pixel 9');
  check('f1: deviceName mismatch blocks relink', !room.active.phone && !room.active.browser);
}

// (g) pendingPairing in flight → the explicit handshake wins.
{
  NOW = 1_000_000;
  const { room, phone } = pairedRoom();
  phoneSocketClosed(room, phone);
  NOW += RESUME_WINDOW_MS + 15_000;
  keepaliveSweep(room);
  NOW += 60_000;
  const phone2 = makeWs('phone', 'U1', 'OPPO CPH2791'); // name already known
  room.pendingPairing = { id: 'p1' };                   // Connect click mid-flight
  const joined = phoneJoin(room, phone2);
  check('g1: pendingPairing blocks relink', joined === false && !room.active.phone);
  check('g2: lastPair left intact for later', !!room.lastPair);
}

// Bonus: Issue-3 resume still fires FIRST for its own case (blip < 120s,
// claim intact) and the relink path is never consulted.
{
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  phoneSocketClosed(room, phone);                       // soft-hold, claim armed
  NOW += 30_000;
  const phone2 = makeWs('phone', 'U1');                 // no deviceName yet
  const joined = phoneJoin(room, phone2);               // tryAutoResume must catch it
  check('h1: Issue-3 resume fires first (no deviceName needed)', joined === true && isActive(room, phone2, browser));
  check('h2: lastPair refreshed by resume', !!room.lastPair && room.lastPair.endedAt === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
