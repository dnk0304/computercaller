import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth';

const PROTECTED = ['/app'];
const AUTH_PAGES = ['/auth/login', '/auth/register', '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get('auth_token')?.value;
  const payload = token ? verifyAccessToken(token) : null;

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
  matcher: ['/app/:path*', '/auth/:path*'],
};
