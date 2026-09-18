/**
 * Sender state machine. Constant memory: never more than one 48 KiB slice plus
 * its base64 is alive at a time, whatever the file size.
 *
 * Slicing vs File.stream(): the hashing pass uses `file.stream()` because it is
 * forward-only and that is exactly what a digest wants. The CHUNK PUMP uses
 * `file.slice(start, end)` instead, because resume (Addendum A (c)) must be able
 * to restart at an arbitrary `upTo` and a ReadableStream cannot seek. Both are
 * O(1) memory; only slice() can satisfy the resume requirement.
 */
import {
  CHUNK_RAW_BYTES, MAX_FILE_BYTES, SEND_DEFER_MS,
  SEND_HIGH_WATER_BYTES, SENDER_ACK_WINDOW, STALL_TIMEOUT_MS,
} from './constants.ts';
import { bytesToBase64 } from './base64.ts';
import { Sha256 } from './sha256.ts';
import { chunkCount, newTransferId } from './frames.ts';
import type { FileFrame } from './frames.ts';
import type { FileFailedReason } from './reasons.ts';
import type { FileTransport, FrameSink, TransferEvents, TransferPhase, TransferProgress } from './types.ts';

type SenderState = 'idle' | 'hashing' | 'offered' | 'sending' | 'finishing' | 'terminal';

export interface FileSender extends FrameSink {
  /** Begin a transfer. Refuses locally (no frame sent) when size > 1 GB. */
  send(file: File, from: string): Promise<void>;
  cancel(): void;
  /** Called by the host when the socket reconnects, so the stall clock is fair. */
  noteReconnect(): void;
  readonly busy: boolean;
  dispose(): void;
}

