/**
 * Why the extension surface signed you out, carried across the frame swap.
 *
 * The web app can say this in a URL: its idle logout ends in
 * `location.replace('/auth/login?reason=idle')`. The extension cannot — the
 * signed-in surface is an iframe the SHELL owns, and at cutoff the page asks
 * the shell to sign out (`requestSignOut()`); shell.js then clears the frame
 * and shows `/extension/login` itself. The page never navigates, so there is
 * no query string to put a reason in and no navigation to attach one to.
 *
 * So the reason is left where the next page will look: one localStorage key on
 * the same origin, written at cutoff and read-and-cleared exactly once by the
 * login page. Read-and-clear rather than read: a reason is about the sign-out
 * that just happened, and a stale one re-appearing on a later manual sign-in
 * would be a lie.
 *
 * No React, no imports — the login page, the guard and the test all use it.
 */

/** The one key. Do not write this string anywhere else. */
export const EXT_SIGNOUT_REASON_KEY = 'cc-ext-signout-reason';

/** The reasons this surface knows how to explain. */
export type ExtSignOutReason = 'idle';

const KNOWN: readonly string[] = ['idle'];

/**
 * Record why the surface is about to sign out.
 *
 * Storage can throw outright in a partitioned or blocked context (not merely
 * return null), and this runs on the logout path, where throwing would strand
 * the user in a surface they are being signed out of. Losing the reason line
 * is a cosmetic degradation; losing the sign-out is not.
 */
export function writeExtSignOutReason(reason: ExtSignOutReason): void {
  try {
    window.localStorage.setItem(EXT_SIGNOUT_REASON_KEY, reason);
  } catch {
    /* Blocked site data. The user still gets signed out, just without the line. */
  }
}

/**
 * Read the reason and remove it, so it explains exactly one sign-in screen.
 * Returns null when absent, unreadable, or not a reason this build knows —
 * an unrecognised value is treated as absent rather than rendered, so a future
 * build's reason cannot paint an empty or raw string into the gate.
 */
export function readAndClearExtSignOutReason(): ExtSignOutReason | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(EXT_SIGNOUT_REASON_KEY);
    window.localStorage.removeItem(EXT_SIGNOUT_REASON_KEY);
  } catch {
    return null;
  }
  if (!raw || !KNOWN.includes(raw)) return null;
  return raw as ExtSignOutReason;
}
