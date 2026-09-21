/**
 * POST /api/devicekeys/register — register or ROTATE this caller's device key.
 *
 * Body: { deviceId, kind, publicKey, label? }. Note what is NOT in that list:
 * userId. A userId in the body is ignored entirely (B8) — see lib/deviceKeyAuth.
 *
 * Rotation semantics (N-4) live in lib/deviceKeys.registerDeviceKey: a changed
 * publicKey for an existing (userId, deviceId) revokes the old row and inserts
 * a new one in one transaction. `publicKey` is never updated in place, because
 * that would erase the evidence of the substitution.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireSameOrigin } from '@/lib/auth';
import { resolveCaller } from '@/lib/deviceKeyAuth';
import { registerDeviceKey } from '@/lib/deviceKeys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  // CSRF applies to the cookie-authenticated path only. A phone presenting a
  // bearer token is not a browser and has no ambient credential for a third
  // party to ride — requiring an Origin header it will never send would just
  // lock the phone out of registering the key that matters most.
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
  const input = body as Record<string, unknown>;

  // N-1's sibling guard: refuse while a pairing HANDSHAKE is mid-flight. The
  // browser has already sent its key set and the phone is about to compute a
  // SAS over it; a key landing between those two moments changes the set under
  // the user, so the digits they are comparing would describe a different
  // pairing than the one they are approving. ~30 s, and only during a handshake.
  //
  // Published by server.js in this same process. Absent under `next dev`
  // without the custom server, in which case there is no relay to be mid-pairing
  // with and the guard is correctly a no-op.
  const inFlight = (globalThis as {
    __relayPairingInFlight?: (userId: string) => Promise<boolean>;
  }).__relayPairingInFlight;
  if (typeof inFlight === 'function') {
    try {
      if (await inFlight(caller.userId)) {
        return NextResponse.json(
          { error: 'pairing_in_flight', code: 'pairing_in_flight' },
          { status: 409 },
        );
      }
    } catch (e) {
      // Fail OPEN — a courtesy guard must never be the reason a device cannot
      // register its key.
      console.error(`[DeviceKey] pairing-in-flight check failed: ${(e as Error).message}`);
    }
  }

  try {
    const result = await registerDeviceKey(caller.userId, {
      deviceId: String(input.deviceId ?? ''),
      kind: String(input.kind ?? ''),
      publicKey: String(input.publicKey ?? ''),
      label: input.label,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    /*
     * R-BH option B -- see the long note in ../list/route.ts. Same field, same
     * source, same reason: the phone learns its account id from the proof it
     * has already presented. Top-level; the key row shape is unchanged.
     */
    return NextResponse.json({ key: result.key, rotated: result.rotated, userId: caller.userId });
  } catch (e) {
    console.error(`[DeviceKey] register failed: ${(e as Error).message}`);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
