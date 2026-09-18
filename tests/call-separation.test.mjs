// Call-separation Tier A tests (2026-07-14).
//
// The webapp cannot import usePhoneBridge (React hook, needs a DOM + WS), so —
// following tests/known-device-relink.test.mjs — this MIRRORS the two pure
// pieces that carry the data-loss fix: telecomForegroundOf() and the
// endCallById() safety gate. If you change the logic in usePhoneBridge.ts,
// update this copy.
//
// Root cause: telecomManager.endCall() rejects a RINGING call if present, else
// disconnects the active/foreground call. So the phone's "foreground" is
// ringing-first, which DIVERGES from the web's active/dialing-first foreground.
// A bare END_CALL therefore hit the wrong leg (dropped a real incoming call).
//
// Run: node tests/call-separation.test.mjs

// ── Mirror of usePhoneBridge.telecomForegroundOf ────────────────────────────
function telecomForegroundOf(list) {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return (
    list.find((c) => c.state === 'ringing') ??
    list.find((c) => c.state === 'active') ??
    list.find((c) => c.state === 'dialing') ??
    list[0]
  );
}

// Mirror of the web-derived foreground (currentCall) — active/dialing-first.
function foregroundOf(list) {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return (
    list.find((c) => c.state === 'active') ??
    list.find((c) => c.state === 'dialing') ??
    list[0]
  );
}

// Mirror of endCallById's decision: does firing END_CALL for `callId` actually
// hit that call? Returns { ended, sentEndCall, removedId, reason }.
function endCallById(list, callId) {
  const tfg = telecomForegroundOf(list);
  if (!tfg || tfg.callId === callId) {
    return { ended: true, sentEndCall: true, removedId: tfg ? tfg.callId : null };
  }
  return { ended: false, sentEndCall: false, reason: 'not_foreground' };
}

// ── Test runner ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

const call = (callId, state, isIncoming) => ({ callId, number: callId, state, isIncoming });

// (1) DENNIS'S BUG: outgoing dialing + incoming ringing coexist.
{
  const outgoing = call('out', 'dialing', false);
  const incoming = call('in', 'ringing', true);
  const list = [outgoing, incoming]; // dial placed first, ring arrived second
  check('1a: web foreground is the OUTGOING (dialing)', foregroundOf(list).callId === 'out');
  check('1b: telecom foreground is the INCOMING (ringing)', telecomForegroundOf(list).callId === 'in');
  check('1c: they DIVERGE (the whole bug)', foregroundOf(list).callId !== telecomForegroundOf(list).callId);

  // The user clicks hang-up on the OUTGOING chip. It is NOT the telecom
  // foreground → we must send NOTHING (never blind-END_CALL the incoming).
  const r = endCallById(list, 'out');
  check('1d: hang-up on outgoing is BLOCKED (no frame sent)', r.ended === false && r.sentEndCall === false);
  check('1e: block reason surfaced', r.reason === 'not_foreground');

  // Hang-up on the INCOMING chip (the telecom foreground) IS live and ends
  // exactly the incoming.
  const r2 = endCallById(list, 'in');
  check('1f: hang-up on incoming fires END_CALL', r2.ended === true && r2.sentEndCall === true);
  check('1g: it removes exactly the incoming row', r2.removedId === 'in');
}

// (2) Single call — telecom foreground == the only call; hang-up always safe.
{
  const only = call('solo', 'dialing', false);
  const r = endCallById([only], 'solo');
  check('2a: lone dialing call — hang-up is live', r.ended === true && r.removedId === 'solo');
  const ring = call('r', 'ringing', true);
  const r2 = endCallById([ring], 'r');
  check('2b: lone ringing call — hang-up is live', r2.ended === true);
}

// (3) Active call + waiting ringing (classic call-waiting). endCall() hits the
//     RINGING waiting leg (telecom foreground), matching phone behavior.
{
  const active = call('a', 'active', true);
  const waiting = call('w', 'ringing', true);
  const list = [active, waiting];
  check('3a: telecom foreground is the ringing waiting leg', telecomForegroundOf(list).callId === 'w');
  const r = endCallById(list, 'a');   // user targets the active leg
  check('3b: hang-up on active is BLOCKED (phone would hit the ring)', r.ended === false);
  const r2 = endCallById(list, 'w');
  check('3c: hang-up on waiting ring is live', r2.ended === true && r2.removedId === 'w');
}

// (4) Two active-ish states: active + dialing (no ring). endCall hits active.
{
  const active = call('a', 'active', true);
  const dialing = call('d', 'dialing', false);
  const list = [active, dialing];
  check('4a: telecom foreground is the active call', telecomForegroundOf(list).callId === 'a');
  check('4b: hang-up on dialing blocked', endCallById(list, 'd').ended === false);
  check('4c: hang-up on active live', endCallById(list, 'a').ended === true);
}

// (5) No calls — endCallById degrades to a plain end (clearAll), never throws.
{
  const r = endCallById([], 'whatever');
  check('5a: empty list — ended true, nothing to remove', r.ended === true && r.removedId === null);
}


