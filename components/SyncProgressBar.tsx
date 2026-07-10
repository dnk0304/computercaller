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

interface SyncProgressShape {
  contacts: { done: number; total: number; complete: boolean };
  messages: { done: number; total: number; complete: boolean };
  callLogs: { done: number; total: number; complete: boolean };
}

function pct(done: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/**
 * SyncProgressBar — the in-flow sync lifecycle bar.
 *
 * Redesigned 2026-07-10 (Pixel, sync-nonblocking-bar): the old full-screen
 * `aria-modal` sync dialog blocked the entire app until a full sync finished.
 * Dennis's directive: "a bar that pushes the header down and comes above it,
 * just loading while you still can use it." Data already streams into the
 * lists progressively (usePhoneBridge), so nothing needs the app locked.
 *
 * This component now renders in NORMAL DOCUMENT FLOW — mounted by AppShell
 * directly above the header — and participates in layout: when a state is
 * active the bar expands (CSS grid-template-rows 0fr→1fr, animated; honors
 * prefers-reduced-motion) and pushes the header + content down; when it
 * clears, the header slides back up. No fixed positioning, no backdrop, no
 * blur, no aria-modal, no pointer capture. The app stays fully interactive.
 *
 * Four mutually-exclusive states, one visual family:
 *   1. Timeout   — amber, role="alert", Retry + dismiss
 *   2. Complete  — emerald, final tallies, 5s auto-dismiss + manual dismiss
 *   3. Syncing   — slate/blue, aggregate per-type counts + combined progress
 *                  fill, Cancel + Restart actions (same handlers the modal had)
 *   4. Quiet     — thinner passive variant for the auto-connect quicksync
 *                  (never shows Cancel/Restart; purely informational)
 *
 * Priority: timeout > complete > syncing > quiet (a fresh completion
 * overrides the syncing row; a manual sync outranks the quiet banner).
 */
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

  // Auto-dismiss the success state after 5 s.
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
  }, [syncCompleteNotification, phone.clearSyncNotification, phone]);

  const dismissCompletion = () => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    phone.clearSyncNotification?.();
  };

  const handleCancel = () => phone.cancelSync?.();
  const handleRestart = () => {
    phone.cancelSync?.();
    // Tiny delay so the bar's syncing state clears before the setup panel
    // re-opens — avoids a render where both react to the same tick.
    window.setTimeout(() => phone.openSyncPanel?.(), 50);
  };

  // ── Resolve the active state (priority order) ────────────────────────────
  const showTimeout = !timeoutDismissed && syncTimedOut;
  const showComplete = !showTimeout && !!syncCompleteNotification;
  const showSyncing = !showTimeout && !showComplete && isSyncing;
  const showQuiet = !showTimeout && !showComplete && !showSyncing && quietSyncing;
  const visible = showTimeout || showComplete || showSyncing || showQuiet;

  // ── Content per state ────────────────────────────────────────────────────
  let content: React.ReactNode = null;

  if (showTimeout) {
    content = (
      <div role="alert" className="bg-amber-900 text-white border-b border-amber-800">
        <div className="px-4 sm:px-5 py-2.5 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-300 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-amber-100">
            Phone didn&apos;t respond — connection may have dropped.
          </span>
          <button
            type="button"
            onClick={() => {
              setTimeoutDismissed(false);
              phone.syncData?.({ contacts: true, messages: true, callLogs: true });
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>
          <button
            type="button"
            onClick={() => setTimeoutDismissed(true)}
            aria-label="Dismiss"
            className="p-1.5 -m-1 text-amber-400 hover:text-white hover:bg-amber-800 rounded-lg transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  } else if (showComplete && syncCompleteNotification) {
    const { contacts, messages, callLogs } = syncCompleteNotification;
    content = (
      <div className="bg-emerald-600 text-white border-b border-emerald-700">
        <div className="px-4 sm:px-5 py-2.5 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-full bg-emerald-500/40 flex items-center justify-center flex-shrink-0"
          >
            <CheckCircle2 className="w-4 h-4 text-white" />
          </span>
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-white">
            Synced: {contacts.toLocaleString()} contacts,{' '}
            {messages.toLocaleString()} messages, {callLogs.toLocaleString()} calls
          </span>
          <button
            type="button"
            onClick={dismissCompletion}
            className="px-2.5 py-1 text-emerald-100 hover:text-white hover:bg-emerald-700 rounded-md transition-colors text-xs font-semibold flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  } else if (showSyncing) {
    const rows = [
      { key: 'contacts', label: 'Contacts', data: syncProgress?.contacts },
      { key: 'messages', label: 'Messages', data: syncProgress?.messages },
      { key: 'callLogs', label: 'Calls', data: syncProgress?.callLogs },
    ] as const;

    // Combined fill across everything with a known total. Indeterminate
    // (shimmer) until at least one total arrives.
    const knownTotal = rows.reduce((n, r) => n + (r.data?.total ?? 0), 0);
    const knownDone = rows.reduce(
      (n, r) => n + (r.data?.complete ? (r.data?.total ?? 0) : Math.min(r.data?.done ?? 0, r.data?.total ?? 0)),
      0
    );
    const hasTotals = knownTotal > 0;
    const fill = pct(knownDone, knownTotal);

    content = (
      <div className="bg-slate-900 text-slate-100 border-b border-slate-800 relative">
        <div className="px-4 sm:px-5 py-2.5 flex items-center gap-3">
          <Loader2
            className="w-4 h-4 motion-safe:animate-spin text-blue-400 flex-shrink-0"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0 flex items-baseline gap-x-3 gap-y-0.5 flex-wrap">
            <span className="text-sm font-semibold whitespace-nowrap">
              Syncing from phone
            </span>
            <span className="text-xs text-slate-400 tabular-nums truncate">
              {rows.map(({ key, label, data }, i) => {
                const done = data?.done ?? 0;
                const total = data?.total ?? 0;
                const complete = data?.complete ?? false;
                return (
                  <React.Fragment key={key}>
                    {i > 0 && <span aria-hidden="true"> · </span>}
                    <span className={clsx(complete && 'text-emerald-400')}>
                      {label}{' '}
                      {complete
                        ? 'done'
                        : total > 0
                          ? `${done.toLocaleString()}/${total.toLocaleString()}`
                          : '…'}
                    </span>
                  </React.Fragment>
                );
              })}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:text-rose-200 hover:bg-rose-950/60 rounded-lg transition-colors border border-rose-900/60 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRestart}
            title="Cancel and re-open the sync setup panel"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors border border-slate-700 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Restart</span>
            <span className="sr-only sm:hidden">Restart with different settings</span>
          </button>
        </div>
        {/* Combined progress fill along the bar's bottom edge. Determinate
            once totals are known; a gentle indeterminate shimmer before. */}
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-800 overflow-hidden" aria-hidden="true">
          {hasTotals ? (
            <div
              className="h-full bg-blue-500 transition-[width] duration-300"
              style={{ width: `${fill}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-blue-500/70 motion-safe:animate-pulse" />
          )}
        </div>
      </div>
    );
  } else if (showQuiet) {
    const msg = syncProgress?.messages;
    const hasCount = !!msg && msg.total > 0;
    content = (
      <div className="bg-slate-900/95 text-slate-200 border-b border-slate-800">
        <div className="px-4 sm:px-5 py-1.5 flex items-center gap-2.5">
          <Loader2
            className="w-3.5 h-3.5 motion-safe:animate-spin text-slate-400 flex-shrink-0"
            aria-hidden="true"
          />
          <span className="text-xs font-medium">
            {hasCount
              ? `Syncing recent messages… ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()}`
              : 'Syncing recent activity…'}
          </span>
        </div>
      </div>
    );
  }

  // ── In-flow expanding wrapper ─────────────────────────────────────────────
  // grid-template-rows 0fr→1fr animates the bar's height in normal flow, so
  // the header (and everything below) is pushed down / released smoothly.
  // motion-reduce disables the transition; the bar simply appears/disappears.
  // The wrapper is always mounted so the transition has a stable element.
  // role="status" aria-live="polite" lives on the wrapper so state changes
  // (syncing → complete) announce without re-inserting a live region; the
  // timeout state carries its own role="alert" for assertive announcement.
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'grid w-full flex-shrink-0 transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none',
        visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
    >
      <div className="min-h-0 overflow-hidden">{content}</div>
    </div>
  );
};
