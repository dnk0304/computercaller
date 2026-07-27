/**
 * lib/entitlement-core.js — the SINGLE runtime source of truth for the
 * "is this user allowed to use the paid product right now?" decision.
 *
 * WHY THIS FILE IS PLAIN COMMONJS (not the .ts):
 *   The relay lives in `server.js`, a plain-Node custom server started with
 *   `node server.js` (see package.json `start`). It is NOT transpiled by Next,
 *   so it cannot `import` the TypeScript `lib/entitlement.ts`. Before this file
 *   existed, `server.js` had NO entitlement check at all — the raw-phoneToken
 *   relay doors (`?token=`, `Authorization: Bearer`) admitted any logged-in
 *   user, entitled or not (broken-access-control revenue leak, 2026-07-27).
 *
 *   Rather than replicate the rules in JS (which WOULD drift from the TS and
 *   silently reopen the leak), this file is the ONE implementation that both
 *   worlds consume:
 *     • server.js  → `require('./lib/entitlement-core.js')`   (Node)
 *     • lib/entitlement.ts / lib/auth.ts → re-export from here (TS, via the
 *       sibling entitlement-core.d.ts type declaration)
 *   One source ⇒ the money/access decision can NEVER drift between the browser
 *   gate and the relay gate. That is the whole point.
 *
 * NO-LOCKOUT GUARANTEE (fail-SAFE for admin + allowlist): rule (1) admin and
 * rule (2) allowlist are checked FIRST and short-circuit to allowed=true
 * regardless of subscription state. Dennis (isAdmin) and the reviewer@ /
 * ENTITLEMENT_ALLOWLIST emails can never be locked out by a missing, expired,
 * or corrupt subscription row.
 *
 * FAIL-CLOSED on the money path: `evaluateUserEntitlement` returns denied when
 * the user row is missing OR the DB lookup throws — the relay must NOT admit an
 * unverified peer on error. (This is the paywall; unlike the proxy which is
 * UX-only and may fail open.)
 */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// Hardcoded fallback so a missing/fat-fingered ENTITLEMENT_ALLOWLIST env can
// never lock Dennis or the Play reviewer out. Mirrors the old lib/auth.ts
// constant this replaces (single source now).
const ENTITLEMENT_ALLOWLIST_FALLBACK =
  'dennis.kotlenko@gmail.com,reviewer@computercaller.com';

/**
 * Is this email on the entitlement allowlist? Read from process.env at CALL
 * time (a Coolify edit takes effect on the next request, no redeploy), falling
 * back to the hardcoded list. Case-insensitive.
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
function isEntitlementAllowed(email) {
  if (!email) return false;
  const raw = process.env.ENTITLEMENT_ALLOWLIST
    ? process.env.ENTITLEMENT_ALLOWLIST.trim()
    : '';
  const list = (raw && raw.length > 0 ? raw : ENTITLEMENT_ALLOWLIST_FALLBACK)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

/**
 * Evaluate entitlement. Rules applied IN ORDER — first match wins:
 *   (1) isAdmin                       → admin, allowed (never locked)
 *   (2) isEntitlementAllowed(email)   → allowlisted, allowed
 *   (3) no subscription               → none, denied
 *   (4) active AND (currentPeriodEnd null OR > now) → active, allowed
 *   (5) trial AND trialEndsAt > now   → trialing, allowed (trialDaysLeft ceil)
 *   (6) trial AND trialEndsAt <= now  → trial_expired, denied
 *   (7) else                          → expired, denied
 *
 * MUST stay byte-for-byte equivalent to the rule order documented in
 * lib/entitlement.ts (this file IS that implementation).
 *
 * @param {{ isAdmin: boolean, email: string, subscription: ({ status: string, trialEndsAt: Date, currentPeriodEnd: (Date|null) }|null) }} input
 * @param {Date} [now]
 * @returns {{ allowed: boolean, state: string, trialDaysLeft: (number|null), reason: string }}
 */
