'use client';

/**
 * FreeAccessManager — the "comp any email" panel (P4).
 *
 * Free access is an email-keyed allowlist, so an email can be granted whether
 * or not an account exists yet. This panel lets Dennis:
 *   • add an email (+ optional note) and pick a DURATION → grant free access
 *     (POST). Presets: 7 / 30 / 90 days / Permanent / Custom. Default 30 days —
 *     a time-boxed comp is the safer default than a permanent bypass.
 *   • see every current grant, with who/when, whether the email is registered,
 *     and its window as a status chip (Permanent / Expires in X days / Expired).
 *   • remove a grant (DELETE), behind a confirm (it's a billing bypass).
 *
 * Re-granting an email that already has a grant REFRESHES/EXTENDS its window
 * (backend upsert), so the button and success copy read "Extend" for a listed
 * email rather than implying a duplicate.
 *
 * The grant email is best-effort: a mail failure never fails the grant, so when
 * `emailSent` comes back false we surface a non-blocking warning ("access
 * granted, but the notification email failed to send").
 *
 * It owns its own fetch of `GET /api/admin/free-access` and reconciles after
 * every mutation. When the allowlist changes it also calls `onChanged` so the
 * parent can refetch the customers table (a grant/revoke here flips a row
 * there). Presentation matches the admin dashboard: white cards, slate ramp,
 * violet as the free-access accent, rounded-2xl, visible focus rings.
 *
 * A11y: labelled inputs, a labelled radiogroup (native radios) for the duration,
 * `role="status"`/`role="alert"` live regions for async feedback, status chips
 * that carry text (never colour alone), confirm dialog for removals.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gift, UserPlus, Loader2, Trash2, AlertCircle, MailX, RefreshCw, X } from 'lucide-react';
import type { FreeAccessEntry } from './adminTypes';
import {
  listFreeAccess,
  grantFreeAccess,
  revokeFreeAccess,
  sortEntriesNewestFirst,
} from './freeAccessClient';
import {
  DURATION_OPTIONS,
  DEFAULT_PRESET,
  MAX_DURATION_DAYS,
  resolveDurationDays,
  describeExpiry,
  type DurationPreset,
  type ChipTone,
} from './freeAccessDuration';
import { formatDate } from './customerRows';
import { ConfirmDialog } from './ConfirmDialog';

// Same pragmatic shape check the server uses — reject obvious typos before the
// round-trip. The server re-validates; this is only for fast inline feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: FreeAccessEntry[] };

// Chip tone → Tailwind classes, keyed to the admin dashboard's ramp.
const CHIP_TONE: Record<ChipTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  accent: 'bg-violet-50 text-violet-700 ring-violet-200',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
};

interface FreeAccessManagerProps {
  /** Called after any successful grant/revoke so the parent can reconcile. */
  onChanged?: () => void;
}

