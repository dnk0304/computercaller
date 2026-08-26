/**
 * Client helpers for the free-access allowlist API. ONE place that knows how to
 * call `POST`/`DELETE /api/admin/free-access`, so the per-row grant/revoke
 * control and the allowlist manager panel hit the endpoint identically (same
 * headers, same same-origin credentials, same error handling) — no drift.
 *
 * All calls are same-origin JSON with `credentials: 'same-origin'` so the auth
 * cookie rides along and Forge's `requireSameOrigin` CSRF check passes. On a
 * non-2xx the helper throws an Error carrying the server's message (or a safe
 * fallback) so callers can surface it inline.
 */

import type {
  FreeAccessEntry,
  FreeAccessGrantResponse,
  FreeAccessListResponse,
} from './adminTypes';

const ENDPOINT = '/api/admin/free-access';

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* non-JSON body — use the fallback */
  }
  return fallback;
}

/** Fetch the full allowlist. Throws on failure. */
export async function listFreeAccess(signal?: AbortSignal): Promise<FreeAccessListResponse> {
  const res = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!res.ok) throw new Error(await readError(res, `Couldn’t load the free-access list (${res.status}).`));
  return (await res.json()) as FreeAccessListResponse;
}

/**
 * Grant (or extend) free access for an email (idempotent upsert).
 *
 * `durationDays` is computed CLIENT-side from the picker: a positive integer for
 * a finite window, or `null`/omitted for a permanent grant. The server owns the
 * clock — it turns the day count into `expiresAt` — so we only ever send the
 * count, never a computed date. Re-granting an existing email REFRESHES its
 * window (extend/renew), which is why the caller's copy reads "Extend" when the
 * email is already listed.
 *
 * Returns the full response — the upserted entry AND `emailSent`, so the caller
 * can warn when the grant landed but the notification email did not.
 */
export async function grantFreeAccess(
  email: string,
  note?: string,
  durationDays?: number | null,
): Promise<FreeAccessGrantResponse> {
  const payload: { email: string; note?: string; durationDays?: number } = { email };
  if (note && note.trim()) payload.note = note.trim();
  // Only send durationDays for a finite window. Omitting it (permanent) and
  // sending null are equivalent server-side; we omit to keep the body minimal.
  if (typeof durationDays === 'number') payload.durationDays = durationDays;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await readError(res, 'Couldn’t grant free access. Please try again.'));
  return (await res.json()) as FreeAccessGrantResponse;
}

/** Revoke free access for an email (idempotent). */
export async function revokeFreeAccess(email: string): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Couldn’t revoke free access. Please try again.'));
}

/** Sort helper — newest grants first, matching the server's default order. */
export function sortEntriesNewestFirst(entries: FreeAccessEntry[]): FreeAccessEntry[] {
  return [...entries].sort(
    (a, b) => new Date(b.grantedAt).getTime() - new Date(a.grantedAt).getTime(),
  );
}
