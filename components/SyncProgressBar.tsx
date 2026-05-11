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
    syncTimedOut?: boolean;
    syncCompleteNotification?: SyncCompleteCounts | null;
    clearSyncNotification?: () => void;
    syncData?: (opts: object) => void;
    syncProgress?: SyncProgressShape | null;
  };

  const isSyncing = phone.isSyncing ?? false;
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

  // ── 3. Syncing banner with per-row progress ────────────────────────────
  if (isSyncing) {
    const rows = [
      { key: 'contacts', label: 'Contacts', data: syncProgress?.contacts },
      { key: 'messages', label: 'Messages', data: syncProgress?.messages },
      { key: 'callLogs', label: 'Call Logs', data: syncProgress?.callLogs },
    ] as const;

    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-0 left-0 right-0 z-50 transition-transform duration-300 ease-out translate-y-0"
      >
        <div className="bg-slate-900 text-white shadow-lg shadow-slate-900/30 border-b border-slate-800">
          <div className="px-5 py-3 space-y-2">
            {rows.map(({ key, label, data }) => {
              const done = data?.done ?? 0;
              const total = data?.total ?? 0;
              const complete = data?.complete ?? false;
              const fill = complete ? 100 : pct(done, total);
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-medium text-slate-300 flex-shrink-0">{label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-[width] duration-300',
                        complete ? 'bg-emerald-400' : 'bg-blue-400'
                      )}
                      style={{ width: `${fill}%` }}
                    />
                  </div>
                  <span className="w-20 text-[11px] tabular-nums text-slate-400 text-right flex-shrink-0">
                    {total > 0
                      ? complete
                        ? `${total.toLocaleString()} ✓`
                        : `${done.toLocaleString()} / ${total.toLocaleString()}`
                      : <Loader2 className="w-3 h-3 inline motion-safe:animate-spin" aria-hidden="true" />
                    }
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return null;
};
