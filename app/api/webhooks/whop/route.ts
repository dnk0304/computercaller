import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { resolveWhopCardState, resolveWhopCancellation } from '@/lib/entitlement-core';

// Whop sends membership / payment webhooks signed with HMAC-SHA256 over the
// raw request body using WHOP_WEBHOOK_SECRET. Header: "x-whop-signature".
//
// We MUST verify before processing — an unsigned POST could flip any user's
// subscription to "active" forever. Verification uses Node's
// timingSafeEqual to defeat timing oracles.
//
// Whop's signature format (per their docs / dashboard): the header value is
// the lowercase hex digest. Some Whop tenants prefix with "sha256=" or
// "t=...,v1=...". We accept both — strip any prefix, take the trailing hex,
// constant-time compare.

const WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET ?? '';

const DAY_MS = 24 * 60 * 60 * 1000;

// Known plan terms for product prod_cyc65yqHR5ilm (verified live via Whop admin
// API, 2026-07-03). Whop plan IDs are stable identifiers. This map is used ONLY
// as a fallback to size the paid period when the event carries NO explicit
// period-end field — so a 90-day or 365-day term can never be silently
// under-set to a month and lock a paying customer out early (entitlement rule 4:
// active && currentPeriodEnd > now).
const PLAN_TERM_DAYS: Record<string, number> = {
  // ⚠️ Internal key vs display name: `plus` displays as "Pro", `pro` as "Pro+".
  // See lib/tiers-core.js — the tier mapping itself lives there and this map is
  // ONLY about how long a period lasts, never about entitlement.
  //
  // Current 3-tier plans (Dennis, 2026-08-11). All monthly.
  plan_6DJ4H4iPEQo5X: 30, // solo → "Solo"  — $6/mo
  plan_IvKRyvHtl4Q8w: 30, // plus → "Pro"   — $7/mo
  plan_h587GLZLlOXP4: 30, // pro  → "Pro+"  — $9/mo
  // Superseded ids, kept so an existing subscriber's period is never under-set.
  plan_CGlYdJJr3Btlu: 30, // solo — $5/mo (grandfathered)
  plan_Ogrl3wQ8GM8zr: 30, // plus — $7/mo (superseded id)
  plan_lOhMcnZspvgnm: 30, // pro  — $10/mo (superseded id)
  // Legacy plans (retired from sale 2026-07-05, kept so existing subscribers'
  // periods are never under-set):
  plan_1nEzOOzXxPDJC: 30, // Monthly — $9
  plan_ZaT3fHVgy7s3e: 90, // 3-Month — $25
  plan_wC4X437WlTdy3: 365, // Annual — $90
};

// Truly unknown plan id: fall back to ~monthly. Deliberately conservative — a
// short period just means the sub re-validates sooner on the next Whop event,
// never a wrongful lockout of a known long term (those are in PLAN_TERM_DAYS).
const DEFAULT_TERM_DAYS = 31;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Extract the plan id from a Whop membership webhook payload. Whop's schema has
 * drifted across API versions, so read all known shapes defensively:
 *   - `plan_id` (string)         — v2-era
 *   - `plan` (string)            — plan id inline
 *   - `plan` ({ id: string })    — newer nested plan object
 */
function extractPlanId(data: unknown): string | null {
  const d = asRecord(data);
  if (!d) return null;
  if (typeof d.plan_id === 'string' && d.plan_id) return d.plan_id;
  if (typeof d.plan === 'string' && d.plan) return d.plan;
  const plan = asRecord(d.plan);
  if (plan && typeof plan.id === 'string' && plan.id) return plan.id;
  return null;
}

/**
 * Coerce a Whop period-end value to a Date. Whop expresses the term end as
 * `expires_at` (unix SECONDS, v2 era; null when non-recurring),
 * `renewal_period_end` (v5 — unix seconds), or `current_period_end` (the v1
 * webhook Membership object — ISO 8601 string). Handles all three unit
 * conventions. Returns null when unusable.
 *
 * NOTE (verified 2026-08-11 against Whop's live OpenAPI spec): Whop's own spec
 * CONTRADICTS itself on the renewal/cancel timestamps — the prose says "as a
 * Unix timestamp" while `format` and the examples are ISO 8601. That is exactly
 * why this coercion sniffs the runtime type instead of trusting a documented
 * unit, and why the >1e12 millisecond guard stays.
 */
