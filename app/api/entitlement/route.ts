import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { evaluateEntitlement, isFreeAccessEmail } from '@/lib/entitlement';

// GET /api/entitlement — the canonical tier + limits + usage contract the web
// app consumes (dispatch feature/tier-gating, 2026-07-27). Auth mirrors
// app/api/auth/me: read the auth_token cookie → validateSessionToken → 401 on
// null. This is the ONE endpoint Pixel's useEntitlement() hook builds against;
// the shape below is FROZEN.
//
// Response (200) — shape extended 2026-08-17 (dispatch forge/pricing-trial-limited):
// {
//   tier: 'free' | 'trial' | 'solo' | 'plus' | 'pro',
//   state: 'active' | 'trialing' | 'trial_expired' | 'expired' | 'free_tier' | 'none' | 'admin' | 'allowlisted' | 'free_access',
//   allowed: boolean,   // NOTE: 'free_tier' is ALLOWED — a no-subscription user
//                       // now lands in the FULL app (free tier), not /subscribe.
//                       // Daily call/message usage is served by GET /api/usage.
//   trialDaysLeft: number | null,
//   grandfathered: boolean,           // ADDED — true = pre-launch row, frozen caps
//   limits: { templates, quickReplies, syncRangeMax, contactSync },
//   upgrade: { reason, cta, targetTier },  // ADDED — Pixel's prompt signal
//   usage:  { templates, quickReplies }
// }
//
// tier/limits/upgrade come straight off the shared entitlement core (same
// resolution the relay gate and the template/quick-reply cap routes use — one
// source, no drift). usage is two cheap count() queries on the caller's rows so
// the UI can render "2 / 3 used" without a second round-trip.
//
// `upgrade` distinguishes the two upsell paths for Pixel:
//   trial cap hit → { reason:'trial-limit-hit', cta:'activate-5', targetTier:'plus' }
//   $5   cap hit → { reason:'plus-limit-hit',  cta:'upgrade-7',  targetTier:'pro'  }
//   $7 / top / grandfathered-top → all-null (nowhere up).
//
// limits.quickReplies is now the REAL tier-enforced cap (trial 0 / $5 3 / $7 5),
// matching /api/quick-replies which reads the same TIER_LIMITS off the
// entitlement result (no longer a placeholder).
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
          // planId + grandfathered are REQUIRED here — this endpoint discloses
          // the tier AND caps, so an omitted planId would report Solo for a
          // Plus/Pro customer, and an omitted grandfathered would show a
          // pre-launch payer the new (possibly narrower) caps.
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

    // Free-access resolution — same DB-backed helper the relay + admin feed use
    // (one source, no drift). Fails closed to false, so a lookup error can never
    // unlock the app for a non-granted user.
    const freeAccess = await isFreeAccessEmail(db, user.email);

    const ent = evaluateEntitlement({
      isAdmin: user.isAdmin,
      email: user.email,
      freeAccess,
      subscription: user.subscription,
    });

    // Cheap usage counts on the caller's own rows.
    const [templatesUsed, quickRepliesUsed] = await Promise.all([
      db.template.count({ where: { userId: payload.userId } }),
      db.quickReplyTemplate.count({ where: { userId: payload.userId } }),
    ]);

    return NextResponse.json({
      tier: ent.tier,
      state: ent.state,
      allowed: ent.allowed,
      trialDaysLeft: ent.trialDaysLeft,
      grandfathered: ent.grandfathered,
      limits: {
        templates: ent.limits.templates,
        quickReplies: ent.limits.quickReplies,
        syncRangeMax: ent.limits.syncRangeMax,
        contactSync: ent.limits.contactSync,
      },
      // `upgrade` (2026-08-17) — the machine-readable prompt signal Pixel reads:
      // { reason:'trial-limit-hit', cta:'activate-5', targetTier:'plus' } on a
      // trial, { reason:'plus-limit-hit', cta:'upgrade-7', targetTier:'pro' } on
      // $5, all-null on $7/top/grandfathered-top.
      upgrade: ent.upgrade,
      usage: {
        templates: templatesUsed,
        quickReplies: quickRepliesUsed,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
