/**
 * POST /api/auth/register — email/password signup, RE-OPENED for the free-tier
 * era (dispatch forge/free-signup-verification, 2026-08-28).
 *
 * HISTORY. This route was RETIRED 2026-07-06 (returned 410 `registration_gone`)
 * when signups went Google-only behind the card-first paywall. Free tier
 * (dispatch forge/free-tier-p1, 2026-08-28) makes "no subscription" the no-card
 * ENTRY POINT, so email/password signup is re-opened: a verified email/password
 * user with no subscription resolves to the SAME `free_tier` admit as a Google
 * free user (entitlement is identity-source-agnostic — see lib/entitlement-core).
 *
 * ACCOUNT IS CREATED DISABLED. The row is created `emailVerified:false` and NO
 * session/JWT/cookie is issued here. /api/auth/login and /api/auth/apk-login
 * both already reject `!emailVerified` with a 403, so the account is inert until
 * the user clicks the emailed verification LINK (/api/auth/verify-email), which
 * flips `emailVerified:true` and lands them on /auth/login?verified=1.
 *
 * MECHANISM IS REUSED, NOT REBUILT (locked decision, Ken). The verification
 * token is `signEmailToken(userId)` — a 24h HS256 JWT with `purpose:
 * 'verify-email'` — stored in `User.emailVerifyToken`, exactly as
 * /api/auth/resend-verification issues it and /api/auth/verify-email consumes
 * it. No new column, no new token type, no 6-digit code (that is P2).
 *
 * NO USER ENUMERATION. Every email-dependent outcome returns ONE generic 200
 * ("verification email sent"), and the create+send work runs fire-and-forget
 * OFF the response path (mirroring /api/auth/forgot-password) so an existing
 * address and a brand-new one are wall-clock indistinguishable. Only synchronous
 * per-IP rate-limit bookkeeping and email/password FORMAT validation (which do
 * not depend on account existence) run before the return.
 *
 * WAITLIST COHERENCE / NO LOCKOUT. Creation is gated on `isEmailAllowed(email)`
 * — the SAME switch /api/auth/login gates on. When WAITLIST_MODE is off (the
 * free-tier era) that is any structurally-valid email; when on (pre-launch) it
 * is Dennis + reviewer only. Because register and login consult the identical
 * predicate, an email register will ever create is an email login will ever
 * admit: no "verified but can never log in" dead end. When not allowed we still
 * return the generic 200 (no create, no send) so a closed-signup probe learns
 * nothing.
 *
 * DEFENCES
 *   • requireSameOrigin (CSRF) — only ever POSTed by our own /auth/register page.
 *   • Per-IP rate limit (5 / hour) — a public endpoint that creates a row and
 *     sends mail is a spam/DoS amplifier otherwise. In-process sliding window,
 *     same shape as set-password / forgot-password (single Node process — a Map
 *     is a correct store here, not a Redis stand-in).
 *   • Per-address mail-bomb resistance is structural: a second register of an
 *     existing email finds the row and sends NOTHING (re-sends go through
 *     /api/auth/resend-verification, which has its own cooldown + 24h cap).
 *   • Password policy reused verbatim from lib/passwordPolicy (MIN/MAX bytes).
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import {
  requireSameOrigin,
  isEmailAllowed,
  signEmailToken,
} from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { MIN_PASSWORD, MAX_PASSWORD_BYTES } from '@/lib/passwordPolicy';
import { sendVerificationEmail, sendNewSignupAdminEmail } from '@/lib/email';

// ── Per-IP rate limit ────────────────────────────────────────────────────────
// In-process sliding window (single Node process — server.js runs the Route
// Handlers in-process, so a Map is a correct store, mirroring set-password and
// forgot-password). getClientIp returns null when no trusted hop supplied one;
// all such requests share the 'unknown' bucket — strictly safer than exempting
// them, which would hand an attacker a free bypass by stripping a header.
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX = 5; // 5 registrations / hour / IP
const ipHits = new Map<string, number[]>();

function ipRateLimited(ip: string | null, nowMs: number = Date.now()): boolean {
  const key = ip ?? 'unknown';
  const cutoff = nowMs - IP_WINDOW_MS;
  const hits = (ipHits.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  ipHits.set(key, hits);
  if (ipHits.size > 5_000) {
    for (const [k, v] of ipHits) if (v.every((t) => t <= cutoff)) ipHits.delete(k);
  }
  return hits.length > IP_MAX;
}

// ONE body for every email-dependent outcome (created / already-exists / not
// allowed / send-failed) so the response cannot distinguish them.
const GENERIC_OK = {
  message:
    "If that email can be registered, we've sent a link to verify it. Check your inbox.",
} as const;

// Minimal structural validity — deliverability is enforced by the verify step,
// not here. Mirrors the check in isEmailAllowed so the two never disagree.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create the account + send the verification link. Runs OFF the response path
 * (never awaited by POST) so timing does not leak whether the email already
 * existed. Every branch is best-effort and swallows its own errors — a failure
 * here must never change the generic response the client already received.
 */
