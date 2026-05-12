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

    const token = signAccessToken({ userId: user.id, email: user.email });

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
