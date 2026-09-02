/**
 * POST /api/admin/reconcile-whop — Dennis-only Whop→Postgres reconciliation
 * (2026-08-12, dispatch fix/whop-payment-reconcile).
 *
 * Pulls every membership from the Whop company API and makes the Subscription
 * table agree with it. This is the repair path for the 2026-08-11 incident
 * (paying customer with no Subscription row) and, more importantly, the
 * standing answer to "what happens when a webhook is missed" — because until
 * now the answer was "nothing, forever".
 *
 * AUTHZ: valid session → isAdminUser (the single admin authority), same gate as
 * every other admin route. Deny by default.
 *
 * READ-ONLY against Whop. Never deletes a Subscription. Idempotent — POST it
 * twice and the second call reports `unchanged` for every customer.
 *
 * Body (optional JSON): `{ "dryRun": true }` → compute and return the diff
 * without writing anything. Use it first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAdminUser } from '@/lib/entitlement';
import { reconcileWhopSubscriptions } from '@/lib/whop-reconcile';

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const token = req.cookies.get('auth_token')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const payload = await validateSessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const requester = await db.user.findUnique({
      where: { id: payload.userId },
      select: { isAdmin: true, email: true },
    });
    if (!isAdminUser({ isAdmin: requester?.isAdmin, email: requester?.email })) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // A malformed/absent body is not an error — it just means "not a dry run".
    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = !!(body && typeof body === 'object' && (body as Record<string, unknown>).dryRun);
    } catch {
      dryRun = false;
    }

    const summary = await reconcileWhopSubscriptions({ dryRun });
    console.log(
      '[Whop reconcile]',
      JSON.stringify({
        by: requester?.email,
        dryRun,
        scanned: summary.scanned,
        matched: summary.matched,
        unmatched: summary.unmatched,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
      }),
    );
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    console.error('[Whop reconcile] failed:', e);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500 });
  }
}
