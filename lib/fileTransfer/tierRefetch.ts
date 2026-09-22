/**
 * lib/fileTransfer/tierRefetch.ts — EXT-UI-3 (a).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * A FILE_FAILED carrying `tier` is the relay saying "this account may not send
 * files". Before this module, that answer reached the UI as COPY ONLY: the
 * banner named the refusal while the client-side entitlement still read
 * `allowed: true`, so the send control stayed UNLOCKED and the screen offered
 * no route to paying. The production case is a trial that lapses mid-session —
 * the panel is never reloaded (Chrome does not destroy a side panel), so
 * nothing re-read /api/entitlement and the stale `true` survived for hours.
 *
 * ── WHY ONLY `tier`, AND EXPLICITLY NOT `quota` ─────────────────────────────
 * `tier` is a statement about the ACCOUNT: what the server believes about this
 * user's entitlement changed, and the client's copy of it is now known-stale.
 * `quota` is a daily byte counter — the entitlement is unchanged, the user is
 * still subscribed, and tomorrow the same account sends again. Refetching on
 * `quota` would spend a request to be told exactly what the client already
 * holds. The other nine wire reasons are transport outcomes (WIRE-TRUTH-v1)
 * and say nothing about the account at all.
 *
 * ── WHY A KEY RATHER THAN A CALLBACK ────────────────────────────────────────
 * The consumer feeds this key to a `useEffect` dependency array. React then
 * owns "exactly once": the effect body runs when the key CHANGES, so a
 * re-render caused by the refetch's own state write cannot re-enter it, and a
 * second, distinct tier failure later in the session does get its own refetch.
 * Encoding the transfer id in the key is what makes those two cases different;
 * a bare boolean would collapse them and re-arm on every unrelated render.
 *
 * Keeping it a pure function (and NOT a hook) is what lets the node suite pin
 * the whole reason table without a renderer.
 */

/**
 * The FILE_FAILED reasons that invalidate the client's entitlement snapshot.
 * A set of one, written as a table so adding a second reason is a data change
 * with a test beside it rather than an `if` someone widens by hand.
 */
export const ENTITLEMENT_STALE_REASONS: readonly string[] = Object.freeze(['tier']);

/** True when this reason means the client's entitlement copy is known-stale. */
export function invalidatesEntitlement(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && ENTITLEMENT_STALE_REASONS.includes(reason);
}

/**
 * The effect key for a failure. `null` (no effect) for every reason that leaves
 * the entitlement intact and for "no failure showing"; a value unique to the
 * (reason, transfer) pair otherwise.
 */
export function entitlementStaleKey(
  error: { id: string; reason: string } | null | undefined,
): string | null {
  if (!error || typeof error.id !== 'string' || error.id === '') return null;
  return invalidatesEntitlement(error.reason) ? `${error.reason}:${error.id}` : null;
}
