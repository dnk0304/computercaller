/**
 * POST /api/auth/relay-ticket/extension — relay-ticket mint for the Chrome
 * extension's background service worker (2026-09-02, forge/chrome-extension-p1).
 *
 * The SW holds a durable `ext-session` JWT (minted by /api/auth/extension/handoff
 * and stored in chrome.storage). It cannot use the browser mint (../route.ts) —
 * that path is gated on a same-origin CSRF check + the auth_token cookie, neither
 * of which a cross-origin extension SW can satisfy. This route authenticates the
 * caller with the ext-session Bearer token instead and mints the SAME 30 s
 * `purpose: 'relay-ticket'` JWT, so the relay (server.js) accepts it with ZERO
 * changes — it still only ever verifies relay-ticket tokens.
 *
 * KEPT (non-negotiable), mirroring the browser + m2m mints:
 *   • sessionVersion kill switch — the ext-session `ver` must still match
 *     User.sessionVersion, so "signed-in-elsewhere" revokes the extension too.
 *   • entitlement chokepoint — evaluateUserEntitlement fails CLOSED; a non-entitled
 *     user mints nothing (403), exactly like every other relay-ticket path.
 *
 * CORS: the SW fetch is cross-origin (chrome-extension:// → computercaller.com), so
 * we echo Access-Control-Allow-Origin for our PINNED extension origin only and
 * answer the preflight. No credentials are used (Bearer, not cookie).
 *
 * REVERSIBILITY: additive route only. Delete this file + the ext-session helpers to
 * fully revert; the browser mint, the relay, and entitlement are untouched.
 */

import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';
import {
  getJwtSecret,
  verifyExtensionSessionToken,
} from '@/lib/auth';
import { evaluateUserEntitlement } from '@/lib/entitlement';
import { CC_EXTENSION_ORIGIN } from '@/lib/extension';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CC_EXTENSION_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Preflight — the SW's POST carries Authorization + JSON, which triggers it. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function extractBearer(req: NextRequest): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders();

  const bearer = extractBearer(req);
  if (!bearer) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers });
  }

  const claims = verifyExtensionSessionToken(bearer);
  if (!claims) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers });
  }
  const userId = claims.userId;

  // ── sessionVersion kill switch (same as validateSessionToken) ─────────────
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers });
    }
    const tokenVer = typeof claims.ver === 'number' ? claims.ver : 0;
    if (tokenVer !== user.sessionVersion) {
      // Signed in elsewhere since the handoff → 409 so the extension re-runs the
      // handoff flow (mirrors the browser mint's 401-vs-409 discipline).
      return NextResponse.json(
        { error: 'session_superseded' },
        { status: 409, headers },
      );
    }
  } catch {
    // Fail CLOSED — a DB blip must not re-admit a possibly-kicked session.
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers });
  }

  // ── HARD entitlement chokepoint (fails CLOSED) ────────────────────────────
  const ent = await evaluateUserEntitlement(
    db as unknown as Parameters<typeof evaluateUserEntitlement>[0],
    userId,
  );
  if (!ent.allowed) {
    return NextResponse.json({ error: 'subscription_required' }, { status: 403, headers });
  }

  // ── Mint — IDENTICAL to the browser + m2m paths so the relay accepts it ────
  const ticket = jwt.sign(
    { userId, purpose: 'relay-ticket' },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: '30s' },
  );

  return NextResponse.json({ ticket }, { headers });
}
