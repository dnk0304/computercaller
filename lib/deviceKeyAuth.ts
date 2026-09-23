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
 * THREE CALLERS, THREE MECHANISMS:
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
 *
 *   - The EXTENSION SERVICE WORKER holds the `ext-session` JWT minted by
 *     /api/auth/extension/token. It has a cookie too, but presenting it is
 *     what breaks it: a cookie-resolved caller is CSRF-gated on the webapp's
 *     own Origin, and a service worker's Origin is `chrome-extension://<id>`.
 *     See the long note in resolveCaller — this arm is INC-0923's fix.
 */

import type { NextRequest } from 'next/server';
import { validateSessionWithIdle, verifyExtensionSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';

export type CallerIdentity =
  | { ok: true; userId: string; via: 'session' | 'phone-token' | 'ext-token' }
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
  /*
   * INC-0923 B-2, THE CAUSE. Before this arm existed, the extension service
   * worker could not register its device key by ANY path, and the DeviceKey
   * table therefore never held a `kind:'extension'` row for anybody. The phone
   * reads an advertised-but-unregistered key as a substitution attack
   * (E2eKeyPin.verify -> Verdict.Mismatch), latches, and declines every later
   * pairing — the whole of INC-0923.
   *
   * Both arms below failed, deterministically:
   *
   *   SESSION. The SW POSTs with `credentials:'include'` and holds
   *   host_permissions, so in production the `auth_token` cookie (SameSite=None
   *   since lib/auth.ts:370's iframe change) DOES ride along. The session
   *   resolves, `via` is 'session', and register/route.ts then runs
   *   requireSameOrigin — which sees `Origin: chrome-extension://<id>` and
   *   refuses. That Chrome sends that Origin is not an inference: it is the
   *   exact header /api/auth/extension/token requires by equality, and that
   *   route mints the token Dennis signs in with every day.
   *
   *   BEARER. The SW's only bearer is the ext-session JWT. The phone-token arm
   *   below looks it up as `User.phoneToken` — a JWT has dots, so it does not
   *   even pass the charset guard. It could never have matched.
   *
   * So the fix is to teach this module the credential the extension actually
   * holds, exactly as /api/auth/relay-ticket/extension already does: verify the
   * signature and purpose, then re-check `ver` against User.sessionVersion so
   * the same "signed-in-elsewhere" kill switch revokes it. Fails CLOSED on a DB
   * error, mirroring that route.
   *
   * ORDERED FIRST, and only on a token that VERIFIES. The doc-comment above
   * puts the session first so a *stray* Authorization header cannot decide the
   * identity; a token bearing our own HS256 signature is not stray, and it is
   * the narrower, more specific proof of the two. Nothing else changes
   * ordering: the web page sends no Authorization header at all, and the
   * phone's opaque phoneToken fails verifyExtensionSessionToken and falls
   * through to its own arm untouched.
   *
   * `via:'ext-token'` is deliberately NOT 'session', which is what makes
   * register/route.ts skip CSRF for it — correct, because a bearer is not an
   * ambient credential and cannot be ridden by a third party.
   */
  const bearerToken = extractBearer(req);
  if (bearerToken) {
    const claims = verifyExtensionSessionToken(bearerToken);
    if (claims && typeof claims.userId === 'string' && claims.userId) {
      try {
        const user = await db.user.findUnique({
          where: { id: claims.userId },
          select: { sessionVersion: true },
        });
        if (user) {
          const tokenVer = typeof claims.ver === 'number' ? claims.ver : 0;
          if (tokenVer === user.sessionVersion) {
            return { ok: true, userId: claims.userId, via: 'ext-token' };
          }
        }
        // Superseded or deleted: fall through to the other arms rather than
        // 401 outright — a stale ext token must not lock out a caller who also
        // holds a perfectly good session cookie.
      } catch {
        // Fail CLOSED for THIS arm only, same as relay-ticket/extension.
      }
    }
  }

  const session = await validateSessionWithIdle(req);
  if (session.ok && session.payload?.userId) {
    return { ok: true, userId: session.payload.userId, via: 'session' };
  }

  const bearer = bearerToken;
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
