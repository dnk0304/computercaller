import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

/**
 * Guides content reader — the single source of truth for /guides.
 *
 * Content contract (owned by marketing): Markdown files in `content/guides/`
 * with frontmatter { title, description, slug, date, keywords[] }. This module
 * is deliberately defensive: the folder may not exist at build time (the
 * content agent may land files after this code ships), and a malformed file
 * must never fail the build — it's skipped instead.
 */

export interface GuideMeta {
  title: string;
  description: string;
  slug: string;
  /** ISO date string from frontmatter, e.g. "2026-07-06". */
  date: string;
  keywords: string[];
}

export interface Guide extends GuideMeta {
  /** Raw Markdown body (frontmatter stripped). */
  content: string;
}

const GUIDES_DIR = path.join(process.cwd(), 'content', 'guides');

function parseGuideFile(filename: string): Guide | null {
  try {
    const raw = fs.readFileSync(path.join(GUIDES_DIR, filename), 'utf8');
    const { data, content } = matter(raw);
    const title = typeof data.title === 'string' ? data.title : '';
    const slug =
      typeof data.slug === 'string' && data.slug.trim()
        ? data.slug.trim()
        : filename.replace(/\.md$/, '');
    if (!title) return null; // No title → not a publishable guide; skip.
    return {
      title,
      description: typeof data.description === 'string' ? data.description : '',
      slug,
      date: typeof data.date === 'string' ? data.date : '',
      keywords: Array.isArray(data.keywords)
        ? data.keywords.filter((k): k is string => typeof k === 'string')
        : [],
      content,
    };
  } catch {
    return null; // Unreadable file must never fail the build.
  }
}

/** All guides, newest first. Returns [] if the content folder is absent. */
export function getAllGuides(): Guide[] {
  let files: string[];
  try {
    files = fs.readdirSync(GUIDES_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.md'))
    .map(parseGuideFile)
    .filter((g): g is Guide => g !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function getGuideBySlug(slug: string): Guide | null {
  return getAllGuides().find((g) => g.slug === slug) ?? null;
}

/** Human-readable date ("July 6, 2026"); falls back to the raw string. */
export function formatGuideDate(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
