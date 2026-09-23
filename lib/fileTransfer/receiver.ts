/**
 * Receiver state machine. Writes every chunk straight to disk through a
 * FileSystemWritableFileStream and folds it into a running digest, so peak heap
 * is one 48 KiB chunk regardless of file size.
 *
 * Two rules this module will not bend:
 *  1. It ACKs only AFTER the write to disk resolves. The ACK window is therefore
 *     real backpressure — if the disk is slow the sender is throttled, instead
 *     of chunks piling up in a queue we would have to hold in memory.
 *  2. If there is no disk handle, it does NOT buffer 1 GB in a tab — that is the
 *     bug this module exists to avoid. T-FT-EXT-NO-SAVE-PICKER replaced the
 *     flat refusal with a SECOND, capped sink (./fallbackSink.ts): the whole
 *     file is held in memory and handed to a download, and only up to
 *     FALLBACK_MAX_FILE_BYTES, which is a fraction of the product cap. An offer
 *     above that is refused BEFORE a chunk is admitted. The refusal that used
 *     to fire here made the extension side panel unable to receive any file at
 *     all (PROD 8e0c035), which is not the same thing as declining to buffer a
 *     gigabyte.
 */
import { CC_EXTENSION_ORIGIN } from '../extension.ts';
import { CHUNK_RAW_BYTES, RECEIVER_ACK_EVERY, STALL_TIMEOUT_MS } from './constants.ts';
import { browserDelivery, createFallbackPicker, fallbackAccepts } from './fallbackSink.ts';
import type { FallbackDelivery } from './fallbackSink.ts';
import { base64ToBytes } from './base64.ts';
import { Sha256 } from './sha256.ts';
import { chunkCount } from './frames.ts';
import type { FileFrame, FileOffer } from './frames.ts';
import type { FileFailedReason } from './reasons.ts';
import { sanitizeFilename } from './sanitizeFilename.ts';
import {
  ensureWritePermission, getSaveFilePicker,
} from './fsAccess.ts';
import type { FileSystemWritableFileStream, SaveFileHandle, SaveFilePicker } from './fsAccess.ts';
import { deleteResume, getResume, isResumable, putResume } from './resumeStore.ts';
import type { FileTransport, FrameSink, ReceiverEvents, TransferPhase, TransferProgress } from './types.ts';

type ReceiverState = 'idle' | 'pending' | 'receiving' | 'verifying' | 'terminal';

export interface FileReceiver extends FrameSink {
  /** The offer awaiting the user, or null. FT-3b renders this. */
  readonly pendingOffer: FileOffer | null;
  /**
   * FT-3a.1 (b). The id of the transfer this machine currently has in flight —
   * an offer awaiting the user counts, because tier/quota/busy refusals arrive
   * exactly then. null when there is nothing to abort. This is the LIVENESS
   * clause of MUST A1.1-M9, which the page (not the SW, and not the crypto
   * latch) is the one that can answer.
   */
  readonly liveId: string | null;
  /**
   * Accept and stream to disk. MUST be called synchronously from the click
   * handler — `showSaveFilePicker` requires the user gesture and a queued
   * microtask will have lost it.
   */
  receiveToDisk(offer: FileOffer): Promise<void>;
  reject(id: string): void;
  cancel(): void;
  noteReconnect(): void;
  dispose(): void;
}

export interface ReceiverOptions {
  /** Injected in tests and the proof script; defaults to the real picker. */
  picker?: SaveFilePicker | null;
  /**
   * T-FT-EXT-NO-SAVE-PICKER. The sink used when there is no usable picker.
   * `undefined` resolves the real one for this document; `null` states that
   * this surface has NO fallback, which is how a test pins the refusal path.
   */
  delivery?: FallbackDelivery | null;
}

