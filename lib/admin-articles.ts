import { NextRequest, NextResponse } from 'next/server';
import { validateSessionToken, requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAdminUser } from '@/lib/entitlement';

/**
 * lib/admin-articles.ts — the shared gate + input validation for
 * /api/admin/articles/* (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * The auth gate is a straight lift of the one in app/api/admin/free-access/
 * route.ts, which is itself the gate from app/api/admin/customers/route.ts:
 * auth_token cookie → validateSessionToken (signature + sessionVersion) → load
 * {isAdmin,email} → isAdminUser (the SINGLE admin authority: isAdmin === true
 * OR the hardcoded admin email). Deny by default; anything else is 401/403.
 * No new authority is invented here. It returns the admin's email because every
 * mutation stamps Article.updatedBy with it.
 *
 * Mutations additionally require requireSameOrigin (CSRF) — same as the
 * free-access route. The article body ends up on a public page, so a
 * cross-origin forgery riding Dennis's cookie would be a defacement vector, not
 * just a data-integrity one.
 */

type AdminOk = { ok: true; adminEmail: string };
type AdminErr = { ok: false; res: NextResponse };
export type AdminGate = AdminOk | AdminErr;

/** Read-only gate. Use on GET. */
export async function requireAdmin(req: NextRequest): Promise<AdminGate> {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    return { ok: false, res: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  const payload = await validateSessionToken(token);
  if (!payload) {
    return { ok: false, res: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  const requester = await db.user.findUnique({
    where: { id: payload.userId },
    select: { isAdmin: true, email: true },
  });
  if (!isAdminUser({ isAdmin: requester?.isAdmin, email: requester?.email })) {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, adminEmail: (requester!.email ?? '').toLowerCase() };
}

/**
 * Write gate: CSRF first, then the same admin check.
 *
 * CSRF is checked BEFORE authn on purpose — a forged cross-origin request must
 * be rejected on its origin alone, without the response timing revealing
 * whether the victim's session was valid.
 */
export async function requireAdminWrite(req: NextRequest): Promise<AdminGate> {
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) {
    return { ok: false, res: NextResponse.json({ error: 'CSRF check failed' }, { status: 403 }) };
  }
  return requireAdmin(req);
}

/** Body parse that never throws. null = malformed JSON (→ 400). */
export async function parseBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/**
 * Slug shape: lowercase alphanumeric words joined by single hyphens. This is
 * the value that becomes a public URL path segment, so it is an allow-list, not
 * a deny-list — no dots, no slashes, no percent-encoding, no leading/trailing
 * or doubled hyphens.
 */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Generous but finite caps, so a single row can't be used to bloat the table. */
const MAX_SLUG = 120;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 1000;
const MAX_BODY = 400_000;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD = 100;

export type FieldError = { field: string; message: string };

export function badRequest(errors: FieldError[]): NextResponse {
  return NextResponse.json({ error: 'Validation failed', errors }, { status: 400 });
}

/** Validated, normalised subset of the writable columns. */
export interface ArticleInput {
  slug?: string;
  title?: string;
  description?: string;
  body?: string;
  keywords?: string[];
}

/**
 * Validate the writable fields off a request body.
 *
 * `mode: 'create'` requires slug + title; `mode: 'patch'` validates only the
 * keys actually present, so a PATCH can update one field without resending the
 * whole record. An explicitly-present-but-wrong-typed key is always an error —
 * it is never silently dropped, because silently dropping a field the admin
 * believes they set is how content quietly fails to change.
 */
export function validateArticleInput(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): { ok: true; value: ArticleInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const value: ArticleInput = {};

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  // ── slug ──
  if (mode === 'create' || has('slug')) {
    const raw = body.slug;
    if (typeof raw !== 'string') {
      errors.push({ field: 'slug', message: 'slug is required and must be a string' });
    } else {
      const slug = raw.trim().toLowerCase();
      if (!SLUG_RE.test(slug)) {
        errors.push({
          field: 'slug',
          message: 'slug must be lowercase words separated by single hyphens (a-z, 0-9)',
        });
      } else if (slug.length > MAX_SLUG) {
        errors.push({ field: 'slug', message: `slug must be at most ${MAX_SLUG} characters` });
      } else {
        value.slug = slug;
      }
    }
  }

  // ── title (required, non-empty) ──
  if (mode === 'create' || has('title')) {
    const raw = body.title;
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push({ field: 'title', message: 'title is required and must be non-empty' });
    } else if (raw.trim().length > MAX_TITLE) {
      errors.push({ field: 'title', message: `title must be at most ${MAX_TITLE} characters` });
    } else {
      value.title = raw.trim();
    }
  }

  // ── description (optional; defaults to '') ──
  if (has('description')) {
    const raw = body.description;
    if (typeof raw !== 'string') {
      errors.push({ field: 'description', message: 'description must be a string' });
    } else if (raw.length > MAX_DESCRIPTION) {
      errors.push({
        field: 'description',
        message: `description must be at most ${MAX_DESCRIPTION} characters`,
      });
    } else {
      value.description = raw.trim();
    }
  }

  // ── body (optional on create — a draft may start empty) ──
  if (has('body')) {
    const raw = body.body;
    if (typeof raw !== 'string') {
      errors.push({ field: 'body', message: 'body must be a string' });
    } else if (raw.length > MAX_BODY) {
      errors.push({ field: 'body', message: `body must be at most ${MAX_BODY} characters` });
    } else {
      value.body = raw;
    }
  }

  // ── keywords (optional string[]) ──
  if (has('keywords')) {
    const raw = body.keywords;
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
      errors.push({ field: 'keywords', message: 'keywords must be an array of strings' });
    } else if (raw.length > MAX_KEYWORDS) {
      errors.push({
        field: 'keywords',
        message: `keywords must contain at most ${MAX_KEYWORDS} entries`,
      });
    } else if ((raw as string[]).some((k) => k.length > MAX_KEYWORD)) {
      errors.push({
        field: 'keywords',
        message: `each keyword must be at most ${MAX_KEYWORD} characters`,
      });
    } else {
      value.keywords = (raw as string[]).map((k) => k.trim()).filter((k) => k.length > 0);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/** The list-row shape. No `body` — the index stays light. */
export function toListRow(a: {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  publishedAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
}) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    description: a.description,
    status: a.status,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    updatedAt: a.updatedAt.toISOString(),
    updatedBy: a.updatedBy ?? null,
  };
}

export const LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  status: true,
  publishedAt: true,
  updatedAt: true,
  updatedBy: true,
} as const;

/** The full record shape (detail GET + every mutation response). */
export function toFullRecord(a: {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  keywords: string[];
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    description: a.description,
    body: a.body,
    keywords: a.keywords,
    status: a.status,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    updatedBy: a.updatedBy ?? null,
  };
}
