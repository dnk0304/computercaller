/**
 * Type declarations for lib/inviteResend-core.js (the shared plain-JS rule).
 * Keeping the runtime in .js lets the runner-less test require it against
 * plain objects with no transpiler; this .d.ts gives the TS callers — the
 * route and the admin panel — full types with zero drift.
 *
 * Every symbol declared here MUST appear in the core's `module.exports`: a
 * handwritten .d.ts will happily type a symbol that does not exist at runtime,
 * and `tsc` will pass while the import is undefined.
 * tests/admin-invite-resend.test.js asserts the export list against this file.
 */

/** Why a resend is refused. See the core's header for the reasoning behind each. */
export type ResendRefusal = 'already_redeemed' | 'not_resendable' | 'user_not_found';

/** The shape the rule needs. Both call sites can produce it. */
export interface ResendCandidate {
  /** Has the account got a usable password credential already? */
  hasPassword: boolean;
  /** 'email' | 'google' | 'both' — only 'email' accounts are invitable. */
  authProvider: string;
}

/** The refusal reason, or `null` when the resend is allowed. */
export function resendRefusal(user: ResendCandidate | null | undefined): ResendRefusal | null;

/** Convenience inverse of `resendRefusal`, for UI enablement. */
export function canResendInvite(user: ResendCandidate | null | undefined): boolean;

/** Operator-facing copy for each refusal reason. */
export const RESEND_REFUSAL_MESSAGE: Record<ResendRefusal, string>;
