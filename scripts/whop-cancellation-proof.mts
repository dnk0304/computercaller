/**
 * scripts/whop-cancellation-proof.mts — end-to-end proof that a MID-PERIOD Whop
 * cancellation is captured and rendered (dispatch
 * forge/whop-payment-tracking-admin, 2026-08-11).
 *
 * This drives the REAL production modules — no re-implementation, no mirrors:
 *   • app/api/webhooks/whop/route.ts   → the actual POST handler, called with a
 *                                        real NextRequest carrying a REAL
 *                                        HMAC-SHA256 x-whop-signature.
 *   • lib/entitlement-core.js          → the actual paywall decision.
 *   • components/admin/customerRows.ts → the actual admin-table cell logic.
 * against a REAL PostgreSQL database (a throwaway container — never prod; the
 * script refuses to run against a non-local host, see assertLocalDb).
 *
 * What it proves, in order:
 *   1. A signed membership.cancel_at_period_end_changed webhook flips
 *      cancelAtPeriodEnd and stamps canceledAt — while status stays 'active'.
 *   2. The customer is STILL ENTITLED (allowed:true) for the rest of the period
 *      they paid for. A cancellation must never revoke access early.
 *   3. The admin table renders "Cancelling · until <date>", not "Cancelled" and
 *      not a plain "Active" row.
 *   4. An unsigned / wrong-signature POST is rejected 401 and changes nothing.
 *   5. An ambiguous later event (payment.succeeded with no flag) does NOT erase
 *      the recorded cancellation.
 *   6. An uncancel (the same toggle event with false) clears it again.
 *   7. When the period finally lapses, membership.went_invalid writes status
 *      'cancelled' (voluntary churn) — NOT 'expired' — and preserves the
 *      ORIGINAL cancellation date.
 *   8. A lapse with no recorded cancellation still writes 'expired'
 *      (involuntary churn) — the two must not collapse into one number.
 *
 * Run:
 *   DATABASE_URL=postgresql://... WHOP_WEBHOOK_SECRET=... \
 *     npx tsx scripts/whop-cancellation-proof.mts
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { POST } from '../app/api/webhooks/whop/route';
import { db } from '../lib/db';
import { evaluateEntitlement } from '../lib/entitlement-core';
import { cancellationMeta, formatDate } from '../components/admin/customerRows';
import type { AdminSubscription } from '../components/admin/adminTypes';

const SECRET = process.env.WHOP_WEBHOOK_SECRET ?? '';
const EMAIL = 'proof.cancels@example.com';
const MEMBERSHIP_ID = 'mem_PROOF_CANCEL';

let passed = 0;
function ok(name: string, cond: unknown) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, `${name} (got ${String(actual)})`);
  console.log(`  PASS  ${name} = ${String(actual)}`);
  passed += 1;
}

/**
 * Refuse to touch anything that is not an obviously-local throwaway database.
 * A proof script that can be pointed at production is a loaded gun; this is the
 * house seed-guard pattern (positive loopback allow-list, no escape hatch).
 */
