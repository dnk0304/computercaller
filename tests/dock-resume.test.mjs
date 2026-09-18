// Relay tests — side-panel dock resume (2026-09-15, forge/dock-reconnect-sw-badge).
//
// Dennis: "when i dock the side panel, it drops the connection and i have to
// sync again when it opens."
//
// The dock is an ORDERING, not a disconnection. shell.js opens the side panel
// FIRST — its iframe joins the lobby while the pop-out is still sitting in
// room.active.browser — and only THEN asks the worker to close the pop-out
// window. tryAutoResume used to run at lobby-JOIN time and nowhere else, so:
//
//   t0  panel iframe joins   → no armed claim yet → LOBBY_STATUS, no resume
//   t1  pop-out socket closes → claim armed … with no join left to fire on
//
// and the pair stayed broken for the full resume window. The fix re-checks
// for a resume at claim-ARM time in terminateActivePair, gated on the dropped
// side being the BROWSER (see below — a dropped phone must not be able to hand
// the pair to a different handset that happened to be idling in the lobby).
//
// server.js cannot be imported without booting Next.js, so — following the
// established pattern in the other .mjs relay tests — this file MIRRORS the
// relay's pairing state machine. If you change the logic in server.js, update
// this copy.
//
// Run: node tests/dock-resume.test.mjs

const OPEN = 1;
const CLOSED = 3;
const RESUME_WINDOW_MS = 180_000;

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

function makeRoom() {
  return {
    token: 't', lobby: new Set(),
    active: { browser: null, phone: null },
    pendingPairing: null, resumable: null, pairIdentity: null,
    frameBuffer: [],
  };
}

// ── Mirrors of server.js logic ─────────────────────────────────────────────

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
  if (!survivorBrowser) safeSend(browserWs, `PAIRING_ACTIVE:${JSON.stringify({ deviceName })}`);
  if (!survivorPhone) safeSend(phoneWs, `PAIRING_ACTIVE:${JSON.stringify({ ua: id.ua ?? 'unknown', ip: id.ip ?? 'unknown' })}`);
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
    const survivor = phoneOpen ? phone : (browserOpen ? browser : null);
    // THE DOCK FIX: a counterpart may already be waiting in the lobby.
    if (droppedRole === 'browser' && tryAutoResume(room)) return;
    if (survivor) safeSend(survivor, `PEER_RECONNECTING:${JSON.stringify({ droppedRole, window: RESUME_WINDOW_MS })}`);
    return;
  }

  room.active = { browser: null, phone: null };
  room.frameBuffer = [];
  room.resumable = reason === 'socket_closed' ? room.resumable : null;
  if (browser) { safeSend(browser, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (browser.readyState === OPEN) room.lobby.add(browser); }
  if (phone) { safeSend(phone, `PAIRING_TERMINATED:{"reason":"${reason}"}`); if (phone.readyState === OPEN) room.lobby.add(phone); }
}

// ── Call-site mirrors ──────────────────────────────────────────────────────

function browserJoin(room, ws) { room.lobby.add(ws); return tryAutoResume(room); }
function phoneJoin(room, ws) { room.lobby.add(ws); return tryAutoResume(room); }

function browserSocketClosed(room, ws) {   // browser ws.on('close') active branch
  room.lobby.delete(ws);
  ws.readyState = CLOSED;
  if (ws === room.active.browser) terminateActivePair(room, 'socket_closed');
}
function phoneSocketClosed(room, ws) {
  room.lobby.delete(ws);
  ws.readyState = CLOSED;
  if (ws === room.active.phone) terminateActivePair(room, 'socket_closed');
}

function pairedRoom() {
  const room = makeRoom();
  const phone = makeWs('phone', { deviceName: 'Pixel' });
  const browser = makeWs('browser');
  room.active.browser = browser; room.active.phone = phone;
  room.pairIdentity = { ua: 'Chrome', ip: '1.2.3.4', deviceLabel: 'Desk', deviceName: 'Pixel' };
  return { room, phone, browser };
}
const isActive = (room, phone, browser) => room.active.phone === phone && room.active.browser === browser;

