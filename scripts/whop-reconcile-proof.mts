/**
 * scripts/whop-reconcile-proof.mts — end-to-end proof that a Whop payment
 * reaches the database, that a payment we CANNOT match is never dropped
 * silently, and that reconciliation converges (dispatch
 * fix/whop-payment-reconcile, 2026-08-12).
 *
 * This drives the REAL production modules — no re-implementation, no mirrors:
 *   • app/api/webhooks/whop/route.ts → the actual POST handler, called with a
 *                                      real NextRequest carrying a REAL
 *                                      HMAC-SHA256 x-whop-signature.
 *   • lib/whop-resolve.ts            → the actual account-resolution ladder.
 *   • lib/whop-reconcile.ts          → the actual reconciliation job.
 *   • lib/entitlement-core.js        → the actual paywall decision.
 * against a REAL PostgreSQL database (a throwaway container — never prod; the
 * script refuses to run against a non-loopback host, see assertLocalDb).
 *
 * Only ONE thing is stubbed: `globalThis.fetch`, which stands in for the Whop
 * company API. Whop is read-only in this system and we must not depend on a
 * live third party (or a real key) to prove OUR logic. The stub serves the
 * EXACT membership shapes verified live on 2026-08-11.
 *
 * What it proves, in order:
 *   1. A slim v1 `membership.went_valid` — no user object, no email, no
 *      pre-existing Subscription (a customer's FIRST purchase) — resolves via
 *      the Whop-API rung and CREATES the subscription row. This is the
 *      regression test for the actual incident: before the fix this event was
 *      dropped and the paying customer had no entitlement.
 *   2. The customer is then ENTITLED (the whole point of the row existing).
 *   3. A payload whose email matches no account writes an UnmatchedWhopEvent,
 *      does not throw, and still returns 200 (no Whop retry storm).
 *   4. Reconciliation over the exact TWO-membership shape picks
 *      mem_..._PAID (period end 2026-09-10, cancelAtPeriodEnd false) and NOT
 *      the cancelled trial that ends 2026-08-18.
 *   5. Running reconciliation a second time is a NO-OP — nothing written, no
 *      duplicate unmatched rows, timestamps unmoved.
 *   6. payment.failed is recorded WITHOUT revoking access.
 *
 * Run (against a throwaway Postgres, e.g.
 *   docker run -d --name cc-pg -e POSTGRES_PASSWORD=proof \
 *     -e POSTGRES_DB=computercaller -p 55439:5432 postgres:16-alpine
 * then `npx prisma db push`):
 *
 *   DATABASE_URL=postgresql://postgres:proof@localhost:55439/computercaller \
 *   WHOP_WEBHOOK_SECRET=test-secret WHOP_API_KEY=test-key \
 *     npx tsx scripts/whop-reconcile-proof.mts
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { POST } from '../app/api/webhooks/whop/route';
import { db } from '../lib/db';
import { evaluateEntitlement } from '../lib/entitlement-core';
import { reconcileWhopSubscriptions } from '../lib/whop-reconcile';

const SECRET = process.env.WHOP_WEBHOOK_SECRET ?? '';

// ---- fixture identities ----------------------------------------------------
const SLIM_EMAIL = 'proof.slim.firstbuy@example.com';
const SLIM_WHOP_USER = 'user_PROOF_SLIM';
const SLIM_MEMBERSHIP = 'mem_PROOF_SLIM';

// Replica of the real incident: ONE customer, TWO memberships.
const TWO_EMAIL = 'proof.twomemberships@example.com';
const TWO_WHOP_USER = 'user_PROOF_TWO';
const TRIAL_MEMBERSHIP = 'mem_PROOF_TRIAL';
const PAID_MEMBERSHIP = 'mem_PROOF_PAID';

// A membership belonging to nobody we know — a customer who paid before he
// registered. Must be recorded, exactly once, however many times we reconcile.
const GHOST_WHOP_USER = 'user_PROOF_GHOST';
const GHOST_MEMBERSHIP = 'mem_PROOF_GHOST';
const GHOST_EMAIL = 'proof.ghost.unregistered@example.com';

const ALL_EMAILS = [SLIM_EMAIL, TWO_EMAIL, GHOST_EMAIL];
const ALL_MEMBERSHIPS = [SLIM_MEMBERSHIP, TRIAL_MEMBERSHIP, PAID_MEMBERSHIP, GHOST_MEMBERSHIP];

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const TRIAL_MEM = {
  id: TRIAL_MEMBERSHIP,
  status: 'trialing',
  valid: true,
  plan_id: 'plan_CGlYdJJr3Btlu',
  user_id: TWO_WHOP_USER,
  cancel_at_period_end: true,
  created_at: sec('2026-08-11T05:39:44Z'),
  renewal_period_end: sec('2026-08-18T05:39:44Z'),
};
const PAID_MEM = {
  id: PAID_MEMBERSHIP,
  status: 'active',
  valid: true,
  plan_id: 'plan_CGlYdJJr3Btlu',
  user_id: TWO_WHOP_USER,
  cancel_at_period_end: false,
  created_at: sec('2026-08-11T05:43:15Z'),
  renewal_period_end: sec('2026-09-10T05:43:15Z'),
};
const GHOST_MEM = {
  id: GHOST_MEMBERSHIP,
  status: 'active',
  valid: true,
  plan_id: 'plan_CGlYdJJr3Btlu',
  user_id: GHOST_WHOP_USER,
  cancel_at_period_end: false,
  created_at: sec('2026-08-11T06:00:00Z'),
  renewal_period_end: sec('2026-09-11T06:00:00Z'),
};

// Whop user id → email, as the company API would answer.
const WHOP_USERS: Record<string, string> = {
  [SLIM_WHOP_USER]: SLIM_EMAIL,
  [TWO_WHOP_USER]: TWO_EMAIL,
  [GHOST_WHOP_USER]: GHOST_EMAIL, // registered nowhere in our DB
};

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

// ---- the Whop company API, stubbed ----------------------------------------
let membershipsListed = 0;
function installWhopStub(memberships: unknown[]): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === 'string' ? input : (input as { url?: string })?.url ?? input,
    );
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const userMatch = /\/company\/users\/([^/?]+)/.exec(url);
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]);
      const email = WHOP_USERS[id];
      if (!email) return new Response('not found', { status: 404 });
      return json({ id, email });
    }

    if (url.includes('/company/memberships?')) {
      membershipsListed += 1;
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
      if (page > 1) return json({ data: [], pagination: { current_page: page, total_page: 1 } });
      return json({ data: memberships, pagination: { current_page: 1, total_page: 1 } });
    }

    throw new Error(`Unexpected fetch in proof harness: ${url}`);
  }) as typeof fetch;
}

/** Build a request Whop would send, signed exactly the way the route verifies. */
function signedRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
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

