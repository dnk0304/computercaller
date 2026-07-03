import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { effectiveTemplateLimit, serializeTemplate } from '@/lib/templates';
import { evaluateEntitlement } from '@/lib/entitlement';

// Item C1 (2026-05-27) — per-user message templates, server-side persistence.
// Auth pattern mirrors app/api/auth/me/route.ts: read auth_token cookie →
// validateSessionToken (signature + sessionVersion) → 401 on null → db call.

// Load the caller's effective template create-limit from entitlement (dispatch
// forge/trial7-caps-whopcard, 2026-07-03). Non-paying (trialing/expired/none)
// users are capped at TRIAL_TEMPLATE_LIMIT; paying/privileged keep the full
// TEMPLATE_LIMIT. Reuses the shared evaluateEntitlement — never re-implements
// the paying test. `select` mirrors app/subscribe/page.tsx.
async function resolveTemplateLimit(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      isAdmin: true,
      email: true,
      subscription: {
        select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
      },
    },
  });
  // Row vanished mid-session — treat as non-paying (trial cap). Defensive; the
  // downstream db call would 401/500 anyway.
  if (!user) return effectiveTemplateLimit('none');
  const ent = evaluateEntitlement({
    isAdmin: user.isAdmin,
    email: user.email,
    subscription: user.subscription,
  });
  return effectiveTemplateLimit(ent.state);
}

// GET /api/templates → { templates: [...] } ordered sortOrder ASC, createdAt DESC.
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [rows, limit] = await Promise.all([
      db.template.findMany({
        where: { userId: payload.userId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      }),
      resolveTemplateLimit(payload.userId),
    ]);

    // `limit` added for the UI (Pixel wave 3) so it can show the cap without a
    // second call. Existing `templates` array key unchanged.
    return NextResponse.json({ templates: rows.map(serializeTemplate), limit });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/templates → create one. Body: { name, body }.
//   400 if name/body empty after trim.
//   409 { error, limit } if the user is at their effective template limit.
//   201 { template } on success. New row sortOrder = (max existing) + 1.
export async function POST(req: NextRequest) {
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

    // CAP: count current rows; reject the create if at/over the EFFECTIVE limit
    // for this user (trial tier = 3, paying/privileged = 15; dispatch
    // forge/trial7-caps-whopcard). The count + create are not in a transaction
    // — a user racing two creates could momentarily exceed by one. Acceptable:
    // single active session (sessionVersion), and the cap is a UX/entitlement
    // guardrail, not a security/billing boundary. The list/UI self-corrects on
    // next load. Existing over-cap rows are grandfathered (create-only block).
    const limit = await resolveTemplateLimit(payload.userId);
    const count = await db.template.count({ where: { userId: payload.userId } });
    if (count >= limit) {
      return NextResponse.json(
        { error: 'Template limit reached', limit },
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
