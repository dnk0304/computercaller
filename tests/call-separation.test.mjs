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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
