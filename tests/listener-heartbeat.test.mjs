// Relay tests — MV3 listener heartbeat (dispatch FORGE-J addendum A, 2026-09-15).
//
// Run: node tests/listener-heartbeat.test.mjs
//
// WHY THIS EXISTS
// ---------------
// Measured with cc_debug tracing and NO debugger attached (Playwright's CDP
// attach suppresses MV3 eviction — that is why the earlier
// scripts/ext-sw-lifetime-proof.mjs returned a false negative with both arms
// surviving identically): the extension's listener service worker was evicted
// TWICE inside a 5.5-minute window. Boot `s61juy` lived ~150s and died; boot
// `fi8wxv` replaced it ~64s later. A relay frame pushed into that 33.8s
// socket-less gap was LOST silently — `SOCKET_OPEN_AT_PUSH=false`, no error
// anywhere, and no `ws-close` trace row (the worker died before its own
// onclose could run). room.frameBuffer does not cover it: that buffer serves
// ACTIVE PAIRS, never listeners.
//
// The relay's existing 15s `ws.ping()` did not prevent this. A protocol-level
// ping is answered by the browser's WebSocket stack below the JS layer — it
// fires no event in the worker, so it is not extension activity and does not
// reset MV3's idle timer. The fix is a real TEXT frame, which fires
// sock.onmessage.
//
// This suite locks the three properties that make the fix correct. It mirrors
// the ~10-line selection/cadence logic from server.js' keepalive tick (there is
// no way to import a setInterval body); the fix's OTHER half — that the SW
// treats HB as a no-op and not as proof of a phone — is asserted against the
// SHIPPED worker in scripts/ext-badge-counter-proof.mjs instead of here.

import assert from 'node:assert/strict';

const OPEN = 1;
const CLOSED = 3;

/** Must stay strictly under MV3's 30s idle window, with a full tick of margin. */
const KEEPALIVE_TICK_MS = 15_000;
const MV3_IDLE_WINDOW_MS = 30_000;

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

function makeWs(role, { listener = false, readyState = OPEN } = {}) {
  return { role, listener, readyState, sent: [], pings: 0, missedPongs: 0 };
}
const safeSend = (ws, msg) => {
  if (ws.readyState !== OPEN) return false;
  ws.sent.push(msg);
  return true;
};

/** Mirror of the per-socket body of server.js' 15s keepalive tick. */
function keepaliveTick(sockets) {
  for (const ws of sockets) {
    if (!ws || ws.readyState !== OPEN) continue;
    ws.missedPongs += 1;
    ws.pings += 1; // ws.ping() — protocol level, fires NO event in the worker
    if (ws.role === 'browser' && ws.listener) {
      safeSend(ws, `HB:${JSON.stringify({})}`);
    }
  }
}

const hbCount = (ws) => ws.sent.filter((m) => m.startsWith('HB:')).length;

console.log('\nlistener heartbeat — who gets it');

test('a LISTENER receives an app-level HB text frame each tick', () => {
  const listener = makeWs('browser', { listener: true });
  keepaliveTick([listener]);
  assert.equal(hbCount(listener), 1);
  assert.equal(listener.sent[0], 'HB:{}');
});

test('the HB is a TEXT frame, NOT a protocol ping — the ping is what failed', () => {
  // The distinction is the entire fix. A protocol ping is handled beneath the
  // JS layer and fires no event, so it cannot reset MV3's idle timer; the
  // measurement showed 15s pings running right up to the eviction.
  const listener = makeWs('browser', { listener: true });
  keepaliveTick([listener]);
  assert.equal(listener.pings, 1, 'the protocol ping still goes out (stale-socket detection)');
  assert.equal(hbCount(listener), 1, 'AND a real message frame, which is the part that keeps the worker alive');
});

test('an interactive browser does NOT get an HB — its socket lives in a page', () => {
  const browser = makeWs('browser', { listener: false });
  keepaliveTick([browser]);
  assert.equal(hbCount(browser), 0);
  assert.equal(browser.pings, 1, 'still pinged for staleness detection');
});

test('a PHONE does not get an HB', () => {
  const phone = makeWs('phone');
  keepaliveTick([phone]);
  assert.equal(hbCount(phone), 0);
  assert.equal(phone.pings, 1);
});

test('a closed listener is skipped entirely', () => {
  const dead = makeWs('browser', { listener: true, readyState: CLOSED });
  keepaliveTick([dead]);
  assert.equal(hbCount(dead), 0);
  assert.equal(dead.pings, 0);
});

