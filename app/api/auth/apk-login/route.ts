import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { isEmailAllowed } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';

// Generic auth failure. ONE body + ONE status for every "you are not getting a
// phoneToken" outcome on this route, so the response can never be used to probe
// which emails exist. Mirrors /api/auth/login (fb1983b, the web enumeration fix).
const INVALID_CREDENTIALS = { error: 'Invalid email or password' } as const;
const INVALID_CREDENTIALS_STATUS = 401;

// Real bcrypt hash of a random throwaway string. Burns the same ~work-factor-12
// CPU on the no-stored-hash paths (no such user / waitlist reject / invite not
// yet redeemed) so those requests don't return in ~1ms while a real wrong
// password takes ~250ms — the timing oracle equalized on web. Same constant as
// app/api/auth/login/route.ts by design.
const TIMING_EQUALIZER_HASH =
  '$2b$12$yDye2rho5BLIB3n.8sk/2eK0JfbOJjW8SLk9NigW05T65mI2qtDtK';

/**
 * Reject with the generic 401, having spent bcrypt time first so this path is
 * indistinguishable from a wrong-password attempt by wall clock.
 */
async function genericAuthFailure(password: unknown): Promise<NextResponse> {
  try {
    await bcrypt.compare(typeof password === 'string' ? password : '', TIMING_EQUALIZER_HASH);
  } catch {
    // A malformed input must not change the response shape or leak a 500.
  }
  return NextResponse.json(INVALID_CREDENTIALS, { status: INVALID_CREDENTIALS_STATUS });
}

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

    // Auth allowlist (2026-06-15). Block non-allowed emails BEFORE bcrypt, same
    // as the web login. This is the interactive APK password login — gating it
    // does NOT touch the phoneToken bearer flow (which is not an interactive
    // login and stays working for Dennis's paired phone). See lib/auth.ts.
    //
    // Admin-provisioned exemption (2026-08-19, forge/apk-invitee-login) — mirrors
    // /api/auth/login. A non-null User.invitedBy IS the allowlist decision an
    // admin made deliberately (recorded on the row + AdminUserAudit), so an
    // invited user can log into the Android app, not just the web. Auth-gate
    // ONLY — grants no entitlement; billing is still the entitlement core's call.
    //
    // ANTI-ENUMERATION: every non-admitting outcome from here down returns the
    // SAME generic 401 via genericAuthFailure with the same bcrypt cost. The old
    // distinct `403 Sign-ups are closed` was an enumeration oracle (it told a
    // prober "this email is not invited"); it is gone. LOGIN is not where a
    // stranger learns the signup policy — /register is.
    if (!isEmailAllowed(email)) {
      const vouched = await db.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { invitedBy: true },
      });
      if (!vouched?.invitedBy) {
        return genericAuthFailure(password);
      }
    }

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        emailVerified: true,
        phoneToken: true,
        authProvider: true,
      },
    });

    // Google-only account guard (dispatch #36, 2026-05-25). NARROWED 2026-08-19
    // to mirror the web enumeration fix: gate on authProvider === 'google', NOT
    // on `passwordHash === null` alone. An admin-provisioned invitee has
    // authProvider 'email' with a null hash until they redeem their invite link;
    // the old check told them "this account uses Google" (wrong) and doubled as
    // an enumeration signal. Now only genuine Google-only accounts land here;
    // the residual "a Google account exists" leak is the accepted #36 trade-off,
    // bounded to self-serve Google signups.
    if (user && user.authProvider === 'google' && user.passwordHash === null) {
      return NextResponse.json(
        {
          error:
            'This account uses Google sign-in. Set a password via the web app to sign into the Android app.',
        },
        { status: 400 },
      );
    }

    // An email-provider row with a null hash (invite issued, not yet redeemed)
    // falls through to here and reads as an ordinary bad credential — no leak.
    if (!user || !user.passwordHash) {
      return genericAuthFailure(password);
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json(INVALID_CREDENTIALS, { status: INVALID_CREDENTIALS_STATUS });
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

    // IP capture (2026-07-03) — interactive APK password login. Record last
    // login IP + last-active timestamp. Best-effort: never block the sign-in on
    // a tracking write failure.
    try {
      await db.user.update({
        where: { id: user.id },
        data: { lastLoginIp: getClientIp(req), lastActiveAt: new Date() },
      });
    } catch (e) {
      console.error('[APKLogin] IP capture update failed (non-fatal):', e);
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
