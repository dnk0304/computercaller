import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyAccessToken } from '@/lib/auth';

// Use the public app URL for ALL redirects from this endpoint.
//
// Why: behind Coolify's Traefik reverse proxy, `req.url` resolves to the
// container's internal address (`http(s)://localhost:3000/...`) because
// that's what the Node server actually sees on the incoming socket. Using
// `new URL('/auth/login?verified=1', req.url)` therefore produces a
// redirect like `https://localhost:3000/auth/login?verified=1` which is
// broken for end users — the browser tries to load localhost and fails.
//
// `NEXT_PUBLIC_APP_URL` is the canonical external origin set in Coolify
// env vars (e.g., `https://computercaller.com`). Anchoring redirects on
// it guarantees users land on the public site regardless of whatever
// internal hostname the container happens to bind.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/auth/login?error=invalid_token', APP_URL));

  const payload = verifyAccessToken(token);
  if (!payload) return NextResponse.redirect(new URL('/auth/login?error=expired_token', APP_URL));

  // Purpose-pin (hardening 2026-08-28, forge/free-signup-verification). Enforce
  // the F-2 purpose claim: only a 'verify-email'-purpose token may verify an
  // email here. Without this pin ANY validly-signed JWT for a userId (a 30d
  // access cookie, a reset token) presented at ?token= would flip emailVerified.
  // Legacy-safe: every verify link minted since F-2 (2026-05-29) carries the
  // claim, and any pre-F-2 token expired long ago (24h TTL). `verifyAccessToken`
  // treats an absent claim as 'access', so an absent-purpose token is rejected
  // here — correct, since a real verify link always has the claim.
  if ((payload.purpose ?? 'access') !== 'verify-email') {
    return NextResponse.redirect(new URL('/auth/login?error=invalid_token', APP_URL));
  }

  // Single-use + idempotent (hardening 2026-08-28). The old code flipped
  // emailVerified purely from the signed payload, so the same 24h JWT worked
  // repeatedly and a token SUPERSEDED by a resend still verified. Now the
  // presented token must equal the one currently stored on the row, and the
  // consuming write clears it:
  //   • already verified            → friendly success redirect (this is what
  //     makes the link safe against email-scanner prefetch and double-clicks —
  //     the human's second GET is not shown an error),
  //   • token matches stored token  → verify, clear token (single use),
  //   • token stale / superseded    → invalid (a resend replaced it; the old
  //     link no longer verifies).
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { emailVerified: true, emailVerifyToken: true },
  });
  if (!user) {
    return NextResponse.redirect(new URL('/auth/login?error=invalid_token', APP_URL));
  }
  if (user.emailVerified) {
    return NextResponse.redirect(new URL('/auth/login?verified=1', APP_URL));
  }
  if (user.emailVerifyToken !== token) {
    return NextResponse.redirect(new URL('/auth/login?error=invalid_token', APP_URL));
  }

  await db.user.update({
    where: { id: payload.userId },
    data: { emailVerified: true, emailVerifyToken: null },
  });

  return NextResponse.redirect(new URL('/auth/login?verified=1', APP_URL));
}
