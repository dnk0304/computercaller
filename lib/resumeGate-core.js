/**
 * lib/resumeGate-core.js — T-RESUME-PHONE-RESTART-DESYNC.
 *
 * Lives in its own module for the same reason lib/e2eBlock-core.js and
 * lib/roomReset-core.js do: requiring server.js starts a server, so a test that
 * wants the REAL predicate can only get it from here. A mirrored copy of this
 * rule would be a copy that drifts, and the drift is invisible — the mirror
 * keeps returning "resume" while production stops checking.
 *
 * ── WHAT WENT WRONG ON PROD ────────────────────────────────────────────────
 * live-acceptance-vc67-20260925T0100Z, 23:27-23:50Z, prod 4dc9282, phone v67.
 * A VERIFIED (SAS-matched) pair. The phone app was force-stopped and restarted.
 * The relay saw the phone's socket close, soft-held the browser, and 13 ms
 * later the phone rejoined the lobby — so `tryAutoResume` re-formed the SAME
 * pair and re-sent the SAME e2e block (P1(b), by design).
 *
 * Except the phone was a FRESH PROCESS. `PhoneService.e2eSession` is an
 * in-memory field; a force-stop wipes it. The block the relay re-sent is sealed
 * key material the phone can no longer open, and the phone never re-derived an
 * SK. The result was a pair that was encrypted on exactly one side:
 *
 *   web   : header "Encrypted. Confirm the code…", sas.confirmed=false,
 *           sealed-expecting — so inbound plaintext SMS_RECEIVED was DROPPED
 *   phone : "Connected · Not encrypted", no `E2E armed`
 *   phone Disconnect : `LEAVE_ACTIVE from non-active phone — ignored`
 *   and the pair stayed wedged until `resume window expired` at 180 s.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * A resume is a claim of CONTINUITY. The relay could always prove continuity of
 * the SOCKET (same room, same device) and never continuity of the SESSION — so
 * it happily resumed a peer that had lost the only thing the resume re-sends.
 *
 * So: a phone that re-joins after ITS OWN socket dropped is resumable only if
 * it SAYS it still holds the session, and names it. The phone declares
 * `?session=<kid>` on its /relay/phone upgrade (the kid of its live
 * E2eSession); a fresh process has no session and declares nothing.
 *
 *   droppedRole = 'browser'                  -> resume   (unchanged; the phone
 *                                               never went anywhere)
 *   the pair holds no e2e block              -> resume   (a plaintext pair has
 *                                               no session to have lost)
 *   phone declares the SAME kid              -> resume   (a blip: the process
 *                                               lived, the socket did not)
 *   phone declares a DIFFERENT kid           -> TERMINATE phone_restarted
 *   phone declares session:false / nothing   -> TERMINATE phone_restarted
 *
 * The last row is deliberately the one that catches an APK that does not speak
 * this protocol at all. Silence is not evidence of a session, and the failure
 * it would otherwise produce is the one above: a UI that says Encrypted over a
 * peer that cannot read a byte. An unnecessary re-pair costs one Connect tap; a
 * wrong resume costs the user every message that arrives for the next 180 s and
 * tells them it is encrypted while it happens.
 *
 * No silent re-handshake is offered: a fresh pairing is the USER's action,
 * because a verified pair means a SAS both people compared, and new key
 * material must be compared again.
 */

/**
 * Read the phone's `?session=` upgrade parameter.
 *
 * Three OUTCOMES, and the third is not the second:
 *   declared:false — the parameter is absent. An APK build that predates this
 *                    protocol. We cannot tell a blip from a restart.
 *   declared:true, present:false — the phone said, in as many words, that it
 *                    holds no session ('0', 'false', 'none', empty).
 *   declared:true, present:true — the phone named the kid it holds.
 *
 * Both non-present outcomes are non-resumable, but they are logged differently,
 * because "old APK" and "phone restarted" are different operational facts and a
 * log line that cannot tell them apart cannot be used to time a rollout.
 *
 * The kid is length-capped for the same reason every other relay-side read of a
 * client string is: it is attacker-controlled and it is going into a log line.
 */
const MAX_KID_LEN = 128;
const ABSENT_TOKENS = new Set(['0', 'false', 'none', 'null', 'undefined', '']);

function readPhoneSessionParam(raw) {
  if (typeof raw !== 'string') return { declared: false, present: false, kid: null };
  const v = raw.trim();
  if (ABSENT_TOKENS.has(v.toLowerCase())) return { declared: true, present: false, kid: null };
  if (v.length > MAX_KID_LEN) return { declared: true, present: false, kid: null };
  return { declared: true, present: true, kid: v };
}

/**
 * The gate. Pure: no sockets, no room, no clock — the caller supplies the three
 * facts, which is what lets the contract test drive every row without a relay.
 *
 * @param {object}  a
 * @param {string}  a.droppedRole  'phone' | 'browser' — which side's socket closed
 * @param {?string} a.roomKid      kid of the pair's stashed e2e block, or null/undefined
 * @param {object}  a.phoneSession result of readPhoneSessionParam for the RETURNING phone
 * @returns {{action:'resume'|'terminate', reason:string, detail:string}}
 *          `reason` on a terminate is the wire reason — 'phone_restarted' — and
 *          it is what PAIRING_TERMINATED carries to the browser.
 */
function resumeGateVerdict({ droppedRole, roomKid, phoneSession }) {
  const s = phoneSession || { declared: false, present: false, kid: null };
  if (droppedRole !== 'phone') {
    return { action: 'resume', reason: 'browser-dropped', detail: 'the phone never left; unchanged path' };
  }
  if (!roomKid) {
    return { action: 'resume', reason: 'plaintext-pair', detail: 'no e2e block stashed — no session to have lost' };
  }
  if (s.present && s.kid === roomKid) {
    return { action: 'resume', reason: 'session-intact', detail: 'phone declares the pair kid' };
  }
  if (s.present) {
    return {
      action: 'terminate',
      reason: 'phone_restarted',
      detail: 'phone declares a DIFFERENT session kid than the pair holds',
    };
  }
  return {
    action: 'terminate',
    reason: 'phone_restarted',
    detail: s.declared
      ? 'phone declares session:false — fresh process'
      : 'phone declared no session (APK predates ?session=) — silence is not evidence of a session',
  };
}

/**
 * Is this LEAVE_ACTIVE from the phone worth honouring?
 *
 * The bug: during a survivor hold `room.active.phone` is null (the phone is the
 * side that dropped), so the returning phone's Disconnect hit
 * `ws === room.active.phone` -> false -> "LEAVE_ACTIVE from non-active phone —
 * ignored". The user's explicit Disconnect did nothing for three minutes.
 *
 * A held pair is still THIS room's pair, and the phone is still a party to it.
 * The ignored branch keeps exactly its original job: a phone that was never
 * part of the room's active pair (no active slot, no live claim) cannot tear
 * down a pair it is not in.
 *
 * @returns {boolean} true => honour it (terminateActivePair 'user_left')
 */
function leaveActiveHonouredDuringHold({ isActivePhone, claimLive, claimDroppedRole, survivorPresent }) {
  if (isActivePhone) return true;              // unchanged: the ordinary path
  return !!(claimLive && claimDroppedRole === 'phone' && survivorPresent);
}

module.exports = {
  MAX_KID_LEN,
  readPhoneSessionParam,
  resumeGateVerdict,
  leaveActiveHonouredDuringHold,
};
