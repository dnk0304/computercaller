import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { serializeTemplate } from '@/lib/templates';

// Item C1 (2026-05-27) — update/delete a single template.
// Ownership is checked as 404 (NOT 403): we never confirm a row exists for a
// user who doesn't own it, so we don't leak the existence of other users' ids.
// Next.js 16: route params arrive as a Promise.

// PUT /api/templates/:id → partial update. Body may include any of
// { name?, body?, sortOrder? }. name/body, if present, must be non-empty after
// trim (400 otherwise). 404 if the row doesn't exist or isn't the caller's.
// Returns { template }.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await ctx.params;

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { name, body, sortOrder } = (parsed ?? {}) as {
      name?: unknown;
      body?: unknown;
      sortOrder?: unknown;
    };

    const data: { name?: string; body?: string; sortOrder?: number } = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
      }
      data.name = name.trim();
    }
    if (body !== undefined) {
      if (typeof body !== 'string' || !body.trim()) {
        return NextResponse.json({ error: 'body must be a non-empty string' }, { status: 400 });
      }
      data.body = body.trim();
    }
    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 });
      }
      data.sortOrder = sortOrder;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'at least one of name, body, sortOrder is required' },
        { status: 400 },
      );
    }

    // Ownership-scoped update: updateMany with userId in the WHERE updates 0 rows
    // if the id is missing OR owned by someone else — both collapse to a 404
    // without revealing which. Then re-read to return the fresh row.
    const result = await db.template.updateMany({
      where: { id, userId: payload.userId },
      data,
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const updated = await db.template.findUnique({ where: { id } });
    if (!updated) {
      // Deleted between update and read (extremely unlikely, single-session). 404.
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json({ template: serializeTemplate(updated) });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/templates/:id → delete. 404 if not the caller's. Returns { ok: true }.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await ctx.params;

    // Ownership-scoped delete: deleteMany scoped by userId removes 0 rows for a
    // missing or non-owned id → 404 (no existence leak).
    const result = await db.template.deleteMany({
      where: { id, userId: payload.userId },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
