/**
 * POST /api/relay/reset — "Reset lobby" over HTTP.
 *
 * Dispatch FORGE-J (2026-09-15). The WS frame path (`RESET_ROOM:{}`, server.js)
 * is the primary route and needs no round-trip. This endpoint exists for the one
 * case the frame path cannot serve: THE BROWSER SOCKET IS WEDGED. A socket stuck
 * in CONNECTING, or OPEN-but-dead behind a NAT that swallowed the FIN, accepts
 * `send()` without error and delivers nothing — so the exact failure the user is
 * reaching for Reset to fix is also the failure that stops the frame arriving.
 * A plain authenticated POST does not depend on the relay socket at all.
 *
 * AUTH — deliberately the SAME chain as POST /api/auth/relay-ticket, in the same
 * order, because this action is strictly less powerful than that one (it can
 * destroy your own session's room; a ticket can drive your phone) and MUST NOT
 * be the weaker door:
 *   1. requireSameOrigin  — CSRF. Without it any page could drop a signed-in
 *      user's phone connection on a drive-by POST. Nuisance, but a real one.
 *   2. auth_token cookie + verifyAccessToken
 *   3. sessionVersion match → 409 session_superseded (not 401) so the client
 *      routes to the kicked card rather than a re-login loop.
 *   4. idle_token freshness → 401 idle_timeout, fail-CLOSED.
 *   5. evaluateUserEntitlement → 403, fail-CLOSED.
 *
 * On (5): an unentitled user arguably ought to be allowed to clean up their own
 * wedged room — it grants no product value. It is gated anyway, because the ONE
 * SOURCE lesson from the relay-ticket route (a hand-rolled entitlement check
 * that drifted and moved the denial wall inward) is that the cost of a
 * divergent auth chain is much higher than the cost of one extra gate. An
 * unentitled user has no live relay socket to wedge in the first place.
 *
 * TRANSPORT to the relay: globalThis.__resetRelayRoom, published by server.js.
 * Same single-process handle pattern as __supersedeWebSessions — the Route
 * Handlers and the WS server are the same Node process.
 *
 * Rate limit: 1 per 5 s per user, enforced INSIDE server.js on the limiter the
 * frame path shares, so alternating transports cannot double the budget.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  verifyAccessToken,
  requireSameOrigin,
  getJwtSecret,
  isIdleTokenValid,
  IDLE_COOKIE_NAME,
} from '@/lib/auth';
import { evaluateUserEntitlement } from '@/lib/entitlement';
import type { ResetRoomResult } from '@/lib/roomReset-core';

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) {
      console.warn(`[RelayReset] CSRF reject: ${csrf.reason}`);
      return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
    }

    const token = req.cookies.get('auth_token')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

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
      console.error('[RelayReset] DB lookup failed:', e);
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const tokenVer = typeof payload.ver === 'number' ? payload.ver : 0;
    if (tokenVer !== user.sessionVersion) {
      return NextResponse.json({ error: 'session_superseded' }, { status: 409 });
    }

    const idleCookie = req.cookies.get(IDLE_COOKIE_NAME)?.value;
    if (!isIdleTokenValid(idleCookie, getJwtSecret())) {
      return NextResponse.json({ error: 'idle_timeout' }, { status: 401 });
    }

    // Same cast the relay-ticket + m2m routes use: entitlement-core.d.ts types
    // dbClient's findUnique loosely (it is normally called from plain-JS
    // server.js), and arg contravariance makes the stricter PrismaClient
    // un-assignable without it.
    const ent = await evaluateUserEntitlement(
      db as unknown as Parameters<typeof evaluateUserEntitlement>[0],
      payload.userId,
    );
    if (!ent.allowed) {
      console.warn(`[RelayReset] entitlement denied (${ent.reason}) for user ${payload.userId}`);
      return NextResponse.json({ error: 'subscription_required' }, { status: 403 });
    }

    const reset = globalThis.__resetRelayRoom;
    if (typeof reset !== 'function') {
      // Only reachable if the Route Handler is served by a process that is not
      // the custom server (e.g. `next start` instead of `node server.js`).
      // 503 rather than 500: the request was well-formed, the relay just is not
      // there — and the client's fallback (send the frame / reconnect) is the
      // right response to a 503.
      console.error('[RelayReset] __resetRelayRoom not installed — relay not running in this process');
      return NextResponse.json({ error: 'relay_unavailable' }, { status: 503 });
    }

    let result: (ResetRoomResult & { rateLimited?: boolean; retryAfterMs?: number }) | null;
    try {
      result = await reset(payload.userId);
    } catch (e) {
      console.error('[RelayReset] reset failed:', e);
      return NextResponse.json({ error: 'reset_failed' }, { status: 500 });
    }

    if (result && result.rateLimited) {
      const retryAfterMs = result.retryAfterMs ?? 5000;
      return NextResponse.json(
        { error: 'rate_limited', retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    // `null` means the user has no phoneToken at all (no APK ever linked).
    // Nothing to reset, and the postcondition the caller wants — "my room is
    // empty" — already holds. 200 with closed:0 keeps the client's happy path
    // single-branch: it reconnects either way.
    const closed = result?.closed ?? 0;
    console.log(`[RelayReset] user=${payload.userId} closed=${closed} socket(s)`);
    return NextResponse.json({ ok: true, closed });
  } catch (e) {
    console.error('[RelayReset] error:', e);
    return NextResponse.json({ error: 'reset_failed' }, { status: 500 });
  }
}
