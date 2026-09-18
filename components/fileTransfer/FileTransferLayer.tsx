'use client';

import React, { useCallback, useState } from 'react';

import { usePhone } from '@/hooks';
import { useUpgrade } from '@/hooks/upgradeModalContext';
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
 * ── THE RECEIVED-TOAST LATCH ────────────────────────────────────────────────
 * `progress` does not clear itself on completion — it sits at `phase: 'done'`.
 * Rendering the toast directly off that would show it forever, and clearing it
 * from an effect would be a state write in an effect (the thing
 * `react-hooks/set-state-in-effect` exists to stop). So the toast is latched BY
 * TRANSFER ID, derived during render: a dismissal that does not name the
 * current transfer is not a dismissal, so the next completed receive shows its
 * own toast without any reset step. This is the same shape SasConfirmDialog
 * uses to key its decision by the SAS digits, and for the same reason.
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
  const { openUpgrade } = useUpgrade();

  const [dismissedToastId, setDismissedToastId] = useState<string | null>(null);

  const onUpgrade = useCallback(() => openUpgrade('fileTransfer'), [openUpgrade]);

  // acceptOffer MUST run synchronously off the click — showSaveFilePicker needs
  // the user gesture, and a gesture does not survive an await. The promise is
  // deliberately floated: failures come back through `error`, not a throw here.
  const onAccept = useCallback(() => { void ft?.acceptOffer(); }, [ft]);
  const onDecline = useCallback(() => { ft?.rejectOffer(); }, [ft]);
  const onCancel = useCallback(() => { ft?.cancel(); }, [ft]);
  const onDismissError = useCallback(() => { ft?.dismissError(); }, [ft]);

  if (!ft) return null;

  const { pendingOffer, progress, error, supported } = ft;

  const receivedDone =
    progress && progress.phase === 'done' && progress.direction === 'receive'
      ? progress
      : null;
  const showToast = receivedDone !== null && dismissedToastId !== receivedDone.id;

  return (
    <>
      {/* Banner and progress are in-flow at the top of the shell, so they push
          the view rather than covering the thread the user is reading. */}
      <FileTransferError
        reason={error?.reason ?? null}
        onDismiss={onDismissError}
        onUpgrade={onUpgrade}
        onRetry={onDismissError}
      />

      <FileTransferProgress progress={progress} onCancel={onCancel} compact={compact} />

      <FileOfferDialog
        offer={pendingOffer}
        supported={supported}
        onAccept={onAccept}
        onDecline={onDecline}
      />

      {showToast && receivedDone && (
        <FileReceivedToast
          name={receivedDone.name}
          size={receivedDone.size}
          onDismiss={() => setDismissedToastId(receivedDone.id)}
          /* onOpen is intentionally absent — the receiver does not surface the
             file handle yet. See FileReceivedToast's header. */
        />
      )}
    </>
  );
}