// ── (a) THE BUG: panel opens BEFORE the pop-out closes ─────────────────────
{
  console.log('\n(a) dock ordering — new surface joins first, old one closes second');
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();

  // t0 — shell.js opened the side panel; its iframe joins while the pop-out
  // is still the active browser. No claim is armed yet, so no resume here.
  const panel = makeWs('browser');
  const resumedOnJoin = browserJoin(room, panel);
  check('a1: panel join does not resume (nothing has dropped yet)', resumedOnJoin === false);
  check('a2: pop-out is still the active browser', room.active.browser === popout);

  // t1 — the worker closes the pop-out window; its socket goes away.
  NOW += 120;
  browserSocketClosed(room, popout);

  check('a3: pair re-formed onto the panel with no re-sync', isActive(room, phone, panel));
  check('a4: panel was told the pair is active', gotFrame(panel, 'PAIRING_ACTIVE:'));
  check('a5: claim consumed', room.resumable === null);
  check('a6: phone never saw a teardown', !gotFrame(phone, 'PAIRING_TERMINATED:'));
  // The phone is the survivor: it never left `active`, so it must not be
  // re-told it is active, and it must not be told a peer went away either.
  check('a7: phone not needlessly re-synced', !gotFrame(phone, 'PAIRING_ACTIVE:'));
  check('a8: phone got no PEER_RECONNECTING flap', !gotFrame(phone, 'PEER_RECONNECTING:'));
}

// ── (b) the reverse ordering still works (join-time resume kept) ───────────
{
  console.log('\n(b) reverse ordering — old surface closes first, new one joins after');
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();
  browserSocketClosed(room, popout);
  check('b1: claim armed, phone soft-held', room.resumable?.droppedRole === 'browser' && room.active.phone === phone);
  check('b2: survivor told peer is reconnecting', gotFrame(phone, 'PEER_RECONNECTING:'));
  NOW += 800;
  const panel = makeWs('browser');
  check('b3: join-time resume fires', browserJoin(room, panel) === true);
  check('b4: pair re-formed onto the panel', isActive(room, phone, panel));
}

// ── (c) a listener must never be promoted by the arm-time resume ──────────
{
  console.log('\n(c) the extension service worker is not a pairing candidate');
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();
  const sw = makeWs('browser', { listener: true });
  room.lobby.add(sw);
  browserSocketClosed(room, popout);
  check('c1: listener NOT promoted into active.browser', room.active.browser === null);
  check('c2: claim left armed for a real surface', room.resumable?.droppedRole === 'browser');
  check('c3: survivor soft-held as before', room.active.phone === phone && gotFrame(phone, 'PEER_RECONNECTING:'));
  const panel = makeWs('browser');
  check('c4: a real surface still resumes past the listener', browserJoin(room, panel) === true && isActive(room, phone, panel));
}

// ── (d) a dropped PHONE must not be handed to a different handset ──────────
{
  console.log('\n(d) arm-time resume is browser-only');
  NOW = 1_000_000;
  const { room, phone, browser } = pairedRoom();
  const otherPhone = makeWs('phone', { deviceName: 'Old Tablet' });
  room.lobby.add(otherPhone);            // a second device idling in the lobby
  phoneSocketClosed(room, phone);
  check('d1: idle handset NOT silently slotted into the pair', room.active.phone === null);
  check('d2: browser soft-held, claim armed for the real phone', room.active.browser === browser && room.resumable?.droppedRole === 'phone');
  check('d3: browser told its peer is reconnecting', gotFrame(browser, 'PEER_RECONNECTING:'));
  // The real phone coming back still resumes — via the join-time path, which
  // is what the arm-time guard deliberately leaves to the phone itself.
  //
  // NOTE (pre-existing, unchanged by THIS fix, deliberately not asserted here.
  // Since FORGE-L, server.js prefers the claim identity deviceName instead —
  // tests/pairing-persist.test.mjs case (h) asserts that):
  // the join-time tryAutoResume took the FIRST open phone it found in the
  // lobby, which is not necessarily the one that just rejoined. With the idle
  // handset above still present it would win the slot. That is server.js
  // behaviour as shipped since Issue 3 and every device in a room belongs to
  // the same user, so it is a separate question — flagged, not widened. Here
  // the idle handset is gone so the assertion is unambiguous.
  room.lobby.delete(otherPhone);
  NOW += 5_000;
  const phone2 = makeWs('phone', { deviceName: 'Pixel' });
  check('d4: the returning phone resumes normally', phoneJoin(room, phone2) === true && isActive(room, phone2, browser));
}

