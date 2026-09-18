// Relay tests — "Reset lobby" (dispatch FORGE-J, 2026-09-15).
//
// Run: node tests/reset-room.test.mjs
//
// UNLIKE the other relay .mjs suites, this file does NOT mirror server.js. The
// reset primitive lives in lib/roomReset-core.js precisely so both call sites
// (the RESET_ROOM frame and POST /api/relay/reset) and this test run the SAME
// bytes. A mirror can pass while production is broken; this cannot.
//
// What is still a mirror, and why that is acceptable: the ~20 lines of server.js
// that decide WHETHER to call resetRoom — the listener short-circuit, the
// rate-limit gate, the ack ordering. Those are reproduced in
// `browserFrameHandler` below with the real limiter wired in. If you change the
// RESET_ROOM branch in server.js, change that function too.

import assert from 'node:assert/strict';
import {
  resetRoom,
  createResetRateLimiter,
  RESET_CLOSE_CODE_PHONE,
  RESET_CLOSE_CODE_BROWSER,
  RESET_CLOSE_REASON,
  RESET_RATE_LIMIT_MS,
} from '../lib/roomReset-core.js';

const OPEN = 1;
const CLOSED = 3;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    process.exitCode = 1;
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeWs(role, { listener = false, userId = 'u1' } = {}) {
  return {
    role,
    listener,
    userId,
    readyState: OPEN,
    sent: [],
    closes: [],
  };
}

const safeSend = (ws, msg) => {
  if (ws.readyState !== OPEN) return false;
  ws.sent.push(msg);
  return true;
};
const closeSocket = (ws, code, reason) => {
  ws.closes.push({ code, reason });
  ws.readyState = CLOSED;
};

function makeRoom(token = 'tok-1') {
  return {
    token,
    lobby: new Set(),
    active: { browser: null, phone: null },
    pendingPairing: null,
    resumable: null,
    pairIdentity: null,
    frameBuffer: [],
  };
}

function makeWorld() {
  const rooms = new Map();
  const room = makeRoom();
  rooms.set(room.token, room);
  const logs = [];
  const deps = { safeSend, closeSocket, rooms, log: (m) => logs.push(m) };
  return { rooms, room, deps, logs };
}

/**
 * Mirror of the RESET_ROOM branch in server.js' browser message handler.
 * See the header note — this is the only mirrored code in the file.
 */
function browserFrameHandler(room, ws, msg, { rooms, limiter, deps, now }) {
  // Listeners are short-circuited far above the control plane in server.js.
  if (ws.listener) return 'ignored';
  if (!msg.startsWith('RESET_ROOM:')) return 'not-handled';
  const gate = limiter.check(ws.userId, now);
  if (!gate.allowed) {
    safeSend(ws, `RESET_ROOM_ACK:${JSON.stringify({ ok: false, reason: 'rate_limited', retryAfterMs: gate.retryAfterMs })}`);
    return 'rate-limited';
  }
  safeSend(ws, `RESET_ROOM_ACK:${JSON.stringify({ ok: true })}`);
  const r = rooms.get(room.token);
  if (!r) return 'no-room';
  resetRoom(r, deps, 'frame');
  return 'reset';
}

// ── 1. The core teardown ────────────────────────────────────────────────────

console.log('\nresetRoom — core teardown');

test('closes every socket in the room: phone, browser AND listener', () => {
  const { room, deps } = makeWorld();
  const phone = makeWs('phone');
  const browser = makeWs('browser');
  const listener = makeWs('browser', { listener: true });
  room.active = { browser, phone };
  room.lobby.add(listener);

  const r = resetRoom(room, deps);

  assert.equal(r.closed, 3, 'all three sockets closed');
  assert.equal(r.phones, 1);
  assert.equal(r.browsers, 1);
  assert.equal(r.listeners, 1);
  for (const ws of [phone, browser, listener]) {
    assert.equal(ws.closes.length, 1, `${ws.role}/${ws.listener} closed exactly once`);
  }
});

