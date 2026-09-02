/**
 * /api/auth/set-password — redeem a single-use invite / reset token
 * (dispatch forge/admin-create-account, 2026-08-15).
 *
 * PUBLIC by necessity: the whole point is that the holder of the token has no
 * session yet. The TOKEN is the authorization — which is why it is 256 bits of
 * crypto-random entropy, stored only as a SHA-256 hash, expiring, and destroyed
 * by the very write that consumes it (see lib/passwordSetToken.ts for the full
 * model; all the token handling lives there so the forgot-password flow, when
 * it is finally built, reuses it verbatim instead of re-deriving it).
 *
 * GET  ?token=…  pre-flight for the set-password PAGE, so it can render "this
 *                link has expired" instead of a form that is guaranteed to
 *                fail. Does NOT consume the token. Returns the masked email so
 *                the page can say which account it is for without the URL
 *                having to carry an address.
 * POST { token, password }
 *                verifies + consumes + sets the password + signs the user in,
 *                exactly as /api/auth/login does (same cookies, same
 *                sessionVersion bump, same relay supersede).
 *
 * DEFENCES
 *   • Rate limited per IP (see below) — a token is unguessable, but an
 *     unlimited public endpoint that runs bcrypt is a free CPU-exhaustion DoS
 *     regardless of whether any token is ever found.
 *   • Constant-time token comparison (lib/passwordSetToken.tokensMatch).
 *   • Invalid and expired collapse to ONE generic client message so the
 *     endpoint cannot be used to probe which tokens ever existed.
 *   • requireSameOrigin on POST — this is only ever submitted by our own page,
 *     and it is a credential-setting mutation.
 *   • Single use is enforced by the DB write, not by app logic, so two
 *     simultaneous submissions of the same link cannot both succeed.
 *
 * NOT IN SCOPE (follow-up): the forgot-password REQUEST flow — the page that
 * lets a user ask for a reset link. `sendPasswordResetEmail` has existed and
 * gone unused since the beginning; issuing its token is now a two-line call to
 * `issuePasswordSetToken(userId, RESET_TTL_MS)`.
 */

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import {
  signAccessToken,
  requireSameOrigin,
  signIdleToken,
  idleCookieSetOptions,
  IDLE_COOKIE_NAME,
  getJwtSecret,
  authCookieSetOptions,
} from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { lookupPasswordSetToken, consumePasswordSetToken } from '@/lib/passwordSetToken';
import { MIN_PASSWORD, MAX_PASSWORD_BYTES } from '@/lib/passwordPolicy';

// ── Rate limit ───────────────────────────────────────────────────────────────
// In-process sliding window, same shape as lib/m2mMintAudit and /api/waitlist
// (single Node process — server.js runs the Route Handlers in-process, so a Map
// is a correct store here, not a stand-in for Redis).
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 10; // 10 attempts / 15 min / IP — generous for a typo, useless for a scan
const rlHits = new Map<string, number[]>();

// getClientIp returns null when no trusted hop supplied one. All such requests
// share the 'unknown' bucket — strictly safer than exempting them, which would
// hand an attacker a free bypass by stripping a header.
function rateLimited(ip: string | null, nowMs: number = Date.now()): boolean {
  const key = ip ?? 'unknown';
  const cutoff = nowMs - RL_WINDOW_MS;
  const hits = (rlHits.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  rlHits.set(key, hits);
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) if (v.every((t) => t <= cutoff)) rlHits.delete(k);
  }
  return hits.length > RL_MAX;
}

// bcrypt SILENTLY TRUNCATES at 72 BYTES. Accepting a longer password would mean
// a 72-byte prefix authenticates — so reject it outright rather than quietly
// weakening the credential the user thinks they chose.
//
// These now come from lib/passwordPolicy so the set-password PAGE can show the
// reader the same rules this route enforces. They were literals here; a screen
// that mirrors them by copy-paste drifts, and then the form promises one thing
// while the server enforces another. Enforcement is still, only, right here.

const INVALID_TOKEN = 'This link is invalid or has expired. Ask for a new one.';

