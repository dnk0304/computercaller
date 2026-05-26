import type { MetadataRoute } from 'next';

/**
 * Sitemap — generated at /sitemap.xml by Next's app-router metadata file
 * convention. Run on every request (re-generated at build time on Vercel).
 *
 * Includes the live public surface today (`/`, auth pages, legal) plus the
 * four marketing routes from dispatch B (`/pricing`, `/about`, `/how-it-works`,
 * `/use-cases`). Those routes do not exist yet — when dispatch B lands they
 * will resolve. Listing them here is intentional: Google will start crawling
 * the moment they ship, and we avoid a second sitemap update.
 *
 * Auth pages are included because Google sometimes ranks `/auth/login` as a
 * branded-search landing; including them ensures it picks the canonical URL.
 * Robots.ts blocks `/app/*` from indexing — the product surface is behind
 * auth and has no SEO value.
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
      url: `${BASE_URL}/how-it-works`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/use-cases`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.9,
    },
    {
      // iPhone setup guide — iOS-leaning keyword cluster ("call from computer
      // iphone", "iphone bluetooth computer calls"). Priority 0.8 because it's
      // a real content page with HowTo + FAQPage rich-snippet eligibility, but
      // a notch below the primary marketing routes (Android remains the lead).
      url: `${BASE_URL}/iphone`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/about`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
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
  ];
}
