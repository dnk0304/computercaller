import { NextRequest, NextResponse } from 'next/server';
import {
  getE2ePref,
  setE2ePref,
  parseE2ePrefBody,
  resolveE2ePrefCaller,
  e2ePrefErrorResponse,
} from '@/lib/e2ePref';

// Per-ACCOUNT Encrypted-mode setting (T-E2E-ACCOUNT-PREF step 1; DESIGN REV 2
// §4). Auth = the /api/prefs/layout credential (session cookie + CSRF on PUT)
// plus the extension service worker's ext-session bearer; see lib/e2ePref.ts.
//
// A PUT that CHANGES the preference forces a lobby reset of both sides — the
// caller's own relay socket included. That is expected: the client re-pairs in
// the new mode, and the on-connect E2E_PREF push is the authoritative value.
//
// Status map (every refusal saves NOTHING):
//   400 bad body · 401 unauth · 403 CSRF · 413 too large · 429 rate limited ·
//   503 relay not in this process (checked BEFORE the write, Security M2) ·
//   500 write landed but the reset failed (reset:null, logged at error level).

export const dynamic = 'force-dynamic';

// GET /api/prefs/e2e -> { resolved }
export async function GET(req: NextRequest) {
  try {
    const caller = await resolveE2ePrefCaller(req, false);
    if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
    let resolved;
    try {
      resolved = await getE2ePref(caller.userId);
    } catch (e) {
      return e2ePrefErrorResponse(e);
    }
    if (!resolved) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ resolved });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/prefs/e2e  Body: exactly {"value":"on"|"off"}
//   -> { changed, resolved, reset: {closed,phones,browsers,listeners} | null }
export async function PUT(req: NextRequest) {
  try {
    const caller = await resolveE2ePrefCaller(req, true);
    if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

    const body = await parseE2ePrefBody(req);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });

    try {
      const out = await setE2ePref(caller.userId, body.value, caller.source);
      return NextResponse.json(out);
    } catch (e) {
      return e2ePrefErrorResponse(e);
    }
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
