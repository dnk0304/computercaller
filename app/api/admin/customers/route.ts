/**
 * GET /api/admin/customers — Dennis-only customer-tracking feed
 * (dispatch forge/trial-lock-and-admin-dashboard, 2026-07-03).
 *
 * The frozen JSON contract Pixel's admin dashboard is built against. Keep the
 * shape EXACT — see the dispatch brief. Returns ALL users unpaginated (tiny
 * dataset in v1). At scale this would move to cursor pagination on
 * createdAt/id + a server-side same-IP aggregate; noted, not needed yet.
 *
 * AUTHZ: validateSessionToken (sig + sessionVersion) → load the user → require
 * isAdmin === true. Anything else is 401/403. Deny by default.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken } from '@/lib/auth';
import { db } from '@/lib/db';
import { evaluateEntitlement, isAdminUser } from '@/lib/entitlement';
import { resolveMembershipStates } from '@/lib/whop';

// Human-readable plan label per resolved tier. Kept local to the admin feed —
// the enforced tier values ('solo'|'plus'|'pro') come straight off the shared
// entitlement core; this is display sugar for the dashboard's Plan column.
const TIER_LABEL: Record<string, string> = {
  solo: 'Solo',
  plus: 'Plus',
  pro: 'Pro',
};

// Same-IP cluster flag threshold. Env override so Dennis can tune sensitivity
// without a redeploy; default 3. A non-numeric/blank env falls back to 3.
function sameIpThreshold(): number {
  const raw = process.env.ADMIN_SAME_IP_FLAG_THRESHOLD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 3;
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('auth_token')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const payload = await validateSessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // AUTHZ gate — the SINGLE admin authority (isAdminUser). Admits isAdmin===true
    // OR the hardcoded admin email, so a lost DB flag can't lock Dennis out;
    // fail-closed for everyone else. Select email alongside isAdmin for it.
    const requester = await db.user.findUnique({
      where: { id: payload.userId },
      select: { isAdmin: true, email: true },
    });
    if (!isAdminUser({ isAdmin: requester?.isAdmin, email: requester?.email })) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Same-IP cluster counts. groupBy over non-null signupIp → map ip → count.
    // signupIp is a nullable scalar, so `{ not: null }` is valid here (it would
    // throw on a NON-nullable field — not the case).
    const ipGroups = await db.user.groupBy({
      by: ['signupIp'],
      where: { signupIp: { not: null } },
      _count: { signupIp: true },
    });
    const ipCounts = new Map<string, number>();
    for (const g of ipGroups) {
      if (g.signupIp) ipCounts.set(g.signupIp, g._count.signupIp);
    }

    const users = await db.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        authProvider: true,
        isAdmin: true,
        createdAt: true,
        lastActiveAt: true,
        signupIp: true,
        lastLoginIp: true,
        subscription: {
          select: {
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            convertedAt: true,
            canceledAt: true,
            paymentMethodAttached: true,
            whopMembershipId: true,
            // cancelAtPeriodEnd (2026-08-11) — the customer cancelled but is
            // still inside the period they paid for. Whop keeps such a
            // membership VALID, so without this the row reads as a happy
            // "Paying" customer right up until they silently vanish.
            cancelAtPeriodEnd: true,
            // planId (2026-07-30) — REQUIRED to surface the tier (Solo/Plus/Pro)
            // in the feed. Was previously dropped, so the dashboard showed only
            // coarse state, never the plan. Feeds evaluateEntitlement below.
            planId: true,
          },
        },
      },
    });

    // Free-access allowlist, batch-loaded ONCE (one query, not per-user) and
    // folded into each row's entitlement via the same free_access short-circuit
    // the relay + browser gates use — one source, no drift. Fail-open to an
    // empty set on error: a free-access lookup failure must not break the whole
    // admin feed, and it can only UNDER-report free access (never grant it).
    let freeAccessSet = new Set<string>();
    try {
      const rows = await db.freeAccessEmail.findMany({ select: { email: true } });
      freeAccessSet = new Set(rows.map((r) => r.email.toLowerCase()));
    } catch (e) {
      console.error('[AdminCustomers] free-access load failed:', e);
    }

    const threshold = sameIpThreshold();
    const now = new Date();

    // LIVE membership state (dispatch forge/trial7-caps-whopcard, 2026-07-03;
    // widened 2026-08-11 to also read cancel_at_period_end + current_period_end
    // off the SAME response — zero extra network calls). For
    // every row that carries a whopMembershipId, ask the Whop admin API whether
    // a card is on file — this also covers TRIAL-only users whose stored
    // paymentMethodAttached is still false. Bounded concurrency + 3s per-call
    // timeout + 60s cache all live in lib/whop.ts; the call NEVER throws and
    // degrades to null (→ fall back to the stored boolean) on any failure. When
    // WHOP_API_KEY is unset or the dev placeholder, this resolves every id to
    // null with zero network calls, so the dashboard behaves exactly as before.
    const membershipIds = users
      .map((u) => u.subscription?.whopMembershipId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const liveState = await resolveMembershipStates(membershipIds);

    const customers = users.map((u) => {
      const freeAccess = freeAccessSet.has(u.email.toLowerCase());
      const ent = evaluateEntitlement(
        {
          isAdmin: u.isAdmin,
          email: u.email,
          freeAccess,
          subscription: u.subscription
            ? {
                status: u.subscription.status,
                trialEndsAt: u.subscription.trialEndsAt,
                currentPeriodEnd: u.subscription.currentPeriodEnd,
                // planId passed through so ent.tier reflects the paid plan.
                planId: u.subscription.planId,
              }
            : null,
        },
        now,
      );

      // sameIpAccountCount: number of accounts sharing this signupIp. When the
      // IP is known it is >= 1 (this row itself is in the group). When null we
      // report 1 (the account itself) — it can never be flagged (needs a
      // non-null IP), so the value is display-only in that case.
      const sameIpAccountCount = u.signupIp ? (ipCounts.get(u.signupIp) ?? 1) : 1;
      const flagged = u.signupIp != null && sameIpAccountCount >= threshold;

      // Live card-on-file override: when Whop answered for this membership
      // (non-null), trust the live value over the stored boolean; on any
      // miss/timeout/no-key (null) keep the stored value. Rows with no
      // membershipId never had a live call, so they keep stored as-is.
      const membershipId = u.subscription?.whopMembershipId ?? null;
      const live = membershipId ? liveState.get(membershipId) : undefined;
      const effectiveCardAttached =
        typeof live?.cardOnFile === 'boolean'
          ? live.cardOnFile
          : (u.subscription?.paymentMethodAttached ?? false);

      // Same live-over-stored precedence for the cancellation signal. The stored
      // column is the durable record (written by the webhook); the live read
      // reconciles it — and backfills customers who cancelled BEFORE the webhook
      // learned to capture cancel_at_period_end at all.
      const effectiveCancelAtPeriodEnd =
        typeof live?.cancelAtPeriodEnd === 'boolean'
          ? live.cancelAtPeriodEnd
          : (u.subscription?.cancelAtPeriodEnd ?? false);

      // Next payment / access-until. Prefer the live period end when Whop
      // answered — a renewal that hasn't reached our webhook yet shows the real
      // next-bill date rather than a stale stored one.
      const effectivePeriodEnd =
        live?.currentPeriodEnd ?? u.subscription?.currentPeriodEnd?.toISOString() ?? null;

      // subscription block is NEVER omitted — when the row has no subscription
      // we return an explicit null-filled object with the evaluated state (which
      // for a non-admin/non-allowlisted user is 'none'; for Dennis it's 'admin').
      // tier/planLabel (2026-07-30, ADDITIVE): the resolved billing tier and its
      // human label. For a free_access user ent.tier === 'pro' → "Pro".
      const tier = ent.tier;
      const planLabel = TIER_LABEL[tier] ?? 'Solo';

      const subscription = u.subscription
        ? {
            status: u.subscription.status,
            state: ent.state,
            tier,
            planLabel,
            trialEndsAt: u.subscription.trialEndsAt?.toISOString() ?? null,
            trialDaysLeft: ent.trialDaysLeft,
            currentPeriodEnd: effectivePeriodEnd,
            convertedAt: u.subscription.convertedAt?.toISOString() ?? null,
            canceledAt: u.subscription.canceledAt?.toISOString() ?? null,
            paymentMethodAttached: effectiveCardAttached,
            whopMembershipId: u.subscription.whopMembershipId ?? null,
            cancelAtPeriodEnd: effectiveCancelAtPeriodEnd,
          }
        : {
            status: null,
            state: ent.state,
            tier,
            planLabel,
            trialEndsAt: null,
            trialDaysLeft: ent.trialDaysLeft,
            currentPeriodEnd: null,
            convertedAt: null,
            canceledAt: null,
            paymentMethodAttached: false,
            whopMembershipId: null,
            cancelAtPeriodEnd: false,
          };

      return {
        id: u.id,
        email: u.email,
        emailVerified: u.emailVerified,
        authProvider: u.authProvider,
        registeredAt: u.createdAt.toISOString(),
        // freeAccess (2026-07-30, ADDITIVE, top-level): is this user's email in
        // the FreeAccessEmail allowlist. Drives the "Free access" badge + the
        // grant/revoke control state in the UI.
        freeAccess,
        subscription,
        lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
        signupIp: u.signupIp ?? null,
        lastLoginIp: u.lastLoginIp ?? null,
        sameIpAccountCount,
        flagged,
      };
    });

    return NextResponse.json({
      customers,
      meta: {
        total: customers.length,
        sameIpThreshold: threshold,
        generatedAt: now.toISOString(),
      },
    });
  } catch (e) {
    console.error('[AdminCustomers] error:', e);
    return NextResponse.json({ error: 'Failed to load customers' }, { status: 500 });
  }
}
