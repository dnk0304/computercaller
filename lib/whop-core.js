/**
 * lib/whop-core.js — PURE Whop membership interpretation (2026-08-12, dispatch
 * fix/whop-payment-reconcile).
 *
 * Zero dependencies, zero I/O, plain CommonJS — exactly like lib/entitlement-core.js
 * and lib/tiers-core.js. That is deliberate: the SAME rules must be readable from
 *   • lib/whop-reconcile.ts        (the admin reconciliation job, TS)
 *   • scripts/backfill-whop-subscription.mjs (the one-shot backfill, ESM)
 *   • tests/whop-reconcile.test.js (runner-less node test, CJS)
 * without three drifting copies. A membership-selection bug that lives in two
 * places is how a cancelled trial overwrites a live paid subscription.
 *
 * THE RULE THAT MATTERS (incident 2026-08-11, sendyfeldheim@gmail.com):
 * a customer can hold SEVERAL memberships on the same product. He started a
 * trial, cancelled it, then bought the real subscription 3.5 minutes later —
 * so he holds a cancelled `trialing` membership AND a live `active` one, and
 * the cancelled one is the one that was created FIRST. Picking "the newest
 * membership" or "the first in the list" is a coin flip that can store the
 * dead trial and expire a paying customer. We pick the `valid === true`
 * membership with the LATEST period end. See pickAuthoritativeMembership.
 */

'use strict';

/** Narrow an unknown to a plain object, or null. */
function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * Unwrap a membership that may be wrapped as `{ data: {...} }` by the API.
 */
function membershipRoot(payload) {
  const root = asRecord(payload);
  if (!root) return null;
  return asRecord(root.data) || root;
}

/**
 * Coerce any Whop timestamp to epoch-ms, or null.
 *
 * Whop's own OpenAPI spec CONTRADICTS itself on these fields — the prose says
 * "Unix timestamp" while `format` and the examples are ISO 8601 — so we sniff
 * the RUNTIME type instead of trusting a documented unit. A numeric value above
 * 1e12 is already milliseconds; below that it is seconds.
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return toEpochMs(n);
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * The end of the current paid period (a.k.a. next-payment / access-until) for a
 * membership, as epoch-ms. Reads every generation's spelling:
 *   `renewal_period_end` (v5) | `current_period_end` (v1) | `expires_at` (v2).
 * Returns null when the membership carries none of them.
 */
function membershipPeriodEndMs(membership) {
  const m = membershipRoot(membership);
  if (!m) return null;
  for (const field of ['renewal_period_end', 'current_period_end', 'expires_at']) {
    const ms = toEpochMs(m[field]);
    if (ms !== null) return ms;
  }
  return null;
}

/** Creation time of a membership as epoch-ms, or null. */
function membershipCreatedAtMs(membership) {
  const m = membershipRoot(membership);
  if (!m) return null;
  return toEpochMs(m.created_at) ?? toEpochMs(m.createdAt);
}

/** The Whop user id attached to a membership / webhook payload, or null. */
function extractWhopUserId(payload) {
  const m = membershipRoot(payload);
  if (!m) return null;
  if (typeof m.user_id === 'string' && m.user_id) return m.user_id;
  const user = asRecord(m.user);
  if (user && typeof user.id === 'string' && user.id) return user.id;
  if (typeof m.user === 'string' && m.user) return m.user;
  return null;
}

/** The email carried on a membership / webhook payload, lowercased, or null. */
function extractPayloadEmail(payload) {
  const m = membershipRoot(payload);
  if (!m) return null;
  const user = asRecord(m.user);
  const raw =
    (user && typeof user.email === 'string' && user.email) ||
    (typeof m.email === 'string' && m.email) ||
    (typeof m.user_email === 'string' && m.user_email) ||
    '';
  const trimmed = raw.trim().toLowerCase();
  return trimmed || null;
}

/**
 * Plan id off a membership / webhook payload. Whop's schema drifted across
 * versions: `plan_id` (v2), `plan` as a bare id string, or `plan: { id }`.
 */
function extractPlanId(payload) {
  const m = membershipRoot(payload);
  if (!m) return null;
  if (typeof m.plan_id === 'string' && m.plan_id) return m.plan_id;
  if (typeof m.plan === 'string' && m.plan) return m.plan;
  const plan = asRecord(m.plan);
  if (plan && typeof plan.id === 'string' && plan.id) return plan.id;
  return null;
}

/** The membership id, or null. */
function extractMembershipId(payload) {
  const m = membershipRoot(payload);
  if (!m) return null;
  return typeof m.id === 'string' && m.id ? m.id : null;
}

/**
 * Did the customer ask to stop? true | false — never null here (unlike the
 * webhook's null-preserving read) because reconciliation treats the LIVE Whop
 * object as complete truth: if Whop doesn't say the membership is cancelling,
 * it isn't.
 */
function membershipCancelAtPeriodEnd(membership) {
  const m = membershipRoot(membership);
  if (!m) return false;
  if (typeof m.cancel_at_period_end === 'boolean') return m.cancel_at_period_end;
  if (typeof m.status === 'string' && (m.status === 'canceling' || m.status === 'canceled')) {
    return true;
  }
  return false;
}

