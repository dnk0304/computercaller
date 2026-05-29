/**
 * POST /api/auth/relay-ticket — mint a short-lived (30 s) signed JWT the
 * browser trades on the relay WebSocket upgrade.
 *
 * Bundle A (2026-05-28) — Phase 4 security review fix (C1 + M3 browser
 * half + M11). Before this endpoint existed, the browser opened the relay
 * WS as `wss://host/relay?token=<phoneToken>` — the same long-lived bearer
 * the Android APK uses. That meant phoneToken had to be returned to the
 * browser in /api/auth/login + /api/auth/me bodies, sat in client-side
 * caches forever, and could not be rotated without breaking the APK.
 *
 * New model: the browser asks for a fresh `relay-ticket` JWT each time it
 * opens (or re-opens) the WS. The ticket is single-purpose
 * (`purpose: 'relay-ticket'`), expires in 30 s, and is verified by
 * server.js' WS upgrade handler before the connection is admitted. The
 * relay's room key remains the user's phoneToken — server.js resolves
 * ticket → userId → phoneToken on connect so legacy `?token=<phoneToken>`
 * (v29 APK) and new `?ticket=<jwt>` (browser; future v30) land in the
 * same room.
 *
 * Why a JWT and not an opaque DB-backed ticket? Three reasons:
 *   1. No DB write on the hot path — every browser reconnect mints one.
 *   2. The relay (server.js, custom Next.js server) is the same Node
 *      process so it shares JWT_SECRET via process.env. No round-trip.
 *   3. Symmetry with the existing access-token model — same HS256, same
 *      secret, same `algorithms` pin, same `purpose`-claim discipline
 *      used by signEmailToken / signResetToken in lib/auth.ts.
 *
 * CSRF: same-origin gated via the standard requireSameOrigin helper
 * (Bundle B). A leaked auth_token cookie still buys nothing on its own —
 * a cross-origin POST is rejected before the session check runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { db } from '@/lib/db';
import {
  verifyAccessToken,
  requireSameOrigin,
  getJwtSecret,
} from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) {
      // Logged server-side only; client gets the generic 403. Same pattern
      // used by every other CSRF-protected route in this app.
      console.warn(`[RelayTicket] CSRF reject: ${csrf.reason}`);
      return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
    }

    const token = req.cookies.get('auth_token')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // F-A (2026-05-29) — distinguish "no/invalid signature" (401) from
    // "valid signature but stale sessionVersion" (409 session_superseded).
    // Previously we used validateSessionToken which collapses both into null
    // → 401, which masks the kick from the client. The browser needs to see
    // 409 explicitly so it routes to the KickedSessionGate instead of the
    // generic re-login flow (WIRE-CONTRACT.md §1 lazy path).
    const payload = verifyAccessToken(token, 'access');
    if (!payload) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    let user;
    try {
      user = await db.user.findUnique({
        where: { id: payload.userId },
        select: { sessionVersion: true },
      });
    } catch (e) {
      console.error('[RelayTicket] DB lookup failed:', e);
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const tokenVer = typeof payload.ver === 'number' ? payload.ver : 0;
    if (tokenVer !== user.sessionVersion) {
      // The cookie is signed correctly but a newer login bumped the row.
      // Surface 409 so the client can render the kicked card. Same semantics
      // the WS push uses (SESSION_SUPERSEDED + close 4001) — this is the
      // lazy/reconnect-path equivalent.
      return NextResponse.json(
        { error: 'session_superseded' },
        { status: 409 },
      );
    }

    // 30 s is short enough that a leaked URL with ?ticket= in a logs/refer-
    // header is functionally useless by the time anyone reads the log, and
    // long enough that a slow page-load → WS handshake doesn't race the
    // expiry on typical networks. The browser re-fetches on every reconnect.
    const ticket = jwt.sign(
      { userId: payload.userId, purpose: 'relay-ticket' },
      getJwtSecret(),
      { algorithm: 'HS256', expiresIn: '30s' },
    );

    return NextResponse.json({ ticket });
  } catch (e) {
    // getJwtSecret throws if JWT_SECRET is missing in prod. Surface 500
    // rather than 401 — this is server-config, not user fault.
    console.error('[RelayTicket] error:', e);
    return NextResponse.json({ error: 'Ticket mint failed' }, { status: 500 });
  }
}
