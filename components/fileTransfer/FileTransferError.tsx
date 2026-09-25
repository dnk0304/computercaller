'use client';

import React, { useCallback } from 'react';
import { AlertTriangle, FolderOpen, RotateCw, X } from 'lucide-react';

import {
  ftFailureCopy, isRelayOwnedReason, FT_REPICK_ACTION, FT_REPICK_MESSAGE, FT_RETRY_ACTION,
} from './ftCopy';

/**
 * components/fileTransfer/FileTransferError.tsx — FT-3b (a)/(b)/(c). The
 * failure banner, rendering the copy table by reason.
 *
 * ── THERE IS NO UPGRADE BUTTON HERE, AND THAT IS THE POINT ──────────────────
 * An earlier version made `tier` a button into the pricing modal. Security
 * A1.1-M10 (binding, R-AN) removed it: a FILE_FAILED frame reports that a
 * transfer stopped, and turning that report into a sales prompt both overstates
 * what the frame knows and puts a checkout route on a failure surface. The
 * tappable Upgrade lives on the LOCKED CONTROL (SendFileControl), which is a
 * pre-flight offer the client makes on its own behalf — not a refusal.
 *
 * So this banner renders `retry` and nothing else. `ftFailureCopy` gives `tier`
 * no action at all, which is what keeps the button from coming back by
 * accident.
 *
 * ── WHY THE BANNER, NOT A TOAST ─────────────────────────────────────────────
 * A failed transfer is a state the user has to act on — retry, upgrade, or pick
 * a smaller file — and a toast that auto-hides after four seconds takes the
 * explanation away before a 1 GB refusal has finished being read. It stays
 * until dismissed. `role="alert"` because it is the result of an action the
 * user just took and it must be announced.
 *
 * ── RELAY-OWNED REASONS ─────────────────────────────────────────────────────
 * Eight of the eleven reasons are authored by the relay and are abort-only
 * (WIRE-TRUTH-v1). The banner does not distinguish them visually — to the user
 * "the file was refused" is one thing regardless of who decided — but the
 * `data-cc-ft-relay-owned` attribute is emitted so the proof harness can assert
 * the whole relay subset renders its copy rather than a generic fallback.
 */

export interface FileTransferErrorProps {
  reason: string | null;
  onDismiss: () => void;
  /** Re-offers the failed send (FT-RETRY-1); for a receive failure, clears. */
  onRetry: () => void;
  /**
   * FT-RETRY-1. True once Try again found the File unreadable: the banner says
   * so and the button becomes "Pick the file again", which opens the picker.
   */
  repick?: boolean;
  /** The picked replacement file. */
  onRepick?: (file: File) => void;
  /** The hidden picker input, so the layer can open it straight off Try again. */
  repickInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function FileTransferError({
  reason, onDismiss, onRetry, repick = false, onRepick, repickInputRef,
}: FileTransferErrorProps) {
  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onRepick?.(file);
  }, [onRepick]);
  if (!reason) return null;
  const copy = ftFailureCopy(reason);
  const showRepick = repick && copy.action === 'retry';

  return (
    <div
      role="alert"
      className="cc-ft-error flex items-start gap-2 border-b border-rose-200 bg-rose-50 px-3 py-2"
      data-cc-ft-error={reason}
      data-cc-ft-relay-owned={isRelayOwnedReason(reason) ? 'true' : 'false'}
      data-cc-ft-repick={showRepick ? 'true' : undefined}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-600" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-rose-900">
        {showRepick ? FT_REPICK_MESSAGE : copy.message}
      </p>

      {/* Always mounted while the banner is up, so the layer can open it from
          the Try again click itself — the picker needs that user gesture. */}
      <input
        ref={repickInputRef}
        type="file"
        className="sr-only"
        onChange={onChange}
        data-cc-ft-repick-input="true"
        tabIndex={-1}
        aria-hidden="true"
      />

      {showRepick && (
        <button
          type="button"
          onClick={() => repickInputRef?.current?.click()}
          data-cc-ft-action="repick"
          className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[12px] font-medium text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
        >
          <FolderOpen className="h-3 w-3" aria-hidden="true" />
          {FT_REPICK_ACTION}
        </button>
      )}

      {copy.action === 'retry' && !showRepick && (
        <button
          type="button"
          onClick={onRetry}
          data-cc-ft-action="retry"
          className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[12px] font-medium text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          {FT_RETRY_ACTION}
        </button>
      )}

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-cc-ft-action="dismiss-error"
        className="flex-shrink-0 rounded-lg p-1 text-rose-500 transition-colors hover:bg-rose-100 hover:text-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
