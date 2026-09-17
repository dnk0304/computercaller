/**
 * chrome-extension/auth-absence.js — E2E-P5a-SW (a).
 *
 * ONE pure decision: when a token read comes back NULL, does that null mean
 * "this user is signed out" (clear the auth + relay facts and repaint the
 * signed-out icon) or "we do not know yet" (keep the last painted state and
 * retry)?
 *
 * Why this needed extracting. Before this file, `connect()` answered the
 * question with a single line —
 *
 *     const token = await getToken();
 *     signedIn = !!token;
 *     if (!token) { connecting = false; refreshIndicator(); return; }
 *
 * — i.e. EVERY null is a sign-out. That is wrong for a null that is merely
 * early, and it is the indicator repaint race (ISSUES 2026-09-18): the
 * `cc-keepalive` alarm fires `connect()` every 30 s, so any window in which a
 * token read transiently resolves null — storage not hydrated after a worker
 * respawn, a sign-in or ticket re-mint in flight — gets painted "signed-out"
 * over a session that is perfectly alive. In the badge harness that surfaced
 * as an indicator of 'signed-out' and the bare "ComputerCaller" tooltip
 * landing on whichever assertions happened to fall inside the window, and the
 * size of the failing set tracked how busy the box was. It is the same race a
 * real user sees as the icon blinking signed-out for a moment on every wake.
 *
 * The honest discriminator is NOT the null itself, it is what we know around
 * it, and there are exactly three facts:
 *
 *   hydrated  a storage read has COMPLETED at least once this worker lifetime.
 *             Before that, we have no auth answer at all — only the absence of
 *             one. (null-before-hydration)
 *   everSeen  a non-null token was observed this worker lifetime. A null AFTER
 *             that, with nothing having deliberately revoked it, is a read
 *             racing a write, not a sign-out. (null-during-refresh)
 *   cleared   the token was revoked by something AUTHORITATIVE: the user
 *             pressed sign out, or the token endpoint answered 401/409. These
 *             are the only two events entitled to assert "signed out", and
 *             they are the only two that set this flag.
 *
 * Deny-by-default still holds where it should: a worker that has completed a
 * read, has never seen a token, and has no revocation on record is a genuinely
 * signed-out profile — fresh install, cleared storage — and it CLEARS. The fix
 * narrows the clear to the cases that earned it; it does not make the
 * extension optimistic about being signed in.
 *
 * Unit-tested standalone by tests/ext-auth-absence.test.mjs. Pure on purpose:
 * no chrome, no storage, no clock — the whole point is that the rule can be
 * enumerated in a table rather than raced in a browser.
 */

/** @typedef {{ hydrated: boolean, everSeen: boolean, cleared: boolean }} AuthFacts */

/**
 * @param {AuthFacts} facts
 * @returns {'clear'|'keep'} 'clear' = assert signed-out (drop relay facts,
 *   repaint). 'keep' = unknown yet; keep the last painted state and retry.
 */
export function tokenAbsenceVerdict(facts) {
  // No facts at all is not "before hydration", it is a caller that lost track
  // of its own state — deny by default rather than pin the icon signed-in.
  if (!facts || typeof facts !== 'object') return 'clear';
  const { hydrated, everSeen, cleared } = facts;
  // An explicit sign-out or a 401 outranks everything, including everSeen —
  // having held a token is precisely the situation a revocation describes.
  if (cleared) return 'clear';
  // No completed read: we are not looking at an absence of token, we are
  // looking at an absence of an answer.
  if (!hydrated) return 'keep';
  // Read completed, but this worker has held a real token and nothing revoked
  // it — a write is in flight under the read.
  if (everSeen) return 'keep';
  // Read completed, never held a token, nothing revoked: signed out.
  return 'clear';
}
