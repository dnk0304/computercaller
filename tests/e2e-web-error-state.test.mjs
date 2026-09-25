/**
 * tests/e2e-web-error-state.test.mjs — `state:'error'` is STICKY (E2E-P2.1 (b)).
 *
 * The defect: `onPairEnded()` reset the view to E2E_VIEW_INITIAL, which is
 * `state:'unencrypted'`. Every refusal — downgrade, replayed epoch, a wrap that
 * would not open, the relay kill switch — calls `fail()` (which sets
 * `state:'error'`) and then returns `true`, and `true` makes usePhoneBridge
 * LEAVE_ACTIVE and call `onPairEnded()`. So the error was erased by the
 * teardown the error itself caused, within the same tick, and P5a's error UI
 * rendered a state that no longer existed. A refusal that erases its own
 * evidence reads, to the user, as nothing having happened.
 *
 * Two halves are tested here and BOTH are needed:
 *   1. the pure transitions (viewAfterPairEnded / viewAfterErrorDismissed),
 *      driven exhaustively over every E2eState and every E2eError; and
 *   2. that the HOOK actually calls them. A pure function nobody wired up is a
 *      pure function that passes its own tests while the bug ships, which is
 *      how this lane's IndexedDB defect survived two green suites.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  E2E_VIEW_INITIAL,
  viewAfterPairEnded,
  viewAfterErrorDismissed,
} from '../hooks/phoneE2e.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const ALL_ERRORS = [
  'e2e-setup-failed',
  'e2e-key-mismatch',
  'e2e-unavailable',
  're-pair-needed',
  'e2e-seq-fail-closed',
  'e2e-epoch-replayed',
];

/** A view in the state `fail()` leaves behind. */
function erroredView(error, overrides = {}) {
  return {
    mode: 'on',
    // A5 (E2E-P2.2 (c)): the EFFECTIVE mode, OR(local, peerByte), latched. It
    // is a separate field from `mode` because a 0/0 pair SEALS with effective
    // off, and that is exactly the pair A5 row 4 used to send in the clear.
    effective: 'on',
    state: 'error',
    error,
    peer: { supports: true, kind: 'present' },
    sas: { digits: '123456', confirmed: true, coverage: null },
    debug: { drops: 3, downgradesDropped: 2, relayAbortsAccepted: 0, kid: 'kid-1', refusedForwardJump: 0 },
    ...overrides,
  };
}

/** A view for a healthy, verified, encrypted pair. */
function liveView(overrides = {}) {
  return {
    mode: 'on',
    effective: 'on',
    state: 'encrypted-verified',
    peer: { supports: true, kind: 'present' },
    sas: { digits: '654321', confirmed: true, coverage: null },
    debug: { drops: 0, downgradesDropped: 0, relayAbortsAccepted: 0, kid: 'kid-9', refusedForwardJump: 0 },
    ...overrides,
  };
}

// ── 1. THE NON-CLEARING PATHS: everything the relay or the network can cause ──
//
// onPairEnded is the single funnel. usePhoneBridge calls it from leaveActive,
// and the relay-driven teardowns (RESET_ROOM -> close 4010, PAIRING_TERMINATED,
// a bare socket close) all reach the same place — asserted by source below.
for (const error of ALL_ERRORS) {
  const out = viewAfterPairEnded(erroredView(error));
  eq(`onPairEnded PRESERVES state:'error' (${error})`, out.state, 'error');
  eq(`onPairEnded PRESERVES the error code (${error})`, out.error, error);
}

{
  const out = viewAfterPairEnded(erroredView('e2e-epoch-replayed'));
  eq('onPairEnded keeps mode alongside the error', out.mode, 'on');
  // Everything PAIR-scoped must still go: the pair really is over.
  eq('onPairEnded clears the SAS digits', out.sas.digits, null);
  eq('onPairEnded clears sas.confirmed', out.sas.confirmed, false);
  eq('onPairEnded clears the kid', out.debug.kid, null);
  eq('onPairEnded clears the drop counters', out.debug.drops, 0);
  eq('onPairEnded clears downgradesDropped', out.debug.downgradesDropped, 0);
  // T-EXT-E2E-ROW-STANDBY-COPY re-pin: `false` -> `'unknown'`. The ASSERTION IS
  // NOT WEAKENED — it is the same claim, now expressible. `peer.supports` is a
  // tri-state (lib/encryptedModeCopy.ts PeerSupport), and `false` there means
  // "the phone answered no", which a teardown is no evidence of. Clearing it to
  // `false` is what made every standby session say "your phone app needs v58 or
  // newer" about a phone that had said nothing. `'unknown'` is the cleared
  // value; a row asserting `false` here would be asserting the defect.
  eq('onPairEnded clears peer.supports to unknown, not to a version verdict',
    out.peer.supports, 'unknown');
  // peer.kind is a property of the BROWSER (the extension SW's key), not of the
  // pair, so it survives a teardown.
  eq('onPairEnded PRESERVES peer.kind', out.peer.kind, 'present');
  // A5 (E2E-P2.2 (c)) added `effective` beside `mode`: the pair A5 row 4 got
  // wrong — sealed, effective OFF — is precisely the one where the two differ.
  // It rides through a teardown with `mode` for the same reason `mode` does:
  // "you asked for encryption and the pair refused" and "the pair was never
  // encrypted" are different sentences, and the badge says so.
  eq('onPairEnded PRESERVES the effective mode alongside mode', out.effective, 'on');
  eq('the view shape is unchanged', Object.keys(out).sort().join(','),
    'debug,effective,error,mode,peer,sas,state');
}

