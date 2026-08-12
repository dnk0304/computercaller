/**
 * Client helpers for the guides CMS API (`/api/admin/articles/*`). ONE place
 * that knows how to call the endpoints, so the list, the row actions and the
 * editor all hit them identically — same headers, same credentials, same error
 * translation. Mirrors `freeAccessClient.ts`.
 *
 * Every mutation is same-origin JSON with `credentials: 'same-origin'`: the
 * auth cookie rides along AND Forge's `requireSameOrigin` CSRF gate passes.
 * Getting either wrong is a silent 403, so it lives here and nowhere else.
 *
 * Errors throw an `ArticleApiError` carrying `status` and the server's `field`
 * (e.g. 'slug' on a 409) so callers can attach the message to the right input
 * instead of dumping a status code on the page.
 */

import type {
  ArticleDraftInput,
  ArticleListResponse,
  ArticleListRow,
  ArticleRecord,
  ArticleResponse,
} from './adminTypes';

const ENDPOINT = '/api/admin/articles';

export class ArticleApiError extends Error {
  readonly status: number;
  /** Which input the server blamed, when it named one. */
  readonly field?: string;

  constructor(message: string, status: number, field?: string) {
    super(message);
    this.name = 'ArticleApiError';
    this.status = status;
    this.field = field;
  }
}

/**
 * Turn a failed response into a message Dennis can act on.
 *
 * The 409 case is the one that matters: the server says "An article with that
 * slug already exists", but "slug" is not a word in this UI — the field is
 * labelled "Web address", so the message has to match the label.
 */
async function toError(res: Response, fallback: string): Promise<ArticleApiError> {
  let serverMessage: string | undefined;
  let field: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: unknown;
      field?: unknown;
      errors?: Array<{ field?: unknown; message?: unknown }>;
    };
    if (typeof body?.error === 'string' && body.error.trim()) serverMessage = body.error;
    if (typeof body?.field === 'string') field = body.field;
    // 400 validation failures carry a per-field list; surface the first one,
    // which is also the field we want to focus.
    const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
    if (first) {
      if (typeof first.message === 'string' && first.message.trim()) serverMessage = first.message;
      if (typeof first.field === 'string' && first.field !== '_') field = first.field;
    }
  } catch {
    /* non-JSON body — fall through to the fallback */
  }

  if (res.status === 409) {
    return new ArticleApiError(
      'That web address is already used by another article. Pick a different one.',
      409,
      field ?? 'slug',
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new ArticleApiError(
      'Your admin session has expired. Reload the page and sign in again.',
      res.status,
      field,
    );
  }
  if (res.status === 404) {
    return new ArticleApiError('That article no longer exists. It may have been deleted.', 404, field);
  }
  return new ArticleApiError(serverMessage ?? fallback, res.status, field);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Fetch every article, drafts included. Throws on failure. */
export async function listArticles(signal?: AbortSignal): Promise<ArticleListRow[]> {
  const res = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!res.ok) throw await toError(res, 'Couldn’t load the guides. Please try again.');
  const body = (await res.json()) as ArticleListResponse;
  return Array.isArray(body?.articles) ? body.articles : [];
}

/** Fetch one article including its body and keywords. */
export async function getArticle(id: string, signal?: AbortSignal): Promise<ArticleRecord> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw await toError(res, 'Couldn’t open that guide. Please try again.');
  return ((await res.json()) as ArticleResponse).article;
}

/** Create a DRAFT. Never publishes — publishing is a separate, explicit action. */
export async function createArticle(input: ArticleDraftInput): Promise<ArticleRecord> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res, 'Couldn’t create the guide. Please try again.');
  // 201 Created; the body carries the full record, so the editor can rebase on
  // the server's copy (real id, createdAt, normalised slug) without a refetch.
  return ((await res.json()) as ArticleResponse).article;
}

/** Partial update. Only the keys present are written. */
export async function updateArticle(
  id: string,
  patch: Partial<ArticleDraftInput>,
): Promise<ArticleRecord> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res, 'Couldn’t save your changes. Please try again.');
  return ((await res.json()) as ArticleResponse).article;
}

/**
 * Put an article live.
 *
 * The server refuses a 400 when the article body is empty ("a live SEO URL with
 * no content is worse than no URL at all"), so the UI blocks that earlier — but
 * the message still has to read as English if it ever gets through.
 */
export async function publishArticle(id: string): Promise<ArticleRecord> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await toError(res, 'Couldn’t publish the guide. Please try again.');
    if (res.status === 400 && err.field === 'body') {
      throw new ArticleApiError(
        'This guide has no content yet, so it can’t go live. Add some text first.',
        400,
        'body',
      );
    }
    throw err;
  }
  return ((await res.json()) as ArticleResponse).article;
}

/** Take an article off the public site. It stays here as a draft. */
export async function unpublishArticle(id: string): Promise<ArticleRecord> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}/unpublish`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await toError(res, 'Couldn’t unpublish the guide. Please try again.');
  return ((await res.json()) as ArticleResponse).article;
}

/** Hard delete. Irreversible. */
export async function deleteArticle(id: string): Promise<void> {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await toError(res, 'Couldn’t delete the guide. Please try again.');
}

// ---------------------------------------------------------------------------
// Slug helpers — the same rule the server enforces, applied client-side so the
// admin gets the feedback while typing rather than after a round-trip.
// ---------------------------------------------------------------------------

/** Server rule (lib/admin-articles.ts): lowercase words joined by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Derive a URL-safe slug from a title. Used ONLY to prefill a brand-new
 * article: silently rewriting the slug of an existing article would move a
 * live SEO URL out from under Google.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // strip accents so "café" → "cafe"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, ''); // the slice can leave a trailing hyphen
}

/** Newest-updated first — the order an editor scans in. */
export function sortByUpdatedDesc(rows: ArticleListRow[]): ArticleListRow[] {
  return [...rows].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

/** Case-insensitive match on title or web address. */
export function matchesQuery(row: ArticleListRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.title.toLowerCase().includes(q) || row.slug.toLowerCase().includes(q);
}
