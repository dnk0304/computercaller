/**
 * POST /api/auth/account/set-password — logged-in "add a password" for an
 * account that has none yet (dispatch forge/set-password, 2026-08-22).
 *
 * WHO THIS IS FOR. A Google-signed-in user (authProvider:'google',
 * passwordHash:null) who is ALREADY in a web session and wants to add a password
 * so the Android app (which cannot do Google-only) will let them in. Because the
 * caller already holds a valid session, NO current password is required and NO
 * emailed token is involved — the session IS the authorization. This is the
 * in-app twin of the emailed forgot-password → /auth/set-password flow.
 *
 * ONLY FOR HASH-LESS ACCOUNTS. If a passwordHash already exists this returns 409:
 * changing an existing password is a different operation with a different threat
 * model (it must verify the current password) and lives in
 * /api/auth/account/change-password. Keeping the two apart means neither has to
 * branch on "do we have a hash" mid-flight.
 *
 * ON SUCCESS
 *   • set passwordHash (bcrypt cost 12 — LOCKSTEP with login/set-password)
 *   • flip authProvider 'google' → 'both' (leave 'email' as-is; a null-hash
 *     'email' invitee shouldn't really reach here, but the guarded WHERE makes
 *     the flip a no-op for it rather than a wrong write)
 *   • bump sessionVersion — a credential change must revoke sessions that
 *     predate it — then RE-ISSUE the caller's own cookies with the new version
 *     so the user is not logged out by their own action, exactly as
 *     /api/auth/set-password does after consume.
 *
 * DEFENCES: requireSameOrigin (credential mutation), session validation
 * identical to /api/auth/me, a light per-user rate limit (it is authed but runs
 * bcrypt), and the relay supersede so any OTHER open tab for this user is kicked.
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
import { getClientIp } from '@/lib/ip';
import { MIN_PASSWORD, MAX_PASSWORD_BYTES } from '@/lib/passwordPolicy';

// Light per-user sliding window — the endpoint is authed, but each accepted
// request burns ~100ms of bcrypt, so cap the churn.
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 10;
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

function validatePassword(password: unknown): NextResponse | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD} characters` },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return NextResponse.json(
      { error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` },
      { status: 400 },
    );
  }
  return null;
}

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

    let body: { password?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const invalid = validatePassword(body?.password);
    if (invalid) return invalid;
    const password = body.password as string;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    // Hash-less only. An account that already has a password must go through
    // change-password (current-password verification), never this door.
    if (user.passwordHash !== null) {
      return NextResponse.json(
        {
          error: 'This account already has a password. Use change password instead.',
          code: 'password_already_set',
        },
        { status: 409 },
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Set hash + double-link (google→both) + bump sessionVersion in one write.
    // The guarded authProvider flip only touches a 'google' row; 'email' stays
    // 'email'. sessionVersion increment revokes every OTHER session — the
    // caller's is re-minted below so they stay signed in.
    const bumped = await db.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 },
        lastActiveAt: new Date(),
      },
      select: { sessionVersion: true },
    });
    await db.user.updateMany({
      where: { id: userId, authProvider: 'google' },
      data: { authProvider: 'both' },
    });

    // Kick any OTHER open web tab for this user right now (lazy check already
    // covers it on next request); best-effort, must not fail the write.
    try {
      const supersede = (globalThis as { __supersedeWebSessions?: (userId: string) => number })
        .__supersedeWebSessions;
      if (typeof supersede === 'function') supersede(userId);
    } catch (err) {
      console.error('[AccountSetPassword] supersedeWebSessions failed:', err);
    }

    // Re-issue the caller's OWN cookies with the new sessionVersion so this very
    // request's browser is not the session it just invalidated. Byte-identical
    // to /api/auth/login and /api/auth/set-password.
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
      `[AccountSetPassword] password added + provider double-linked for ${user.email} at ${new Date().toISOString()}`,
    );
    return response;
  } catch (e) {
    console.error('[AccountSetPassword] POST error:', e);
    return NextResponse.json({ error: 'Failed to set password' }, { status: 500 });
  }
}
