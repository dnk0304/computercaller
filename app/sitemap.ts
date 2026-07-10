import type { MetadataRoute } from 'next';
import { getAllGuides } from '@/lib/guides';

/**
 * Sitemap — generated at /sitemap.xml by Next's app-router metadata file
 * convention. Re-generated at build time.
 *
 * Includes only routes that actually exist and resolve 200: the homepage,
 * the two auth landing pages, the two legal pages, and the guides section.
 *
 * Auth pages are included because Google sometimes ranks `/auth/login` as a
 * branded-search landing; listing them ensures it picks the correct canonical
 * URL. Robots.ts blocks `/app/*`, `/api/*`, `/messenger/*` from indexing —
 * the product surface is behind auth and has no SEO value.
 *
 * When new marketing routes ship (e.g. /pricing, /about, /how-it-works,
 * /use-cases), add them here AT THE SAME TIME you ship their pages, and make
 * sure each new page sets its own `alternates.canonical` (the root layout
 * cascades `canonical: "/"` to every child unless overridden). Listing a
 * non-existent route here pollutes GSC coverage reports with soft 404s.
 */

const BASE_URL = 'https://computercaller.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/auth/register`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/auth/login`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    // Guides — the SEO article section. The index is always listed (it renders
    // an empty state even with no content); each article URL is derived from
    // content/guides/*.md at build time, so the sitemap and the statically
    // generated /guides/[slug] pages can never drift apart.
    {
      url: `${BASE_URL}/guides`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    ...getAllGuides().map((guide) => ({
      url: `${BASE_URL}/guides/${guide.slug}`,
      lastModified: guide.date ? new Date(guide.date) : now,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