{
  // A teardown with NO error behaves exactly as before — this fix must not
  // invent an error where there was none.
  const out = viewAfterPairEnded(liveView());
  eq('onPairEnded on a healthy pair resets to initial state', out.state, E2E_VIEW_INITIAL.state);
  eq('onPairEnded on a healthy pair resets mode', out.mode, E2E_VIEW_INITIAL.mode);
  check('onPairEnded on a healthy pair carries no error', out.error === undefined);
  eq('onPairEnded on a healthy pair still keeps peer.kind', out.peer.kind, 'present');
}

{
  // Repeated teardowns (PAIRING_TERMINATED echoes leaveActive; both fire) must
  // not erode the error. Idempotence is the property that makes the funnel safe.
  let v = erroredView('e2e-unavailable');
  for (let i = 0; i < 5; i += 1) v = viewAfterPairEnded(v);
  eq('onPairEnded is idempotent: error survives 5 teardowns', v.state, 'error');
  eq('onPairEnded is idempotent: code survives', v.error, 'e2e-unavailable');
}

// ── 2. THE CLEARING PATHS: explicit user acts ───────────────────────────────
for (const error of ALL_ERRORS) {
  const out = viewAfterErrorDismissed(erroredView(error));
  eq(`dismiss clears state (${error})`, out.state, E2E_VIEW_INITIAL.state);
  check(`dismiss clears the error code (${error})`, out.error === undefined);
}

{
  const out = viewAfterErrorDismissed(erroredView('re-pair-needed'));
  eq('dismiss resets mode', out.mode, E2E_VIEW_INITIAL.mode);
  eq('dismiss keeps peer.kind', out.peer.kind, 'present');
  eq('dismiss clears the SAS digits', out.sas.digits, null);
}

{
  // A dismiss with no error showing must be a NO-OP. The control sits next to
  // the banner; a double-click must not cost a live session its SAS digits.
  const live = liveView();
  const out = viewAfterErrorDismissed(live);
  check('dismiss on a live encrypted pair is a no-op (identity)', out === live);
  eq('dismiss on a live pair keeps the SAS digits', out.sas.digits, '654321');
  eq('dismiss on a live pair keeps the state', out.state, 'encrypted-verified');
}

{
  const un = { ...E2E_VIEW_INITIAL };
  check('dismiss on an unencrypted view is a no-op', viewAfterErrorDismissed(un) === un);
}

// Dismiss then teardown: nothing comes back from the dead.
{
  const out = viewAfterPairEnded(viewAfterErrorDismissed(erroredView('e2e-key-mismatch')));
  eq('a dismissed error does not return on the next teardown', out.state,
    E2E_VIEW_INITIAL.state);
  check('a dismissed error has no code on the next teardown', out.error === undefined);
}

// ── 3. THE WIRING. A pure function nobody called is the real failure mode. ───
const useE2e = readFileSync(join(ROOT, 'hooks', 'useE2e.ts'), 'utf8');
const bridge = readFileSync(join(ROOT, 'hooks', 'usePhoneBridge.ts'), 'utf8');

check('useE2e imports viewAfterPairEnded', /\bviewAfterPairEnded\b/.test(useE2e));
check('useE2e imports viewAfterErrorDismissed', /\bviewAfterErrorDismissed\b/.test(useE2e));
// INC-0924: onPairEnded now chooses between two teardown views. Both arms are
// required — asserting only the plain one would pass on a build that had lost
// the mid-SAS branch, which is the branch that tells a user their phone said
// the codes did not match.
check('onPairEnded calls viewAfterPairEnded on an ordinary teardown',
  useE2e.includes('viewAfterPairEndedDuringSas : viewAfterPairEnded'));
check('onPairEnded calls viewAfterPairEndedDuringSas when the SAS was open',
  /setView\(endedMidSas \? viewAfterPairEndedDuringSas : viewAfterPairEnded\);/.test(useE2e));
check('and it reads the SAS window BEFORE clearing it',
  useE2e.indexOf('const endedMidSas = sasPendingRef.current;')
    < useE2e.indexOf('setView(endedMidSas ?'));