// ── (6) the sealed twin: the reducer is MODE-BLIND (E2E-P6 (a)) ─────────────
//
// CALL_ADD / CALL_UPDATE / CALL_ENDED / CALL_REMOVE are all on §13.7's sealed
// allowlist, so on a mode-ON pair the call list this reducer runs over is
// assembled from bodies that arrived as `{e,kid,s,c}` and were opened by the
// client. The reducer itself sits BELOW that boundary and must never know the
// difference: the same CALL_* stream, sealed or clear, has to produce the same
// telecom foreground and the same endCallById verdict.
//
// This section therefore seals each call frame, opens it at the reducer
// boundary, and compares. Anything in the mirror that peeked at wire shape
// rather than at the opened body would diverge here.
//
// SCOPE: the reducer is a MIRROR of usePhoneBridge.telecomForegroundOf. This
// proves the mirror is mode-blind; the real hook is exercised elsewhere. See
// tests/lib/sealed-twin.mjs's header.

import {
  twin, transcript, sealBody, openBody, assertNoPlaintext,
  SEALED_FRAME_TYPES, makeTestSession,
} from './lib/sealed-twin.mjs';

const CANARY = 'CANARY-CALLSEP-3f81ad60 a call number must not reach the relay';

/**
 * The client's frame boundary: take a CALL_* frame off the wire and fold it into
 * the call list. `open` is the identity in the plaintext arm and a real AES-GCM
 * open in the sealed one — the reducer below sees only the result either way.
 */
function applyCallFrame(list, type, body) {
  switch (type) {
    case 'CALL_ADD':
      return [...list, { callId: body.callId, number: body.number, state: body.state, isIncoming: body.isIncoming }];
    case 'CALL_UPDATE':
      return list.map((c) => (c.callId === body.callId ? { ...c, state: body.state } : c));
    case 'CALL_ENDED':
    case 'CALL_REMOVE':
      return list.filter((c) => c.callId !== body.callId);
    default:
      return list;
  }
}

/** Dennis's bug, replayed as a CALL_* stream rather than a hand-built array. */
const CALL_STREAM = [
  ['CALL_ADD', { callId: 'out', number: `${CANARY}-out`, state: 'dialing', isIncoming: false }],
  ['CALL_ADD', { callId: 'in', number: `${CANARY}-in`, state: 'ringing', isIncoming: true }],
];

const callScn = twin((mode) => {
  const wire = CALL_STREAM.map(([t, p]) => [t, mode.body(t, p)]);
  // The relay forwards these verbatim; the client opens them at the boundary.
  const open = (t, b) => (mode.on ? openBody(mode.session, t, b) : b);
  let list = [];
  const frames = [];
  for (const [t, b] of wire) {
    frames.push(`${t}:${JSON.stringify(b)}`);
    list = applyCallFrame(list, t, open(t, b));
  }
  const tfg = telecomForegroundOf(list);
  const wfg = foregroundOf(list);
  return {
    list, frames,
    tfg: tfg ? tfg.callId : null,
    wfg: wfg ? wfg.callId : null,
    endOut: endCallById(list, 'out'),
    endIn: endCallById(list, 'in'),
  };
});

// (6a) The reducer's OUTPUT is identical — the whole claim, stated once.
check('6a: the reconstructed call list is identical sealed vs clear',
  JSON.stringify(callScn.plain.list) === JSON.stringify(callScn.sealed.list));
check('6b: telecom foreground is identical (and is still the ringing leg)',
  callScn.plain.tfg === callScn.sealed.tfg && callScn.sealed.tfg === 'in');
check('6c: web foreground is identical (and still DIVERGES — the bug is intact)',
  callScn.plain.wfg === callScn.sealed.wfg && callScn.sealed.wfg === 'out' &&
  callScn.sealed.wfg !== callScn.sealed.tfg);
check('6d: endCallById on the outgoing is BLOCKED in both arms',
  JSON.stringify(callScn.plain.endOut) === JSON.stringify(callScn.sealed.endOut) &&
  callScn.sealed.endOut.ended === false && callScn.sealed.endOut.reason === 'not_foreground');
check('6e: endCallById on the incoming is LIVE in both arms, same removedId',
  JSON.stringify(callScn.plain.endIn) === JSON.stringify(callScn.sealed.endIn) &&
  callScn.sealed.endIn.ended === true && callScn.sealed.endIn.removedId === 'in');
// The control arm. Without it, a reducer that returned [] for everything would
// satisfy 6a–6c by agreeing with itself.
check('6f: the list is NOT empty (the stream really was applied)',
  callScn.sealed.list.length === 2 && callScn.sealed.list[0].callId === 'out');

