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
    /*
     * R-BH (Ken, 2026-09-21), option B: the top-level `userId` is the account
     * this caller PROVED it is, echoed back so the phone can learn its own
     * account id from the API it already calls. It is the identical string
     * `/api/auth/me` hands the page (`user.id`), so both sides of a pairing
     * feed the SAME value into SPEC 13.10.3's context field and their key
     * schedules agree instead of diverging in silence.
     *
     * TOP-LEVEL, deliberately, and never inside a key row: `PUBLIC_SELECT` in
     * lib/deviceKeys.ts is untouched, so which row fields are exposed does not
     * change here at all.
     *
     * LIST has to carry it, not just register: the registrar is LIST-first and
     * an ALREADY_LIVE phone issues no write whatsoever, so a phone whose row
     * already exists would otherwise never see the value.
     *
     * The source is `caller`, i.e. resolveCaller's proof, and B8 is untouched:
     * there is still no input on this route for anyone to vary.
     */
    return NextResponse.json({ keys, userId: caller.userId });
  } catch (e) {
    console.error(`[DeviceKey] list failed: ${(e as Error).message}`);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