async function provisionAndSend(email: string, password: string, signupIp: string | null) {
  try {
    // Waitlist coherence: only create what login would later admit.
    if (!isEmailAllowed(email)) {
      console.log('[Auth] register: email not allowed (waitlist closed):', email);
      return;
    }

    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      // Non-enumerating: response was already the generic 200. Re-sends are the
      // resend-verification endpoint's job (cooldown + 24h cap live there), so
      // register never mail-bombs an existing address.
      console.log('[Auth] register: email already registered, no-op:', email);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12); // cost 12 — lockstep with every password write
    const phoneToken = crypto.randomBytes(32).toString('base64url');

    const user = await db.user.create({
      data: {
        email,
        passwordHash,
        phoneToken,
        emailVerified: false, // account is INERT until the link is clicked
        authProvider: 'email',
        signupIp,
      },
      select: { id: true, email: true, createdAt: true },
    });

    const verifyToken = signEmailToken(user.id);
    await db.user.update({
      where: { id: user.id },
      data: { emailVerifyToken: verifyToken },
    });

    try {
      await sendVerificationEmail(user.email, verifyToken);
      console.log('[Auth] register: verification email sent:', email);
    } catch (e) {
      console.error('[Auth] register: failed to send verification email:', e);
    }

    try {
      await sendNewSignupAdminEmail({
        userEmail: user.email,
        method: 'email',
        createdAt: user.createdAt ?? new Date(),
      });
    } catch (e) {
      console.error('[Auth] register: admin signup notify failed:', e);
    }
  } catch (e) {
    console.error('[Auth] register: provisionAndSend error:', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    // Per-IP rate limit BEFORE any work. IP-keyed, so a 429 reveals nothing
    // about whether any given email exists.
    if (ipRateLimited(getClientIp(req))) {
      return NextResponse.json(
        { error: 'Too many signups from this network. Try again later.' },
        { status: 429 },
      );
    }

    let body: { email?: unknown; password?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const rawEmail = body?.email;
    const password = body?.password;

    // FORMAT validation — independent of account existence, so a 400 here is not
    // an enumeration signal (it is the same answer for existing and new emails).
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim().toLowerCase())) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD} characters.` },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return NextResponse.json(
        { error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.` },
        { status: 400 },
      );
    }

    const email = rawEmail.trim().toLowerCase();
    const signupIp = getClientIp(req);

    // Fire-and-forget: do NOT await, so wall-clock time to the response does not
    // depend on whether the email existed or whether mail was sent. `void` marks
    // the intentional non-await for lint.
    void provisionAndSend(email, password, signupIp);

    return NextResponse.json(GENERIC_OK, { status: 200 });
  } catch (e) {
    console.error('[Auth] register error:', e);
    // Generic 200 rather than a 500 so an internal blip does not become a
    // timing/shape oracle. The client is told to check their inbox regardless.
    return NextResponse.json(GENERIC_OK, { status: 200 });
  }
}