// (6g) Transcript equality over the wire the relay actually saw.
//
// FINDING, recorded rather than smoothed over: transcript()'s keep-list treats
// `state` as relay-owned, which it is for PAIR_STATE — but for a CALL_* frame
// `state` is a BODY field (ringing/active/dialing). So a raw transcript
// comparison of CALL_* frames does NOT agree, and it SHOULD NOT: the plaintext
// arm exposes the call's state to the relay and the sealed arm does not. That
// difference is the seal working, not the relay behaving differently, so it is
// asserted in both directions below instead of being defined away.
{
  const relayView = (frames) => JSON.stringify(transcript(frames).map((t) => ({ type: t.type, hasE2eBlock: t.hasE2eBlock })));
  check('6g: the relay-decision transcript is identical plaintext vs sealed' +
    (relayView(callScn.plain.frames) === relayView(callScn.sealed.frames) ? '' :
      ` — plain=${relayView(callScn.plain.frames)} sealed=${relayView(callScn.sealed.frames)}`),
    relayView(callScn.plain.frames) === relayView(callScn.sealed.frames));
  // The one field that must NOT survive: the call's state, visible to the relay
  // in the clear arm and invisible in the sealed one.
  check('6g2: the call state is visible to the relay in the clear and hidden when sealed',
    transcript(callScn.plain.frames).every((t) => typeof t.state === 'string') &&
    transcript(callScn.sealed.frames).every((t) => t.state === undefined));
  check('6h: that transcript is NOT empty and keeps both CALL_ADDs in order',
    JSON.stringify(transcript(callScn.sealed.frames).map((t) => t.type)) ===
    JSON.stringify(['CALL_ADD', 'CALL_ADD']));
  check('6i: every frame on the wire really was sealed in the ON arm',
    transcript(callScn.sealed.frames).every((t) => t.sealed === true) &&
    transcript(callScn.plain.frames).every((t) => t.sealed === false));
}

// (6j) Verbatim passthrough — what the client opens is what the phone sealed.
{
  const out = JSON.parse(callScn.sealed.frames[1].slice('CALL_ADD:'.length));
  let opened = null;
  try { opened = openBody(callScn.session, 'CALL_ADD', out); } catch (e) { opened = { err: String(e) }; }
  check('6j: the envelope survives the relay unchanged and still opens',
    opened && opened.callId === 'in' && opened.number === `${CANARY}-in` && opened.state === 'ringing');
}

// (6k) No plaintext leak: the phone number never appears on the wire in the ON
//      arm, and demonstrably does in the OFF arm.
{
  const secrets = { a: `${CANARY}-out`, b: `${CANARY}-in` };
  const res = assertNoPlaintext(JSON.stringify(callScn.sealed.frames), secrets);
  check('6k: no call number survives in plaintext on the sealed wire' +
    (res.clean ? '' : ` — ${JSON.stringify(res.leaked)}`), res.clean);
  const ctrl = assertNoPlaintext(JSON.stringify(callScn.plain.frames), secrets);
  check('6l: …and the plaintext arm genuinely does leak it (the detector works)',
    ctrl.clean === false && ctrl.leaked.length === 2);
}

// (6m) The whole allowlist, not just the two frames above: each CALL_* type on
//      §13.7's sealed list must round-trip and drive the reducer identically.
{
  const CALL_TYPES = SEALED_FRAME_TYPES.filter((t) => /^CALL_(ADD|UPDATE|ENDED|REMOVE)$/.test(t));
  check('6m: all four CALL_* reducer frames are on the sealed allowlist',
    JSON.stringify(CALL_TYPES.sort()) === JSON.stringify(['CALL_ADD', 'CALL_ENDED', 'CALL_REMOVE', 'CALL_UPDATE']));

  // Call-waiting, then the ring is answered, then the first leg is removed.
  const stream = [
    ['CALL_ADD', { callId: 'a', number: `${CANARY}-a`, state: 'active', isIncoming: true }],
    ['CALL_ADD', { callId: 'w', number: `${CANARY}-w`, state: 'ringing', isIncoming: true }],
    ['CALL_UPDATE', { callId: 'w', state: 'active' }],
    ['CALL_ENDED', { callId: 'a' }],
    ['CALL_REMOVE', { callId: 'a' }],
  ];
  const run = (sealed) => {
    const session = sealed ? makeTestSession({ kid: 'kid-callsep' }) : null;
    let list = [];
    const seen = [];
    for (const [t, p] of stream) {
      const body = sealed ? sealBody(session, t, p) : p;
      const opened = sealed ? openBody(session, t, JSON.parse(JSON.stringify(body))) : body;
      list = applyCallFrame(list, t, opened);
      const f = telecomForegroundOf(list);
      seen.push([t, f ? f.callId : null, list.length]);
    }
    return JSON.stringify(seen);
  };
  const clear = run(false), sealedRun = run(true);
  check(`6n: the full CALL_* sequence drives the reducer identically` +
    (clear === sealedRun ? '' : ` — clear=${clear} sealed=${sealedRun}`), clear === sealedRun);
  check('6o: …and the foreground really moved during it (not a constant)',
    new Set(JSON.parse(clear).map((x) => x[1])).size >= 2);
  check('6p: the sequence ends with only the answered waiting leg',
    JSON.parse(clear)[4][1] === 'w' && JSON.parse(clear)[4][2] === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
