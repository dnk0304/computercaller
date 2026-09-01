import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { parseLayoutPrefs, type LayoutPrefs } from '@/lib/layoutPrefs';

// Per-user desktop dashboard layout preferences (dispatch forge/layout-prefs-
// backend, 2026-09-01). Auth pattern mirrors app/api/templates/route.ts:
// read auth_token cookie → validateSessionToken → 401 on null. PUT adds the
// same-origin CSRF guard used by every mutating settings route.
//
// Persistence: User.layoutPrefs Json? — null means "no saved layout" → the
// client renders the POWER_DEFAULT (today's exact dashboard). Stored garbage
// (e.g. a shape written by a future/rolled-back version) is treated the same:
// GET returns { prefs: null } so the UI never renders a broken grid.

// Reject PUT bodies larger than this (bytes). A full 4-module custom layout is
// well under 1KB; 4KB is generous headroom while capping abuse/accidental bloat.
const MAX_BODY_BYTES = 4096;

// GET /api/prefs/layout → { prefs: LayoutPrefs | null }
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { layoutPrefs: true },
    });

    // Row vanished mid-session, or column null/invalid → null (power fallback).
    const prefs: LayoutPrefs | null = user ? parseLayoutPrefs(user.layoutPrefs) : null;
    return NextResponse.json({ prefs });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/prefs/layout  Body: LayoutPrefs (zod-validated) → { prefs: LayoutPrefs }
//   400 invalid JSON / invalid shape, 401 unauth, 403 CSRF, 413 too large.
export async function PUT(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Size cap on the raw body (bytes), before JSON.parse — a hostile payload
    // must not force a multi-MB parse. Content-Length is advisory; the decoded
    // string length is authoritative.
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Zod validation + normalization (unknown keys stripped, defaults applied).
    const prefs = parseLayoutPrefs(parsed);
    if (!prefs) {
      return NextResponse.json({ error: 'Invalid layout preferences' }, { status: 400 });
    }

    // Persist the NORMALIZED value (Prisma serializes it to the Json? column).
    await db.user.update({
      where: { id: payload.userId },
      data: { layoutPrefs: prefs },
    });

    return NextResponse.json({ prefs });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
