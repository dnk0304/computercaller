/**
 * lib/adminGate.ts — the shared admin-route gate (dispatch
 * forge/admin-create-account, 2026-08-15).
 *
 * Lifted verbatim out of app/api/admin/free-access/route.ts, where it was a
 * file-local helper, because POST /api/admin/users needs the IDENTICAL gate and
 * a second copy of an authorization check is the worst possible thing to
 * duplicate: a divergence between two copies of a gate is a privilege
 * escalation that no test for either route on its own would catch.
 *
 * Deny-by-default at every step: no cookie → 401, bad/stale session → 401,
 * not an admin → 403. No data ever leaves before the gate returns ok.
 *
 * `isAdminUser` (lib/entitlement) remains the SINGLE admin authority — the
 * isAdmin flag OR the hardcoded admin email, fail-closed for everyone else.
 * This file only plumbs a request to it; it never re-decides who is an admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAdminUser } from '@/lib/entitlement';

export type AdminOk = { ok: true; adminEmail: string };
export type AdminErr = { ok: false; res: NextResponse };
export type AdminGate = AdminOk | AdminErr;

/**
 * Valid session → load {isAdmin,email} → isAdminUser. Returns the admin's
 * lowercased email on success, for audit attribution.
 */
export async function requireAdmin(req: NextRequest): Promise<AdminGate> {
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

/** Parse a JSON body defensively. null = malformed JSON → caller returns 400. */
export async function parseJsonBody(
  req: NextRequest,
): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}
