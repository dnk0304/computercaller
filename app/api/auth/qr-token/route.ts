/**
 * GET /api/auth/qr-token — return the authenticated user's phoneToken so the
 * browser can render a QR code that the Android APK (v29 legacy or future
 * v30) scans to authenticate against the relay.
 *
 * Bundle A (2026-05-28) — Phase 4 security review.
 *
 * Why this endpoint exists separately from /api/auth/me:
 *   - L9 fix removed phoneToken from /api/auth/me's response. /me is polled
 *     on every protected page mount and lands in any client-side cache that
 *     wraps it (SWR / React Query / window-storage); the relay bearer has
 *     no business being there.
 *   - C1 fix removed phoneToken from /api/auth/login's response for the
 *     same reason.
 *   - But the QR pairing flow LEGITIMATELY needs the phoneToken: the QR
 *     image encodes `wss://host/relay/phone?token=<phoneToken>`, and the
 *     phone scans it as its first contact with the server — it has no
 *     other channel to learn the token from.
 *
 * This endpoint is the one narrow disclosure path. It is:
 *   - GET (so it does not need CSRF on the standard model — same-site
 *     cookies + a 1-hop disclosure to the calling page is the standard
 *     safe-method posture).
 *   - Session-validated (validateSessionToken, dispatch #27 model — kicked
 *     sessions return 401 same as everything else).
 *   - Specific to its purpose — frontend code that does NOT render the QR
 *     SHOULD NOT call this endpoint. Grep for `/api/auth/qr-token` to
 *     audit call sites.
 *
 * Future deprecation:
 *   Once Bundle C ships v30 of the APK and the QR-scan flow ALSO migrates
 *   to a server-minted ticket model (the phone could hit /api/auth/qr-
 *   ticket instead of consuming a long-lived phoneToken), this endpoint
 *   can be removed. Until then, narrow disclosure beats wholesale /me leak.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateSessionToken } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const payload = await validateSessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { phoneToken: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    return NextResponse.json({ phoneToken: user.phoneToken });
  } catch (e) {
    console.error('[QrToken] error:', e);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