/**
 * THE REGRESSION ITSELF: onPairEnded must not reset the view unconditionally.
 * The old line was
 *   setView((v) => ({ ...E2E_VIEW_INITIAL, peer: { ... kind: v.peer.kind } }));
 * and it is what erased the error. onSignOut legitimately still uses
 * E2E_VIEW_INITIAL (sign-out IS an explicit user act), so the assertion is
 * scoped to the onPairEnded body rather than to the file.
 */
{
  const i = useE2e.indexOf('const onPairEnded = useCallback');
  check('onPairEnded exists in useE2e.ts', i > 0);
  // Comments MUST be stripped first. The body carries a comment explaining why
  // it is not `setView(E2E_VIEW_INITIAL)` any more, and the first draft of this
  // assertion matched that explanation and reported the bug as still present.
  // A grep-proof that reads the prose describing the invariant is measuring the
  // documentation, not the code.
  const body = useE2e.slice(i, i + 900)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('onPairEnded does NOT spread E2E_VIEW_INITIAL (the erasing bug)',
    !body.includes('E2E_VIEW_INITIAL'),
    'onPairEnded still resets the view unconditionally');
  // Prove the detector can fire, or "no match" means nothing.
  check('the E2E_VIEW_INITIAL detector fires on the ORIGINAL buggy line',
    'setView((v) => ({ ...E2E_VIEW_INITIAL, peer: { supports: false, kind: v.peer.kind } }));'
      .includes('E2E_VIEW_INITIAL'));
}

check('useE2e exposes dismissError on the API', /\bdismissError\(\): void;/.test(useE2e));
check('dismissError calls viewAfterErrorDismissed',
  useE2e.includes('setView(viewAfterErrorDismissed)'));
check('turning encrypted mode OFF clears a showing error',
  useE2e.includes("if (mode === 'off') setView(viewAfterErrorDismissed);"));
check('usePhoneBridge exposes the dismiss to the UI',
  /dismissE2eError:\s*e2eApi\.dismissError/.test(bridge));

/** A NEW successful pairing clears the error — the second clearing path. */
{
  const i = useE2e.indexOf('const onPairingActive = useCallback');
  const body = useE2e.slice(i, useE2e.indexOf('const onE2eUnavailable'));
  const clears = (body.match(/error:\s*undefined/g) || []).length;
  check('a new pairing outcome clears the error (accept sets error: undefined)',
    clears >= 2, `found ${clears} clearing sites, expected the mode-off branch and the success branch`);
}

/**
 * An SW restart notification must NOT clear an error. The extension-bridge
 * effect only ever narrows to `peer`, so the assertion is that its setView
 * spreads the previous view and touches neither `state` nor `error`.
 */
{
  const i = useE2e.indexOf("data.type !== 'e2e-pubkey'");
  const body = useE2e.slice(i, i + 400);
  check('the SW-key listener spreads the previous view', body.includes('...v'));
  check('the SW-key listener does not set state', !/\bstate:/.test(body));
  check('the SW-key listener does not set error', !/\berror:/.test(body));
}

/**
 * RESET_ROOM and a socket close reach the error rule through the SAME funnel.
 *
 * INC-0924 re-read the table, as this assertion's previous wording asked the
 * next person to. There are now TWO call sites, and the second is not a leak:
 * the PAIRING_TERMINATED frame is the one place a pair ends WITHOUT this
 * browser asking, and until this commit nothing in that case told the e2e half
 * anything — the session, the SAS block and the digits stayed installed
 * against a pair that no longer existed. It is also the frame the phone's
 * "Doesn't match" arrives as. So the count is pinned at 2 AND each site is
 * named, which is strictly stronger than the bare count it replaces: a third,
 * unreviewed site still fires this, and so does either of these two vanishing.
 */
{
  // T-RESUME-PHONE-RESTART-DESYNC widened the signature: onPairEnded now takes
  // an OPTIONAL relay reason, and the PAIRING_TERMINATED site passes it so
  // 'phone_restarted' can reach the user as its own sentence. The count control
  // is what matters and it is unchanged — a third, unreviewed site still fires
  // this, and so does either of these two vanishing — so the pattern is widened
  // to "called with anything" rather than the count being relaxed.
  const CALL = /e2eRef\.current\.onPairEnded\(/g;
  const sites = (bridge.match(CALL) || []).length;
  eq('onPairEnded has exactly TWO reviewed call sites', sites, 2);
  // ...and the empty-parens form must not silently come back at the terminated
  // site: dropping the argument there is exactly how the new copy would go
  // missing while every count above stayed green.
  check('the PAIRING_TERMINATED site passes the relay reason',
    /onPairEnded\(\(payload as Record<string, unknown>\)\?\.reason\)/.test(bridge));
  {
    const i = bridge.indexOf("case 'PAIRING_TERMINATED': {");
    const body = bridge.slice(i, bridge.indexOf(`\n      }`, i));
    check('the PAIRING_TERMINATED case actually sliced',
      body.includes('setLobbyState') && body.length > 200, `${body.length} chars`);
    check('site 1: the PAIRING_TERMINATED frame tells the e2e half',
      body.includes('e2eRef.current.onPairEnded('));
  }
  {
    const i = bridge.indexOf('const leaveActive = useCallback');
    check('site 2: the local Disconnect still funnels through it',
      i > 0 && bridge.slice(i, i + 1200).includes('e2eRef.current.onPairEnded()'));
  }
}

const total = pass + fail;
if (fail > 0) {
  console.log(`\ne2e-web-error-state: ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`e2e-web-error-state: ${pass}/${total} checks passed`);
process.exit(fail > 0 ? 1 : 0);
