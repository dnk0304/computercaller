/**
 * lib/freeAccessGrant.ts — THE single implementation of "comp this email"
 * (dispatch forge/admin-create-account, 2026-08-15).
 *
 * Free access is a BILLING BYPASS. A granted email resolves through the shared
 * entitlement core to `state:'free_access'` → top tier → allowed. There are now
 * two callers that need to perform that grant:
 *   • POST /api/admin/free-access        — manage the allowlist directly
 *   • POST /api/admin/users              — create an account WITH free access
 *
 * Both go through `grantFreeAccess` below. This is not tidiness for its own
 * sake: on 2026-08-12 the browser gate in `proxy.ts` had drifted from the shared
 * entitlement core because the same rule had been written twice, and free-access
 * grants silently stopped being honoured at one of the two doors. A second
 * hand-rolled "insert FreeAccessEmail + insert FreeAccessAudit" in the new route
 * would have been the identical mistake one layer down: the moment the grant
 * gains a field, a side effect, or a revocation rule, one copy gets it and the
 * other does not.
 *
 * INVARIANT this helper owns: a grant is ALWAYS an upsert of the allowlist row
 * AND an append-only audit row. Never one without the other.
 */

import { db } from '@/lib/db';
import { grantStatus } from '@/lib/entitlement';

// Pragmatic email shape check — one @, non-empty local part, a dotted domain,
// no whitespace. Not RFC-5322-exhaustive on purpose: we only need to reject
// obviously-malformed input before it becomes an allowlist key. Exported so
// every admin route validates identically (a stricter check in one route and a
// looser one in another is how you end up with two spellings of one account).
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase + shape-check. Returns null for anything unusable. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** Trim + cap a free-text admin note. Empty/whitespace/non-string → null. */
export function normalizeNote(raw: unknown, max = 500): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : null;
}

export type GrantStatus = 'permanent' | 'active' | 'expired';

export type FreeAccessEntry = {
  id: string;
  email: string;
  note: string | null;
  grantedBy: string;
  grantedAt: string;
  /** ISO expiry instant, or null for a permanent grant. */
  expiresAt: string | null;
  /** Derived at read/write time from expiresAt vs now (single source: grantStatus). */
  status: GrantStatus;
};

/**
 * Grant (or refresh) free access for an email.
 *
 * Idempotent by design: re-granting an existing email refreshes note/grantedBy
 * without erroring, and `createdAt` (grantedAt) is preserved because it is only
 * set on create. The audit row is appended on EVERY call, including refreshes —
 * "granted again by someone else" is exactly the kind of thing the trail exists
 * to record.
 *
 * @param email  MUST already be normalized (caller validates, so it can return
 *               a 400 with its own error shape).
 * @param actor  admin email, for audit attribution.
 * @param expiresAt When the grant lapses. `null` (default) = permanent. Written
 *               on BOTH create and update, so re-granting an email REFRESHES its
 *               window (extend a shrinking one, or resurrect a lapsed one) —
 *               the same way the upsert already refreshes note/grantedBy. The
 *               shared entitlement gate auto-lapses it at request time.
 * @param client Prisma client or an interactive-transaction client, so the
 *               account-create path can put the user row, the allowlist row and
 *               both audit rows in ONE transaction.
 */
export async function grantFreeAccess(
  email: string,
  actor: string,
  note: string | null = null,
  expiresAt: Date | null = null,
  client: Pick<typeof db, 'freeAccessEmail' | 'freeAccessAudit'> = db,
): Promise<FreeAccessEntry> {
  const row = await client.freeAccessEmail.upsert({
    where: { email },
    create: { email, note, grantedBy: actor, expiresAt },
    update: { note, grantedBy: actor, expiresAt },
    select: { id: true, email: true, note: true, grantedBy: true, createdAt: true, expiresAt: true },
  });

  // Append-only audit — durable who/when/what/HOW-LONG for the billing bypass.
  // The duration lives in the audit note (the FreeAccessAudit schema has no
  // dedicated expiry column, and adding one is more churn than the trail needs):
  // the human note plus a machine-readable expiry marker so the trail records
  // exactly how long each grant was for. Never mutated — this is the record.
  const expiryMark = expiresAt ? `expires=${expiresAt.toISOString()}` : 'expires=never';
  const auditNote = note ? `${note} [${expiryMark}]` : `[${expiryMark}]`;
  await client.freeAccessAudit.create({
    data: { action: 'grant', email, actor, note: auditNote },
  });

  return {
    id: row.id,
    email: row.email,
    note: row.note ?? null,
    grantedBy: row.grantedBy,
    grantedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    status: grantStatus(row.expiresAt),
  };
}

/**
 * Revoke free access for an email.
 *
 * Idempotent: revoking an absent email is a successful no-op, not a 404.
 * `removed` reports whether a row actually existed. The audit row is written
 * either way — an attempted revoke is itself worth recording — which is also
 * why the audit table exists at all: the revoke DELETES the FreeAccessEmail
 * row, so that row can never be its own audit record.
 */
export async function revokeFreeAccess(
  email: string,
  actor: string,
  client: Pick<typeof db, 'freeAccessEmail' | 'freeAccessAudit'> = db,
): Promise<{ removed: boolean }> {
  const result = await client.freeAccessEmail.deleteMany({ where: { email } });
  const removed = result.count > 0;

  await client.freeAccessAudit.create({
    data: { action: 'revoke', email, actor, note: null },
  });
  console.warn(
    `[FreeAccess] revoked ${email} by ${actor} at ${new Date().toISOString()} (existed=${removed})`,
  );

  return { removed };
}
