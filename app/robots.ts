import type { MetadataRoute } from 'next';

/**
 * /robots.txt — Next app-router convention. Allows all reputable crawlers,
 * blocks the product surface and API routes (no SEO value, and indexing
 * them risks leaking auth-gated content), and points to the sitemap.
 *
 * `/app/*` is the authenticated product. `/api/*` is server-only. Both are
 * disallowed for every user-agent — there is no legitimate reason for a
 * crawler to index them, and explicit disallow is cheaper than relying on
 * runtime 401s to deter indexing.
 */

const BASE_URL = 'https://computercaller.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/api/', '/messenger/'],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
