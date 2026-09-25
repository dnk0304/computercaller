/**
 * FILE-QUEUE-WEB — the queue's orchestration: which File goes to the sender,
 * and when. React-free so tests/e2e-ft-queue.test.mjs drives it against the
 * REAL createFileSender over a recording transport.
 *
 * It OWNS the one FileSender. The active item still goes through that sender
 * and through FT-RETRY-1's planRetry exactly as a single send did — the queue
 * decides only the ORDER; nothing about offering, pumping or failing a transfer
 * is re-implemented here.
 *
 * ── WHY AN EXTERNAL STORE, NOT React STATE ─────────────────────────────────
 * The scheduler has to react to sender callbacks (done / failed), and those are
 * wired once, in a lazy initializer, long before any render can see the queue.
 * Driving "offer the next one" from a React effect means a setState inside an
 * effect for every step (react-hooks/set-state-in-effect, and a render between
 * every hop). Here the step is a plain function call after the reducer runs, and
 * React reads the state through useSyncExternalStore.
 *
 * ── WHY THE KICK IS DEFERRED ────────────────────────────────────────────────
 * The sender fires onFailed/onDone from INSIDE fail()/finish(), and both clear
 * their `file` AFTER the callback returns. Starting the next send synchronously
 * from the callback would hand the sender a new File and then have it nulled
 * under it. `kick()` schedules on a microtask, after that stack unwinds.
 *
 * ── ONE SEND AT A TIME, INCLUDING ITS LAUNCH ───────────────────────────────
 * `sender.send()` hashes before it offers. A cancel during hashing leaves that
 * promise pending until the hash loop notices, and a second send() on the same
 * sender in that window would have the first loop continue under the second's
 * state. So the next item is not launched until the previous send() promise has
 * settled (`launching`).
 */
import { createFileSender } from './sender.ts';
import type { FileSender } from './sender.ts';
import { planRetry } from './retry.ts';
import { newTransferId } from './frames.ts';
import type { FileFailedReason } from './reasons.ts';
import type { FileTransport, TransferEvents, TransferProgress } from './types.ts';
import {
  emptyQueue, isActive, nextToOffer, queueReducer, toPersisted,
} from './queue.ts';
import type { PersistedQueueItem, QueueEvent, QueueItem, QueueState } from './queue.ts';

/** What a retry did. The UI opens the picker on 'repick'. */
export type QueueRetryOutcome = 'sent' | 'changed' | 'repick' | 'unavailable';

export interface QueueControllerDeps {
  transport: FileTransport;
  /** Forwarded sender events (the hook's progress row and quota mirror). */
  sendEvents?: TransferEvents;
  /** Called with the metadata projection whenever it changes. */
  persist?: (items: PersistedQueueItem[]) => void;
  now?: () => number;
  newId?: () => string;
  /** planRetry's readability probe; injected by tests only. */
  readable?: (file: Blob) => Promise<boolean>;
}

export interface QueueController {
  readonly sender: FileSender;
  getState(): QueueState;
  subscribe(listener: () => void): () => void;
  /** Append files at the tail. Returns their queue ids. */
  enqueue(files: readonly File[], from: string): string[];
  /** Remove a row. On the ACTIVE send this is the existing sender.cancel(). */
  remove(id: string): void;
  /** Cancel the active send (if any) and drop its row. */
  cancelActiveSend(): void;
  /** Retry a failed/needs-file row, or send `replacement` in its place. */
  retry(id: string, replacement?: File): Promise<QueueRetryOutcome>;
  resume(): void;
  /** Drop a terminal row (done / failed). */
  clear(id: string): void;
  dismissFailure(): void;
  /** The File a row holds, if it still has one. */
  fileOf(id: string): File | null;
  /** Receive-side facts the scheduler needs (it never offers while receiving). */
  noteReceiveProgress(p: TransferProgress): void;
  noteReceiveDone(transferId: string): void;
  noteReceiveFailed(transferId: string, reason: FileFailedReason): void;
  noteIncomingOffer(pending: boolean): void;
  noteReconnect(): void;
  /** Merge a persisted snapshot (after a restart). */
  restore(records: readonly PersistedQueueItem[], from: string): void;
  dispose(): void;
}

