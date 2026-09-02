/**
 * GET /api/auth/extension/handoff — the ONE-TIME sign-in handoff for the Chrome
 * extension (2026-09-02, forge/chrome-extension-p1).
 *
 * FLOW
 * ────
 * The extension calls `chrome.identity.launchWebAuthFlow({ url: <this>, interactive })`.
 * Chrome opens this URL in an auth window that SHARES the profile's cookies:
 *   • Already signed in (valid auth_token, first-party navigation → Lax cookie IS
 *     sent) → we mint a durable `ext-session` JWT and 302 to
 *     `https://<EXT_ID>.chromiumapp.org/#ext_token=<jwt>`. Chrome intercepts that
 *     redirect and hands the fragment back to the extension, which stores the token
 *     in chrome.storage and the background SW trades it for relay-tickets.
 *   • Not signed in → 302 to /auth/login?next=<this route>. After the user logs in
 *     (which also sets the SameSite=None auth_token cookie so the /extension iframe
 *     works too) the login flow returns here and we mint.
 *
 * WHY A DEDICATED TOKEN (not just the cookie): the background service worker is not
 * same-origin page context — it cannot pass requireSameOrigin CSRF, and third-party
 * cookie deprecation makes cookie-in-fetch fragile. The `ext-session` JWT is the
 * durable, cookie-independent credential for the SW. It carries `ver`
 * (sessionVersion) so the "signed-in-elsewhere" kill switch revokes it too.
 *
 * SECURITY: the redirect target is the FIXED chromiumapp.org origin derived from our
 * PINNED extension ID — it is not caller-controlled, so this is not an open redirect.
 * The token is only ever exposed to our own extension via Chrome's launchWebAuthFlow
 * interception.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateSessionToken, signExtensionSessionToken } from '@/lib/auth';
import { CC_EXTENSION_AUTH_REDIRECT } from '@/lib/extension';

// jsonwebtoken needs the Node runtime (not Edge).
export const runtime = 'nodejs';
// Never cache an auth redirect that embeds a freshly minted token.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value;
  const payload = token ? await validateSessionToken(token) : null;

  if (!payload) {
    // Bounce to login, then come straight back here to complete the handoff.
    const loginUrl = new URL('/auth/login', req.url);
    loginUrl.searchParams.set('next', '/api/auth/extension/handoff');
    return NextResponse.redirect(loginUrl);
  }

  // Re-read sessionVersion so the minted ext-session token is stamped with the
  // CURRENT version (validateSessionToken already confirmed the cookie matches,
  // but we want the authoritative number for the `ver` claim).
  let ver = 0;
  try {
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { sessionVersion: true },
    });
    if (!user) {
      // Account vanished between the cookie check and here — fail to login.
      return NextResponse.redirect(new URL('/auth/login', req.url));
    }
    ver = user.sessionVersion;
  } catch {
    // Transient DB blip — do NOT mint a token we can't version-stamp correctly.
    return NextResponse.json({ error: 'handoff_unavailable' }, { status: 503 });
  }

  const extToken = signExtensionSessionToken(payload.userId, ver);
  const redirect = `${CC_EXTENSION_AUTH_REDIRECT}#ext_token=${encodeURIComponent(extToken)}`;
  return NextResponse.redirect(redirect);
}
