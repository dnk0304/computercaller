/**
 * FT-3a — the file-transfer view-model.
 *
 * This hook owns the sender/receiver state machines and exposes the surface
 * FT-3b renders. It holds NO socket and NO keys: usePhoneBridge hands it a
 * bridge whose `sendFrame` is the app's existing `sendCommand`, which is the
 * one place outbound frames are sealed. `FILE_CHUNK` matches the frozen
 * `*_CHUNK` suffix, so lib/e2e/padding.mjs already treats it as padding-exempt
 * — nothing about the crypto path needed a change for this feature.
 *
 * Deliberately NOT here: any enforcement. The 1 GB and 2 GB/day numbers are
 * mirrored for UX (grey out an impossible pick, name the reason a refusal came
 * back with); the relay refuses at FILE_OFFER and is the only authority.
 */
'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  coerceFileFrame, isFileFrameType,
} from '@/lib/fileTransfer/frames.ts';
import type { FileFrameType, FileOffer } from '@/lib/fileTransfer/frames.ts';
import { createFileSender } from '@/lib/fileTransfer/sender.ts';
import type { FileSender } from '@/lib/fileTransfer/sender.ts';
import { createFileReceiver } from '@/lib/fileTransfer/receiver.ts';
import type { FileReceiver } from '@/lib/fileTransfer/receiver.ts';
import { isFileSystemAccessSupported } from '@/lib/fileTransfer/fsAccess.ts';
import { failureCopy } from '@/lib/fileTransfer/reasons.ts';
import type { FailureCopy, FileFailedReason } from '@/lib/fileTransfer/reasons.ts';
import {
  addToMirror, emptyMirror, previewPick, remainingToday,
} from '@/lib/fileTransfer/quotaMirror.ts';
import type { PickVerdict, QuotaMirror } from '@/lib/fileTransfer/quotaMirror.ts';
import type { FileTransport, TransferProgress } from '@/lib/fileTransfer/types.ts';

/** What usePhoneBridge must supply. */
export interface FileTransferBridge {
  sendFrame(type: FileFrameType, payload: object): void;
  bufferedAmount(): number;
  isOpen(): boolean;
}

/**
 * A stable box holding that bridge, filled in by usePhoneBridge once
 * `sendCommand` exists — which is ~2,700 lines below the hook call site in that
 * file. A plain object rather than a React ref on purpose: the transport reads
 * it lazily inside callbacks, never during render, and threading an actual ref
 * through a factory is the pattern react-hooks/refs exists to stop.
 */
export interface FileTransferBridgeSlot {
  bridge: FileTransferBridge | null;
}

export interface FileTransferError {
  id: string;
  reason: FileFailedReason;
  copy: FailureCopy;
}

export interface FileTransferApi {
  /** An inbound offer awaiting the user. FT-3b renders the Accept dialog. */
  pendingOffer: FileOffer | null;
  /** The live transfer in either direction, or null. Carries ETA and bytes. */
  progress: TransferProgress | null;
  /** The last failure, with the exact copy to render. Cleared by `dismissError`. */
  error: FileTransferError | null;
  /** False on a browser without the File System Access API — receive is impossible. */
  supported: boolean;
  /** True while a transfer is running; the send control should be disabled. */
  busy: boolean;
  /** Bytes left in today's MIRRORED counter, for "1.4 GB left today". */
  remainingBytesToday: number;

  /** Would this pick be refused, and why? Mirror only — render, never gate on it. */
  checkPick(size: number, subscribed: boolean): PickVerdict;
  /** Start a send. Oversize picks fail locally without spending a frame. */
  sendFile(file: File, from: string): Promise<void>;
  /**
   * Accept the pending offer and stream it to disk. MUST be called directly
   * from the click handler: `showSaveFilePicker` needs the user gesture.
   */
  acceptOffer(): Promise<void>;
  rejectOffer(): void;
  cancel(): void;
  dismissError(): void;

  /** Called by usePhoneBridge for every inbound FILE_* frame. */
  handleFrame(type: string, payload: unknown): void;
  /** Called by usePhoneBridge on a reconnect edge, to drive FILE_RESUME. */
  noteReconnect(): void;
}

