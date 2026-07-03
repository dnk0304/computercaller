import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signEmailToken, requireSameOrigin, isEmailAllowed, isWaitlistMode } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { sendVerificationEmail, sendNewSignupAdminEmail } from '@/lib/email';

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

    // Auth allowlist (2026-06-15). Hard-block public signup BEFORE any
    // db.user.create — only allowlisted emails may ever mint an account while
    // the app is pre-Play-Store. See lib/auth.ts isEmailAllowed.
    if (!isEmailAllowed(email)) {
      return NextResponse.json(
        { error: 'Sign-ups are closed — join the waitlist at computercaller.com' },
        { status: 403 },
      );
    }

    const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // WAITLIST_MODE gate (2026-06-15). When engaged (default, pre-Play-Store)
    // we do NOT provision a free trial. Account still mints (allowlist already
    // gated who gets here), but no trial/payment entitlement is granted. Flip
    // WAITLIST_MODE=off in Coolify to restore the original 7-day trial with
    // zero code redeploy. See lib/auth.ts isWaitlistMode.
    const grantTrial = !isWaitlistMode();

    // Bundle A (2026-05-28) Phase 4 fix (C2): generate phoneToken in
    // application code — schema no longer carries a SQL default (the prior
    // `cuid()` default produced non-cryptographic, structurally-predictable
    // bearers). 32 random bytes encoded base64url ≈ 256 bits of entropy in
    // 43 URL-safe characters. Same format the prior migration's bulk UPDATE
    // produces for existing rows, so the column is uniform across the table.
    const phoneToken = crypto.randomBytes(32).toString('base64url');

    // Dev-mode auto-verify: if no Resend API key is configured, skip the
    // email step entirely and mark the user as already verified. Lets us
    // run the full A→B flow on localhost with zero external deps. In
    // production RESEND_API_KEY is set, so the normal verify-by-email
    // gate stays intact. Detected here (not in lib/email.ts) because the
    // emailVerified column lives in the User row — has to be set at
    // create time to skip the gate cleanly.
    const skipEmailVerification = !process.env.RESEND_API_KEY;

    // IP capture (2026-07-03) — record the signup IP for the same-IP abuse flag
    // in the admin dashboard. Flag-only, never auto-ban. See lib/ip.ts.
    const signupIp = getClientIp(req);

    const user = await db.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        phoneToken,
        emailVerified: skipEmailVerification,
        signupIp,
        // Original behavior (restored by WAITLIST_MODE=off): provision a
        // 7-day trial on signup. Flagged, not deleted.
        ...(grantTrial
          ? { subscription: { create: { status: 'trial', trialEndsAt } } }
          : {}),
      },
    });

    // Admin notify on brand-new signup. Try/catch — must NEVER block signup.
    // In dev (no RESEND_API_KEY) getResend() throws; the catch swallows it.
    try {
      await sendNewSignupAdminEmail({
        userEmail: user.email,
        method: 'email',
        createdAt: user.createdAt ?? new Date(),
      });
    } catch (e) {
      console.error('[Auth] admin signup notify failed:', e);
    }

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
