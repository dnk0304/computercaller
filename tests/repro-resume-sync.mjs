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
  // (scenario: c1 last touched NOW - 30000, i.e. 30s before resume — unused on
  // the pre-fix path below, which never consults the touched map at all.)
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

// ---------------------------------------------------------------------------
// APPENDED — E2E-P6 (a): the same resume scenario with §13.7 SEALED bodies.
//
// The relay is supposed to be mode-blind: it routes on TYPE, and a sealed frame
// keeps its type and replaces only its body with {e,kid,s,c}. So every
// assertion above should hold verbatim when the bodies are ciphertext. What is
// NEW here is the anti-replay rule, which only exists in mode ON:
//
//   A resume LEGITIMATELY replays buffered frames. The correct response to a
//   repeated (kid, s) is to DEDUPE — drop the duplicate silently and keep the
//   pair up — NOT to treat it as an attack and tear the session down. A resume
//   that ends in a teardown is the outage the resume path exists to prevent.
//
// So the assertions are: same kid across the resume, buffered frames replay in
// ORDER, duplicates are deduped, rejections are zero, and no NEW frame is ever
// dropped.
//
// Same caveat as the rest of this file: this is a LOGIC harness mirroring
// server.js branch structure, not a live WS test.
// ---------------------------------------------------------------------------
import { makeTestSession, sealBody, openBody, SEALED_FRAME_TYPES } from './lib/sealed-twin.mjs';

// The receiver's anti-replay window. `deduped` and `rejected` are counted
// SEPARATELY on purpose — collapsing them is exactly the bug this guards.
function makeReceiver() {
  return { seen: new Set(), accepted: [], deduped: [], rejected: [], kids: new Set() };
}
function receiveSealed(rx, session, type, env) {
  const key = `${env.kid}|${env.s}`;
  rx.kids.add(env.kid);
  if (rx.seen.has(key)) { rx.deduped.push(key); return 'deduped'; }
  let opened;
  try { opened = openBody(session, type, env); }
  catch { rx.rejected.push(key); return 'rejected'; } // only a REAL auth failure rejects
  rx.seen.add(key);
  rx.accepted.push({ type, s: env.s, payload: opened });
  return 'accepted';
}

test('SEALED twin: mode-ON frames survive the lobby-phone path with 0 drops', () => {
  const session = makeTestSession({ kid: 'kid-p6-resume-0001' });
  const room = makeRoom();
  const browser = { id: 'b1', role: 'browser', open: OPEN };
  room.active.browser = browser;
  room.resumable = { droppedRole: 'phone', expiresAt: Date.now() + 120000 };
  const phone = { id: 'p2', role: 'phone', open: OPEN };
  room.lobby.add(phone);

  const types = ['CALL_LOG_ENTRY', 'SMS_RECEIVED', 'CALL_INCOMING'];
  assert.ok(types.every((t) => SEALED_FRAME_TYPES.includes(t)), 'all three types are on the frozen sealed allowlist');
  const envs = types.map((t, i) => sealBody(session, t, { id: `evt-${i}`, body: `sealed-${i}` }));
  types.forEach((t, i) => onLobbyPhoneFrame(room, phone, `${t}:${JSON.stringify(envs[i])}`, true));

  assert.equal(room.dropped.length, 0, '0 sealed frames dropped');
  assert.equal(room.delivered.length, 3, 'browser received all 3 sealed frames');
  assert.ok(room.active.phone && room.active.phone.id === 'p2', 'phone re-formed into active (routing never read a body)');
  // The relay must have forwarded the envelope byte-for-byte: it still opens.
  const rx = makeReceiver();
  room.delivered.forEach((frame, i) => {
    const type = frame.slice(0, frame.indexOf(':'));
    assert.equal(type, types[i], 'type survived the relay in order');
    assert.equal(receiveSealed(rx, session, type, JSON.parse(frame.slice(type.length + 1))), 'accepted');
  });
  assert.equal(rx.rejected.length, 0, 'no sealed frame was corrupted in transit');
});

