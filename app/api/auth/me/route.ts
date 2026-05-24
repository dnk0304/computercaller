import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ user: null }, { status: 401 });

    // Dispatch #27 Block B — validateSessionToken does signature verify AND
    // sessionVersion check. A kicked session (another browser logged in for
    // this user) lands here as null, the frontend already routes 401 to the
    // login page so the bounce is automatic.
    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ user: null }, { status: 401 });

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, phoneToken: true, emailVerified: true, subscription: true },
    });

    if (!user) return NextResponse.json({ user: null }, { status: 401 });
    return NextResponse.json({ user });
  } catch {
    // Database not available (no DATABASE_URL in dev) — return null gracefully
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