export function createFileSender(
  transport: FileTransport,
  events: TransferEvents = {},
): FileSender {
  let state: SenderState = 'idle';
  let file: File | null = null;
  let id = '';
  let sha = '';
  let total = 0;
  let nextSeq = 0;
  let ackedUpTo = -1;
  let startedAt = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let deferTimer: ReturnType<typeof setTimeout> | null = null;
  let pumping = false;

  const chunks = () => chunkCount(total, CHUNK_RAW_BYTES);

  const clearTimers = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
  };

  const progress = (phase: TransferPhase, bytes: number, reason?: FileFailedReason): TransferProgress => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0.25 ? bytes / elapsed : 0;
    const remaining = Math.max(0, total - bytes);
    return {
      id, name: file?.name ?? '', size: total, direction: 'send', phase, bytes,
      bytesPerSecond: rate,
      etaSeconds: rate > 0 && phase === 'transferring' ? remaining / rate : null,
      ...(reason ? { reason } : {}),
    };
  };

  const emit = (phase: TransferPhase, bytes: number) => events.onProgress?.(progress(phase, bytes));

  /** Terminal failure. `announce` is false when the peer is the one telling US. */
  const fail = (reason: FileFailedReason, announce = true) => {
    if (state === 'terminal' || state === 'idle') return;
    const sentBytes = Math.max(0, Math.min(total, (ackedUpTo + 1) * CHUNK_RAW_BYTES));
    state = 'terminal';
    clearTimers();
    if (announce && transport.isOpen()) {
      transport.send('FILE_FAILED', { id, reason });
    }
    events.onProgress?.(progress('failed', sentBytes, reason));
    events.onFailed?.(id, reason);
    file = null;
  };

  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => fail('timeout'), STALL_TIMEOUT_MS);
  };

  const finish = () => {
    if (state !== 'sending') return;
    state = 'finishing';
    clearTimers();
    transport.send('FILE_DONE', { id, sha256: sha });
    state = 'terminal';
    const done = progress('done', total);
    events.onProgress?.(done);
    events.onDone?.(done);
    file = null;
  };

  async function pump(): Promise<void> {
    if (pumping || state !== 'sending' || !file) return;
    pumping = true;
    try {
      while (state === 'sending' && nextSeq < chunks()) {
        if (!transport.isOpen()) return;                      // park; FILE_RESUME restarts us
        if (nextSeq - ackedUpTo > SENDER_ACK_WINDOW) return;  // window shut; FILE_ACK restarts us
        if (transport.bufferedAmount() > SEND_HIGH_WATER_BYTES) {
          if (!deferTimer) {
            deferTimer = setTimeout(() => { deferTimer = null; void pump(); }, SEND_DEFER_MS);
          }
          return;
        }
        const start = nextSeq * CHUNK_RAW_BYTES;
        const slice = file.slice(start, Math.min(start + CHUNK_RAW_BYTES, total));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        if (state !== 'sending' || !file) return;             // cancelled while awaiting the read
        transport.send('FILE_CHUNK', { id, seq: nextSeq, n: chunks(), data: bytesToBase64(bytes) });
        nextSeq++;
        emit('transferring', Math.min(total, nextSeq * CHUNK_RAW_BYTES));
      }
      if (state === 'sending' && nextSeq >= chunks() && ackedUpTo >= chunks() - 1) finish();
    } catch {
      fail('oom');
    } finally {
      pumping = false;
    }
  }

  /** Stream the whole file once for the sha256 the frozen FILE_OFFER requires. */
  async function hashFile(f: File): Promise<string> {
    const h = new Sha256();
    let seen = 0;
    const reader = f.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state !== 'hashing') { void reader.cancel(); throw new Error('cancelled'); }
      const part = value as Uint8Array;
      h.update(part);
      seen += part.length;
      emit('hashing', seen);
    }
    return h.hex();
  }

  return {
    get busy() { return state !== 'idle' && state !== 'terminal'; },

    async send(f, from) {
      if (state !== 'idle' && state !== 'terminal') throw new Error('a transfer is already running');
      file = f; total = f.size; id = newTransferId();
      nextSeq = 0; ackedUpTo = -1; startedAt = Date.now();

      // Local mirror of the server cap: refuse the pick without spending a frame.
      // UX only — the relay refuses independently and is the sole enforcement point.
      if (total > MAX_FILE_BYTES) {
        state = 'terminal';
        events.onProgress?.(progress('failed', 0, 'too_large'));
        events.onFailed?.(id, 'too_large');
        file = null;
        return;
      }

      state = 'hashing';
      try {
        sha = await hashFile(f);
      } catch {
        if (state === 'hashing') fail('cancelled', false);
        return;
      }
      if (state !== 'hashing') return;

      state = 'offered';
      startedAt = Date.now();
      transport.send('FILE_OFFER', {
        id, name: f.name, size: total,
        mime: f.type || 'application/octet-stream', sha256: sha, from,
      });
      emit('offered', 0);
      armStall();
    },

    handleFrame(frame: FileFrame) {
      if (frame.payload.id !== id || state === 'idle' || state === 'terminal') return;
      switch (frame.type) {
        case 'FILE_ACCEPT':
          if (state !== 'offered') return;
          state = 'sending';
          startedAt = Date.now();
          armStall();
          void pump();
          return;

        case 'FILE_REJECT':
          fail('cancelled', false);
          return;

        case 'FILE_ACK': {
          if (state !== 'sending') return;
          if (frame.payload.upTo > ackedUpTo) ackedUpTo = frame.payload.upTo;
          armStall();
          if (nextSeq >= chunks() && ackedUpTo >= chunks() - 1) finish();
          else void pump();
          return;
        }

        case 'FILE_RESUME': {
          // The receiver reconnected. We can only resume while we still hold the
          // File (the tab is alive); otherwise the transfer is honestly dead.
          if (!file) { fail('cancelled'); return; }
          ackedUpTo = Math.min(frame.payload.upTo, chunks() - 1);
          nextSeq = ackedUpTo + 1;
          state = 'sending';
          startedAt = Date.now();
          armStall();
          void pump();
          return;
        }

        case 'FILE_FAILED':
          fail(frame.payload.reason, false);
          return;

        default:
          return;
      }
    },

    noteReconnect() {
      if (state === 'sending' || state === 'offered') armStall();
    },

    cancel() { fail('cancelled'); },

    dispose() { clearTimers(); state = 'terminal'; file = null; },
  };
}