function assertLocalDb(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = /@([^/:]+)/.exec(url)?.[1] ?? '';
  const allowed = ['127.0.0.1', 'localhost', '::1'];
  if (!allowed.includes(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is not loopback. This script WRITES and must never touch a shared or production database.`,
    );
  }
}

/** Build a request Whop would send, signed exactly the way the route verifies. */
function signedRequest(body: unknown, secretOverride?: string): Request {
  const raw = JSON.stringify(body);
  const sig = crypto
    .createHmac('sha256', secretOverride ?? SECRET)
    .update(raw, 'utf8')
    .digest('hex');
  return new Request('https://computercaller.com/api/webhooks/whop', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-whop-signature': sig },
    body: raw,
  });
}

// The route's parameter is a NextRequest; a plain Request is structurally
// sufficient for everything it touches (text(), headers). Cast at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (req: Request) => POST(req as any);

async function readSub() {
  const sub = await db.subscription.findFirst({ where: { whopMembershipId: MEMBERSHIP_ID } });
  assert.ok(sub, 'subscription row should exist');
  return sub!;
}

/** The admin-feed shape the table consumes, built from the live row. */
function toAdminSub(sub: Awaited<ReturnType<typeof readSub>>): AdminSubscription {
  return {
    status: sub.status as AdminSubscription['status'],
    state: 'active',
    tier: 'plus',
    planLabel: 'Plus',
    trialEndsAt: sub.trialEndsAt.toISOString(),
    trialDaysLeft: null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    convertedAt: sub.convertedAt?.toISOString() ?? null,
    canceledAt: sub.canceledAt?.toISOString() ?? null,
    paymentMethodAttached: sub.paymentMethodAttached,
    whopMembershipId: sub.whopMembershipId,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

async function main() {
  assertLocalDb();
  if (!SECRET) throw new Error('WHOP_WEBHOOK_SECRET must be set — the route fails closed without it.');

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 18 * 86_400_000); // still 18 days paid up

  // ---- fixture: a happy, paying, card-on-file customer ---------------------
  await db.subscription.deleteMany({ where: { whopMembershipId: MEMBERSHIP_ID } });
  await db.user.deleteMany({ where: { email: EMAIL } });
  const user = await db.user.create({
    data: {
      email: EMAIL,
      phoneToken: crypto.randomBytes(32).toString('base64url'),
      emailVerified: true,
      subscription: {
        create: {
          whopMembershipId: MEMBERSHIP_ID,
          status: 'active',
          trialEndsAt: new Date(now.getTime() - 40 * 86_400_000),
          currentPeriodEnd: periodEnd,
          convertedAt: new Date(now.getTime() - 38 * 86_400_000),
          paymentMethodAttached: true,
          planId: 'plan_IvKRyvHtl4Q8w',
        },
      },
    },
    include: { subscription: true },
  });

  console.log('\n--- BEFORE (the row Dennis sees today) ---');
  const before = await readSub();
  eq('status', before.status, 'active');
  eq('cancelAtPeriodEnd', before.cancelAtPeriodEnd, false);
  eq('canceledAt', before.canceledAt, null);
  ok('admin table shows NO cancellation', cancellationMeta(toAdminSub(before), 'active') === null);

  // ---- 4. an unsigned / forged POST must change nothing --------------------
  console.log('\n--- forged signature ---');
  const bad = await post(signedRequest(
    { action: 'membership.cancel_at_period_end_changed', data: { id: MEMBERSHIP_ID, cancel_at_period_end: true } },
    'not-the-real-secret',
  ));
  eq('forged webhook rejected', bad.status, 401);
  eq('forged webhook changed nothing', (await readSub()).cancelAtPeriodEnd, false);

  // ---- 1. the real mid-period cancellation ---------------------------------
  // Payload shaped per Whop's live OpenAPI spec for the v1 Membership object:
  // status stays 'active', cancel_at_period_end flips, current_period_end ISO.
  console.log('\n--- membership.cancel_at_period_end_changed (cancel_at_period_end: true) ---');
  const res = await post(signedRequest({
    action: 'membership.cancel_at_period_end_changed',
    data: {
      id: MEMBERSHIP_ID,
      status: 'active',
      user: { email: EMAIL },
      plan_id: 'plan_IvKRyvHtl4Q8w',
      cancel_at_period_end: true,
      current_period_end: periodEnd.toISOString(),
    },
  }));
  eq('webhook accepted', res.status, 200);

  const cancelled = await readSub();
  eq('cancelAtPeriodEnd recorded', cancelled.cancelAtPeriodEnd, true);
  ok('canceledAt stamped', cancelled.canceledAt instanceof Date);
  eq('status STILL active (Whop keeps it valid)', cancelled.status, 'active');
  eq(
    'currentPeriodEnd preserved',
    cancelled.currentPeriodEnd?.toISOString().slice(0, 10),
    periodEnd.toISOString().slice(0, 10),
  );

  // ---- 2. still entitled for the rest of the paid period -------------------
  const ent = evaluateEntitlement({
    isAdmin: false,
    email: EMAIL,
    subscription: {
      status: cancelled.status,
      trialEndsAt: cancelled.trialEndsAt,
      currentPeriodEnd: cancelled.currentPeriodEnd,
      planId: cancelled.planId,
    },
  });
  eq('STILL ENTITLED during the paid period', ent.allowed, true);
  eq('entitlement state unchanged', ent.state, 'active');
  eq('tier unchanged', ent.tier, 'plus');

  // ---- 3. what the admin table renders -------------------------------------
  const meta = cancellationMeta(toAdminSub(cancelled), 'active');
  eq('Cancelled column label', meta?.label, 'Cancelling');
  eq('flagged as pending churn', meta?.pendingChurn, true);
  console.log(
    `  ROW -> Paying: Yes | Next payment: ${formatDate(cancelled.currentPeriodEnd?.toISOString())} | Cancelled: ${meta?.label} until ${formatDate(cancelled.currentPeriodEnd?.toISOString())}`,
  );

  // ---- 5. an ambiguous later event must NOT erase the cancellation ---------
  console.log('\n--- payment.succeeded with NO cancel flag (ambiguous) ---');
  const firstCancelDate = cancelled.canceledAt!.getTime();
  await post(signedRequest({
    action: 'payment.succeeded',
    data: { id: MEMBERSHIP_ID, user: { email: EMAIL }, plan_id: 'plan_IvKRyvHtl4Q8w' },
  }));
  const afterAmbiguous = await readSub();
  eq('cancellation PRESERVED through ambiguous event', afterAmbiguous.cancelAtPeriodEnd, true);
  eq('canceledAt not moved', afterAmbiguous.canceledAt?.getTime(), firstCancelDate);

  // ---- 6. uncancel ---------------------------------------------------------
  console.log('\n--- the same toggle event with cancel_at_period_end: false (uncancel) ---');
  await post(signedRequest({
    action: 'membership.cancel_at_period_end_changed',
    data: { id: MEMBERSHIP_ID, status: 'active', user: { email: EMAIL }, cancel_at_period_end: false },
  }));
  const unc = await readSub();
  eq('uncancel clears the flag', unc.cancelAtPeriodEnd, false);
  eq('uncancel clears canceledAt', unc.canceledAt, null);
  ok('admin table shows NO cancellation again', cancellationMeta(toAdminSub(unc), 'active') === null);

  // ---- 7. re-cancel, then the period lapses → VOLUNTARY churn --------------
  console.log('\n--- re-cancel, then the period lapses ---');
  await post(signedRequest({
    action: 'membership.cancel_at_period_end_changed',
    data: { id: MEMBERSHIP_ID, status: 'active', user: { email: EMAIL }, cancel_at_period_end: true },
  }));
  const reCancelled = await readSub();
  const decidedAt = reCancelled.canceledAt!.getTime();

  await post(signedRequest({
    action: 'membership.went_invalid',
    data: { id: MEMBERSHIP_ID, user: { email: EMAIL } },
  }));
  const lapsed = await readSub();
  eq("voluntary churn writes status 'cancelled'", lapsed.status, 'cancelled');
  eq('ORIGINAL decision date preserved', lapsed.canceledAt?.getTime(), decidedAt);
  eq('scheduled flag reset once it took effect', lapsed.cancelAtPeriodEnd, false);
  const lapsedEnt = evaluateEntitlement({
    isAdmin: false,
    email: EMAIL,
    subscription: {
      status: lapsed.status,
      trialEndsAt: lapsed.trialEndsAt,
      currentPeriodEnd: new Date(now.getTime() - 1000), // period has passed
      planId: lapsed.planId,
    },
  });
  eq("'cancelled' still denies access", lapsedEnt.allowed, false);

  // ---- 8. a lapse with NO cancellation is INVOLUNTARY churn ----------------
  console.log('\n--- a different customer lapses without ever cancelling ---');
  await db.subscription.update({
    where: { userId: user.id },
    data: { status: 'active', cancelAtPeriodEnd: false, canceledAt: null },
  });
  await post(signedRequest({
    action: 'membership.went_invalid',
    data: { id: MEMBERSHIP_ID, user: { email: EMAIL } },
  }));
  eq("involuntary churn writes status 'expired'", (await readSub()).status, 'expired');

  // ---- cleanup -------------------------------------------------------------
  await db.subscription.deleteMany({ where: { whopMembershipId: MEMBERSHIP_ID } });
  await db.user.deleteMany({ where: { email: EMAIL } });

  console.log(`\nAll ${passed} assertions passed.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error('\nFAILED:', err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
