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
 *   the phone SURVIVED the hold              -> resume   (unchanged; it never
 *                                               went anywhere)
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
 * The kid is length-capped AND charset-pinned for the same reason every other
 * relay-side read of a client string is: it is attacker-controlled and it is a
 * string the relay carries around (into PAIRING_ACTIVE, and one careless edit
 * away from a log line).
 *
 * SECURITY MINOR 1 (ack 2026-09-25, forge/resume-phone-restart amendment 1).
 * The sibling read of `?deviceId=` in server.js parseConnection pins
 * /^[A-Za-z0-9_-]{1,128}$/. The kid is base64url BY CONSTRUCTION — Android
 * E2eAccept.newKid() is E2eKeyEncoding.toBase64Url(SecureRandom bytes) — so the
 * identical regex costs nothing and makes "this value can never be interesting
 * in a log line" a property of THE PARSER rather than an accident of every
 * current call site. Defence that depends on nobody ever adding a console.log
 * is not defence.
 *
 * A value that fails the charset is treated as a DECLARED ABSENCE — the same
 * outcome as the over-length cap, and deliberately NOT an error: the socket is
 * already authenticated, the gate's job is a liveness decision, and closing on
 * a malformed label would hand any client a way to turn a typo into a hard
 * disconnect. `declared:true` rather than `declared:false` because garbage is
 * not silence: an APK that predates this protocol sends NOTHING, so a
 * malformed value is a client that spoke and was not understood, and the
 * rollout log must not read that as "old APK". Either way it is non-resumable,
 * which is the safe direction.
 */
const MAX_KID_LEN = 128;
const KID_CHARSET = /^[A-Za-z0-9_-]+$/; // base64url, unpadded — E2eKeyEncoding.toBase64Url
const ABSENT_TOKENS = new Set(['0', 'false', 'none', 'null', 'undefined', '']);

function readPhoneSessionParam(raw) {
  if (typeof raw !== 'string') return { declared: false, present: false, kid: null };
  const v = raw.trim();
  if (ABSENT_TOKENS.has(v.toLowerCase())) return { declared: true, present: false, kid: null };
  if (v.length > MAX_KID_LEN) return { declared: true, present: false, kid: null };
  if (!KID_CHARSET.test(v)) return { declared: true, present: false, kid: null };
  return { declared: true, present: true, kid: v };
}

/**
 * The gate. Pure: no sockets, no room, no clock — the caller supplies the three
 * facts, which is what lets the contract test drive every row without a relay.
 *
 * Keyed on whether the PHONE is the side RETURNING, not on the claim's
 * `droppedRole`. They usually agree, and where they do not the claim is the
 * wrong fact: when BOTH sides drop, `droppedRole` records only the LAST close,
 * so a pair whose phone restarted and whose browser then reloaded would carry
 * droppedRole='browser' and walk a session-less phone straight through. What
 * matters is whether the phone in front of us is a socket that survived the
 * hold (then its session is the pair's, by construction) or one that re-joined
 * (then it has to say so).
 *
 * @param {object}  a
 * @param {boolean} a.phoneReturning  false = this phone never left room.active
 * @param {?string} a.roomKid      kid of the pair's stashed e2e block, or null/undefined
 * @param {object}  a.phoneSession result of readPhoneSessionParam for the RETURNING phone
 * @returns {{action:'resume'|'terminate', reason:string, detail:string}}
 *          `reason` on a terminate is the wire reason — 'phone_restarted' — and
 *          it is what PAIRING_TERMINATED carries to the browser.
 */
function resumeGateVerdict({ phoneReturning, roomKid, phoneSession }) {
  const s = phoneSession || { declared: false, present: false, kid: null };
  if (!phoneReturning) {
    return { action: 'resume', reason: 'phone-survived', detail: 'the phone never left active; unchanged path' };
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
 * SECURITY MINOR 4 (ack 2026-09-25, amendment 1) — SENDER IDENTITY.
 * The hold branch as first written tested the CLAIM's shape and never that the
 * sender was the phone the claim is about, so ANY phone socket in the room —
 * including a second handset of the same account sitting in the lobby that was
 * never a party to the pair — could end the hold. Same-account only, and the
 * outcome is a teardown rather than a resurrection, which is why it was a MINOR
 * and not a block; it is still a Disconnect the user did not press.
 *
 * The sender must therefore be the phone `tryAutoResume` would actually resume.
 * There is no stable phone deviceId on this wire to match on: `?deviceId=` is
 * read for LISTENERS only (server.js parseConnection) and `ws.deviceName` is
 * self-declared and not unique — Security named it explicitly as inadequate,
 * and server.js:1457 already uses it only as a PREFERENCE, never as proof. The
 * dropped socket's own object is no help either: the phone that sends this
 * frame is a NEW socket from the redial. So the discriminator that IS available
 * and IS sound is cardinality — the sender is honoured only when it is the sole
 * phone socket in the room, i.e. the only candidate the resume could pick. With
 * a second phone present the room is ambiguous and we refuse, because the cost
 * of refusing is a Disconnect the user can repeat and the cost of honouring is
 * a pair torn down by a device that was not in it.
 *
 * `senderIsSoleRoomPhone` defaults to FALSE when the caller omits it. That is
 * the fail direction we want: an un-plumbed call site loses the hold fix (the
 * user taps Disconnect again) rather than silently keeping the hole open.
 *
 * @returns {boolean} true => honour it (terminateActivePair 'user_left')
 */
function leaveActiveHonouredDuringHold({
  isActivePhone,
  claimLive,
  claimDroppedRole,
  survivorPresent,
  senderIsSoleRoomPhone,
}) {
  if (isActivePhone) return true;              // unchanged: the ordinary path
  if (!(claimLive && claimDroppedRole === 'phone' && survivorPresent)) return false;
  return senderIsSoleRoomPhone === true;
}

module.exports = {
  MAX_KID_LEN,
  KID_CHARSET,
  readPhoneSessionParam,
  resumeGateVerdict,
  leaveActiveHonouredDuringHold,
};
