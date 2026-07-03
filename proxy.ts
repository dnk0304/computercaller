import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
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

  // Helper: build a redirect response that ALSO clears the stale auth_token
  // cookie. Without this, a kicked browser would keep its cookie, and the
  // next page load would re-trigger validateSessionToken, re-fail, re-bounce
  // in a loop that confuses the user. Clearing the cookie means the next
  // request is a clean "guest" request — no validation needed, just shows
  // the login form.
  const bounceToLogin = (nextPath?: string) => {
    const loginUrl = nextPath
      ? new URL(`/auth/login?next=${encodeURIComponent(nextPath)}`, req.url)
      : new URL('/auth/login', req.url);
    const res = NextResponse.redirect(loginUrl);
    if (token && !payload) {
      // Token existed but failed validation — actively clear it so the
      // login page sees a clean slate. maxAge 0 forces removal across
      // browsers; matching the cookie attributes from /api/auth/login
      // (path: '/') is required for the delete to actually take effect.
      res.cookies.set('auth_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      });
    }
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
