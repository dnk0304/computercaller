/**
 * GET /api/auth/google/start — kick off the Google OAuth flow.
 *
 * Dispatch #36 (2026-05-25).
 *
 * 1. Generate a random nonce, sign it into a state JWT.
 * 2. Store the nonce in an HttpOnly cookie (`g_oauth_state`).
 * 3. Send the same JWT along to Google via the `state` query param.
 * 4. On the callback, we verify the JWT signature AND require the cookie's
 *    nonce to match the JWT's nonce. That dual check defeats CSRF: an
 *    attacker who can forge a callback URL cannot also set the user's cookie.
 *
 * State carries an optional `next` redirect target so deep-links survive the
 * OAuth round-trip (e.g. user clicked "Sign in" from a paywalled page).
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { buildAuthUrl, sanitiseNext, signOAuthState } from '@/lib/google';

const STATE_COOKIE = 'g_oauth_state';
const STATE_TTL_SEC = 10 * 60; // 10 minutes — matches the JWT expiry in lib/google.ts

export async function GET(req: NextRequest) {
  // If the OAuth client isn't configured, fail loud with a 500 rather than
  // redirecting to a half-broken Google URL. Easier debug for Coolify env
  // misconfig.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.json(
      { error: 'Google OAuth not configured on this server' },
      { status: 500 }
    );
  }

  const nonce = crypto.randomBytes(32).toString('base64url');
  const next = sanitiseNext(req.nextUrl.searchParams.get('next'));

  const state = signOAuthState({ n: nonce, next });
  const authUrl = buildAuthUrl(state);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // 'lax' is required — Google's redirect is cross-site, 'strict' would drop the cookie.
    maxAge: STATE_TTL_SEC,
    path: '/api/auth/google',
  });

  return response;
}