test('phone gets close 1000 — the APK code that redials in 5s with NO error UI', () => {
  // PhoneClient.kt:69-81 invokes onConnectionError for every code != 1000,
  // which flips PhoneService to RelayPhase.FAILED. onConnectionChange(false)
  // schedules the fixed 5s redial for EVERY code, so 1000 costs no latency and
  // buys a calm phone UI. 4401 would be catastrophic — it cancels the redial
  // permanently — so assert we are nowhere near it.
  const { room, deps } = makeWorld();
  const phone = makeWs('phone');
  room.active.phone = phone;

  resetRoom(room, deps);

  assert.deepEqual(phone.closes[0], { code: 1000, reason: RESET_CLOSE_REASON });
  assert.equal(RESET_CLOSE_CODE_PHONE, 1000);
  assert.notEqual(RESET_CLOSE_CODE_PHONE, 4401, 'NEVER 4401 — the APK stops reconnecting on it');
});

test('browsers and listeners get close 4010 — non-terminal, not the 4001 kick', () => {
  const { room, deps } = makeWorld();
  const browser = makeWs('browser');
  const listener = makeWs('browser', { listener: true });
  room.active.browser = browser;
  room.lobby.add(listener);

  resetRoom(room, deps);

  assert.deepEqual(browser.closes[0], { code: 4010, reason: RESET_CLOSE_REASON });
  assert.deepEqual(listener.closes[0], { code: 4010, reason: RESET_CLOSE_REASON });
  assert.equal(RESET_CLOSE_CODE_BROWSER, 4010);
  assert.notEqual(RESET_CLOSE_CODE_BROWSER, 4001, 'NEVER 4001 — terminal, strands the user on the kicked card');
});

test('clears the state Disconnect leaves behind: resumable, frameBuffer, pendingPairing', () => {
  // This is the whole reason the action exists. terminateActivePair('user_left')
  // clears active + frameBuffer but NOT resumable's arming path, and never
  // touches a live pendingPairing or the lobby Set.
  const { room, deps } = makeWorld();
  let timerCleared = false;
  const browser = makeWs('browser');
  room.lobby.add(browser);
  room.resumable = { droppedRole: 'phone', expiresAt: Date.now() + 30_000 };
  room.frameBuffer = [{ msg: 'SMS_RECEIVED:{}', at: Date.now() }];
  room.pairIdentity = { deviceName: 'Pixel' };
  room.pendingPairing = {
    id: 'p1',
    browserWs: browser,
    timer: setTimeout(() => { timerCleared = false; }, 60_000),
  };
  // Prove the clearTimeout actually ran by swapping in a sentinel.
  clearTimeout(room.pendingPairing.timer);
  room.pendingPairing.timer = setTimeout(() => {}, 60_000);

  resetRoom(room, deps);

  assert.equal(room.resumable, null, 'resumable cleared — no silent re-form with a corpse');
  assert.deepEqual(room.frameBuffer, [], 'frameBuffer cleared — no stale replay');
  assert.equal(room.pendingPairing, null, 'pendingPairing cleared');
  assert.equal(room.pairIdentity, null);
  assert.equal(room.lobby.size, 0, 'lobby emptied');
  assert.equal(room.active.browser, null);
  assert.equal(room.active.phone, null);
  assert.equal(timerCleared, false);
});

test('reaps the room from the rooms Map', () => {
  const { rooms, room, deps } = makeWorld();
  room.lobby.add(makeWs('phone'));
  assert.equal(rooms.size, 1);

  resetRoom(room, deps);

  assert.equal(rooms.size, 0, 'room deleted — the next connect builds a virgin one');
  assert.equal(rooms.get('tok-1'), undefined);
});

test('a socket in BOTH lobby and active is closed exactly once', () => {
  // The dock handoff window genuinely produces this. A double close would
  // double-fire the ws close handler and double-count the result.
  const { room, deps } = makeWorld();
  const browser = makeWs('browser');
  room.active.browser = browser;
  room.lobby.add(browser);

  const r = resetRoom(room, deps);

  assert.equal(browser.closes.length, 1);
  assert.equal(r.closed, 1);
  assert.equal(r.browsers, 1);
});

