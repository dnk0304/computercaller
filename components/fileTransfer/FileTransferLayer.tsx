'use client';

import React, { useCallback } from 'react';

import { usePhone } from '@/hooks';
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
   * No useUpgrade() here any more. M10 took the Upgrade button off the failure
   * banner, so this layer has no route into the pricing modal — the only
   * tappable upgrade on the surface is the locked control, which wires its own.
   * Dropping the hook keeps that structural: the layer cannot grow the button
   * back without someone re-adding the dependency and noticing why it went.
   */
  // acceptOffer MUST run synchronously off the click — showSaveFilePicker needs
  // the user gesture, and a gesture does not survive an await. The promise is
  // deliberately floated: failures come back through `error`, not a throw here.
  const onAccept = useCallback(() => { void ft?.acceptOffer(); }, [ft]);
  const onDecline = useCallback(() => { ft?.rejectOffer(); }, [ft]);
  const onCancel = useCallback(() => { ft?.cancel(); }, [ft]);
  const onDismissError = useCallback(() => { ft?.dismissError(); }, [ft]);
  const onDismissCompleted = useCallback(() => { ft?.dismissCompleted(); }, [ft]);
  const completedId = ft?.completed?.id ?? null;
  // Bound to the id so the handler cannot outlive the transfer it names.
  const onOpenReceived = useCallback(
    () => (completedId && ft ? ft.openReceived(completedId) : Promise.resolve('gone' as const)),
    [ft, completedId],
  );

  if (!ft) return null;

  const { pendingOffer, progress, error, supported, completed } = ft;

  return (
    <>
      {/* Banner and progress are in-flow at the top of the shell, so they push
          the view rather than covering the thread the user is reading. */}
      <FileTransferError
        reason={error?.reason ?? null}
        onDismiss={onDismissError}
        onRetry={onDismissError}
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