test('a mixed room: only the listeners are heartbeaten', () => {
  const phone = makeWs('phone');
  const browser = makeWs('browser');
  const l1 = makeWs('browser', { listener: true });
  const l2 = makeWs('browser', { listener: true });
  keepaliveTick([phone, browser, l1, l2]);
  assert.equal(hbCount(phone) + hbCount(browser), 0);
  assert.equal(hbCount(l1), 1);
  assert.equal(hbCount(l2), 1, 'every listener, not just the first');
});

console.log('\nlistener heartbeat — cadence');

test('the tick is strictly under the 30s MV3 idle window', () => {
  assert.ok(
    KEEPALIVE_TICK_MS < MV3_IDLE_WINDOW_MS,
    `tick ${KEEPALIVE_TICK_MS}ms must be < ${MV3_IDLE_WINDOW_MS}ms`,
  );
});

test('a DROPPED tick still lands inside the idle window — one tick of margin', () => {
  // The real guarantee. At 15s, losing one heartbeat to a GC pause or a slow
  // event loop still puts the next one at 30s, i.e. at the boundary rather
  // than past it. A 25s tick would satisfy "< 30s" and still die on one miss.
  assert.ok(
    KEEPALIVE_TICK_MS * 2 <= MV3_IDLE_WINDOW_MS,
    'two ticks must fit inside the idle window so a single miss is survivable',
  );
});

test('over 4 ticks (60s) a listener gets 4 heartbeats — no drift, no gap', () => {
  const listener = makeWs('browser', { listener: true });
  for (let i = 0; i < 4; i++) keepaliveTick([listener]);
  assert.equal(hbCount(listener), 4);
  // 4 ticks x 15s = 60s covered, vs the measured 33.8s socket-less gap and the
  // 63.9s worker-down interval this is meant to prevent.
});

console.log('\nlistener heartbeat — it must not lie about presence');

test('HB is not a data frame and carries no payload to misread', () => {
  const listener = makeWs('browser', { listener: true });
  keepaliveTick([listener]);
  const [type, json] = listener.sent[0].split(/:(.*)/s);
  assert.equal(type, 'HB');
  assert.deepEqual(JSON.parse(json), {}, 'empty payload — nothing to mistake for a phone or a message');
});

test('HB is distinct from every frame the SW acts on', () => {
  // background.js short-circuits HB ABOVE its `notePhonePresence(true)`
  // catch-all. If HB ever collided with a real frame name the worker would
  // either raise a notification or turn the green dot on for an empty room.
  const acted = ['SMS_RECEIVED', 'CALL_INCOMING', 'CALL_WAITING', 'PHONE_NOTIFICATION',
    'LOBBY_STATUS', 'PHONE_PRESENT', 'PHONE_ABSENT', 'ROOM_RESET', 'PING', 'PONG'];
  assert.ok(!acted.includes('HB'));
});

// ═══════════════════════════════════════════════════════════════════════════
// SEALED-PAIR TWIN — the heartbeat is NEVER sealed (E2E-P6 (a))
// ═══════════════════════════════════════════════════════════════════════════
// The HB is generated BY THE RELAY, not forwarded from a peer, so there is no
// session, no key and no counter it could be sealed under — and the extension's
// worker must be able to read it with the pair OFF, half-negotiated, or gone.
// It is therefore absent from §13.7's sealed allowlist and must stay absent.
//
// The twin below ticks the same mirror twice — once with plaintext data frames
// on the listener's socket, once with really-sealed ones — and requires that
// who gets heartbeaten, how often, and what the HB looks like are all identical,
// and that the HB itself never acquires an envelope.
//
// SCOPE: this mirrors the ~10-line tick body from server.js, as the header of
// this file already states; it proves the MIRROR, not the shipped relay.
import {
  twin, transcript, assertNoPlaintext, SEALED_FRAME_TYPES,
  MANDATORY_PLAINTEXT_FRAME_TYPES, ENVELOPE_VERSION,
} from './lib/sealed-twin.mjs';

const TWIN_CANARY = 'canary-listener-heartbeat-6ac1d4-this-plaintext-must-never-survive';

