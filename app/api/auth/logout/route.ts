import { NextRequest, NextResponse } from 'next/server';
import {
  requireSameOrigin,
  authCookieClearOptions,
  idleCookieClearOptions,
  IDLE_COOKIE_NAME,
} from '@/lib/auth';
import { CC_EXTENSION_ORIGIN } from '@/lib/extension';

export async function POST(req: NextRequest) {
  // Bundle B M1 — CSRF: a forged cross-origin POST to /api/auth/logout is
  // low-impact (user gets logged out, then logs back in), but defense in
  // depth — and it keeps the response shape consistent with the other
  // mutating endpoints.
  //
  // 2026-09-14 (forge/ext-login-gate): the Chrome extension's account chip is
  // the ONLY sign-out affordance in the extension surface, and its POST carries
  // Origin: chrome-extension://<PINNED ID>. That ONE pinned origin is accepted
  // here in addition to same-origin. It is an exact-match against the compiled
  // constant — never a reflected/echoed Origin header — so no other extension
  // and no web page can satisfy it. Scoped deliberately to this endpoint only:
  // requireSameOrigin itself is untouched, so no other mutating route widens.
  if (req.headers.get('origin') !== CC_EXTENSION_ORIGIN) {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }

  const response = NextResponse.json({ message: 'Logged out' });
  // Clear with the SET attributes (SameSite=None; Secure in prod) — a bare
  // { maxAge: 0, path: '/' } is a Lax, non-Secure cookie write, which a browser
  // discards outright when the request is cross-site (the extension case), so
  // the session would have survived sign-out.
  response.cookies.set('auth_token', '', authCookieClearOptions());
  // Clear the idle cookie too (2026-07-27) so an explicit logout leaves no
  // stale idle token behind. Harmless if it was never set (e.g. legacy session).
  response.cookies.set(IDLE_COOKIE_NAME, '', idleCookieClearOptions());
  return response;
}