export function createQueueController(deps: QueueControllerDeps): QueueController {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? newTransferId;
  const files = new Map<string, File>();
  const listeners = new Set<() => void>();
  let state: QueueState = emptyQueue();
  let persisted = '[]';
  let launching = false;
  let offerPending = false;
  let kicked = false;
  let disposed = false;
  let wake: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (e: QueueEvent) => {
    const next = queueReducer(state, e);
    if (next === state) return;
    state = next;
    // Drop Files whose rows are gone or finished — a File is a capability over
    // the user's disk and is held only while something can still send it.
    for (const id of files.keys()) {
      const it = state.items.find((x) => x.id === id);
      if (!it || it.state === 'done') files.delete(id);
    }
    if (deps.persist) {
      const snap = toPersisted(state);
      const key = JSON.stringify(snap);
      if (key !== persisted) { persisted = key; deps.persist(snap); }
    }
    for (const l of listeners) l();
  };

  const find = (id: string): QueueItem | undefined => state.items.find((x) => x.id === id);

  const localBusy = () =>
    launching || offerPending || sender.busy || state.items.some((x) => x.state === 'receiving');

  const schedule = () => {
    kicked = false;
    if (disposed || launching) return;
    if (wake) { clearTimeout(wake); wake = null; }
    if (state.paused) return;
    const waiting = state.items.some((x) => x.direction === 'send' && x.state === 'queued');
    if (!waiting) return;
    if (!deps.transport.isOpen()) { dispatch({ type: 'link-down' }); return; }
    const t = now();
    const next = nextToOffer(state, localBusy(), t);
    if (!next) {
      // A busy item waiting out its back-off: come back when it is due.
      const head = state.items.find((x) => x.direction === 'send' && x.state === 'queued');
      if (head && head.notBefore > t && !localBusy() && !state.items.some(isActive)) {
        wake = setTimeout(() => { wake = null; schedule(); }, head.notBefore - t);
      }
      return;
    }
    const file = files.get(next.id);
    if (!file) {
      dispatch({ type: 'needs-file', id: next.id });
      kick();
      return;
    }
    dispatch({ type: 'start', id: next.id });
    launching = true;
    sender.send(file, next.from)
      .catch(() => { /* the sender reports its own failures through onFailed */ })
      .finally(() => { launching = false; kick(); });
  };

  const kick = () => {
    if (kicked || disposed) return;
    kicked = true;
    queueMicrotask(schedule);
  };

  const sender = createFileSender(deps.transport, {
    onProgress: (p) => {
      deps.sendEvents?.onProgress?.(p);
      dispatch({ type: 'progress', progress: p });
    },
    onFailed: (id, reason) => {
      dispatch({ type: 'failed', transferId: id, direction: 'send', reason, at: now() });
      deps.sendEvents?.onFailed?.(id, reason);
      kick();
    },
    onDone: (p) => {
      dispatch({ type: 'done', transferId: p.id, direction: 'send' });
      deps.sendEvents?.onDone?.(p);
      kick();
    },
  });

  const activeSendItem = () => state.items.find((x) => x.direction === 'send' && isActive(x));

  const remove = (id: string) => {
    const it = find(id);
    if (!it) return;
    // Row first, then the cancel: the cancel's own FILE_FAILED echo then finds
    // no live row and is dropped instead of being announced as a failure.
    dispatch({ type: 'remove', id });
    files.delete(id);
    if (it.direction === 'send' && isActive(it)) sender.cancel();
    kick();
  };

  return {
    sender,
    getState: () => state,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },

    enqueue(list, from) {
      const specs = list.map((f) => ({
        id: newId(), name: f.name, size: f.size, lastModified: f.lastModified, from,
      }));
      specs.forEach((s, i) => files.set(s.id, list[i]));
      dispatch({ type: 'enqueue', items: specs });
      kick();
      return specs.map((s) => s.id);
    },

    remove,

    cancelActiveSend() {
      const it = activeSendItem();
      if (it) { remove(it.id); return; }
      sender.cancel();
    },

    async retry(id, replacement) {
      const it = find(id);
      if (!it || it.direction !== 'send' || isActive(it) || it.state === 'done' || it.state === 'queued') {
        return 'unavailable';
      }
      if (replacement) {
        files.set(id, replacement);
        dispatch({
          type: 'repicked', id, name: replacement.name, size: replacement.size,
          lastModified: replacement.lastModified,
        });
        kick();
        return 'sent';
      }
      const file = files.get(id);
      if (!file || it.state === 'needs-file') {
        dispatch({ type: 'needs-file', id });
        return 'repick';
      }
      const plan = await planRetry(
        { file, from: it.from, size: it.size, failedId: it.transferId },
        deps.readable,
      );
      if (plan === 'repick') { dispatch({ type: 'needs-file', id }); return 'repick'; }
      if (plan === 'changed') { dispatch({ type: 'changed', id, size: file.size }); return 'changed'; }
      dispatch({ type: 'retry', id });
      kick();
      return 'sent';
    },

    resume() { dispatch({ type: 'resume' }); kick(); },

    clear(id) {
      const it = find(id);
      if (it && (it.state === 'done' || it.state === 'failed')) remove(id);
    },

    dismissFailure() { dispatch({ type: 'dismiss-failure' }); },

    fileOf: (id) => files.get(id) ?? null,

    noteReceiveProgress(p) {
      dispatch({ type: 'progress', progress: p });
    },
    noteReceiveDone(transferId) {
      dispatch({ type: 'done', transferId, direction: 'receive' });
      kick();
    },
    noteReceiveFailed(transferId, reason) {
      dispatch({ type: 'failed', transferId, direction: 'receive', reason, at: now() });
      kick();
    },
    noteIncomingOffer(pending) {
      offerPending = pending;
      if (!pending) kick();
    },
    noteReconnect() {
      sender.noteReconnect();
      dispatch({ type: 'reconnected' });
      kick();
    },

    restore(records, from) {
      dispatch({ type: 'restore', records, from });
    },

    dispose() {
      disposed = true;
      if (wake) { clearTimeout(wake); wake = null; }
      sender.dispose();
      files.clear();
      listeners.clear();
    },
  };
}
