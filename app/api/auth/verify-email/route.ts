import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyAccessToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/auth/login?error=invalid_token', req.url));

  const payload = verifyAccessToken(token);
  if (!payload) return NextResponse.redirect(new URL('/auth/login?error=expired_token', req.url));

  await db.user.update({
    where: { id: payload.userId },
    data: { emailVerified: true, emailVerifyToken: null },
  });

  return NextResponse.redirect(new URL('/auth/login?verified=1', req.url));
}
