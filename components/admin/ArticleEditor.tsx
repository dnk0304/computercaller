'use client';

/**
 * ArticleEditor — the full-width guide editor (2026-08-12, feat/articles-cms-ui).
 *
 * Deliberately NOT a modal. These are long-form articles; a cramped dialog is
 * the wrong container for a 2,000-word Markdown body. It replaces the list
 * in-place and owns a back affordance, so the admin is only ever looking at one
 * thing.
 *
 * The two rules this component exists to enforce:
 *
 *   1. SAVE IS NOT PUBLISH. They are separate buttons with different weights.
 *      Save writes a draft and leaves a draft a draft. Publish is the only
 *      thing that puts a page on computercaller.com, and it always goes through
 *      a confirm. Combining them is how someone publishes a half-written page.
 *
 *   2. A PUBLISHED SLUG IS A LIVE URL. The web address auto-derives from the
 *      title only while the article is brand new and untouched. On an existing
 *      article it is never rewritten silently, and changing it on a PUBLISHED
 *      article raises an explicit warning that the old URL will 404.
 *
 * A11y: every field has a real <label>; errors are wired via aria-describedby +
 * aria-invalid and announced through a role="alert"; the keyword input is a
 * labelled text field with a removable-chip list (each chip's remove button
 * names the keyword it removes); the preview toggle is a pressed-state button;
 * the beforeunload + in-app dirty guard covers both ways of losing work.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Eye,
  Globe,
  Loader2,
  Save,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ArticleDraftInput, ArticleRecord } from './adminTypes';
import { ArticleApiError, SLUG_RE, slugify } from './articlesClient';

const SITE = 'computercaller.com/guides';

/** Server caps, mirrored so the counter and the block happen before the request. */
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 1000;
const MAX_BODY = 400_000;

export interface ArticleEditorProps {
  /** The article being edited, or null for a brand-new draft. */
  article: ArticleRecord | null;
  /** Persist. Returns the server's record so the editor can rebase on it. */
  onSave: (input: ArticleDraftInput, id: string | null) => Promise<ArticleRecord>;
  /** Ask the parent to run the publish confirm flow for the saved article. */
  onPublish: (article: ArticleRecord) => void;
  /** Leave the editor. The dirty guard runs before this fires. */
  onClose: () => void;
}

interface FormState {
  title: string;
  slug: string;
  description: string;
  body: string;
  keywords: string[];
}

function toForm(a: ArticleRecord | null): FormState {
  return {
    title: a?.title ?? '',
    slug: a?.slug ?? '',
    description: a?.description ?? '',
    body: a?.body ?? '',
    keywords: a?.keywords ?? [],
  };
}

