/**
 * (j) — the FT-A1.1 §2.4 accepted-exception counter.
 *
 * WHAT IS BEING COUNTED, AND WHY IT IS A COUNTER
 * ----------------------------------------------
 * C-1's downgrade latch kills every plaintext FILE_* frame while the pair is
 * encrypted. That is right for a peer-authored frame and wrong for the refusals
 * only the RELAY can author — it holds no key, so it cannot seal one. FT-A1.1
 * §2.4 carves out exactly one exception for those relay-minted FILE_FAILED
 * frames, and an exception to an otherwise absolute rule is worth being able to
 * read a number for.
 *
 * It replaces a `console.warn`. A warn is invisible in production and
 * unassertable in a test, which makes it the wrong instrument for the one hole
 * in the latch.
 *
 * THE PROPERTY THAT MATTERS
 * -------------------------
 * The counter must be inert: diagnostics only, never user-visible (m-G), never
 * gating anything. "Inert" is easy to claim in a comment and easy to break in a
 * refactor, so it is asserted STRUCTURALLY here — the whole view is compared
 * field by field and everything except `debug.relayAbortsAccepted` must be
 * untouched. That way a future edit which quietly sets an error, flips a mode
 * or marks the session fails this file rather than passing it.
 *
 * The reason the rule exists: a transport refusal is not evidence about the
 * crypto session. If admitting one could move `state` or `mode`, a
 * relay-position party would hold a session kill switch — it could mint
 * refusals until the pair tore itself down. So the counter is deliberately the
 * ONLY thing that moves.
 *
 * NOTE ON SCOPE. The predicate that decides whether a frame IS a relay-minted
 * abort — `isRelayMintedAbort` in lib/fileTransfer/relayAbort.ts — belongs to
 * FT-3a.1 (ft/3a-web-logic @ b07daf2) and is NOT on this branch. This file
 * therefore tests the COUNTER, which is what (j) delivers, and not the
 * predicate, which already has its own suite (tests/e2e-ft-relay-abort.test.mjs)
 * on that branch. Asserting the predicate here from a local copy would be a
 * second opinion about the same bytes — the exact mistake A3 exists because of.
 */
import { E2E_VIEW_INITIAL, withRelayAbortAccepted } from '../hooks/phoneE2e.ts';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── 1. the counter exists, starts at zero, and counts ─────────────────────
check('1a: the initial view starts the counter at 0',
  E2E_VIEW_INITIAL.debug.relayAbortsAccepted === 0,
  JSON.stringify(E2E_VIEW_INITIAL.debug));

const once = withRelayAbortAccepted(E2E_VIEW_INITIAL);
check('1b: one admitted abort increments it to 1', once.debug.relayAbortsAccepted === 1);

let many = E2E_VIEW_INITIAL;
for (let i = 0; i < 7; i++) many = withRelayAbortAccepted(many);
check('1c: it accumulates (7 admitted => 7)', many.debug.relayAbortsAccepted === 7,
  String(many.debug.relayAbortsAccepted));

check('1d: it does not mutate the view it was given',
  E2E_VIEW_INITIAL.debug.relayAbortsAccepted === 0,
  'withRelayAbortAccepted must be pure — a shared E2E_VIEW_INITIAL that drifts would poison every later pair');

// ── 2. INERTNESS — the whole point ────────────────────────────────────────
//
// Compared structurally rather than field-by-name, so a field added to the view
// LATER is covered by this test automatically. A hand-written list of "things
// that must not change" only ever protects what its author remembered.
{
  const before = {
    ...E2E_VIEW_INITIAL,
    // Start from a non-default, fully-populated view so "unchanged" is a real
    // claim: comparing two all-zero views would pass no matter what the
    // function did to a field that happened to already be falsy.
    mode: 'on',
    state: 'encrypted-verified',
    peer: { supports: true, kind: 'present' },
    sas: { digits: '29614', confirmed: true, coverage: null },
    debug: { drops: 12, downgradesDropped: 5, relayAbortsAccepted: 3, kid: 'kid-j-0001', refusedForwardJump: 9 },
  };
  const after = withRelayAbortAccepted(before);

  const strip = (v) => JSON.stringify({ ...v, debug: { ...v.debug, relayAbortsAccepted: null } });
  check('2a: everything except the counter is byte-identical',
    strip(before) === strip(after),
    `\n    before ${strip(before)}\n    after  ${strip(after)}`);

  check('2b: the counter itself advanced by exactly one',
    after.debug.relayAbortsAccepted === before.debug.relayAbortsAccepted + 1);

  // Named explicitly as well as structurally: these four are the ones a
  // relay-position party would want to move, so they get their own line in the
  // output where a reader will see them.
  check('2c: it never touches `mode` — admitting a transport refusal is not a downgrade',
    after.mode === before.mode);
  check('2d: it never touches `state` — no abort, no error, no session mark',
    after.state === before.state && after.error === undefined);
  check('2e: it never touches the SAS',
    JSON.stringify(after.sas) === JSON.stringify(before.sas));
  check('2f: it never disturbs the kid',
    after.debug.kid === before.debug.kid);
}

// ── 3. it does NOT fold into downgradesDropped ────────────────────────────
//
// One counts frames REFUSED by the latch, the other frames ADMITTED past it.
// A single number covering both would hide the exception inside the rule, which
// is the one thing a diagnostic for an exception must not do.
{
  const v = withRelayAbortAccepted({
    ...E2E_VIEW_INITIAL,
    debug: { ...E2E_VIEW_INITIAL.debug, downgradesDropped: 4 },
  });
  check('3a: admitting an abort leaves downgradesDropped alone',
    v.debug.downgradesDropped === 4, String(v.debug.downgradesDropped));
  check('3b: the two counters are separate fields',
    v.debug.relayAbortsAccepted === 1 && v.debug.downgradesDropped === 4);
}

// ── 4. the detector proof ─────────────────────────────────────────────────
//
// 2a is the load-bearing assertion in this file, and it is exactly the shape
// that can silently stop working: if `strip` ever blanked the wrong field, or
// if the two views were both defaults, it would pass for any implementation.
// So prove it can fail — hand it a function that ALSO sets an error, which is
// the precise misbehaviour §2.4 forbids, and require 2a's comparison to reject.
{
  const rogue = (view) => ({
    ...view,
    state: 'error',
    error: 'e2e-setup-failed',
    debug: { ...view.debug, relayAbortsAccepted: view.debug.relayAbortsAccepted + 1 },
  });
  const before = { ...E2E_VIEW_INITIAL, mode: 'on', state: 'encrypted-verified' };
  const strip = (v) => JSON.stringify({ ...v, debug: { ...v.debug, relayAbortsAccepted: null } });
  check('4a: the inertness check REJECTS an implementation that also sets an error',
    strip(before) !== strip(rogue(before)),
    'if this passes, assertion 2a cannot fail and proves nothing');

  // And the mirror: an implementation that does nothing at all must not be
  // mistaken for a correct one.
  const inert = (view) => view;
  check('4b: a no-op implementation fails the count assertion',
    inert(before).debug.relayAbortsAccepted !== before.debug.relayAbortsAccepted + 1);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
