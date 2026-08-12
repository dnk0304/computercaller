import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireAdminWrite, toFullRecord } from '@/lib/admin-articles';

/**
 * POST /api/admin/articles/[id]/unpublish — take an article back to draft
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * The escape hatch for a bad publish: the article vanishes from /guides, from
 * /guides/[slug] (404), and from the sitemap within one revalidatePath, with no
 * deploy.
 *
 * publishedAt is deliberately PRESERVED. It records when the article first went
 * live; clearing it would re-date the page on the next publish. `status` alone
 * is what every public read filters on (see lib/articles.ts), so keeping the
 * stamp cannot leak a draft.
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
    const existing = await db.article.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Article not found' }, { status: 404 });

    const updated = await db.article.update({
      where: { id },
      data: { status: 'draft', updatedBy: gate.adminEmail },
      select: FULL_SELECT,
    });

    revalidatePath('/guides');
    revalidatePath(`/guides/${updated.slug}`);

    console.warn(`[AdminArticles] UNPUBLISH by ${gate.adminEmail}: ${updated.slug}`);

    return NextResponse.json({ article: toFullRecord(updated), revalidated: true });
  } catch (e) {
    console.error('[AdminArticles] unpublish error:', e);
    return NextResponse.json({ error: 'Failed to unpublish article' }, { status: 500 });
  }
}
