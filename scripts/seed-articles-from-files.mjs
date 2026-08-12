/**
 * scripts/seed-articles-from-files.mjs — one-way import of content/guides/*.md
 * into the Article table (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * This is the bridge that moves the 17 existing guides out of the repo and into
 * the CMS. The files are NOT deleted afterwards: they remain the seed source
 * and the runtime fallback lib/articles.ts uses when the table is empty.
 *
 * PARSE CONTRACT: identical to lib/guides.ts — same gray-matter call, same
 * field coercions, same "no title → skip", same slug derivation (frontmatter
 * `slug`, else the filename minus `.md`), same "an unreadable file is skipped,
 * never fatal". If lib/guides.ts ever changes, change this to match, or the
 * seeded rows will differ from the fallback they replace.
 *
 * ── IDEMPOTENCY RULE (the important part) ───────────────────────────────────
 * Running this twice must never duplicate an article, and must never clobber an
 * edit Dennis made in the admin panel. The guard is `updatedBy`:
 *
 *   • Row absent            → CREATE it, status 'published', publishedAt from
 *                             the frontmatter `date`.
 *   • Row exists, updatedBy IS NULL  → UPDATE it from the file. The row is
 *                             still pristine machine-seeded content, so a
 *                             corrected .md can be re-imported.
 *   • Row exists, updatedBy IS NOT NULL → SKIP, untouched. A human has edited
 *                             this article; the DB is now authoritative and the
 *                             file is a stale historical copy.
 *
 * Every admin mutation stamps updatedBy, and this script never sets it, so the
 * flag is a reliable "a human owns this row now" marker. Publish state is NEVER
 * changed on an existing row either — re-seeding cannot silently re-publish
 * something an admin unpublished.
 *
 * Usage:
 *   node scripts/seed-articles-from-files.mjs --dry    # report only, no writes
 *   node scripts/seed-articles-from-files.mjs          # apply
 *
 * DO NOT RUN AGAINST PRODUCTION casually — it is Ken's to run. Pass
 * --i-know-this-is-prod to allow a non-local DATABASE_URL; without it the
 * script refuses any host that is not localhost/127.0.0.1.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import matter from 'gray-matter';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALLOW_REMOTE = argv.includes('--i-know-this-is-prod');

const GUIDES_DIR = path.join(process.cwd(), 'content', 'guides');

/** Refuse a remote database unless explicitly acknowledged. */
function assertTargetAllowed() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }
  if (ALLOW_REMOTE) return;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // A non-URL DATABASE_URL (e.g. a sqlite file: path) is not a remote DB.
    return;
  }
  // Positive allow-list, not a blocklist: anything not provably local is
  // treated as production.
  const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);
  if (!LOCAL.has(host)) {
    console.error(
      `DATABASE_URL points at "${host}", which is not local.\n` +
        'Re-run with --i-know-this-is-prod if that is genuinely intended.',
    );
    process.exit(1);
  }
}

/**
 * Parse one file. Mirrors lib/guides.ts::parseGuideFile exactly, and
 * additionally returns the frontmatter keywords/date needed for the row.
 * Returns null for anything that is not a publishable guide.
 */
function parseGuideFile(filename) {
  try {
    const raw = fs.readFileSync(path.join(GUIDES_DIR, filename), 'utf8');
    const { data, content } = matter(raw);
    const title = typeof data.title === 'string' ? data.title : '';
    const slug =
      typeof data.slug === 'string' && data.slug.trim()
        ? data.slug.trim()
        : filename.replace(/\.md$/, '');
    if (!title) return null;
    return {
      title,
      description: typeof data.description === 'string' ? data.description : '',
      slug,
      date: typeof data.date === 'string' ? data.date : '',
      keywords: Array.isArray(data.keywords)
        ? data.keywords.filter((k) => typeof k === 'string')
        : [],
      content,
    };
  } catch (e) {
    console.warn(`  ! skipped ${filename}: ${e.message}`);
    return null;
  }
}

/**
 * Frontmatter date → publishedAt. `date` is a bare YYYY-MM-DD with no zone;
 * parsing it as UTC midnight keeps the rendered date identical to what
 * formatGuideDate() (timeZone: 'UTC') shows today. An unparseable/absent date
 * falls back to now, so the row is still a valid published article.
 */
function toPublishedAt(date) {
  if (!date) return new Date();
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function main() {
  assertTargetAllowed();

  let files;
  try {
    files = fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch {
    console.error(`No readable content directory at ${GUIDES_DIR}. Nothing to seed.`);
    process.exit(1);
  }

  const guides = files.map(parseGuideFile).filter(Boolean);

  console.log(`Articles seed ${DRY ? '(DRY RUN — no writes)' : '(APPLY)'}`);
  console.log(`  source : ${GUIDES_DIR}`);
  console.log(`  files  : ${files.length} .md → ${guides.length} parseable\n`);

  // Duplicate slugs across two files would make the run order-dependent. Fail
  // loudly rather than let the last writer silently win.
  const seen = new Map();
  for (const g of guides) {
    if (seen.has(g.slug)) {
      console.error(`Duplicate slug "${g.slug}" in content/guides/. Fix the files first.`);
      process.exit(1);
    }
    seen.set(g.slug, g);
  }

  const prisma = new PrismaClient();
  const counts = { created: 0, updated: 0, skipped: 0 };

  try {
    for (const g of guides) {
      const existing = await prisma.article.findUnique({
        where: { slug: g.slug },
        select: { id: true, updatedBy: true, status: true },
      });

      if (!existing) {
        counts.created += 1;
        console.log(`  CREATE  ${g.slug}  (published ${g.date || 'now'})`);
        if (!DRY) {
          await prisma.article.create({
            data: {
              slug: g.slug,
              title: g.title,
              description: g.description,
              body: g.content,
              keywords: g.keywords,
              status: 'published',
              publishedAt: toPublishedAt(g.date),
            },
          });
        }
        continue;
      }

      if (existing.updatedBy) {
        counts.skipped += 1;
        console.log(`  SKIP    ${g.slug}  (edited in admin by ${existing.updatedBy})`);
        continue;
      }

      counts.updated += 1;
      console.log(`  UPDATE  ${g.slug}  (never edited in admin; status stays '${existing.status}')`);
      if (!DRY) {
        // status/publishedAt deliberately absent: re-seeding refreshes CONTENT,
        // never publication state.
        await prisma.article.update({
          where: { slug: g.slug },
          data: {
            title: g.title,
            description: g.description,
            body: g.content,
            keywords: { set: g.keywords },
          },
        });
      }
    }

    // Rows in the DB with no corresponding file. Reported, never deleted —
    // articles created in the admin panel legitimately have no file.
    const dbSlugs = await prisma.article.findMany({ select: { slug: true } });
    const orphans = dbSlugs.map((r) => r.slug).filter((s) => !seen.has(s));
    if (orphans.length > 0) {
      console.log(`\n  ${orphans.length} DB article(s) with no file (left untouched):`);
      for (const s of orphans) console.log(`    - ${s}`);
    }

    console.log(
      `\nDone. created=${counts.created} updated=${counts.updated} skipped=${counts.skipped}` +
        (DRY ? '  (DRY RUN — nothing was written)' : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
