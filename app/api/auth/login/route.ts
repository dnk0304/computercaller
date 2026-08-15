import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import {
  signAccessToken,
  requireSameOrigin,
  isEmailAllowed,
  signIdleToken,
  idleCookieSetOptions,
  IDLE_COOKIE_NAME,
  getJwtSecret,
} from '@/lib/auth';
import { getClientIp } from '@/lib/ip';

// Generic auth failure. ONE body + ONE status for every "you are not getting a
// session" outcome on this route (see the enumeration note below), so the
// response can never be used to probe which emails exist.
const INVALID_CREDENTIALS = { error: 'Invalid email or password' } as const;
const INVALID_CREDENTIALS_STATUS = 401;

// A real bcrypt hash of a random throwaway string, used ONLY to burn the same
// ~work-factor-12 CPU time on the paths where there is no stored hash to compare
// against (no such user / waitlist reject / invite not yet redeemed). Without
// it, `!user || !user.passwordHash` short-circuits and those requests return in
// ~1ms while a real account with a wrong password takes ~250ms — a timing oracle
// that reveals account existence just as loudly as a distinct status code.
const TIMING_EQUALIZER_HASH =
  '$2b$12$yDye2rho5BLIB3n.8sk/2eK0JfbOJjW8SLk9NigW05T65mI2qtDtK';

/**
 * Reject with the generic 401, having spent bcrypt time first so this path is
 * not distinguishable from a wrong-password attempt by wall clock.
 */
