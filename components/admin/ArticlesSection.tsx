'use client';

/**
 * ArticlesSection — the guides CMS panel in /app/admin (2026-08-12).
 *
 * Owns the whole feature: the list, the search, the row actions, the confirm
 * flows, and the editor it swaps itself out for. The admin page mounts it and
 * nothing else.
 *
 * The design brief in one line: "this is live / this is not live" has to be
 * unmistakable. So the status column is the widest-weight thing on the row —
 * a filled pill with a dot AND the words "Live" / "Draft", never colour alone —
 * and a live row carries a real link to the page it publishes to, because the
 * most convincing proof something is live is being able to click it.
 *
 * Publish / unpublish / delete all route through the shared ConfirmDialog with
 * plain-English copy. Publishing is one confident click plus one confirm; it is
 * never fused into Save.
 *
 * A11y: the table is a real <table> with scoped headers; every row action is a
 * focusable button with an accessible name that includes the article title (so
 * a screen-reader user hears "Publish How to text from your computer", not
 * "Publish"); outcomes land in a polite live region.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ArticleDraftInput, ArticleListRow, ArticleRecord } from './adminTypes';
import {
  ArticleApiError,
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  matchesQuery,
  publishArticle,
  sortByUpdatedDesc,
  unpublishArticle,
  updateArticle,
} from './articlesClient';
import { formatDate } from './customerRows';
import { ConfirmDialog } from './ConfirmDialog';

const SITE_PATH = 'computercaller.com/guides';

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: ArticleListRow[] };

/** Which full-screen surface is showing. The editor replaces the list. */
type View =
  | { kind: 'list' }
  | { kind: 'editing'; article: ArticleRecord | null }
  | { kind: 'opening'; id: string };

/** Stable identity so the memo below doesn't re-run on every non-ready render. */
const EMPTY_ROWS: ArticleListRow[] = [];

type Pending =
  | { action: 'publish'; row: ArticleListRow }
  | { action: 'unpublish'; row: ArticleListRow }
  | { action: 'delete'; row: ArticleListRow };

