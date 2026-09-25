/**
 * session-kick.js — the extension's half of "one surface at a time"
 * (EXT/WEB DUAL SESSION, Option A, Dennis 2026-09-25: "user should pick if he
 * works in webapp or extension").
 *
 * Newest sign-in wins on EVERY surface. The web tab has always been kicked by
 * an extension sign-in (SESSION_SUPERSEDED + close 4001 → KickedSessionGate).
 * The reverse was silent: the relay never indexed the extension's listener, so
 * a web sign-in left the extension quietly running on a dead token. The relay
 * now kicks the listener too, with a reason:
 *
 *   SESSION_SUPERSEDED:{"reason":"superseded"}   another sign-in (web, other
 *                                                device, other surface)
 *   SESSION_SUPERSEDED:{"reason":"signed_out"}   sign-out anywhere (m2)
 *   then ws.close(4001, "session_superseded")
 *
 * and a 409 `session_superseded` from the ticket mint (the worker was asleep
 * when the kick went out) means the same thing as a 'superseded' kick.
 *
 * Pure on purpose — no chrome, no storage, no clock — so the rule is
 * enumerated in tests/ext-web-dual-session.test.mjs rather than raced in a
 * browser. background.js owns the side effects.
 */

/** chrome.storage.local key the worker writes and the shell reads. */
export const KICKED_KEY = 'cc_kicked';

/** Close code the relay uses for a superseded session (WIRE-CONTRACT §1). */
export const KICK_CLOSE_CODE = 4001;

/**
 * The reason carried by a SESSION_SUPERSEDED frame. Anything that is not an
 * explicit sign-out is a supersede: the listener only ever gets this frame
 * because the account's sessionVersion moved, and "someone signed in" is the
 * conservative reading — it is what the web tab has always shown.
 * @param {unknown} data parsed frame payload
 * @returns {'superseded'|'signed_out'}
 */
export function kickReasonFromFrame(data) {
  return data && typeof data === 'object' && data.reason === 'signed_out'
    ? 'signed_out'
    : 'superseded';
}

/**
 * Is this socket close the relay kicking the session (terminal), rather than a
 * drop to reconnect from?
 * @param {{code?: number, reason?: string}|null|undefined} ev
 */
export function isKickClose(ev) {
  return !!ev && (ev.code === KICK_CLOSE_CODE || ev.reason === 'session_superseded');
}

/**
 * Honour a kick ONLY if the token that opened the kicked socket (or asked for
 * the refused ticket) is still the token in storage. If it is not, a newer
 * sign-in has already replaced it — the kick describes a session that no
 * longer exists here, and acting on it would sign out the fresh one. Also
 * false when storage is empty: an explicit sign-out already did the work.
 * @param {string|null} storedToken token in chrome.storage.local right now
 * @param {string|null} usedToken   token the kicked socket/ticket was minted from
 */
export function shouldHonourKick(storedToken, usedToken) {
  return typeof usedToken === 'string' && usedToken.length > 0 && storedToken === usedToken;
}

/**
 * What the shell shows for a stored kick record.
 *   'kicked' → the "signed in on another device — Sign back in here" card
 *   'anon'   → the plain sign-in gate (signed out elsewhere)
 *   null     → no record; the normal cookie probe decides
 * @param {unknown} record value of KICKED_KEY
 * @returns {'kicked'|'anon'|null}
 */
export function kickedView(record) {
  if (!record || typeof record !== 'object') return null;
  return record.reason === 'signed_out' ? 'anon' : 'kicked';
}
