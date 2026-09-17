/**
 * GET /api/devicekeys/list — the caller's OWN device keys.
 *
 * There is no userId parameter, and that is the security property, not an
 * omission: with no input to vary, there is nothing for a caller to change in
 * order to see somebody else's rows. The id comes from resolveCaller (B8).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveCaller } from '@/lib/deviceKeyAuth';
import { listDeviceKeys } from '@/lib/deviceKeys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  // `includeRevoked=0` for a caller that only wants live keys; the default is
  // the full ledger, because the history is the point of the table.
  const includeRevoked = req.nextUrl.searchParams.get('includeRevoked') !== '0';

  try {
    const keys = await listDeviceKeys(caller.userId, { includeRevoked });
    return NextResponse.json({ keys });
  } catch (e) {
    console.error(`[DeviceKey] list failed: ${(e as Error).message}`);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
