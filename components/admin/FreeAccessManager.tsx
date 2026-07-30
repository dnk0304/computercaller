'use client';

/**
 * FreeAccessManager — the "comp any email" panel (P4).
 *
 * Free access is an email-keyed allowlist, so an email can be granted whether
 * or not an account exists yet. This panel lets Dennis:
 *   • add an email (+ optional note) → grant free access (POST)
 *   • see every current grant, with who/when + whether the email is registered
 *   • remove a grant (DELETE), behind a confirm (it's a billing bypass)
 *
 * It owns its own fetch of `GET /api/admin/free-access` and reconciles after
 * every mutation. When the allowlist changes it also calls `onChanged` so the
 * parent can refetch the customers table (a grant/revoke here flips a row
 * there). Presentation matches the admin dashboard: white cards, slate ramp,
 * violet as the free-access accent, rounded-2xl, visible focus rings.
 *
 * A11y: labelled inputs, `role="status"`/`role="alert"` live regions for async
 * feedback, keyboard-operable controls, confirm dialog for removals.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gift, UserPlus, Loader2, Trash2, AlertCircle, MailX, RefreshCw } from 'lucide-react';
import type { FreeAccessEntry } from './adminTypes';
import {
  listFreeAccess,
  grantFreeAccess,
  revokeFreeAccess,
  sortEntriesNewestFirst,
} from './freeAccessClient';
import { formatDate } from './customerRows';
import { ConfirmDialog } from './ConfirmDialog';

// Same pragmatic shape check the server uses — reject obvious typos before the
// round-trip. The server re-validates; this is only for fast inline feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: FreeAccessEntry[] };

interface FreeAccessManagerProps {
  /** Called after any successful grant/revoke so the parent can reconcile. */
  onChanged?: () => void;
}

export function FreeAccessManager({ onChanged }: FreeAccessManagerProps) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  // Removal confirm + per-row pending.
  const [toRemove, setToRemove] = useState<FreeAccessEntry | null>(null);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const emailRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const data = await listFreeAccess(signal);
      setState({ kind: 'ready', entries: sortEntriesNewestFirst(data.entries) });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Couldn’t load the free-access list.',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setFormOk(null);
      const value = email.trim().toLowerCase();
      if (!EMAIL_RE.test(value)) {
        setFormError('Enter a valid email address.');
        emailRef.current?.focus();
        return;
      }
      setSubmitting(true);
      try {
        await grantFreeAccess(value, note);
        setEmail('');
        setNote('');
        setFormOk(`${value} now has free access.`);
        await load();
        onChanged?.();
        emailRef.current?.focus();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'Couldn’t grant free access.');
      } finally {
        setSubmitting(false);
      }
    },
    [email, note, load, onChanged],
  );

  const handleRemove = useCallback(async () => {
    if (!toRemove) return;
    const entry = toRemove;
    setToRemove(null);
    setRemoving((p) => ({ ...p, [entry.id]: true }));
    // Optimistic removal from the list.
    setState((prev) =>
      prev.kind === 'ready'
        ? { kind: 'ready', entries: prev.entries.filter((x) => x.id !== entry.id) }
        : prev,
    );
    try {
      await revokeFreeAccess(entry.email);
      onChanged?.();
    } catch (err) {
      // Roll back by reloading the authoritative list + surface the error.
      setFormError(err instanceof Error ? err.message : 'Couldn’t revoke free access.');
      await load();
    } finally {
      setRemoving((p) => {
        if (!(entry.id in p)) return p;
        const next = { ...p };
        delete next[entry.id];
        return next;
      });
    }
  }, [toRemove, load, onChanged]);

  const total = state.kind === 'ready' ? state.entries.length : null;
  const emailValid = useMemo(() => EMAIL_RE.test(email.trim().toLowerCase()), [email]);

  return (
    <section
      aria-labelledby="free-access-heading"
      className="rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div className="flex items-start gap-3">
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600"
            aria-hidden="true"
          >
            <Gift className="h-4 w-4" />
          </span>
          <div>
            <h2 id="free-access-heading" className="text-sm font-bold text-slate-800">
              Free access
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Comp any email — registered or not — with full Pro access. It applies the moment they
              sign in.
            </p>
          </div>
        </div>
        {total !== null && (
          <span className="mt-0.5 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            <span className="tabular-nums">{total}</span>
            {total === 1 ? 'grant' : 'grants'}
          </span>
        )}
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:flex-1">
            <label htmlFor="free-access-email" className="mb-1 block text-xs font-medium text-slate-600">
              Email
            </label>
            <input
              ref={emailRef}
              id="free-access-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (formError) setFormError(null);
                if (formOk) setFormOk(null);
              }}
              placeholder="person@example.com"
              aria-invalid={email.length > 0 && !emailValid}
              aria-describedby={formError ? 'free-access-form-error' : undefined}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
          </div>
          <div className="sm:flex-1">
            <label htmlFor="free-access-note" className="mb-1 block text-xs font-medium text-slate-600">
              Note <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="free-access-note"
              type="text"
              maxLength={500}
              autoComplete="off"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. beta tester, friend"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-500/20"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !emailValid}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            )}
            Grant access
          </button>
        </div>

        {formError && (
          <p id="free-access-form-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {formError}
          </p>
        )}
        {formOk && (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <Gift className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {formOk}
          </p>
        )}
      </form>

      {/* List */}
      <div className="px-2 py-2">
        {state.kind === 'loading' && (
          <div className="space-y-2 p-3" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" role="alert">
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

        {state.kind === 'ready' && state.entries.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            No free-access grants yet. Add an email above to comp someone.
          </p>
        )}

        {state.kind === 'ready' && state.entries.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {state.entries.map((entry) => {
              const isRemoving = !!removing[entry.id];
              return (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-[13px] text-slate-800" title={entry.email}>
                        {entry.email}
                      </span>
                      {!entry.registered && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200"
                          title="No account has signed up with this email yet — access applies as soon as one does."
                        >
                          <MailX className="h-3 w-3" aria-hidden="true" />
                          Not registered yet
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      {entry.note ? <span className="text-slate-600">{entry.note} · </span> : null}
                      Granted {formatDate(entry.grantedAt)} by {entry.grantedBy}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setToRemove(entry)}
                    disabled={isRemoving}
                    aria-label={`Remove free access for ${entry.email}`}
                    className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove free access?"
        tone="danger"
        confirmLabel="Remove access"
        onCancel={() => setToRemove(null)}
        onConfirm={handleRemove}
        description={
          toRemove ? (
            <>
              <span className="font-medium text-slate-800">{toRemove.email}</span> will lose
              complimentary access. If they have a subscription or active trial, that takes over
              again; otherwise they’ll hit the paywall. You can re-add them anytime.
            </>
          ) : null
        }
      />
    </section>
  );
}

export default FreeAccessManager;
