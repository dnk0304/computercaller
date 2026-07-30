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

// Shared tier map (2026-07-27, dispatch feature/tier-gating). Same CJS module
// the TS layer re-exports (lib/tiers.ts → lib/tiers-core.js), so the tier a user
// resolves to is IDENTICAL in the browser gate, the relay gate, and the
// template-cap routes. planIdToTier maps the 3 locked plan ids; unknown/null →
// 'solo' (safe default, least privilege).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- this module is intentionally plain CJS (see header) so `node server.js` can require it; its own deps must be require()d too.
const { planIdToTier, TIER_LIMITS } = require('./tiers-core.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the tier for an evaluated entitlement result. LOCKED rules (D3):
 *   - admin / allowlisted  → 'pro' (privileged states are NEVER gated down;
 *                            Dennis and the reviewer always get the top tier).
 *   - everyone else        → planIdToTier(subscription.planId). This honors a
 *                            planId attached to an ACTIVE sub (the tier they
 *                            pay for) AND to a TRIALING sub (the tier they chose
 *                            at card-first checkout). No sub / no planId / an
 *                            unknown id → 'solo'.
 * @param {string} state
 * @param {{ planId?: (string|null) }|null|undefined} subscription
 * @returns {'solo'|'plus'|'pro'}
 */
function resolveTier(state, subscription) {
  // free_access joins admin/allowlisted as a PRIVILEGED state → top tier (Pro).
  // Dennis's decision: a free-access grant = full Pro, all features.
  if (state === 'admin' || state === 'allowlisted' || state === 'free_access') return 'pro';
  const planId =
    subscription && typeof subscription.planId === 'string' ? subscription.planId : null;
  return planIdToTier(planId);
}

/**
 * Attach `tier` + `limits` to a base entitlement result (the 4 existing fields
 * stay byte-stable; tier/limits are purely ADDITIVE). Single place so every
 * return path decorates identically.
 * @param {{allowed:boolean,state:string,trialDaysLeft:(number|null),reason:string}} base
 * @param {{ planId?: (string|null) }|null|undefined} subscription
 */
function withTier(base, subscription) {
  const tier = resolveTier(base.state, subscription);
  return Object.assign({}, base, { tier, limits: TIER_LIMITS[tier] });
}

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
 *   (2b) freeAccess === true          → free_access, allowed (Pro tier)
 *   (3) no subscription               → none, denied
 *   (4) active AND (currentPeriodEnd null OR > now) → active, allowed
 *   (5) trial AND trialEndsAt > now   → trialing, allowed (trialDaysLeft ceil)
 *   (6) trial AND trialEndsAt <= now  → trial_expired, denied
 *   (7) else                          → expired, denied
 *
 * free_access (2b) is ranked with the OTHER privileged admits (admin/allowlist),
 * strictly BEFORE every subscription/deny branch. It is a pure ADD to the admit
 * set — it can only turn a deny into an allow for an allowlisted email, and it
 * NEVER changes the decision for anyone whose email is not free-access-granted
 * (freeAccess defaults to undefined/false). The paywall for regular users is
 * byte-stable.
 *
 * MUST stay byte-for-byte equivalent to the rule order documented in
 * lib/entitlement.ts (this file IS that implementation).
 *
 * @param {{ isAdmin: boolean, email: string, freeAccess?: boolean, subscription: ({ status: string, trialEndsAt: Date, currentPeriodEnd: (Date|null), planId?: (string|null) }|null) }} input
 * @param {Date} [now]
 * @returns {{ allowed: boolean, state: string, trialDaysLeft: (number|null), reason: string }}
 */
function evaluateEntitlementBase(input, now) {
  const clock = now instanceof Date ? now : new Date();
  const { isAdmin, email, subscription, freeAccess } = input;
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

  // (2b) Free-access grant (DB-backed email allowlist, resolved by the caller
  // into freeAccess:boolean — see isFreeAccessEmail). Privileged admit → Pro.
  if (freeAccess === true) {
    return { allowed: true, state: 'free_access', trialDaysLeft: null, reason: 'free_access' };
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
 * Public entitlement evaluation. Runs the byte-stable rule engine
 * (evaluateEntitlementBase) then decorates the result with `tier` + `limits`
 * (2026-07-27, dispatch feature/tier-gating). The existing 4 fields
 * {allowed,state,trialDaysLeft,reason} are UNCHANGED; tier/limits are additive
 * so every prior caller keeps working. tier is derived from the resolved state
 * + the subscription's planId (see resolveTier) — this is what guarantees the
 * browser gate, the relay gate, and the template-cap routes see ONE tier.
 * @param {{ isAdmin: boolean, email: string, subscription: ({ status: string, trialEndsAt: Date, currentPeriodEnd: (Date|null), planId?: (string|null) }|null) }} input
 * @param {Date} [now]
 * @returns {{ allowed: boolean, state: string, trialDaysLeft: (number|null), reason: string, tier: string, limits: object }}
 */
function evaluateEntitlement(input, now) {
  const base = evaluateEntitlementBase(input, now);
  return withTier(base, input ? input.subscription : null);
}

// Hardcoded admin email so a missing/lost `isAdmin` DB flag (a fragile manual
// prod UPDATE) can NEVER lock Dennis out of his own admin panel. Mirrors the
// ENTITLEMENT_ALLOWLIST_FALLBACK house pattern above.
const ADMIN_EMAIL_FALLBACK = 'dennis.kotlenko@gmail.com';

/**
 * The SINGLE admin authority. True iff the account is flagged isAdmin===true OR
 * its email is the hardcoded admin email (case-insensitive, trimmed).
 *
 * FAIL-SAFE for Dennis (the email fallback survives a lost DB flag); FAIL-CLOSED
 * for everyone else (no other email matches, isAdmin stays default-false, and
 * ANY error / malformed input → false). This is the privileged gate used by the
 * admin page and EVERY /api/admin/* route — deny by default.
 *
 * @param {{ isAdmin?: unknown, email?: unknown }} [account]
 * @returns {boolean}
 */
function isAdminUser(account) {
  try {
    if (!account || typeof account !== 'object') return false;
    if (account.isAdmin === true) return true;
    return (
      typeof account.email === 'string' &&
      account.email.trim().toLowerCase() === ADMIN_EMAIL_FALLBACK
    );
  } catch (_err) {
    return false;
  }
}

/**
 * Is this email in the DB-backed FreeAccessEmail allowlist? The ONE query every
 * gate (relay, browser, admin feed) uses so free-access resolution can never
 * drift — mirrors the tiers/entitlement one-source discipline.
 *
 * FAIL-CLOSED: a null/blank email, a client missing the model, or ANY DB error
 * returns false. Free access is a privileged ADD to the admit set, so failing
 * closed here simply means "not free" — it can never weaken a paywall or admit
 * someone who wasn't granted.
 *
 * @param {{ freeAccessEmail?: { findUnique: Function } }} dbClient
 * @param {string|null|undefined} email
 * @returns {Promise<boolean>}
 */
async function isFreeAccessEmail(dbClient, email) {
  if (!email || typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  try {
    if (!dbClient || !dbClient.freeAccessEmail) return false;
    const row = await dbClient.freeAccessEmail.findUnique({
      where: { email: normalized },
      select: { email: true },
    });
    return !!row;
  } catch (_err) {
    return false;
  }
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
          // planId added 2026-07-27 for tier resolution. Additive to the
          // select; the paywall decision (allowed/state) is unchanged.
          select: {
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            planId: true,
          },
        },
      },
    });
  } catch (err) {
    // FAIL-CLOSED: denied, and tier defaults to Solo (least privilege) so any
    // relay/route reading limits off an error result gates to the cheapest tier.
    return withTier(
      { allowed: false, state: 'error', trialDaysLeft: null, reason: 'entitlement_lookup_error' },
      null,
    );
  }
  if (!user) {
    return withTier(
      { allowed: false, state: 'none', trialDaysLeft: null, reason: 'user_not_found' },
      null,
    );
  }
  // Free-access resolution folded in HERE so the relay gate (server.js →
  // evaluateUserEntitlement) honors a free-access grant automatically, through
  // the exact same evaluateEntitlement call the browser gate uses. The query
  // fails closed (→ false) so a free-access lookup error can never flip an
  // otherwise-entitled paying user to denied.
  const freeAccess = await isFreeAccessEmail(dbClient, user.email);
  return evaluateEntitlement(
    { isAdmin: user.isAdmin, email: user.email, freeAccess, subscription: user.subscription },
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
  isAdminUser,
  isFreeAccessEmail,
  resolveWhopCardState,
  ENTITLEMENT_ALLOWLIST_FALLBACK,
  ADMIN_EMAIL_FALLBACK,
};
