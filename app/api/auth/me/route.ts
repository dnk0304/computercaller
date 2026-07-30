import { NextRequest, NextResponse } from 'next/server';
import { validateSessionWithIdle } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAdminUser } from '@/lib/entitlement';

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ user: null }, { status: 401 });

    // Dispatch #27 Block B — validateSessionToken does signature verify AND
    // sessionVersion check. A kicked session (another browser logged in for
    // this user) lands here as null, the frontend already routes 401 to the
    // login page so the bounce is automatic.
    //
    // Idle gate (2026-07-27, forge/web-idle-timeout): validateSessionWithIdle
    // ALSO rejects when auth_token is valid but the sliding idle_token has
    // lapsed. An idle-expired open tab's next /me poll returns 401 → the client
    // routes it to login exactly like a kicked session. This is the
    // belt-and-braces to the client timer: even an OS-throttled tab bounces on
    // its next poll regardless of whether its local timer fired.
    const result = await validateSessionWithIdle(req);
    if (!result.ok) return NextResponse.json({ user: null }, { status: 401 });
    const payload = result.payload;

    // Bundle A (2026-05-28) Phase 4 fix (L9, C1): phoneToken removed from the
    // select — over-disclosure on every browser /me poll exposed the relay
    // bearer to any client-side cache or XSS. The browser now fetches a 30s
    // relay-ticket from /api/auth/relay-ticket instead; the QR-pairing flow
    // uses /api/auth/qr-token; APK reads phoneToken via /api/auth/apk-login.
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      // isAdmin selected (2026-07-30) to derive the client admin signal below.
      select: { id: true, email: true, emailVerified: true, isAdmin: true, subscription: true },
    });

    if (!user) return NextResponse.json({ user: null }, { status: 401 });

    // Client admin signal (F6): the EFFECTIVE admin authority (isAdminUser),
    // not the raw DB flag — so Pixel can show/hide the Admin nav link. This is
    // UX only; every /api/admin/* route re-checks server-side, so exposing the
    // boolean leaks no admin data. Overwrite the raw isAdmin with the computed
    // effective value on the returned object.
    const isAdmin = isAdminUser({ isAdmin: user.isAdmin, email: user.email });
    return NextResponse.json({ user: { ...user, isAdmin } });
  } catch {
    // Database not available (no DATABASE_URL in dev) — return null gracefully
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
