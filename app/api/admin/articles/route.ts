import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  requireAdmin,
  requireAdminWrite,
  parseBody,
  validateArticleInput,
  badRequest,
  toListRow,
  toFullRecord,
  LIST_SELECT,
} from '@/lib/admin-articles';

/**
 * /api/admin/articles — the guides CMS collection endpoint
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 *   GET  → { articles: [...] }  every article, drafts included, NO body.
 *   POST → create a DRAFT. Never publishes; publishing is its own endpoint so
 *          "save" can never accidentally push content live.
 *
 * Admin-only (see lib/admin-articles.ts for the gate — the same isAdminUser
 * authority the customers and free-access feeds use). Contract is frozen: the
 * admin UI is built against it.
 */

// This route reads a per-request cookie and must never be cached.
export const dynamic = 'force-dynamic';

// ── GET: list ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    // Drafts first (they need attention), then newest-published first — the
    // order an editor wants, not the public order.
    const rows = await db.article.findMany({
      orderBy: [{ status: 'asc' }, { publishedAt: { sort: 'desc', nulls: 'first' } }, { updatedAt: 'desc' }],
      select: LIST_SELECT,
    });

    return NextResponse.json({ articles: rows.map(toListRow) });
  } catch (e) {
    console.error('[AdminArticles] GET error:', e);
    return NextResponse.json({ error: 'Failed to load articles' }, { status: 500 });
  }
}

// ── POST: create a draft ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const gate = await requireAdminWrite(req);
    if (!gate.ok) return gate.res;

    const body = await parseBody(req);
    if (!body) return badRequest([{ field: '_', message: 'Malformed JSON body' }]);

    const parsed = validateArticleInput(body, 'create');
    if (!parsed.ok) return badRequest(parsed.errors);
    const { slug, title, description, body: md, keywords } = parsed.value;

    try {
      const created = await db.article.create({
        data: {
          slug: slug!,
          title: title!,
          description: description ?? '',
          body: md ?? '',
          keywords: keywords ?? [],
          status: 'draft',
          updatedBy: gate.adminEmail,
        },
      });
      return NextResponse.json({ article: toFullRecord(created) }, { status: 201 });
    } catch (e) {
      // P2002 = unique violation on Article.slug. Caught rather than
      // pre-checked with a findUnique so two concurrent creates cannot both
      // pass the check and race into the insert — the DB constraint is the
      // authority, this is just its HTTP translation.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json(
          { error: 'An article with that slug already exists', field: 'slug' },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (e) {
    console.error('[AdminArticles] POST error:', e);
    return NextResponse.json({ error: 'Failed to create article' }, { status: 500 });
  }
}
