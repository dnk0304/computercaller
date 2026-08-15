/**
 * lib/inviteResend-core.js — may this account be re-invited?
 * (dispatch pixel/invite-resend, 2026-08-15)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Resending an invite mints a fresh set-password token, which is a
 * CREDENTIAL-BEARING capability: whoever holds the resulting link can set the
 * account's password. So the question "is this account eligible" is a security
 * decision, and it is asked in two places —
 *
 *   • POST /api/admin/users (resend path), which enforces it, and
 *   • components/admin/CreateAccountPanel, which must disable the button and
 *     explain why rather than offer an action that is certain to be refused.
 *
 * Two copies of a security predicate is how they drift, and a UI that offers
 * what the server refuses is how an operator learns to click through warnings.
 * One implementation, two call sites — the same reason entitlement-core.js and
 * passwordSetToken-core.js exist, and plain CJS for the same reason: it can be
 * exercised runner-less against plain objects (`node tests/…`) with no database,
 * no transpiler and no server.
 *
 * ⛔ THE RULE, AND WHY EACH HALF OF IT IS THERE
 * --------------------------------------------
 * An invite may be re-issued ONLY for an account that nobody controls yet.
 *
 *   hasPassword === true      → 'already_redeemed'
 *       The invitee accepted and chose a password. Issuing a new set-password
 *       link would be an admin-triggered credential RESET of a live account: a
 *       different act, with different consent, notification and audit needs,
 *       and a plausible account-takeover path if an admin session is ever
 *       compromised. Password reset is the user's own flow, not this one.
 *
 *   authProvider !== 'email'  → 'not_resendable'
 *       A Google account legitimately has no password hash, so a naive
 *       "hasPassword === false" check would happily mint a set-password link
 *       for an account a real person already uses every day — handing the
 *       link-holder a second, password-based way in. Google users are already
 *       activated; there is nothing to invite them to.
 *
 * Everything else (an admin-created account, never activated, authProvider
 * 'email', no password yet) is precisely the case the resend exists for: the
 * one-time link was lost and the account is otherwise unreachable.
 *
 * The server re-asserts both conditions inside the transaction's WHERE clause,
 * because this predicate answers for a row that was read a moment ago and a
 * redemption can land in between. This module decides; it does not race.
 */

/**
 * @typedef {'already_redeemed' | 'not_resendable' | 'user_not_found'} ResendRefusal
 */

/**
 * Why a resend must be refused, or `null` when it is allowed.
 *
 * @param {{ hasPassword: boolean, authProvider: string } | null | undefined} user
 * @returns {ResendRefusal | null}
 */
function resendRefusal(user) {
  if (!user) return 'user_not_found';
  // Order matters for the MESSAGE, not the outcome: an account that is both
  // Google-linked and password-holding is refused either way, but
  // "they already have a password" is the more actionable thing to tell an
  // admin (it points at password reset) than "it's a Google account".
  if (user.hasPassword === true) return 'already_redeemed';
  if (user.authProvider !== 'email') return 'not_resendable';
  return null;
}

/**
 * Convenience inverse for UI enablement.
 *
 * @param {{ hasPassword: boolean, authProvider: string } | null | undefined} user
 * @returns {boolean}
 */
function canResendInvite(user) {
  return resendRefusal(user) === null;
}

/** Operator-facing copy for each refusal. Kept beside the rule so a new
 *  refusal reason cannot ship without the sentence that explains it. */
const RESEND_REFUSAL_MESSAGE = {
  already_redeemed:
    'That account has already set a password. Re-inviting would reset a live credential, which this tool does not do.',
  not_resendable:
    'That account signs in with Google. It does not need — and must not be given — a set-password link.',
  user_not_found: 'No account with that email exists yet',
};

module.exports = {
  resendRefusal,
  canResendInvite,
  RESEND_REFUSAL_MESSAGE,
};
