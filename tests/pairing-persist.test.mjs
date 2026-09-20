// Relay tests — phone pairing survives a side-panel close (FORGE-L, 2026-09-15).
//
// Dennis: "i would like the phone pairing to be kept for the same amount of
// time like in the official webapp. Not just 3 minutes."
//
// The web app stays paired for as long as its TAB is open, because that tab
// owns the interactive browser socket. In the extension that socket lives in
// the side-panel iframe, so closing the panel killed it and the pair had only
// RESUME_WINDOW_MS (180 s) to live. But the extension also keeps a
// `?role=listener` socket owned by its MV3 service worker — the extension's
// equivalent of the web app's open tab, and (since FORGE-J's 15 s app-level
// HB frame) a trustworthy liveness signal.
//
// Option (b): while the dropped side is the BROWSER and a live listener is in
// the room, the keepalive tick RENEWS the resume claim. The claim falls back
// to ordinary 180 s expiry only once the listener has been continuously ABSENT
// for LISTENER_HOLD_GRACE_MS. Never applied when the PHONE is the dropped side.
//
// server.js cannot be imported without booting Next.js, so — following the
// established pattern in the other .mjs relay tests — this file MIRRORS the
// relay's pairing state machine. If you change the logic in server.js, update
// this copy.
//
// Run: node tests/pairing-persist.test.mjs

const OPEN = 1;
const CLOSED = 3;
const RESUME_WINDOW_MS = 180_000;
const LISTENER_HOLD_GRACE_MS = 10 * 60_000;
const KEEPALIVE_TICK_MS = 15_000;
const FRAME_BUFFER_MAX = 200;

let NOW = 1_000_000; // fake clock
const now = () => NOW;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

function makeWs(role, { listener = false, deviceName = null } = {}) {
  return { role, listener, deviceName, readyState: OPEN, sent: [] };
}
const safeSend = (ws, msg) => { if (ws.readyState === OPEN) { ws.sent.push(msg); return true; } return false; };
const gotFrame = (ws, prefix) => ws.sent.some((m) => m.startsWith(prefix));
const countFrames = (ws, prefix) => ws.sent.filter((m) => m.startsWith(prefix)).length;

function makeRoom() {
  return {
    token: 't', lobby: new Set(),
    active: { browser: null, phone: null },
    pendingPairing: null, resumable: null, pairIdentity: null, lastResume: null,
    frameBuffer: [],
  };
}

// ── Mirrors of server.js logic ─────────────────────────────────────────────

// server.js hasLiveListener(). Listeners only ever live in room.lobby — they
// are never promoted into room.active.
function hasLiveListener(room) {
  if (!room || !room.lobby) return false;
  for (const s of room.lobby) {
    if (s.role === 'browser' && s.listener && s.readyState === OPEN) return true;
  }
  return false;
}

function tryAutoResume(room) {
  const claim = room.resumable;
  if (!claim) return false;
  if (now() > claim.expiresAt) { room.resumable = null; room.frameBuffer = []; return false; }
  if (room.pendingPairing) { room.resumable = null; return false; }
  let phoneWs = room.active.phone && room.active.phone.readyState === OPEN ? room.active.phone : null;
  let browserWs = room.active.browser && room.active.browser.readyState === OPEN ? room.active.browser : null;
  const survivorPhone = phoneWs, survivorBrowser = browserWs;
  // FORGE-L: prefer the handset that was actually in this pair. Over a hold
  // measured in minutes a second device of the same user is likelier to be
  // idling in the lobby. Purely a preference — falls through to first-found.
  const wantDeviceName = claim.identity ? claim.identity.deviceName : null;
  if (!phoneWs && wantDeviceName) {
    for (const s of room.lobby) {
      if (s.role === 'phone' && s.readyState === OPEN && s.deviceName === wantDeviceName) { phoneWs = s; break; }
    }
  }
  for (const s of room.lobby) {
    if (s.role === 'phone' && !phoneWs && s.readyState === OPEN) phoneWs = s;
    // A passive listener (the extension service worker) is receive-only and is
    // NEVER promoted into the active browser slot.
    else if (s.role === 'browser' && !s.listener && !browserWs && s.readyState === OPEN) browserWs = s;
  }
  if (!phoneWs || !browserWs) return false;
  room.lobby.delete(phoneWs); room.lobby.delete(browserWs);
  room.active.browser = browserWs; room.active.phone = phoneWs;
  room.resumable = null;
  const id = claim.identity ?? {};
  const deviceName = phoneWs.deviceName ?? id.deviceName ?? null;
  room.pairIdentity = { ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', deviceLabel: id.deviceLabel, deviceName };
  // FORGE-M: a live panel hold is survivor-preserving in its own right — both
  // peers may be away at once while the listener keeps the pair alive, and the
  // pair that re-forms is the SAME pair. `resumed`/`gapMs` tell the client to
  // run its SILENT merge backfill instead of a first-connect quicksync.
  const held = !!(survivorPhone || survivorBrowser) || claim.panelHold === true;
  const gapMs = now() - (claim.heldSince ?? claim.droppedAt);
  const mark = { resumed: true, held, gapMs };
  room.lastResume = { held, gapMs, droppedRole: claim.droppedRole, panelHold: claim.panelHold === true };
  if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName, ...mark })}`);
  if (!survivorPhone) safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown', ...mark })}`);
  if (room.frameBuffer && room.frameBuffer.length) {
    // FORGE-L: cutoff tracks the claim's ACTUAL lifetime. A flat
    // now-RESUME_WINDOW_MS would discard every frame buffered more than 3
    // minutes ago — exactly the SMS this feature exists to preserve.
    const cutoff = claim.panelHold ? (claim.heldSince ?? claim.droppedAt) : now() - RESUME_WINDOW_MS;
    for (const entry of room.frameBuffer) {
      if (entry.at < cutoff) continue;
      safeSend(browserWs, entry.msg);
    }
    room.frameBuffer = [];
  }
  return true;
}