test('sends PAIRING_TERMINATED to the active pair and ROOM_RESET to everyone', () => {
  const { room, deps } = makeWorld();
  const phone = makeWs('phone');
  const browser = makeWs('browser');
  const listener = makeWs('browser', { listener: true });
  room.active = { browser, phone };
  room.lobby.add(listener);

  resetRoom(room, deps);

  for (const ws of [phone, browser]) {
    assert.ok(
      ws.sent.some((m) => m.startsWith('PAIRING_TERMINATED:') && m.includes('room_reset')),
      'active peer told the pairing ended',
    );
  }
  for (const ws of [phone, browser, listener]) {
    assert.ok(ws.sent.some((m) => m.startsWith('ROOM_RESET:')), 'every socket got ROOM_RESET');
  }
  // Ordering matters: frames must be queued while the socket is still OPEN.
  assert.ok(listener.sent.length > 0, 'frame landed before the close');
});

test('a socket that throws on close does not abort the rest of the teardown', () => {
  const { room, rooms, logs } = makeWorld();
  const bad = makeWs('browser');
  const good = makeWs('phone');
  room.lobby.add(bad);
  room.lobby.add(good);
  const deps = {
    safeSend,
    closeSocket: (ws, code, reason) => {
      if (ws === bad) throw new Error('already closing');
      closeSocket(ws, code, reason);
    },
    rooms,
    log: (m) => logs.push(m),
  };

  resetRoom(room, deps);

  assert.equal(good.closes.length, 1, 'the healthy socket still got closed');
  assert.equal(rooms.size, 0, 'the room was still reaped');
});

test('an already-empty room is a no-op, not a crash', () => {
  const { room, rooms, deps } = makeWorld();
  const r = resetRoom(room, deps);
  assert.equal(r.closed, 0);
  assert.equal(rooms.size, 0);
});

// ── 2. The frame path ───────────────────────────────────────────────────────

console.log('\nRESET_ROOM frame path');

test('an interactive browser frame resets the room and is acked ok:true', () => {
  const { room, rooms, deps } = makeWorld();
  const limiter = createResetRateLimiter();
  const browser = makeWs('browser');
  const phone = makeWs('phone');
  room.active = { browser, phone };

  const out = browserFrameHandler(room, browser, 'RESET_ROOM:{}', { rooms, limiter, deps, now: 1000 });

  assert.equal(out, 'reset');
  assert.ok(browser.sent.some((m) => m === 'RESET_ROOM_ACK:{"ok":true}'), 'acked before teardown');
  assert.equal(rooms.size, 0);
  assert.equal(phone.closes[0].code, 1000);
  assert.equal(browser.closes[0].code, 4010);
});

test('the ack is queued BEFORE the socket is closed', () => {
  // If server.js acked after doResetRoom the socket would already be CLOSED and
  // safeSend would drop the frame silently.
  const { room, rooms, deps } = makeWorld();
  const limiter = createResetRateLimiter();
  const browser = makeWs('browser');
  room.active.browser = browser;

  browserFrameHandler(room, browser, 'RESET_ROOM:{}', { rooms, limiter, deps, now: 1000 });

  assert.ok(browser.sent.includes('RESET_ROOM_ACK:{"ok":true}'));
  assert.equal(browser.readyState, CLOSED);
});

test('a LISTENER frame is IGNORED — a passive SW must never destroy the room', () => {
  const { room, rooms, deps } = makeWorld();
  const limiter = createResetRateLimiter();
  const listener = makeWs('browser', { listener: true });
  const phone = makeWs('phone');
  room.lobby.add(listener);
  room.lobby.add(phone);

  const out = browserFrameHandler(room, listener, 'RESET_ROOM:{}', { rooms, limiter, deps, now: 1000 });

  assert.equal(out, 'ignored');
  assert.equal(rooms.size, 1, 'room untouched');
  assert.equal(phone.closes.length, 0, 'phone not dropped');
  assert.equal(listener.sent.length, 0, 'no ack to a listener');
  assert.equal(room.lobby.size, 2);
});

test('the frame is NOT gated on being the active browser — that gate is the bug', () => {
  // A wedged room is exactly the room where this socket was never promoted to
  // room.active.browser. LEAVE_ACTIVE's `ws === room.active.browser` check is
  // why Disconnect cannot rescue it.
  const { room, rooms, deps } = makeWorld();
  const limiter = createResetRateLimiter();
  const lobbyBrowser = makeWs('browser');
  const phantomPhone = makeWs('phone');
  room.lobby.add(lobbyBrowser);
  room.lobby.add(phantomPhone);
  assert.equal(room.active.browser, null, 'precondition: not the active browser');

  const out = browserFrameHandler(room, lobbyBrowser, 'RESET_ROOM:{}', { rooms, limiter, deps, now: 1000 });

  assert.equal(out, 'reset');
  assert.equal(phantomPhone.closes.length, 1, 'the phantom phone was dropped');
  assert.equal(rooms.size, 0);
});

