/**
 * GET /api/auth/google/callback — complete the Google OAuth flow.
 *
 * Dispatch #36 (2026-05-25).
 *
 * Sequence:
 *   1. Reject if Google returned `error` (user denied consent, app blocked, etc).
 *   2. Verify state JWT signature AND match its nonce against the cookie.
 *      Either failing → CSRF reject, redirect to login.
 *   3. Exchange code → id_token via Google's token endpoint.
 *   4. Validate id_token via Google's tokeninfo endpoint (sig + iss + aud + exp).
 *   5. Refuse if `email_verified=false` (extremely rare for consumer Google).
 *   6. User lookup branches:
 *        a) Found by googleId          → login this user (sign JWT, redirect)
 *        b) Found by email (no googleId) → link Google to this account
 *                                          (set googleId, authProvider='both'),
 *                                          mark emailVerified=true, login.
 *        c) Not found                  → create new user
 *                                          (passwordHash=null, emailVerified=true,
 *                                          authProvider='google'), provision trial,
 *                                          login.
 *   7. Bump sessionVersion, sign auth_token JWT, set HttpOnly cookie.
 *   8. Redirect to `next` (or `/app`).
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import {
  signAccessToken,
  isEmailAllowed,
  signIdleToken,
  idleCookieSetOptions,
  IDLE_COOKIE_NAME,
  getJwtSecret,
  authCookieSetOptions,
} from '@/lib/auth';
import { getClientIp } from '@/lib/ip';
import {
  exchangeCodeForTokens,
  verifyIdToken,
  verifyOAuthState,
  sanitiseNext,
} from '@/lib/google';
import { sendNewSignupAdminEmail } from '@/lib/email';

const STATE_COOKIE = 'g_oauth_state';

// As in app/api/auth/verify-email/route.ts — Coolify+Traefik fronting means
// req.url resolves to the internal container address. Anchor every redirect
// from this endpoint on the public NEXT_PUBLIC_APP_URL.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

function loginErrorRedirect(reason: string): NextResponse {
  const url = new URL(`/auth/login?error=${encodeURIComponent(reason)}`, APP_URL);
  const res = NextResponse.redirect(url);
  // Burn the state cookie — single-use.
  res.cookies.set(STATE_COOKIE, '', { maxAge: 0, path: '/api/auth/google' });
  return res;
}

export async function GET(req: NextRequest) {
  try {
    const oauthError = req.nextUrl.searchParams.get('error');
    if (oauthError) {
      console.warn(`[GoogleCallback] OAuth error param: ${oauthError}`);
      // `access_denied` = user clicked "Cancel" on the Google consent. Not
      // an error worth scaring them about — silently bounce back to login.
      return loginErrorRedirect(oauthError === 'access_denied' ? 'google_cancelled' : 'google_error');
    }

    const code = req.nextUrl.searchParams.get('code');
    const stateParam = req.nextUrl.searchParams.get('state');
    if (!code || !stateParam) {
      return loginErrorRedirect('google_missing_params');
    }

    // Dual CSRF check: signed state JWT + cookie containing the same JWT.
    const cookieState = req.cookies.get(STATE_COOKIE)?.value;
    if (!cookieState || cookieState !== stateParam) {
      console.warn('[GoogleCallback] State cookie/param mismatch — CSRF reject');
      return loginErrorRedirect('google_state_mismatch');
    }
    const state = verifyOAuthState(stateParam);
    if (!state) {
      return loginErrorRedirect('google_state_invalid');
    }

    const { idToken } = await exchangeCodeForTokens(code);
    const claims = await verifyIdToken(idToken);

    if (!claims.email_verified) {
      console.warn(`[GoogleCallback] Refused: Google email_verified=false for ${claims.email}`);
      return loginErrorRedirect('google_email_unverified');
    }

    const email = claims.email.toLowerCase();
    const googleId = claims.sub;

    // Auth allowlist (2026-06-15). Redirect flow, so a non-allowed Google email
    // bounces to the login page with an error param — BEFORE any find/link/
    // create branch, critically blocking branch-c auto-create. See lib/auth.ts
    // isEmailAllowed (env AUTH_ALLOWLIST + hardcoded Dennis+reviewer fallback).
    if (!isEmailAllowed(email)) {
      console.warn(`[GoogleCallback] Blocked non-allowlisted email: ${email}`);
      return loginErrorRedirect('closed');
    }

    // Branch a: look up by googleId first — exact match wins regardless of email.
    let user = await db.user.findUnique({
      where: { googleId },
      include: { subscription: true },
    });

    if (!user) {
      // Branch b: existing email/password account on the same email — link.
      const byEmail = await db.user.findUnique({
        where: { email },
        include: { subscription: true },
      });

      if (byEmail) {
        // Link Google identity, normalise authProvider to 'both' (or 'google'
        // if the existing row had no password — defensive, shouldn't happen
        // with the pre-dispatch schema since passwordHash was NOT NULL, but
        // future rows might).
        const newProvider = byEmail.passwordHash ? 'both' : 'google';
        user = await db.user.update({
          where: { id: byEmail.id },
          data: {
            googleId,
            authProvider: newProvider,
            emailVerified: true,
          },
          include: { subscription: true },
        });
      } else {
        // Branch c: brand-new user. No password, and — card-first paywall
        // (2026-07-06) — NO subscription row. subscription=null → entitlement
        // rule (3) denies → proxy.ts bounces the fresh user to /subscribe
        // (Whop embed, card-attached trial). Whop webhook writes the row.
        // Bundle A (2026-05-28) — schema no longer auto-generates phoneToken
        // (was cuid() default; fix C2). Every user-create path now mints a
        // crypto-random 32-byte base64url value in app code. Same generation
        // used in /api/auth/register so the format is uniform.
        const phoneToken = crypto.randomBytes(32).toString('base64url');
        // IP capture (2026-07-03) — signup IP for the same-IP abuse flag.
        const signupIp = getClientIp(req);
        user = await db.user.create({
          data: {
            email,
            passwordHash: null,
            phoneToken,
            emailVerified: true,
            googleId,
            authProvider: 'google',
            signupIp,
          },
          include: { subscription: true },
        });

        // Admin notify — brand-new user only (Branch c). Try/catch swallows
        // any failure so the signup never breaks on notify error.
        try {
          await sendNewSignupAdminEmail({
            userEmail: user.email,
            method: 'google',
            createdAt: user.createdAt ?? new Date(),
          });
        } catch (e) {
          console.error('[Auth] admin signup notify failed:', e);
        }
      }
    }

    // Dispatch #27 model — bump sessionVersion before signing so any prior
    // token for this user (e.g. an old tab) is invalidated. Symmetric with
    // /api/auth/login.
    // Fold IP capture into the bump — one write. This is a returning/linking/
    // new interactive login on every branch (a/b/c), so lastLoginIp +
    // lastActiveAt update here regardless of branch (2026-07-03).
    const bumped = await db.user.update({
      where: { id: user.id },
      data: {
        sessionVersion: { increment: 1 },
        lastLoginIp: getClientIp(req),
        lastActiveAt: new Date(),
      },
      select: { sessionVersion: true },
    });

    // F-A (2026-05-29) — instant kick of any prior browser WS for this user.
    // See /api/auth/login for the full rationale. Phone APK sockets are NOT
    // affected (index only holds relay-ticket-authed connections).
    try {
      const supersede = (globalThis as { __supersedeWebSessions?: (userId: string) => number }).__supersedeWebSessions;
      if (typeof supersede === 'function') {
        supersede(user.id);
      }
    } catch (err) {
      console.error('[Auth] supersedeWebSessions failed (lazy check still in force):', err);
    }

    const token = signAccessToken({
      userId: user.id,
      email: user.email,
      ver: bumped.sessionVersion,
    });

    const next = sanitiseNext(state.next);
    const redirectUrl = new URL(next, APP_URL);
    const response = NextResponse.redirect(redirectUrl);

    response.cookies.set('auth_token', token, authCookieSetOptions());

    // Idle-timeout cookie (2026-07-27, forge/web-idle-timeout) — mint alongside
    // auth_token exactly as /api/auth/login does, so the Google web path starts
    // the same sliding 4h idle window. See lib/idleSession.ts.
    response.cookies.set(
      IDLE_COOKIE_NAME,
      signIdleToken(user.id, getJwtSecret()),
      idleCookieSetOptions(),
    );

    // Burn the state cookie — it's single-use.
    response.cookies.set(STATE_COOKIE, '', { maxAge: 0, path: '/api/auth/google' });

    return response;
  } catch (e) {
    console.error('[GoogleCallback] error:', e);
    return loginErrorRedirect('google_internal_error');
  }
}
