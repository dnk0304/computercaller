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
import { createQueueController } from '@/lib/fileTransfer/queueController.ts';
import type { QueueController } from '@/lib/fileTransfer/queueController.ts';
import { loadQueue, saveQueue } from '@/lib/fileTransfer/queueStore.ts';
import type { QueueState } from '@/lib/fileTransfer/queue.ts';
import { createFileReceiver } from '@/lib/fileTransfer/receiver.ts';
import type { FileReceiver } from '@/lib/fileTransfer/receiver.ts';
import { getSaveFilePicker } from '@/lib/fileTransfer/fsAccess.ts';
import { browserDelivery, canReceiveFiles } from '@/lib/fileTransfer/fallbackSink.ts';
import { CC_EXTENSION_ORIGIN } from '@/lib/extension';
import type { SaveFileHandle } from '@/lib/fileTransfer/fsAccess.ts';
import { decideRelayAbort } from '@/lib/fileTransfer/relayAbort.ts';
import {
  HANDLE_RETENTION_MS, openReceivedFile,
} from '@/lib/fileTransfer/openReceived.ts';
import type { OpenReceivedDeps, OpenReceivedOutcome } from '@/lib/fileTransfer/openReceived.ts';
import { failureCopy } from '@/lib/fileTransfer/reasons.ts';
import type { FailureCopy, FileFailedReason } from '@/lib/fileTransfer/reasons.ts';
import {
  addToMirror, emptyMirror, previewPick, remainingToday,
} from '@/lib/fileTransfer/quotaMirror.ts';
import type { PickVerdict, QuotaMirror } from '@/lib/fileTransfer/quotaMirror.ts';
import type { FileTransport, TransferProgress } from '@/lib/fileTransfer/types.ts';
import { retryModeFor } from '@/lib/fileTransfer/retry.ts';
import type { OutgoingRecord, RetryMode } from '@/lib/fileTransfer/retry.ts';
import { ftFailureCopy } from '@/components/fileTransfer/ftCopy';

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

/**
 * FT-3a.1 (c). A transfer that finished, plus the handle "Open" needs. Held
 * only until the UI dismisses the toast or HANDLE_RETENTION_MS elapses — a
 * FileSystemFileHandle is a live capability over a user's file, not a piece of
 * view state, so it is not kept for the life of the tab.
 */
export interface CompletedTransfer {
  id: string;
  name: string;
  /** False once the handle has been released; FT-3b hides "Open". */
  canOpen: boolean;
}

export interface FileTransferError {
  id: string;
  reason: FileFailedReason;
  copy: FailureCopy;
}

/** What a `retry()` call did — the UI acts on 'repick' by opening the picker. */
export type FileRetryOutcome = 'sent' | 'changed' | 'repick' | 'unavailable';

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
  /**
   * Queue one file. Kept for existing callers; it is `enqueue([file], from)`.
   * Oversize picks still fail locally without spending a frame, as a row.
   */
  sendFile(file: File, from: string): Promise<void>;

  /**
   * FILE-QUEUE-WEB. The transfer list: outgoing rows in queue order plus this
   * session's incoming rows. Metadata only; see lib/fileTransfer/queue.ts.
   */
  queue: QueueState;
  /** Append files at the tail of the outgoing queue. */
  enqueue(files: File[], from: string): void;
  /** Remove a row. On the active transfer this IS `cancel()`. */
  remove(id: string): void;
  /** Resume a paused queue. */
  resume(): void;
  /** Drop a finished (done / failed) row. */
  clear(id: string): void;
  /**
   * Accept the pending offer and stream it to disk. MUST be called directly
   * from the click handler: `showSaveFilePicker` needs the user gesture.
   */
  acceptOffer(): Promise<void>;
  rejectOffer(): void;
  /**
   * Cancel whatever is live (sends the existing FILE_FAILED `cancelled` frame
   * for a live transfer) AND clear local state — the error banner and the
   * retained outgoing File — so the sender is never left without an exit.
   */
  cancel(): void;
  /** Clears the banner and drops the retained outgoing File. */
  dismissError(): void;
  /**
   * FT-RETRY-1. What the failure banner may offer for the CURRENT error:
   * 'resend' (Try again re-offers the same File), 'repick' (the File no longer
   * reads — show "Pick the file again"), or 'none'.
   */
  retryMode: RetryMode;
  /**
   * Retry a failed row: back in the queue at the TAIL (a new transfer id when
   * it is offered). `id` omitted = the row the banner's error belongs to. With
   * `replacement` (the user re-picked after 'repick'), that File takes the
   * row's place.
   */
  retry(id?: string | null, replacement?: File): Promise<FileRetryOutcome>;

  /**
   * The last completed RECEIVE, while its handle is still held. FT-3b renders
   * the "Open" button from this. There is no "Show in folder": the File System
   * Access API exposes no reveal-in-file-manager call and a handle carries no
   * path, so that control cannot be built on the web and the copy must not
   * promise it.
   */
  completed: CompletedTransfer | null;
  /**
   * Open a completed receive in a new tab. Permission is re-checked on every
   * call — a granted permission is a snapshot, not a property of the handle.
   * `deps` is injected only by tests and the proof script.
   */
  openReceived(id: string, deps?: OpenReceivedDeps | null): Promise<OpenReceivedOutcome>;
  /** Drop the retained handle (toast dismissed). Idempotent. */
  dismissCompleted(): void;

  /** Called by usePhoneBridge for every inbound FILE_* frame. */
  handleFrame(type: string, payload: unknown): void;
  /** Called by usePhoneBridge on a reconnect edge, to drive FILE_RESUME. */
  noteReconnect(): void;
}

