/**
 * lib/e2ePref.ts — TS entry point for the per-account Encrypted-mode setting.
 *
 * The rules live in lib/e2ePref-core.js (plain CJS, shared with server.js — see
 * its header). This module binds them to lib/db and owns the ONE HTTP auth
 * decision for app/api/prefs/e2e/*:
 *
 *   - session cookie (the /api/prefs/layout credential; used by the /app page
 *     and by the extension side panel, which is an iframe of the web origin)
 *     -> source 'web', CSRF (requireSameOrigin) on every mutating method;
 *   - ext-session bearer (the ext-token arm of lib/deviceKeyAuth.ts, held by
 *     the extension service worker) -> source 'ext', no CSRF (a header bearer
 *     is not an ambient credential); read ONLY from the Authorization header;
 *   - resolveCaller's phone-token arm is REFUSED here: the phone writes over
 *     its relay socket (DESIGN §4, "no new phone HTTP auth surface").
 */

import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireSameOrigin } from '@/lib/auth';
import { resolveCaller } from '@/lib/deviceKeyAuth';
import * as core from './e2ePref-core';
import type { E2ePrefSource, E2ePrefValue } from './e2ePref-core';

export type {
  E2ePrefValue,
  E2ePrefSource,
  ResolvedE2ePref,
  E2ePrefResetResult,
} from './e2ePref-core';
export { E2ePrefError, resolveE2ePref } from './e2ePref-core';
import { E2ePrefError } from './e2ePref-core';

export const getE2ePref = (userId: string) => core.getE2ePref(db, userId);
export const setE2ePref = (userId: string, value: E2ePrefValue, source: E2ePrefSource) =>
  core.setE2ePref(db, userId, value, source);
export const seedE2ePref = (userId: string, value: string, source: E2ePrefSource) =>
  core.seedE2ePref(db, userId, value, source);

/** Security m2: exactly `{ value }`; the userId comes from auth only. */
const BodySchema = z.strictObject({ value: z.enum(['on', 'off']) });
const MAX_BODY_BYTES = 1024;

export type E2ePrefCaller =
  | { ok: true; userId: string; source: 'web' | 'ext' }
  | { ok: false; status: 401 | 403; error: string };

export async function resolveE2ePrefCaller(req: NextRequest, mutating: boolean): Promise<E2ePrefCaller> {
  const caller = await resolveCaller(req);
  if (!caller.ok || caller.via === 'phone-token') {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (caller.via === 'session' && mutating) {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return { ok: false, status: 403, error: 'CSRF check failed' };
  }
  return { ok: true, userId: caller.userId, source: caller.via === 'ext-token' ? 'ext' : 'web' };
}

export type ParsedE2ePrefBody =
  | { ok: true; value: E2ePrefValue }
  | { ok: false; status: 400 | 413; error: string };

export async function parseE2ePrefBody(req: NextRequest): Promise<ParsedE2ePrefBody> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Payload too large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
  const r = BodySchema.safeParse(parsed);
  if (!r.success) return { ok: false, status: 400, error: 'Body must be exactly {"value":"on"|"off"}' };
  return { ok: true, value: r.data.value };
}

/** Shared with the seed route: one mapping from E2ePrefError to HTTP. */
export function e2ePrefErrorResponse(e: unknown): NextResponse {
  const code = e instanceof E2ePrefError || (e && typeof e === 'object' && 'code' in e)
    ? (e as E2ePrefError).code
    : null;
  switch (code) {
    case 'rate_limited': {
      const retryAfterMs = (e as E2ePrefError).retryAfterMs ?? 60_000;
      return NextResponse.json(
        { error: 'rate_limited', retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }
    case 'relay_unavailable':
      console.error('[e2e-pref] relay hook not installed in this process — write refused (503)');
      return NextResponse.json({ error: 'relay_unavailable' }, { status: 503 });
    case 'reset_failed':
    case 'push_failed': {
      const err = e as E2ePrefError;
      console.error(`[e2e-pref] ${code}: ${err.message}`);
      return NextResponse.json(
        { error: code, changed: err.changed ?? err.applied ?? true, resolved: err.resolved ?? null, reset: null },
        { status: 500 },
      );
    }
    case 'not_found':
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    case 'invalid_value':
    case 'invalid_source':
      return NextResponse.json({ error: 'Body must be exactly {"value":"on"|"off"}' }, { status: 400 });
    default:
      console.error('[e2e-pref] write failed:', e instanceof Error ? e.message : 'unknown');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
