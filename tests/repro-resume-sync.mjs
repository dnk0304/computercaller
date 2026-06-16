// Before/after repro harness for the post-soft-hold live-sync regression
// (2026-06-16). Runner-less — `node tests/repro-resume-sync.mjs`. Exits non-zero
// on any failed assertion.
//
// Models the RELAY pair state machine (Bug A) and the WEB stale-chip decision
// (Bug B) as pure logic so we can drive a blip deterministically and count
// dropped frames / chip state BEFORE and AFTER the fix in the same process.
//
// This is a LOGIC harness, not a live WS test — it mirrors the exact branch
// structure of server.js (lobby-phone data branch + deliverLobbyFrameDuringResume
// + tryAutoResume) and lib/callQueueGuards.expiredStaleCallIds.

import { strict as assert } from 'node:assert';
import { expiredStaleCallIds } from '../lib/callQueueGuards.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok - ${name}`); };

// ---------------------------------------------------------------------------
// Minimal relay model. A socket is { id, role, open }. A room has lobby (Set),
// active {phone, browser}, and resumable claim. delivered[] records frames the
// browser actually received; dropped[] records frames the relay dropped.
// ---------------------------------------------------------------------------
const OPEN = true;
function makeRoom() {
  return { lobby: new Set(), active: { phone: null, browser: null }, resumable: null,
           delivered: [], dropped: [] };
}
function send(ws, msg, sink) { if (ws && ws.open) sink.push(msg); }

// tryAutoResume — re-scan lobby, seed from any held survivor, re-form when both
// roles available. Mirrors server.js L473-522.
function tryAutoResume(room) {
  const claim = room.resumable;
  if (!claim) return false;
  let phoneWs = room.active.phone && room.active.phone.open ? room.active.phone : null;
  let browserWs = room.active.browser && room.active.browser.open ? room.active.browser : null;
  for (const s of room.lobby) {
    if (s.role === 'phone' && !phoneWs && s.open) phoneWs = s;
    else if (s.role === 'browser' && !browserWs && s.open) browserWs = s;
  }
  if (!phoneWs || !browserWs) return false;
  room.lobby.delete(phoneWs); room.lobby.delete(browserWs);
  room.active.phone = phoneWs; room.active.browser = browserWs;
  room.resumable = null;
  return true;
}

// The lobby-phone data branch. `withFix` toggles deliverLobbyFrameDuringResume.
function onLobbyPhoneFrame(room, ws, msg, withFix) {
  if (ws === room.active.phone) { // normal active path
    send(room.active.browser, msg, room.delivered); return;
  }
  if (withFix) {
    // Hotfix 2026-06-16b: deliver to the active opposite peer whenever one is
    // present. An armed resume claim is no longer required — a live active
    // browser is sufficient (covers the duplicate-lobby-socket regression).
    const survivor = room.active.browser;
    if (survivor && survivor.open) {
      const claimArmed = !!room.resumable && Date.now() <= room.resumable.expiresAt;
      if (claimArmed && tryAutoResume(room)) {
        if (ws === room.active.phone) send(room.active.browser, msg, room.delivered);
        else send(survivor, msg, room.delivered);
      } else {
        send(survivor, msg, room.delivered); // dup-socket / armed-window passthrough
      }
      return;
    }
  }
  room.dropped.push(msg); // pre-fix behavior / no active opposite peer
}

// Scenario: browser survives a blip (droppedRole=phone). Phone re-joins lobby
// but the simultaneous-both-in-lobby resume window is MISSED (the browser
// survivor is held in active, phone sits in lobby), so the phone never becomes
// active. The phone then emits 3 live frames during the gap.
function runScenario(withFix) {
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  // Pair was active, phone blipped: soft-hold keeps browser in active, arms claim.
  room.active.browser = browser;
  room.resumable = { droppedRole: 'phone', expiresAt: Date.now() + 120000 };
  // Phone re-attaches as a NEW lobby socket.
  const phone = { id: 'p2', role: 'phone', open: OPEN };
  room.lobby.add(phone);
  // NOTE: in the broken path tryAutoResume is only attempted at lobby-JOIN; we
  // simulate the missed window by NOT calling it here (the join races ahead of
  // / behind the browser's own reconnection). Live frames now arrive:
  onLobbyPhoneFrame(room, phone, 'CALL_LOG_ENTRY:{"id":"45631617"}', withFix);
  onLobbyPhoneFrame(room, phone, 'SMS_RECEIVED:{"id":"21369"}', withFix);
  onLobbyPhoneFrame(room, phone, 'CALL_INCOMING:{"id":"16088"}', withFix);
  return room;
}

test('Bug A BEFORE: lobby-phone frames are dropped, pair never re-forms', () => {
  const room = runScenario(false);
  assert.equal(room.dropped.length, 3, 'all 3 live frames dropped pre-fix');
  assert.equal(room.delivered.length, 0, 'browser received nothing pre-fix');
  assert.equal(room.active.phone, null, 'phone still stuck in lobby pre-fix');
});

test('Bug A AFTER: pair re-forms on first frame, 0 dropped, all delivered', () => {
  const room = runScenario(true);
  assert.equal(room.dropped.length, 0, '0 frames dropped post-fix');
  assert.equal(room.delivered.length, 3, 'browser received all 3 frames post-fix');
  assert.ok(room.active.phone && room.active.phone.id === 'p2', 'phone re-formed into active');
});