/** Show enough of an address to confirm "yes, that's me" and no more. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

// ── GET: non-consuming pre-flight ────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    if (rateLimited(getClientIp(req))) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
    }
    const token = req.nextUrl.searchParams.get('token');
    const found = await lookupPasswordSetToken(token);
    if (!found.ok) {
      // `reason` is intentionally NOT echoed — invalid and expired look
      // identical to the caller.
      return NextResponse.json({ valid: false, error: INVALID_TOKEN }, { status: 400 });
    }
    return NextResponse.json({ valid: true, email: maskEmail(found.email) });
  } catch (e) {
    console.error('[SetPassword] GET error:', e);
    return NextResponse.json({ error: 'Failed to check link' }, { status: 500 });
  }
}

// ── POST: consume + set password + sign in ───────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    if (rateLimited(getClientIp(req))) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
    }

    let body: { token?: unknown; password?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const password = body?.password;
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

    // Validate the token BEFORE spending ~100ms of bcrypt on it, so a garbage
    // token costs an index lookup rather than a hash.
    const found = await lookupPasswordSetToken(body?.token);
    if (!found.ok) {
      return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
    }

    // Cost 12 — LOCKSTEP with every other password write in the codebase.
    const passwordHash = await bcrypt.hash(password, 12);

    // Atomic: sets the hash, destroys the token, and bumps sessionVersion in one
    // conditional write. A second submission of the same link lands here with
    // the token already gone and gets the generic 400.
    const consumed = await consumePasswordSetToken(body?.token, passwordHash);
    if (!consumed.ok) {
      return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
    }

    // Double-link the account (2026-08-22, forge/set-password). A Google-only
    // user who redeems a set-password link now has BOTH a Google identity and a
    // password, so flip authProvider 'google' → 'both' — the state the Google
    // callback and apk-google-login already produce when they link the other
    // way. Without it the apk-login guard (authProvider==='google' && no hash)
    // would keep blocking the Android app even though a hash now exists.
    //
    // A guarded follow-up updateMany, NOT part of the atomic consume: the flip
    // is idempotent and non-security-critical (the hash write is the critical
    // atomic part). The WHERE pins authProvider:'google' so an 'email' or 'both'
    // row is left untouched. A relay/DB hiccup here must not fail the redemption
    // that already succeeded, so it is best-effort logged.
    try {
      await db.user.updateMany({
        where: { id: consumed.userId, authProvider: 'google' },
        data: { authProvider: 'both' },
      });
    } catch (err) {
      console.error('[SetPassword] authProvider google→both flip failed:', err);
    }

    // Setting a password is a credential change: any session that predates it
    // must die. consumePasswordSetToken already incremented sessionVersion (the
    // lazy kick); ask the relay to close any open browser socket for this user
    // RIGHT NOW too, exactly as /api/auth/login does. Same single Node process,
    // same globalThis IPC, same try/catch — a relay hiccup must never break the
    // redemption, and the lazy check still enforces it.
    try {
      const supersede = (globalThis as { __supersedeWebSessions?: (userId: string) => number })
        .__supersedeWebSessions;
      if (typeof supersede === 'function') supersede(consumed.userId);
    } catch (err) {
      console.error('[SetPassword] supersedeWebSessions failed (lazy check still in force):', err);
    }

    // Record the login the same way /api/auth/login does, so the admin panel's
    // "last seen" is not blank for an account that has demonstrably just signed
    // in. Deliberately a separate write from the consume: the consume must stay
    // a single conditional statement to keep its race guarantee.
    await db.user.update({
      where: { id: consumed.userId },
      data: { lastLoginIp: getClientIp(req), lastActiveAt: new Date() },
    });

    const token = signAccessToken({
      userId: consumed.userId,
      email: consumed.email,
      ver: consumed.sessionVersion,
    });

    const subscription = await db.subscription.findUnique({
      where: { userId: consumed.userId },
    });

    const response = NextResponse.json({
      user: { id: consumed.userId, email: consumed.email },
      subscription,
    });

    // Cookie options byte-identical to /api/auth/login — maxAge LOCKSTEP with
    // signAccessToken's '30d'. phoneToken deliberately never travels here (it is
    // the APK relay bearer; the browser gets a ticket from /api/auth/relay-ticket).
    response.cookies.set('auth_token', token, authCookieSetOptions());
    response.cookies.set(
      IDLE_COOKIE_NAME,
      signIdleToken(consumed.userId, getJwtSecret()),
      idleCookieSetOptions(),
    );

    console.warn(
      `[SetPassword] password set + signed in for ${consumed.email} at ${new Date().toISOString()}`,
    );

    return response;
  } catch (e) {
    console.error('[SetPassword] POST error:', e);
    return NextResponse.json({ error: 'Failed to set password' }, { status: 500 });
  }
}
