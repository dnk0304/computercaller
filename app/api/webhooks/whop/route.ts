import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Whop sends webhooks for membership events.
// Verify the signature using WHOP_WEBHOOK_SECRET.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, data } = body;

    // Verify webhook signature (Whop sends X-Whop-Signature header)
    // For now log and process — add HMAC verification before production
    console.log('[Whop webhook]', action, data?.id);

    const email = data?.user?.email?.toLowerCase();
    if (!email) return NextResponse.json({ ok: true });

    const user = await db.user.findUnique({ where: { email } });
    if (!user) return NextResponse.json({ ok: true }); // user not registered yet

    if (action === 'membership.went_valid' || action === 'payment.succeeded') {
      const periodEnd = data?.expires_at
        ? new Date(data.expires_at * 1000)
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

      await db.subscription.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          whopMembershipId: data?.id,
          status: 'active',
          trialEndsAt: new Date(),
          currentPeriodEnd: periodEnd,
        },
        update: {
          whopMembershipId: data?.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
        },
      });
    }

    if (action === 'membership.went_invalid' || action === 'membership.expired') {
      await db.subscription.updateMany({
        where: { userId: user.id },
        data: { status: 'expired' },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[Whop webhook] Error:', e);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
