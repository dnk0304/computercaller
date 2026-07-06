import { NextResponse } from 'next/server';

/**
 * POST /api/auth/register — RETIRED (2026-07-06, Google-only registration).
 *
 * Dennis removed email/password signup entirely: new accounts are created
 * exclusively via Google Sign-In (/api/auth/google/start → callback), which
 * arrives pre-verified and — card-first paywall — with NO subscription row,
 * so proxy.ts routes the fresh user to /subscribe (Whop embed).
 *
 * The route intentionally stays mounted and returns 410 Gone (not 404) so:
 *   - any stale client bundle / cached page that still POSTs here gets a
 *     clear, machine-readable answer instead of a generic not-found;
 *   - the JSON error tells the human what to do (use Google).
 *
 * NOT touched by this retirement:
 *   - /api/auth/login          — existing email/password users keep working
 *   - /api/auth/apk-login      — APK email/password login keeps working
 *   - /api/auth/verify-email   — legacy verification links keep working
 *   - reviewer@computercaller.com — logs in via /api/auth/login as before
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'Email registration has been retired. Please sign up with Google.',
      code: 'registration_gone',
      signupUrl: '/api/auth/google/start',
    },
    { status: 410 },
  );
}
