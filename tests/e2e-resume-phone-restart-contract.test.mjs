#!/usr/bin/env node
/**
 * tests/e2e-resume-phone-restart-contract.test.mjs
 * T-RESUME-PHONE-RESTART-DESYNC (RESUME-PROTOCOL v3.0 RULE 30).
 *
 * ── THE CROSS-SURFACE ASSUMPTION THIS FILE EXISTS TO HOLD ──────────────────
 * "If the PHONE loses its E2E session, the WEB stops expecting sealed frames."
 *
 * On 2026-09-25 (live-acceptance-vc67, prod 4dc9282, phone v67) that sentence
 * was false in both directions at once and nothing anywhere noticed:
 *
 *   - the RELAY resumed a pair whose phone had been force-stopped, because it
 *     could prove the socket was continuous and never that the SESSION was;
 *   - the WEB accepted the resume, kept its verified session and its
 *     "Encrypted. Confirm the code…" header, and silently DROPPED the
 *     plaintext SMS_RECEIVED the restarted phone then sent;
 *   - the phone's own Disconnect was answered "LEAVE_ACTIVE from non-active
 *     phone — ignored", because during a survivor hold the phone is not in
 *     room.active.phone.
 *
 * So the pair sat wedged for the full 180 s, telling the user it was encrypted
 * the whole time. Three surfaces, one assumption, no test.
 *
 * ── WHAT IS REAL HERE ──────────────────────────────────────────────────────
 * Nothing about the decision is re-implemented in this file:
 *   - lib/resumeGate-core.js       the SHIPPED relay predicates, required, not
 *                                  mirrored (the module exists so a test can
 *                                  have them without booting a server)
 *   - hooks/phoneE2e.ts            the SHIPPED page predicates and the view
 *                                  transition
 *   - lib/encryptedModeCopy.ts     the SHIPPED copy
 *   - server.js                    read as SOURCE, to prove the predicates are
 *                                  actually CALLED at the two sites that had
 *                                  the bug. A pure function nobody invokes is a
 *                                  green test over dead code.
 *
 * ── AND THE CONTROLS ───────────────────────────────────────────────────────
 * Section 5 plants the PRE-FIX predicates (the relay's "a returning phone is
 * always resumable", the LEAVE_ACTIVE identity test, and the web's "a resume is
 * just a resume") and REQUIRES each to disagree with the shipped rule on the
 * prod row. An assertion both the old and the new code pass proves nothing
 * about the bug. Section 6 pins the copy and requires it not to be the
 * "keys were cleared" line, which blames the wrong machine.
 *
 * Run: node tests/e2e-resume-phone-restart-contract.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  E2E_VIEW_INITIAL,
  resumedPeerSessionVerdict,
  pairEndedErrorForReason,
  viewAfterPairEndedWithError,
  viewAfterPairEnded,
} from '../hooks/phoneE2e.ts';
import { E2E_ERRORS, encryptionIndicator } from '../lib/encryptedModeCopy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The REAL relay module. Required, not mirrored — see the file header.
const {
  readPhoneSessionParam,
  resumeGateVerdict,
  leaveActiveHonouredDuringHold,
  MAX_KID_LEN,
} = require('../lib/resumeGate-core.js');

const VECTORS = JSON.parse(readFileSync(join(ROOT, 'tests', 'e2e-resume-vectors.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── 1. the relay gate, every row ────────────────────────────────────────────
for (const row of VECTORS.relayRows) {
  const v = resumeGateVerdict({
    phoneReturning: row.phoneReturning,
    roomKid: row.roomKid,
    phoneSession: row.phoneSession,
  });
  eq(`relay[${row.name}] action`, v.action, row.expect.action);
  eq(`relay[${row.name}] reason`, v.reason, row.expect.reason);
  check(`relay[${row.name}] carries a human detail`, typeof v.detail === 'string' && v.detail.length > 10);
}
// The wire reason is a STRING THE BROWSER SWITCHES ON. Pinned here so it cannot
// be reworded on the relay side without this file and the page copy moving too.
for (const row of VECTORS.relayRows.filter((r) => r.expect.action === 'terminate')) {
  eq(`relay[${row.name}] wire reason is exactly 'phone_restarted'`, row.expect.reason, 'phone_restarted');
}

// ── 2. the ?session= parser ─────────────────────────────────────────────────
{
  // The THREE outcomes, and the third is not the second: "old APK" and "phone
  // says it has nothing" are different operational facts, and a parser that
  // collapsed them would make the rollout impossible to time from the logs.
  const undeclared = readPhoneSessionParam(undefined);
  eq('parser: absent param is UNDECLARED', undeclared.declared, false);
  eq('parser: absent param has no session', undeclared.present, false);
  for (const token of ['0', 'false', 'none', 'null', 'undefined', '', '  ', 'FALSE']) {
    const p = readPhoneSessionParam(token);
    check(`parser: ${JSON.stringify(token)} is a DECLARED absence`, p.declared === true && p.present === false);
  }
  const live = readPhoneSessionParam('  kid-pair-A1  ');
  check('parser: a kid is trimmed and reported present', live.declared && live.present && live.kid === 'kid-pair-A1');
  // Attacker-controlled and headed for a log line.
  const huge = readPhoneSessionParam('k'.repeat(MAX_KID_LEN + 1));
  check('parser: an over-long kid is refused as an absence, never echoed', huge.present === false && huge.kid === null);
  eq('parser: a non-string (array param) is UNDECLARED', readPhoneSessionParam(['a', 'b']).declared, false);
  // And the parser feeds the gate: the end-to-end shape, absent -> terminate.
  eq('parser -> gate: an undeclared phone on a sealed pair terminates',
    resumeGateVerdict({ phoneReturning: true, roomKid: 'k1', phoneSession: readPhoneSessionParam(undefined) }).action,
    'terminate');
  eq('parser -> gate: the SAME kid on a sealed pair resumes',
    resumeGateVerdict({ phoneReturning: true, roomKid: 'k1', phoneSession: readPhoneSessionParam('k1') }).action,
    'resume');
}

// ── 3. LEAVE_ACTIVE during a hold ───────────────────────────────────────────
for (const row of VECTORS.leaveActiveRows) {
  eq(`leaveActive[${row.name}]`, leaveActiveHonouredDuringHold({
    isActivePhone: row.isActivePhone,
    claimLive: row.claimLive,
    claimDroppedRole: row.claimDroppedRole,
    survivorPresent: row.survivorPresent,
  }), row.expect);
}

// ── 4. the page's own re-verification + the terminated reason ───────────────
for (const row of VECTORS.webRows) {
  eq(`web[${row.name}]`, resumedPeerSessionVerdict({
    resumed: row.resumed,
    ourKid: row.ourKid,
    peerSession: row.peerSession,
  }), row.expect);
}
for (const row of VECTORS.terminatedReasonRows) {
  eq(`terminated[${row.name}]`, pairEndedErrorForReason(row.reason), row.expect);
}

// ── 5. THE CONTROLS — the pre-fix predicates must go RED on the prod rows ───
{
  /** What the relay did before this lane: both roles back => resume. */
  const preFixRelay = () => ({ action: 'resume' });
  const prodRelayRow = VECTORS.relayRows.find((r) => r.name === 'phone-dropped-session-absent-terminates');
  check('CONTROL: the vector file still carries the prod relay row', !!prodRelayRow);
  eq('CONTROL: the PRE-FIX relay predicate resumes the prod row (i.e. reproduces the bug)',
    preFixRelay().action, 'resume');
  check('CONTROL: ...and the SHIPPED predicate disagrees with it there',
    resumeGateVerdict({
      phoneReturning: prodRelayRow.phoneReturning,
      roomKid: prodRelayRow.roomKid,
      phoneSession: prodRelayRow.phoneSession,
    }).action !== preFixRelay().action);
  // The control must also NOT fire on the blip row, or the gate would be
  // "terminate always", which passes the prod row for the wrong reason.
  const blip = VECTORS.relayRows.find((r) => r.name === 'phone-dropped-session-intact-same-kid-resumes');
  check('CONTROL: the shipped predicate AGREES with the pre-fix one on a genuine blip',
    resumeGateVerdict({ phoneReturning: blip.phoneReturning, roomKid: blip.roomKid, phoneSession: blip.phoneSession }).action
      === preFixRelay().action);

  /** What the LEAVE_ACTIVE branch did before: strict identity with active.phone. */
  const preFixLeave = (r) => r.isActivePhone;
  const prodLeaveRow = VECTORS.leaveActiveRows.find((r) => r.name === 'leave-active-during-survivor-hold-honoured');
  eq('CONTROL: the PRE-FIX LEAVE_ACTIVE test IGNORES the prod row (the 3 minutes of nothing)',
    preFixLeave(prodLeaveRow), false);
  check('CONTROL: ...and the SHIPPED test honours it', leaveActiveHonouredDuringHold({
    isActivePhone: prodLeaveRow.isActivePhone,
    claimLive: prodLeaveRow.claimLive,
    claimDroppedRole: prodLeaveRow.claimDroppedRole,
    survivorPresent: prodLeaveRow.survivorPresent,
  }) === true);
  // ...and it did not simply become "honour everything".
  const stranger = VECTORS.leaveActiveRows.find((r) => r.name === 'leave-active-with-no-pair-and-no-claim-ignored');
  check('CONTROL: the shipped test still refuses a phone in no pair and no hold',
    leaveActiveHonouredDuringHold({
      isActivePhone: stranger.isActivePhone,
      claimLive: stranger.claimLive,
      claimDroppedRole: stranger.claimDroppedRole,
      survivorPresent: stranger.survivorPresent,
    }) === false);

  /** What the page did before: a resume was just a resume. */
  const preFixWeb = () => 'ok';
  const prodWebRow = VECTORS.webRows.find((r) => r.name === 'web-resumed-peer-declares-no-session-lost');
  eq('CONTROL: the PRE-FIX page verdict says ok on the prod row', preFixWeb(), 'ok');
  check('CONTROL: ...and the SHIPPED page verdict says lost there',
    resumedPeerSessionVerdict({
      resumed: prodWebRow.resumed, ourKid: prodWebRow.ourKid, peerSession: prodWebRow.peerSession,
    }) === 'lost');
  // The false positive is the expensive one: an absent field must still be ok.
  const absent = VECTORS.webRows.find((r) => r.name === 'web-resumed-no-peer-session-field-ok');
  check('CONTROL: the shipped page verdict still says ok when the field is ABSENT',
    resumedPeerSessionVerdict({
      resumed: absent.resumed, ourKid: absent.ourKid, peerSession: absent.peerSession,
    }) === 'ok');
}