function terminateActivePair(room, reason) {
  const { browser, phone } = room.active;
  if (!browser && !phone) return;

  if (reason === 'socket_closed') { // soft-hold (LEGACY_RESUME_TEARDOWN off)
    const phoneOpen = !!phone && phone.readyState === OPEN;
    const browserOpen = !!browser && browser.readyState === OPEN;
    const droppedRole = !phoneOpen ? 'phone' : 'browser';
    room.active = { browser: browserOpen ? browser : null, phone: phoneOpen ? phone : null };
    // FORGE-L panel hold: (1) the browser went away while the extension's MV3
    // listener is still there, or (2) STICKY — a prior claim was already
    // holding, so the phone's own blip cannot silently downgrade the hold.
    const prior = room.resumable;
    const panelHold =
      (droppedRole === 'browser' && hasLiveListener(room)) ||
      (!!prior && prior.panelHold === true);
    // FORGE-M: heldSince is the moment the CHAIN of drops began, carried across
    // every re-entry while the hold is live (the second side dropping must not
    // move the frame-buffer replay cutoff forward, nor restart the listener
    // grace, nor make the re-formed pair look new).
    const heldSince = (panelHold && prior && prior.heldSince) ? prior.heldSince : now();
    room.resumable = {
      droppedRole, panelHold, heldSince, droppedAt: now(), expiresAt: now() + RESUME_WINDOW_MS,
      identity: room.pairIdentity ?? null,
      listenerGoneAt: (panelHold && prior) ? (prior.listenerGoneAt ?? null) : null,
    };
    const survivor = phoneOpen ? phone : (browserOpen ? browser : null);
    if (droppedRole === 'browser' && tryAutoResume(room)) return;
    if (survivor) safeSend(survivor, `PEER_RECONNECTING:${JSON.stringify({ droppedRole, window: RESUME_WINDOW_MS })}`);
    return;
  }

  room.active = { browser: null, phone: null };
  room.frameBuffer = [];
  room.resumable = null;
  if (browser) { safeSend(browser, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (browser.readyState === OPEN) room.lobby.add(browser); }
  if (phone) { safeSend(phone, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (phone.readyState === OPEN) room.lobby.add(phone); }
}

// server.js keepalive tick — the resume-claim sweep, with the FORGE-L hold.
function keepaliveTick(room) {
  const claim = room.resumable;
  if (!claim) return;
  if (claim.panelHold) {
    if (hasLiveListener(room)) {
      claim.listenerGoneAt = null;
      claim.expiresAt = now() + RESUME_WINDOW_MS;
      return;
    }
    if (claim.listenerGoneAt === null) claim.listenerGoneAt = now();
    if (now() - claim.listenerGoneAt <= LISTENER_HOLD_GRACE_MS) {
      claim.expiresAt = now() + RESUME_WINDOW_MS;
      return;
    }
    claim.panelHold = false;
    claim.expiresAt = now();
  }
  if (now() <= claim.expiresAt) return;
  const onlyOneActive = (!!room.active.browser) !== (!!room.active.phone);
  if (onlyOneActive) {
    room.resumable = null;
    terminateActivePair(room, 'resume_expired');
  } else {
    room.resumable = null;
  }
}

// Advance the fake clock by `ms`, running the keepalive tick at its real
// cadence so a hold is renewed exactly as it would be in production.
function advance(room, ms) {
  const end = NOW + ms;
  while (NOW + KEEPALIVE_TICK_MS <= end) { NOW += KEEPALIVE_TICK_MS; keepaliveTick(room); }
  NOW = end;
}

// Phone-originated data frame. Mirrors the ws.on('message') phone branch:
// listeners are mirrored BEFORE the active-pair gate; an active phone with no
// active browser drops (the SW already has it); a LOBBY phone under an armed
// claim buffers for replay.
function phoneDataFrame(room, ws, msg) {
  for (const s of room.lobby) if (s.role === 'browser' && s.listener) safeSend(s, msg);
  if (ws === room.active.phone) {
    const b = room.active.browser;
    if (b && b.readyState === OPEN) { safeSend(b, msg); return 'forwarded'; }
    return 'dropped_no_browser';
  }
  const claim = room.resumable;
  if (claim && now() <= claim.expiresAt) {
    room.frameBuffer.push({ msg, at: now() });
    if (room.frameBuffer.length > FRAME_BUFFER_MAX) room.frameBuffer.shift();
    return 'buffered';
  }
  return 'dropped';
}

// ── Call-site mirrors ──────────────────────────────────────────────────────

function browserJoin(room, ws) { room.lobby.add(ws); return tryAutoResume(room); }
function phoneJoin(room, ws) { room.lobby.add(ws); return tryAutoResume(room); }
function browserSocketClosed(room, ws) {
  room.lobby.delete(ws); ws.readyState = CLOSED;
  if (ws === room.active.browser) terminateActivePair(room, 'socket_closed');
}
function phoneSocketClosed(room, ws) {
  room.lobby.delete(ws); ws.readyState = CLOSED;
  if (ws === room.active.phone) terminateActivePair(room, 'socket_closed');
}

// A paired room with the extension's MV3 listener present — the shape that
// exists whenever the extension is installed and its worker is alive.
function pairedRoomWithListener() {
  const room = makeRoom();
  const phone = makeWs('phone', { deviceName: 'Pixel' });
  const browser = makeWs('browser');   // the side-panel iframe
  const sw = makeWs('browser', { listener: true });
  room.lobby.add(sw);
  room.active.browser = browser; room.active.phone = phone;
  room.pairIdentity = { ua: 'Chrome', ip: '1.2.3.4', deviceLabel: 'Desk', deviceName: 'Pixel' };
  return { room, phone, browser, sw };
}
const isActive = (room, phone, browser) => room.active.phone === phone && room.active.browser === browser;

// ── (a) THE ASK: panel closed 5 minutes, reopen, still paired ─────────────
{
  console.log('\n(a) panel close → 5 min → reopen → still paired, no re-accept');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();

  browserSocketClosed(room, panel);
  check('a1: claim armed with the panel hold', room.resumable?.panelHold === true && room.resumable.droppedRole === 'browser');
  check('a2: phone soft-held in active, told its peer is reconnecting', room.active.phone === phone && gotFrame(phone, 'PEER_RECONNECTING:'));

  advance(room, 5 * 60_000);
  check('a3: past 180 s the claim is STILL live (this is the whole fix)', room.resumable !== null && now() <= room.resumable.expiresAt);
  check('a4: phone was never dropped to the lobby', room.active.phone === phone && !gotFrame(phone, 'PAIRING_TERMINATED:'));

  const panel2 = makeWs('browser');
  check('a5: reopening the panel resumes silently', browserJoin(room, panel2) === true);
  check('a6: pair re-formed', isActive(room, phone, panel2));
  check('a7: the reopened panel is told it is active (no user re-accept)', gotFrame(panel2, 'PAIRING_ACTIVE:'));
  check('a8: the phone was NOT re-prompted to accept a pairing', !gotFrame(phone, 'PAIRING_REQUEST:'));
  check('a9: the surviving phone was not needlessly re-synced', !gotFrame(phone, 'PAIRING_ACTIVE:'));
  check('a10: claim consumed', room.resumable === null);
  void sw;
}

// ── (b) an SMS arriving during the hold still reaches the user ────────────
{
  console.log('\n(b) SMS during the hold → SW gets it live; a lobby-phone frame replays');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  browserSocketClosed(room, panel);

  advance(room, 60_000);
  const r1 = phoneDataFrame(room, phone, 'PHONE_SMS:{"id":"m1"}');
  check('b1: no active browser, so the pair path drops it', r1 === 'dropped_no_browser');
  check('b2: but the MV3 listener received it live (badge/notification)', gotFrame(sw, 'PHONE_SMS:'));

  // Now the phone itself blips (doze / handoff) — it lands in the lobby, and a
  // frame it sends there is buffered for replay.
  phoneSocketClosed(room, phone);
  check('b3: the phone blip did NOT downgrade the hold (sticky)', room.resumable?.panelHold === true);
  const phone2 = makeWs('phone', { deviceName: 'Pixel' });
  room.lobby.add(phone2);
  advance(room, 60_000);
  const r2 = phoneDataFrame(room, phone2, 'PHONE_SMS:{"id":"m2"}');
  check('b4: lobby-phone frame buffered under the live claim', r2 === 'buffered');

  // Reopen at t+6 min. m2 is ~4 min old — the OLD flat now-180s replay cutoff
  // would have silently discarded it. That was a real hole in option (b).
  advance(room, 4 * 60_000);
  const panel2 = makeWs('browser');
  check('b5: resume at t+6min succeeds', browserJoin(room, panel2) === true);
  check('b6: the >3-minute-old buffered SMS was REPLAYED, not discarded', gotFrame(panel2, 'PHONE_SMS:{"id":"m2"}'));
  check('b7: buffer drained', room.frameBuffer.length === 0);
}

// ── (c) listener absent past the grace → released cleanly ─────────────────
{
  console.log('\n(c) extension genuinely gone → grace burns → pair released cleanly');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  browserSocketClosed(room, panel);

  advance(room, 2 * 60_000);
  check('c1: held while the worker is alive', room.resumable?.panelHold === true);

  // Browser closed / extension disabled: the listener socket goes away.
  sw.readyState = CLOSED; room.lobby.delete(sw);
  advance(room, LISTENER_HOLD_GRACE_MS - 60_000);
  check('c2: still held inside the grace (an MV3 eviction must not cost the pair)', room.resumable?.panelHold === true && room.resumable !== null);

  advance(room, 2 * 60_000 + RESUME_WINDOW_MS);
  check('c3: claim released after the grace', room.resumable === null);
  check('c4: phone told cleanly, not left hanging', gotFrame(phone, 'PAIRING_TERMINATED:'));
  check('c5: phone returned to the lobby', room.lobby.has(phone) && room.active.phone === null);
}

// ── (d) an evicted-and-replaced MV3 worker must NOT cost the pairing ──────
{
  console.log('\n(d) MV3 worker eviction + respawn inside the grace');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  browserSocketClosed(room, panel);

  sw.readyState = CLOSED; room.lobby.delete(sw);
  advance(room, 64_000);              // FORGE-J's worst measured respawn gap
  check('d1: grace started but not burned', room.resumable?.listenerGoneAt !== null && room.resumable !== null);
  const sw2 = makeWs('browser', { listener: true });
  room.lobby.add(sw2);
  advance(room, KEEPALIVE_TICK_MS);
  check('d2: replacement worker re-arms the hold', room.resumable?.listenerGoneAt === null && room.resumable.panelHold === true);
  advance(room, 20 * 60_000);         // well past the grace, worker alive
  check('d3: still paired 20 minutes later', room.resumable !== null && room.active.phone === phone);
  const panel2 = makeWs('browser');
  check('d4: reopen still resumes', browserJoin(room, panel2) === true && isActive(room, phone, panel2));
}

// ── (e) explicit teardown is still immediate ─────────────────────────────
{
  console.log('\n(e) LEAVE_ACTIVE / RESET_ROOM / sign-out release immediately');
  for (const reason of ['user_left', 'room_reset', 'session_superseded']) {
    NOW = 1_000_000;
    const { room, phone, browser: panel } = pairedRoomWithListener();
    browserSocketClosed(room, panel);
    check(`e-${reason}-1: hold armed`, room.resumable?.panelHold === true);
    terminateActivePair(room, reason);
    check(`e-${reason}-2: claim cleared instantly despite the live listener`, room.resumable === null);
    check(`e-${reason}-3: pair gone`, room.active.phone === null && room.active.browser === null);
    check(`e-${reason}-4: phone told`, gotFrame(phone, 'PAIRING_TERMINATED:'));
    advance(room, 1_000);
    check(`e-${reason}-5: the tick does not resurrect it`, room.resumable === null);
  }
}

// ── (f) the PHONE dropping is NOT given the hold ─────────────────────────
{
  console.log('\n(f) a missing handset is a real absence — 180 s as before');
  NOW = 1_000_000;
  const { room, phone, browser: panel } = pairedRoomWithListener();
  phoneSocketClosed(room, phone);
  check('f1: no panel hold for a phone drop', room.resumable?.panelHold === false && room.resumable.droppedRole === 'phone');
  check('f2: browser soft-held', room.active.browser === panel && gotFrame(panel, 'PEER_RECONNECTING:'));
  advance(room, RESUME_WINDOW_MS + KEEPALIVE_TICK_MS);
  check('f3: released at the ordinary 180 s window even with a live listener', room.resumable === null);
  check('f4: browser told cleanly', gotFrame(panel, 'PAIRING_TERMINATED:'));
}

// ── (g) a second web tab while held behaves as today ─────────────────────
{
  console.log('\n(g) a web tab joining during the hold takes the slot, as today');
  NOW = 1_000_000;
  const { room, phone, browser: panel } = pairedRoomWithListener();
  browserSocketClosed(room, panel);
  advance(room, 4 * 60_000);
  const webTab = makeWs('browser');
  check('g1: the web tab resumes the pair (same user, same token-scoped room)', browserJoin(room, webTab) === true);
  check('g2: pair re-formed onto the tab', isActive(room, phone, webTab));
  check('g3: exactly one PAIRING_ACTIVE — no duplicate pairing prompt', countFrames(webTab, 'PAIRING_ACTIVE:') === 1);
  check('g4: no re-accept round trip', !gotFrame(phone, 'PAIRING_REQUEST:'));
}

// ── (h) the returning handset is preferred over an idle sibling ───────────
{
  console.log('\n(h) over a long hold, resume prefers the handset that was in the pair');
  NOW = 1_000_000;
  const { room, phone, browser: panel } = pairedRoomWithListener();
  browserSocketClosed(room, panel);
  phoneSocketClosed(room, phone);
  const idle = makeWs('phone', { deviceName: 'Old Tablet' });
  const real = makeWs('phone', { deviceName: 'Pixel' });
  room.lobby.add(idle);               // the sibling was there first
  room.lobby.add(real);
  advance(room, 5 * 60_000);
  const panel2 = makeWs('browser');
  check('h1: resume fires', browserJoin(room, panel2) === true);
  check('h2: the pair went to the ORIGINAL handset, not the idle sibling', room.active.phone === real);
  check('h3: the idle sibling was left in the lobby untouched', room.lobby.has(idle) && !gotFrame(idle, 'PAIRING_ACTIVE:'));
  check('h4: exactly one PAIRING_ACTIVE to the phone — no duplicate prompt', countFrames(real, 'PAIRING_ACTIVE:') === 1);
}

// ── (i) the hold cannot widen WHO may resume ─────────────────────────────
{
  console.log('\n(i) the hold lengthens the window, it does not widen the door');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  browserSocketClosed(room, panel);
  advance(room, 8 * 60_000);
  check('i1: the listener is NOT promoted into the active browser slot', room.active.browser === null);
  check('i2: a held claim with no interactive surface does not resume', tryAutoResume(room) === false);
  check('i3: claim still armed for a real surface', room.resumable?.panelHold === true);
  void sw; void phone;
}

// ── (j) FORGE-M: Dennis's exact prod timeline (2026-09-16 09:15:58 UTC) ───
// Relay log, room MRsNsod3:a6644771:
//   09:15:58 socket_closed droppedRole=browser code=1000 "page_unload" panelHold=YES
//   09:16:01 socket_closed droppedRole=phone   code=1000 "(none)"     panelHold=YES
//   09:16:24 auto-resumed  gap=23709ms droppedRole=phone survivorHeld=FALSE
// survivorHeld=false is what made the client re-run a first-connect sync:
// "it drops it and takes it up once with need to do a full sync again".
{
  console.log('\n(j) panel close -> phone blips 3 s later -> reopen 23 s later');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  const t0 = NOW;

  browserSocketClosed(room, panel);                 // 09:15:58
  check('j1: hold armed on the panel close', room.resumable?.panelHold === true && room.resumable.droppedRole === 'browser');
  check('j2: heldSince stamped at the FIRST drop', room.resumable.heldSince === t0);

  // An SMS lands while only the phone is up — buffered for replay. This is the
  // frame the old droppedAt-based cutoff threw away once the phone blipped.
  NOW += 1_000;
  const activePhone = room.active.phone;
  room.active.phone = null; room.lobby.add(phone);   // lobby-phone shape
  check('j3: SMS during the hold is buffered', phoneDataFrame(room, phone, 'PHONE_SMS:{"id":"held"}') === 'buffered');
  room.lobby.delete(phone); room.active.phone = activePhone;

  NOW = t0 + 3_000;
  phoneSocketClosed(room, phone);                   // 09:16:01 — the v55 APK redials
  check('j4: still held after the phone blip (sticky)', room.resumable?.panelHold === true);
  check('j5: droppedRole flipped to phone, as production shows', room.resumable.droppedRole === 'phone');
  check('j6: heldSince did NOT move to the phone blip', room.resumable.heldSince === t0);
  check('j7: BOTH sides away, yet the pair was never torn down', room.active.phone === null && room.active.browser === null && !gotFrame(phone, 'PAIRING_TERMINATED:'));

  // The phone redials into the lobby ~5 s later (PhoneService lobbyReconnectDelayMs).
  NOW = t0 + 8_000;
  const phone2 = makeWs('phone', { deviceName: 'Pixel' });
  check('j8: the phone alone cannot resume — it still needs a real surface', phoneJoin(room, phone2) === false);
  check('j9: claim survives the half-resume', room.resumable?.panelHold === true);

  // 09:16:24 — the user reopens the panel.
  NOW = t0 + 23_709;
  const panel2 = makeWs('browser');
  check('j10: reopen resumes the pair', browserJoin(room, panel2) === true);
  check('j11: pair re-formed onto the returning panel + phone', isActive(room, phone2, panel2));
  check('j12: THE FIX — resume is survivor-preserving, not a new pair', room.lastResume.held === true);
  check('j13: gap measured from the FIRST drop, not the phone blip', room.lastResume.gapMs === 23_709);
  check('j14: the panel is told this is a RESUME, not a first connect', panel2.sent.some((m) => m.startsWith('PAIRING_ACTIVE:') && JSON.parse(m.slice('PAIRING_ACTIVE:'.length)).resumed === true));
  check('j15: the rejoined phone is told the same', phone2.sent.some((m) => m.startsWith('PAIRING_ACTIVE:') && JSON.parse(m.slice('PAIRING_ACTIVE:'.length)).resumed === true));
  check('j16: no re-accept round trip', !gotFrame(phone2, 'PAIRING_REQUEST:'));
  check('j17: the SMS buffered BEFORE the phone blip was replayed, not dropped', gotFrame(panel2, 'PHONE_SMS:{"id":"held"}'));
  void sw;
}

// ── (k) a genuine first connect must STAY a first connect ────────────────
{
  console.log('\n(k) the resume marker never leaks onto a real handshake');
  NOW = 1_000_000;
  const { room, phone, browser: panel } = pairedRoomWithListener();
  // handleAcceptPairing's frame — mirrored here as the shape it actually sends.
  safeSend(panel, `PAIRING_ACTIVE:${JSON.stringify({ deviceName: 'Pixel' })}`);
  const frame = JSON.parse(panel.sent[0].slice('PAIRING_ACTIVE:'.length));
  check('k1: a handshake PAIRING_ACTIVE carries no resume marker', frame.resumed === undefined);
  check('k2: and no gap', frame.gapMs === undefined);
  void room; void phone;
}

// ── (l) a NON-held resume (ordinary blip) still reports honestly ──────────
{
  console.log('\n(l) ordinary phone blip, no hold: resumed=true, held via the survivor');
  NOW = 1_000_000;
  const { room, phone, browser: panel } = pairedRoomWithListener();
  phoneSocketClosed(room, phone);
  check('l1: no panel hold for a phone drop', room.resumable?.panelHold === false);
  NOW += 4_000;
  const phone2 = makeWs('phone', { deviceName: 'Pixel' });
  check('l2: the phone returning resumes', phoneJoin(room, phone2) === true);
  check('l3: held=true because the BROWSER survived in active', room.lastResume.held === true);
  check('l4: the surviving browser was not re-synced', !gotFrame(panel, 'PAIRING_ACTIVE:'));
  check('l5: the returning phone is marked resumed', phone2.sent.some((m) => m.startsWith('PAIRING_ACTIVE:') && JSON.parse(m.slice('PAIRING_ACTIVE:'.length)).resumed === true));
}

// ── (m) listener absent → present → absent across a held claim ────────────
{
  console.log('\n(m) listener transitions do not corrupt the hold grace clock');
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  browserSocketClosed(room, panel);

  // absent
  sw.readyState = CLOSED; room.lobby.delete(sw);
  advance(room, 60_000);
  const goneAt = room.resumable.listenerGoneAt;
  check('m1: grace clock started', goneAt !== null);

  // FORGE-M: a phone blip while the listener is ABSENT must not reset the
  // grace — otherwise a closed browser plus a flapping phone holds forever.
  phoneSocketClosed(room, phone);
  check('m2: phone blip did NOT restart the listener grace', room.resumable.listenerGoneAt === goneAt);

  // present again
  const sw2 = makeWs('browser', { listener: true });
  room.lobby.add(sw2);
  advance(room, KEEPALIVE_TICK_MS);
  check('m3: returning listener clears the grace', room.resumable.listenerGoneAt === null);

  // absent for good
  sw2.readyState = CLOSED; room.lobby.delete(sw2);
  advance(room, LISTENER_HOLD_GRACE_MS + RESUME_WINDOW_MS + KEEPALIVE_TICK_MS);
  check('m4: released once the extension is genuinely gone', room.resumable === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// (n) SEALED-PAIR TWIN — the listener-renewed hold is MODE-BLIND (E2E-P6 (a))
// ═══════════════════════════════════════════════════════════════════════════
// §13.7 replaces a frame's BODY with `{e,kid,s,c}` and leaves its TYPE alone,
// so nothing above — hasLiveListener, the panelHold renewal, the buffering
// branch in phoneDataFrame, the replay cutoff — has anything new to read. This
// section runs the SAME mirrors twice, plaintext then really-sealed, and
// requires the transcripts to be identical.
//
// SCOPE: proves the MIRROR has no body-dependent branch. Not evidence about the
// shipped relay — that is P6 (g) against `node server.js`. See the header of
// tests/lib/sealed-twin.mjs.
import {
  twin, transcript, openBody, assertNoPlaintext,
} from './lib/sealed-twin.mjs';

const TWIN_CANARY = 'canary-pairing-persist-4d92be-this-plaintext-must-never-survive';

/**
 * The FORGE-L path end to end: panel closes → listener renews the claim well
 * past 180 s → the phone itself blips into the lobby → frames it sends there
 * are buffered → the panel reopens and the buffer replays.
 *
 * A sealed frame buffered while the panel is shut has to survive every claim
 * renewal in between and still open at the far end.
 */
function holdTwinScenario(mode) {
  NOW = 1_000_000;
  const { room, phone, browser: panel, sw } = pairedRoomWithListener();
  const e2e = mode.block();
  if (e2e) room.pairIdentity = { ...room.pairIdentity, e2e };

  browserSocketClosed(room, panel);          // panelHold armed
  advance(room, 5 * 60_000);                 // renewed past the 180 s window

  phoneSocketClosed(room, phone);            // the handset blips into the lobby
  const phone2 = makeWs('phone', { deviceName: 'Pixel' });
  room.lobby.add(phone2);

  const bodies = [], payloads = [], results = [];
  for (let i = 0; i < 3; i++) {
    const payload = { id: `msg-${i}`, text: `${TWIN_CANARY}-${i}` };
    payloads.push(payload);
    const body = mode.body('SMS_RECEIVED', payload);
    bodies.push(body);
    advance(room, 30_000);                   // more renewals between frames
    results.push(phoneDataFrame(room, phone2, `SMS_RECEIVED:${JSON.stringify(body)}`));
  }

  const c = room.resumable;
  const claimSnapshot = c
    ? { droppedRole: c.droppedRole, panelHold: c.panelHold, heldSince: c.heldSince,
        listenerGoneAt: c.listenerGoneAt, expiresAt: c.expiresAt,
        e2e: c.identity ? c.identity.e2e : undefined }
    : null;

  const panel2 = makeWs('browser');
  const resumed = browserJoin(room, panel2);
  return { room, sw, phone2, panel2, resumed, bodies, payloads, results, claimSnapshot, e2e };
}

console.log('\n(n) sealed-pair twin — listener-renewed hold + buffered replay');
{
  const t = twin(holdTwinScenario);
  const S = t.sealed, P = t.plain;

  // 1. Transcript equality.
  const panelAgree = t.agrees((o) => o.panel2.sent);
  check('n1: reopened-panel transcript identical in plaintext and sealed modes', panelAgree.equal);
  if (!panelAgree.equal) { console.log(`       plain : ${panelAgree.plain}`); console.log(`       sealed: ${panelAgree.sealed}`); }
  check('n2: listener transcript identical (live mirror is type-routed)', t.agrees((o) => o.sw.sent).equal);
  check('n3: phone transcript identical', t.agrees((o) => o.phone2.sent).equal);
  check('n4: the buffering DECISION is identical', P.results.join(',') === S.results.join(',') && S.results.every((r) => r === 'buffered'));
  check('n5: the resume fired in both modes', P.resumed === true && S.resumed === true);
  check('n6: same pair state', isActive(P.room, P.phone2, P.panel2) && isActive(S.room, S.phone2, S.panel2));

  // The renewal decision is the thing FORGE-L added; it must be reached on
  // identical inputs in both modes, not merely produce a working resume.
  check('n7: the renewed claim is byte-identical across modes (minus the opaque e2e block)',
    JSON.stringify({ ...P.claimSnapshot, e2e: undefined }) === JSON.stringify({ ...S.claimSnapshot, e2e: undefined }));
  check('n8: the hold was genuinely live and genuinely past 180 s',
    S.claimSnapshot.panelHold === true && S.claimSnapshot.listenerGoneAt === null);

  // 2. Verbatim passthrough across the whole hold.
  const replayed = S.panel2.sent.filter((m) => m.startsWith('SMS_RECEIVED:'))
    .map((m) => JSON.parse(m.slice('SMS_RECEIVED:'.length)));
  check('n9: every sealed frame buffered during the hold came out, in order',
    replayed.length === S.bodies.length
    && replayed.every((env, i) => JSON.stringify(env) === JSON.stringify(S.bodies[i])));
  let opened = [], openOk = true;
  try { opened = replayed.map((env) => openBody(t.session, 'SMS_RECEIVED', env)); }
  catch (e) { openOk = false; console.log(`       open failed: ${e.message}`); }
  check('n10: each replayed envelope still OPENS after the renewals',
    openOk && opened.length === 3 && opened.every((p, i) => p.text === S.payloads[i].text));
  check('n11: counters intact, no gaps (s = 0,1,2)', replayed.map((e) => e.s).join(',') === '0,1,2');
  check('n12: one kid across the whole hold — no re-key on renewal',
    new Set(replayed.map((e) => e.kid)).size === 1 && replayed[0].kid === t.session.kid);
  const mirroredLive = S.sw.sent.filter((m) => m.startsWith('SMS_RECEIVED:'));
  check('n13: the live listener mirror is verbatim too',
    mirroredLive.length === 3 && mirroredLive.every((m, i) => m === `SMS_RECEIVED:${JSON.stringify(S.bodies[i])}`));

  // 3. No plaintext leak. Secrets are the payloads themselves, never `opened` —
  // a failed open must not be able to empty the secret set and pass vacuously.
  const hay = JSON.stringify({
    frameBuffer: S.room.frameBuffer,
    resumable: S.room.resumable,
    pairIdentity: S.room.pairIdentity,
    panelSent: S.panel2.sent, swSent: S.sw.sent, phoneSent: S.phone2.sent,
    lastResume: S.room.lastResume,
  });
  const leak = assertNoPlaintext(hay, S.payloads);
  check(`n14: no plaintext survives the hold anywhere in room state${leak.clean ? '' : ` — LEAKED ${JSON.stringify(leak.leaked)}`}`, leak.clean);

  // 4. The e2e block rides the claim untouched; the same kid comes back.
  check('n15: the claim carried the e2e block verbatim through every renewal',
    JSON.stringify(S.claimSnapshot.e2e) === JSON.stringify(S.e2e));
  check('n16: that kid is the kid the replayed frames use', S.claimSnapshot.e2e.kid === t.session.kid);
  check('n17: plaintext mode attaches no e2e block', P.claimSnapshot.e2e === undefined);
  check('n18: buffer drained and claim consumed in both modes',
    P.room.frameBuffer.length === 0 && S.room.frameBuffer.length === 0
    && P.room.resumable === null && S.room.resumable === null);
  check('n19: sealed frames are sealed, plaintext frames are not',
    transcript(P.panel2.sent).every((x) => x.sealed === false)
    && transcript(S.panel2.sent).filter((x) => x.type === 'SMS_RECEIVED').every((x) => x.sealed === true));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
