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
 *
 * 2026-08-15 (forge/admin-create-account) — REFACTOR, no behaviour change.
 * The admin gate, the email/note normalizers and the grant/revoke bodies moved
 * to lib/adminGate.ts and lib/freeAccessGrant.ts so POST /api/admin/users can
 * comp an account through the EXACT same code path instead of hand-rolling a
 * second one. Same status codes, same response shapes, same audit rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { requireAdmin, parseJsonBody } from '@/lib/adminGate';
import {
  grantFreeAccess,
  revokeFreeAccess,
  normalizeEmail,
  normalizeNote,
} from '@/lib/freeAccessGrant';
import { grantStatus } from '@/lib/entitlement';
import { sendFreeAccessGrantedEmail } from '@/lib/email';

// Largest duration an admin may grant in one call (~10 years). Anything longer
// is meant to be a permanent grant (durationDays omitted / null), not a
// finite one — the cap rejects a fat-fingered or hostile day count.
const MAX_DURATION_DAYS = 3650;
const MS_PER_DAY = 86_400_000;

/**
 * Validate the optional durationDays. Returns:
 *   { ok:true, days:null }        → permanent (absent/null)
 *   { ok:true, days:number }      → finite, valid
 *   { ok:false }                  → present but invalid (caller returns 400)
 */
function parseDurationDays(raw: unknown): { ok: true; days: number | null } | { ok: false } {
  if (raw == null) return { ok: true, days: null }; // permanent
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_DURATION_DAYS) {
    return { ok: false };
  }
  return { ok: true, days: raw };
}

// ── GET: list the allowlist ──────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const rows = await db.freeAccessEmail.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, note: true, grantedBy: true, createdAt: true, expiresAt: true },
    });
    const now = new Date();

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
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      status: grantStatus(r.expiresAt, now),
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

    const body = await parseJsonBody(req);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }
    const note = normalizeNote(body.note);

    // Duration: presets (7/30/90/permanent/custom) are computed CLIENT-side into
    // a day count, so the API only ever sees durationDays. null/absent =
    // permanent. Never trust the client's clock — we compute expiresAt here.
    const parsed = parseDurationDays(body.durationDays);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `durationDays must be a positive integer up to ${MAX_DURATION_DAYS}, or omitted for permanent` },
        { status: 400 },
      );
    }
    const expiresAt = parsed.days == null ? null : new Date(Date.now() + parsed.days * MS_PER_DAY);

    const entry = await grantFreeAccess(email, gate.adminEmail, note, expiresAt);

    // Best-effort notification. A mail failure must NEVER fail the grant — the
    // row + audit are already committed. We surface emailSent so the panel can
    // warn "granted, but the email didn't go out." Re-granting re-notifies
    // (a legitimate re-grant to extend is worth re-telling the recipient).
    let emailSent = false;
    try {
      await sendFreeAccessGrantedEmail({ email, expiresAt });
      emailSent = true;
    } catch (mailErr) {
      console.error('[FreeAccess] grant email failed (grant still succeeded):', mailErr);
    }

    return NextResponse.json({ entry, emailSent });
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

    const body = await parseJsonBody(req);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }

    const { removed } = await revokeFreeAccess(email, gate.adminEmail);

    return NextResponse.json({ revoked: true, email, removed });
  } catch (e) {
    console.error('[FreeAccess] DELETE error:', e);
    return NextResponse.json({ error: 'Failed to revoke free access' }, { status: 500 });
  }
}