// ── 6. the copy, and the view it lands on ───────────────────────────────────
{
  check('the error code is in the shared list', E2E_ERRORS.includes('e2e-resume-session-lost'));

  const sealedVerified = {
    ...E2E_VIEW_INITIAL,
    mode: 'on', effective: 'on', state: 'encrypted-verified',
    peer: { supports: true, kind: 'key' },
    sas: { digits: '04237', confirmed: true, coverage: null },
    debug: { ...E2E_VIEW_INITIAL.debug, kid: VECTORS.kids.pair },
  };
  const after = viewAfterPairEndedWithError(sealedVerified, 'e2e-resume-session-lost');
  eq('the funnel lands on state error', after.state, 'error');
  eq('...with the new code', after.error, 'e2e-resume-session-lost');
  // The whole point: no decrypt-expecting state survives.
  eq('...the SAS digits are gone', after.sas.digits, null);
  eq('...the confirmation is gone', after.sas.confirmed, false);
  eq('...the kid is gone', after.debug.kid, null);
  eq('...and the peer is no longer claimed to support anything', after.peer.supports, 'unknown');

  const ind = encryptionIndicator({ state: after.state, error: after.error, peer: after.peer });
  check('the indicator says pair again', /pair again/i.test(`${ind.label} ${ind.detail}`));
  check('the indicator names the phone restart', /phone restarted/i.test(`${ind.label} ${ind.detail}`));
  eq('NO lock icon', ind.lock, false);
  check('the word "verified" is nowhere in it', !/verified/i.test(`${ind.label} ${ind.detail}`));
  check('it does NOT blame this browser ("keys were cleared" is the wrong machine)',
    !/keys were cleared/i.test(ind.detail));
  check('it does NOT tell the user to reconnect — reconnecting fixes nothing here',
    !/reconnect/i.test(ind.detail));
  // Frozen strings. Ken's brief names these; a reword is a deliberate act.
  eq('label is frozen', ind.label, 'Not encrypted — pair again');
  eq('detail is frozen', ind.detail,
    'Your phone restarted, so the encrypted session ended on that side. Pair again.');

  // A sticky error already on screen still outranks it (the P5a rule).
  const alreadyErrored = { ...E2E_VIEW_INITIAL, state: 'error', error: 'e2e-key-mismatch' };
  eq('an error already showing is NOT overwritten',
    viewAfterPairEndedWithError(alreadyErrored, 'e2e-resume-session-lost').error, 'e2e-key-mismatch');
  eq('...and that is the same answer the plain teardown gives',
    viewAfterPairEnded(alreadyErrored).error, 'e2e-key-mismatch');
}

