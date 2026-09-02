import type { NextConfig } from "next";

// Bundle B (2026-05-28) — security headers applied to every response. Closes
// audit finding H1 (no headers). Layout follows OWASP secure-headers guidance
// for an authenticated SaaS:
//   - HSTS: 180 days + preload-ready (registered submission is a follow-up)
//   - X-Frame-Options + frame-ancestors: deny embedding except same-origin
//   - X-Content-Type-Options: stop MIME sniffing (defense in depth for any
//     route that ever sets the wrong Content-Type)
//   - Referrer-Policy: strict-origin-when-cross-origin — leaks the origin
//     but not the path on cross-site nav (path can contain template ids etc.)
//   - Permissions-Policy: deny mic/geo by default; camera + payment kept
//     same-origin (camera = QR scan; payment = Whop checkout)
//   - CSP: report-style allowlist. Cloudflare Turnstile + Whop checkout +
//     Google sign-in form-action are the third-party origins we authorise.
//     `unsafe-inline` on script-src is the Next.js hydration cost — closing
//     this requires nonces on every inline boot script and is deferred.
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=15552000; includeSubDomains; preload',
  },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(), geolocation=(), payment=(self)',
  },
  {
    key: 'Content-Security-Policy',
    // Single-line value — header values cannot contain literal newlines.
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' wss://computercaller.com https://api.cloudflare.com",
      "frame-src 'self' https://whop.com",
      "frame-ancestors 'self'",
      "form-action 'self' https://accounts.google.com",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  // Disable StrictMode in dev — it double-renders every component on every
  // state change (intentional for side-effect detection, but halves perf on
  // complex components like Dashboard). Re-enable if auditing for side effects.
  reactStrictMode: false,

  // Externalize Prisma client from server bundling so Turbopack doesn't
  // try to materialize a symlink to it inside the build output. On Windows
  // (where SeCreateSymbolicLinkPrivilege is typically absent) that symlink
  // step panics with os error 1314 and every API route that imports Prisma
  // returns 500. With `serverExternalPackages`, Next/Turbopack leaves the
  // package as a runtime require — no symlink, no panic.
  // Refs: https://www.prisma.io/docs/orm/more/help-and-troubleshooting/nextjs-help
  serverExternalPackages: ['@prisma/client', '.prisma/client'],

  // Android-only repositioning (2026-07-10): the iPhone setup page was
  // removed. Its URL is in the previously-submitted sitemap and may be
  // indexed, so permanent-redirect it home instead of 404ing.
  async redirects() {
    return [
      {
        source: '/iphone',
        destination: '/',
        permanent: true,
      },
      // Fix 3 (2026-07-16): canonicalise www → apex. A mutating POST whose
      // Origin is https://www.computercaller.com used to 403 in requireSameOrigin
      // (expected apex only). Redirecting at the edge means browsers land on the
      // apex before any mutating POST, so the origin mismatch never arises (and
      // it's better for cookies/SEO). Host-scoped: only fires for www requests,
      // so apex traffic — including the WSS relay upgrade and /api/webhooks/whop,
      // which already run on the apex — is untouched.
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.computercaller.com' }],
        destination: 'https://computercaller.com/:path*',
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        // Match every path. Next.js applies these on top of any per-route
        // headers set by individual route handlers.
        source: '/(.*)',
        headers: SECURITY_HEADERS,
      },
      {
        // Chrome extension (2026-09-02, forge/chrome-extension-p1). The MV3
        // extension iframes https://computercaller.com/extension inside a
        // chrome-extension:// page. The global policy (X-Frame-Options:SAMEORIGIN
        // + frame-ancestors 'self') forbids that. This entry sits AFTER the
        // global block, so for the Content-Security-Policy key it REPLACES the
        // global CSP on /extension only (same last-wins semantics the
        // /auth/set-password Referrer-Policy override relies on). It re-states the
        // full policy verbatim EXCEPT frame-ancestors, which is pinned to our
        // extension's stable ID (see lib/extension.ts CC_EXTENSION_ID — keep in
        // sync). Per the CSP spec, when a valid frame-ancestors directive is
        // present the browser IGNORES the still-served X-Frame-Options header, so
        // no separate XFO override is needed. Scoped to /extension ONLY — the
        // site-wide anti-framing posture is unchanged everywhere else.
        source: '/extension',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "media-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' wss://computercaller.com https://api.cloudflare.com",
              "frame-src 'self' https://whop.com",
              'frame-ancestors chrome-extension://helkcjjlidcceiifjccolmppanfmcjjg',
              "form-action 'self' https://accounts.google.com",
              "base-uri 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // audit round 1, Mi2: /auth/set-password carries a live single-use
        // reset token in its query string. The global policy is
        // strict-origin-when-cross-origin, which still sends the ORIGIN on
        // cross-site navigation and the full URL (path + query) on same-origin
        // navigation — either can leak the token via Referer. Override to
        // no-referrer for this path only so no navigation off this page ever
        // carries the token. This entry sits AFTER the global block, so for the
        // Referrer-Policy key it wins on /auth/set-password.
        source: '/auth/set-password',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        // GSC fix (2026-08-21): Google indexed woff2 font URLs under
        // /_next/static/media/ as if they were pages. noindex the media
        // folder (hashed fonts + imported assets) via X-Robots-Tag.
        // Deliberately NOT robots.txt-disallowed: Googlebot must still
        // FETCH /_next/static JS/CSS to render pages — this header only
        // keeps the assets out of the index. CSS/JS live under
        // /_next/static/css and /_next/static/chunks, NOT media, so
        // rendering resources are unaffected by this rule.
        source: '/_next/static/media/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
      },
    ];
  },
};

export default nextConfig;
