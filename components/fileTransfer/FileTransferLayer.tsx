'use client';

import React, { useCallback, useEffect, useRef } from 'react';

import { usePhone } from '@/hooks';
import { useUpgrade } from '@/hooks/upgradeModalContext';
import { entitlementStaleKey } from '@/lib/fileTransfer/tierRefetch';
import type { FileTransferApi } from '@/hooks/useFileTransfer';

import { FileOfferDialog } from './FileOfferDialog';
import { FileTransferProgress } from './FileTransferProgress';
import { FileTransferError } from './FileTransferError';
import { FileReceivedToast } from './FileReceivedToast';

/**
 * components/fileTransfer/FileTransferLayer.tsx — FT-3b (a). The one mount
 * point for every transfer surface, rendered by PhoneModeShell next to
 * SasConfirmDialog.
 *
 * ── WHY ONE LAYER RATHER THAN FOUR MOUNTS ───────────────────────────────────
 * There is exactly ONE live transfer per room by rule (WIRE-TRUTH-v1: the relay
 * matches sealed non-offer frames by TYPE against the room's single live
 * transfer). Four components each calling `usePhone()` and each deciding
 * independently whether to render would let the dialog, the progress row and
 * the toast disagree about which transfer is current during a handoff. One
 * component reads the state once and renders a consistent picture of it.
 *
 * It also keeps the hook contract in one place: if FT-3a's surface changes,
 * this file is the only thing that has to follow.
 *
 * ── THE RECEIVED TOAST ──────────────────────────────────────────────────────
 * Driven by FT-3a.1's `completed` record rather than by `progress.phase`. The
 * hook holds that record only while the file handle is still live, which is
 * exactly the window in which "Open" can work — so the toast's lifetime and the
 * button's capability come from one source instead of being guessed at from a
 * terminal phase.
 *
 * `dismissCompleted()` clears it in the hook. There is no local latch: the
 * earlier version keyed a dismissal by transfer id because `progress` never
 * cleared itself, and keeping that on top of a hook that DOES clear would be
 * two pieces of state free to disagree about whether the toast is showing.
 */

export interface FileTransferLayerProps {
  /** Extension surface renders the compact skin. */
  compact?: boolean;
}