// ── 7. the predicates are actually CALLED (server.js source pin) ────────────
{
  // A pure function nobody invokes is a green test over dead code. server.js
  // cannot be imported (requiring it starts a server), so the wiring is pinned
  // as SOURCE — normalised first, because server.js is CRLF in the working tree
  // and a `$`-anchored read of it silently matches nothing.
  const SRC = readFileSync(join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  check('server.js requires the real gate module', SRC.includes("require('./lib/resumeGate-core.js')"));
  check('parseConnection reads the ?session= parameter',
    /readPhoneSessionParam\(parsed\.query\?\.session\)/.test(SRC));
  check('the phone socket carries its declaration', /ws\.phoneSession = phoneSession;/.test(SRC));
  check('tryAutoResume consults the gate', /resumeGateVerdict\(\{/.test(SRC));
  check('...reading the kid off the stashed block',
    /roomKid: room\.active\.e2e \? room\.active\.e2e\.kid : null/.test(SRC));
  // The gate must key on whether the PHONE RETURNED, not on the claim's
  // droppedRole: when both sides drop, droppedRole records only the LAST close,
  // so a restarted phone under a browser-dropped claim would walk straight
  // through. Proven live in scripts/e2e-resume-phone-restart-proof.mjs (D).
  check('...and keyed on phoneReturning, not on claim.droppedRole',
    /phoneReturning: !survivorPhone,/.test(SRC));
  check('...and terminating with the gate reason', /terminateActivePair\(room, gate\.reason\)/.test(SRC));
  // ...and when BOTH sides had already dropped there is no active slot left,
  // so terminateActivePair's `if (!browser && !phone) return;` guard would tell
  // NOBODY. The returning browser is a live socket in hand and is told
  // directly, or it sits in the lobby silently refused — the original wedge in
  // a different hat. Proven live by scripts/e2e-resume-phone-restart-proof.mjs
  // (D2/D3); pinned here so the branch cannot be deleted as "unreachable".
  check('...and telling a returning browser directly when no active slot is left',
    /if \(room\.active\.browser \|\| room\.active\.phone\) \{/.test(SRC)
    && /safeSend\(browserWs, `PAIRING_TERMINATED:/.test(SRC));
  check('the LEAVE_ACTIVE branch consults the hold predicate',
    /leaveActiveHonouredDuringHold\(\{/.test(SRC));
  check('the ignored log line still exists for the rows that deserve it',
    SRC.includes('LEAVE_ACTIVE from non-active phone — ignored'));
  // The resumed frame must carry the page's re-verification input.
  check('the resume marker carries peerSession', /resumeMark\.peerSession = returningPhoneSession/.test(SRC));
}

// ── 8. vector-file hygiene ──────────────────────────────────────────────────
{
  const all = [
    ...VECTORS.relayRows, ...VECTORS.leaveActiveRows,
    ...VECTORS.webRows, ...VECTORS.terminatedReasonRows,
  ];
  const names = all.map((r) => r.name);
  eq('row names are unique', new Set(names).size, names.length);
  check('every row says WHY it exists', all.every((r) => typeof r.why === 'string' && r.why.length > 40));
  // The six rows Ken's brief names, transcribed from the BRIEF and not read
  // back out of the file — a required-list built from the file it checks
  // proves the parser, never the list.
  for (const required of [
    'browser-dropped-resumes',
    'phone-dropped-session-intact-same-kid-resumes',
    'phone-dropped-session-absent-terminates',
    'phone-dropped-different-kid-terminates',
    'leave-active-during-survivor-hold-honoured',
    'web-resumed-kid-mismatch-lost',
  ]) {
    check(`the vector file still carries ${required}`, names.includes(required));
  }
  check('the incident is recorded on the file', /force-stopped|force-stop/i.test(VECTORS._incident));
}

// ── 9. the detector itself ──────────────────────────────────────────────────
{
  // `check` must be able to fail, or all of the above is decoration.
  const before = failed;
  check('self-test (DELIBERATE — the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-resume-phone-restart-contract: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
