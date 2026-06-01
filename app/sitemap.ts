import type { MetadataRoute } from 'next';

/**
 * Sitemap — generated at /sitemap.xml by Next's app-router metadata file
 * convention. Re-generated at build time.
 *
 * Includes only routes that actually exist and resolve 200: the homepage,
 * the iPhone setup guide, the two auth landing pages (Google sometimes ranks
 * `/auth/login` as a branded-search landing), and the two legal pages.
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
      // iPhone setup guide — iOS-leaning keyword cluster ("call from computer
      // iphone", "iphone bluetooth computer calls"). Priority 0.8 because it's
      // a real content page with HowTo + FAQPage rich-snippet eligibility, but
      // a notch below the homepage (Android remains the lead).
      url: `${BASE_URL}/iphone`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
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
