import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import {
  requireAdmin,
  requireAdminWrite,
  parseBody,
  validateArticleInput,
  badRequest,
  toFullRecord,
} from '@/lib/admin-articles';

/**
 * /api/admin/articles/[id] — single-article read, update, delete
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 *   GET    → the full record, including body + keywords.
 *   PATCH  → partial update of { slug, title, description, body, keywords }.
 *            Stamps updatedBy. 409 on a slug collision.
 *   DELETE → hard delete.
 *
 * Revalidation: PATCH and DELETE of a PUBLISHED article bust the public ISR
 * cache too. Editing a live page and having the fix sit behind a 5-minute
 * window would be a surprising failure mode, and a deleted article must stop
 * 200-ing immediately. A slug change revalidates BOTH the old and new paths.
 */

export const dynamic = 'force-dynamic';

const FULL_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  body: true,
  keywords: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: true,
} as const;

const NOT_FOUND = () => NextResponse.json({ error: 'Article not found' }, { status: 404 });

// ── GET: full record ─────────────────────────────────────────────────────────
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const { id } = await ctx.params;
    const article = await db.article.findUnique({ where: { id }, select: FULL_SELECT });
    if (!article) return NOT_FOUND();

    return NextResponse.json({ article: toFullRecord(article) });
  } catch (e) {
    console.error('[AdminArticles] GET[id] error:', e);
    return NextResponse.json({ error: 'Failed to load article' }, { status: 500 });
  }
}

// ── PATCH: update ────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdminWrite(req);
    if (!gate.ok) return gate.res;

    const { id } = await ctx.params;
    const body = await parseBody(req);
    if (!body) return badRequest([{ field: '_', message: 'Malformed JSON body' }]);

    const parsed = validateArticleInput(body, 'patch');
    if (!parsed.ok) return badRequest(parsed.errors);

    const existing = await db.article.findUnique({ where: { id }, select: FULL_SELECT });
    if (!existing) return NOT_FOUND();

    const data: Prisma.ArticleUpdateInput = { updatedBy: gate.adminEmail };
    if (parsed.value.slug !== undefined) data.slug = parsed.value.slug;
    if (parsed.value.title !== undefined) data.title = parsed.value.title;
    if (parsed.value.description !== undefined) data.description = parsed.value.description;
    if (parsed.value.body !== undefined) data.body = parsed.value.body;
    if (parsed.value.keywords !== undefined) data.keywords = { set: parsed.value.keywords };

    let updated;
    try {
      updated = await db.article.update({ where: { id }, data, select: FULL_SELECT });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json(
          { error: 'An article with that slug already exists', field: 'slug' },
          { status: 409 },
        );
      }
      throw e;
    }

    // Only a live article has a public cache to bust. A slug rename leaves the
    // OLD URL behind, so revalidate it too or it keeps serving the stale page.
    if (existing.status === 'published') {
      revalidatePath('/guides');
      revalidatePath(`/guides/${existing.slug}`);
      if (updated.slug !== existing.slug) revalidatePath(`/guides/${updated.slug}`);
    }

    return NextResponse.json({ article: toFullRecord(updated) });
  } catch (e) {
    console.error('[AdminArticles] PATCH error:', e);
    return NextResponse.json({ error: 'Failed to update article' }, { status: 500 });
  }
}

// ── DELETE: hard delete ──────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdminWrite(req);
    if (!gate.ok) return gate.res;

    const { id } = await ctx.params;
    const existing = await db.article.findUnique({
      where: { id },
      select: { id: true, slug: true, status: true, title: true },
    });
    if (!existing) return NOT_FOUND();

    await db.article.delete({ where: { id } });

    // Irreversible and it removes a public URL — log who did it. The files in
    // content/guides/ are untouched, so a seeded article deleted here can be
    // restored by re-running the seed script.
    console.warn(
      `[AdminArticles] DELETE by ${gate.adminEmail}: ${existing.slug} (${existing.title})`,
    );

    if (existing.status === 'published') {
      revalidatePath('/guides');
      revalidatePath(`/guides/${existing.slug}`);
    }

    return NextResponse.json({ deleted: true, id: existing.id, slug: existing.slug });
  } catch (e) {
    console.error('[AdminArticles] DELETE error:', e);
    return NextResponse.json({ error: 'Failed to delete article' }, { status: 500 });
  }
}