/** File System Access support cannot change over a page's life. */
const SUBSCRIBE_NEVER = () => () => {};
const RETURN_FALSE = () => false;

export function useFileTransfer(slot: FileTransferBridgeSlot): FileTransferApi {
  const [pendingOffer, setPendingOffer] = useState<FileOffer | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<FileTransferError | null>(null);
  const [mirror, setMirror] = useState<QuotaMirror>(() => emptyMirror());
  // The picker only exists in the browser, and the server must render the same
  // thing the client hydrates with. useSyncExternalStore is the tool for exactly
  // that: a constant server snapshot of `false`, the real capability on the
  // client, and no state write from an effect to bridge the two.
  const supported = useSyncExternalStore(SUBSCRIBE_NEVER, isFileSystemAccessSupported, RETURN_FALSE);

  const transport = useMemo<FileTransport>(() => ({
    send: (type, payload) => slot.bridge?.sendFrame(type, payload),
    bufferedAmount: () => slot.bridge?.bufferedAmount() ?? 0,
    isOpen: () => slot.bridge?.isOpen() ?? false,
  }), [slot]);

  const onFailed = useCallback((id: string, reason: FileFailedReason) => {
    setError({ id, reason, copy: failureCopy(reason) });
    setPendingOffer(null);
  }, []);

  // Lazy useState rather than a ref filled during render: the state machines
  // must be created exactly once per mount, and writing a ref during render is
  // the thing that makes a component unsafe to re-run.
  const [sender] = useState<FileSender>(() => createFileSender(transport, {
    onProgress: setProgress,
    onFailed,
    onDone: (p) => {
      // Charge the MIRROR only on a completed send, matching the server's
      // commit-at-FILE_DONE rule. A failed transfer must not appear to have
      // burned quota the relay never charged.
      setMirror((m) => addToMirror(m, p.size));
    },
  }));
  const [receiver] = useState<FileReceiver>(() => createFileReceiver(transport, {
    onProgress: setProgress,
    onFailed,
    onOffer: setPendingOffer,
    onDone: () => setPendingOffer(null),
  }));

  useEffect(() => () => { sender.dispose(); receiver.dispose(); }, [sender, receiver]);

  const handleFrame = useCallback((type: string, payload: unknown) => {
    if (!isFileFrameType(type)) return;
    const frame = coerceFileFrame(type, payload);
    // A malformed frame is dropped, never guessed at. The peer is not trusted
    // to have sent the field types it claims.
    if (!frame) return;
    sender.handleFrame(frame);
    receiver.handleFrame(frame);
  }, [sender, receiver]);

  const noteReconnect = useCallback(() => {
    sender.noteReconnect();
    receiver.noteReconnect();
  }, [sender, receiver]);

  const sendFile = useCallback(async (file: File, from: string) => {
    setError(null);
    await sender.send(file, from);
  }, [sender]);

  const acceptOffer = useCallback(async () => {
    const offer = receiver.pendingOffer;
    if (!offer) return;
    setError(null);
    await receiver.receiveToDisk(offer);
  }, [receiver]);

  const rejectOffer = useCallback(() => {
    const offer = receiver.pendingOffer;
    if (!offer) return;
    receiver.reject(offer.id);
    setPendingOffer(null);
  }, [receiver]);

  const cancel = useCallback(() => {
    sender.cancel();
    receiver.cancel();
  }, [sender, receiver]);

  const dismissError = useCallback(() => setError(null), []);

  const checkPick = useCallback(
    (size: number, subscribed: boolean) => previewPick(size, mirror, subscribed),
    [mirror],
  );

  const busy = progress !== null
    && progress.phase !== 'done'
    && progress.phase !== 'failed';

  return {
    pendingOffer, progress, error, supported, busy,
    remainingBytesToday: remainingToday(mirror),
    checkPick, sendFile, acceptOffer, rejectOffer, cancel, dismissError,
    handleFrame, noteReconnect,
  };
}
