'use client';

/**
 * ReconcileWhopButton — the manual "check everyone against Whop" lever
 * (2026-08-12, feat/articles-cms-ui addendum).
 *
 * Context that shapes the design: on 2026-08-11 a paying customer was invisible
 * in this panel for a full day because a payment webhook silently failed to
 * match. There is no cron in this app, so `POST /api/admin/reconcile-whop` has
 * exactly one trigger — this button. That makes it a product surface, not a
 * debug tool, so it sits in the open at the top of the customers section and
 * reads like reassurance rather than a red button.
 *
 * Deliberately NO confirm dialog: the operation is idempotent and read-only
 * against Whop. Making someone confirm a harmless action teaches them to click
 * through confirms, which is how the dangerous ones get clicked through too.
 *
 * It does paginate the Whop API, so it takes a few seconds: the button disables
 * itself in flight (no double-fire), shows progress, and the result lands in a
 * live region as plain English — counts, not a status code.
 */

import React, { useCallback, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCcw } from 'lucide-react';

/** The shape of `ReconcileSummary` that this UI actually reads. */
interface ReconcileSummary {
  scanned?: number;
  matched?: number;
  unmatched?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
}

type Result =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Turn the summary into a sentence.
 *
 * `matched` is the number of Whop memberships that mapped to one of our
 * accounts, which is the honest answer to "how many customers were checked".
 * `created + updated` is what actually changed. `unmatched` only gets a mention
 * when it is non-zero, because that is the case that needs a human.
 */
function describe(summary: ReconcileSummary): string {
  const checked = num(summary.matched) || num(summary.scanned);
  const changed = num(summary.created) + num(summary.updated);
  const unmatched = num(summary.unmatched);

  const head =
    changed === 0
      ? `Checked ${plural(checked, 'customer', 'customers')}. Everything was already up to date.`
      : `Checked ${plural(checked, 'customer', 'customers')}, updated ${changed}.`;

  if (unmatched > 0) {
    return `${head} ${plural(unmatched, 'payment', 'payments')} in Whop couldn’t be matched to an account here — worth a look.`;
  }
  return head;
}

export interface ReconcileWhopButtonProps {
  /** Called after a successful run so the parent can refetch the customer table. */
  onReconciled?: () => void;
}

export function ReconcileWhopButton({ onReconciled }: ReconcileWhopButtonProps) {
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const running = result.kind === 'running';

  const run = useCallback(async () => {
    setResult({ kind: 'running' });
    try {
      const res = await fetch('/api/admin/reconcile-whop', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // An empty object rather than no body: the endpoint reads `dryRun` off
        // the body, and sending `{}` says "this is a real run" explicitly.
        body: JSON.stringify({}),
      });

      if (res.status === 401 || res.status === 403) {
        setResult({
          kind: 'error',
          message: 'Your admin session has expired. Reload the page and sign in again.',
        });
        return;
      }
      if (!res.ok) {
        setResult({
          kind: 'error',
          message:
            'Couldn’t reach Whop just now, so nothing was changed. Try again in a moment.',
        });
        return;
      }

      const body = (await res.json()) as { ok?: boolean; summary?: ReconcileSummary };
      setResult({ kind: 'ok', message: describe(body?.summary ?? {}) });
      // Refresh the table so the new statuses and paid-until dates are visible
      // immediately — the whole point is seeing the customer who was missing.
      onReconciled?.();
    } catch {
      setResult({
        kind: 'error',
        message: 'Couldn’t reach the server. Check your connection and try again.',
      });
    }
  }, [onReconciled]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-800">Subscription sync</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Checks every customer against Whop and updates their status and paid-until date.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex flex-shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? (
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          )}
          {running ? 'Checking with Whop…' : 'Re-sync with Whop'}
        </button>
      </div>

      {/* One region for every outcome, so a screen reader hears the result the
          same moment a sighted user reads it. Kept mounted so the announcement
          is not lost to a remount race. */}
      <div aria-live="polite" className="empty:hidden">
        {result.kind === 'running' && (
          <p className="mt-3 text-xs text-slate-500">
            This checks every payment in Whop, so it takes a few seconds.
          </p>
        )}
        {result.kind === 'ok' && (
          <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {result.message}
          </p>
        )}
        {result.kind === 'error' && (
          <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-red-600">
            <AlertCircle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {result.message}
          </p>
        )}
      </div>
    </div>
  );
}

export default ReconcileWhopButton;
