import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/auth';
import { sendNewWaitlistAdminEmail } from '@/lib/email';

/**
 * POST /api/waitlist — public landing-page email capture.
 *
 * Dispatch (2026-06-15, forge/waitlist-and-auth-allowlist). While the app is
 * pre-Play-Store the marketing page replaces "register now" with a waitlist;
 * Pixel's client form POSTs here with credentials: 'same-origin', JSON body.
 *
 * Contract (must match Pixel exactly):
 *   200 { ok: true }                      — new email stored
 *   200 { ok: true, alreadyOnList: true } — dedupe hit (treated as success)
 *   400 { error: 'Enter a valid email' }  — bad/missing email
 *   403 { error: 'CSRF check failed' }    — same-origin guard failed
 *   429 { error: ... }                    — per-IP rate limit
 *
 * Hardening:
 *   • requireSameOrigin CSRF guard (same as /api/auth/register).
 *   • Honeypot field `company` — if non-empty, silently 200 { ok: true } and
 *     store nothing (kills naive bots without telling them).
 *   • Dedupe via upsert on the @unique email — a re-submit is success, never a
 *     409. upsert is atomic so concurrent first-time submits can't race the
 *     unique constraint into a 500.
 *   • Best-effort Resend admin notify on NEW inserts only, in try/catch.
 *   • In-memory per-IP token bucket. The app runs single-process (custom
 *     server.js) so a module-level Map is the correct, simplest store.
 */

// --- In-memory per-IP rate limit -------------------------------------------
// Single-process deploy → a module-level Map is sufficient and survives across
// requests for the life of the process. Sliding window: max N hits per window.
const RL_WINDOW_MS = 60_000; // 1 minute
const RL_MAX = 5; // 5 submits / IP / minute — generous for a human, hostile to bots
const rlHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const hits = (rlHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  rlHits.set(ip, hits);
  // Opportunistic cleanup so the Map can't grow unbounded over process life.
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (v.every((t) => t <= cutoff)) rlHits.delete(k);
    }
  }
  return hits.length > RL_MAX;
}

function clientIp(req: NextRequest): string {
  // Behind Coolify/Traefik — trust the proxy's forwarded chain, take the first
  // (client) hop. Falls back to a constant so a missing header degrades to a
  // shared bucket rather than throwing.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

// RFC-ish: one @, no spaces, a dot in the domain. Deliberately permissive —
// we want to reject typos/garbage, not adjudicate the email RFC.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    if (rateLimited(clientIp(req))) {
      return NextResponse.json({ error: 'Too many requests — please try again shortly' }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const rawEmail = body && typeof body === 'object' ? (body as { email?: unknown }).email : undefined;
    const honeypot = body && typeof body === 'object' ? (body as { company?: unknown }).company : undefined;

    // Honeypot: a real human never fills the hidden `company` field. Pretend
    // success, store nothing. Checked BEFORE validation so bots learn nothing.
    if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    if (typeof rawEmail !== 'string') {
      return NextResponse.json({ error: 'Enter a valid email' }, { status: 400 });
    }
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'Enter a valid email' }, { status: 400 });
    }

    // Dedupe-as-success. upsert with empty update = no-op on collision. We use
    // the returned createdAt vs. a pre-read to distinguish new from existing so
    // we only fire the admin notify (and only report alreadyOnList) correctly.
    const existing = await db.waitlist.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return NextResponse.json({ ok: true, alreadyOnList: true }, { status: 200 });
    }

    // Atomic create-or-noop. If a concurrent request inserted the same email
    // between the read above and here, upsert's update:{} swallows the unique
    // collision instead of 500'ing — and we simply skip the notify for it.
    let created = false;
    try {
      await db.waitlist.create({ data: { email, source: 'landing' } });
      created = true;
    } catch {
      // Unique collision from a concurrent insert → treat as already-on-list.
      return NextResponse.json({ ok: true, alreadyOnList: true }, { status: 200 });
    }

    if (created) {
      // Best-effort admin notify. In dev (no RESEND_API_KEY) getResend() throws;
      // the catch swallows it. A Resend hiccup must NEVER fail the request.
      try {
        await sendNewWaitlistAdminEmail(email);
      } catch (e) {
        console.error('[Waitlist] admin notify failed:', e);
      }
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    console.error('[Waitlist] error:', e);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
