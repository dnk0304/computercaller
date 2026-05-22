import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth';

const PROTECTED = ['/app'];
const AUTH_PAGES = ['/auth/login', '/auth/register', '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── Auth gate (applies in both dev and production) ──────────────────────
  //
  // Earlier this file had a dev-mode bypass that redirected `/` → `/app`
  // unconditionally, which meant you could never see the marketing landing
  // or walk the register → login → dashboard flow in local dev — every
  // page request slid you straight into the app. Removed because we
  // explicitly want to test the full A→B flow in localhost before shipping
  // to production. Behavior is now identical across environments:
  //   - Guest hits `/`           → landing renders
  //   - Logged-in hits `/`       → bounced to `/app`
  //   - Guest hits `/app/*`      → bounced to `/auth/login?next=<path>`
  //   - Logged-in hits `/auth/*` → bounced to `/app` (so the back button
  //                                doesn't dump them back into login)
  //
  // Auth check uses `verifyAccessToken` (signature check, not just cookie
  // presence) — proxy in Next 16 runs in Node, so `jsonwebtoken` works
  // here. That's the upgrade over the Edge-runtime `middleware.ts` that
  // would have done a cookie-presence-only check.
  const token = req.cookies.get('auth_token')?.value;
  const payload = token ? verifyAccessToken(token) : null;

  // Redirect root to /app for logged-in users; let guests see the landing.
  if (pathname === '/') {
    return payload
      ? NextResponse.redirect(new URL('/app', req.url))
      : NextResponse.next();
  }

  // Protect /app/* — redirect to login if not authenticated
  if (PROTECTED.some(p => pathname.startsWith(p))) {
    if (!payload) {
      return NextResponse.redirect(new URL(`/auth/login?next=${encodeURIComponent(pathname)}`, req.url));
    }
  }

  // Redirect logged-in users away from auth pages
  if (AUTH_PAGES.includes(pathname) && payload) {
    return NextResponse.redirect(new URL('/app', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/app/:path*', '/auth/:path*'],
};