function coercePeriodEnd(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Whop uses unix seconds (~1.7e9). Guard against a millisecond value
    // (>1e12) just in case a future payload changes units.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return coercePeriodEnd(n);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Determine currentPeriodEnd for a membership.went_valid / payment.succeeded
 * event, correct for ANY term (30 / 90 / 365-day). Priority:
 *   1) explicit period end carried by the event — expires_at OR
 *      renewal_period_end — but only if it is in the FUTURE (a went_valid with a
 *      past period-end is a bad value that would instantly lock the user out);
 *   2) known plan-id → term-days map (this product's 3 plans);
 *   3) DEFAULT_TERM_DAYS for a truly unknown plan.
 * Never throws — a webhook must not 500 on a missing/odd field.
 */
function computePeriodEnd(data: unknown, now: Date = new Date()): Date {
  const explicit = extractPeriodEnd(data);
  if (explicit && explicit.getTime() > now.getTime()) return explicit;

  const planId = extractPlanId(data);
  const days = (planId && PLAN_TERM_DAYS[planId]) || DEFAULT_TERM_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * The period end explicitly carried by an event, across every Whop generation:
 * `expires_at` (v2) | `renewal_period_end` (v5) | `current_period_end` (v1).
 * `current_period_end` was previously UNREAD — it is the only period field the
 * modern v1 webhook Membership payload carries, so a v1-versioned endpoint had
 * no explicit source at all and always fell through to the plan-term estimate.
 * Returns null when the event carries none of them.
 */
function extractPeriodEnd(data: unknown): Date | null {
  const d = asRecord(data);
  if (!d) return null;
  return (
    coercePeriodEnd(d.expires_at) ??
    coercePeriodEnd(d.renewal_period_end) ??
    coercePeriodEnd(d.current_period_end)
  );
}

/**
 * Normalise the event name across Whop's THREE webhook generations. Verified
 * against Whop's live OpenAPI spec (2026-08-11):
 *   - legacy v2/v5 envelope: `{ action, company, data }`
 *   - modern v1 envelope:    `{ id, type, timestamp, api_version, data }`
 * and both dot (`membership.went_valid`) and underscore
 * (`membership_went_valid`) spellings are accepted event identifiers.
 *
 * A webhook endpoint's `api_version` defaults to v2 on creation, so THIS route
 * has only ever seen `{ action }` + dotted names. Reading `type` and folding
 * underscores costs nothing and means the route keeps working if the endpoint
 * is ever recreated at v1 — which matters because
 * `membership.cancel_at_period_end_changed` is documented on the modern list.
 */
function extractEventName(body: unknown): string {
  const b = asRecord(body);
  const raw =
    (typeof b?.action === 'string' && b.action) ||
    (typeof b?.type === 'string' && b.type) ||
    '';
  // `membership_went_valid` → `membership.went_valid`. Only the KNOWN namespace
  // prefix is a boundary — a blind first-underscore split would mangle both
  // `app_membership_*` (→ "app.membership_*") and the event name
  // `cancel_at_period_end_changed`, which must keep its underscores.
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(app_membership|app_payment|membership|payment|resolution)_/, '$1.');
}

