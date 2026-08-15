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

  constructor(message: string, status: number, conflict?: ExistingUserConflict['user']) {
    super(message);
    this.name = 'CreateUserError';
    this.status = status;
    this.conflict = conflict;
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
  let body: Partial<ExistingUserConflict> & { error?: unknown } = {};
  try {
    body = (await res.json()) as ExistingUserConflict;
  } catch {
    /* non-JSON body — fall through to the status-based copy */
  }
  const serverMessage =
    typeof body?.error === 'string' && body.error.trim() ? body.error : null;

  if (res.status === 409 && body?.user) {
    return new CreateUserError(
      serverMessage ?? 'An account with that email already exists',
      409,
      body.user,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new CreateUserError(
      'Your admin session has expired. Reload the page and sign in again.',
      res.status,
    );
  }
  return new CreateUserError(
    serverMessage ?? `Couldn’t create the account (${res.status}).`,
    res.status,
  );
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

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await toError(res);
  return (await res.json()) as CreateUserResponse;
}

/** The same address check the rest of the admin panel uses. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
