/**
 * scripts/backfill-whop-subscription.mjs — repair ONE customer whose Whop
 * payment never produced a Subscription row (2026-08-12, dispatch
 * fix/whop-payment-reconcile).
 *
 * Written for the 2026-08-11 incident: sendyfeldheim@gmail.com paid, the
 * webhook never matched him to his account, and he had no entitlement.
 *
 * SAFETY:
 *   • READ-ONLY against Whop. It lists memberships and reads users. It never
 *     refunds, cancels, or mutates anything on Whop's side.
 *   • `--dry` (recommended first) prints the EXACT upsert payload and exits
 *     without touching the database.
 *   • Idempotent: re-running it converges on the same row. It only ever fills
 *     `convertedAt` / `canceledAt` when they are empty, so a re-run can't move
 *     a "paying since" date.
 *   • Refuses to invent an account — the User must already exist.
 *
 * THE RULE THAT MATTERS: a customer can hold SEVERAL memberships. This one
 * holds a CANCELLED trial (created first, ends 2026-08-18) and the LIVE paid
 * subscription (created 3.5 min later, ends 2026-09-10). Taking "the first" or
 * "the newest-created" membership would store the dead trial and expire a
 * paying customer mid-subscription. We take the `valid === true` membership
 * with the LATEST period end — see pickAuthoritativeMembership in
 * lib/whop-core.js, which is the same function the reconciliation job uses.
 *
 * Usage:
 *   node scripts/backfill-whop-subscription.mjs --email <addr> [--whop-user-id <id>] [--dry]
 *
 * Requires WHOP_API_KEY (read scope) and DATABASE_URL in the environment.
 */

import { PrismaClient } from '@prisma/client';
import whopCore from '../lib/whop-core.js';

const {
  pickAuthoritativeMembership,
  membershipToSubscriptionFields,
  membershipIsValid,
  membershipPeriodEndMs,
  extractWhopUserId,
  extractMembershipId,
  extractPayloadEmail,
} = whopCore;

