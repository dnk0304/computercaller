/**
 * lib/whop-reconcile.ts — make Postgres agree with Whop (2026-08-12, dispatch
 * fix/whop-payment-reconcile).
 *
 * WHY THIS EXISTS. Since commit cc5b4ba the Whop webhook is the ONLY writer
 * that ever creates a Subscription row. One missed or unmatchable event and a
 * paying customer has no entitlement, with nothing in the system that would
 * ever notice or repair it. A webhook is an at-most-once-useful notification;
 * it is not a source of truth. This job makes Whop the source of truth and the
 * database a cache of it, which is the only arrangement that survives a
 * dropped event.
 *
 * GUARANTEES:
 *   • READ-ONLY against Whop. It lists memberships. It never mutates a
 *     membership, never refunds, never changes a plan.
 *   • Never DELETES a Subscription. Worst case it corrects one.
 *   • IDEMPOTENT — a second run writes nothing (every field is diffed before
 *     it is written, and the stamp-once columns are only ever filled when
 *     empty). `unchanged` in the summary is the proof.
 *   • A partial Whop list is safe: it only means some customers were not
 *     visited this run. `complete:false` says so.
 */

import { db } from '@/lib/db';
import { isWhopKeyConfigured, listCompanyMemberships } from '@/lib/whop';
import {
  extractMembershipId,
  extractPayloadEmail,
  extractWhopUserId,
  membershipToSubscriptionFields,
  pickAuthoritativeMembership,
} from '@/lib/whop-core';
import {
  recordUnmatchedWhopEvent,
  resolveUnmatchedWhopEvents,
  resolveWhopAccount,
  type WhopIdentity,
} from '@/lib/whop-resolve';

export interface ReconcileChange {
  membershipId: string | null;
  userId: string;
  email: string | null;
  action: 'created' | 'updated';
  fields: string[];
}

export interface ReconcileSummary {
  dryRun: boolean;
  /** Whop memberships seen. */
  scanned: number;
  /** Distinct customers (grouped by Whop user id). */
  customers: number;
  /** False when a Whop page failed or the page cap was hit. */
  complete: boolean;
  matched: number;
  unmatched: number;
  created: number;
  updated: number;
  unchanged: number;
  changes: ReconcileChange[];
  errors: string[];
}

/** The Subscription columns reconciliation is allowed to touch. */
type SubscriptionWrite = {
  whopMembershipId?: string | null;
  status?: string;
  planId?: string | null;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date;
  convertedAt?: Date;
  paymentMethodAttached?: boolean;
};

/**
 * Record an unmatched membership ONCE. Without this guard every reconcile run
 * would append a fresh row for the same unregistered customer and the job
 * would stop being idempotent.
 */
async function recordUnmatchedOnce(identity: WhopIdentity): Promise<boolean> {
  const or: Array<Record<string, string>> = [];
  if (identity.whopUserId) or.push({ whopUserId: identity.whopUserId });
  if (identity.membershipId) or.push({ whopMembershipId: identity.membershipId });
  if (or.length > 0) {
    const existing = await db.unmatchedWhopEvent.findFirst({
      where: { resolvedAt: null, OR: or },
      select: { id: true },
    });
    if (existing) return false;
  }
  await recordUnmatchedWhopEvent('reconcile.unmatched_membership', identity, {
    source: 'whop-reconcile',
    membershipId: identity.membershipId,
    whopUserId: identity.whopUserId,
  });
  return true;
}

/**
 * Reconcile every Whop membership against the Subscription table.
 *
 * @param opts.dryRun  compute and report the diff, write nothing.
 */