export function createFileReceiver(
  transport: FileTransport,
  events: ReceiverEvents = {},
  options: ReceiverOptions = {},
): FileReceiver {
  let state: ReceiverState = 'idle';
  let offer: FileOffer | null = null;
  let pending: FileOffer | null = null;
  let handle: SaveFileHandle | null = null;
  /**
   * True while the live transfer is going to the MEMORY fallback sink. It
   * gates the resume record: that record stores a file HANDLE for a later
   * page to reopen, and a memory handle is neither persistable nor meaningful
   * after a reload.
   */
  let sinkIsMemory = false;
  let writable: FileSystemWritableFileStream | null = null;
  let digest = new Sha256();
  let bytesWritten = 0;
  /** Durable watermark: the highest chunk index actually ON DISK. Drives ACK and resume. */
  let upTo = -1;
  /**
   * Highest chunk index ADMITTED for writing. Updated synchronously as frames
   * arrive, because the write is async: chunk n+1 routinely lands before
   * chunk n's write resolves, and comparing it against `upTo` would read a
   * perfectly ordered stream as a gap.
   */
  let acceptedSeq = -1;
  let lastAcked = -1;
  let startedAt = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Disk writes run one at a time through this queue. It is a QUEUE rather than
   * a promise chain on purpose: `verify` and `fail` both need to wait for the
   * writes to settle, and appending them to a chain they then await is a
   * self-deadlock. `drain()` waits only for queued WRITES, never for a waiter.
   */
  const writeQueue: Array<() => Promise<void>> = [];
  let draining = false;
  let drainWaiters: Array<() => void> = [];

  const releaseDrainWaiters = () => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const w of waiters) w();
  };

  async function runQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    while (writeQueue.length > 0) {
      const task = writeQueue.shift()!;
      try {
        await task();
      } catch {
        writeQueue.length = 0;
        draining = false;
        releaseDrainWaiters();
        void fail('oom');
        return;
      }
    }
    draining = false;
    releaseDrainWaiters();
  }

  const enqueueWrite = (task: () => Promise<void>) => {
    writeQueue.push(task);
    void runQueue();
  };

  const drain = (): Promise<void> =>
    !draining && writeQueue.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => drainWaiters.push(resolve));

  const chunks = () => (offer ? chunkCount(offer.size, CHUNK_RAW_BYTES) : 0);

  const clearTimers = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };

  const progress = (phase: TransferPhase, reason?: FileFailedReason): TransferProgress => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0.25 ? bytesWritten / elapsed : 0;
    const size = offer?.size ?? 0;
    return {
      id: offer?.id ?? pending?.id ?? '',
      name: offer?.name ?? pending?.name ?? '',
      size,
      direction: 'receive',
      phase,
      bytes: bytesWritten,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 && phase === 'transferring' ? Math.max(0, size - bytesWritten) / rate : null,
      ...(reason ? { reason } : {}),
    };
  };

  const armStall = () => {
    clearTimers();
    stallTimer = setTimeout(() => void fail('timeout'), STALL_TIMEOUT_MS);
  };

  const sendAck = () => {
    if (upTo === lastAcked) return;
    lastAcked = upTo;
    transport.send('FILE_ACK', { id: offer!.id, upTo });
  };

  /**
   * Terminal failure. Truncates the partial file to zero so no half-file is left
   * looking like a real one, then closes the handle.
   */
  async function fail(reason: FileFailedReason, announce = true): Promise<void> {
    if (state === 'terminal' || state === 'idle') return;
    const id = offer?.id ?? pending?.id ?? '';
    state = 'terminal';
    clearTimers();
    try {
      await drain();
      if (writable) { await writable.truncate(0); await writable.close(); }
    } catch {
      /* the handle is already gone; nothing further to undo */
    }
    writable = null;
    if (announce && transport.isOpen() && id) {
      transport.send('FILE_FAILED', { id, reason });
    }
    if (id) await deleteResume(id);
    events.onProgress?.(progress('failed', reason));
    events.onFailed?.(id, reason);
    offer = null; pending = null; handle = null;
  }

  /** Rebuild the digest from what is already on disk (resume after a reload). */
  async function rehashPartial(h: SaveFileHandle, upToBytes: number): Promise<Sha256> {
    const d = new Sha256();
    const file = await h.getFile();
    const reader = file.slice(0, upToBytes).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      d.update(value as Uint8Array);
    }
    return d;
  }

  async function writeChunk(seq: number, bytes: Uint8Array): Promise<void> {
    await writable!.write(bytes);
    // Fold into the digest only once the bytes are DURABLE, so the digest and
    // `upTo` always describe the same prefix of the file. Hashing at admit time
    // instead would double-count every chunk that was in flight when the socket
    // dropped, and resume would then always fail the hash check.
    digest.update(bytes);
    bytesWritten += bytes.length;
    upTo = seq;
    if (seq % RECEIVER_ACK_EVERY === RECEIVER_ACK_EVERY - 1 || seq === chunks() - 1) {
      sendAck();
      if (!sinkIsMemory) {
        await putResume({
          id: offer!.id, sha256: offer!.sha256, size: offer!.size,
          name: offer!.name, mime: offer!.mime,
          bytesWritten, upTo, handle: handle!, updatedAt: Date.now(),
        });
      }
    }
    events.onProgress?.(progress('transferring'));
  }

  async function verify(declared: string): Promise<void> {
    state = 'verifying';
    clearTimers();
    events.onProgress?.(progress('verifying'));
    const actual = digest.hex();
    // Check both the digest the offer committed to and the one FILE_DONE repeats.
    if (actual !== offer!.sha256 || declared !== offer!.sha256) {
      await fail('hash_mismatch');
      return;
    }
    try {
      await writable!.close();
    } catch {
      await fail('oom');
      return;
    }
    writable = null;
    await deleteResume(offer!.id);
    state = 'terminal';
    const done = progress('done');
    // FT-3a.1 (c): hand the HANDLE — not the writable, which we just closed and
    // which is a write lock on the user's file — to the host, so it can offer
    // "Open" while the toast is up. The machine itself keeps nothing: a handle
    // is a live capability, and its retention window is a UI decision.
    if (handle) events.onReceived?.(offer!.id, offer!.name, handle);
    events.onProgress?.(done);
    events.onDone?.(done);
    offer = null; pending = null; handle = null;
  }

  return {
    get pendingOffer() { return pending; },
    get liveId() {
      if (state === 'idle' || state === 'terminal') return null;
      return offer?.id ?? pending?.id ?? null;
    },

    async receiveToDisk(incoming: FileOffer) {
      if (state === 'receiving' || state === 'verifying') throw new Error('a transfer is already running');
      const diskPicker = options.picker !== undefined ? options.picker : getSaveFilePicker();
      const delivery = options.delivery !== undefined
        ? options.delivery
        : browserDelivery(CC_EXTENSION_ORIGIN);

      /**
       * The memory sink, or null when this surface truly cannot receive.
       * Resolved before the picker is attempted, because the picker's THROW is
       * one of the two ways we end up here (see below) and deciding what to do
       * about it must not depend on work we have not done yet.
       */
      const fallbackFor = (): SaveFilePicker | null => {
        if (!delivery) return null;
        return createFallbackPicker(incoming.mime, incoming.size, delivery);
      };

      /** No picker AND no fallback: refuse honestly, as this always has. */
      const refuseNoSink = () => {
        transport.send('FILE_REJECT', { id: incoming.id });
        pending = null;
        handle = null;
        events.onFailed?.(incoming.id, 'oom');
      };

      /**
       * The fallback holds the file in the tab, so its cap is its own
       * (FALLBACK_MAX_FILE_BYTES), NOT the product's 1 GB. Refused before a
       * chunk is admitted, and reported as `too_large` — which is what it is —
       * so the user gets a sentence instead of a dialog that closed itself.
       */
      const refuseTooLargeForFallback = () => {
        transport.send('FILE_REJECT', { id: incoming.id });
        pending = null;
        handle = null;
        events.onFailed?.(incoming.id, 'too_large');
      };

      const suggestedName = sanitizeFilename(incoming.name, incoming.mime);
      let usingFallback = false;

      if (!diskPicker) {
        const fallback = fallbackFor();
        if (!fallback) { refuseNoSink(); return; }
        if (!fallbackAccepts(incoming.size)) { refuseTooLargeForFallback(); return; }
        usingFallback = true;
        handle = await fallback({ suggestedName });
      } else {
        try {
          handle = await diskPicker({ suggestedName });
        } catch (err) {
          // TWO DIFFERENT THINGS THROW HERE AND THEY ARE NOT THE SAME ANSWER.
          //
          // `AbortError` is the user closing the picker: a decline, and the
          // sender must not be left waiting. Anything else means the SURFACE
          // refused to open a picker at all — inside the extension's
          // side-panel iframe Chrome throws `SecurityError` ("cross origin sub
          // frames aren't allowed to show a file picker"), and a picker that
          // needed a gesture it no longer has throws `NotAllowedError`. Those
          // are not the user's answer, and treating them as one is what sent a
          // silent FILE_REJECT 20 ms after every Accept in the side panel.
          const name = (err as { name?: string } | undefined)?.name;
          const fallback = name === 'AbortError' ? null : fallbackFor();
          if (!fallback) {
            transport.send('FILE_REJECT', { id: incoming.id });
            pending = null;
            handle = null;
            return;
          }
          if (!fallbackAccepts(incoming.size)) { refuseTooLargeForFallback(); return; }
          usingFallback = true;
          handle = await fallback({ suggestedName });
        }
      }
      if (!(await ensureWritePermission(handle))) {
        transport.send('FILE_REJECT', { id: incoming.id });
        pending = null; handle = null;
        return;
      }

      offer = incoming;
      pending = null;
      sinkIsMemory = usingFallback;
      bytesWritten = 0; upTo = -1; acceptedSeq = -1; lastAcked = -1;
      digest = new Sha256();
      writeQueue.length = 0;
      startedAt = Date.now();

      // Resume path: a record for this id whose partial file is still on disk.
      // NOT on the fallback sink — its buffer dies with the page, so there is
      // never a partial to resume from, and a memory handle is not something
      // the resume store could persist even if there were.
      const prior = usingFallback ? null : await getResume(incoming.id);
      let keepExisting = false;
      if (prior && isResumable(prior, incoming)) {
        try {
          digest = await rehashPartial(handle, prior.bytesWritten);
          bytesWritten = prior.bytesWritten;
          upTo = prior.upTo;
          acceptedSeq = prior.upTo;
          lastAcked = prior.upTo;
          keepExisting = true;
        } catch {
          digest = new Sha256();
          bytesWritten = 0; upTo = -1; acceptedSeq = -1; lastAcked = -1;
        }
      }

      try {
        writable = await handle.createWritable({ keepExistingData: keepExisting });
        if (keepExisting) await writable.seek(bytesWritten);
      } catch {
        await fail('oom');
        return;
      }

      state = 'receiving';
      transport.send('FILE_ACCEPT', { id: incoming.id });
      if (keepExisting) {
        transport.send('FILE_RESUME', { id: incoming.id, upTo });
      }
      armStall();
      events.onProgress?.(progress('transferring'));
    },

    reject(id: string) {
      transport.send('FILE_REJECT', { id });
      if (pending?.id === id) pending = null;
    },

    cancel() { void fail('cancelled'); },

    noteReconnect() {
      // Ask the sender to pick up where the disk actually got to. If the record
      // has aged out or the sender no longer holds the File, it answers
      // FILE_FAILED and we tear down cleanly.
      if (state !== 'receiving' || !offer) return;
      armStall();
      // Let every queued write land first, so `upTo` is the true on-disk
      // watermark. Asking to resume from a point the disk has not reached yet
      // would silently lose the chunks that were in flight when the wire died.
      void drain().then(() => {
        if (state !== 'receiving' || !offer) return;
        acceptedSeq = upTo;
        transport.send('FILE_RESUME', { id: offer.id, upTo });
      });
    },

    handleFrame(frame: FileFrame) {
      switch (frame.type) {
        case 'FILE_OFFER':
          // A REPLAY of the offer we are already receiving is legitimate and
          // must be ignored, not refused: the relay's frameBuffer re-sends
          // buffered frames on resume, so the offer routinely arrives a second
          // time on the new socket. Refusing it cancels the very transfer the
          // reconnect was meant to save.
          if (offer && frame.payload.id === offer.id) return;
          // One transfer per room: an offer for a DIFFERENT id mid-transfer is
          // refused.
          if (state === 'receiving' || state === 'verifying') {
            transport.send('FILE_FAILED', { id: frame.payload.id, reason: 'cancelled' });
            return;
          }
          pending = frame.payload;
          state = 'pending';
          events.onOffer?.(frame.payload);
          return;

        case 'FILE_CHUNK': {
          if (state !== 'receiving' || !offer || frame.payload.id !== offer.id) return;
          const { seq } = frame.payload;
          // A duplicate is legitimate — the relay's frameBuffer replays on
          // resume — so ignore it rather than treating a replay as an attack.
          if (seq <= acceptedSeq) return;
          if (seq !== acceptedSeq + 1) { void fail('connection_lost'); return; }
          acceptedSeq = seq;
          armStall();
          let bytes: Uint8Array;
          try {
            bytes = base64ToBytes(frame.payload.data);
          } catch {
            void fail('hash_mismatch');
            return;
          }
          enqueueWrite(() => (state === 'receiving' ? writeChunk(seq, bytes) : Promise.resolve()));
          return;
        }

        case 'FILE_DONE':
          if (state !== 'receiving' || !offer || frame.payload.id !== offer.id) return;
          void drain().then(() => verify(frame.payload.sha256)).catch(() => { void fail('oom'); });
          return;

        case 'FILE_FAILED':
          if (frame.payload.id === pending?.id) { pending = null; state = 'idle'; }
          if (!offer || frame.payload.id !== offer.id) {
            events.onFailed?.(frame.payload.id, frame.payload.reason);
            return;
          }
          void fail(frame.payload.reason, false);
          return;

        default:
          // FILE_ACCEPT / FILE_REJECT / FILE_ACK / FILE_RESUME are the sender's
          // to handle; a receiver that acted on them would be talking to itself.
          return;
      }
    },

    dispose() {
      clearTimers();
      state = 'terminal';
      const w = writable;
      writable = null;
      if (w) void drain().then(() => w.close()).catch(() => {});
      offer = null; pending = null; handle = null;
    },
  };
}
