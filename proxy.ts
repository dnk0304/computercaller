import { NextRequest, NextResponse } from 'next/server';
import {
  validateSessionToken,
  isIdleTokenValid,
  getJwtSecret,
  IDLE_COOKIE_NAME,
} from '@/lib/auth';
import { IDLE_LOGOUT_REASON } from '@/lib/idleTimeout';
import { db } from '@/lib/db';
import { evaluateEntitlement } from '@/lib/entitlement';

const PROTECTED = ['/app'];
const AUTH_PAGES = ['/auth/login', '/auth/register', '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'];

export async function proxy(req: NextRequest) {
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
  // Auth check uses `validateSessionToken` (signature check + DB
  // sessionVersion lookup, dispatch #27 Block B). proxy in Next 16 runs in
  // Node, so `jsonwebtoken` and the Prisma client both work here. A token
  // whose `ver` no longer matches the DB column (because the user re-logged
  // elsewhere) returns null and the request is bounced just like a missing
  // cookie. Dispatch #27 Q2 default = silent bounce (no toast / no banner
  // telling the abuser what we detected).
  const token = req.cookies.get('auth_token')?.value;
  const payload = token ? await validateSessionToken(token) : null;

  // Idle window enforcement (2026-07-27, forge/web-idle-timeout). Only relevant
  // once the session itself is valid — a stale/absent auth_token is handled by
  // the plain `payload` path below. `idleValid` is a pure signature+expiry
  // check on the second signed cookie (zero DB cost). When the session is valid
  // but the idle cookie is missing/expired/forged, we treat it as logged-out
  // and bounce with reason=idle. Scoped to the /app gate below — `/` and the
  // auth pages continue to key off `payload` alone (login-state, not activity).
  const idleValid = payload
    ? isIdleTokenValid(req.cookies.get(IDLE_COOKIE_NAME)?.value, getJwtSecret())
    : false;

  // Helper: build a redirect response that ALSO clears the stale cookies.
  // Without this, a kicked/idle browser would keep its cookie, and the next
  // page load would re-trigger validation, re-fail, re-bounce in a loop that
  // confuses the user. Clearing means the next request is a clean "guest"
  // request — no validation needed, just shows the login form.
  //
  // `reason` (e.g. 'idle') is surfaced on the login page as a quiet line.
  // When set, we clear auth_token even though the session was signature-valid
  // (idle-expiry logout), AND always clear the idle cookie so the two travel
  // together.
  const clearCookieOpts = {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 0,
    path: '/' as const,
  };
  const bounceToLogin = (nextPath?: string, reason?: string) => {
    const params = new URLSearchParams();
    if (nextPath) params.set('next', nextPath);
    if (reason) params.set('reason', reason);
    const qs = params.toString();
    const loginUrl = new URL(`/auth/login${qs ? `?${qs}` : ''}`, req.url);
    const res = NextResponse.redirect(loginUrl);
    // Clear auth_token when it failed validation OR on an idle-expiry logout
    // (where the token itself was still signature-valid).
    if ((token && !payload) || reason === IDLE_LOGOUT_REASON) {
      res.cookies.set('auth_token', '', clearCookieOpts);
    }
    // Always clear the idle cookie on any bounce — harmless if absent.
    res.cookies.set(IDLE_COOKIE_NAME, '', clearCookieOpts);
    return res;
  };

  // Redirect root to /app for logged-in users; let guests see the landing.
  if (pathname === '/') {
    if (payload) return NextResponse.redirect(new URL('/app', req.url));
    // Stale-cookie case at root: clear the cookie so the landing renders
    // cleanly without a fake "logged in" state in the header.
    if (token && !payload) {
      const res = NextResponse.next();
      res.cookies.set('auth_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      });
      return res;
    }
    return NextResponse.next();
  }

  // Protect /app/* — redirect to login if not authenticated (or if session
  // was invalidated by a fresh login elsewhere — silent bounce per Q2).
  if (PROTECTED.some(p => pathname.startsWith(p))) {
    if (!payload) {
      return bounceToLogin(pathname);
    }

    // Idle-timeout gate (2026-07-27). Session is authenticated but the sliding
    // idle cookie has lapsed (>4h since last activity, or the cookie was never
    // minted / was tampered). Clear BOTH cookies and bounce with reason=idle so
    // the login page shows the quiet "logged out after inactivity" line. This
    // is the SERVER-AUTHORITATIVE half — even if the client timer is buggy or
    // the tab was OS-throttled, a stale session cannot re-enter /app here.
    if (!idleValid) {
      return bounceToLogin(pathname, IDLE_LOGOUT_REASON);
    }

    // ── Trial / subscription entitlement gate (2026-07-03) ─────────────────
    //
    // The session is valid (authenticated). Now check the user is ENTITLED to
    // the paid product. One extra indexed PK lookup for isAdmin + email +
    // subscription, fed to the shared pure evaluateEntitlement. If not allowed,
    // redirect to the /subscribe lock screen. We do NOT clear the cookie — the
    // user stays logged in, they just can't reach /app until they pay (or their
    // trial is still live). /subscribe is NOT in this proxy's matcher, so the
    // redirect can't loop.
    //
    // NO-LOCKOUT: /app/admin and every Dennis request pass because
    // evaluateEntitlement rule (1) isAdmin short-circuits to allowed=true, and
    // rule (2) covers ENTITLEMENT_ALLOWLIST emails.
    //
    // FAIL-OPEN by design: this proxy redirect is the UX layer, not the money
    // chokepoint. If the DB lookup throws (transient blip), we let the request
    // through rather than risk bouncing a legitimate paying user — including
    // Dennis, whose isAdmin flag we could not read during the outage. The HARD
    // enforcement lives in /api/auth/relay-ticket (fail-CLOSED): an unentitled
    // user who slips past this redirect during a blip still cannot mint a relay
    // ticket, so they cannot actually drive the phone. See relay-ticket route.
    try {
      const user = await db.user.findUnique({
        where: { id: payload.userId },
        select: {
          isAdmin: true,
          email: true,
          subscription: {
            select: { status: true, trialEndsAt: true, currentPeriodEnd: true },
          },
        },
      });
      if (user) {
        const ent = evaluateEntitlement({
          isAdmin: user.isAdmin,
          email: user.email,
          subscription: user.subscription,
        });
        if (!ent.allowed) {
          return NextResponse.redirect(new URL('/subscribe', req.url));
        }
      }
      // user === null shouldn't happen (validateSessionToken already confirmed
      // the row exists) — fail OPEN and let the request through if it does.
    } catch (err) {
      console.error('[proxy] entitlement lookup failed — failing open:', err);
      // Fall through to NextResponse.next() below. relay-ticket still gates.
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
