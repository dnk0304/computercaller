/**
 * lib/nextPath.ts — open-redirect sanitiser for `?next=` targets.
 *
 * WHY THIS FILE EXISTS (2026-09-17, dispatch forge/w-strip-email-literals):
 * `sanitiseNext` used to live in lib/google.ts. That file imports
 * `getJwtSecret` from lib/auth.ts, which imports lib/db.ts (PrismaClient) and
 * re-exports from lib/entitlement-core.js. components/auth/LoginForm.tsx is a
 * 'use client' component and imported `sanitiseNext` from lib/google — so the
 * whole server chain was pulled into a PUBLIC client bundle. Because
 * entitlement-core.js is plain CommonJS it cannot be tree-shaken, and its
 * hardcoded email literals shipped to every visitor in
 * _next/static/chunks/*.js (confirmed live, 2026-09-17).
 *
 * This module is therefore DELIBERATELY DEPENDENCY-FREE: no imports, no env
 * reads, no secrets. It is safe for both client and server. Keep it that way —
 * adding an import here re-opens the exact hole this split closed.
 */

/**
 * Sanitise a `next` redirect target. Must start with a single `/` and NOT
 * a second `/` (no scheme-relative `//evil.com/x` URLs) and not contain
 * a CR/LF. Anything else falls back to `/app`.
 */
export function sanitiseNext(next: string | null | undefined): string {
  if (!next || typeof next !== 'string') return '/app';
  if (!next.startsWith('/')) return '/app';
  if (next.startsWith('//')) return '/app';
  if (/[\r\n]/.test(next)) return '/app';
  return next;
}