export function FreeAccessManager({ onChanged }: FreeAccessManagerProps) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [preset, setPreset] = useState<DurationPreset>(DEFAULT_PRESET);
  const [customDays, setCustomDays] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  // Non-blocking warning: the grant succeeded but the notification email didn't.
  const [mailWarning, setMailWarning] = useState<string | null>(null);
  // Removal confirm + per-row pending.
  const [toRemove, setToRemove] = useState<FreeAccessEntry | null>(null);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

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

  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = useMemo(() => EMAIL_RE.test(normalizedEmail), [normalizedEmail]);

  // Does this email already have a grant? Re-granting extends its window, so the
  // CTA reads "Extend access" and the success copy says the window was extended.
  const alreadyListed = useMemo(() => {
    if (state.kind !== 'ready' || !emailValid) return false;
    return state.entries.some((e) => e.email.toLowerCase() === normalizedEmail);
  }, [state, emailValid, normalizedEmail]);

  const clearFeedback = useCallback(() => {
    if (formError) setFormError(null);
    if (formOk) setFormOk(null);
  }, [formError, formOk]);

  const handleAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setFormOk(null);
      setMailWarning(null);

      if (!EMAIL_RE.test(normalizedEmail)) {
        setFormError('Enter a valid email address.');
        emailRef.current?.focus();
        return;
      }
      const duration = resolveDurationDays(preset, customDays);
      if (!duration.ok) {
        setFormError(duration.reason);
        customRef.current?.focus();
        return;
      }

      const extending = alreadyListed;
      setSubmitting(true);
      try {
        const { emailSent } = await grantFreeAccess(normalizedEmail, note, duration.days);
        const windowLabel =
          duration.days == null ? 'permanent access' : `${duration.days}-day access`;
        setEmail('');
        setNote('');
        setPreset(DEFAULT_PRESET);
        setCustomDays('');
        setFormOk(
          extending
            ? `${normalizedEmail}’s window was extended — now ${windowLabel}.`
            : `${normalizedEmail} now has ${windowLabel}.`,
        );
        if (!emailSent) {
          setMailWarning(
            'Access was granted, but the notification email failed to send. Let them know manually.',
          );
        }
        await load();
        onChanged?.();
        emailRef.current?.focus();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'Couldn’t grant free access.');
      } finally {
        setSubmitting(false);
      }
    },
    [normalizedEmail, note, preset, customDays, alreadyListed, load, onChanged],
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
  // Single "now" per render pass so every chip agrees on the clock.
  const now = Date.now();

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
              Comp any email — registered or not — with full Pro access for a set window. It applies
              the moment they sign in.
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
                clearFeedback();
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
        </div>

        {/* Duration picker */}
        <fieldset className="mt-3">
          <legend className="mb-1.5 text-xs font-medium text-slate-600">Duration</legend>
          <div
            role="radiogroup"
            aria-label="Free-access duration"
            className="flex flex-wrap gap-1.5"
          >
            {DURATION_OPTIONS.map((opt) => {
              const active = preset === opt.value;
              return (
                <label
                  key={opt.value}
                  className={[
                    'inline-flex cursor-pointer items-center rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors',
                    'focus-within:ring-2 focus-within:ring-violet-500/40',
                    active
                      ? 'border-violet-300 bg-violet-50 text-violet-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="free-access-duration"
                    value={opt.value}
                    checked={active}
                    onChange={() => {
                      setPreset(opt.value);
                      clearFeedback();
                      if (opt.value === 'custom') {
                        // Focus the day input once it renders.
                        requestAnimationFrame(() => customRef.current?.focus());
                      }
                    }}
                    className="sr-only"
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>

          {preset === 'custom' && (
            <div className="mt-2.5">
              <label
                htmlFor="free-access-custom-days"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Number of days
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={customRef}
                  id="free-access-custom-days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_DURATION_DAYS}
                  step={1}
                  value={customDays}
                  onChange={(e) => {
                    setCustomDays(e.target.value);
                    clearFeedback();
                  }}
                  placeholder="e.g. 14"
                  aria-describedby="free-access-custom-hint"
                  className="w-28 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
                <span id="free-access-custom-hint" className="text-[11px] text-slate-400">
                  1–{MAX_DURATION_DAYS} days
                </span>
              </div>
            </div>
          )}
        </fieldset>

        <div className="mt-3.5 flex justify-end">
          <button
            type="submit"
            disabled={submitting || !emailValid}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            )}
            {alreadyListed ? 'Extend access' : 'Grant access'}
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
        {mailWarning && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800"
          >
            <MailX className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="flex-1">{mailWarning}</span>
            <button
              type="button"
              onClick={() => setMailWarning(null)}
              aria-label="Dismiss warning"
              className="flex-shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
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
              const chip = describeExpiry(entry, now);
              const expired = entry.status === 'expired';
              return (
                <li
                  key={entry.id}
                  className={[
                    'flex items-center gap-3 px-3 py-2.5',
                    expired ? 'opacity-70' : '',
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-[13px] text-slate-800" title={entry.email}>
                        {entry.email}
                      </span>
                      {/* Status chip — text-first, never colour alone. */}
                      <span
                        className={[
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
                          CHIP_TONE[chip.tone],
                        ].join(' ')}
                        title={chip.title}
                      >
                        {chip.label}
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