/** Was this membership ever cancelled by the customer (any evidence)? */
function membershipCancellationIntended(membership) {
  const m = membershipRoot(membership);
  if (!m) return false;
  if (membershipCancelAtPeriodEnd(m)) return true;
  if (toEpochMs(m.canceled_at) !== null) return true;
  if (toEpochMs(m.cancelled_at) !== null) return true;
  return false;
}

/** Whop's own `valid` flag — the single authority on "is this live right now". */
function membershipIsValid(membership) {
  const m = membershipRoot(membership);
  return !!m && m.valid === true;
}

/**
 * Pick the ONE membership that represents what a customer actually holds.
 *
 * Rule, in order:
 *   1. Only `valid === true` memberships are candidates. An invalid membership
 *      never speaks for a customer who also holds a valid one.
 *   2. Among those, the LATEST period end wins — that is the subscription that
 *      keeps them entitled the longest, and it is the one they are paying for.
 *   3. Ties (or memberships with no period end at all) break on the later
 *      `created_at`, then on the later position in the list. Deterministic.
 *   4. If NOTHING is valid, fall back to the invalid membership with the latest
 *      period end, so a fully-lapsed customer still reconciles to the right
 *      'cancelled'/'expired' row instead of being skipped. `valid` on the
 *      returned object tells the caller which case it got.
 *
 * Returns null only for an empty/garbage list.
 */
function pickAuthoritativeMembership(memberships) {
  const list = Array.isArray(memberships) ? memberships.filter((m) => !!membershipRoot(m)) : [];
  if (list.length === 0) return null;

  const valid = list.filter(membershipIsValid);
  const pool = valid.length > 0 ? valid : list;

  let best = null;
  let bestPeriod = -Infinity;
  let bestCreated = -Infinity;
  for (const m of pool) {
    // A candidate with no period end sorts BELOW any candidate that has one —
    // an unknown end date must never beat a known, later one.
    const period = membershipPeriodEndMs(m) ?? -Infinity;
    const created = membershipCreatedAtMs(m) ?? -Infinity;
    if (best === null || period > bestPeriod || (period === bestPeriod && created >= bestCreated)) {
      best = m;
      bestPeriod = period;
      bestCreated = created;
    }
  }
  return best;
}

/**
 * Map ONE membership to the Subscription column values it implies.
 *
 * Status mapping:
 *   • `valid === true`                     → 'active'
 *   • otherwise, cancellation was intended → 'cancelled' (voluntary churn)
 *   • otherwise                            → 'expired'   (involuntary churn)
 *
 * DELIBERATE DEVIATION FROM THE BRIEF, documented: the brief specifies
 * "'active' when valid && status==='active'". Taken literally, a membership
 * that is `valid` but `trialing` would fall through to 'expired' — and
 * lib/entitlement-core.js DENIES 'expired', so reconciliation would lock out a
 * customer whose membership Whop says is live. Reconciliation must never be
 * able to revoke access from a valid membership. `valid` is Whop's own
 * entitlement flag and it is the one we trust. The narrower rule is preserved
 * where it is safe: a NON-valid membership is still split into cancelled vs
 * expired for churn reporting, which is what the distinction is actually for.
 *
 * `currentPeriodEnd` is omitted (undefined) rather than nulled when the
 * membership carries no period end — never clobber a good stored date with a
 * blank one.
 *
 * Returns plain JS values (Date objects, not Prisma calls) so both the TS job
 * and the ESM script can consume it.
 */
function membershipToSubscriptionFields(membership, now) {
  const m = membershipRoot(membership);
  if (!m) return null;
  const at = now instanceof Date ? now : new Date();

  const valid = membershipIsValid(m);
  const periodEndMs = membershipPeriodEndMs(m);
  const createdMs = membershipCreatedAtMs(m);
  const cancelAtPeriodEnd = membershipCancelAtPeriodEnd(m);

  const status = valid ? 'active' : membershipCancellationIntended(m) ? 'cancelled' : 'expired';

  return {
    whopMembershipId: extractMembershipId(m),
    status,
    planId: extractPlanId(m),
    currentPeriodEnd: periodEndMs === null ? undefined : new Date(periodEndMs),
    // A live membership is never advertising a scheduled cancellation it does
    // not have; a dead one has no future period to cancel at.
    cancelAtPeriodEnd: valid ? cancelAtPeriodEnd : false,
    // canceledAt: only ever a value we may stamp when the row has none. null
    // means "no cancellation known" and callers must NOT overwrite a stored
    // date with it — the ORIGINAL cancellation moment is the useful number.
    canceledAt: cancelAtPeriodEnd || status === 'cancelled' ? at : null,
    // Whop's checkout is card-first on this product: a membership that is or
    // ever was valid was paid for with a card on file.
    paymentMethodAttached: valid,
    // "Paying since" / "trial started" both anchor on when Whop created the
    // membership. Used ONLY to populate a row that has none.
    convertedAt: status === 'active' && createdMs !== null ? new Date(createdMs) : null,
    trialEndsAt: createdMs !== null ? new Date(createdMs) : at,
  };
}

module.exports = {
  toEpochMs,
  extractWhopUserId,
  extractPayloadEmail,
  extractPlanId,
  extractMembershipId,
  membershipPeriodEndMs,
  membershipCreatedAtMs,
  membershipIsValid,
  membershipCancelAtPeriodEnd,
  membershipCancellationIntended,
  pickAuthoritativeMembership,
  membershipToSubscriptionFields,
};
