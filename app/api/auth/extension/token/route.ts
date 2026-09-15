/**
 * POST /api/auth/extension/token — mint the durable ext-session token for the
 * Chrome extension's background service worker FROM THE COOKIE, with no auth
 * window (2026-09-15, dispatch forge/ext-embedded-login, Ken decision D3).
 *
 * WHY THIS EXISTS (and why the handoff route was not enough)
 * GET /api/auth/extension/handoff is a *redirect* flow: it only ever returns
 * its token through chrome.identity.launchWebAuthFlow, i.e. through a window.
 * When the profile has no session yet, Chrome must SHOW that window, the
 * toolbar popup loses focus, and Chrome destroys the popup document along with
 * whatever was awaiting the flow — the token was never stored. That is the bug
 * behind "sign-in only works if I already logged in on the web app".
 *
 * With the embedded login (/extension/login framed inside the popup) the cookie
 * already exists by the time we need a token, so the token exchange no longer
 * needs a window at all: the service worker POSTs here with
 * `credentials: 'include'` (an MV3 host_permissions privileged fetch) and gets
 * the same JWT the handoff route would have minted. The handoff route is
 * KEPT — the Google path still goes through it, because Google's consent screen
 * genuinely does need a window.
 *
 * AUTH: the auth_token cookie via validateSessionWithIdle — the same idle-aware
 * gate the rest of the app uses, so a 4h-idle session cannot be laundered into
 * a fresh 30-day extension token here.
 *
 * CSRF: this is a mutating POST that mints a credential, so the ONE pinned
 * extension origin is required by EXACT MATCH against the compiled
 * CC_EXTENSION_ORIGIN constant — never a reflected Origin header, never a
 * prefix test, never a wildcard. Same per-endpoint pattern as /api/auth/logout;
 * requireSameOrigin itself is untouched and no other route widens. A web page
 * (same-origin included) gets 403: nothing on computercaller.com has any reason
 * to mint an extension token, and refusing same-origin here means an XSS on the
 * app cannot exfiltrate a cookie-independent 30-day credential.
 *
 * The response body is the token itself, so it is uncacheable by construction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateSessionWithIdle, signExtensionSessionToken } from '@/lib/auth';
import { CC_EXTENSION_ORIGIN } from '@/lib/extension';

// jsonwebtoken needs the Node runtime (not Edge).
export const runtime = 'nodejs';
// Never cache a response that embeds a freshly minted credential.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (req.headers.get('origin') !== CC_EXTENSION_ORIGIN) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  const session = await validateSessionWithIdle(req);
  if (!session.ok || !session.payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Re-read sessionVersion so the minted ext-session token is stamped with the
  // CURRENT version — identical to the handoff route. The `ver` claim is what
  // makes the "signed-in-elsewhere" kill switch revoke this token too.
  let ver = 0;
  try {
    const user = await db.user.findUnique({
      where: { id: session.payload.userId },
      select: { sessionVersion: true },
    });
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    ver = user.sessionVersion;
  } catch {
    // Transient DB blip — do NOT mint a token we can't version-stamp correctly.
    return NextResponse.json({ error: 'token_unavailable' }, { status: 503 });
  }

  const extToken = signExtensionSessionToken(session.payload.userId, ver);
  return NextResponse.json(
    { ext_token: extToken },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