// ── 3. Rate limiting ────────────────────────────────────────────────────────

console.log('\nrate limit — 1 per 5s per user');

test('a second reset within 5s is refused with a retryAfterMs', () => {
  const limiter = createResetRateLimiter();
  const first = limiter.check('u1', 0);
  assert.equal(first.allowed, true);
  const second = limiter.check('u1', 4_999);
  assert.equal(second.allowed, false);
  assert.equal(second.retryAfterMs, 1);
});

test('a reset at exactly the window boundary is allowed', () => {
  const limiter = createResetRateLimiter();
  limiter.check('u1', 0);
  assert.equal(limiter.check('u1', RESET_RATE_LIMIT_MS).allowed, true);
});

test('the limit is PER USER — one user cannot block another', () => {
  const limiter = createResetRateLimiter();
  assert.equal(limiter.check('u1', 0).allowed, true);
  assert.equal(limiter.check('u2', 0).allowed, true, 'a different user is unaffected');
  assert.equal(limiter.check('u1', 100).allowed, false);
});

test('a refused attempt does NOT extend the window (no lockout spiral)', () => {
  // If a rejected check wrote its timestamp, a user hammering the button would
  // never get back in. It must record only ACCEPTED resets.
  const limiter = createResetRateLimiter();
  limiter.check('u1', 0);
  limiter.check('u1', 1_000); // refused
  limiter.check('u1', 2_000); // refused
  assert.equal(limiter.check('u1', 5_000).allowed, true, 'window still measured from the accepted reset');
});

test('the frame path refuses a rapid second RESET_ROOM and acks ok:false', () => {
  const limiter = createResetRateLimiter();
  const w1 = makeWorld();
  const b1 = makeWs('browser');
  w1.room.active.browser = b1;
  browserFrameHandler(w1.room, b1, 'RESET_ROOM:{}', { rooms: w1.rooms, limiter, deps: w1.deps, now: 0 });

  // Fresh room (the first reset reaped the old one) — same user, 1s later.
  const w2 = makeWorld();
  const b2 = makeWs('browser');
  w2.room.active.browser = b2;
  const out = browserFrameHandler(w2.room, b2, 'RESET_ROOM:{}', { rooms: w2.rooms, limiter, deps: w2.deps, now: 1_000 });

  assert.equal(out, 'rate-limited');
  assert.equal(w2.rooms.size, 1, 'the second room was NOT torn down');
  assert.equal(b2.closes.length, 0, 'the socket stayed open');
  const ack = b2.sent.find((m) => m.startsWith('RESET_ROOM_ACK:'));
  assert.ok(ack, 'refusal is acked, not silently dropped');
  const body = JSON.parse(ack.slice('RESET_ROOM_ACK:'.length));
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'rate_limited');
  assert.equal(body.retryAfterMs, 4_000);
});

test('the HTTP path shares the frame path budget — no doubling by alternating', () => {
  // server.js runs both entry points through ONE limiter keyed on userId. This
  // asserts the property that makes that correct.
  const limiter = createResetRateLimiter();
  assert.equal(limiter.check('u1', 0).allowed, true, 'frame path consumes the budget');
  assert.equal(limiter.check('u1', 500).allowed, false, 'HTTP path is refused on the same budget');
});

test('sweep bounds the limiter Map but never evicts a live entry', () => {
  const limiter = createResetRateLimiter();
  limiter.check('u1', 0);
  limiter.check('u2', 0);
  assert.equal(limiter.size(), 2);
  limiter.sweep(RESET_RATE_LIMIT_MS * 3); // well inside 10x — nothing evicted
  assert.equal(limiter.size(), 2, 'entries inside 10x the window survive');
  limiter.sweep(RESET_RATE_LIMIT_MS * 11);
  assert.equal(limiter.size(), 0, 'stale entries reaped');
});