export async function reconcileWhopSubscriptions(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<ReconcileSummary> {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();

  const summary: ReconcileSummary = {
    dryRun,
    scanned: 0,
    customers: 0,
    complete: false,
    matched: 0,
    unmatched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    changes: [],
    errors: [],
  };

  if (!isWhopKeyConfigured()) {
    summary.errors.push('WHOP_API_KEY is not configured — nothing to reconcile against.');
    return summary;
  }

  const { memberships, complete } = await listCompanyMemberships();
  summary.scanned = memberships.length;
  summary.complete = complete;
  if (!complete) {
    summary.errors.push(
      'Whop membership list was incomplete (a page failed or the page cap was hit). ' +
        'Some customers were not visited this run; re-run to finish.',
    );
  }

  // Group by CUSTOMER, not by membership. A customer can hold several
  // memberships — the 2026-08-11 customer holds a cancelled trial AND a live
  // paid subscription — and only one of them may speak for his Subscription
  // row. Memberships with no user id are their own group (they can still match
  // on membership id or a payload email).
  const groups = new Map<string, unknown[]>();
  for (const m of memberships) {
    const key = extractWhopUserId(m) ?? `membership:${extractMembershipId(m) ?? 'unknown'}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }
  summary.customers = groups.size;

  for (const [, group] of groups) {
    try {
      // THE rule: the valid membership with the latest period end. Taking the
      // newest-created one instead would store this customer's CANCELLED trial
      // and expire him mid-subscription.
      const authoritative = pickAuthoritativeMembership(group);
      if (!authoritative) continue;

      const identity: WhopIdentity = {
        email: extractPayloadEmail(authoritative),
        membershipId: extractMembershipId(authoritative),
        whopUserId: extractWhopUserId(authoritative),
      };

      const match = await resolveWhopAccount(identity);
      if (!match) {
        summary.unmatched += 1;
        if (!dryRun) await recordUnmatchedOnce(identity);
        continue;
      }
      summary.matched += 1;

      const fields = membershipToSubscriptionFields(authoritative, now);
      if (!fields) continue;

      const existing = await db.subscription.findUnique({
        where: { userId: match.userId },
        select: {
          whopMembershipId: true,
          status: true,
          planId: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          canceledAt: true,
          convertedAt: true,
          paymentMethodAttached: true,
        },
      });

      if (!existing) {
        // The incident case: Whop has a paid membership and we have no row.
        summary.created += 1;
        summary.changes.push({
          membershipId: fields.whopMembershipId,
          userId: match.userId,
          email: identity.email,
          action: 'created',
          fields: ['*'],
        });
        if (!dryRun) {
          await db.subscription.create({
            data: {
              userId: match.userId,
              whopMembershipId: fields.whopMembershipId,
              status: fields.status,
              planId: fields.planId,
              trialEndsAt: fields.trialEndsAt,
              currentPeriodEnd: fields.currentPeriodEnd ?? null,
              cancelAtPeriodEnd: fields.cancelAtPeriodEnd,
              canceledAt: fields.canceledAt,
              convertedAt: fields.convertedAt,
              paymentMethodAttached: fields.paymentMethodAttached,
            },
          });
          await resolveUnmatchedWhopEvents(identity, match.userId);
        }
        continue;
      }

      // Diff every column before writing. This is what makes a second run a
      // no-op — and it keeps `updatedAt` honest instead of churning it on
      // every scheduled pass.
      const write: SubscriptionWrite = {};
      const changed: string[] = [];

      if (fields.whopMembershipId && existing.whopMembershipId !== fields.whopMembershipId) {
        write.whopMembershipId = fields.whopMembershipId;
        changed.push('whopMembershipId');
      }
      if (existing.status !== fields.status) {
        write.status = fields.status;
        changed.push('status');
      }
      // Never null out a stored plan on a membership that omitted one.
      if (fields.planId && existing.planId !== fields.planId) {
        write.planId = fields.planId;
        changed.push('planId');
      }
      if (
        fields.currentPeriodEnd &&
        existing.currentPeriodEnd?.getTime() !== fields.currentPeriodEnd.getTime()
      ) {
        write.currentPeriodEnd = fields.currentPeriodEnd;
        changed.push('currentPeriodEnd');
      }
      if (existing.cancelAtPeriodEnd !== fields.cancelAtPeriodEnd) {
        write.cancelAtPeriodEnd = fields.cancelAtPeriodEnd;
        changed.push('cancelAtPeriodEnd');
      }
      // Stamp-once columns: fill an empty one, never overwrite. canceledAt is
      // when the customer DECIDED to leave — reconciliation must not move that
      // date to "whenever the job last ran".
      if (!existing.canceledAt && fields.canceledAt) {
        write.canceledAt = fields.canceledAt;
        changed.push('canceledAt');
      }
      if (!existing.convertedAt && fields.convertedAt) {
        write.convertedAt = fields.convertedAt;
        changed.push('convertedAt');
      }
      // Card-on-file is only ever asserted, never cleared: a lapsed membership
      // does not prove the card was removed, and clearing it would make the
      // flag flap on every run.
      if (fields.paymentMethodAttached && !existing.paymentMethodAttached) {
        write.paymentMethodAttached = true;
        changed.push('paymentMethodAttached');
      }

      if (changed.length === 0) {
        summary.unchanged += 1;
        continue;
      }

      summary.updated += 1;
      summary.changes.push({
        membershipId: fields.whopMembershipId,
        userId: match.userId,
        email: identity.email,
        action: 'updated',
        fields: changed,
      });
      if (!dryRun) {
        await db.subscription.update({ where: { userId: match.userId }, data: write });
        await resolveUnmatchedWhopEvents(identity, match.userId);
      }
    } catch (e) {
      // One bad customer must never abort the whole reconciliation.
      summary.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return summary;
}
