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

  await db.user.update({
    where: { id: payload.userId },
    data: { emailVerified: true, emailVerifyToken: null },
  });

  return NextResponse.redirect(new URL('/auth/login?verified=1', APP_URL));
}
