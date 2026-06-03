import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { serializeQuickReplyTemplate } from '@/lib/quickReplyTemplates';

// Dispatch CC-quickreply-templates-v2 (2026-06-03) — update/delete a single
// quick-reply template. SEPARATE from /api/templates/[id]; same patterns.
// Ownership is checked as 404 (NOT 403) via updateMany/deleteMany scoped by
// userId — we never confirm a row exists for a user who doesn't own it, so
// we don't leak the existence of other users' ids. Next.js 16: route params
// arrive as a Promise.

// PUT /api/quick-replies/:id → partial update. Body may include any of
// { body?, label?, sortOrder? }.
//   body if present must be non-empty after trim (400).
//   label is settable to a string OR clearable to null (explicit null OR
//     empty-after-trim string both → null).
//   sortOrder if present must be an integer (400).
// 404 if the row doesn't exist or isn't the caller's. Returns { quickReply }.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

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
    const { body, label, sortOrder } = (parsed ?? {}) as {
      body?: unknown;
      label?: unknown;
      sortOrder?: unknown;
    };

    const data: { body?: string; label?: string | null; sortOrder?: number } = {};

    if (body !== undefined) {
      if (typeof body !== 'string' || !body.trim()) {
        return NextResponse.json({ error: 'body must be a non-empty string' }, { status: 400 });
      }
      data.body = body.trim();
    }
    if (label !== undefined) {
      // Explicit null → clear. String → trim; empty-after-trim → clear.
      if (label === null) {
        data.label = null;
      } else if (typeof label === 'string') {
        const trimmedLabel = label.trim();
        data.label = trimmedLabel.length > 0 ? trimmedLabel : null;
      } else {
        return NextResponse.json(
          { error: 'label must be a string or null' },
          { status: 400 },
        );
      }
    }
    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 });
      }
      data.sortOrder = sortOrder;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'at least one of body, label, sortOrder is required' },
        { status: 400 },
      );
    }

    // Ownership-scoped update: updateMany with userId in the WHERE updates 0
    // rows if the id is missing OR owned by someone else — both collapse to a
    // 404 without revealing which. Then re-read to return the fresh row.
    const result = await db.quickReplyTemplate.updateMany({
      where: { id, userId: payload.userId },
      data,
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Quick-reply not found' }, { status: 404 });
    }

    const updated = await db.quickReplyTemplate.findUnique({ where: { id } });
    if (!updated) {
      // Deleted between update and read (extremely unlikely, single-session). 404.
      return NextResponse.json({ error: 'Quick-reply not found' }, { status: 404 });
    }

    return NextResponse.json({ quickReply: serializeQuickReplyTemplate(updated) });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/quick-replies/:id → delete. 404 if not the caller's.
// Returns { ok: true }.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await ctx.params;

    // Ownership-scoped delete: deleteMany scoped by userId removes 0 rows for
    // a missing or non-owned id → 404 (no existence leak).
    const result = await db.quickReplyTemplate.deleteMany({
      where: { id, userId: payload.userId },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Quick-reply not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