// ── (e) an explicit teardown never resumes, dock ordering or not ───────────
{
  console.log('\n(e) user_left is still terminal');
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();
  const panel = makeWs('browser');
  browserJoin(room, panel);
  terminateActivePair(room, 'user_left');
  check('e1: no claim armed', room.resumable === null);
  check('e2: pair is gone', room.active.browser === null && room.active.phone === null);
  check('e3: both sides told', gotFrame(popout, 'PAIRING_TERMINATED:') && gotFrame(phone, 'PAIRING_TERMINATED:'));
  check('e4: the waiting panel was NOT silently paired', room.active.browser !== panel);
}

// ── (f) an expired claim cannot be resumed at arm time either ─────────────
{
  console.log('\n(f) the resume window is still a window');
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();
  browserSocketClosed(room, popout);
  NOW += RESUME_WINDOW_MS + 1;
  const panel = makeWs('browser');
  check('f1: a late surface does not silently re-link', browserJoin(room, panel) === false);
  check('f2: lapsed claim cleared', room.resumable === null);
  void phone;
}

// ═══════════════════════════════════════════════════════════════════════════
// (g) SEALED-PAIR TWIN — the dock/resume is MODE-BLIND (E2E-P6 (a))
// ═══════════════════════════════════════════════════════════════════════════
// §13.7 keeps the frame TYPE and replaces only the BODY with `{e,kid,s,c}`, so
// every decision above — arm the claim, refuse to promote a listener, replay the
// buffer — is made on bytes that did not change. This section runs the SAME
// mirror functions twice (plaintext bodies, then real AES-256-GCM sealed
// bodies) and requires the transcripts to be identical.
//
// SCOPE: this proves the MIRROR has no body-dependent branch. It is NOT
// evidence about the shipped relay — see the header of tests/lib/sealed-twin.mjs
// and P6 (g), which exercises `node server.js` itself.
import {
  twin, transcript, openBody, assertNoPlaintext,
} from './lib/sealed-twin.mjs';

const TWIN_CANARY = 'canary-dock-resume-8f3a1c-this-plaintext-must-never-survive';

/**
 * Pop-out closes (claim armed) → three phone frames land in the buffer while no
 * browser is active → the side panel joins and resumes. This is case (b)'s
 * ordering with a frame buffer riding across the resume, which is where a
 * body-reading branch would show up.
 *
 * The buffer push is done inline because this file's mirror set has no
 * phoneDataFrame (pairing-persist owns that one); the push is exactly what the
 * relay's lobby-phone branch does — `{ msg, at }`, untouched.
 */
function dockTwinScenario(mode) {
  NOW = 1_000_000;
  const { room, phone, browser: popout } = pairedRoom();
  const e2e = mode.block();
  if (e2e) room.pairIdentity = { ...room.pairIdentity, e2e };

  browserSocketClosed(room, popout);

  const bodies = [];
  const payloads = [];
  for (let i = 0; i < 3; i++) {
    const payload = { id: `msg-${i}`, text: `${TWIN_CANARY}-${i}` };
    payloads.push(payload);
    const body = mode.body('SMS_RECEIVED', payload);
    bodies.push(body);
    NOW += 10;
    room.frameBuffer.push({ msg: `SMS_RECEIVED:${JSON.stringify(body)}`, at: now() });
  }

  NOW += 800;
  const claimIdentity = room.resumable ? room.resumable.identity : null;
  const panel = makeWs('browser');
  const resumed = browserJoin(room, panel);
  return { room, phone, popout, panel, resumed, bodies, payloads, claimIdentity, e2e };
}

