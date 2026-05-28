import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';

// Item C1 (2026-05-27) — bulk reorder templates (Ken's preference over per-row PUTs).
//
// PUT /api/templates/reorder
//   Body: { orderedIds: string[] }  — the desired order, front to back.
//   Sets sortOrder = array index for each id THE CALLER OWNS. ids not owned by
//   the caller (or that don't exist) are silently ignored — no error, no leak.
//   Returns { ok: true }. The next GET reflects the new order (sortOrder ASC).
export async function PUT(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { orderedIds } = (parsed ?? {}) as { orderedIds?: unknown };

    if (!Array.isArray(orderedIds) || !orderedIds.every((x) => typeof x === 'string')) {
      return NextResponse.json(
        { error: 'orderedIds must be an array of strings' },
        { status: 400 },
      );
    }

    // Apply all updates in one transaction so the new order lands atomically.
    // Each update is scoped by userId, so an id the caller doesn't own simply
    // matches 0 rows (no-op) — ownership is enforced without leaking existence.
    await db.$transaction(
      orderedIds.map((id, index) =>
        db.template.updateMany({
          where: { id, userId: payload.userId },
          data: { sortOrder: index },
        }),
      ),
    );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
