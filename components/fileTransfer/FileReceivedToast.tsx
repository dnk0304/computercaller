'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';

import { formatBytes } from './ftFormat';

/** Mirrors lib/fileTransfer/openReceived.ts. */
export type OpenOutcome = 'opened' | 'denied' | 'blocked' | 'gone';

/** What to say when Open did not simply work. `opened` needs no words. */
const OPEN_FAILURE_COPY: Record<Exclude<OpenOutcome, 'opened'>, string> = {
  denied: 'Permission to open the file was declined.',
  blocked: 'Your browser blocked the new tab. Allow pop-ups for this site to open it.',
  gone: 'That file is no longer available to open from here. It is still saved where you chose.',
};

/**
 * components/fileTransfer/FileReceivedToast.tsx — FT-3b (a). The completion
 * toast for a received file.
 *
 * ── "SHOW IN FOLDER" DOES NOT EXIST ON THE WEB, AND SAYING SO IS THE DESIGN ──
 * The brief asked for "Show in folder"/open. There is NO web API that reveals a
 * file in the OS file manager: Chrome exposes that only to its own downloads UI
 * (`chrome.downloads.show`), and this file never goes through the download path
 * at all — the user picked its destination themselves in `showSaveFilePicker`,
 * so it was written straight to the folder they chose. A button that cannot do
 * what its label says is worse than no button, so "Show in folder" is absent
 * from this component and from the copy. Ruled correct by Ken (R-AN).
 *
 * ── "OPEN" IS NOW REAL ──────────────────────────────────────────────────────
 * FT-3a.1 surfaces the completed receive while its handle is still held
 * (`completed: {id, name, canOpen}`) and `openReceived(id)`, which re-checks
 * permission on every call — a granted permission is a snapshot, not a property
 * of the handle. The handle is released after HANDLE_RETENTION_MS, at which
 * point `canOpen` goes false and the button disappears rather than failing.
 *
 * The four outcomes are all rendered, because three of them are silent
 * otherwise and a button that appears to do nothing is the worst of the set:
 *   opened  — nothing to say; the tab is there.
 *   denied  — the user declined the permission re-prompt.
 *   blocked — the browser suppressed the popup.
 *   gone    — the handle expired or the file moved.
 *
 * ── z-INDEX ─────────────────────────────────────────────────────────────────
 * z-40, matching NotificationToast in PhoneModeShell and staying strictly below
 * CallModal's z-50. A file toast must never cover a ringing call.
 */

/** Matches TOAST_AUTO_HIDE_MS in PhoneModeShell — one dwell time on this surface. */
export const FT_TOAST_AUTO_HIDE_MS = 4000;

export interface FileReceivedToastProps {
  name: string;
  /** Omitted once the transfer record no longer carries it. */
  size?: number;
  onDismiss: () => void;
  /**
   * Opens the received file. Undefined when the handle has been released
   * (`completed.canOpen === false`) — the button is omitted rather than
   * disabled, because a permanently greyed control reads as a bug.
   */
  onOpen?: () => Promise<OpenOutcome>;
}

export function FileReceivedToast({ name, size, onDismiss, onOpen }: FileReceivedToastProps) {
  const [outcome, setOutcome] = useState<OpenOutcome | null>(null);
  const failure = outcome && outcome !== 'opened' ? OPEN_FAILURE_COPY[outcome] : null;

  const open = useCallback(() => {
    if (!onOpen) return;
    // Floated on purpose: the outcome is rendered, never thrown. Nothing
    // asynchronous precedes the call, so the user gesture reaches the picker's
    // permission re-prompt intact.
    void onOpen().then(setOutcome).catch(() => setOutcome('gone'));
  }, [onOpen]);

  // Auto-hide. The toast is informational — the file is already on disk — so it
  // does not require an acknowledgement the way the error banner does. It stops
  // auto-hiding once Open has reported a FAILURE: that text is the answer to
  // something the user just did, and taking it away after four seconds would
  // leave them with a button that silently did nothing.
  useEffect(() => {
    if (failure) return;
    const t = setTimeout(onDismiss, FT_TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [onDismiss, failure]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="cc-ft-toast pointer-events-none fixed inset-x-2 top-2 z-40 animate-in fade-in slide-in-from-top-3 duration-200"
      data-cc-ft-received="true"
    >
      <div className="pointer-events-auto mx-auto flex w-full max-w-md items-start gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-lg shadow-slate-900/10">
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-slate-800">File received</p>
          <p className="mt-0.5 truncate text-[12px] text-slate-500">
            {name}{size === undefined ? '' : ` — ${formatBytes(size)}`}
          </p>
          {failure && (
            <p
              role="alert"
              data-cc-ft-open-outcome={outcome}
              className="mt-1 text-[12px] leading-relaxed text-amber-700"
            >
              {failure}
            </p>
          )}
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={open}
            data-cc-ft-action="open-received"
            className="flex-shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Open
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex-shrink-0 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