console.log('\n(g) sealed-pair twin — dock resume');
{
  const t = twin(dockTwinScenario);
  const S = t.sealed, P = t.plain;

  // 1. Transcript equality — any body-dependent branch diverges here.
  const panelAgree = t.agrees((o) => o.panel.sent);
  check('g1: panel transcript identical in plaintext and sealed modes', panelAgree.equal);
  if (!panelAgree.equal) { console.log(`       plain : ${panelAgree.plain}`); console.log(`       sealed: ${panelAgree.sealed}`); }
  check('g2: phone transcript identical (PEER_RECONNECTING, no teardown)', t.agrees((o) => o.phone.sent).equal);
  check('g3: the resume itself happened in both modes', P.resumed === true && S.resumed === true);
  check('g4: same pair state in both modes', isActive(P.room, P.phone, P.panel) && isActive(S.room, S.phone, S.panel));
  check('g5: claim consumed in both modes', P.room.resumable === null && S.room.resumable === null);
  check('g6: buffer drained in both modes', P.room.frameBuffer.length === 0 && S.room.frameBuffer.length === 0);

  // 2. Verbatim passthrough — the relay changed not one byte across the resume.
  const replayed = S.panel.sent.filter((m) => m.startsWith('SMS_RECEIVED:'))
    .map((m) => JSON.parse(m.slice('SMS_RECEIVED:'.length)));
  check('g7: every buffered sealed frame came out the far side, in order',
    replayed.length === S.bodies.length
    && replayed.every((env, i) => JSON.stringify(env) === JSON.stringify(S.bodies[i])));
  let opened = [];
  let openOk = true;
  try { opened = replayed.map((env) => openBody(t.session, 'SMS_RECEIVED', env)); }
  catch (e) { openOk = false; console.log(`       open failed: ${e.message}`); }
  check('g8: each replayed envelope still OPENS (AEAD intact — nothing rewritten)',
    openOk && opened.length === 3 && opened.every((p, i) => p.text === `${TWIN_CANARY}-${i}`));
  check('g9: counters survive the resume with no gaps (s = 0,1,2)',
    replayed.map((e) => e.s).join(',') === '0,1,2');
  check('g10: one kid throughout — the resume did not re-key',
    new Set(replayed.map((e) => e.kid)).size === 1 && replayed[0].kid === t.session.kid);

  // 3. No plaintext leak anywhere the relay kept state.
  const hay = JSON.stringify({
    frameBuffer: S.room.frameBuffer,
    resumable: S.room.resumable,
    pairIdentity: S.room.pairIdentity,
    panelSent: S.panel.sent,
    phoneSent: S.phone.sent,
    popoutSent: S.popout.sent,
  });
  const leak = assertNoPlaintext(hay, S.payloads);
  check(`g11: no plaintext survives in room state or any transcript${leak.clean ? '' : ` — LEAKED ${JSON.stringify(leak.leaked)}`}`, leak.clean);

  // 4. The e2e block survives the drop→arm→resume chain, same kid.
  check('g12: the claim carried the e2e block verbatim across the drop',
    !!S.claimIdentity && JSON.stringify(S.claimIdentity.e2e) === JSON.stringify(S.e2e));
  // The rebuilt pairIdentity is composed field-by-field from the claim
  // (ua/ip/deviceLabel/deviceName), so the opaque e2e block is NOT carried into
  // the post-resume identity. Not a body read — the relay never needs it — but
  // recorded here so the behaviour is asserted rather than assumed.
  check('g12b: post-resume pairIdentity keeps only relay-owned identity fields',
    S.room.pairIdentity.e2e === undefined && S.room.pairIdentity.deviceName === 'Pixel');
  check('g13: the kid held by the claim is the kid the frames still use',
    !!S.claimIdentity && S.claimIdentity.e2e.kid === t.session.kid);
  check('g14: plaintext mode attaches no e2e block at all', P.claimIdentity && P.claimIdentity.e2e === undefined);
  check('g15: no sealed envelope leaked into the plaintext arm',
    transcript(P.panel.sent).every((x) => x.sealed === false)
    && transcript(S.panel.sent).filter((x) => x.type === 'SMS_RECEIVED').every((x) => x.sealed === true));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
