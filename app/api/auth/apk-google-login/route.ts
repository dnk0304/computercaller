import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { verifyIdToken } from '@/lib/google';
import { sendNewSignupAdminEmail } from '@/lib/email';
import { isEmailAllowed } from '@/lib/auth';
import { getClientIp } from '@/lib/ip';

/**
 * POST /api/auth/apk-google-login — APK Google sign-in endpoint.
 *
 * Dispatch (2026-05-29). Companion to /api/auth/apk-login.
 *
 * The Android app obtains a Google ID token via Credential Manager and POSTs
 * it here. We verify the token with Google, find/link/create the matching
 * User, and return the SAME { phoneToken, deviceName } shape that
 * /api/auth/apk-login returns. The app reuses its existing post-login
 * storage path — no new parser required.
 *
 * 3-branch user lookup mirrors /api/auth/google/callback (lines 90-141):
 *   a) findUnique by googleId → returning Google user.
 *   b) else findUnique by email → link Google identity (this closes the
 *      apk-login gap where existing email/password users couldn't sign into
 *      the APK with Google — see apk-login route lines 47-60).
 *   c) else create user with passwordHash=null, fresh phoneToken, 7-day trial.
 *
 * Critical divergences from /api/auth/google/callback (intentional):
 *   • NO cookie set — the APK has no browser session model.
 *   • NO sessionVersion bump on ANY branch. The phone is a SEPARATE auth
 *     principal: signing in on the phone must not invalidate the user's
 *     active browser session. Same rule /api/auth/apk-login follows.
 *   • NO call to __supersedeWebSessions — phone sign-in does not kick web
 *     sockets.
 *   • NO auth_token JWT issued — the APK authenticates against the relay
 *     via ?token=<phoneToken>, not via JWT.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const idToken = body && typeof body === 'object' ? (body as { idToken?: unknown }).idToken : null;

    if (typeof idToken !== 'string' || idToken.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // Verify with Google. lib/google.ts enforces:
    //   • signature (via Google's tokeninfo endpoint)
    //   • iss ∈ {accounts.google.com, https://accounts.google.com}
    //   • aud == process.env.GOOGLE_CLIENT_ID (our Web client ID)
    //   • exp (with 30s skew tolerance)
    // Any failure → generic 401 (no detail leak about which check failed).
    let claims;
    try {
      claims = await verifyIdToken(idToken);
    } catch (err) {
      console.warn('[APKGoogleLogin] verifyIdToken rejected token:', err);
      return NextResponse.json({ error: 'Google sign-in failed' }, { status: 401 });
    }

    if (!claims.email_verified) {
      console.warn(`[APKGoogleLogin] Refused: email_verified=false for ${claims.email}`);
      return NextResponse.json({ error: 'Your Google email is not verified' }, { status: 403 });
    }

    const email = claims.email.toLowerCase();
    const googleId = claims.sub;

    // Auth allowlist (2026-06-15). Block non-allowed Google emails BEFORE any
    // find/link/create — critically blocking branch-c auto-create. The phoneToken
    // bearer flow is untouched. See lib/auth.ts isEmailAllowed.
    //
    // Admin-provisioned exemption (2026-08-19, forge/apk-invitee-login) — mirrors
    // /api/auth/login. A non-null User.invitedBy IS a deliberate admin allowlist
    // decision, so an invited user can also reach the app via Google. The lookup
    // is only reachable AFTER verifyIdToken has proven the caller owns this exact
    // email (aud + signature checked above), so it is not an enumeration oracle:
    // an attacker cannot forge a token for someone else's address. Auth-gate ONLY
    // — grants no entitlement.
    //
    // ANTI-ENUMERATION: a non-allowlisted, non-invited email returns the SAME
    // generic 401 'Google sign-in failed' as a token-verification failure above,
    // so the two are indistinguishable. The old distinct `403 Sign-ups are
    // closed` is gone.
    if (!isEmailAllowed(email)) {
      const vouched = await db.user.findUnique({
        where: { email },
        select: { invitedBy: true },
      });
      if (!vouched?.invitedBy) {
        console.warn(`[APKGoogleLogin] Blocked non-allowlisted email: ${email}`);
        return NextResponse.json({ error: 'Google sign-in failed' }, { status: 401 });
      }
    }

    // Branch a — exact match on Google's stable subject ID wins.
    let user = await db.user.findUnique({
      where: { googleId },
      include: { subscription: true },
    });

    if (!user) {
      // Branch b — existing account on this email (created via email/password
      // or pre-Google). Link Google identity. authProvider becomes 'both' if
      // there's a password on file, else 'google' (defensive — shouldn't
      // happen with pre-dispatch schema but new rows may have passwordHash=null).
      const byEmail = await db.user.findUnique({
        where: { email },
        include: { subscription: true },
      });

      if (byEmail) {
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
        // Branch c — brand-new user. Mirror /api/auth/google/callback exactly:
        // passwordHash=null, fresh 32-byte base64url phoneToken. Card-first
        // paywall (2026-07-06): NO subscription row on create — the user must
        // start the card-attached trial via the /subscribe Whop embed on the
        // web; the Whop webhook writes the subscription row.
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

    // Defensive: every User row should have a phoneToken. If for any reason
    // a returning/linked row doesn't (e.g. legacy data predating Bundle A's
    // schema fix), mint and persist one in place rather than 500'ing — the
    // Google identity is already verified, so the user is trusted.
    if (!user.phoneToken) {
      const minted = crypto.randomBytes(32).toString('base64url');
      console.warn(`[APKGoogleLogin] User ${user.id} had no phoneToken — minting one in place`);
      user = await db.user.update({
        where: { id: user.id },
        data: { phoneToken: minted },
        include: { subscription: true },
      });
    }

    // NOTE: no sessionVersion bump, no cookie, no supersedeWebSessions call.
    // The phone is a separate principal — see file header.

    // IP capture (2026-07-03) — interactive Google login on the APK. Update
    // lastLoginIp + lastActiveAt on every branch (a returning/b linked/c new).
    // For branch c the row was just created with signupIp; this additionally
    // records it as the last-login IP too. Best-effort — never block sign-in.
    try {
      await db.user.update({
        where: { id: user.id },
        data: { lastLoginIp: getClientIp(req), lastActiveAt: new Date() },
      });
    } catch (e) {
      console.error('[APKGoogleLogin] IP capture update failed (non-fatal):', e);
    }

    return NextResponse.json({
      phoneToken: user.phoneToken,
      deviceName: user.email,
    });
  } catch (e) {
    console.error('[APKGoogleLogin] error:', e);
    return NextResponse.json({ error: 'Sign-in failed' }, { status: 500 });
  }
}
