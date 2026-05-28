/**
 * Google OAuth 2.0 helpers — dispatch #36 (2026-05-25).
 *
 * Implements the Authorization Code flow against Google's OAuth endpoints
 * with no third-party SDK. Two reasons:
 *   1) Keeps the dependency footprint flat — `googleapis` pulls in ~3 MB
 *      and a transitive dep tree we don't need for one OAuth dance.
 *   2) The official `google-auth-library` is fine but still ~500 KB. The
 *      raw flow is well-specified and stable.
 *
 * Why we validate via Google's tokeninfo endpoint rather than fetching
 * Google's JWKS and verifying locally:
 *   - tokeninfo: 1 HTTP call per login, validates signature + iss + aud +
 *     exp on Google's side. Easy to reason about, no key-cache to manage.
 *   - JWKS local-verify: zero HTTP per login after the first key fetch,
 *     but requires cached key rotation, JWK-to-PEM conversion, and clock
 *     skew handling on our side.
 *   At this app's traffic level the extra round-trip is invisible. If
 *   Google logins ever become a hot path, swap to local verify.
 */

import jwt from 'jsonwebtoken';

// Bundle B (2026-05-28) — H6 fix. Same JWT_SECRET as lib/auth.ts (single
// shared HMAC key for the entire app). Mirror the fail-closed pattern so
// this module also refuses to load if the secret is missing or weak.
// Pin verification to HS256 to prevent algorithm-confusion attacks (M4).
const JWT_SECRET = (() => {
  const v = process.env.JWT_SECRET;
  if (!v || v.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and >=32 chars. Generate with: ' +
        'node -e "console.log(crypto.randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return v;
})();

const JWT_VERIFY_OPTS = { algorithms: ['HS256' as const] };

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** Shape of the state JWT we round-trip through Google's `state` param. */
export interface OAuthStatePayload {
  /** Random nonce — the same value sits in the HttpOnly cookie. */
  n: string;
  /** Optional in-app redirect after successful auth (sanitised at issue time). */
  next?: string;
  /** Purpose marker for defense-in-depth — rejects accidental reuse of other tokens. */
  purpose: 'google-oauth-state';
}

/**
 * Result of decoding Google's id_token. Field names mirror Google's claim
 * names so callers can grep for them in the OpenID Connect spec.
 */
export interface GoogleIdTokenClaims {
  /** Stable Google user ID. NEVER changes for a given Google account. */
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  /** Issuer — must be `accounts.google.com` or `https://accounts.google.com`. */
  iss: string;
  /** Audience — must equal GOOGLE_CLIENT_ID. */
  aud: string;
  /** Expiry (seconds since epoch). */
  exp: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[google] Missing required env var: ${name}`);
  return v;
}

/** GOOGLE_REDIRECT_URI is configurable so local dev (http://localhost:3000/...) and prod can both run. */
export function getRedirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI ??
    `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/google/callback`
  );
}

/**
 * Build the Google consent-screen URL.
 * Scope: openid + email + profile is the minimal viable set for sign-in.
 * `prompt=select_account` lets users switch Google accounts mid-flow.
 * `access_type=online` — we don't need refresh tokens (no ongoing API
 *   calls on the user's behalf, just identity), so we keep things lean.
 */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. Returns the raw id_token (JWT). */
export async function exchangeCodeForTokens(code: string): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`[google] token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) {
    throw new Error('[google] token response missing id_token');
  }
  return { idToken: data.id_token };
}

/**
 * Validate an id_token via Google's tokeninfo endpoint. Google verifies the
 * signature + standard claims and returns the parsed claims on success.
 * We additionally cross-check `aud` against our client ID and `iss` against
 * the documented Google issuers — defense in depth.
 */
export async function verifyIdToken(idToken: string): Promise<GoogleIdTokenClaims> {
  const res = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`[google] tokeninfo failed: ${res.status} ${text}`);
  }
  const claims = (await res.json()) as Record<string, unknown>;

  // Google returns string values for everything including `exp` and the
  // booleans. Normalise to typed shape and validate.
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const iss = typeof claims.iss === 'string' ? claims.iss : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  const emailVerifiedRaw = claims.email_verified;
  const email_verified =
    emailVerifiedRaw === true || emailVerifiedRaw === 'true';
  const expNum = typeof claims.exp === 'string' ? parseInt(claims.exp, 10) : Number(claims.exp);
  const exp = Number.isFinite(expNum) ? expNum : 0;

  const expectedAud = requireEnv('GOOGLE_CLIENT_ID');
  if (aud !== expectedAud) {
    throw new Error(`[google] id_token aud mismatch: expected ${expectedAud}, got ${aud}`);
  }
  if (!GOOGLE_ISSUERS.has(iss)) {
    throw new Error(`[google] id_token iss invalid: ${iss}`);
  }
  if (!sub || !email) {
    throw new Error('[google] id_token missing sub or email');
  }
  // tokeninfo already enforces exp on Google's side, but the response
  // includes it — re-check with a 30s skew tolerance defensively.
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp > 0 && exp + 30 < nowSec) {
    throw new Error('[google] id_token expired');
  }

  return {
    sub,
    email,
    email_verified,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
    iss,
    aud,
    exp,
  };
}

/**
 * Sanitise a `next` redirect target. Must start with a single `/` and NOT
 * a second `/` (no scheme-relative `//evil.com/x` URLs) and not contain
 * a CR/LF. Anything else falls back to `/app`.
 */
export function sanitiseNext(next: string | null | undefined): string {
  if (!next || typeof next !== 'string') return '/app';
  if (!next.startsWith('/')) return '/app';
  if (next.startsWith('//')) return '/app';
  if (/[\r\n]/.test(next)) return '/app';
  return next;
}

/** Sign a 10-minute state JWT for the OAuth round-trip. */
export function signOAuthState(payload: Omit<OAuthStatePayload, 'purpose'>): string {
  return jwt.sign({ ...payload, purpose: 'google-oauth-state' as const }, JWT_SECRET, {
    expiresIn: '10m',
  });
}

/** Verify a state JWT. Returns null on any failure — caller treats as CSRF reject. */
export function verifyOAuthState(token: string): OAuthStatePayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTS) as OAuthStatePayload;
    if (decoded.purpose !== 'google-oauth-state') return null;
    if (typeof decoded.n !== 'string' || !decoded.n) return null;
    return decoded;
  } catch {
    return null;
  }
}
