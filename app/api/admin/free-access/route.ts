/**
 * /api/admin/free-access — Dennis-only free-access allowlist management
 * (dispatch forge/admin-panel-free-access, 2026-07-30).
 *
 * Free access is a BILLING BYPASS: a granted email resolves through the shared
 * entitlement gate to `state:'free_access'` → Pro tier → allowed. Therefore
 * every method here is:
 *   • ADMIN-ONLY — gated on isAdminUser (the single admin authority: isAdmin
 *     flag OR the hardcoded admin email; fail-closed for everyone else).
 *   • CSRF-protected on mutations — requireSameOrigin on POST/DELETE.
 *   • AUDITED — every grant AND revoke writes an append-only FreeAccessAudit
 *     row (who/when/what); revokes also log a server warn line.
 *
 * Endpoints:
 *   GET    → list all FreeAccessEmail rows (+ whether each maps to a registered
 *            user), for the manage-allowlist panel.
 *   POST   { email, note? } → upsert a grant (idempotent). grantedBy = admin.
 *   DELETE { email }        → revoke (delete row; idempotent).
 *
 * No PII leaks in error bodies — validation failures return generic messages.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAdminUser } from '@/lib/entitlement';

// Pragmatic email shape check. Not RFC-5322-exhaustive on purpose: we only need
// to reject obviously-malformed input before it becomes an allowlist key. One
// @, non-empty local part, a dotted domain, no whitespace.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

type AdminOk = { ok: true; adminEmail: string };
type AdminErr = { ok: false; res: NextResponse };

/**
 * Shared admin gate for every method: valid session → load {isAdmin,email} →
 * isAdminUser. Returns the admin's email for audit attribution on success.
 * Deny-by-default: any failure → 401/403, no data.
 */
async function requireAdmin(req: NextRequest): Promise<AdminOk | AdminErr> {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    return { ok: false, res: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  const payload = await validateSessionToken(token);
  if (!payload) {
    return { ok: false, res: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  const requester = await db.user.findUnique({
    where: { id: payload.userId },
    select: { isAdmin: true, email: true },
  });
  if (!isAdminUser({ isAdmin: requester?.isAdmin, email: requester?.email })) {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  // requester is non-null here (isAdminUser returned true off its fields).
  return { ok: true, adminEmail: (requester!.email ?? '').toLowerCase() };
}

async function parseBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

// ── GET: list the allowlist ──────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const rows = await db.freeAccessEmail.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, note: true, grantedBy: true, createdAt: true },
    });

    // Mark which granted emails belong to a registered account (so the UI can
    // flag pre-grants for emails that haven't signed up yet). One IN query.
    const emails = rows.map((r) => r.email);
    const registered = new Set<string>();
    if (emails.length > 0) {
      const users = await db.user.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      });
      for (const u of users) registered.add(u.email.toLowerCase());
    }

    const entries = rows.map((r) => ({
      id: r.id,
      email: r.email,
      note: r.note ?? null,
      grantedBy: r.grantedBy,
      grantedAt: r.createdAt.toISOString(),
      registered: registered.has(r.email.toLowerCase()),
    }));

    return NextResponse.json({ entries, meta: { total: entries.length } });
  } catch (e) {
    console.error('[FreeAccess] GET error:', e);
    return NextResponse.json({ error: 'Failed to load free-access list' }, { status: 500 });
  }
}

// ── POST: grant (idempotent upsert) ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const body = await parseBody(req);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }
    const note =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

    // Idempotent: re-granting an existing email refreshes note/grantedBy without
    // erroring. createdAt (grantedAt) is preserved on update (only set on create).
    const row = await db.freeAccessEmail.upsert({
      where: { email },
      create: { email, note, grantedBy: gate.adminEmail },
      update: { note, grantedBy: gate.adminEmail },
      select: { id: true, email: true, note: true, grantedBy: true, createdAt: true },
    });

    // Append-only audit — durable who/when/what for the billing bypass.
    await db.freeAccessAudit.create({
      data: { action: 'grant', email, actor: gate.adminEmail, note },
    });

    return NextResponse.json({
      entry: {
        id: row.id,
        email: row.email,
        note: row.note ?? null,
        grantedBy: row.grantedBy,
        grantedAt: row.createdAt.toISOString(),
      },
    });
  } catch (e) {
    console.error('[FreeAccess] POST error:', e);
    return NextResponse.json({ error: 'Failed to grant free access' }, { status: 500 });
  }
}

// ── DELETE: revoke (idempotent) ──────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const body = await parseBody(req);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }

    // deleteMany → idempotent (revoking an absent email is a no-op success, not
    // a 404). removed reflects whether a row actually existed.
    const result = await db.freeAccessEmail.deleteMany({ where: { email } });
    const removed = result.count > 0;

    // Audit both the durable log AND a server warn line (brief F5).
    await db.freeAccessAudit.create({
      data: { action: 'revoke', email, actor: gate.adminEmail, note: null },
    });
    console.warn(
      `[FreeAccess] revoked ${email} by ${gate.adminEmail} at ${new Date().toISOString()} (existed=${removed})`,
    );

    return NextResponse.json({ revoked: true, email, removed });
  } catch (e) {
    console.error('[FreeAccess] DELETE error:', e);
    return NextResponse.json({ error: 'Failed to revoke free access' }, { status: 500 });
  }
}