async function genericAuthFailure(password: unknown): Promise<NextResponse> {
  try {
    await bcrypt.compare(typeof password === 'string' ? password : '', TIMING_EQUALIZER_HASH);
  } catch {
    // A malformed input must not change the response shape or leak a 500.
  }
  return NextResponse.json(INVALID_CREDENTIALS, { status: INVALID_CREDENTIALS_STATUS });
}

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const { email, password } = await req.json();

    // Auth allowlist (2026-06-15). Block non-allowed emails BEFORE bcrypt so a
    // non-allowed user learns nothing about whether the account exists, and
    // before any session work. See lib/auth.ts isEmailAllowed for the no-lockout
    // guarantee (env AUTH_ALLOWLIST with a hardcoded Dennis+reviewer fallback).
    // Admin-provisioned exemption (2026-08-15, forge/admin-create-account).
    // WAITLIST_MODE defaults ON (fail-safe), so isEmailAllowed closes login to
    // everyone outside AUTH_ALLOWLIST. That would make the whole admin
    // "create account" feature a dead end: the invitee redeems their link, gets
    // signed in once by /api/auth/set-password, and is then locked out of every
    // subsequent login by a gate that exists to stop UNINVITED signups. An admin
    // deliberately minting the account IS the allowlist decision — recorded
    // durably on the row (User.invitedBy) and in AdminUserAudit, not inferred.
    //
    // Scope is exactly one thing: permission to attempt a login. It grants NO
    // entitlement — billing is still decided solely by the shared entitlement
    // core (subscription / free-access / admin), so this is not a bypass of the
    // paywall and not a fourth admit path.
    //
    // USER-ENUMERATION FIX (2026-08-15). The exemption above is correct, but the
    // response it used to return was not: rejecting with a distinct
    // `403 Sign-ups are closed` while a vouched account fell through to
    // `401 Invalid email or password` turned this route into an oracle. Three
    // probes, three distinguishable answers:
    //     403 → email is NOT invited (or does not exist)
    //     400 → invited, invite not yet redeemed   ← the old passwordHash guard
    //     401 → invited AND redeemed
    // That cleanly enumerates every admin-provisioned account, which is exactly
    // the set an attacker most wants: hand-picked, known-good, real users.
    //
    // Every non-admitting outcome now returns the SAME generic 401 via
    // `genericAuthFailure`, with the same bcrypt cost burned. The waitlist copy
    // moves off this route entirely — LOGIN is not where a stranger learns the
    // signup policy, /register is (and it still says so). A person who was never
    // invited has no password here anyway, so "Invalid email or password" is
    // both non-revealing AND true.
    if (!isEmailAllowed(email)) {
      const vouched =
        typeof email === 'string'
          ? await db.user.findUnique({
              where: { email: email.toLowerCase() },
              select: { invitedBy: true },
            })
          : null;
      if (!vouched?.invitedBy) {
        return genericAuthFailure(password);
      }
    }

    const user = await db.user.findUnique({
      where: { email: email?.toLowerCase() },
      include: { subscription: true },
    });

    // Google-only account guard (dispatch #36, 2026-05-25).
    // If a user signed up via Google, passwordHash is NULL. Returning the
    // generic "Invalid email or password" would be misleading — they HAVE an
    // account, they just need to use the Google button.
    //
    // NARROWED 2026-08-15. This used to fire on `passwordHash === null` ALONE,
    // which was factually wrong and a leak. Admin-provisioned invitees have
    // `authProvider: 'email'` and a null hash until they redeem their invite
    // link, so they were told "This account uses Google" — an account they have
    // never touched Google with — and that 400 doubled as the enumeration
    // signal described above. Gate on the field that actually means it:
    // authProvider === 'google'. ('both' keeps its hash, so it never lands here.)
    //
    // Residual, ACCEPTED leak: a genuine Google account is still confirmed to
    // exist. That is the deliberate dispatch #36 trade-off and it is bounded to
    // self-serve Google signups — it no longer touches admin-provisioned rows,
    // which is the set that mattered.
    if (user && user.authProvider === 'google' && user.passwordHash === null) {
      return NextResponse.json(
        { error: 'This account uses Google. Sign in with Google.' },
        { status: 400 },
      );
    }

    // An email-provider row with a null hash (invite issued, not yet redeemed)
    // now falls through to here and reads as an ordinary bad credential.
    if (!user || !user.passwordHash) {
      return genericAuthFailure(password);
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json(INVALID_CREDENTIALS, { status: INVALID_CREDENTIALS_STATUS });
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
    // Fold IP capture into the existing atomic bump — one write. lastLoginIp +
    // lastActiveAt updated on every successful interactive login (2026-07-03).
    const bumped = await db.user.update({
      where: { id: user.id },
      data: {
        sessionVersion: { increment: 1 },
        lastLoginIp: getClientIp(req),
        lastActiveAt: new Date(),
      },
      select: { sessionVersion: true },
    });

    // F-A (2026-05-29) — Option C instant flip. The sessionVersion bump above
    // is the LAZY path: it makes any already-issued cookie stale on next API
    // call. The relay separately tracks every open browser WS by userId; ask
    // it to push a SESSION_SUPERSEDED frame + close 4001 to the prior tab
    // RIGHT NOW so the kicked browser flips to the locked-out card without
    // waiting for its next /api/* call. Phone APK sockets are NOT in the
    // index and stay untouched (apk-login deliberately does not bump
    // sessionVersion, so the phone bearer remains valid through web logins).
    //
    // server.js (the custom Next.js server) and this Route Handler run in the
    // SAME Node process — globalThis is the documented single-process IPC.
    // Wrapped in try/catch so a relay hiccup never breaks login. The lazy
    // sessionVersion check still enforces the kick on the next request.
    try {
      const supersede = (globalThis as { __supersedeWebSessions?: (userId: string) => number }).__supersedeWebSessions;
      if (typeof supersede === 'function') {
        supersede(user.id);
      }
    } catch (err) {
      console.error('[Auth] supersedeWebSessions failed (lazy check still in force):', err);
    }

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      ver: bumped.sessionVersion,
    });

    // Bundle A (2026-05-28) Phase 4 fix (C1, M11): phoneToken is the WS relay
    // bearer for the Android APK and MUST NOT travel to the browser. The
    // browser now obtains a short-lived ticket via POST /api/auth/relay-ticket
    // for its own WS connection; the APK gets phoneToken via POST
    // /api/auth/apk-login (unchanged). Anything that needs to render the QR
    // pairing code calls GET /api/auth/qr-token explicitly.
    const response = NextResponse.json({
      user: { id: user.id, email: user.email },
      subscription: user.subscription,
    });

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 2592000, // 30 days — LOCKSTEP with signAccessToken expiresIn '30d' (2026-06-09)
      path: '/',
    });

    // Idle-timeout cookie (2026-07-27, forge/web-idle-timeout). The sliding 4h
    // window starts now; POST /api/auth/heartbeat re-mints it on activity. This
    // is the WEB session's idle clock only — the APK/phoneToken bearer flow
    // (apk-login) deliberately never sets it and is unaffected.
    response.cookies.set(
      IDLE_COOKIE_NAME,
      signIdleToken(user.id, getJwtSecret()),
      idleCookieSetOptions(),
    );

    return response;
  } catch (e) {
    console.error('[Auth] Login error:', e);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
