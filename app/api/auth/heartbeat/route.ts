/**
 * POST /api/auth/heartbeat — slide the web idle window forward.
 * (2026-07-27, dispatch forge/web-idle-timeout.)
 *
 * The client's IdleTimeoutGuard pings this on genuine user activity (throttled
 * to IDLE_HEARTBEAT_MIN_INTERVAL_MS, and continuously while a live call is in
 * progress). On a valid session we RE-MINT the idle_token 4h forward — that
 * re-mint is what keeps an active user logged in past the cutoff. Idempotent
 * and cheap: signature-verify + one indexed sessionVersion PK lookup (via
 * validateSessionToken), no writes.
 *
 * Enforcement lives elsewhere (proxy /app gate, relay-ticket, /api/auth/me) —
 * this endpoint ONLY slides the window; it never gates access.
 *
 * CSRF: POST → requireSameOrigin, same as every other mutating auth route.
 * A missing/expired auth_token ⇒ 401 (the client stops heartbeating and its
 * own timer / the next /me poll bounces it).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  validateSessionToken,
  requireSameOrigin,
  signIdleToken,
  idleCookieSetOptions,
  IDLE_COOKIE_NAME,
  getJwtSecret,
} from '@/lib/auth';

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) {
    console.warn(`[Heartbeat] CSRF reject: ${csrf.reason}`);
    return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }

  const token = req.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Full session validation (signature + sessionVersion). A kicked/stale
  // session gets NO fresh idle window — it must re-authenticate.
  const payload = await validateSessionToken(token);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  // Re-mint the idle cookie 4h forward — slides the sliding window.
  response.cookies.set(
    IDLE_COOKIE_NAME,
    signIdleToken(payload.userId, getJwtSecret()),
    idleCookieSetOptions(),
  );
  return response;
}
