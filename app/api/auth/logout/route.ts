import { NextRequest, NextResponse } from 'next/server';
import { requireSameOrigin } from '@/lib/auth';

export async function POST(req: NextRequest) {
  // Bundle B M1 — CSRF: a forged cross-origin POST to /api/auth/logout is
  // low-impact (user gets logged out, then logs back in), but defense in
  // depth — and it keeps the response shape consistent with the other
  // mutating endpoints.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

  const response = NextResponse.json({ message: 'Logged out' });
  response.cookies.set('auth_token', '', { maxAge: 0, path: '/' });
  return response;
}
