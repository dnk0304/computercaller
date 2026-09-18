'use client';

import React, { useEffect } from 'react';
import { CheckCircle2, X } from 'lucide-react';

import { formatBytes } from './ftFormat';

/**
 * components/fileTransfer/FileReceivedToast.tsx — FT-3b (a). The completion
 * toast for a received file.
 *
 * ── "SHOW IN FOLDER" DOES NOT EXIST ON THE WEB, AND SAYING SO IS THE DESIGN ──
 * The brief asks for a received-file toast with "Show in folder"/open. Half of
 * that is not buildable and the other half needs a hook change:
 *
 *  1. THERE IS NO WEB API THAT REVEALS A FILE IN THE OS FILE MANAGER. Chrome
 *     exposes it only to its own downloads UI (`chrome.downloads.show`), and
 *     this file never goes through the download path at all — the user picked
 *     its destination themselves in `showSaveFilePicker`, so it was written
 *     straight to the folder they chose. A button that cannot do what its label
 *     says is worse than no button, so there is no "Show in folder" here.
 *
 *  2. "OPEN" IS BUILDABLE BUT NEEDS THE HANDLE. `handle.getFile()` yields a
 *     File we can open in a tab. FT-3a's receiver nulls its `handle` on
 *     completion (lib/fileTransfer/receiver.ts) and the hook never surfaces it,
 *     so there is nothing to open from out here. That is a one-line request for
 *     Forge, filed in the résumé; until it lands `onOpen` is undefined and the
 *     button is simply absent.
 *
 * The toast therefore states the outcome the user can verify — the file's name
 * and size, saved where they chose — and grows the Open button the moment the
 * handle exists. Nothing about this component changes when it does.
 *
 * ── z-INDEX ─────────────────────────────────────────────────────────────────
 * z-40, matching NotificationToast in PhoneModeShell and staying strictly below
 * CallModal's z-50. A file toast must never cover a ringing call.
 */

/** Matches TOAST_AUTO_HIDE_MS in PhoneModeShell — one dwell time on this surface. */
export const FT_TOAST_AUTO_HIDE_MS = 4000;

export interface FileReceivedToastProps {
  name: string;
  size: number;
  onDismiss: () => void;
  /**
   * Opens the received file. Undefined until the receiver surfaces its handle —
   * the button is omitted rather than disabled, because a permanently greyed
   * control reads as a bug.
   */
  onOpen?: () => void;
}

export function FileReceivedToast({ name, size, onDismiss, onOpen }: FileReceivedToastProps) {
  // Auto-hide. The toast is informational — the file is already on disk — so it
  // does not require an acknowledgement the way the error banner does.
  useEffect(() => {
    const t = setTimeout(onDismiss, FT_TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

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
            {name} — {formatBytes(size)}
          </p>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
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