function sameKeywords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export function ArticleEditor({ article, onSave, onPublish, onClose }: ArticleEditorProps) {
  const [record, setRecord] = useState<ArticleRecord | null>(article);
  const [form, setForm] = useState<FormState>(() => toForm(article));
  const [baseline, setBaseline] = useState<FormState>(() => toForm(article));
  const [keywordDraft, setKeywordDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // True until the admin types in the web-address field themselves. Only while
  // it holds does the title drive the slug — and only on a NEW article.
  const [slugAuto, setSlugAuto] = useState(article === null);

  const titleRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const isNew = record === null;
  const isPublished = record?.status === 'published';

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const dirty = useMemo(
    () =>
      form.title !== baseline.title ||
      form.slug !== baseline.slug ||
      form.description !== baseline.description ||
      form.body !== baseline.body ||
      !sameKeywords(form.keywords, baseline.keywords),
    [form, baseline],
  );

  // Browser-level guard: closing the tab or hitting back with unsaved edits.
  // The in-app guard below covers leaving the editor without leaving the page.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // A published article whose web address has been edited: the old URL dies.
  const slugChangedOnLive = isPublished && record !== null && form.slug !== record.slug;

  const trimmedTitle = form.title.trim();
  const slugValid = SLUG_RE.test(form.slug);
  const canSave = trimmedTitle.length > 0 && slugValid && !saving;
  const bodyEmpty = form.body.trim().length === 0;

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
    setSavedAt(null);
  }, []);

  const handleTitleChange = useCallback(
    (value: string) => {
      setForm((f) => ({
        ...f,
        title: value,
        // Only ever prefills; never rewrites an address the admin has touched
        // or one that already exists on the live site.
        slug: slugAuto && isNew ? slugify(value) : f.slug,
      }));
      setError(null);
      setSavedAt(null);
    },
    [slugAuto, isNew],
  );

  const commitKeyword = useCallback(() => {
    const next = keywordDraft.trim();
    if (!next) return;
    setForm((f) =>
      f.keywords.includes(next) || f.keywords.length >= 50
        ? f
        : { ...f, keywords: [...f.keywords, next] },
    );
    setKeywordDraft('');
    setSavedAt(null);
  }, [keywordDraft]);

  const handleKeywordKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commitKeyword();
        return;
      }
      // Backspace on an empty input removes the last chip — the behaviour every
      // tag input has, and the only way to clear one without a mouse.
      if (e.key === 'Backspace' && keywordDraft === '') {
        setForm((f) => ({ ...f, keywords: f.keywords.slice(0, -1) }));
      }
    },
    [commitKeyword, keywordDraft],
  );

  const focusField = useCallback((field?: string) => {
    if (field === 'slug') slugRef.current?.focus();
    else if (field === 'title') titleRef.current?.focus();
    else if (field === 'description') descriptionRef.current?.focus();
    else if (field === 'body') bodyRef.current?.focus();
  }, []);

  const save = useCallback(async (): Promise<ArticleRecord | null> => {
    if (!canSave) return null;
    setSaving(true);
    setError(null);
    // Fold any half-typed keyword in rather than dropping it on save — losing
    // a word the admin typed is worse than an extra keyword they can remove.
    const pendingKeyword = keywordDraft.trim();
    const keywords =
      pendingKeyword && !form.keywords.includes(pendingKeyword)
        ? [...form.keywords, pendingKeyword]
        : form.keywords;
    const input: ArticleDraftInput = {
      title: trimmedTitle,
      slug: form.slug,
      description: form.description.trim(),
      body: form.body,
      keywords,
    };
    try {
      const saved = await onSave(input, record?.id ?? null);
      setRecord(saved);
      const next = toForm(saved);
      setForm(next);
      setBaseline(next);
      setKeywordDraft('');
      setSlugAuto(false);
      setSavedAt(saved.updatedAt);
      return saved;
    } catch (e) {
      const err = e instanceof ArticleApiError ? e : null;
      setError({
        message: err?.message ?? 'Couldn’t save your changes. Please try again.',
        field: err?.field,
      });
      focusField(err?.field);
      return null;
    } finally {
      setSaving(false);
    }
  }, [canSave, form, keywordDraft, onSave, record, trimmedTitle, focusField]);

  // Publish always saves first. Otherwise "Publish" on a dirty editor puts the
  // PREVIOUS body live, which is the single most confusing thing a CMS can do.
  const handlePublish = useCallback(async () => {
    const saved = dirty || isNew ? await save() : record;
    if (saved) onPublish(saved);
  }, [dirty, isNew, save, record, onPublish]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirmLeave(true);
    else onClose();
  }, [dirty, onClose]);

  return (
    <div className="space-y-4">
      {/* ── Header: identity on the left, the two distinct actions on the right ── */}
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={requestClose}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Back to all guides</span>
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-slate-800">
              {isNew ? 'New guide' : trimmedTitle || 'Untitled guide'}
            </h2>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
              <StatusPill status={record?.status ?? 'draft'} />
              {dirty && <span className="font-medium text-amber-700">Unsaved changes</span>}
              {!dirty && savedAt && <span className="text-emerald-700">Saved</span>}
            </p>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {/* Save is quiet and secondary: it is the safe, frequent action. */}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-4 w-4" aria-hidden="true" />
            )}
            Save draft
          </button>
          {/* Publish is the loud one: emerald, filled, and the only route live. */}
          {!isPublished && (
            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={!canSave || bodyEmpty}
              title={bodyEmpty ? 'Add some content before publishing.' : undefined}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              Publish
            </button>
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {error.message}
        </p>
      )}

      {bodyEmpty && !isPublished && (
        <p className="text-xs text-slate-500">
          A guide needs content before it can go live. Publish unlocks once you’ve written
          something.
        </p>
      )}

      {/* ── Fields ── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Title */}
          <div>
            <label htmlFor="article-title" className="mb-1 block text-xs font-medium text-slate-600">
              Title
            </label>
            <input
              ref={titleRef}
              id="article-title"
              type="text"
              value={form.title}
              maxLength={MAX_TITLE}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="How to text from your computer"
              aria-invalid={error?.field === 'title' || undefined}
              aria-describedby="article-title-help"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
            <p id="article-title-help" className="mt-1 text-xs text-slate-400">
              The headline readers see, and the title Google shows in search results.
            </p>
          </div>

          {/* Web address (slug) */}
          <div>
            <label htmlFor="article-slug" className="mb-1 block text-xs font-medium text-slate-600">
              Web address
            </label>
            <input
              ref={slugRef}
              id="article-slug"
              type="text"
              value={form.slug}
              maxLength={120}
              onChange={(e) => {
                setSlugAuto(false);
                set('slug', e.target.value.toLowerCase());
              }}
              placeholder="how-to-text-from-your-computer"
              aria-invalid={(form.slug.length > 0 && !slugValid) || error?.field === 'slug' || undefined}
              aria-describedby="article-slug-help"
              className={clsx(
                'w-full rounded-xl border bg-white px-3 py-2 font-mono text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2',
                form.slug.length > 0 && !slugValid
                  ? 'border-red-300 focus:border-red-300 focus:ring-red-500/30'
                  : 'border-slate-200 focus:border-emerald-300 focus:ring-emerald-500/30',
              )}
            />
            <p id="article-slug-help" className="mt-1 text-xs text-slate-400">
              {form.slug.length > 0 && !slugValid ? (
                <span className="font-medium text-red-600">
                  Use lowercase letters, numbers and single hyphens only — like
                  {' '}
                  <span className="font-mono">text-from-your-computer</span>.
                </span>
              ) : (
                <>
                  This page will live at{' '}
                  <span className="font-mono text-slate-500">
                    {SITE}/{form.slug || '…'}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* The one warning that protects a live SEO URL. */}
        {slugChangedOnLive && (
          <p
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>
              You’re changing the web address of a guide that’s already live. Anyone who visits the
              old address{' '}
              <span className="font-mono text-amber-800">
                {SITE}/{record?.slug}
              </span>{' '}
              — including links from Google — will get a “page not found”. Only change it if you
              mean to.
            </span>
          </p>
        )}

        {/* Description */}
        <div className="mt-5">
          <label
            htmlFor="article-description"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Short description
          </label>
          <textarea
            ref={descriptionRef}
            id="article-description"
            rows={2}
            value={form.description}
            maxLength={MAX_DESCRIPTION}
            onChange={(e) => set('description', e.target.value)}
            placeholder="One or two sentences summarising the guide."
            aria-describedby="article-description-help"
            className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
          <p id="article-description-help" className="mt-1 text-xs text-slate-400">
            Shown under the title in search results and on the guides index.
          </p>
        </div>

        {/* Keywords */}
        <div className="mt-5">
          <label
            htmlFor="article-keywords"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Keywords <span className="font-normal text-slate-400">(optional)</span>
          </label>
          {form.keywords.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {form.keywords.map((k) => (
                <li key={k}>
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-2.5 pr-1 text-xs font-medium text-slate-700">
                    {k}
                    <button
                      type="button"
                      onClick={() =>
                        set(
                          'keywords',
                          form.keywords.filter((x) => x !== k),
                        )
                      }
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      <span className="sr-only">Remove keyword {k}</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <input
            id="article-keywords"
            type="text"
            value={keywordDraft}
            maxLength={100}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={handleKeywordKeyDown}
            onBlur={commitKeyword}
            placeholder="Type a keyword and press Enter"
            aria-describedby="article-keywords-help"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
          <p id="article-keywords-help" className="mt-1 text-xs text-slate-400">
            Search terms this guide should rank for. Press Enter after each one.
          </p>
        </div>

        {/* Body + preview */}
        <div className="mt-5">
          <div className="mb-1 flex items-end justify-between gap-3">
            <label htmlFor="article-body" className="block text-xs font-medium text-slate-600">
              Content
            </label>
            <button
              type="button"
              onClick={() => setShowPreview((p) => !p)}
              aria-pressed={showPreview}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30',
                showPreview
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {showPreview ? 'Hide preview' : 'Show preview'}
            </button>
          </div>
          <div className={clsx('grid gap-4', showPreview && 'lg:grid-cols-2')}>
            <textarea
              ref={bodyRef}
              id="article-body"
              rows={24}
              value={form.body}
              maxLength={MAX_BODY}
              onChange={(e) => set('body', e.target.value)}
              spellCheck
              placeholder={'# A heading\n\nWrite the guide here. Markdown works:\n\n- a list item\n- **bold text**\n- [a link](https://computercaller.com)'}
              aria-describedby="article-body-help"
              className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
            {showPreview && (
              <div
                aria-live="off"
                className="min-h-[200px] overflow-auto rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Preview
                </p>
                {form.body.trim() ? (
                  <div className="space-y-3 text-sm leading-relaxed text-slate-700">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={previewComponents}>
                      {form.body}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">
                    Nothing to preview yet — start writing on the left.
                  </p>
                )}
              </div>
            )}
          </div>
          <p id="article-body-help" className="mt-1 text-xs text-slate-400">
            Written in Markdown. <span className="font-mono">#</span> for headings,{' '}
            <span className="font-mono">**bold**</span>, <span className="font-mono">-</span> for
            list items.
          </p>
        </div>
      </div>

      {/* In-app dirty guard. Kept as a plain card rather than ConfirmDialog: it
          answers a three-way question (save / discard / stay), and forcing that
          into a two-button dialog would make "Cancel" ambiguous. */}
      {confirmLeave && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5" role="alertdialog" aria-label="Unsaved changes">
          <h3 className="text-sm font-semibold text-amber-900">You have unsaved changes</h3>
          <p className="mt-1 text-sm text-amber-800">
            Leaving now discards everything you’ve written since your last save.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConfirmLeave(false)}
              className="inline-flex items-center rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={() => void save().then((s) => s && onClose())}
              disabled={!canSave}
              className="inline-flex items-center rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save and leave
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-xl px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
            >
              Discard changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact status pill — shared shape with the list so the two never diverge. */
function StatusPill({ status }: { status: string }) {
  const published = status === 'published';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
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

/**
 * Preview styling. Intentionally lighter than the public /guides renderer: this
 * is a formatting check ("is that heading actually a heading?"), not a fidelity
 * mock of the live page. react-markdown's default urlTransform sanitising is
 * left untouched.
 */
const previewComponents = {
  h1: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="text-lg font-bold text-slate-800" {...p} />
  ),
  h2: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="text-base font-bold text-slate-800" {...p} />
  ),
  h3: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="text-sm font-semibold text-slate-800" {...p} />
  ),
  p: (p: React.HTMLAttributes<HTMLParagraphElement>) => <p className="text-slate-700" {...p} />,
  ul: (p: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="list-disc space-y-1 pl-5 text-slate-700" {...p} />
  ),
  ol: (p: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="list-decimal space-y-1 pl-5 text-slate-700" {...p} />
  ),
  a: (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="font-medium text-blue-600 underline" {...p} />
  ),
  code: (p: React.HTMLAttributes<HTMLElement>) => (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800" {...p} />
  ),
  blockquote: (p: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-slate-200 pl-3 italic text-slate-600" {...p} />
  ),
  table: (p: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" {...p} />
    </div>
  ),
  th: (p: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-slate-200 px-2 py-1 font-semibold text-slate-700" {...p} />
  ),
  td: (p: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-slate-100 px-2 py-1 text-slate-600" {...p} />
  ),
};

export default ArticleEditor;
