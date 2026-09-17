/**
 * POST /api/devicekeys/revoke — revoke one of the CALLER'S OWN keys.
 *
 * Body: { id }. The row is looked up by (id AND caller.userId) in a single
 * query, so a row belonging to anyone else is simply not found — there is no
 * moment at which the route holds another user's row and then decides whether
 * to allow the write.
 *
 * Another user's row returns 404, not 403, deliberately: 403 would confirm the
 * row exists and turn this endpoint into an oracle for enumerating other
 * accounts' key ids.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireSameOrigin } from '@/lib/auth';
import { resolveCaller } from '@/lib/deviceKeyAuth';
import { revokeDeviceKey } from '@/lib/deviceKeys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  if (caller.via === 'session') {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  try {
    const result = await revokeDeviceKey(caller.userId, (body as Record<string, unknown>).id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // An already-revoked key is a SUCCESS: revocation is a postcondition, and a
    // client retrying after a dropped response must not be told it failed.
    return NextResponse.json({ key: result.key, alreadyRevoked: result.alreadyRevoked });
  } catch (e) {
    console.error(`[DeviceKey] revoke failed: ${(e as Error).message}`);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