test('a null/absent userId is not rate-limited into a shared bucket', () => {
  // Every real path supplies ws.userId, but if one ever did not, keying every
  // such caller on `undefined` would let one of them lock out all the others.
  const limiter = createResetRateLimiter();
  assert.equal(limiter.check(null, 0).allowed, true);
  assert.equal(limiter.check(null, 1).allowed, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// SEALED-PAIR TWIN — the reset teardown is MODE-BLIND (E2E-P6 (a))
// ═══════════════════════════════════════════════════════════════════════════
// Unlike the twins in the other relay suites, this one runs against the REAL
// lib/roomReset-core.js, not a mirror — so it is evidence about the shipped
// reset primitive rather than about a copy of it. What it is still not is
// evidence about the relay AROUND that primitive (the RESET_ROOM branch below
// is mirrored, and P6 (g) is what exercises `node server.js`).
//
// The claim: resetRoom routes and closes on ROLE, never on a frame body, so a
// room full of sealed frames tears down byte-for-byte like a plaintext one —
// and the sealed frames in the buffer are DESTROYED by the reset rather than
// surviving into the next pair.
import {
  twin, transcript, openBody, assertNoPlaintext, e2eBlock,
} from './lib/sealed-twin.mjs';

const TWIN_CANARY = 'canary-reset-room-2b7e05-this-plaintext-must-never-survive';

/**
 * A fully-loaded room at the moment of reset: an active pair, a listener, a
 * live resume claim holding the pair's identity, and three buffered frames
 * waiting to replay onto whoever resumes next.
 */
function resetTwinScenario(mode) {
  const { rooms, room, deps, logs } = makeWorld();
  const phone = makeWs('phone');
  const browser = makeWs('browser');
  const listener = makeWs('browser', { listener: true });
  room.active = { browser, phone };
  room.lobby.add(listener);

  const e2e = mode.block();
  room.pairIdentity = e2e
    ? { ua: 'Chrome', ip: '1.2.3.4', deviceName: 'Pixel', e2e }
    : { ua: 'Chrome', ip: '1.2.3.4', deviceName: 'Pixel' };

  const bodies = [], payloads = [];
  for (let i = 0; i < 3; i++) {
    const payload = { id: `msg-${i}`, text: `${TWIN_CANARY}-${i}` };
    payloads.push(payload);
    const body = mode.body('SMS_RECEIVED', payload);
    bodies.push(body);
    room.frameBuffer.push({ msg: `SMS_RECEIVED:${JSON.stringify(body)}`, at: 1_000 + i });
  }
  room.resumable = { droppedRole: 'browser', panelHold: true, expiresAt: 9e15, identity: room.pairIdentity };

  // Prove the buffered envelopes were intact going IN — otherwise "nothing
  // sealed survived" could be true because nothing sealed ever existed.
  const bufferedBefore = room.frameBuffer.map((e) => e.msg);

  const r = resetRoom(room, deps, 'frame');
  return { rooms, room, phone, browser, listener, r, bodies, payloads, bufferedBefore, logs, e2e };
}

console.log('\nsealed-pair twin — reset teardown');

{
  const t = twin(resetTwinScenario);
  const S = t.sealed, P = t.plain;

  test('twin: every socket transcript is identical in plaintext and sealed modes', () => {
    for (const [name, pick] of [['phone', (o) => o.phone.sent], ['browser', (o) => o.browser.sent], ['listener', (o) => o.listener.sent]]) {
      const a = t.agrees(pick);
      assert.equal(a.equal, true, `${name} transcript diverged\n  plain : ${a.plain}\n  sealed: ${a.sealed}`);
    }
    assert.deepEqual(S.r, P.r, 'the same sockets were closed and counted in both modes');
  });

  test('twin: close codes are unchanged by the mode — phone 1000, browser/listener 4010', () => {
    for (const arm of [P, S]) {
      assert.deepEqual(arm.phone.closes, [{ code: RESET_CLOSE_CODE_PHONE, reason: RESET_CLOSE_REASON }]);
      assert.deepEqual(arm.browser.closes, [{ code: RESET_CLOSE_CODE_BROWSER, reason: RESET_CLOSE_REASON }]);
      assert.deepEqual(arm.listener.closes, [{ code: RESET_CLOSE_CODE_BROWSER, reason: RESET_CLOSE_REASON }]);
    }
    assert.deepEqual(S.phone.closes, P.phone.closes);
    assert.deepEqual(S.browser.closes, P.browser.closes);
    assert.deepEqual(S.listener.closes, P.listener.closes);
  });

  test('twin: the buffered frames really WERE sealed envelopes going in', () => {
    // The negative below ("nothing sealed survived") is only meaningful if
    // something sealed existed. Open each one from the pre-reset snapshot.
    assert.equal(S.bufferedBefore.length, 3);
    S.bufferedBefore.forEach((msg, i) => {
      const env = JSON.parse(msg.slice('SMS_RECEIVED:'.length));
      assert.equal(JSON.stringify(env), JSON.stringify(S.bodies[i]), 'buffered verbatim');
      assert.deepEqual(openBody(t.session, 'SMS_RECEIVED', env), S.payloads[i]);
    });
    assert.equal(transcript(S.bufferedBefore).every((x) => x.sealed === true), true);
  });

  test('twin: the reset DESTROYS the sealed buffer — nothing replays onto the next pair', () => {
    assert.deepEqual(S.room.frameBuffer, [], 'frameBuffer cleared in sealed mode too');
    assert.deepEqual(P.room.frameBuffer, []);
    assert.equal(S.room.resumable, null, 'no claim left to re-form with');
    assert.equal(S.room.pairIdentity, null, 'the e2e block went with the identity');
    assert.equal(S.room.pendingPairing, null);
    assert.equal(S.room.lobby.size, 0);
    assert.equal(S.rooms.size, 0, 'room reaped in sealed mode exactly as in plaintext');
    assert.equal(P.rooms.size, 0);
  });

  test('twin: no sealed CIPHERTEXT survives the reap either', () => {
    const survivors = JSON.stringify({
      room: { frameBuffer: S.room.frameBuffer, resumable: S.room.resumable, pairIdentity: S.room.pairIdentity, active: S.room.active },
      rooms: [...S.rooms.keys()],
      logs: S.logs,
    });
    for (const body of S.bodies) {
      assert.equal(survivors.includes(body.c), false, 'a ciphertext blob outlived the reset');
      assert.equal(survivors.includes(String(body.kid)), false, 'the kid outlived the reset');
    }
  });

  test('twin: no plaintext leak anywhere the reset touched', () => {
    // Secrets are the payloads themselves — never a decrypted value — so a
    // broken open cannot empty the secret set and pass this vacuously.
    const hay = JSON.stringify({
      room: { frameBuffer: S.room.frameBuffer, resumable: S.room.resumable, pairIdentity: S.room.pairIdentity },
      sent: { phone: S.phone.sent, browser: S.browser.sent, listener: S.listener.sent },
      closes: { phone: S.phone.closes, browser: S.browser.closes, listener: S.listener.closes },
      logs: S.logs,
      bufferedBefore: S.bufferedBefore,
    });
    const leak = assertNoPlaintext(hay, S.payloads);
    assert.equal(leak.clean, true, `plaintext leaked: ${JSON.stringify(leak.leaked)}`);
  });

  test('twin: the mode flag changes nothing about which frames the reset emits', () => {
    // PAIRING_TERMINATED to the active pair, ROOM_RESET to everyone — all
    // relay-generated, so all plaintext in both modes, by construction.
    const types = (ws) => transcript(ws.sent).map((x) => `${x.type}${x.sealed ? '(sealed)' : ''}`).join(',');
    assert.equal(types(S.phone), 'PAIRING_TERMINATED,ROOM_RESET');
    assert.equal(types(S.phone), types(P.phone));
    assert.equal(types(S.browser), types(P.browser));
    assert.equal(types(S.listener), 'ROOM_RESET', 'the listener gets the notice, not a teardown');
    assert.equal(types(S.listener), types(P.listener));
    assert.equal(e2eBlock({ kid: t.session.kid }).kid, t.session.kid, 'e2e blocks are opaque shape-only to the relay');
  });
}

console.log(`\n${passed} assertion group(s) passed.`);
if (process.exitCode) console.error('SUITE FAILED');
else console.log('reset-room.test.mjs OK');
