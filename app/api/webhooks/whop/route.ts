import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';

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
      const periodEnd = data?.expires_at
        ? new Date(data.expires_at * 1000)
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

      // Card-on-file (2026-07-03). Best-effort: if a future Whop payload carries
      // an explicit boolean (has_payment_method / payment_method present), honor
      // it; otherwise v1 fallback — a sub that reached 'active' has a card on
      // file (Whop's paid membership requires payment). Trial-only users stay
      // false. See report note: confirming card-on-file DURING a trial needs a
      // Whop API follow-up (GET /memberships/{id}); not blocking the dashboard.
      const explicitCard =
        typeof data?.has_payment_method === 'boolean'
          ? (data.has_payment_method as boolean)
          : typeof data?.user?.has_payment_method === 'boolean'
            ? (data.user.has_payment_method as boolean)
            : null;
      const paymentMethodAttached = explicitCard ?? true;

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
          paymentMethodAttached,
          canceledAt: null,
        },
        update: {
          whopMembershipId: data?.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
          paymentMethodAttached,
          // Re-activation clears any prior cancellation marker.
          canceledAt: null,
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
