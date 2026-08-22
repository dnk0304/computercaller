/**
 * POST /api/auth/forgot-password — request a password-set/reset link
 * (dispatch forge/set-password, 2026-08-22).
 *
 * PUBLIC. Takes { email } and — if that email belongs to an eligible account —
 * mints a single-use reset token and emails the /auth/set-password link. The
 * token model lives entirely in lib/passwordSetToken (256-bit raw, SHA-256 at
 * rest, expiring, single-use enforced by the consuming DB write); this route
 * only decides WHO gets one and rate-limits the asking.
 *
 * WHY GOOGLE-ONLY ACCOUNTS ARE ELIGIBLE. This is the whole point of the
 * dispatch: a `authProvider:'google'` user has no password and therefore cannot
 * sign into the Android app. Letting them request a set-password link (which,
 * on redeem, flips them to 'both') is how they add the credential. So eligibility
 * is "the account exists AND emailVerified" — provider is deliberately NOT a
 * filter.
 *
 * NO USER ENUMERATION. The response is ALWAYS the same generic 200, returned
 * immediately and identically whether or not the email matched, whether or not a
 * mail was sent, whether or not the send failed. Neither the body nor the status
 * branches on the lookup. TIMING is also flat: the whole eligible-user branch —
 * DB lookup, token mint, and mail dispatch — is fire-and-forgotten OFF the
 * response path (see POST body), so a matched+verified account and an unknown
 * address are wall-clock indistinguishable. Only the synchronous rate-limit
 * bookkeeping runs before the return.
 *
 * DEFENCES
 *   • Rate limited per IP (5 / 15 min) — a public endpoint that writes a row and
 *     sends an email is a spam/DoS amplifier otherwise.
 *   • Rate limited per EMAIL (3 / hour) — so one victim address cannot be
 *     mail-bombed by rotating source IPs.
 *   • requireSameOrigin — this is only ever submitted by our own page.
 *   • Re-requesting revokes the prior token (the token core overwrites it) —
 *     acceptable and expected: the newest link is the one that works.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import { issuePasswordSetToken, RESET_TTL_MS } from '@/lib/passwordSetToken';
import { sendPasswordResetEmail } from '@/lib/email';

// ── Rate limits ──────────────────────────────────────────────────────────────
// In-process sliding windows, same shape as set-password/route.ts (single Node
// process — a Map is a correct store here, not a Redis stand-in).
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 5; // 5 requests / 15 min / IP
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_MAX = 3; // 3 requests / hour / email — anti mail-bomb

const ipHits = new Map<string, number[]>();
const emailHits = new Map<string, number[]>();

function slidingLimited(
  store: Map<string, number[]>,
  key: string,
  windowMs: number,
  max: number,
  nowMs: number = Date.now(),
): boolean {
  const cutoff = nowMs - windowMs;
  const hits = (store.get(key) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  store.set(key, hits);
  if (store.size > 5_000) {
    for (const [k, v] of store) if (v.every((t) => t <= cutoff)) store.delete(k);
  }
  return hits.length > max;
}

// One body + one status for every outcome that is not a hard 4xx guard, so the
// response cannot distinguish "sent" from "no such account".
const GENERIC_OK = {
  message: "If an account exists for that email, we've sent a link to set your password.",
} as const;

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const ip = getClientIp(req);
    if (slidingLimited(ipHits, ip ?? 'unknown', IP_WINDOW_MS, IP_MAX)) {
      return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
    }

    let body: { email?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawEmail = body?.email;
    // Structural sanity only. An invalid/absent email is NOT an error the caller
    // gets to distinguish from a valid-but-unknown one — collapse it into the
    // same generic 200 so the shape never reveals whether the input parsed.
    const email =
      typeof rawEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail.trim())
        ? rawEmail.trim().toLowerCase()
        : null;

    if (email && !slidingLimited(emailHits, email, EMAIL_WINDOW_MS, EMAIL_MAX)) {
      // TIMING: the entire eligible-user branch — DB lookup, token mint, and mail
      // dispatch — is fire-and-forgotten OFF the response path. If any of it were
      // awaited here, a matched+verified email would answer measurably slower than
      // an unknown one, and that wall-clock gap is itself an enumeration oracle.
      // Detaching it makes the response time independent of whether the account
      // exists. Safe here because server.js is a long-lived Node process (not
      // serverless) — the detached promise runs to completion after we respond.
      void (async () => {
        try {
          // Eligible = exists AND emailVerified. Google-only accounts included on
          // purpose (see header).
          const user = await db.user.findUnique({
            where: { email },
            select: { id: true, emailVerified: true },
          });
          if (user && user.emailVerified) {
            const { rawToken } = await issuePasswordSetToken(user.id, RESET_TTL_MS);
            await sendPasswordResetEmail(email, rawToken);
          }
        } catch (err) {
          // A lookup/mint/mail failure must NOT surface anywhere the caller can
          // observe — logging server-side is the only signal we allow ourselves.
          console.error('[ForgotPassword] async lookup/issue/send failed:', err);
        }
      })().catch((err) => console.error('[ForgotPassword] async send failed', err));
    }

    // Always the same answer, returned immediately and identically on every path
    // (unknown / unverified / eligible) — the send happens after this returns.
    return NextResponse.json(GENERIC_OK);
  } catch (e) {
    console.error('[ForgotPassword] POST error:', e);
    // Even the catch-all returns the generic 200: a thrown error before the
    // response must not become an oracle. The failure is logged; the caller
    // sees the same "check your email" as everyone else.
    return NextResponse.json(GENERIC_OK);
  }
}