// Always the real Whop API. WHOP_API_BASE_OVERRIDE exists ONLY so the harness
// can serve the recorded incident fixtures from loopback — it is rejected
// unless it points at localhost, so it can never redirect a real run at an
// attacker-controlled host.
function resolveApiBase() {
  const override = (process.env.WHOP_API_BASE_OVERRIDE || '').trim();
  if (!override) return 'https://api.whop.com/api/v5';
  const host = (() => {
    try {
      return new URL(override).hostname;
    } catch {
      return '';
    }
  })();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.error(`ERROR: WHOP_API_BASE_OVERRIDE must be loopback, got "${host}".`);
    process.exit(1);
  }
  console.warn(`⚠ Using WHOP_API_BASE_OVERRIDE=${override} (test fixture server, not real Whop).`);
  return override;
}
const WHOP_API_BASE = resolveApiBase();

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  // Also accept --name=value. A silently-ignored flag spelling is how a script
  // quietly does the wrong job.
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const EMAIL = (arg('email') || '').trim().toLowerCase();
const WHOP_USER_ID = arg('whop-user-id');
const DRY = hasFlag('dry');

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function whopGet(path) {
  const key = (process.env.WHOP_API_KEY || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${WHOP_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Whop GET ${path} → ${res.status} ${await res.text().catch(() => '')}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every membership on the company, paginated. */
async function listAllMemberships() {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await whopGet(`/company/memberships?page=${page}&per=50`);
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.memberships)
          ? payload.memberships
          : [];
    all.push(...list);
    const pg = payload?.pagination;
    const total = Number(pg?.total_page ?? pg?.total_pages ?? NaN);
    if (Number.isFinite(total)) {
      if (page >= total) break;
    } else if (list.length < 50) {
      break;
    }
  }
  return all;
}

const userEmailCache = new Map();
async function whopUserEmail(userId) {
  if (!userId) return null;
  if (userEmailCache.has(userId)) return userEmailCache.get(userId);
  let email = null;
  try {
    const u = await whopGet(`/company/users/${encodeURIComponent(userId)}`);
    const root = u?.data && typeof u.data === 'object' ? u.data : u;
    email = typeof root?.email === 'string' ? root.email.trim().toLowerCase() : null;
  } catch (e) {
    console.warn(`  (could not read Whop user ${userId}: ${e.message})`);
  }
  userEmailCache.set(userId, email);
  return email;
}

async function main() {
  if (!EMAIL) die('--email <address> is required.');
  if (!(process.env.WHOP_API_KEY || '').trim()) die('WHOP_API_KEY is not set.');
  if (!(process.env.DATABASE_URL || '').trim()) die('DATABASE_URL is not set.');

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: EMAIL },
      select: { id: true, email: true, whopUserId: true },
    });
    if (!user) {
      die(`No app account with email ${EMAIL}. This script repairs an EXISTING account; it never creates one.`);
    }
    console.log(`App account: ${user.id} (${user.email})`);

    console.log('Listing Whop memberships (read-only)…');
    const all = await listAllMemberships();
    console.log(`  ${all.length} membership(s) on the company.`);

    // Which of them belong to this customer? Prefer an explicit Whop user id;
    // otherwise match on the membership's own email, falling back to a
    // per-user lookup for the slim payloads that carry only user_id.
    const mine = [];
    for (const m of all) {
      const uid = extractWhopUserId(m);
      if (WHOP_USER_ID) {
        if (uid === WHOP_USER_ID) mine.push(m);
        continue;
      }
      const inline = extractPayloadEmail(m);
      if (inline) {
        if (inline === EMAIL) mine.push(m);
        continue;
      }
      if (uid && (await whopUserEmail(uid)) === EMAIL) mine.push(m);
    }

    if (mine.length === 0) {
      die(`No Whop membership found for ${EMAIL}${WHOP_USER_ID ? ` / ${WHOP_USER_ID}` : ''}.`);
    }

    console.log(`\nMemberships for this customer (${mine.length}):`);
    for (const m of mine) {
      const end = membershipPeriodEndMs(m);
      console.log(
        `  ${extractMembershipId(m)}  status=${m?.status}  valid=${membershipIsValid(m)}  ` +
          `cancel_at_period_end=${m?.cancel_at_period_end}  periodEnd=${end ? new Date(end).toISOString() : 'null'}`,
      );
    }

    const chosen = pickAuthoritativeMembership(mine);
    if (!chosen) die('Could not pick an authoritative membership.');
    console.log(
      `\nAuthoritative (valid, latest period end): ${extractMembershipId(chosen)}`,
    );
    if (!membershipIsValid(chosen)) {
      console.warn('  ⚠ NOTE: no VALID membership — this customer is not currently entitled.');
    }

    const fields = membershipToSubscriptionFields(chosen, new Date());
    const existing = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { id: true, convertedAt: true, canceledAt: true },
    });

    const createPayload = {
      userId: user.id,
      whopMembershipId: fields.whopMembershipId,
      status: fields.status,
      planId: fields.planId,
      trialEndsAt: fields.trialEndsAt,
      currentPeriodEnd: fields.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
      canceledAt: fields.canceledAt,
      convertedAt: fields.convertedAt,
      paymentMethodAttached: fields.paymentMethodAttached,
    };
    const updatePayload = {
      whopMembershipId: fields.whopMembershipId,
      status: fields.status,
      cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
      paymentMethodAttached: fields.paymentMethodAttached,
      ...(fields.planId ? { planId: fields.planId } : {}),
      ...(fields.currentPeriodEnd ? { currentPeriodEnd: fields.currentPeriodEnd } : {}),
      // Stamp-once columns: fill only when empty, so a re-run never moves them.
      ...(!existing?.convertedAt && fields.convertedAt ? { convertedAt: fields.convertedAt } : {}),
      ...(!existing?.canceledAt && fields.canceledAt ? { canceledAt: fields.canceledAt } : {}),
    };

    const whopUserId = extractWhopUserId(chosen);
    console.log(`\n${existing ? 'UPDATE' : 'CREATE'} Subscription for userId=${user.id}:`);
    console.log(JSON.stringify(existing ? updatePayload : createPayload, null, 2));
    if (whopUserId && !user.whopUserId) {
      console.log(`\nAlso linking User.whopUserId = ${whopUserId} (currently null).`);
    }

    if (DRY) {
      console.log('\n--dry: nothing was written. Re-run without --dry to apply.');
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({
        where: { userId: user.id },
        create: createPayload,
        update: updatePayload,
      });
      if (whopUserId) {
        // Guarded on null so an existing link is never re-pointed.
        await tx.user.updateMany({
          where: { id: user.id, whopUserId: null },
          data: { whopUserId },
        });
      }
      await tx.unmatchedWhopEvent.updateMany({
        where: {
          resolvedAt: null,
          OR: [
            ...(whopUserId ? [{ whopUserId }] : []),
            ...(fields.whopMembershipId ? [{ whopMembershipId: fields.whopMembershipId }] : []),
            { payloadEmail: EMAIL },
          ],
        },
        data: { resolvedUserId: user.id, resolvedAt: new Date() },
      });
    });

    const after = await prisma.subscription.findUnique({ where: { userId: user.id } });
    console.log('\nWritten. Resulting row:');
    console.log(JSON.stringify(after, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
