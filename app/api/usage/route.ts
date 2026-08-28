import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { evaluateEntitlement, isFreeAccessEmail } from '@/lib/entitlement';

// GET /api/usage — the LIVE daily-usage contract the web app polls to render the
// free tier's "N / 20 calls today" meters (dispatch forge/free-tier-p1,
// 2026-08-28). Auth mirrors /api/entitlement: auth_token cookie →
// validateSessionToken → 401 on null. This is a Pixel-facing contract; the
// shape below is FROZEN.
//
// WHY a SEPARATE endpoint from /api/entitlement: entitlement is near-static
// (tier + caps change only on a plan flip), so Pixel fetches it once on load;
// the daily counters move on every call/message and want cheap polling. Keeping
// them apart also means the money-path /api/entitlement contract is untouched by
// this dispatch (its pinned shape test stays green). This endpoint still echoes
// `tier` so a single poll gives Pixel everything it needs for the meter row.
//
// Response (200):
// {
//   tier: 'free' | 'trial' | 'solo' | 'plus' | 'pro',
//   resetAt: number,                       // epoch-ms of next UTC midnight (reset boundary)
//   calls:    { used: number, limit: number | null },   // limit null = unlimited (every paid tier)
//   messages: { used: number, limit: number | null }
// }
//
// `used` is the count for the CURRENT UTC day (0 when no row exists yet). It is
// OUTBOUND only — the relay increments the same counters and never counts
// inbound. `limit` is null for any tier without a finite daily cap (i.e. every
// tier except `free`), which is Pixel's signal to hide the meter entirely.
//
// The daily caps come straight off the shared entitlement core (limits
// .callsPerDay / .messagesPerDay), the SAME limit set the relay meters against —
// one source, no drift.
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextUtcMidnightMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const payload = await validateSessionToken(token);
    if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: {
        isAdmin: true,
        email: true,
        subscription: {
          // planId + grandfathered required so the resolved caps match exactly
          // what the relay meters against (a Plus/Pro payer is unlimited, and a
          // grandfathered row uses its frozen limit set).
          select: {
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            planId: true,
            grandfathered: true,
          },
        },
      },
    });
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Free-access resolution — same DB-backed helper the relay + admin feed use.
    const freeAccess = await isFreeAccessEmail(db, user.email);

    const ent = evaluateEntitlement({
      isAdmin: user.isAdmin,
      email: user.email,
      freeAccess,
      subscription: user.subscription,
    });

    // A finite daily cap marks a metered tier (only `free`); anything else →
    // null (unlimited), which tells Pixel not to render a daily meter.
    const callsLimit =
      typeof ent.limits.callsPerDay === 'number' && Number.isFinite(ent.limits.callsPerDay)
        ? ent.limits.callsPerDay
        : null;
    const messagesLimit =
      typeof ent.limits.messagesPerDay === 'number' && Number.isFinite(ent.limits.messagesPerDay)
        ? ent.limits.messagesPerDay
        : null;

    const now = new Date();
    const resetAt = nextUtcMidnightMs(now);

    // Read today's counter. Absent row → 0/0. Only bother when the tier is
    // actually metered (an unlimited tier never has a counter and never needs a
    // read).
    let callsUsed = 0;
    let messagesUsed = 0;
    if (callsLimit !== null || messagesLimit !== null) {
      const row = await db.usageCounter.findUnique({
        where: { userId_dayKey: { userId: payload.userId, dayKey: utcDayKey(now) } },
        select: { calls: true, messages: true },
      });
      if (row) {
        callsUsed = row.calls;
        messagesUsed = row.messages;
      }
    }

    return NextResponse.json({
      tier: ent.tier,
      resetAt,
      calls: { used: callsUsed, limit: callsLimit },
      messages: { used: messagesUsed, limit: messagesLimit },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
