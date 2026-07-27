/**
 * lib/idleSession.ts — the signed sliding idle-cookie primitives
 * (2026-07-27, dispatch forge/web-idle-timeout).
 *
 * WHY A SEPARATE MODULE (not lib/auth.ts): lib/auth.ts imports `@/lib/db`
 * (Prisma) at module load, so it cannot be pulled into Node's runner-less
 * type-stripping test harness (the `@/` alias + Prisma engine don't resolve
 * standalone — see tests/www-origin.test.mjs's mirror workaround). Keeping the
 * idle-cookie CRYPTO here — with only `jsonwebtoken` + the pure constants in
 * `./idleTimeout` as deps, and the JWT secret INJECTED by the caller rather
 * than read from `getJwtSecret()` — makes this module directly unit-testable
 * (tests/idle-session.test.ts) and reusable by proxy / routes without dragging
 * in the DB.
 *
 * DESIGN (Ken's recommended mechanism — signed sliding cookie, NOT a DB
 * lastActiveAt write per request):
 *   - `idle_token` is a short HS256 JWT `{ userId, purpose:'idle' }` signed
 *     with the SAME secret as auth_token, expiring IDLE_TIMEOUT_MS out.
 *   - It is minted alongside auth_token at every login path, and re-minted
 *     4h-forward by POST /api/auth/heartbeat on genuine activity — that
 *     re-mint is what "slides" the window.
 *   - Enforcement (proxy /app gate, relay-ticket, /api/auth/me) treats a
 *     missing/expired/forged idle_token as logged-out even when auth_token is
 *     still valid. Because the cookie is server-signed, the client cannot forge
 *     a later deadline; because it is stateless, enforcement costs ZERO extra
 *     DB round-trips (the sessionVersion PK lookup already in those paths is
 *     untouched).
 */

import jwt from 'jsonwebtoken';
// Explicit .ts extension: allowImportingTsExtensions (tsconfig) + bundler
// resolution accept it, and it lets this DB-free module load under Node's
// runner-less type-stripping test harness (tests/idle-session.test.ts).
import { IDLE_COOKIE_MAX_AGE_S } from './idleTimeout.ts';

const IDLE_JWT_VERIFY_OPTS = { algorithms: ['HS256' as const] };

interface IdleClaims {
  userId: string;
  purpose: 'idle';
}

/**
 * Sign a fresh idle token that expires IDLE_TIMEOUT_MS from now. `secret` is
 * injected (callers pass getJwtSecret()) so this stays DB/env-free and
 * testable.
 */
export function signIdleToken(userId: string, secret: string): string {
  return jwt.sign({ userId, purpose: 'idle' }, secret, {
    algorithm: 'HS256',
    expiresIn: IDLE_COOKIE_MAX_AGE_S, // seconds
  });
}

/**
 * Verify an idle token. Returns `{ userId }` when the signature is valid, the
 * token is unexpired, AND the purpose claim is exactly 'idle'. Returns null on
 * any failure (bad/absent signature, expiry, alg confusion, wrong purpose).
 *
 * Pins alg=HS256 to defeat the alg-confusion / alg:none family, matching
 * verifyAccessToken in lib/auth.ts.
 */
export function verifyIdleToken(
  token: string | undefined | null,
  secret: string,
): { userId: string } | null {
  if (!token) return null;
  try {
    const claims = jwt.verify(token, secret, IDLE_JWT_VERIFY_OPTS) as IdleClaims;
    if (claims.purpose !== 'idle') return null;
    if (typeof claims.userId !== 'string' || claims.userId.length === 0) return null;
    return { userId: claims.userId };
  } catch {
    return null;
  }
}

/**
 * Convenience predicate for enforcement points that only need a yes/no:
 * "is this idle cookie present, unexpired, and authentic?"
 */
export function isIdleTokenValid(
  token: string | undefined | null,
  secret: string,
): boolean {
  return verifyIdleToken(token, secret) !== null;
}
