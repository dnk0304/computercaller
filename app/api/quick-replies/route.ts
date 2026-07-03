import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { effectiveQuickReplyLimit, serializeQuickReplyTemplate } from '@/lib/quickReplyTemplates';
import { evaluateEntitlement } from '@/lib/entitlement';

// Load the caller's effective quick-reply create-limit from entitlement
// (dispatch forge/trial7-caps-whopcard, 2026-07-03). Non-paying users are
// capped at TRIAL_QUICK_REPLY_LIMIT (1); paying/privileged keep the full
// QUICK_REPLY_LIMIT (5). Reuses the shared evaluateEntitlement. `select`
// mirrors app/subscribe/page.tsx.
async function resolveQuickReplyLimit(userId: string): Promise<number> {
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
  if (!user) return effectiveQuickReplyLimit('none');
  const ent = evaluateEntitlement({
    isAdmin: user.isAdmin,
    email: user.email,
    subscription: user.subscription,
  });
  return effectiveQuickReplyLimit(ent.state);
}

// Dispatch CC-quickreply-templates-v2 (2026-06-03) — per-user quick-reply
// templates, server-side persistence. SEPARATE store from the normal SMS
// templates (/api/templates) — these only feed the incoming-call
// reply-and-hangup chips, capped at 5/user. Auth/CSRF/ownership patterns
// mirror app/api/templates/route.ts exactly.

// GET /api/quick-replies → { quickReplies: [...] } ordered sortOrder ASC,
// createdAt DESC, scoped to the caller's userId. 401 if no/invalid token.
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [rows, limit] = await Promise.all([
      db.quickReplyTemplate.findMany({
        where: { userId: payload.userId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      }),
      resolveQuickReplyLimit(payload.userId),
    ]);

    // `limit` added for the UI (Pixel wave 3). Existing `quickReplies` key
    // unchanged.
    return NextResponse.json({ quickReplies: rows.map(serializeQuickReplyTemplate), limit });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/quick-replies → create one. Body: { body, label? }.
//   400 if body is empty after trim.
//   409 { error, limit } if the user is at their effective quick-reply limit.
//   201 { quickReply } on success. New row sortOrder = (max existing) + 1.
// label is optional; trimmed; stored as null if absent or empty after trim.
// 409 shape matches the /api/templates cap response exactly so the client
// can reuse the same handling.
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
    const { body, label } = (parsed ?? {}) as { body?: unknown; label?: unknown };

    // body trim is for the non-empty CHECK only; the stored value is the
    // trimmed user content (matches Template POST behavior — edge whitespace
    // stripped, internal newlines preserved).
    const trimmedBody = typeof body === 'string' ? body.trim() : '';
    if (!trimmedBody) {
      return NextResponse.json(
        { error: 'body is required and must be non-empty' },
        { status: 400 },
      );
    }

    // label: optional. Accept string or omitted/null. Empty-after-trim → null.
    let normalizedLabel: string | null = null;
    if (label !== undefined && label !== null) {
      if (typeof label !== 'string') {
        return NextResponse.json(
          { error: 'label must be a string when provided' },
          { status: 400 },
        );
      }
      const trimmedLabel = label.trim();
      normalizedLabel = trimmedLabel.length > 0 ? trimmedLabel : null;
    }

    // CAP: count current rows; reject the create if at/over the limit.
    // Count + create are not in a transaction — a user racing two creates at
    // exactly 4 could momentarily reach 6. Acceptable: single active session
    // (sessionVersion) makes the race effectively impossible, and the cap is a
    // UX guardrail, not a security/billing boundary. Matches the Template-cap
    // pattern in /api/templates so the 409 shape is identical → Pixel reuses
    // the same handling.
    const limit = await resolveQuickReplyLimit(payload.userId);
    const count = await db.quickReplyTemplate.count({ where: { userId: payload.userId } });
    if (count >= limit) {
      return NextResponse.json(
        { error: 'Quick-reply limit reached', limit },
        { status: 409 },
      );
    }

    // Next sortOrder = max existing + 1 (appends to the end of the chip row).
    const max = await db.quickReplyTemplate.aggregate({
      where: { userId: payload.userId },
      _max: { sortOrder: true },
    });
    const nextSortOrder = (max._max.sortOrder ?? -1) + 1;

    const created = await db.quickReplyTemplate.create({
      data: {
        userId: payload.userId,
        body: trimmedBody,
        label: normalizedLabel,
        sortOrder: nextSortOrder,
      },
    });

    return NextResponse.json(
      { quickReply: serializeQuickReplyTemplate(created) },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