/** Four ticks over a mixed room, with a data frame pushed to the listener between ticks. */
function hbTwinScenario(mode) {
  const phone = makeWs('phone');
  const browser = makeWs('browser', { listener: false });
  const listener = makeWs('browser', { listener: true });
  const dead = makeWs('browser', { listener: true, readyState: CLOSED });
  const sockets = [phone, browser, listener, dead];

  const bodies = [], payloads = [];
  for (let i = 0; i < 4; i++) {
    keepaliveTick(sockets);
    const payload = { id: `msg-${i}`, text: `${TWIN_CANARY}-${i}` };
    payloads.push(payload);
    const body = mode.body('SMS_RECEIVED', payload);
    bodies.push(body);
    // The SW's live mirror — the traffic the HB shares a socket with.
    safeSend(listener, `SMS_RECEIVED:${JSON.stringify(body)}`);
  }
  return { phone, browser, listener, dead, bodies, payloads };
}

console.log('\nsealed-pair twin — the HB is relay-generated and never sealed');

{
  const t = twin(hbTwinScenario);
  const S = t.sealed, P = t.plain;
  const hbOf = (ws) => ws.sent.filter((m) => m.startsWith('HB:'));

  test('twin: the listener transcript is identical with the pair ON and OFF', () => {
    const a = t.agrees((o) => o.listener.sent);
    assert.equal(a.equal, true, `listener transcript diverged\n  plain : ${a.plain}\n  sealed: ${a.sealed}`);
    assert.deepEqual(hbOf(S.listener), hbOf(P.listener), 'same heartbeats, same order');
  });

  test('twin: turning the pair ON changes neither WHO is heartbeaten nor how often', () => {
    for (const arm of [P, S]) {
      assert.equal(hbOf(arm.listener).length, 4, 'one HB per tick, four ticks');
      assert.equal(hbOf(arm.phone).length, 0, 'phones never get an HB');
      assert.equal(hbOf(arm.browser).length, 0, 'interactive browsers never get an HB');
      assert.equal(hbOf(arm.dead).length, 0, 'a closed listener is skipped');
      assert.equal(arm.phone.pings, 4, 'the protocol ping is unchanged too');
      assert.equal(arm.dead.pings, 0);
    }
    assert.equal(hbOf(S.listener).length, hbOf(P.listener).length);
    // Cadence is a constant, not a mode-dependent one.
    assert.equal(KEEPALIVE_TICK_MS * 2 <= MV3_IDLE_WINDOW_MS, true);
  });

  test('twin: the HB itself carries NO envelope, in either mode', () => {
    for (const arm of [P, S]) {
      for (const hb of hbOf(arm.listener)) {
        assert.equal(hb, 'HB:{}', 'byte-identical empty payload');
        const body = JSON.parse(hb.slice('HB:'.length));
        assert.deepEqual(body, {}, 'no e/kid/s/c — nothing to decrypt');
        assert.equal(body.e, undefined);
        assert.equal(body.c, undefined);
      }
    }
    assert.equal(transcript(hbOf(S.listener)).every((x) => x.sealed === false), true);
    // ...while the data frames sharing the socket ARE sealed, which is what
    // makes the line above a statement about HB rather than about the mode.
    assert.equal(
      transcript(S.listener.sent).filter((x) => x.type === 'SMS_RECEIVED').every((x) => x.sealed === true),
      true,
      'the sealed arm really was sealed',
    );
    assert.equal(ENVELOPE_VERSION, 1);
  });

  test('twin: HB is on neither §13.7 list — it can be on neither', () => {
    // Sealing it would make it unreadable before a session exists; putting it on
    // the MANDATORY_PLAINTEXT list would imply it was ever a candidate. It is
    // relay-generated, so it is simply not a peer frame at all.
    assert.equal(SEALED_FRAME_TYPES.includes('HB'), false, 'HB must never be sealable');
    assert.equal(MANDATORY_PLAINTEXT_FRAME_TYPES.includes('HB'), false, 'HB is not a peer frame either');
  });

  test('twin: no plaintext from the sealed traffic leaks onto the HB socket', () => {
    const leak = assertNoPlaintext(JSON.stringify(S.listener.sent), S.payloads);
    assert.equal(leak.clean, true, `plaintext leaked onto the listener socket: ${JSON.stringify(leak.leaked)}`);
    const hbLeak = assertNoPlaintext(JSON.stringify(hbOf(S.listener)), S.payloads);
    assert.equal(hbLeak.clean, true, 'the HB carries nothing of the traffic around it');
  });
}

console.log(`\n${passed} assertion group(s) passed.`);
if (process.exitCode) console.error('SUITE FAILED');
else console.log('listener-heartbeat.test.mjs OK');
