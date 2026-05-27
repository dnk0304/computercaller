import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { TEMPLATE_LIMIT, serializeTemplate } from '@/lib/templates';

// Item C1 (2026-05-27) — per-user message templates, server-side persistence.
// Auth pattern mirrors app/api/auth/me/route.ts: read auth_token cookie →
// validateSessionToken (signature + sessionVersion) → 401 on null → db call.

// GET /api/templates → { templates: [...] } ordered sortOrder ASC, createdAt DESC.
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const rows = await db.template.findMany({
      where: { userId: payload.userId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    return NextResponse.json({ templates: rows.map(serializeTemplate) });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/templates → create one. Body: { name, body }.
//   400 if name/body empty after trim.
//   409 { error, limit } if the user already has TEMPLATE_LIMIT templates.
//   201 { template } on success. New row sortOrder = (max existing) + 1.
export async function POST(req: NextRequest) {
  try {
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
    const { name, body } = (parsed ?? {}) as { name?: unknown; body?: unknown };

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    // body trim is for the non-empty CHECK only; the stored value preserves the
    // user's content verbatim (incl. internal newlines) save for edge whitespace.
    const trimmedBody = typeof body === 'string' ? body.trim() : '';
    if (!trimmedName || !trimmedBody) {
      return NextResponse.json(
        { error: 'name and body are required and must be non-empty' },
        { status: 400 },
      );
    }

    // CAP: count current rows; reject the create if at/over the limit. The
    // count + create are not in a transaction — a user racing two creates at
    // exactly 14 could momentarily reach 16. Acceptable: single-user, single
    // active session (sessionVersion), and the cap is a UX guardrail, not a
    // security/billing boundary. The list/UI self-corrects on next load.
    const count = await db.template.count({ where: { userId: payload.userId } });
    if (count >= TEMPLATE_LIMIT) {
      return NextResponse.json(
        { error: 'Template limit reached', limit: TEMPLATE_LIMIT },
        { status: 409 },
      );
    }

    // Next sortOrder = max existing + 1 (appends to the end of the carousel).
    const max = await db.template.aggregate({
      where: { userId: payload.userId },
      _max: { sortOrder: true },
    });
    const nextSortOrder = (max._max.sortOrder ?? -1) + 1;

    const created = await db.template.create({
      data: {
        userId: payload.userId,
        name: trimmedName,
        body: trimmedBody,
        sortOrder: nextSortOrder,
      },
    });

    return NextResponse.json({ template: serializeTemplate(created) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
