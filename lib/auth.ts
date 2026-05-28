import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';

// Bundle B (2026-05-28) — H6 fix. Previously this fell back to a hardcoded
// 'dev-secret-change-in-production' if JWT_SECRET was unset, which meant a
// production deploy without the env var would silently sign tokens any
// attacker could forge. Now: throw on first sign/verify if missing or < 32 chars.
//
// Hotfix (2026-05-28): the check used to run inside an IIFE at module-load,
// but Next 16's "Collect page data" build step imports every server module
// without runtime env present (Coolify's nixpacks build only passes build-args
// + NEXT_PUBLIC_* into the build context — runtime secrets are intentionally
// excluded). Defer validation to first call so the build can statically
// analyse the module while still failing closed at runtime.
let _jwtSecretCache: string | undefined;
export function getJwtSecret(): string {
  if (_jwtSecretCache) return _jwtSecretCache;
  const v = process.env.JWT_SECRET;
  if (!v || v.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and >=32 chars. Generate with: ' +
        'node -e "console.log(crypto.randomBytes(48).toString(\'base64url\'))"',
    );
  }
  _jwtSecretCache = v;
  return v;
}

// Pin verification to HS256 — defeats the alg-confusion attack where an
// attacker crafts a token with alg=none or alg=HS256-with-the-public-key-as-secret
// and tricks jsonwebtoken into accepting it. We only ever SIGN with HS256, so
// pinning here is loss-free.
const JWT_VERIFY_OPTS = { algorithms: ['HS256' as const] };

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
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '24h' });
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTS) as JwtPayload;
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
  return jwt.sign({ userId, purpose: 'verify-email' }, getJwtSecret(), { expiresIn: '24h' });
}

export function signResetToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'reset-password' }, getJwtSecret(), { expiresIn: '1h' });
}

/**
 * Bundle B (2026-05-28) — M1 fix. SameSite=Lax on auth_token blocks most
 * cross-site form submissions, but a same-site attacker (subdomain, or any
 * page on computercaller.com) can still craft a forged POST that rides the
 * cookie. This helper layers an Origin/Referer check on top.
 *
 * Strategy:
 *   - GET/HEAD/OPTIONS: always allow (no mutation).
 *   - Other methods: require Origin == expected, OR (no Origin AND Referer
 *     starts with expected). Browsers always set Origin on cross-origin
 *     POST; some same-origin tools omit it but include Referer.
 *
 * The expected origin is computed from NODE_ENV:
 *   - production → 'https://computercaller.com' (hardcoded; the canonical
 *     deploy. If we ever multi-domain, replace with an env-driven allowlist.)
 *   - other → 'http://<host>' from the Host header (lets dev work on
 *     localhost:3000, 127.0.0.1:3000, LAN IPs, etc. without code changes).
 *
 * Returns a discriminated union so callers can log the reason without
 * exposing it to the response body. Failure reason is logged server-side
 * only — client gets a generic 403.
 *
 * IMPORTANT: not all mutating endpoints can use this. Exempted:
 *   - /api/auth/google/callback — Google redirects with its origin
 *   - /api/webhooks/whop — Whop's webhook, HMAC-protected separately
 *   - /api/auth/apk-login — called by the Android native HTTP client which
 *     does not set Origin. Auth on that endpoint is the email+password
 *     credential pair, not the browser cookie.
 */
export function requireSameOrigin(
  req: Request,
): { ok: true } | { ok: false; reason: string } {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return { ok: true };
  }
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host');
  const expected =
    process.env.NODE_ENV === 'production'
      ? 'https://computercaller.com'
      : `http://${host}`;
  if (origin && origin === expected) return { ok: true };
  // Same-origin fetches from some user agents omit Origin but always set
  // Referer. Accept Referer as a fallback when (and only when) Origin is
  // absent — never accept Referer alone if Origin is present-and-wrong.
  if (!origin && referer && referer.startsWith(expected + '/')) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `bad-origin (origin=${origin ?? 'null'}, referer=${referer ?? 'null'}, expected=${expected})`,
  };
}
