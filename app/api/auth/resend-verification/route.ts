import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { signEmailToken, requireSameOrigin } from '@/lib/auth';
import { sendVerificationEmail } from '@/lib/email';

// ratelimit-todo: production must rate-limit this endpoint (e.g. 3/hr per email +
// per IP via Redis). Test rig is single-user so we skip real infra here.

const GENERIC_RESPONSE = {
  ok: true,
  message:
    'If your email is registered and not yet verified, a new verification link has been sent.',
};

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const { email } = await req.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
    }

    const normalized = email.toLowerCase().trim();
    const user = await db.user.findUnique({ where: { email: normalized } });

    // Non-enumeration: always return the same generic response regardless of
    // whether the user exists or is already verified. Logging captures the
    // actual branch hit for diagnostics.
    if (!user) {
      console.log('[Auth] Resend-verification requested for unknown email:', normalized);
      return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
    }

    if (user.emailVerified) {
      console.log('[Auth] Resend-verification requested for already-verified user:', normalized);
      return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
    }

    // Generate fresh token, persist, send email. Same shape as register.
    const verifyToken = signEmailToken(user.id);
    await db.user.update({ where: { id: user.id }, data: { emailVerifyToken: verifyToken } });

    try {
      await sendVerificationEmail(user.email, verifyToken);
      console.log('[Auth] Resend-verification email sent for:', normalized);
    } catch (e) {
      console.error('[Auth] Failed to send resend verification email:', e);
      // Still return 200 — don't leak the email-service state to clients.
    }

    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  } catch (e) {
    console.error('[Auth] Resend-verification error:', e);
    // Still return 200 to avoid revealing internal state via 500 timing/shape.
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }
}
