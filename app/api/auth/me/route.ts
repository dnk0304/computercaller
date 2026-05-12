import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.json({ user: null }, { status: 401 });

  const payload = verifyAccessToken(token);
  if (!payload) return NextResponse.json({ user: null }, { status: 401 });

  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, phoneToken: true, emailVerified: true, subscription: true },
  });

  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user });
}
