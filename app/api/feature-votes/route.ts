import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/auth';
import { Prisma } from '@prisma/client';

/**
 * /api/feature-votes — public "vote on what we build next" widget for the CC
 * homepage (dispatch forge/feature-voting, 2026-09-02).
 *
 * Anonymous, NO login. A visitor is identified by `voterKey`, a SHA-256 hash of
 * (client IP + a first-party anon cookie token this route sets on first sight).
 * That gives a reasonable one-vote-per-person without any signup: neither half
 * alone is enough (shared office IP → distinct cookies; cleared cookie → same
 * IP re-derives a NEW key, so a determined user CAN re-vote, which is an
 * acceptable trade for zero-friction anonymous voting — this is a homepage
 * applause meter, not an election).
 *
 * VOTING IS TOGGLE: POSTing a suggestionId you've already voted for REMOVES the
 * vote (unvote), so users can change their mind. The response's `voted` field
 * reports the resulting state.
 *
 * CONTRACT (Pixel consumes this — keep exact):
 *   GET  /api/feature-votes
 *     200 { suggestions: [ {
 *            id, slug, title, description|null, status,
 *            sortOrder, count, voted            // count:int, voted:bool for THIS voter
 *          } ] }                                // sorted by sortOrder asc, then createdAt
 *     (sets the anon cookie on the response if the caller had none)
 *
 *   POST /api/feature-votes   body: { "suggestionId": "<id>" }
 *     200 { ok: true, suggestionId, voted: boolean, count: number }
 *          // voted = resulting state AFTER the toggle; count = new vote count
 *     400 { error: 'Invalid request' }     — missing/bad suggestionId
 *     403 { error: 'CSRF check failed' }    — same-origin guard failed
 *     404 { error: 'Unknown suggestion' }   — suggestionId does not exist
 *     429 { error: ... }                    — per-IP rate limit
 */

// --- anon cookie ------------------------------------------------------------
const ANON_COOKIE = 'cc_fv_anon';
const ANON_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// --- In-memory per-IP rate limit (single-process custom server → module Map;
// same pattern as /api/waitlist). Guards the POST only. ----------------------
const RL_WINDOW_MS = 60_000;
const RL_MAX = 30; // 30 votes / IP / minute — frictionless for a human, hostile to a script
const rlHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const hits = (rlHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  rlHits.set(ip, hits);
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (v.every((t) => t <= cutoff)) rlHits.delete(k);
    }
  }
  return hits.length > RL_MAX;
}

function clientIp(req: NextRequest): string {
  // Behind Coolify/Traefik — take the first (client) hop of the forwarded chain.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

function voterKeyFrom(ip: string, anonToken: string): string {
  return createHash('sha256').update(`${ip}:${anonToken}`).digest('hex');
}

/**
 * Returns the caller's anon token, minting a fresh one if the cookie is absent.
 * When minted, the caller must write it back with setAnonCookie(res, token).
 */
function readOrMintAnon(req: NextRequest): { token: string; isNew: boolean } {
  const existing = req.cookies.get(ANON_COOKIE)?.value;
  if (existing) return { token: existing, isNew: false };
  return { token: randomUUID(), isNew: true };
}

function setAnonCookie(res: NextResponse, token: string): void {
  res.cookies.set(ANON_COOKIE, token, {
    httpOnly: true, // server-only; the client never needs to read it
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ANON_MAX_AGE,
  });
}

export async function GET(req: NextRequest) {
  const { token, isNew } = readOrMintAnon(req);
  const voterKey = voterKeyFrom(clientIp(req), token);

  const suggestions = await db.featureSuggestion.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      status: true,
      sortOrder: true,
      voteCount: true,
      // Only this voter's row (if any) — cheap existence check per suggestion.
      votes: { where: { voterKey }, select: { id: true }, take: 1 },
    },
  });

  const res = NextResponse.json({
    suggestions: suggestions.map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: s.description,
      status: s.status,
      sortOrder: s.sortOrder,
      count: s.voteCount,
      voted: s.votes.length > 0,
    })),
  });
  if (isNew) setAnonCookie(res, token);
  return res;
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many requests — please try again shortly' },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const suggestionId =
    body && typeof body === 'object' ? (body as { suggestionId?: unknown }).suggestionId : undefined;
  if (typeof suggestionId !== 'string' || suggestionId.length === 0) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Validate the suggestion exists — ignore unknown ids (never create votes for
  // a phantom suggestion).
  const suggestion = await db.featureSuggestion.findUnique({
    where: { id: suggestionId },
    select: { id: true },
  });
  if (!suggestion) {
    return NextResponse.json({ error: 'Unknown suggestion' }, { status: 404 });
  }

  const { token, isNew } = readOrMintAnon(req);
  const voterKey = voterKeyFrom(ip, token);

  // TOGGLE. The denormalised voteCount is mutated in the SAME array-form
  // ($transaction is atomic) as the vote row insert/delete, so the counter can
  // never drift from the row set. The composite @@unique makes the create fail
  // (P2002) when the voter already voted → that's the unvote branch.
  let voted: boolean;
  let count: number;
  try {
    const [, updated] = await db.$transaction([
      db.featureVote.create({ data: { suggestionId, voterKey } }),
      db.featureSuggestion.update({
        where: { id: suggestionId },
        data: { voteCount: { increment: 1 } },
        select: { voteCount: true },
      }),
    ]);
    voted = true;
    count = updated.voteCount;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const [, updated] = await db.$transaction([
        db.featureVote.delete({
          where: { suggestionId_voterKey: { suggestionId, voterKey } },
        }),
        db.featureSuggestion.update({
          where: { id: suggestionId },
          data: { voteCount: { decrement: 1 } },
          select: { voteCount: true },
        }),
      ]);
      voted = false;
      count = updated.voteCount;
    } else {
      throw e;
    }
  }

  const res = NextResponse.json({ ok: true, suggestionId, voted, count });
  if (isNew) setAnonCookie(res, token);
  return res;
}
