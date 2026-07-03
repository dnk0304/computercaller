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
  /**
   * F-2 (2026-05-29). Purpose-claim discipline. Access tokens (the 24h auth_token
   * cookie) are signed with `purpose: 'access'`; verify-email tokens use
   * `purpose: 'verify-email'`; reset-password uses `purpose: 'reset-password'`;
   * relay-ticket uses `purpose: 'relay-ticket'`. Verifiers can pin the purpose
   * to reject a token presented at the wrong site. Absent on tokens minted
   * before this dispatch — treated as 'access' for backward compat with live
   * 24h cookies.
   */
  purpose?: 'access' | 'verify-email' | 'reset-password' | 'relay-ticket';
}

export function signAccessToken(payload: JwtPayload): string {
  // Always stamp purpose: 'access' going forward. Backward compat: existing
  // cookies in flight have no purpose claim — verifyAccessToken treats
  // absent === 'access' so they continue to validate until they expire.
  //
  // Session TTL 24h → 30d (2026-06-09). The old 24h expiry forced a daily
  // logout: once the JWT expired, proxy.ts cleared the cookie + bounced to
  // /auth/login, and /api/templates 401'd (templates rendered as silently
  // empty) until re-login minted a fresh token. 30d removes the daily
  // friction. Kept in LOCKSTEP with the cookie maxAge (2592000s) in
  // /api/auth/login and /api/auth/google/callback. The sessionVersion kill
  // switch (validateSessionToken) still invalidates a session on the next
  // login elsewhere, so a longer TTL does NOT weaken logout/security.
  // Only the SESSION signer changed — signEmailToken ('24h') and
  // signResetToken ('1h') deliberately stay short-lived.
  return jwt.sign({ ...payload, purpose: 'access' }, getJwtSecret(), { expiresIn: '30d' });
}

/**
 * Verify the signature of an access (or other-purpose) JWT.
 *
 * @param token  the raw JWT string
 * @param purpose  if supplied, also enforce `claims.purpose === purpose`.
 *                 Absent claim is treated as `'access'` for backward compat
 *                 with cookies minted before purpose was added. Callers that
 *                 must accept any signed token (e.g. the email-verify route
 *                 which verifies a verify-email-purpose token) omit this arg
 *                 and get the pre-existing signature-only behavior.
 */
export function verifyAccessToken(
  token: string,
  purpose?: 'access',
): JwtPayload | null {
  try {
    const claims = jwt.verify(token, getJwtSecret(), JWT_VERIFY_OPTS) as JwtPayload;
    if (purpose !== undefined) {
      const claimPurpose = claims.purpose ?? 'access';
      if (claimPurpose !== purpose) return null;
    }
    return claims;
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

/**
 * Auth allowlist (2026-06-15, dispatch forge/waitlist-and-auth-allowlist).
 *
 * The app is pre-Play-Store, so the public must NOT be able to register or log
 * in. Rather than gate on the `isAdmin` DB flag (a wrong flag = Dennis locked
 * out of his own app with no fast recovery + a risky migration), we gate on an
 * env-driven email allowlist. Rollback is zero-rebuild: edit AUTH_ALLOWLIST in
 * Coolify and redeploy-free for the next request.
 *
 * NO-LOCKOUT GUARANTEE: when AUTH_ALLOWLIST is unset/empty/whitespace, we fall
 * back to a HARDCODED default that always includes Dennis + the Play reviewer.
 * A missing or fat-fingered env var can therefore never lock Dennis out, and
 * the reviewer@ account stays allowed so Google Play "App access" review keeps
 * working. Ken sets AUTH_ALLOWLIST explicitly in Coolify to the same value, but
 * the built-in default is the safety net.
 *
 * Enforced at ALL FIVE interactive auth entry points (login, register,
 * google/callback, apk-login, apk-google-login) BEFORE any user create/link/
 * session issue. The phone bearer (phoneToken) flow, /api/auth/me, relay,
 * logout are NOT gated — they are not interactive logins.
 */
const AUTH_ALLOWLIST_FALLBACK = 'dennis.kotlenko@gmail.com,reviewer@computercaller.com';

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;

  // Public-launch gate (2026-07-03, dispatch forge/reopen-public-signup).
  // When the site is OUT of waitlist mode, signups + logins are OPEN to the
  // public: any structurally-valid email is allowed. When waitlist mode is ON
  // (the pre-launch default), the allowlist below still applies BYTE-IDENTICALLY
  // to before — Dennis + reviewer only. This ties "open signups" to the SAME
  // single switch (WAITLIST_MODE=off) that already grants the 14-day trial in
  // the register/google-callback routes: one coherent, reversible switch, no new
  // env var and no wildcard string to fat-finger. Fail-safe default is UNCHANGED
  // — a missing/blank/typo'd WAITLIST_MODE keeps waitlist mode ON (see
  // isWaitlistMode), so the allowlist lockdown remains the safe default.
  if (!isWaitlistMode()) {
    // Minimal structural validity only: non-empty local part, an '@', a domain
    // with a dot, no internal whitespace. Deliberately permissive — real
    // deliverability is enforced downstream by the email-verify step, not here.
    // Guarantees we never return true for a null/blank/whitespace-only value.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
  }

  const raw = process.env.AUTH_ALLOWLIST?.trim();
  const list = (raw && raw.length > 0 ? raw : AUTH_ALLOWLIST_FALLBACK)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

/**
 * WAITLIST_MODE — payment/free-trial kill switch (2026-06-15).
 *
 * Dennis: "make sure people dont get sent to whop, we need to take away the
 * payment/free trial and re-activate it once we have things sorted with google
 * play store." This is the BACKEND half of that switch (the frontend hides the
 * Whop/"Start free trial" CTAs behind NEXT_PUBLIC_WAITLIST_MODE; Pixel owns
 * that). Both must be set in Coolify at deploy.
 *
 * When ON (the default while we are pre-Play-Store), the backend refuses to
 * PROVISION a new 14-day trial subscription on user-create. The original
 * trial-grant logic is NOT deleted — it is wrapped in `if (!isWaitlistMode())`,
 * so re-activation after Play Store approval is a single env flip
 * (WAITLIST_MODE=off) with ZERO code redeploy.
 *
 * DEFAULT-ON semantics: trial is suppressed UNLESS the env var is explicitly
 * one of the "off" tokens below. A missing/blank/typo'd var fails SAFE
 * (waitlist on, no trials granted) — we would rather a misconfig withhold a
 * trial than accidentally re-open paid signups before Play Store is sorted.
 *
 * Scope: this gates NEW checkout/trial INITIATION only. It does NOT touch:
 *   - /api/webhooks/whop  — incoming payment/membership confirmations for
 *     EXISTING paying users (HMAC-verified; keeps real subscribers working).
 *   - any returning-user login / phoneToken bearer flow.
 * Read at call-time (process.env), so flipping it in Coolify takes effect on
 * the next request without a code redeploy.
 */
export function isWaitlistMode(): boolean {
  const raw = process.env.WAITLIST_MODE?.trim().toLowerCase();
  // Explicit opt-out tokens turn the trial/payment flow back ON. Anything
  // else (including unset) keeps WAITLIST_MODE engaged = no trials granted.
  const OFF_TOKENS = new Set(['off', 'false', '0', 'no', 'disabled']);
  return !(raw !== undefined && OFF_TOKENS.has(raw));
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
      ? (process.env.NEXT_PUBLIC_APP_URL ?? 'https://computercaller.com')
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