function evaluateEntitlement(input, now) {
  const clock = now instanceof Date ? now : new Date();
  const { isAdmin, email, subscription } = input;
  const nowMs = clock.getTime();

  // (1) Admin — never locked, regardless of subscription.
  if (isAdmin) {
    return { allowed: true, state: 'admin', trialDaysLeft: null, reason: 'admin' };
  }

  // (2) Entitlement allowlist (env + hardcoded fallback).
  if (isEntitlementAllowed(email)) {
    return {
      allowed: true,
      state: 'allowlisted',
      trialDaysLeft: null,
      reason: 'entitlement_allowlist',
    };
  }

  // (3) No subscription at all — cannot be entitled.
  if (!subscription) {
    return { allowed: false, state: 'none', trialDaysLeft: null, reason: 'no_subscription' };
  }

  const { status, trialEndsAt, currentPeriodEnd } = subscription;

  // (4) Active paid subscription. null currentPeriodEnd = open-ended active.
  if (
    status === 'active' &&
    (currentPeriodEnd === null || currentPeriodEnd.getTime() > nowMs)
  ) {
    return { allowed: true, state: 'active', trialDaysLeft: null, reason: 'active_subscription' };
  }

  // (5) Live trial.
  if (status === 'trial' && trialEndsAt.getTime() > nowMs) {
    const trialDaysLeft = Math.ceil((trialEndsAt.getTime() - nowMs) / DAY_MS);
    return { allowed: true, state: 'trialing', trialDaysLeft, reason: 'trial_active' };
  }

  // (6) Trial that has run out.
  if (status === 'trial' && trialEndsAt.getTime() <= nowMs) {
    return { allowed: false, state: 'trial_expired', trialDaysLeft: 0, reason: 'trial_expired' };
  }

  // (7) Everything else: expired, cancelled, or active-with-a-past-period.
  return {
    allowed: false,
    state: 'expired',
    trialDaysLeft: null,
    reason: `not_entitled_status_${status}`,
  };
}

/**
 * Load {isAdmin,email,subscription} for `userId` and evaluate entitlement.
 * This is the exact chokepoint server.js' relay upgrade calls for EVERY auth
 * path (?token=, Bearer, ?ticket=) so the browser gate and the relay gate use
 * identical logic.
 *
 * FAIL-CLOSED: on a missing row OR a DB error, returns allowed:false. The relay
 * must not admit an unverified peer. (Admin/allowlist bypass only applies once
 * the row is successfully loaded — a total DB outage denies everyone, same
 * stance as the relay-ticket route, and the whole app is down in that case
 * anyway.)
 *
 * @param {{ user: { findUnique: Function } }} dbClient  Prisma client (or a mock)
 * @param {string} userId
 * @param {Date} [now]
 * @returns {Promise<{ allowed: boolean, state: string, trialDaysLeft: (number|null), reason: string }>}
 */
async function evaluateUserEntitlement(dbClient, userId, now) {
  let user;
  try {
    user = await dbClient.user.findUnique({
      where: { id: userId },
      select: {
        isAdmin: true,
        email: true,
        subscription: {
          select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
        },
      },
    });
  } catch (err) {
    return {
      allowed: false,
      state: 'error',
      trialDaysLeft: null,
      reason: 'entitlement_lookup_error',
    };
  }
  if (!user) {
    return { allowed: false, state: 'none', trialDaysLeft: null, reason: 'user_not_found' };
  }
  return evaluateEntitlement(
    { isAdmin: user.isAdmin, email: user.email, subscription: user.subscription },
    now,
  );
}

/**
 * Resolve whether a Whop membership/payment event proves a card is on file.
 *
 * Returns:
 *   true   — a card is positively confirmed (explicit flag true, OR
 *            payment.succeeded which means a real charge cleared).
 *   false  — positively no card (explicit flag false).
 *   null   — UNKNOWN (e.g. membership.went_valid with no flag — a no-card Whop
 *            trial). Callers must NOT assert a card in this case; they should
 *            preserve any prior value rather than default to true.
 *
 * Fixes the pre-2026-07-27 `explicitCard ?? true` bug that recorded every
 * no-card trial as a card-attached paying conversion, making the admin
 * dashboard lie about who actually has a card.
 *
 * @param {string} action
 * @param {unknown} data
 * @returns {boolean|null}
 */
function resolveWhopCardState(action, data) {
  const d = data && typeof data === 'object' ? data : {};
  const u = d.user && typeof d.user === 'object' ? d.user : {};
  const explicit =
    typeof d.has_payment_method === 'boolean'
      ? d.has_payment_method
      : typeof u.has_payment_method === 'boolean'
        ? u.has_payment_method
        : null;
  if (explicit !== null) return explicit;
  if (action === 'payment.succeeded') return true;
  return null;
}

module.exports = {
  isEntitlementAllowed,
  evaluateEntitlement,
  evaluateUserEntitlement,
  resolveWhopCardState,
  ENTITLEMENT_ALLOWLIST_FALLBACK,
};
