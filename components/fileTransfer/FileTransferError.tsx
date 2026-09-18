'use client';

import React from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';

import { ftFailureCopy, isRelayOwnedReason } from './ftCopy';

/**
 * components/fileTransfer/FileTransferError.tsx — FT-3b (a)/(b)/(c). The
 * failure banner, rendering the copy table by reason.
 *
 * ── THE UPGRADE AFFORDANCE IS PLATFORM-SPECIFIC ─────────────────────────────
 * `tier` is the one reason whose copy carries `action: 'upgrade'`, and this
 * banner makes it a real button into the existing pricing modal. That is
 * correct HERE and would be a policy violation on Android: the Play Payments
 * anti-steering clause forbids a tappable element leading to an external
 * checkout, which is exactly what Whop is (PLAY-TIER-COPY-RULING §1). Web and
 * the extension are not distributed through Play, so they keep the link, and
 * the Android strings are deliberately different. Do not "unify" these tables.
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
  /** Opens the existing pricing modal. Wired only for `action: 'upgrade'`. */
  onUpgrade: () => void;
  /** Clears the error and returns the user to the send control. */
  onRetry: () => void;
}

export function FileTransferError({ reason, onDismiss, onUpgrade, onRetry }: FileTransferErrorProps) {
  if (!reason) return null;
  const copy = ftFailureCopy(reason);

  return (
    <div
      role="alert"
      className="cc-ft-error flex items-start gap-2 border-b border-rose-200 bg-rose-50 px-3 py-2"
      data-cc-ft-error={reason}
      data-cc-ft-relay-owned={isRelayOwnedReason(reason) ? 'true' : 'false'}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-600" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-rose-900">{copy.message}</p>

      {copy.action === 'upgrade' && (
        <button
          type="button"
          onClick={onUpgrade}
          data-cc-ft-action="upgrade"
          className="flex-shrink-0 rounded-lg bg-rose-600 px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
        >
          Upgrade
        </button>
      )}

      {copy.action === 'retry' && (
        <button
          type="button"
          onClick={onRetry}
          data-cc-ft-action="retry"
          className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[12px] font-medium text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Try again
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