export function ArticlesSection() {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const rows = await listArticles(signal);
      setState({ kind: 'ready', rows: sortByUpdatedDesc(rows) });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      setState({
        kind: 'error',
        message:
          e instanceof ArticleApiError ? e.message : 'Couldn’t load the guides. Please try again.',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rows = useMemo(() => (state.kind === 'ready' ? state.rows : EMPTY_ROWS), [state]);
  const filtered = useMemo(() => rows.filter((r) => matchesQuery(r, query)), [rows, query]);
  const liveCount = rows.filter((r) => r.status === 'published').length;

  // ── Editor plumbing ────────────────────────────────────────────────────────

  const openEditor = useCallback(async (id: string) => {
    setRowError(null);
    setView({ kind: 'opening', id });
    try {
      const article = await getArticle(id);
      setView({ kind: 'editing', article });
    } catch (e) {
      setView({ kind: 'list' });
      setRowError(
        e instanceof ArticleApiError ? e.message : 'Couldn’t open that guide. Please try again.',
      );
    }
  }, []);

  const handleSave = useCallback(
    async (input: ArticleDraftInput, id: string | null): Promise<ArticleRecord> => {
      const saved = id ? await updateArticle(id, input) : await createArticle(input);
      // Reconcile the list against the server's record rather than patching it
      // locally — updatedAt/updatedBy/status are all server-owned.
      setState((s) =>
        s.kind === 'ready'
          ? {
              kind: 'ready',
              rows: sortByUpdatedDesc([
                saved,
                ...s.rows.filter((r) => r.id !== saved.id),
              ]),
            }
          : s,
      );
      setAnnouncement(`Saved “${saved.title}” as a draft.`);
      return saved;
    },
    [],
  );

  // ── Row actions ────────────────────────────────────────────────────────────

  const runPending = useCallback(async () => {
    if (!pending) return;
    const { action, row } = pending;
    setBusy(true);
    setRowError(null);
    try {
      if (action === 'delete') {
        await deleteArticle(row.id);
        setState((s) =>
          s.kind === 'ready' ? { kind: 'ready', rows: s.rows.filter((r) => r.id !== row.id) } : s,
        );
        setAnnouncement(`Deleted “${row.title}”.`);
      } else {
        const updated =
          action === 'publish' ? await publishArticle(row.id) : await unpublishArticle(row.id);
        setState((s) =>
          s.kind === 'ready'
            ? {
                kind: 'ready',
                rows: sortByUpdatedDesc(s.rows.map((r) => (r.id === updated.id ? updated : r))),
              }
            : s,
        );
        setAnnouncement(
          action === 'publish'
            ? `“${updated.title}” is now live at ${SITE_PATH}/${updated.slug}.`
            : `“${updated.title}” has been taken off the site and is back to a draft.`,
        );
      }
      setPending(null);
      // A publish/unpublish from inside the editor returns to the list — the
      // status just changed, and the list is where that change is legible.
      setView({ kind: 'list' });
    } catch (e) {
      setPending(null);
      setRowError(
        e instanceof ArticleApiError ? e.message : 'That didn’t work. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [pending]);

  // ── Editor view ────────────────────────────────────────────────────────────

  if (view.kind === 'opening') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-16 text-sm text-slate-500 shadow-sm">
        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
        Opening guide…
      </div>
    );
  }

  if (view.kind === 'editing') {
    return (
      <>
        <React.Suspense
          fallback={
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-16 text-sm text-slate-500 shadow-sm">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              Loading editor…
            </div>
          }
        >
          <ArticleEditorLazy
            article={view.article}
            onSave={handleSave}
            onPublish={(a) => setPending({ action: 'publish', row: a })}
            onClose={() => {
              setView({ kind: 'list' });
              void load();
            }}
          />
        </React.Suspense>
        <ConfirmLayer pending={pending} busy={busy} onConfirm={runPending} onCancel={() => setPending(null)} />
        <LiveRegion message={announcement} />
      </>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────

  return (
    <section
      aria-labelledby="articles-heading"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      {/* Panel header */}
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"
            aria-hidden="true"
          >
            <FileText className="h-4 w-4" />
          </span>
          <div>
            <h2 id="articles-heading" className="text-sm font-bold text-slate-800">
              Guides
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Write and edit the guides on computercaller.com. Publishing puts a page live in
              seconds — no deploy.
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {state.kind === 'ready' && (
            <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 sm:inline-flex">
              <span className="tabular-nums">{liveCount}</span>
              <span className="ml-1">live</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => setView({ kind: 'editing', article: null })}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New guide
          </button>
        </div>
      </div>

      {/* Search */}
      {state.kind === 'ready' && rows.length > 0 && (
        <div className="border-b border-slate-100 px-5 py-3">
          <label htmlFor="articles-search" className="sr-only">
            Search guides by title or web address
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              id="articles-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or web address"
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        </div>
      )}

      {rowError && (
        <p
          role="alert"
          className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-5 py-3 text-sm font-medium text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {rowError}
        </p>
      )}

      {state.kind === 'loading' && <ListSkeleton />}

      {state.kind === 'error' && (
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center" role="alert">
          <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
          <p className="text-sm text-slate-600">{state.message}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </div>
      )}

      {state.kind === 'ready' && rows.length === 0 && (
        <div className="px-6 py-14 text-center">
          <span
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500"
            aria-hidden="true"
          >
            <FileText className="h-6 w-6" />
          </span>
          <h3 className="text-base font-semibold text-slate-800">No guides yet</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-slate-500">
            Write your first guide here and publish it straight to computercaller.com.
          </p>
          <button
            type="button"
            onClick={() => setView({ kind: 'editing', article: null })}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Write your first guide
          </button>
        </div>
      )}

      {state.kind === 'ready' && rows.length > 0 && filtered.length === 0 && (
        <p className="px-5 py-12 text-center text-sm text-slate-500">
          No guide matches “{query.trim()}”. Try a different word.
        </p>
      )}

      {state.kind === 'ready' && filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Guide
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Last updated
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-800">{row.title}</p>
                    {row.status === 'published' ? (
                      <a
                        href={`/guides/${row.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                      >
                        /{row.slug}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">— open the live page for {row.title}</span>
                      </a>
                    ) : (
                      <p className="mt-0.5 font-mono text-xs text-slate-400">/{row.slug}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500">
                    <span className="tabular-nums">{formatDate(row.updatedAt)}</span>
                    {row.updatedBy && (
                      <span className="block truncate text-slate-400">by {row.updatedBy}</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <RowAction
                        label="Edit"
                        srSuffix={row.title}
                        icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => void openEditor(row.id)}
                      />
                      {row.status === 'published' ? (
                        <RowAction
                          label="Unpublish"
                          srSuffix={row.title}
                          icon={<Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
                          onClick={() => setPending({ action: 'unpublish', row })}
                        />
                      ) : (
                        <RowAction
                          label="Publish"
                          srSuffix={row.title}
                          tone="publish"
                          icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
                          onClick={() => setPending({ action: 'publish', row })}
                        />
                      )}
                      <RowAction
                        label="Delete"
                        srSuffix={row.title}
                        tone="danger"
                        iconOnly
                        icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => setPending({ action: 'delete', row })}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmLayer pending={pending} busy={busy} onConfirm={runPending} onCancel={() => setPending(null)} />
      <LiveRegion message={announcement} />
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * The confirm copy. Every string names the article and says what will actually
 * happen to the public site — not "Are you sure?".
 */
function ConfirmLayer({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: Pending | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!pending) return null;
  const { action, row } = pending;

  if (action === 'publish') {
    return (
      <ConfirmDialog
        open
        title={`Publish “${row.title}”?`}
        description={
          <>
            It goes live at{' '}
            <span className="font-mono text-slate-800">
              {SITE_PATH}/{row.slug}
            </span>{' '}
            right away, and anyone can read it. You can unpublish it again at any time.
          </>
        }
        confirmLabel="Publish it"
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }

  if (action === 'unpublish') {
    return (
      <ConfirmDialog
        open
        title={`Take “${row.title}” off the site?`}
        description={
          <>
            The page at{' '}
            <span className="font-mono text-slate-800">
              {SITE_PATH}/{row.slug}
            </span>{' '}
            stops working for readers. Your writing is kept here as a draft, so you can publish it
            again whenever you want.
          </>
        }
        confirmLabel="Take it down"
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }

  return (
    <ConfirmDialog
      open
      title={`Delete “${row.title}” permanently?`}
      tone="danger"
      description={
        <>
          This erases the guide and everything written in it. It cannot be undone.
          {row.status === 'published' && (
            <>
              {' '}
              The live page at{' '}
              <span className="font-mono text-slate-800">
                {SITE_PATH}/{row.slug}
              </span>{' '}
              will stop working, and any Google link to it will break.
            </>
          )}{' '}
          If you only want it off the site, unpublish it instead.
        </>
      }
      confirmLabel="Delete permanently"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/**
 * The status pill. The brief's most important element: a filled shape, a dot,
 * AND the word — so it survives greyscale, low contrast and a quick glance.
 * "Live" rather than "Published" because live is what Dennis actually asks
 * about ("is it live yet?").
 */
function StatusPill({ status }: { status: string }) {
  const published = status === 'published';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold',
        published ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700',
      )}
    >
      <span
        className={clsx('h-1.5 w-1.5 rounded-full', published ? 'bg-emerald-600' : 'bg-slate-500')}
        aria-hidden="true"
      />
      {published ? 'Live' : 'Draft'}
    </span>
  );
}

function RowAction({
  label,
  srSuffix,
  icon,
  onClick,
  tone = 'default',
  iconOnly = false,
}: {
  label: string;
  /** Appended to the accessible name so each row's button is distinguishable. */
  srSuffix: string;
  icon: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'publish' | 'danger';
  iconOnly?: boolean;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus-visible:ring-red-500/30'
      : tone === 'publish'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus-visible:ring-emerald-500/30'
        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 focus-visible:ring-blue-500/30';
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2',
        toneClass,
      )}
    >
      {icon}
      {iconOnly ? null : label}
      <span className="sr-only">
        {iconOnly ? label : ''} {srSuffix}
      </span>
    </button>
  );
}

/**
 * One polite live region for every async outcome in this panel. Publish and
 * unpublish change the state of a public website — a sighted user sees the pill
 * flip, and this is the equivalent for everyone else.
 */
function LiveRegion({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-slate-100" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-56 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          </div>
          <div className="h-6 w-16 animate-pulse rounded-full bg-slate-100" />
          <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
          <div className="h-7 w-40 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

// The editor is only pulled in when one is actually opened — it drags
// react-markdown + remark-gfm with it, and the list view has no use for either.
const ArticleEditorLazy = React.lazy(() =>
  import('./ArticleEditor').then((m) => ({ default: m.ArticleEditor })),
);

export default ArticlesSection;
