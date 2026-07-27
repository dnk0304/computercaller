import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { resolveWhopCardState } from '@/lib/entitlement-core';

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
  plan_CGlYdJJr3Btlu: 30, // Monthly — $5 (the single live plan, 2026-07-05)
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
 * either `expires_at` (unix SECONDS, v2 era; null when non-recurring) or
 * `renewal_period_end` (current schema — "end of the current billing period";
 * unix seconds OR ISO datetime string). Returns null when unusable.
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
  const d = asRecord(data);
  const explicit =
    coercePeriodEnd(d?.expires_at) ?? coercePeriodEnd(d?.renewal_period_end);
  if (explicit && explicit.getTime() > now.getTime()) return explicit;

  const planId = extractPlanId(data);
  const days = (planId && PLAN_TERM_DAYS[planId]) || DEFAULT_TERM_DAYS;
  return new Date(now.getTime() + days * DAY_MS);
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
    const { action, data } = body;

    console.log('[Whop webhook] verified', action, data?.id);

    const email = data?.user?.email?.toLowerCase();
    if (!email) return NextResponse.json({ ok: true });

    const user = await db.user.findUnique({ where: { email } });
    if (!user) return NextResponse.json({ ok: true }); // user not registered yet

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
        },
        update: {
          whopMembershipId: data?.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
          // Re-activation clears any prior cancellation marker.
          canceledAt: null,
          // Only overwrite the card flag on a definite signal (true/false); on
          // unknown (null) omit it so a prior confirmed value is preserved.
          ...(cardState !== null ? { paymentMethodAttached: cardState } : {}),
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
    }

    if (action === 'membership.went_invalid' || action === 'membership.expired') {
      await db.subscription.updateMany({
        where: { userId: user.id },
        data: { status: 'expired', canceledAt: new Date() },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[Whop webhook] Error:', e);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