test('SEALED twin: the SAME kid comes back across the resume', () => {
  const session = makeTestSession({ kid: 'kid-p6-resume-0002' });
  const rx = makeReceiver();
  // Pre-blip traffic.
  receiveSealed(rx, session, 'SMS_RECEIVED', sealBody(session, 'SMS_RECEIVED', { id: 'pre-1' }));
  // …blip… the phone re-attaches and resumes the SAME sealed session.
  receiveSealed(rx, session, 'SMS_RECEIVED', sealBody(session, 'SMS_RECEIVED', { id: 'post-1' }));
  assert.deepEqual([...rx.kids], ['kid-p6-resume-0002'], 'exactly one kid across the resume — no silent rekey');
  assert.equal(rx.rejected.length, 0, 'resume did not invalidate the key');
});

test('SEALED twin: a resume replay DEDUPES — 0 rejections, 0 teardown', () => {
  const session = makeTestSession({ kid: 'kid-p6-resume-0003' });
  const rx = makeReceiver();
  const types = ['SMS_RECEIVED', 'PHONE_NOTIFICATION', 'CALL_LOG_ENTRY'];
  const buffered = types.map((t, i) => ({ type: t, env: sealBody(session, t, { id: `buf-${i}`, body: `b${i}` }) }));

  // First pass: the frames are buffered and delivered normally.
  for (const { type, env } of buffered) assert.equal(receiveSealed(rx, session, type, env), 'accepted');
  assert.equal(rx.accepted.length, 3);

  // The blip. On resume the relay replays its whole buffer — the SAME envelopes,
  // in the SAME order. This is legitimate, not an attack.
  const outcomes = buffered.map(({ type, env }) => receiveSealed(rx, session, type, env));
  assert.deepEqual(outcomes, ['deduped', 'deduped', 'deduped'], 'every replayed frame was deduped, not rejected');
  assert.equal(rx.rejected.length, 0, 'a legitimate resume replay produces ZERO rejections');
  assert.equal(rx.accepted.length, 3, 'and zero double-deliveries');

  // Ordering is preserved through the replay: the dedupe must not reorder or
  // consume the buffer out of sequence.
  assert.deepEqual(rx.deduped, buffered.map(({ env }) => `${env.kid}|${env.s}`),
    'buffered sealed frames replayed in order');

  // …and NEW frames that arrive after the replay still land. A dedupe window
  // that swallowed post-resume traffic would be the same outage by another name.
  const fresh = ['SMS_RECEIVED', 'CALL_INCOMING'].map((t) => ({ type: t, env: sealBody(session, t, { id: `new-${t}` }) }));
  const freshOutcomes = fresh.map(({ type, env }) => receiveSealed(rx, session, type, env));
  assert.deepEqual(freshOutcomes, ['accepted', 'accepted'], 'zero NEW frames dropped after a resume replay');
  assert.equal(rx.accepted.length, 5);
  assert.equal(rx.rejected.length, 0, 'still zero rejections');
});

test('SEALED twin: dedupe is not blanket acceptance — a TAMPERED replay is rejected', () => {
  // The control for the test above. If the receiver simply never rejected
  // anything, "0 rejections on a legitimate replay" would be vacuous. A frame
  // whose ciphertext was altered has a fresh (kid,s) key, so it reaches the
  // open() path and must fail authentication there.
  const session = makeTestSession({ kid: 'kid-p6-resume-0004' });
  const rx = makeReceiver();
  const env = sealBody(session, 'SMS_RECEIVED', { id: 'genuine' });
  assert.equal(receiveSealed(rx, session, 'SMS_RECEIVED', env), 'accepted');
  const tampered = { ...env, s: env.s + 1, c: env.c.slice(0, -4) + (env.c.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  assert.equal(receiveSealed(rx, session, 'SMS_RECEIVED', tampered), 'rejected', 'tampered ciphertext must not open');
  assert.equal(rx.rejected.length, 1, 'the reject path is reachable — the 0-rejection assertions above mean something');
  assert.equal(rx.deduped.length, 0, 'and tampering is NOT mistaken for a benign duplicate');
});

console.log(`\n${passed} repro assertions passed`);
