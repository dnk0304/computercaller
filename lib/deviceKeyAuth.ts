/**
 * lib/deviceKeyAuth.ts — B8: where a DeviceKey route's userId is allowed to
 * come from, and nowhere else.
 *
 * THE RULE. The caller's identity is taken from something the caller PROVED:
 * the session cookie, or a phone token that resolves to exactly one User row.
 * It is never read from a body, a query string or a client-set header. This is
 * the whole of B8, and it is in its own module so that "which userId does this
 * route act on?" has one answer with one implementation, instead of three
 * routes each doing their own version of it.
 *
 * A route that took `userId` from the body would look almost identical and
 * would let any authenticated user (or anyone at all) read and revoke another
 * account's keys. Putting the only source of userId here means a reviewer can
 * check that property by reading one file, and tests/devicekey-authz.test.js
 * asserts that a body-supplied userId is ignored.
 *
 * TWO CALLERS, TWO MECHANISMS:
 *
 *   - The web page and the extension hold a session cookie. That is the
 *     ordinary path, and it reuses validateSessionWithIdle exactly as every
 *     other authed route does.
 *
 *   - The PHONE has no cookie. It holds `phoneToken`, the same bearer it
 *     already presents to the relay's WebSocket (server.js validates it with
 *     the identical `findUnique({ where: { phoneToken } })` lookup). There is
 *     no precedent for it on a REST route, so this module establishes one
 *     narrowly: it is accepted ONLY as `Authorization: Bearer <phoneToken>`,
 *     ONLY by the devicekeys routes, and it resolves to a userId the same way
 *     the relay does. The phone must be able to register its own key — it is
 *     the device whose key matters most — so some path had to exist; giving it
 *     a new long-lived credential would have been worse than reusing the one it
 *     already has.
 */

import type { NextRequest } from 'next/server';
import { validateSessionWithIdle } from '@/lib/auth';
import { db } from '@/lib/db';

export type CallerIdentity =
  | { ok: true; userId: string; via: 'session' | 'phone-token' }
  | { ok: false; status: 401; error: string };

/** `Authorization: Bearer <token>` → the token, or null. */
function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the caller to a userId, or refuse.
 *
 * The session is tried FIRST so that a browser request is never resolved by a
 * stray Authorization header, and the phone token is tried only when there is
 * no valid session. Both paths end at a User row; neither consults the request
 * body.
 */
export async function resolveCaller(req: NextRequest): Promise<CallerIdentity> {
  const session = await validateSessionWithIdle(req);
  if (session.ok && session.payload?.userId) {
    return { ok: true, userId: session.payload.userId, via: 'session' };
  }

  const bearer = extractBearer(req);
  if (bearer) {
    // Bounded before it reaches the database: phoneToken is ~43 base64url
    // chars, and an unbounded string here would be an unbounded indexed lookup
    // driven by an unauthenticated caller.
    if (bearer.length <= 256 && /^[A-Za-z0-9_-]+$/.test(bearer)) {
      const user = await db.user.findUnique({
        where: { phoneToken: bearer },
        select: { id: true },
      });
      if (user) return { ok: true, userId: user.id, via: 'phone-token' };
    }
  }

  // One opaque refusal for every failure mode. Distinguishing "no session"
  // from "bad phone token" would tell an unauthenticated caller which of their
  // guesses was closer.
  return { ok: false, status: 401, error: 'Not authenticated' };
}
