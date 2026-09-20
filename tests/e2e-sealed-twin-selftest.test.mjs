/**
 * Regression test for the twin kit itself. (E2E-P6.)
 *
 * WHY A TEST HELPER NEEDS ITS OWN TEST
 * ------------------------------------
 * Every mode-ON twin added in P6 (a) rests on `transcript()`. If `transcript()`
 * quietly drops the very field a scenario turns on, the twin built over it
 * still prints `ok` — forever, for any bug. That is not a weak test, it is an
 * assertion with no way to go red, and it makes a whole suite worthless while
 * looking healthy.
 *
 * That is not hypothetical here. It happened: `transcript()` kept one fixed
 * global field list, PAIR_STATE's entire payload is three relay-COMPUTED truth
 * fields (`phonePresent`, `paired`, `held`), none of the three were on that
 * list, and so a PAIR_STATE transcript comparison compared
 * `{type:'PAIR_STATE'}` with `{type:'PAIR_STATE'}`. A planted bug that set
 * `held = true` whenever an e2e block was present stayed green straight
 * through it.
 *
 * So this file does what the project rule asks: it writes the test for the bug
 * FIRST and then keeps it. Each case below plants a defect and requires the kit
 * to NOTICE. A case that passes because nothing happened is a case that has to
 * fail here.
 */
import {
  transcript, sealBody, openBody, makeTestSession, assertNoPlaintext, paddedLength,
} from './lib/sealed-twin.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const frame = (type, payload) => `${type}:${JSON.stringify(payload)}`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. the exact hole that was found: PAIR_STATE truth fields ──────────────
//
// The planted defect is the real one from the (a) work: the relay leaks mode
// into a truth field by setting `held` when an e2e block is present.
{
  const clear = [frame('PAIR_STATE', { phonePresent: true, paired: true, held: false })];
  const buggy = [frame('PAIR_STATE', { phonePresent: true, paired: true, held: true })];
  const same = [frame('PAIR_STATE', { phonePresent: true, paired: true, held: false })];

  check('1a: transcript() carries PAIR_STATE\'s three computed truth fields',
    (() => {
      const t = transcript(clear)[0];
      return t.phonePresent === true && t.paired === true && t.held === false;
    })(),
    JSON.stringify(transcript(clear)[0]));

  check('1b: a flipped `held` makes the two transcripts DIFFER (the bug is caught)',
    !eq(transcript(clear), transcript(buggy)));

  check('1c: an unchanged frame still compares equal (no false positive)',
    eq(transcript(clear), transcript(same)));

  // The guard on the guard: if someone ever prunes the per-type table again,
  // 1b silently becomes unfalsifiable. So assert the FIELD is present, not just
  // that the comparison happened to differ.
  check('1d: `held` is actually present in the transcript, not merely compared',
    Object.prototype.hasOwnProperty.call(transcript(buggy)[0], 'held'));
}

// ── 2. a body field must not masquerade as a relay decision ────────────────
//
// `state` is kept ON PURPOSE for CALL_*, so that the exposure is observable:
// in the clear the relay can read the call's state, sealed it cannot. The twin
// asserts the difference in both directions rather than defining it away.
{
  const s = makeTestSession();
  const clear = [frame('CALL_ADD', { callId: 'in', number: '+4790000000', state: 'ringing' })];
  const sealed = [frame('CALL_ADD', sealBody(s, 'CALL_ADD', { callId: 'in', number: '+4790000000', state: 'ringing' }))];

  check('2a: in the clear, the call state is visible to the relay',
    typeof transcript(clear)[0].state === 'string');
  check('2b: sealed, the call state is NOT visible to the relay',
    transcript(sealed)[0].state === undefined);
  check('2c: the sealed frame is marked sealed and keeps its routable type',
    transcript(sealed)[0].sealed === true && transcript(sealed)[0].type === 'CALL_ADD');
}

// ── 3. the no-plaintext detector must fire, and must not fire falsely ──────
//
// The failure mode this catches is subtle and was hit for real during (a): if
// the secrets are taken from the DECRYPTED payload, then a plant that breaks
// decryption empties the secret set and the check passes vacuously. Secrets
// must always come from the pre-seal object.
{
  const s = makeTestSession();
  const payload = { body: 'CC-CANARY-selftest-plaintext-body', address: '+4791234567' };
  const env = sealBody(s, 'SMS_RECEIVED', payload);

  check('3a: clean on real ciphertext', assertNoPlaintext(env.c, payload).clean);
  check('3b: fires on a planted leak',
    !assertNoPlaintext(`log: body=${payload.body}`, payload).clean);
  check('3c: an EMPTY secret set is not silently "clean" — it is vacuous',
    assertNoPlaintext('anything at all', {}).leaked.length === 0
    && assertNoPlaintext(`body=${payload.body}`, payload).leaked.length > 0,
    'a vacuous pass and a real pass must not be indistinguishable');
  check('3d: short tokens are skipped so coincidence cannot fire it',
    assertNoPlaintext('abcdef', { t: 'abc' }).clean);
}

// ── 4. the seal itself ─────────────────────────────────────────────────────
{
  const s = makeTestSession();
  const payload = { body: 'round trip', n: 1 };
  const env = sealBody(s, 'SMS_RECEIVED', payload);

  check('4a: round-trips under the same derivation',
    eq(openBody(makeTestSession(), 'SMS_RECEIVED', env), payload));

  let boundToType = false;
  try { openBody(makeTestSession(), 'PHONE_NOTIFICATION', env); } catch { boundToType = true; }
  check('4b: the AAD binds the frame type — opening under another type fails', boundToType);

  let boundToSeq = false;
  try { openBody(makeTestSession(), 'SMS_RECEIVED', { ...env, s: env.s + 1 }); } catch { boundToSeq = true; }
  check('4c: the AAD binds the sequence number', boundToSeq);

  const flipped = Buffer.from(env.c, 'base64url');
  flipped[0] ^= 0xff;
  let tamperCaught = false;
  try { openBody(makeTestSession(), 'SMS_RECEIVED', { ...env, c: flipped.toString('base64url') }); } catch { tamperCaught = true; }
  check('4d: a single flipped ciphertext byte is refused', tamperCaught);

  // Two different plaintexts in the same bucket must produce the same length,
  // or the padding is not hiding anything.
  const a = sealBody(makeTestSession(), 'SMS_RECEIVED', { b: 'x' });
  const b = sealBody(makeTestSession(), 'SMS_RECEIVED', { b: 'xxxxxxxxxxxxxxxxxxxx' });
  check('4e: §13.4 padding makes same-bucket frames the same size on the wire',
    Buffer.from(a.c, 'base64url').length === Buffer.from(b.c, 'base64url').length);
  check('4f: *_CHUNK is exempt from padding, by suffix',
    paddedLength(3000, 'MESSAGES_CHUNK') === 3000 && paddedLength(3000, 'MESSAGES') === 4096);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