function extractSignatureHex(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // Pattern A: bare hex digest, e.g. "abc123..."
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  // Pattern B: "sha256=abc123..."
  const eqMatch = trimmed.match(/^sha256=([a-f0-9]{64})$/i);
  if (eqMatch) return eqMatch[1].toLowerCase();

  // Pattern C: comma-separated key=value, look for v1= or sha256=
  for (const part of trimmed.split(',')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const key = k.trim().toLowerCase();
    const val = v.trim();
    if ((key === 'v1' || key === 'sha256' || key === 'signature') && /^[a-f0-9]{64}$/i.test(val)) {
      return val.toLowerCase();
    }
  }
  return null;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  // Buffer.from with mismatched lengths makes timingSafeEqual throw, which
  // would itself be a timing oracle. Pad to equal length first; the !== check
  // on length is constant relative to inputs (just the length numbers).
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    // Read the raw body as text BEFORE parsing JSON. HMAC is computed over
    // the exact bytes Whop signed — re-serializing the parsed object would
    // produce a different byte sequence (key order, whitespace) and fail
    // every signature. Once we've verified, parse the same string we hashed.
    const rawBody = await req.text();

    if (!WEBHOOK_SECRET) {
      // Fail closed. If the secret env var is missing the deploy is misconfigured
      // — never process an unsigned-effectively-anonymous webhook in production.
      console.error('[Whop webhook] WHOP_WEBHOOK_SECRET not set — rejecting.');
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    const headerSig = extractSignatureHex(req.headers.get('x-whop-signature'));
    if (!headerSig) {
      console.warn('[Whop webhook] Missing/malformed x-whop-signature header.');
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
    }

    const computedSig = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody, 'utf8')
      .digest('hex');

    if (!timingSafeHexEqual(headerSig, computedSig)) {
      console.warn('[Whop webhook] Signature mismatch — rejecting.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Signature verified — safe to parse and process.
    const body = JSON.parse(rawBody);
    const { data } = body;
    // Envelope-agnostic event name (v2 `action` | v1 `type`, dot|underscore).
    const action = extractEventName(body);

    console.log('[Whop webhook] verified', action, data?.id);

    const membershipId: string | null =
      typeof data?.id === 'string' && data.id ? data.id : null;

    // Resolve the account. Primary: the email on the payload (legacy v2/v5
    // carries a nested `user` object). FALLBACK: the modern v1 Membership
    // payload is SLIM — it has `user_id` but NO user object and therefore no
    // email, so an email-only lookup would silently drop every v1 event. Fall
    // back to the membership id we already stored at conversion time.
    const email: string | undefined = data?.user?.email?.toLowerCase();
    const user = email
      ? await db.user.findUnique({ where: { email } })
      : membershipId
        ? (
            await db.subscription.findFirst({
              where: { whopMembershipId: membershipId },
              select: { user: { select: { id: true } } },
            })
          )?.user ?? null
        : null;
    if (!user) return NextResponse.json({ ok: true }); // user not registered yet

    // Cancellation intent carried by THIS event (true | false | null=unknown).
    // Read on every event, not just the cancellation one: a membership payload
    // carries `cancel_at_period_end` regardless of which action delivered it, so
    // any event we already receive can record the intent. `null` means the field
    // was absent — callers below preserve the stored value rather than clearing
    // it (same null-preserving discipline as the card flag).
    const cancelIntent = resolveWhopCancellation(data);

    // Mid-period cancellation (2026-08-11). Whop keeps the membership VALID and
    // only flips `cancel_at_period_end`; NO membership.went_invalid fires until
    // the paid period actually lapses. Before this branch such a customer read
    // as a happy "Paying" row right up until they silently vanished.
    //
    // Deliberately does NOT touch `status` — they are still active and still
    // entitled to everything they paid for until currentPeriodEnd. This records
    // the churn signal only. It also fires on UNCANCEL (Whop's
    // cancel_at_period_end_changed is a toggle, both directions), which is why
    // we branch on the boolean rather than on the event name alone.
    if (action === 'membership.cancel_at_period_end_changed' && cancelIntent !== null) {
      const now = new Date();
      const periodEnd = extractPeriodEnd(data);
      await db.subscription.updateMany({
        where: { userId: user.id },
        data: {
          cancelAtPeriodEnd: cancelIntent,
          // canceledAt is the moment we FIRST learned of the cancellation. On
          // an uncancel we clear it so the row stops advertising churn.
          ...(cancelIntent ? {} : { canceledAt: null }),
          // Keep the access-until date fresh when the event carries one — it is
          // the date the UI shows as "cancels <date>".
          ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        },
      });
      if (cancelIntent) {
        // Stamp ONCE (guarded on null) so a re-fire of the toggle can't move the
        // original cancellation date forward.
        await db.subscription.updateMany({
          where: { userId: user.id, canceledAt: null },
          data: { canceledAt: now },
        });
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'membership.went_valid' || action === 'payment.succeeded') {
      // Term-correct period end for ANY plan (30/90/365-day). Trusts the event's
      // explicit period end (expires_at | renewal_period_end) when present and in
      // the future; otherwise derives the term from the plan id so a long term is
      // never under-set to a month. See computePeriodEnd above.
      const periodEnd = computePeriodEnd(data);

      // Card-on-file (2026-07-27 fix). resolveWhopCardState returns:
      //   true  — positively confirmed (explicit flag true, OR payment.succeeded
      //           = a real charge cleared, so a card is on file).
      //   false — positively no card (explicit flag false).
      //   null  — UNKNOWN (e.g. membership.went_valid with no flag — a NO-CARD
      //           Whop trial). Previously this defaulted to `true`, recording
      //           every no-card trial as a card-attached paying conversion and
      //           making the admin dashboard lie about who actually has a card.
      // On `null` we DO NOT assert a card: the create branch defaults false, and
      // the update branch omits the column entirely so a prior confirmed `true`
      // (e.g. from an earlier payment.succeeded) is never downgraded by a later
      // ambiguous went_valid.
      const cardState = resolveWhopCardState(action, data);

      // Persist the plan id → billing tier (2026-07-27, dispatch
      // feature/tier-gating). extractPlanId already reads it (it was previously
      // used ONLY to size currentPeriodEnd and then discarded). We now store it
      // so lib/tiers-core.planIdToTier can resolve the tier on every entitlement
      // check. On both branches we only WRITE planId when the event carries one
      // (non-null) so an ambiguous event without a plan id never nulls out a
      // previously-stored plan. A stored null (or never-set) → Solo via the
      // planIdToTier safe default (the backfill rule).
      const eventPlanId = extractPlanId(data);

      const now = new Date();

      await db.subscription.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          whopMembershipId: data?.id,
          status: 'active',
          trialEndsAt: new Date(),
          currentPeriodEnd: periodEnd,
          // Brand-new row created directly at 'active' → this IS the conversion.
          convertedAt: now,
          // Only assert a card when positively confirmed; unknown (null) → false.
          paymentMethodAttached: cardState === true,
          canceledAt: null,
          // A brand-new row: trust the event's flag, default to not-cancelled.
          cancelAtPeriodEnd: cancelIntent === true,
          // Store the tier's plan id when present; null → Solo default.
          planId: eventPlanId,
        },
        update: {
          whopMembershipId: data?.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
          // Cancellation markers are cleared ONLY on a positive not-cancelled
          // signal (cancelIntent === false), never on an ambiguous event.
          //
          // This is a deliberate change from the old unconditional
          // `canceledAt: null`: a customer who cancels mid-period stays valid,
          // so a later payment.succeeded / re-fired went_valid that happens to
          // omit the flag would have ERASED the churn signal we just recorded.
          // Whop's membership object does carry `cancel_at_period_end`, so a
          // genuine renewal still clears it — see resolveWhopCancellation.
          ...(cancelIntent === false ? { canceledAt: null, cancelAtPeriodEnd: false } : {}),
          ...(cancelIntent === true ? { cancelAtPeriodEnd: true } : {}),
          // Only overwrite the card flag on a definite signal (true/false); on
          // unknown (null) omit it so a prior confirmed value is preserved.
          ...(cardState !== null ? { paymentMethodAttached: cardState } : {}),
          // Only overwrite planId when the event carries one — never null out a
          // previously-stored plan on an event that omitted it.
          ...(eventPlanId ? { planId: eventPlanId } : {}),
        },
      });

      // Stamp convertedAt exactly ONCE — the first time this sub becomes active.
      // updateMany with convertedAt:null guard is idempotent: re-fires of
      // went_valid/payment.succeeded won't overwrite the original "paying since"
      // timestamp. (The create branch above already set it, so this only fills
      // rows that transitioned trial→active via the update branch.)
      await db.subscription.updateMany({
        where: { userId: user.id, convertedAt: null },
        data: { convertedAt: now },
      });

      // If this event ALSO reported a scheduled cancellation, stamp the date
      // once (same null guard). A renewal that arrives already-cancelled is a
      // real Whop shape: the customer cancelled during the prior period.
      if (cancelIntent === true) {
        await db.subscription.updateMany({
          where: { userId: user.id, canceledAt: null },
          data: { canceledAt: now },
        });
      }
    }

    if (action === 'membership.went_invalid' || action === 'membership.expired') {
      // The period has now actually lapsed. Distinguish VOLUNTARY churn
      // (the customer cancelled — we recorded cancelAtPeriodEnd, or this event
      // says so) from INVOLUNTARY churn (failed payment / chargeback / revoke).
      // Both are equally non-entitled — lib/entitlement-core.js rule (7) denies
      // either — but they are very different numbers commercially, and until
      // now 'cancelled' was NEVER written despite the schema documenting it.
      const existing = await db.subscription.findUnique({
        where: { userId: user.id },
        select: { cancelAtPeriodEnd: true, canceledAt: true },
      });
      const voluntary = cancelIntent === true || existing?.cancelAtPeriodEnd === true;

      await db.subscription.updateMany({
        where: { userId: user.id },
        data: {
          status: voluntary ? 'cancelled' : 'expired',
          // Preserve the ORIGINAL cancellation date when we already have one —
          // that is when the customer decided to leave, which is the useful
          // number. Only stamp now for a row we never saw cancel.
          ...(existing?.canceledAt ? {} : { canceledAt: new Date() }),
          // The scheduled-cancellation flag has served its purpose; `status`
          // now carries the signal. Reset so the row can't read as both
          // "ended" and "cancels at period end".
          cancelAtPeriodEnd: false,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[Whop webhook] Error:', e);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