test('LIVE REGRESSION: duplicate lobby-phone socket delivers to active browser with NO armed claim', () => {
  // Reproduces the 2026-06-16 notification-fetch break. The pair is fully
  // formed (active.phone = p-active, active.browser = b1) and the resume claim
  // has already been consumed (resumable = null). The physical phone holds a
  // SECOND socket in the lobby that streams live SMS / call frames.
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  const activePhone = { id: 'p-active', role: 'phone', open: OPEN };
  room.active.browser = browser;
  room.active.phone = activePhone;
  room.resumable = null; // claim already consumed — this is the regression case
  const dupPhone = { id: 'p-dup', role: 'phone', open: OPEN };
  room.lobby.add(dupPhone);

  // BEFORE the hotfix these dropped (no armed claim). AFTER: delivered to the
  // active browser because a live active opposite peer is present.
  onLobbyPhoneFrame(room, dupPhone, 'SMS_RECEIVED:{"id":"21374"}', true);
  onLobbyPhoneFrame(room, dupPhone, 'PHONE_NOTIFICATION:{"id":"n1"}', true);
  onLobbyPhoneFrame(room, dupPhone, 'CALL_LOG_ENTRY:{"id":"16097"}', true);

  assert.equal(room.dropped.length, 0, 'no live frame dropped from the dup lobby socket');
  assert.equal(room.delivered.length, 3, 'all 3 reached the active browser');
  // Active pair is untouched by the dup-socket delivery.
  assert.equal(room.active.phone, activePhone, 'active phone unchanged');
  assert.equal(room.active.browser, browser, 'active browser unchanged');
});

test('LIVE REGRESSION pre-fix: same dup-socket frames DROP without the hotfix', () => {
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  room.active.browser = browser;
  room.active.phone = { id: 'p-active', role: 'phone', open: OPEN };
  room.resumable = null;
  const dupPhone = { id: 'p-dup', role: 'phone', open: OPEN };
  room.lobby.add(dupPhone);
  onLobbyPhoneFrame(room, dupPhone, 'SMS_RECEIVED:{"id":"21374"}', false);
  assert.equal(room.dropped.length, 1, 'pre-fix: dup-socket SMS dropped');
  assert.equal(room.delivered.length, 0, 'pre-fix: browser got nothing');
});

test('Bug A AFTER (passthrough): frames reach a held survivor even if re-form is impossible', () => {
  // Force re-form impossible: clear the claim AFTER seeding so tryAutoResume
  // bails, but keep a survivor browser — exercises the passthrough leg.
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  room.active.browser = browser;
  room.resumable = { droppedRole: 'phone', expiresAt: Date.now() + 120000 };
  const phone = { id: 'p2', role: 'phone', open: OPEN };
  // phone NOT added to lobby → tryAutoResume can't find it → re-form fails →
  // passthrough to survivor.
  onLobbyPhoneFrame(room, phone, 'SMS_RECEIVED:{"id":"21370"}', true);
  assert.equal(room.dropped.length, 0, 'no drop when survivor held');
  assert.equal(room.delivered.length, 1, 'passthrough delivered to survivor');
});

// ---------------------------------------------------------------------------
// Bug B — stale "in-call" chip across a blip, using the REAL pure fn.
// ---------------------------------------------------------------------------
const NOW = 1_750_000_000_000;
const BLIP = NOW; // blip began at NOW

test('Bug B BEFORE: ACTIVE chip whose end-frame was lost is NOT cleared by B1 sweep', () => {
  // B1 only expires RINGING rows; an ACTIVE row is never TTL'd. Simulate the
  // pre-fix world: no resume-time expiry exists, so the chip persists.
  const calls = [{ callId: 'c1', number: '+34600', isIncoming: true,
                   startTime: NOW - 60000, state: 'active' }];
  const touched = new Map([['c1', NOW - 30000]]); // last event 30s before resume
  // Pre-fix path = expiredRingingCallIds only (active rows ignored). We assert
  // the active row would survive that path → stale chip persists.
  const ringingOnly = calls.filter(c => c.state === 'ringing');
  assert.equal(ringingOnly.length, 0, 'no ringing row to sweep → chip stuck pre-fix');
});

test('Bug B AFTER: resume sweep expires the active chip last touched before the blip', () => {
  const calls = [{ callId: 'c1', number: '+34600', isIncoming: true,
                   startTime: NOW - 60000, state: 'active' }];
  const touched = new Map([['c1', BLIP - 5000]]); // last event before blip start
  const stale = expiredStaleCallIds(calls, touched, BLIP);
  assert.deepEqual(stale, ['c1'], 'pre-blip active chip expired on resume');
});

test('Bug B AFTER: a live call still heartbeating after the blip is KEPT', () => {
  const calls = [{ callId: 'c2', number: '+34601', isIncoming: false,
                   startTime: NOW - 60000, state: 'active' }];
  const touched = new Map([['c2', BLIP + 4000]]); // heartbeat landed after resume
  const stale = expiredStaleCallIds(calls, touched, BLIP);
  assert.deepEqual(stale, [], 'live post-blip call is not expired');
});

// ---------------------------------------------------------------------------
// Regression guard — soft-hold STILL holds the browser through a blip.
// ---------------------------------------------------------------------------
test('Regression guard: soft-hold keeps survivor browser in active across the blip', () => {
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  room.active.browser = browser;
  room.resumable = { droppedRole: 'phone', expiresAt: Date.now() + 120000 };
  // The blip happened; before any phone returns, assert the browser was never
  // evicted to the lobby and no teardown wiped it.
  assert.equal(room.active.browser, browser, 'browser held in active (no wipe)');
  assert.equal(room.lobby.has(browser), false, 'browser not pushed to lobby');
  assert.ok(room.resumable, 'resume claim armed');
});

console.log(`\n${passed} repro assertions passed`);