export function FileTransferLayer({ compact = false }: FileTransferLayerProps) {
  // `fileTransfer` is optional on the context type only so this component can
  // be mounted on a surface whose provider predates FT-3a without crashing.
  const phone = usePhone() as unknown as { fileTransfer?: FileTransferApi };
  const ft = phone?.fileTransfer;
  /*
   * ── useUpgrade(), FOR refetchEntitlement AND NOTHING ELSE (EXT-UI-3 a) ────
   * M10 (R-AN, binding) took the Upgrade BUTTON off the failure banner and it
   * stays off: FileTransferError renders `retry` and gives `tier` no action at
   * all, and the only tappable upgrade on either surface is the pre-flight
   * control (SendFileControl), which wires its own. This layer deliberately
   * destructures ONLY `refetchEntitlement` — `openUpgrade` is not in scope
   * here, so the button cannot grow back without someone widening this line
   * and having to explain why.
   *
   * ── WHY THIS LAYER IS THE WIRING POINT (EXT-UI-3 a) ──────────────────────
   * The obvious home — useFileTransfer's `onFailed` funnel — CANNOT work:
   * PhoneModeProvider (which calls usePhoneBridge → useFileTransfer) is mounted
   * OUTSIDE UpgradeModalProvider on BOTH surfaces (app/app/layout.tsx:53-64,
   * app/extension/ExtensionProviders.tsx:36-39), so useUpgrade() there returns
   * the context's inert DEFAULT_VALUE and the refetch would be a silent no-op.
   * FileTransferSlots IS inside the provider but is mounted more than once (the
   * header control and the drop target), which would fire N refetches for one
   * refusal. This layer is inside the provider, is mounted exactly once
   * (PhoneModeShell:2399 — that is the whole premise of this file) and already
   * reads `error`, so "once per failure" is a property of the mount rather than
   * a hope.
   *
   * The key is null for every reason that leaves the entitlement intact —
   * `quota` included, deliberately (see lib/fileTransfer/tierRefetch.ts).
   */
  const { refetchEntitlement } = useUpgrade();
  // acceptOffer MUST run synchronously off the click — showSaveFilePicker needs
  // the user gesture, and a gesture does not survive an await. The promise is
  // deliberately floated: failures come back through `error`, not a throw here.
  const onAccept = useCallback(() => { void ft?.acceptOffer(); }, [ft]);
  const onDecline = useCallback(() => { ft?.rejectOffer(); }, [ft]);
  const onCancel = useCallback(() => { ft?.cancel(); }, [ft]);
  const onDismissError = useCallback(() => { ft?.dismissError(); }, [ft]);
  /*
   * FT-RETRY-1. "Try again" used to be wired to onDismissError — it cleared
   * the banner and did nothing else. It now re-offers the retained File under a
   * new id. When that File no longer reads, the banner switches to "Pick the
   * file again" AND the picker is opened from this same click: the probe is a
   * one-byte read, well inside the browser's user-activation window. A
   * RECEIVE failure has no File on this side to resend, so it keeps the old
   * clear-the-banner behaviour (retryMode 'none').
   */
  const repickInputRef = useRef<HTMLInputElement>(null);
  const onRetry = useCallback(() => {
    if (!ft) return;
    if (ft.retryMode === 'none') { ft.dismissError(); return; }
    void ft.retry().then((outcome) => {
      if (outcome === 'repick') repickInputRef.current?.click();
    });
  }, [ft]);
  const onRepick = useCallback((file: File) => { void ft?.retry(file); }, [ft]);
  const onDismissCompleted = useCallback(() => { ft?.dismissCompleted(); }, [ft]);
  const completedId = ft?.completed?.id ?? null;
  // Bound to the id so the handler cannot outlive the transfer it names.
  const onOpenReceived = useCallback(
    () => (completedId && ft ? ft.openReceived(completedId) : Promise.resolve('gone' as const)),
    [ft, completedId],
  );

  // Keyed on (reason, transfer id), so React runs this exactly once per
  // distinct tier failure: the refetch writes entitlement state, which
  // re-renders this subtree, but the key is unchanged by that render and the
  // effect cannot re-enter. `refetchEntitlement` is useCallback-stable
  // (useEntitlement's `load` closes over nothing, deps []), so it never re-arms
  // the effect on its own. Declared above the `!ft` guard because it is a hook.
  const staleKey = entitlementStaleKey(ft?.error ?? null);
  useEffect(() => {
    if (staleKey) refetchEntitlement();
  }, [staleKey, refetchEntitlement]);

  if (!ft) return null;

  const { pendingOffer, progress, error, supported, completed } = ft;

  return (
    <>
      {/* Banner and progress are in-flow at the top of the shell, so they push
          the view rather than covering the thread the user is reading. */}
      <FileTransferError
        reason={error?.reason ?? null}
        onDismiss={onDismissError}
        onRetry={onRetry}
        repick={ft.retryMode === 'repick'}
        onRepick={onRepick}
        repickInputRef={repickInputRef}
      />

      <FileTransferProgress progress={progress} onCancel={onCancel} compact={compact} />

      <FileOfferDialog
        offer={pendingOffer}
        supported={supported}
        onAccept={onAccept}
        onDecline={onDecline}
      />

      {completed && (
        <FileReceivedToast
          name={completed.name}
          onDismiss={onDismissCompleted}
          /* Omitted, not disabled, once the handle has been released. */
          onOpen={completed.canOpen ? onOpenReceived : undefined}
        />
      )}
    </>
  );
}
