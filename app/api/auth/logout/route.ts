import { NextRequest, NextResponse } from 'next/server';
import {
  requireSameOrigin,
  validateSessionToken,
  authCookieClearOptions,
  idleCookieClearOptions,
  IDLE_COOKIE_NAME,
} from '@/lib/auth';
import { db } from '@/lib/db';
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

  // SECURITY-DESIGN-READ m2 (2026-09-25, Option 1 — Dennis): sign-out must
  // revoke the extension token. ext-session tokens are stateless and stamped
  // with User.sessionVersion, so clearing cookies alone left a copied token
  // live. Bumping sessionVersion here — the same revocation the credential
  // routes use (account/change-password) — kills EVERY web session and EVERY
  // ext-session token of this account, wherever sign-out was pressed. The
  // phone is untouched: its phoneToken bearer never carried `ver`.
  //
  // Identity is the cookie's signature + CURRENT sessionVersion
  // (validateSessionToken), deliberately NOT the idle check: an idle-expired
  // cookie still proves who the caller is, and this write only ever REMOVES
  // access. No valid session (absent, forged, already superseded) = no bump;
  // the cookies are still cleared and the response is still 200.
  let revokeFailed = false;
  let bumpedTo: number | null = null;
  const token = req.cookies.get('auth_token')?.value;
  const session = token ? await validateSessionToken(token) : null;
  if (session?.userId) {
    try {
      const bumped = await db.user.update({
        where: { id: session.userId },
        data: { sessionVersion: { increment: 1 } },
        select: { sessionVersion: true },
      });
      bumpedTo = bumped.sessionVersion;
    } catch (err) {
      // Loud, not silent: the caller believes every session just ended. The
      // cookies below are still cleared, so THIS device is signed out either
      // way; the non-2xx tells anything that reads it that the rest are not.
      revokeFailed = true;
      console.error('[Logout] sessionVersion bump failed — other sessions NOT revoked:', err);
    }
    if (!revokeFailed) {
      // Instant flip for open browser tabs (same as login/change-password);
      // the lazy sessionVersion check enforces it regardless.
      try {
        const supersede = (globalThis as {
          __supersedeWebSessions?: (
            userId: string,
            opts?: { sessionVersion?: number; reason?: 'superseded' | 'signed_out' },
          ) => number;
        }).__supersedeWebSessions;
        // EXT/WEB DUAL SESSION: the extension's listener hears WHY — a sign-out
        // lands it on the plain sign-in gate, not the "signed in on another
        // device" card. Web tabs keep their unchanged wire frame.
        if (typeof supersede === 'function') {
          supersede(session.userId, { sessionVersion: bumpedTo ?? undefined, reason: 'signed_out' });
        }
      } catch (err) {
        console.error('[Logout] supersedeWebSessions failed (lazy check still in force):', err);
      }
    }
  }

  const response = revokeFailed
    ? NextResponse.json(
        { error: 'Signed out on this device, but other sessions could not be revoked' },
        { status: 500 },
      )
    : NextResponse.json({ message: 'Logged out' });
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
