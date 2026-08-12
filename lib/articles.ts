import { db } from '@/lib/db';
import { getAllGuides, getGuideBySlug, type Guide } from '@/lib/guides';

/**
 * lib/articles.ts — the DB-backed reader for /guides
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * Replaces the build-time file read on the three public surfaces (the index,
 * /guides/[slug], and the sitemap) so Dennis can publish from the admin panel
 * without a Coolify rebuild. It deliberately returns the SAME `Guide` shape
 * lib/guides.ts already returns, so the page components barely changed.
 *
 * ── THE FALLBACK RULE (non-negotiable) ──────────────────────────────────────
 * These are 17 live SEO pages. A bad migration, a dropped table, an unreachable
 * database, or an un-seeded environment must NEVER be able to blank /guides.
 * So every reader here falls back to the file-based lib/guides.ts when — and
 * ONLY when — one of two things is true:
 *
 *   (a) the query THREW (table missing, DB down, client out of date), or
 *   (b) the Article table is EMPTY (nothing has been seeded yet).
 *
 * Note what is deliberately NOT a fallback trigger: a populated table in which
 * the requested slug is absent or is a DRAFT. Falling back there would
 * resurrect the file copy of an article an admin has explicitly unpublished —
 * a draft leaking onto a public URL. Once the table has rows it is the single
 * source of truth, and a missing/draft slug is a genuine 404. That is why
 * getArticleBySlug() does a cheap count() first rather than treating
 * "no row for this slug" as "the DB isn't ready".
 *
 * Both queries run behind ISR (`revalidate = 300` on the guides routes), so the
 * count + fetch pair executes at most once per route per 5 minutes, and the
 * publish/unpublish admin actions call revalidatePath() to bust it immediately.
 */

/** The subset of Article columns the public pages actually need. */
const ARTICLE_SELECT = {
  slug: true,
  title: true,
  description: true,
  body: true,
  keywords: true,
  publishedAt: true,
  createdAt: true,
} as const;

type ArticleRow = {
  slug: string;
  title: string;
  description: string;
  body: string;
  keywords: string[];
  publishedAt: Date | null;
  createdAt: Date;
};

/**
 * Article row → the `Guide` shape the pages render.
 *
 * `date` is the frontmatter-compatible YYYY-MM-DD string the existing UI
 * expects (formatGuideDate, <time dateTime>, JSON-LD datePublished, sitemap
 * lastModified). publishedAt is authoritative; createdAt is the backstop for a
 * row that somehow reads as published with no stamp.
 */
function toGuide(row: ArticleRow): Guide {
  const stamp = row.publishedAt ?? row.createdAt;
  return {
    title: row.title,
    description: row.description,
    slug: row.slug,
    date: stamp.toISOString().slice(0, 10),
    keywords: row.keywords,
    content: row.body,
  };
}

/**
 * Published articles, newest first. Drafts are excluded at the SQL level, so
 * they can never reach the index, generateStaticParams, or the sitemap.
 *
 * Ordering: publishedAt desc with nulls last, then createdAt desc as the
 * tiebreaker — same "newest first" the file reader produced.
 */
export async function getAllArticles(): Promise<Guide[]> {
  try {
    const rows = await db.article.findMany({
      where: { status: 'published' },
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: ARTICLE_SELECT,
    });
    // Empty table → nothing has been seeded. Serve the files, not a blank page.
    if (rows.length === 0) return getAllGuides();
    return rows.map(toGuide);
  } catch (e) {
    console.error('[articles] getAllArticles failed, falling back to files:', e);
    return getAllGuides();
  }
}

/**
 * One published article by slug, or null.
 *
 * The count() is the fallback discriminator described in the module header: it
 * separates "the CMS isn't populated yet" (→ serve the file) from "the CMS is
 * populated and this slug is absent or a draft" (→ a real 404). Without it a
 * draft would still be reachable at its public URL via the file copy.
 */
export async function getArticleBySlug(slug: string): Promise<Guide | null> {
  try {
    const total = await db.article.count();
    if (total === 0) return getGuideBySlug(slug);

    const row = await db.article.findFirst({
      where: { slug, status: 'published' },
      select: ARTICLE_SELECT,
    });
    return row ? toGuide(row) : null;
  } catch (e) {
    console.error('[articles] getArticleBySlug failed, falling back to files:', e);
    return getGuideBySlug(slug);
  }
}

// Re-exported so the page components keep a single import from '@/lib/articles'
// and the date formatting stays identical to the file-based rendering.
export { formatGuideDate } from '@/lib/guides';
export type { Guide } from '@/lib/guides';