/** File System Access support cannot change over a page's life. */
const SUBSCRIBE_NEVER = () => () => {};
/**
 * T-FT-EXT-NO-SAVE-PICKER. The snapshot must be a STABLE function reference —
 * useSyncExternalStore re-reads it on every render and a new closure each time
 * would loop — and it must be cheap, which it is: two capability reads, no
 * allocation beyond the delivery object.
 */
const canReceiveHere = (): boolean =>
  canReceiveFiles(getSaveFilePicker(), browserDelivery(CC_EXTENSION_ORIGIN));
const RETURN_FALSE = () => false;

/** The FILE_OFFER `from` a restored row is re-sent with (see FileTransferSlots). */
const FT_QUEUE_FROM = 'Computer';

export function useFileTransfer(slot: FileTransferBridgeSlot): FileTransferApi {
  const [pendingOffer, setPendingOffer] = useState<FileOffer | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [mirror, setMirror] = useState<QuotaMirror>(() => emptyMirror());
  /**
   * The retained handle lives in STATE, not in a ref and not in a mutable box.
   * Both of those were tried and both are correctly refused by the lint rules
   * here: the state machines are built in a lazy `useState` initializer that
   * runs during render, so a ref or a box captured by `onReceived` would be a
   * mutable cell written from render-constructed code. State is the one cell
   * React is happy to have written from a callback, and it makes the retention
   * window an ordinary effect keyed on the record rather than a hand-managed
   * timer — one fewer thing to leak on unmount.
   *
   * The handle never leaves this hook: what FT-3b sees is `{id, name, canOpen}`.
   */
  const [held, setHeld] = useState<{ id: string; name: string; handle: SaveFileHandle | null } | null>(null);

  const releaseHandle = useCallback(() => {
    setHeld((h) => (h && h.handle ? { ...h, handle: null } : h));
  }, []);

  const dismissCompleted = useCallback(() => setHeld(null), []);

  // The retention window. A handle is a live capability over a user's file; it
  // is dropped when the toast is dismissed or after HANDLE_RETENTION_MS,
  // whichever comes first, rather than kept for the life of the tab so a button
  // can stay enabled.
  useEffect(() => {
    if (!held || !held.handle) return undefined;
    const id = held.id;
    const t = setTimeout(
      () => setHeld((h) => (h && h.id === id ? { ...h, handle: null } : h)),
      HANDLE_RETENTION_MS,
    );
    return () => clearTimeout(t);
  }, [held]);

  const completed = useMemo<CompletedTransfer | null>(
    () => (held ? { id: held.id, name: held.name, canOpen: held.handle !== null } : null),
    [held],
  );
  // The picker only exists in the browser, and the server must render the same
  // thing the client hydrates with. useSyncExternalStore is the tool for exactly
  // that: a constant server snapshot of `false`, the real capability on the
  // client, and no state write from an effect to bridge the two.
  const supported = useSyncExternalStore(SUBSCRIBE_NEVER, canReceiveHere, RETURN_FALSE);

  const transport = useMemo<FileTransport>(() => ({
    send: (type, payload) => slot.bridge?.sendFrame(type, payload),
    bufferedAmount: () => slot.bridge?.bufferedAmount() ?? 0,
    isOpen: () => slot.bridge?.isOpen() ?? false,
  }), [slot]);

  // Lazy useState rather than a ref filled during render: the state machines
  // must be created exactly once per mount, and writing a ref during render is
  // the thing that makes a component unsafe to re-run.
  //
  // FILE-QUEUE-WEB. The queue controller OWNS the one FileSender and decides
  // only which File it gets next; offering, pumping, failing and FT-RETRY-1's
  // planRetry are the same code a single send always ran through. The failure
  // banner is the queue's `lastFailure`: the reducer is the one place that
  // knows whether a `busy` was re-queued (no banner) or final (banner).
  const [queueCtl] = useState<QueueController>(() => createQueueController({
    transport,
    sendEvents: {
      onProgress: setProgress,
      onDone: (p) => {
        // Charge the MIRROR only on a completed send, matching the server's
        // commit-at-FILE_DONE rule. A failed transfer must not appear to have
        // burned quota the relay never charged.
        setMirror((m) => addToMirror(m, p.size));
      },
    },
    persist: (items) => { void saveQueue(items); },
  }));
  const sender = queueCtl.sender;
  const [receiver] = useState<FileReceiver>(() => createFileReceiver(transport, {
    onProgress: (p) => { setProgress(p); queueCtl.noteReceiveProgress(p); },
    onFailed: (id, reason: FileFailedReason) => {
      queueCtl.noteReceiveFailed(id, reason);
      queueCtl.noteIncomingOffer(false);
      setPendingOffer(null);
    },
    onOffer: (offer) => { queueCtl.noteIncomingOffer(true); setPendingOffer(offer); },
    onDone: (p) => {
      queueCtl.noteReceiveDone(p.id);
      queueCtl.noteIncomingOffer(false);
      setPendingOffer(null);
    },
    onReceived: (id, name, handle) => setHeld({ id, name, handle }),
  }));

  useEffect(() => () => { queueCtl.dispose(); receiver.dispose(); }, [queueCtl, receiver]);

  const queue = useSyncExternalStore(queueCtl.subscribe, queueCtl.getState, queueCtl.getState);

  // Restore the persisted metadata once. Mid-send rows come back failed
  // (connection_lost) with Retry, queued rows come back needs-file (the File
  // died with the page): never a silent stuck row. See queue.ts 'restore'.
  useEffect(() => {
    let live = true;
    void loadQueue().then((records) => { if (live) queueCtl.restore(records, FT_QUEUE_FROM); });
    return () => { live = false; };
  }, [queueCtl]);

  const lastFailure = queue.lastFailure;
  const error = useMemo<FileTransferError | null>(
    () => (lastFailure
      ? { id: lastFailure.transferId, reason: lastFailure.reason, copy: failureCopy(lastFailure.reason) }
      : null),
    [lastFailure],
  );

  const openReceived = useCallback(
    async (id: string, deps?: OpenReceivedDeps | null): Promise<OpenReceivedOutcome> => {
      if (!held || held.id !== id || !held.handle) return 'gone';
      const { handle } = held;
      const outcome = deps === undefined
        ? await openReceivedFile(handle)
        : await openReceivedFile(handle, deps);
      // A revoked permission or a vanished file is terminal for this handle —
      // leaving the button live would just re-prompt on every click.
      if (outcome === 'denied' || outcome === 'gone') releaseHandle();
      return outcome;
    },
    [held, releaseHandle],
  );

  const handleFrame = useCallback((type: string, payload: unknown) => {
    if (!isFileFrameType(type)) return;
    // ── FT-A1.1 MUST A1.1-M9, the LIVENESS clause ─────────────────────────
    // useE2e admitted this frame on shape + reason subset alone; this hook is
    // the only layer that knows which transfers exist. A relay-minted abort for
    // an id that is not live is DROPPED — that is what stops the exception
    // being an id-guessing oracle and what stops it creating zombie transfers.
    // Checked here rather than in the machines because it must hold on the mode
    // OFF path too: the mark means the same thing either way.
    const relay = decideRelayAbort(
      type, payload, (id) => sender.liveId === id || receiver.liveId === id,
    );
    if (relay.action === 'drop') return;
    if (relay.action === 'abort') {
      // Re-built from the two scalars, so the mark itself never reaches a state
      // machine and the frame can only ever mean "abort the transfer you named".
      const abort = coerceFileFrame('FILE_FAILED', { id: relay.id, reason: relay.reason });
      if (abort) { sender.handleFrame(abort); receiver.handleFrame(abort); }
      return;
    }
    const frame = coerceFileFrame(type, payload);
    // A malformed frame is dropped, never guessed at. The peer is not trusted
    // to have sent the field types it claims.
    if (!frame) return;
    sender.handleFrame(frame);
    receiver.handleFrame(frame);
  }, [sender, receiver]);

  const noteReconnect = useCallback(() => {
    queueCtl.noteReconnect();
    receiver.noteReconnect();
  }, [queueCtl, receiver]);

  const enqueue = useCallback((files: File[], from: string) => {
    queueCtl.enqueue(files, from);
  }, [queueCtl]);

  const sendFile = useCallback(async (file: File, from: string) => {
    queueCtl.enqueue([file], from);
  }, [queueCtl]);

  // FT-RETRY-1's banner rule, unchanged, fed from the row the error belongs
  // to: the retained File is that row's File, `failedId` its failed transfer
  // id, and a row the probe found unreadable (needs-file) is the repick case.
  const failedRow = lastFailure?.itemId
    ? queue.items.find((it) => it.id === lastFailure.itemId) ?? null
    : null;
  const failedFile = failedRow ? queueCtl.fileOf(failedRow.id) : null;
  const outgoing: OutgoingRecord | null = failedRow && failedFile && lastFailure
    ? { file: failedFile, from: failedRow.from, size: failedRow.size, failedId: lastFailure.transferId }
    : null;
  const repickId = failedRow?.state === 'needs-file' && lastFailure ? lastFailure.transferId : null;
  const retryMode = retryModeFor(error, outgoing, repickId, (r) => ftFailureCopy(r).action);

  const retry = useCallback(async (id?: string | null, replacement?: File): Promise<FileRetryOutcome> => {
    const target = id ?? queueCtl.getState().lastFailure?.itemId ?? null;
    if (!target) return 'unavailable';
    // planRetry (FT-RETRY-1) runs inside the controller: 'send' re-queues the
    // row at the tail, 'repick' marks it needs-file, 'changed' re-baselines.
    return queueCtl.retry(target, replacement);
  }, [queueCtl]);

  const remove = useCallback((id: string) => {
    const row = queueCtl.getState().items.find((it) => it.id === id);
    if (row?.direction === 'receive' && row.state === 'receiving') {
      // The active RECEIVE: the existing cancel path, then drop its row.
      queueCtl.remove(id);
      receiver.cancel();
      queueCtl.dismissFailure();
      return;
    }
    queueCtl.remove(id);
  }, [queueCtl, receiver]);

  const resume = useCallback(() => queueCtl.resume(), [queueCtl]);
  const clear = useCallback((id: string) => queueCtl.clear(id), [queueCtl]);

  const acceptOffer = useCallback(async () => {
    const offer = receiver.pendingOffer;
    if (!offer) return;
    queueCtl.dismissFailure();
    await receiver.receiveToDisk(offer);
  }, [receiver, queueCtl]);

  const rejectOffer = useCallback(() => {
    const offer = receiver.pendingOffer;
    if (!offer) return;
    receiver.reject(offer.id);
    queueCtl.noteIncomingOffer(false);
    setPendingOffer(null);
  }, [receiver, queueCtl]);

  const cancel = useCallback(() => {
    // The active send's row goes with it (Remove on the active item IS this),
    // and the queue moves on to the next one.
    queueCtl.cancelActiveSend();
    receiver.cancel();
    queueCtl.dismissFailure();
  }, [queueCtl, receiver]);

  const dismissError = useCallback(() => {
    queueCtl.dismissFailure();
  }, [queueCtl]);

  const checkPick = useCallback(
    (size: number, subscribed: boolean) => previewPick(size, mirror, subscribed),
    [mirror],
  );

  const busy = progress !== null
    && progress.phase !== 'done'
    && progress.phase !== 'failed';

  return {
    pendingOffer, progress, error, supported, busy, completed,
    remainingBytesToday: remainingToday(mirror),
    checkPick, sendFile, acceptOffer, rejectOffer, cancel, dismissError,
    retryMode, retry,
    queue, enqueue, remove, resume, clear,
    openReceived, dismissCompleted,
    handleFrame, noteReconnect,
  };
}
