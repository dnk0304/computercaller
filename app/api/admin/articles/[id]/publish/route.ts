import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireAdminWrite, toFullRecord } from '@/lib/admin-articles';

/**
 * POST /api/admin/articles/[id]/publish — put an article live
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * This is the whole point of the CMS: it replaces a multi-minute Coolify
 * container rebuild with a write + two revalidatePath() calls, so a publish is
 * visible in seconds.
 *
 * publishedAt is stamped ONLY when null. Re-publishing an article that was
 * unpublished and fixed keeps its ORIGINAL publication date, so the JSON-LD
 * datePublished, the visible <time>, and the sitemap lastModified don't churn
 * and re-date a page Google has already indexed.
 *
 * Idempotent: publishing an already-published article is a no-op write plus a
 * cache bust — which is also a useful "force a refresh" button.
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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdminWrite(req);
    if (!gate.ok) return gate.res;

    const { id } = await ctx.params;
    const existing = await db.article.findUnique({
      where: { id },
      select: { id: true, title: true, publishedAt: true, body: true },
    });
    if (!existing) return NextResponse.json({ error: 'Article not found' }, { status: 404 });

    // Refuse to publish an empty shell — a live SEO URL with no content is
    // worse than no URL at all.
    if (!existing.body.trim()) {
      return NextResponse.json(
        { error: 'Cannot publish an article with an empty body', field: 'body' },
        { status: 400 },
      );
    }

    const updated = await db.article.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: existing.publishedAt ?? new Date(),
        updatedBy: gate.adminEmail,
      },
      select: FULL_SELECT,
    });

    revalidatePath('/guides');
    revalidatePath(`/guides/${updated.slug}`);

    console.log(`[AdminArticles] PUBLISH by ${gate.adminEmail}: ${updated.slug}`);

    return NextResponse.json({ article: toFullRecord(updated), revalidated: true });
  } catch (e) {
    console.error('[AdminArticles] publish error:', e);
    return NextResponse.json({ error: 'Failed to publish article' }, { status: 500 });
  }
}
