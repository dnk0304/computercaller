import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signEmailToken } from '@/lib/auth';
import { sendVerificationEmail } from '@/lib/email';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    const user = await db.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        subscription: {
          create: { status: 'trial', trialEndsAt },
        },
      },
    });

    const verifyToken = signEmailToken(user.id);
    await db.user.update({ where: { id: user.id }, data: { emailVerifyToken: verifyToken } });

    try {
      await sendVerificationEmail(user.email, verifyToken);
    } catch (e) {
      console.error('[Auth] Failed to send verification email:', e);
    }

    return NextResponse.json({ message: 'Account created. Check your email to verify.' }, { status: 201 });
  } catch (e) {
    console.error('[Auth] Register error:', e);
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 });
  }
}
