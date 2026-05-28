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

  async headers() {
    return [
      {
        // Match every path. Next.js applies these on top of any per-route
        // headers set by individual route handlers.
        source: '/(.*)',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
