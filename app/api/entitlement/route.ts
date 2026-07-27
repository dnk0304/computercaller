import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { evaluateEntitlement } from '@/lib/entitlement';

// GET /api/entitlement — the canonical tier + limits + usage contract the web
// app consumes (dispatch feature/tier-gating, 2026-07-27). Auth mirrors
// app/api/auth/me: read the auth_token cookie → validateSessionToken → 401 on
// null. This is the ONE endpoint Pixel's useEntitlement() hook builds against;
// the shape below is FROZEN.
//
// Response (200):
// {
//   tier: 'solo' | 'plus' | 'pro',
//   state: 'active' | 'trialing' | 'trial_expired' | 'expired' | 'none' | 'admin' | 'allowlisted',
//   allowed: boolean,
//   trialDaysLeft: number | null,
//   limits: { templates, quickReplies, syncRangeMax, contactSync, mirroring },
//   usage:  { templates, quickReplies }
// }
//
// tier/limits come straight off the shared entitlement core (same resolution
// the relay gate and the template-cap route use — one source, no drift). usage
// is two cheap count() queries on the caller's rows so the UI can render
// "2 / 3 used" without a second round-trip.
//
// NOTE on limits.quickReplies: it is the tier-map placeholder (5 for all tiers,
// D5). The ACTUALLY enforced quick-reply cap is still state-based (paying=5 /
// trial=1) in /api/quick-replies — quick-replies are intentionally not a tier
// differentiator yet. The per-list `limit` on GET /api/quick-replies is the
// real enforced number for that surface.
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
          // planId is REQUIRED here — this endpoint discloses the tier, so an
          // omitted planId would silently report Solo for a Plus/Pro customer.
          select: { status: true, trialEndsAt: true, currentPeriodEnd: true, planId: true },
        },
      },
    });
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const ent = evaluateEntitlement({
      isAdmin: user.isAdmin,
      email: user.email,
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
      limits: {
        templates: ent.limits.templates,
        quickReplies: ent.limits.quickReplies,
        syncRangeMax: ent.limits.syncRangeMax,
        contactSync: ent.limits.contactSync,
        mirroring: ent.limits.mirroring,
      },
      usage: {
        templates: templatesUsed,
        quickReplies: quickRepliesUsed,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
