/**
 * The idle verdict, as one pure function.
 *
 * Extracted from IdleTimeoutGuard's 1 s tick (dispatch PIXEL-CC ext-auto-logout,
 * 2026-09-21) so the 4 h boundary can be tested on a fake clock instead of by
 * waiting four hours with a real one. The guard calls this and does nothing
 * else with the arithmetic — there is exactly one place that decides.
 *
 * The constants come from lib/idleTimeout.ts and are never re-stated as
 * literals here: "edit IDLE_TIMEOUT_MS here and NOWHERE else" is that file's
 * own instruction, and a second copy of `4 * 60 * 60 * 1000` in this module
 * would quietly become the real timeout the day someone changed the first one.
 */

import { IDLE_TIMEOUT_MS, IDLE_WARN_BEFORE_MS } from './idleTimeout.ts';

export type IdleVerdict = 'ok' | 'warn' | 'logout';

export interface IdleVerdictInput {
  /** Now, in epoch ms. */
  now: number;
  /** When the user last genuinely interacted, in epoch ms. */
  lastActivity: number;
  /**
   * A live call counts as continuous activity and outranks everything: it keeps
   * the window open, never warns and never logs out. Passive pairing is NOT
   * keepAlive (Dennis 2026-07-27) — that distinction lives in the guard's
   * predicate, not here.
   */
  keepAlive: boolean;
  /** IDLE_WARN_ENABLED. When false the modal never shows and 'warn' is never returned. */
  warnEnabled: boolean;
}

/**
 * BOUNDARY, stated once so the tests can pin it:
 *   remaining  > IDLE_WARN_BEFORE_MS            -> 'ok'
 *   0 < remaining <= IDLE_WARN_BEFORE_MS        -> 'warn'   (when warnEnabled)
 *   remaining <= 0                              -> 'logout'
 * i.e. EXACTLY IDLE_TIMEOUT_MS since the last activity logs out, and exactly
 * IDLE_WARN_BEFORE_MS remaining is already warning. Both edges are inclusive on
 * the side that acts, which is the conservative direction for a security
 * timeout: never later than the stated window.
 */
export function idleVerdict({
  now,
  lastActivity,
  keepAlive,
  warnEnabled,
}: IdleVerdictInput): IdleVerdict {
  if (keepAlive) return 'ok';
  const remaining = IDLE_TIMEOUT_MS - (now - lastActivity);
  if (remaining <= 0) return 'logout';
  if (warnEnabled && remaining <= IDLE_WARN_BEFORE_MS) return 'warn';
  return 'ok';
}

/** Milliseconds left in the window, floored at 0. Drives the modal countdown. */
export function idleRemainingMs(now: number, lastActivity: number): number {
  return Math.max(0, IDLE_TIMEOUT_MS - (now - lastActivity));
}
