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

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const { email, password } = await req.json();

    // Auth allowlist (2026-06-15). Block non-allowed emails BEFORE bcrypt so a
    // non-allowed user learns nothing about whether the account exists, and
    // before any session work. See lib/auth.ts isEmailAllowed for the no-lockout
    // guarantee (env AUTH_ALLOWLIST with a hardcoded Dennis+reviewer fallback).
    if (!isEmailAllowed(email)) {
      return NextResponse.json(
        { error: 'Sign-ups are closed — join the waitlist at computercaller.com' },
        { status: 403 },
      );
    }

    const user = await db.user.findUnique({
      where: { email: email?.toLowerCase() },
      include: { subscription: true },
    });

    // Google-only account guard (dispatch #36, 2026-05-25).
    // If a user signed up via Google, passwordHash is NULL. Returning the
    // generic "Invalid email or password" would be misleading — they HAVE
    // an account, they just need to use the Google button. Surface a clear
    // message so they don't get stuck.
    // We deliberately respond BEFORE the bcrypt.compare so we don't leak
    // timing info on the password — but this also means we leak the
    // existence of the email + the fact that it's Google-linked. Acceptable
    // trade-off: this is a sign-in form, not a recovery flow, and the
    // alternative (silent generic 401) is a UX dead-end.
    if (user && user.passwordHash === null) {
      return NextResponse.json(
        { error: 'This account uses Google. Sign in with Google.' },
        { status: 400 },
      );
    }

    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
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
