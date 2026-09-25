import { NextRequest, NextResponse } from 'next/server';
import {
  seedE2ePref,
  parseE2ePrefBody,
  resolveE2ePrefCaller,
  e2ePrefErrorResponse,
} from '@/lib/e2ePref';

// POST /api/prefs/e2e/seed  Body: exactly {"value":"on"}
//   -> { applied, changed, resolved, reset: null }
//
// Upgrade-only migration (DESIGN §7, Security S4): compare-and-set on a row
// that never chose. It can only raise an unset account to ON, it bumps rev
// (Security M3) and pushes E2E_PREF, and it NEVER resets anybody. 'off' is 400.
// Same auth, CSRF, limiter and status map as PUT /api/prefs/e2e.

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const caller = await resolveE2ePrefCaller(req, true);
    if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

    const body = await parseE2ePrefBody(req);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
    if (body.value !== 'on') {
      return NextResponse.json({ error: 'Seed accepts only {"value":"on"}' }, { status: 400 });
    }

    try {
      const out = await seedE2ePref(caller.userId, body.value, caller.source);
      return NextResponse.json({ applied: out.applied, changed: out.applied, resolved: out.resolved, reset: null });
    } catch (e) {
      return e2ePrefErrorResponse(e);
    }
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
