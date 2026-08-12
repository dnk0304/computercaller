/**
 * lib/whop-resolve.ts — attach a Whop event/membership to an app account
 * (2026-08-12, dispatch fix/whop-payment-reconcile).
 *
 * THE INCIDENT THIS CLOSES (2026-08-11): a customer paid on Whop and was
 * invisible in the admin panel with no entitlement. Since commit cc5b4ba
 * ("stop auto-creating trial subscriptions at signup") the Whop webhook is the
 * ONLY writer that ever creates a Subscription row — so its account-match is a
 * single point of failure, and it had a hole:
 *
 *   • the modern v1 Membership payload is SLIM (a `user_id`, no user object,
 *     no email), and the only fallback was a lookup by whopMembershipId —
 *     which BY DEFINITION cannot exist for a customer's FIRST purchase,
 *     because nothing has ever written that row. First-time buyer dropped.
 *   • the membership-id fallback only ran when the email was entirely ABSENT.
 *     A present-but-different email fell straight through to "drop".
 *   • every drop returned a bare `{ok:true}` — no trace, no alert.
 *
 * The ladder below tries every rung, in order, each only when the previous
 * failed, and RECORDS the failure when they all do.
 */

import { db } from '@/lib/db';
import { fetchWhopUserEmail, isWhopKeyConfigured } from '@/lib/whop';
import { extractMembershipId, extractPayloadEmail, extractWhopUserId } from '@/lib/whop-core';

/** Which rung matched — logged, and useful when auditing a disputed charge. */
export type WhopMatchVia = 'whopUserId' | 'payloadEmail' | 'membershipId' | 'whopApiEmail';

export interface WhopMatch {
  userId: string;
  via: WhopMatchVia;
}

/** The identifiers a Whop payload can carry, already extracted. */
export interface WhopIdentity {
  email: string | null;
  membershipId: string | null;
  whopUserId: string | null;
}

/** Pull every identifier we know how to match on out of a raw payload. */
export function extractWhopIdentity(payload: unknown): WhopIdentity {
  return {
    email: extractPayloadEmail(payload),
    membershipId: extractMembershipId(payload),
    whopUserId: extractWhopUserId(payload),
  };
}

/**
 * Persist the Whop-user ↔ account link so future events match on an id rather
 * than an email that either side can change.
 *
 * `updateMany` with a `whopUserId: null` guard, deliberately:
 *   • it is idempotent and cannot throw on a re-run;
 *   • it NEVER overwrites an existing link. If two Whop users somehow point at
 *     one account, the first link wins and the second is simply not recorded —
 *     silently re-pointing an account's billing identity is far worse than
 *     leaving one event to match by email.
 * Never throws: a bookkeeping write must not fail a payment webhook.
 */
async function linkWhopUserId(userId: string, whopUserId: string): Promise<void> {
  try {
    await db.user.updateMany({
      where: { id: userId, whopUserId: null },
      data: { whopUserId },
    });
  } catch (e) {
    console.error('[Whop] failed to link whopUserId', whopUserId, e);
  }
}

/**
 * Resolve a Whop event to an app account. Returns null only when every rung
 * failed — which is a real, expected state (the customer paid before he
 * registered), and is exactly the case Part 2 records rather than swallows.
 *
 * Rungs, in order:
 *   1. `whopUserId` on User — the durable link, preferred over everything
 *      because it survives an email change on either side.
 *   2. the email carried on the payload.
 *   3. the membership id → an existing Subscription (a returning customer).
 *   4. the Whop company API: user id → email → account. This is the rung that
 *      would have saved the 2026-08-11 customer. Skipped silently when no real
 *      WHOP_API_KEY is configured.
 *
 * On success, opportunistically records the whopUserId link.
 */
export async function resolveWhopAccount(identity: WhopIdentity): Promise<WhopMatch | null> {
  const { email, membershipId, whopUserId } = identity;

  // Rung 1 — durable id link.
  if (whopUserId) {
    const byId = await db.user.findFirst({ where: { whopUserId }, select: { id: true } });
    if (byId) return { userId: byId.id, via: 'whopUserId' };
  }

  // Rung 2 — email on the payload.
  if (email) {
    const byEmail = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (byEmail) {
      if (whopUserId) await linkWhopUserId(byEmail.id, whopUserId);
      return { userId: byEmail.id, via: 'payloadEmail' };
    }
  }

  // Rung 3 — an existing Subscription for this membership (returning customer).
  // NOTE: this now runs even when an email WAS present but didn't match, which
  // is defect 2 from the incident report.
  if (membershipId) {
    const sub = await db.subscription.findFirst({
      where: { whopMembershipId: membershipId },
      select: { userId: true },
    });
    if (sub) {
      if (whopUserId) await linkWhopUserId(sub.userId, whopUserId);
      return { userId: sub.userId, via: 'membershipId' };
    }
  }

  // Rung 4 — ask Whop who this user id is. The first-purchase blind spot.
  if (whopUserId && isWhopKeyConfigured()) {
    const apiEmail = await fetchWhopUserEmail(whopUserId);
    if (apiEmail && apiEmail !== email) {
      const byApi = await db.user.findUnique({ where: { email: apiEmail }, select: { id: true } });
      if (byApi) {
        await linkWhopUserId(byApi.id, whopUserId);
        return { userId: byApi.id, via: 'whopApiEmail' };
      }
    }
  }

  return null;
}

/**
 * Record a verified-but-unmatched event. Returns the row id, or null if even
 * this write failed.
 *
 * NEVER THROWS. The caller answers Whop 200 either way — a non-2xx would make
 * Whop retry-storm an event we genuinely cannot process yet — but the point of
 * this function is that "we can't process it" stops being invisible. The
 * console.error prefix is deliberately greppable in container logs:
 *   docker logs <app> | grep 'UNMATCHED'
 */
export async function recordUnmatchedWhopEvent(
  eventName: string,
  identity: WhopIdentity,
  rawPayload: unknown,
): Promise<string | null> {
  console.error(
    '[Whop webhook] UNMATCHED',
    JSON.stringify({
      eventName,
      membershipId: identity.membershipId,
      whopUserId: identity.whopUserId,
      payloadEmail: identity.email,
    }),
  );
  try {
    const row = await db.unmatchedWhopEvent.create({
      data: {
        eventName,
        whopMembershipId: identity.membershipId,
        whopUserId: identity.whopUserId,
        payloadEmail: identity.email,
        // Store the whole verified event so it can be replayed or audited. If
        // it isn't JSON-serialisable we still keep the identifiers above.
        rawPayload: (rawPayload ?? {}) as never,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.error('[Whop webhook] UNMATCHED — failed to persist the event', e);
    return null;
  }
}

/**
 * Mark previously-unmatched events for this identity as resolved, once the
 * account finally exists. Best-effort, never throws.
 */
export async function resolveUnmatchedWhopEvents(
  identity: WhopIdentity,
  userId: string,
): Promise<number> {
  const or: Array<Record<string, string>> = [];
  if (identity.whopUserId) or.push({ whopUserId: identity.whopUserId });
  if (identity.membershipId) or.push({ whopMembershipId: identity.membershipId });
  if (identity.email) or.push({ payloadEmail: identity.email });
  if (or.length === 0) return 0;

  try {
    const res = await db.unmatchedWhopEvent.updateMany({
      where: { resolvedAt: null, OR: or },
      data: { resolvedUserId: userId, resolvedAt: new Date() },
    });
    return res.count;
  } catch (e) {
    console.error('[Whop] failed to mark unmatched events resolved', e);
    return 0;
  }
}
