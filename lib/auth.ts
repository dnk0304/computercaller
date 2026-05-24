import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';

export interface JwtPayload {
  userId: string;
  email: string;
  /**
   * Session version (monotonic counter, dispatch #27 Block B). The /api/auth/login
   * route increments User.sessionVersion before signing, and `validateSessionToken`
   * rejects any token whose `ver` no longer matches the DB column. Effect: a
   * fresh login on Browser B invalidates every prior session for the same user.
   *
   * Optional in the type for backwards compat — JWTs minted before this dispatch
   * have no `ver` claim. `validateSessionToken` treats `undefined` as 0 so the
   * pre-existing session stays valid until the next login bumps the counter.
   */
  ver?: number;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Verify the token's signature AND check `ver` against User.sessionVersion in
 * one round-trip. Returns the payload on success, null on either signature
 * failure OR a version mismatch (single-session enforcement). Use this in any
 * code path that gates access on the cookie — proxy.ts, /api/auth/me, etc.
 *
 * Why not just verifyAccessToken: signature-only validation lets stale tokens
 * from a previous browser keep working after the user re-logs elsewhere, which
 * defeats the entire point of Option III. validateSessionToken closes that
 * door. The DB hit is one indexed PK lookup per protected request — negligible.
 *
 * Edge cases:
 *   - `ver` claim missing (pre-dispatch token): treated as 0; matches the
 *     default-0 row so old tokens stay valid until first re-login bumps to 1.
 *   - DB throw: treat as auth failure (returns null). Belt-and-braces — a
 *     transient DB blip should NOT silently re-admit a kicked session.
 *   - User row missing (deleted account): null.
 */
export async function validateSessionToken(token: string): Promise<JwtPayload | null> {
  const payload = verifyAccessToken(token);
  if (!payload) return null;
  try {
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { sessionVersion: true },
    });
    if (!user) return null;
    const tokenVer = typeof payload.ver === 'number' ? payload.ver : 0;
    if (tokenVer !== user.sessionVersion) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function signEmailToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'verify-email' }, JWT_SECRET, { expiresIn: '24h' });
}

export function signResetToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'reset-password' }, JWT_SECRET, { expiresIn: '1h' });
}
