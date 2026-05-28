import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signEmailToken, requireSameOrigin } from '@/lib/auth';
import { sendVerificationEmail } from '@/lib/email';

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

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
    const trialEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days

    // Dev-mode auto-verify: if no Resend API key is configured, skip the
    // email step entirely and mark the user as already verified. Lets us
    // run the full A→B flow on localhost with zero external deps. In
    // production RESEND_API_KEY is set, so the normal verify-by-email
    // gate stays intact. Detected here (not in lib/email.ts) because the
    // emailVerified column lives in the User row — has to be set at
    // create time to skip the gate cleanly.
    const skipEmailVerification = !process.env.RESEND_API_KEY;

    const user = await db.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        emailVerified: skipEmailVerification,
        subscription: {
          create: { status: 'trial', trialEndsAt },
        },
      },
    });

    if (skipEmailVerification) {
      console.log(`[Auth] DEV MODE — auto-verified ${user.email} (no RESEND_API_KEY set).`);
      return NextResponse.json(
        { message: 'Account created (dev mode auto-verified). You can sign in now.' },
        { status: 201 },
      );
    }

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
