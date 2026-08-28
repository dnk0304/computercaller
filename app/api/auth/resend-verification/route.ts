import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { signEmailToken, requireSameOrigin } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { sendVerificationEmail } from '@/lib/email';

/**
 * POST /api/auth/resend-verification — re-send the email-verification link.
 *
 * NON-ENUMERATION. Always the same generic 200, returned immediately, whether
 * or not the email exists, is already verified, is rate-limited, or the send
 * fails. The lookup + rate-limit + send all run fire-and-forget OFF the response
 * path (mirroring /api/auth/forgot-password) so timing is flat too.
 *
 * RATE LIMITS (2026-08-28, forge/free-signup-verification — the route previously
 * carried only a "ratelimit-todo" and enforced nothing):
 *   • Per-IP: 10 / hour → 429. IP-keyed, so the 429 reveals nothing about any
 *     specific email. This is the ONLY branch that can return non-200; it is
 *     safe precisely because it does not depend on account existence.
 *   • Per-EMAIL cooldown: ≥60s between sends. Enforced SILENTLY (generic 200,
 *     no send) — a per-email 429 would leak that the address exists+unverified.
 *   • Per-EMAIL cap: max 5 sends / 24h. Also enforced silently. Anti mail-bomb
 *     for a single victim address across rotating source IPs.
 *
 * In-process sliding windows (single Node process — a Map is a correct store,
 * same shape as set-password / forgot-password, not a Redis stand-in).
 */

// ── Per-IP limiter ───────────────────────────────────────────────────────────
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX = 10; // 10 / hour / IP
const ipHits = new Map<string, number[]>();

// ── Per-email limiters ───────────────────────────────────────────────────────
const EMAIL_COOLDOWN_MS = 60 * 1000; // ≥60s between sends to one address
const EMAIL_DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_DAY_MAX = 5; // ≤5 sends / 24h to one address
const emailSends = new Map<string, number[]>(); // email → timestamps of ACTUAL sends

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

/**
 * May we send to this email right now? Enforces the 60s cooldown AND the 5/24h
 * cap against the record of ACTUAL sends. Records the send timestamp only when
 * it returns true, so a rejected attempt neither sends nor consumes budget.
 */
function emailSendAllowed(email: string, nowMs: number = Date.now()): boolean {
  const dayCutoff = nowMs - EMAIL_DAY_MS;
  const sends = (emailSends.get(email) ?? []).filter((t) => t > dayCutoff);
  const last = sends.length ? sends[sends.length - 1] : 0;
  if (nowMs - last < EMAIL_COOLDOWN_MS) return false; // cooldown not elapsed
  if (sends.length >= EMAIL_DAY_MAX) return false; // 24h cap reached
  sends.push(nowMs);
  emailSends.set(email, sends);
  if (emailSends.size > 5_000) {
    for (const [k, v] of emailSends) if (v.every((t) => t <= dayCutoff)) emailSends.delete(k);
  }
  return true;
}

const GENERIC_RESPONSE = {
  ok: true,
  message:
    'If your email is registered and not yet verified, a new verification link has been sent.',
};

async function lookupAndSend(normalized: string) {
  try {
    const user = await db.user.findUnique({ where: { email: normalized } });
    if (!user) {
      console.log('[Auth] Resend-verification requested for unknown email:', normalized);
      return;
    }
    if (user.emailVerified) {
      console.log('[Auth] Resend-verification requested for already-verified user:', normalized);
      return;
    }
    // Per-email cooldown + 24h cap. Silent skip on limit (the response is the
    // same generic 200 either way, so this cannot enumerate).
    if (!emailSendAllowed(normalized)) {
      console.log('[Auth] Resend-verification suppressed by per-email limit:', normalized);
      return;
    }

    const verifyToken = signEmailToken(user.id);
    await db.user.update({ where: { id: user.id }, data: { emailVerifyToken: verifyToken } });

    try {
      await sendVerificationEmail(user.email, verifyToken);
      console.log('[Auth] Resend-verification email sent for:', normalized);
    } catch (e) {
      console.error('[Auth] Failed to send resend verification email:', e);
    }
  } catch (e) {
    console.error('[Auth] Resend-verification lookupAndSend error:', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    // Per-IP limit BEFORE any work. The only non-200 outcome; safe because it
    // does not depend on account existence.
    if (ipRateLimited(getClientIp(req))) {
      return NextResponse.json(
        { error: 'Too many requests. Try again later.' },
        { status: 429 },
      );
    }

    const { email } = await req.json();
    if (email && typeof email === 'string') {
      const normalized = email.toLowerCase().trim();
      // Fire-and-forget: do NOT await, so response timing does not reveal which
      // branch (unknown / verified / limited / sent) was taken.
      void lookupAndSend(normalized);
    }

    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  } catch (e) {
    console.error('[Auth] Resend-verification error:', e);
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }
}
