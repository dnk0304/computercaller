/**
 * usersClient — the typed client for `POST /api/admin/users` (2026-08-15).
 *
 * Same shape as freeAccessClient / articlesClient: plain module functions, one
 * `ENDPOINT`, same-origin JSON so the auth cookie rides along and Forge's
 * `requireSameOrigin` CSRF check passes. There is NO csrf token or header in
 * this codebase — origin checking is the whole mechanism, so adding one would
 * be cargo cult.
 *
 * WHY THE RICH ERROR CLASS. A 409 here is not an error message, it is a
 * DESTINATION: the account already exists, and the admin's next move depends on
 * what that account already is (does it have a password? is it allowlisted?).
 * Flattening that to a string — which `readError` would do — throws away the
 * only information that makes the duplicate case actionable, so the conflict
 * payload is carried on the thrown error and rendered by the panel.
 */

import type {
  CreateUserInput,
  CreateUserResponse,
  ExistingUserConflict,
} from './adminTypes';

const ENDPOINT = '/api/admin/users';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Thrown for every non-2xx. `conflict` is populated only for the 409, and is
 * what lets the panel render the existing account instead of a dead string.
 */
export class CreateUserError extends Error {
  readonly status: number;
  readonly conflict?: ExistingUserConflict['user'];
  /**
   * The request may or may not have committed (2026-08-15).
   *
   * `POST /api/admin/users` writes the account, its comp and its audit row in
   * ONE transaction and only then sends mail — so a 5xx or a dropped connection
   * after the write leaves the admin unable to tell "nothing happened" from
   * "the account exists and its one-time link is gone forever". Retrying blind
   * gets a 409; not retrying may abandon a real customer.
   *
   * When this is true the UI must NOT say "couldn't create the account". It
   * must say it does not know, and send the admin to Customers to look.
   */
  readonly indeterminate: boolean;
  /** Server-supplied refusal code, when there is one (e.g. `already_redeemed`). */
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    opts: {
      conflict?: ExistingUserConflict['user'];
      indeterminate?: boolean;
      code?: string;
    } = {},
  ) {
    super(message);
    this.name = 'CreateUserError';
    this.status = status;
    this.conflict = opts.conflict;
    this.indeterminate = opts.indeterminate ?? false;
    this.code = opts.code;
  }
}

/**
 * Returns (never throws) the error for a failed response, so callers read
 * `throw await toError(res)` — the same idiom articlesClient uses.
 *
 * Status copy is overridden deliberately: a raw 401/403 from an expired admin
 * session otherwise surfaces as "Forbidden", which tells the reader nothing
 * about what to DO.
 */
async function toError(res: Response): Promise<CreateUserError> {
  let body: Partial<ExistingUserConflict> & { error?: unknown; code?: unknown } = {};
  try {
    body = (await res.json()) as ExistingUserConflict;
  } catch {
    /* non-JSON body — fall through to the status-based copy */
  }
  const serverMessage =
    typeof body?.error === 'string' && body.error.trim() ? body.error : null;
  const code = typeof body?.code === 'string' ? body.code : undefined;

  if (res.status === 409 && body?.user) {
    return new CreateUserError(
      serverMessage ?? 'An account with that email already exists',
      409,
      { conflict: body.user, code },
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new CreateUserError(
      'Your admin session has expired. Reload the page and sign in again.',
      res.status,
      { code },
    );
  }
  // 5xx: the request reached the server. The write may well have committed
  // before it failed, so this is an UNKNOWN outcome, not a failure. See
  // CreateUserError.indeterminate.
  if (res.status >= 500) {
    return new CreateUserError(
      serverMessage ?? `The server errored (${res.status}).`,
      res.status,
      { indeterminate: true, code },
    );
  }
  return new CreateUserError(
    serverMessage ?? `Couldn’t create the account (${res.status}).`,
    res.status,
    { code },
  );
}

/**
 * One request shape for both create and resend. Split out so the two exported
 * verbs cannot drift on credentials, CSRF posture or error translation.
 *
 * A thrown `fetch` (offline, DNS, connection reset mid-flight) is translated
 * here rather than escaping as a bare TypeError: "Failed to fetch" tells the
 * admin nothing, and — critically — the request may already have committed
 * server-side, so it is flagged indeterminate for the same reason a 5xx is.
 */
async function post(body: CreateUserInput): Promise<CreateUserResponse> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } catch {
    throw new CreateUserError(
      'The connection dropped before the server answered.',
      0,
      { indeterminate: true },
    );
  }

  if (!res.ok) throw await toError(res);
  return (await res.json()) as CreateUserResponse;
}

/**
 * Create an account and mint its single-use invite.
 *
 * ⚠️ The resolved `invite.url` is the ONE copy of a credential-bearing link that
 * will ever exist. Callers must hold it in component state only — never
 * localStorage, never a URL, never a log line.
 */
export async function createUser(input: CreateUserInput): Promise<CreateUserResponse> {
  const body: CreateUserInput = { email: input.email };
  // Optional fields are omitted rather than sent empty: the route runs them
  // through normalizeNote, and a blank string would persist as an empty note.
  if (input.name && input.name.trim()) body.name = input.name.trim();
  if (input.note && input.note.trim()) body.note = input.note.trim();
  if (input.freeAccess) body.freeAccess = true;

  return post(body);
}

/**
 * Mint a FRESH invite link for an account that already exists and has not been
 * redeemed. The previously-issued link stops working the moment this resolves.
 *
 * ⚠️ Same handling rule as `createUser`: the resolved `invite.url` is the only
 * copy that will ever exist. Component state only.
 *
 * Throws `CreateUserError` with `code: 'already_redeemed' | 'not_resendable'`
 * when the server refuses — both are correct refusals, not faults. The UI
 * disables the action for those accounts up front; this is the race-safe
 * backstop for a redemption that lands mid-request.
 */
export async function resendInvite(email: string, note?: string): Promise<CreateUserResponse> {
  const body: CreateUserInput = { email: email.trim(), resend: true };
  if (note && note.trim()) body.note = note.trim();
  return post(body);
}

/**
 * Can this account be re-invited at all?
 *
 * Re-exported from the SHARED rule the route enforces (lib/inviteResend-core),
 * not reimplemented here. A UI copy of a security predicate drifts, and a panel
 * that offers what the server refuses teaches the operator to click through
 * warnings. The refusal reasons and the reasoning live in that file.
 */
export { canResendInvite, resendRefusal, RESEND_REFUSAL_MESSAGE } from '@/lib/inviteResend-core';

/** The same address check the rest of the admin panel uses. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
