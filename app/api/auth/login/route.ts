import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signAccessToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    const user = await db.user.findUnique({
      where: { email: email?.toLowerCase() },
      include: { subscription: true },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    if (!user.emailVerified) {
      return NextResponse.json({ error: 'Please verify your email before logging in' }, { status: 403 });
    }

    // Dispatch #27 Block B (2026-05-24, Option III) — single-active-session.
    // Bump sessionVersion BEFORE signing the new JWT. Any previously-issued
    // token for this user carries the old `ver` claim; subsequent calls to
    // validateSessionToken will compare against this newly-incremented row
    // and reject the stale token. Use `update`'s atomic increment so concurrent
    // logins serialise correctly at the DB level (no read-modify-write race).
    const bumped = await db.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      ver: bumped.sessionVersion,
    });

    const response = NextResponse.json({
      user: { id: user.id, email: user.email, phoneToken: user.phoneToken },
      subscription: user.subscription,
    });

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 86400, // 24 hours
      path: '/',
    });

    return response;
  } catch (e) {
    console.error('[Auth] Login error:', e);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