async function cleanup(): Promise<void> {
  await db.subscription.deleteMany({ where: { user: { email: { in: ALL_EMAILS } } } });
  await db.subscription.deleteMany({ where: { whopMembershipId: { in: ALL_MEMBERSHIPS } } });
  await db.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
  await db.unmatchedWhopEvent.deleteMany({
    where: {
      OR: [
        { whopMembershipId: { in: ALL_MEMBERSHIPS } },
        { payloadEmail: { in: [...ALL_EMAILS, 'nobody.here@example.com'] } },
        { whopUserId: { in: [SLIM_WHOP_USER, TWO_WHOP_USER, GHOST_WHOP_USER] } },
      ],
    },
  });
}

async function makeUser(email: string) {
  return db.user.create({
    data: {
      email,
      phoneToken: crypto.randomBytes(32).toString('base64url'),
      emailVerified: true,
    },
  });
}

async function main() {
  assertLocalDb();
  if (!SECRET) throw new Error('WHOP_WEBHOOK_SECRET must be set — the route fails closed without it.');
  if (!(process.env.WHOP_API_KEY ?? '').trim() || process.env.WHOP_API_KEY === 'dev-placeholder') {
    throw new Error('WHOP_API_KEY must be set to a non-placeholder value — the API rung is skipped otherwise.');
  }

  installWhopStub([TRIAL_MEM, PAID_MEM, GHOST_MEM]);
  await cleanup();

  // =========================================================================
  console.log('\n1. FIRST PURCHASE, slim v1 payload — the 2026-08-11 incident');
  // A brand-new customer with an account but NO subscription row (the state
  // every account has been in since cc5b4ba stopped auto-creating trials).
  // Whop delivers the modern v1 Membership shape: a user_id, no user object,
  // no email — and there is no prior Subscription to look the membership up
  // by, because this is his first ever purchase.
  // =========================================================================
  const slimUser = await makeUser(SLIM_EMAIL);
  eq('precondition: no subscription row', await db.subscription.count({ where: { userId: slimUser.id } }), 0);

  const slimEvent = {
    type: 'membership.went_valid',
    api_version: 'v1',
    data: {
      id: SLIM_MEMBERSHIP,
      user_id: SLIM_WHOP_USER, // ← no `user` object, no email anywhere
      plan_id: 'plan_CGlYdJJr3Btlu',
      status: 'active',
      valid: true,
      cancel_at_period_end: false,
      created_at: sec('2026-08-11T05:43:15Z'),
      renewal_period_end: sec('2026-09-10T05:43:15Z'),
    },
  };
  const res1 = await post(signedRequest(slimEvent));
  eq('webhook returns 200', res1.status, 200);

  const slimSub = await db.subscription.findUnique({ where: { userId: slimUser.id } });
  ok('subscription row was CREATED (was silently dropped before the fix)', !!slimSub);
  eq('status', slimSub!.status, 'active');
  eq('whopMembershipId', slimSub!.whopMembershipId, SLIM_MEMBERSHIP);
  eq('planId', slimSub!.planId, 'plan_CGlYdJJr3Btlu');
  eq('currentPeriodEnd', slimSub!.currentPeriodEnd?.toISOString(), '2026-09-10T05:43:15.000Z');

  const linked = await db.user.findUnique({ where: { id: slimUser.id }, select: { whopUserId: true } });
  eq('User.whopUserId linked durably for future events', linked?.whopUserId, SLIM_WHOP_USER);

  console.log('\n2. …and the paying customer is actually ENTITLED');
  const ent = evaluateEntitlement(
    {
      isAdmin: false,
      email: SLIM_EMAIL,
      freeAccess: false,
      subscription: {
        status: slimSub!.status,
        trialEndsAt: slimSub!.trialEndsAt,
        currentPeriodEnd: slimSub!.currentPeriodEnd,
        planId: slimSub!.planId,
      },
    },
    new Date('2026-08-12T12:00:00Z'),
  );
  eq('entitlement allowed', ent.allowed, true);

  // A repeat of the SAME event must not double-write or move "paying since".
  const convertedAtFirst = slimSub!.convertedAt?.toISOString();
  await post(signedRequest(slimEvent));
  const slimSub2 = await db.subscription.findUnique({ where: { userId: slimUser.id } });
  eq('re-delivery does not move convertedAt', slimSub2!.convertedAt?.toISOString(), convertedAtFirst);
  eq('still exactly one subscription row', await db.subscription.count({ where: { userId: slimUser.id } }), 1);

  // =========================================================================
  console.log('\n3. UNMATCHABLE payload — recorded, never dropped silently');
  // =========================================================================
  const unmatchedEvent = {
    action: 'membership.went_valid',
    data: {
      id: 'mem_PROOF_NOBODY',
      user: { id: 'user_PROOF_NOBODY', email: 'nobody.here@example.com' },
      plan_id: 'plan_CGlYdJJr3Btlu',
      status: 'active',
      valid: true,
    },
  };
  const res3 = await post(signedRequest(unmatchedEvent));
  eq('still returns 200 (Whop must not retry-storm)', res3.status, 200);
  eq('…and says so explicitly', (await res3.json()).matched, false);

  const rec = await db.unmatchedWhopEvent.findFirst({
    where: { payloadEmail: 'nobody.here@example.com' },
  });
  ok('an UnmatchedWhopEvent row was written', !!rec);
  eq('eventName', rec!.eventName, 'membership.went_valid');
  eq('payloadEmail captured', rec!.payloadEmail, 'nobody.here@example.com');
  eq('whopUserId captured', rec!.whopUserId, 'user_PROOF_NOBODY');
  eq('unresolved', rec!.resolvedAt, null);
  ok('the whole verified payload is stored for replay', !!(rec!.rawPayload as Record<string, unknown>)?.data);
  await db.unmatchedWhopEvent.deleteMany({ where: { payloadEmail: 'nobody.here@example.com' } });

  // =========================================================================
  console.log('\n4. RECONCILE the two-membership customer');
  // The exact incident shape: a cancelled trial ending 2026-08-18 and the live
  // paid subscription ending 2026-09-10. Reconciliation must store the PAID
  // one. Storing the trial would expire a paying customer three weeks early.
  // =========================================================================
  const twoUser = await makeUser(TWO_EMAIL);
  eq('precondition: paying customer has NO subscription row', await db.subscription.count({ where: { userId: twoUser.id } }), 0);

  const run1 = await reconcileWhopSubscriptions();
  eq('scanned all three memberships', run1.scanned, 3);
  // 3 memberships, 2 customers — the trial and the paid subscription are the
  // SAME person and must collapse into one group. If they didn't, they would
  // race each other for his single Subscription row.
  eq('grouped into two customers', run1.customers, 2);
  eq('list was complete', run1.complete, true);
  eq('created one subscription', run1.created, 1);
  eq('one membership could not be matched (the ghost)', run1.unmatched, 1);
  eq('no errors', run1.errors, []);

  const twoSub = await db.subscription.findUnique({ where: { userId: twoUser.id } });
  ok('subscription row created for the paying customer', !!twoSub);
  eq('picked the PAID membership, not the cancelled trial', twoSub!.whopMembershipId, PAID_MEMBERSHIP);
  eq('period end is the paid one (2026-09-10), not the trial (2026-08-18)', twoSub!.currentPeriodEnd?.toISOString(), '2026-09-10T05:43:15.000Z');
  eq('cancelAtPeriodEnd is false — the trial cancellation is not his', twoSub!.cancelAtPeriodEnd, false);
  eq('status', twoSub!.status, 'active');
  eq('planId', twoSub!.planId, 'plan_CGlYdJJr3Btlu');
  eq('canceledAt clean', twoSub!.canceledAt, null);

  eq(
    'the unregistered ghost buyer was recorded, not dropped',
    await db.unmatchedWhopEvent.count({ where: { whopUserId: GHOST_WHOP_USER, resolvedAt: null } }),
    1,
  );

  // =========================================================================
  console.log('\n5. RECONCILE AGAIN — must be a complete no-op');
  // =========================================================================
  const beforeUpdatedAt = twoSub!.updatedAt.toISOString();
  const beforeSlim = await db.subscription.findUnique({ where: { userId: slimUser.id } });

  const run2 = await reconcileWhopSubscriptions();
  eq('nothing created', run2.created, 0);
  eq('nothing updated', run2.updated, 0);
  eq('every matched customer reported unchanged', run2.unchanged, run2.matched);
  eq('no change list', run2.changes, []);
  eq('no errors', run2.errors, []);

  const twoSubAfter = await db.subscription.findUnique({ where: { userId: twoUser.id } });
  eq('updatedAt did NOT move (no write happened)', twoSubAfter!.updatedAt.toISOString(), beforeUpdatedAt);
  eq('membership unchanged', twoSubAfter!.whopMembershipId, PAID_MEMBERSHIP);
  eq('period end unchanged', twoSubAfter!.currentPeriodEnd?.toISOString(), '2026-09-10T05:43:15.000Z');

  const slimAfter = await db.subscription.findUnique({ where: { userId: slimUser.id } });
  eq(
    'the webhook-created row is left alone too',
    slimAfter!.updatedAt.toISOString(),
    beforeSlim!.updatedAt.toISOString(),
  );
  eq(
    'the ghost was NOT recorded a second time (idempotent)',
    await db.unmatchedWhopEvent.count({ where: { whopUserId: GHOST_WHOP_USER } }),
    1,
  );

  // =========================================================================
  console.log('\n6. A ghost who finally registers is picked up and resolved');
  // =========================================================================
  const ghostUser = await makeUser(GHOST_EMAIL);
  const run3 = await reconcileWhopSubscriptions();
  eq('his subscription is created on the next pass', run3.created, 1);
  const ghostSub = await db.subscription.findUnique({ where: { userId: ghostUser.id } });
  eq('with the right membership', ghostSub?.whopMembershipId, GHOST_MEMBERSHIP);
  eq(
    'and his unmatched record is marked resolved',
    (await db.unmatchedWhopEvent.findFirst({ where: { whopUserId: GHOST_WHOP_USER } }))?.resolvedUserId,
    ghostUser.id,
  );

  // =========================================================================
  console.log('\n7. payment.failed is recorded and does NOT revoke access');
  // =========================================================================
  const failEvent = {
    action: 'payment.failed',
    data: { id: PAID_MEMBERSHIP, user_id: TWO_WHOP_USER, plan_id: 'plan_CGlYdJJr3Btlu' },
  };
  const res7 = await post(signedRequest(failEvent));
  eq('returns 200', res7.status, 200);
  const afterFail = await db.subscription.findUnique({ where: { userId: twoUser.id } });
  ok('lastPaymentFailedAt stamped', !!afterFail!.lastPaymentFailedAt);
  eq('failure counted', afterFail!.paymentFailureCount, 1);
  eq('status untouched — a single failure must NOT revoke access', afterFail!.status, 'active');
  eq('period end untouched', afterFail!.currentPeriodEnd?.toISOString(), '2026-09-10T05:43:15.000Z');
  eq(
    'still entitled',
    evaluateEntitlement(
      {
        isAdmin: false,
        email: TWO_EMAIL,
        freeAccess: false,
        subscription: {
          status: afterFail!.status,
          trialEndsAt: afterFail!.trialEndsAt,
          currentPeriodEnd: afterFail!.currentPeriodEnd,
          planId: afterFail!.planId,
        },
      },
      new Date('2026-08-12T12:00:00Z'),
    ).allowed,
    true,
  );

  // A later successful charge clears the dunning streak.
  await post(
    signedRequest({
      action: 'payment.succeeded',
      data: { ...PAID_MEM, user_id: TWO_WHOP_USER },
    }),
  );
  eq(
    'a successful charge resets the failure count',
    (await db.subscription.findUnique({ where: { userId: twoUser.id } }))!.paymentFailureCount,
    0,
  );

  console.log(`\nAll ${passed} assertions passed. (Whop membership list called ${membershipsListed}x)`);
}

main()
  .then(async () => {
    await cleanup();
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error('\nFAILED:', e);
    // Tear the fixtures down even on failure — a leaked fixture turns the NEXT
    // run's baseline red for the wrong reason.
    await cleanup().catch(() => {});
    await db.$disconnect();
    process.exit(1);
  });
