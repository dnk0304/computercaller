import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

/**
 * Dispatch #28 (2026-05-24) — APK sign-in endpoint.
 *
 * The Android companion app calls this with {email, password} from its
 * SignInActivity. On success it returns {phoneToken, deviceName} which the
 * APK stores in EncryptedSharedPreferences and uses to authenticate against
 * the relay (?token=<phoneToken>).
 *
 * Differences from /api/auth/login:
 *   • No HttpOnly cookie set — the APK has no browser session model. It just
 *     stores the phoneToken locally and uses it forever (no rotation in v1
 *     per Q3 default in the dispatch plan).
 *   • Does NOT bump User.sessionVersion (Q8 in the dispatch plan). The APK
 *     sign-in is orthogonal to the browser's single-active-session model —
 *     signing into the APK should not kick the user out of their browser
 *     session.
 *   • Returns phoneToken in the response body so the APK can persist it.
 *
 * Same as /api/auth/login:
 *   • bcrypt.compare against User.passwordHash
 *   • Rejects unverified-email users with 403
 *   • Generic 401 for invalid credentials (no user-enumeration leak)
 */
export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (typeof email !== 'string' || typeof password !== 'string') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        emailVerified: true,
        phoneToken: true,
      },
    });

    // Google-only account guard (dispatch #36, 2026-05-25). passwordHash
    // is NULL for OAuth-only users. The APK currently has no Google sign-in
    // path — surface a specific error so the user knows to set a password
    // (via /auth/forgot-password, once that ships) rather than retrying
    // with the same Google email + a guessed password forever.
    if (user && user.passwordHash === null) {
      return NextResponse.json(
        {
          error:
            'This account uses Google sign-in. Set a password via the web app to sign into the Android app.',
        },
        { status: 400 },
      );
    }

    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    if (!user.emailVerified) {
      return NextResponse.json(
        { error: 'Please verify your email before signing in' },
        { status: 403 }
      );
    }

    if (!user.phoneToken) {
      // Defensive: every User row should have a phoneToken provisioned at
      // registration. If we ever land here, something is corrupt — surface
      // a 500 so the APK shows a generic error rather than silently failing
      // with an empty token (which the relay would then reject as 4401).
      console.error(`[APKLogin] User ${user.id} has no phoneToken`);
      return NextResponse.json({ error: 'Account misconfigured — contact support' }, { status: 500 });
    }

    return NextResponse.json({
      phoneToken: user.phoneToken,
      deviceName: user.email,
    });
  } catch (e) {
    console.error('[APKLogin] error:', e);
    return NextResponse.json({ error: 'Sign-in failed' }, { status: 500 });
  }
}
