/**
 * POST /api/auth/account/change-password — logged-in password change for an
 * account that ALREADY has a password (dispatch forge/set-password, Dennis scope
 * addition 2026-08-22).
 *
 * THE TWIN OF /api/auth/account/set-password:
 *   • hash-LESS account (Google-only)     → account/set-password  (no current
 *                                            password; the session authorizes)
 *   • account WITH a hash (email or both) → THIS route (current password
 *                                            required and verified)
 *
 * Requiring the current password is the point: a valid session alone must not be
 * enough to rotate a credential an attacker with a hijacked cookie could then
 * use to lock the real owner out. Verifying the old password re-proves the human.
 *
 * ON SUCCESS
 *   • set the new passwordHash (bcrypt cost 12 — LOCKSTEP with the rest of the
 *     codebase)
 *   • bump sessionVersion so every OTHER session dies (a credential change), then
 *     RE-ISSUE the caller's own cookies so they stay signed in
 *   • kick other open tabs via the relay supersede
 *
 * NO TIMING / ENUMERATION LEAK on the current-password check: this route is
 * session-authed, so the account is already known to exist — there is nothing to
 * enumerate. The current-password verify still uses bcrypt.compare (constant-time
 * within bcrypt) and returns ONE generic 400 for both "no hash somehow" and
 * "wrong current password".
 *
 * DEFENCES: requireSameOrigin, session validation identical to /api/auth/me,
 * light per-user rate limit (runs two bcrypt ops per accepted call).
 */

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import {
  validateSessionWithIdle,
  signAccessToken,
  requireSameOrigin,
  signIdleToken,
  idleCookieSetOptions,
  IDLE_COOKIE_NAME,
  getJwtSecret,
  authCookieSetOptions,
} from '@/lib/auth';
import { MIN_PASSWORD, MAX_PASSWORD_BYTES } from '@/lib/passwordPolicy';

const RL_WINDOW_MS = 15 * 60 * 1000;
// 5 / 15 min per user — this is an authed password-GUESSING oracle (each accepted
// call runs bcrypt.compare against the real hash), so it must be no looser than
// forgot-password's 5/15 min. Was 10; tightened per audit round 1 (Mi1).
const RL_MAX = 5;
const rlHits = new Map<string, number[]>();
function rateLimited(key: string, nowMs: number = Date.now()): boolean {
  const cutoff = nowMs - RL_WINDOW_MS;
  const hits = (rlHits.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  rlHits.set(key, hits);
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) if (v.every((t) => t <= cutoff)) rlHits.delete(k);
  }
  return hits.length > RL_MAX;
}

const INVALID_CURRENT = 'Current password is incorrect.';

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const session = await validateSessionWithIdle(req);
    if (!session.ok) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const userId = session.payload.userId;

    if (rateLimited(userId)) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
    }

    let body: { currentPassword?: unknown; newPassword?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;

    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
    }
    // Validate the NEW password against the shared policy (same rules the server
    // enforces everywhere else).
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD} characters` },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
      return NextResponse.json(
        { error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` },
        { status: 400 },
      );
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    // Hash-less accounts belong on account/set-password, not here. Still spend a
    // bcrypt.compare against a throwaway hash first so this branch is not a
    // faster wall-clock path than a real wrong-password attempt.
    if (user.passwordHash === null) {
      await bcrypt.compare(currentPassword, '$2b$12$yDye2rho5BLIB3n.8sk/2eK0JfbOJjW8SLk9NigW05T65mI2qtDtK');
      return NextResponse.json(
        {
          error: 'This account has no password yet. Set one instead.',
          code: 'no_password_set',
        },
        { status: 409 },
      );
    }

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return NextResponse.json({ error: INVALID_CURRENT }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const bumped = await db.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 },
        lastActiveAt: new Date(),
      },
      select: { sessionVersion: true },
    });

    try {
      const supersede = (globalThis as { __supersedeWebSessions?: (userId: string) => number })
        .__supersedeWebSessions;
      if (typeof supersede === 'function') supersede(userId);
    } catch (err) {
      console.error('[ChangePassword] supersedeWebSessions failed:', err);
    }

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      ver: bumped.sessionVersion,
    });
    const response = NextResponse.json({ ok: true });
    response.cookies.set('auth_token', token, authCookieSetOptions());
    response.cookies.set(
      IDLE_COOKIE_NAME,
      signIdleToken(user.id, getJwtSecret()),
      idleCookieSetOptions(),
    );

    console.warn(
      `[ChangePassword] password changed for ${user.email} at ${new Date().toISOString()}`,
    );
    return response;
  } catch (e) {
    console.error('[ChangePassword] POST error:', e);
    return NextResponse.json({ error: 'Failed to change password' }, { status: 500 });
  }
}
