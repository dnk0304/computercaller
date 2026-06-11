'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, X, RefreshCw, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';

const AUTO_DISMISS_MS = 5000;

interface SyncCompleteCounts {
  contacts: number;
  messages: number;
  callLogs: number;
}

/**
 * Top-of-page sync banner.
 *
 * Three mutually-exclusive states:
 *   1. Timeout  — amber alert with retry CTA
 *   2. Syncing  — slate banner with spinner: "Syncing in background…"
 *      A single static element that appears once and stays visible until done.
 *      No per-row counts updating, no re-render-per-chunk flicker.
 *   3. Complete — emerald toast with the final tallies, auto-dismiss after 5s
 *
 * The hook is responsible for not pushing intermediate progress updates;
 * this component just reflects the high-level lifecycle.
 */
interface SyncProgressShape {
  contacts: { done: number; total: number; complete: boolean };
  messages: { done: number; total: number; complete: boolean };
  callLogs:  { done: number; total: number; complete: boolean };
}

function pct(done: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

export const SyncProgressBar = () => {
  const phone = usePhone() as ReturnType<typeof usePhone> & {
    isSyncing?: boolean;
    quietSyncing?: boolean;
    syncTimedOut?: boolean;
    syncCompleteNotification?: SyncCompleteCounts | null;
    clearSyncNotification?: () => void;
    syncData?: (opts: object) => void;
    syncProgress?: SyncProgressShape | null;
    cancelSync?: () => void;
    openSyncPanel?: () => void;
  };

  const isSyncing = phone.isSyncing ?? false;
  const quietSyncing = phone.quietSyncing ?? false;
  const syncTimedOut = phone.syncTimedOut ?? false;
  const syncCompleteNotification = phone.syncCompleteNotification ?? null;
  const syncProgress = phone.syncProgress ?? null;

  const [timeoutDismissed, setTimeoutDismissed] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);

  // Reset the timeout-dismiss flag whenever a new timeout fires so the
  // next failure surfaces again. "Adjust state during render" pattern —
  // safe per React 19 docs.
  const [prevSyncTimedOut, setPrevSyncTimedOut] = useState(false);
  if (prevSyncTimedOut !== syncTimedOut) {
    setPrevSyncTimedOut(syncTimedOut);
    if (syncTimedOut) setTimeoutDismissed(false);
  }

  // Auto-dismiss the success toast after 5 s.
  useEffect(() => {
    if (!syncCompleteNotification) return;
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      phone.clearSyncNotification?.();
      dismissTimerRef.current = null;
    }, AUTO_DISMISS_MS);

    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
    // phone.clearSyncNotification is stable (useCallback in the hook), but
    // we list it for exhaustive-deps correctness.
  }, [syncCompleteNotification, phone.clearSyncNotification, phone]);

  const dismissCompletion = () => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    phone.clearSyncNotification?.();
  };

  // ── 1. Timeout banner ──────────────────────────────────────────────────
  if (!timeoutDismissed && syncTimedOut) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed top-0 left-0 right-0 z-50 translate-y-0 transition-transform duration-300"
      >
        <div className="bg-amber-900 text-white shadow-lg border-b border-amber-800">
          <div className="px-5 py-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-300 flex-shrink-0" />
            <span className="flex-1 text-sm font-medium text-amber-100">
              Phone didn&apos;t respond — connection may have dropped.
            </span>
            <button
              type="button"
              onClick={() => {
                setTimeoutDismissed(false);
                phone.syncData?.({ contacts: true, messages: true, callLogs: true });
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
            <button
              type="button"
              onClick={() => setTimeoutDismissed(true)}
              aria-label="Dismiss"
              className="p-1.5 -m-1 text-amber-400 hover:text-white hover:bg-amber-800 rounded-lg transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 2. Completion toast ────────────────────────────────────────────────
  // Show before the syncing banner so a fresh completion overrides it.
  if (syncCompleteNotification) {
    const { contacts, messages, callLogs } = syncCompleteNotification;
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-0 left-0 right-0 z-50 transition-transform duration-300 ease-out translate-y-0 animate-in slide-in-from-top duration-300"
      >
        <div className="bg-emerald-600 text-white shadow-lg shadow-emerald-900/30 border-b border-emerald-700">
          <div className="px-5 py-3 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="w-6 h-6 rounded-full bg-emerald-500/40 flex items-center justify-center flex-shrink-0"
            >
              <CheckCircle2 className="w-4 h-4 text-white" />
            </span>
            <span className="flex-1 text-sm font-medium text-white">
              Synced: {contacts.toLocaleString()} contacts,{' '}
              {messages.toLocaleString()} messages, {callLogs.toLocaleString()} calls
            </span>
            <button
              type="button"
              onClick={dismissCompletion}
              aria-label="Dismiss"
              className="px-2 py-1 -my-1 text-emerald-100 hover:text-white hover:bg-emerald-700 rounded-md transition-colors text-xs font-semibold flex-shrink-0"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={dismissCompletion}
              aria-label="Close"
              className="p-1.5 -m-1 text-emerald-200 hover:text-white hover:bg-emerald-700 rounded-lg transition-colors flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 2.5 Quiet sync — subtle inline banner for the auto-connect quicksync
  //
  // Issue 1 (2026-06-11): the auto-connect quicksync must show its count
  // WITHOUT the heavy floating modal. Thin passive top banner, same family as
  // the timeout/completion banners: no backdrop, no blur, no buttons, does
  // not block clicks, auto-vanishes when quietSyncing flips false. The modal
  // wins if both flags are somehow true (manual sync started mid-quicksync).
  if (quietSyncing && !isSyncing) {
    const msg = syncProgress?.messages;
    const hasCount = !!msg && msg.total > 0;
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-0 left-0 right-0 z-40 pointer-events-none"
      >
        <div className="bg-slate-900/95 text-slate-200 shadow-md border-b border-slate-800">
          <div className="px-5 py-2 flex items-center gap-2.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 flex-shrink-0" />
            <span className="text-xs font-medium">
              {hasCount
                ? `Syncing recent messages… ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()}`
                : 'Syncing recent activity…'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── 3. Syncing — centered floating modal with per-row progress + Cancel/Restart
  //
  // Earlier this was a thin top-of-screen banner. User wanted it as a centered
  // floating modal with the ability to cancel an in-flight sync and restart
  // with different settings — surfaces sync as a focused, interruptible
  // operation instead of a passive background tick.
  if (isSyncing) {
    const rows = [
      { key: 'contacts', label: 'Contacts', data: syncProgress?.contacts },
      { key: 'messages', label: 'Messages', data: syncProgress?.messages },
      { key: 'callLogs', label: 'Call Logs', data: syncProgress?.callLogs },
    ] as const;

    const handleCancel = () => phone.cancelSync?.();
    const handleRestart = () => {
      phone.cancelSync?.();
      // Tiny delay so the modal unmounts cleanly before the setup panel
      // re-opens — avoids a render where both are momentarily mounted.
      window.setTimeout(() => phone.openSyncPanel?.(), 50);
    };

    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-progress-title"
        className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-200"
      >
        {/* Backdrop — non-dismissive on click; user must use Cancel/Restart.
            This is an intentional "modal commitment" pattern: the user is
            mid-operation, accidental backdrop clicks shouldn't abandon it. */}
        <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" aria-hidden="true" />

        {/* Card */}
        <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl shadow-slate-900/30 overflow-hidden animate-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-start gap-3">
            <span
              aria-hidden="true"
              className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-500/20"
            >
              <Loader2 className="w-5 h-5 text-white motion-safe:animate-spin" />
            </span>
            <div className="flex-1 min-w-0">
              <h2 id="sync-progress-title" className="text-base font-bold text-slate-900">
                Syncing from phone
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Pulling contacts, messages, and call logs in the background.
              </p>
            </div>
          </div>

          {/* Per-row progress */}
          <div className="px-5 py-4 space-y-3">
            {rows.map(({ key, label, data }) => {
              const done = data?.done ?? 0;
              const total = data?.total ?? 0;
              const complete = data?.complete ?? false;
              const fill = complete ? 100 : pct(done, total);
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-slate-700">{label}</span>
                    <span className="text-[11px] tabular-nums text-slate-500">
                      {complete && total > 0 ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          {total.toLocaleString()}
                        </span>
                      ) : complete ? (
                        // Complete with no rows to pull (e.g. contacts during
                        // the auto-connect quicksync, which fetches messages +
                        // call logs only). Show a calm "done" check, NOT a
                        // spinner — a complete row must never appear to be
                        // still working. (Issue 2, Forge 2026-06-11.)
                        <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          Done
                        </span>
                      ) : total > 0 ? (
                        `${done.toLocaleString()} / ${total.toLocaleString()}`
                      ) : (
                        <Loader2 className="w-3 h-3 inline motion-safe:animate-spin" aria-hidden="true" />
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-[width] duration-300',
                        complete ? 'bg-emerald-500' : 'bg-blue-500'
                      )}
                      style={{ width: `${fill}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleCancel}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white hover:bg-rose-50 rounded-lg transition-colors border border-rose-200"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRestart}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 rounded-lg transition-colors border border-slate-200"
              title="Cancel and re-open the sync setup panel"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Restart with different settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
