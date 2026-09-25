/**
 * FILE-QUEUE-WEB — the sender-local transfer queue, as a PURE reducer.
 *
 * Design: DISPATCH-BRIEF-FILE-QUEUE-UI.md ADDENDUM 2 (Q1, zero wire change).
 * The relay stays one-transfer-per-room; the queue is a list this side keeps
 * and walks one item at a time. Nothing here touches a socket, a File, React or
 * IndexedDB: `(state, event) -> state` plus `nextToOffer`. The orchestration
 * (which File, which sender call) lives in queueController.ts; this module is
 * what decides, and tests/e2e-ft-queue.test.mjs pins every rule row.
 *
 * ── ITEM STATES (both platforms, same names) ────────────────────────────────
 *   queued      waiting its turn, not offered            Remove
 *   offering    FILE_OFFER out (or hashing before it)     Cancel
 *   sending     bytes moving out                          Cancel
 *   receiving   bytes moving in                           Cancel
 *   done        terminal ok                               Open (incoming), Clear
 *   failed      terminal, reason = FILE_FAILED reason     Retry, Remove
 *   needs-file  the File is gone (restart / unreadable)   Re-pick, Remove
 *
 * ── SCHEDULER RULES (sender) ────────────────────────────────────────────────
 * Strictly one in flight. The next item is offered only when nothing is active
 * AND the local side is idle (not receiving, no offer awaiting the user).
 * Failure handling by reason class:
 *   busy     -> back to queued, re-offered after QUEUE_BUSY_REOFFER_MS, at most
 *               QUEUE_BUSY_MAX times; then failed and the queue PAUSES (every
 *               item behind it would only hit the same busy phone).
 *   link     -> failed + queue PAUSED ('link'); a reconnect resumes it.
 *   account  -> failed + queue PAUSED ('account'); no auto-resume.
 *   file     -> failed, the queue continues.
 * Retry and Re-pick re-enqueue the item at the TAIL.
 *
 * Imported relatively (no `@/`) so plain node runs the unit suite.
 */
import type { FileFailedReason } from './reasons.ts';
import type { TransferProgress } from './types.ts';

export type QueueItemState =
  | 'queued' | 'offering' | 'sending' | 'receiving' | 'done' | 'failed' | 'needs-file';

export type QueueDirection = 'send' | 'receive';

/** Why the queue stopped walking. Null while it runs. */
export type QueuePause = 'link' | 'account' | 'busy';

export type FailureClass = 'busy' | 'link' | 'account' | 'file';

/** Busy re-offers before the item is failed for good. */
export const QUEUE_BUSY_MAX = 3;
/** How long a busy item waits before it is offered again. */
export const QUEUE_BUSY_REOFFER_MS = 5_000;

export interface QueueItem {
  /** Queue id. Stable across retries; NOT the wire transfer id. */
  readonly id: string;
  /** Wire id of the current / last attempt. Null until the sender names one. */
  readonly transferId: string | null;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly direction: QueueDirection;
  readonly state: QueueItemState;
  readonly reason: FileFailedReason | null;
  /** Bytes hashed / sent / received for the live phase. */
  readonly bytes: number;
  /** Busy re-offers spent on this item. */
  readonly busyRetries: number;
  /** Epoch ms before which a busy-requeued item is not offered again. */
  readonly notBefore: number;
  /** The FILE_OFFER `from` label. */
  readonly from: string;
}

/** The failure the banner renders: the latest one nobody has acted on. */
export interface QueueFailure {
  readonly transferId: string;
  readonly reason: FileFailedReason;
  readonly direction: QueueDirection;
  /** The row it belongs to, or null (a receive that never got a row). */
  readonly itemId: string | null;
}

export interface QueueState {
  readonly items: readonly QueueItem[];
  readonly paused: QueuePause | null;
  readonly lastFailure: QueueFailure | null;
}

/** What survives a restart. Metadata only — never the File, never bytes. */
export interface PersistedQueueItem {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  direction: QueueDirection;
  state: QueueItemState;
  reason: FileFailedReason | null;
}

export interface EnqueueSpec {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  from: string;
}

export type QueueEvent =
  | { type: 'enqueue'; items: readonly EnqueueSpec[] }
  /** The scheduler picked this item and is handing its File to the sender. */
  | { type: 'start'; id: string }
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'done'; transferId: string; direction: QueueDirection }
  | { type: 'failed'; transferId: string; direction: QueueDirection; reason: FileFailedReason; at: number }
  | { type: 'remove'; id: string }
  /** Retry passed planRetry: back in line at the tail. */
  | { type: 'retry'; id: string }
  /** The File no longer reads (or never survived the restart). */
  | { type: 'needs-file'; id: string }
  /** The user picked a replacement: back in line at the tail. */
  | { type: 'repicked'; id: string; name: string; size: number; lastModified: number }
  /** planRetry said the size moved: still failed, new baseline. */
  | { type: 'changed'; id: string; size: number }
  | { type: 'resume' }
  | { type: 'reconnected' }
  /** The socket is not open while there is work to offer. */
  | { type: 'link-down' }
  | { type: 'dismiss-failure' }
  | { type: 'restore'; records: readonly PersistedQueueItem[]; from: string };

export const emptyQueue = (): QueueState => ({ items: [], paused: null, lastFailure: null });

const ACTIVE: ReadonlySet<QueueItemState> = new Set(['offering', 'sending', 'receiving']);
export const isActive = (it: QueueItem): boolean => ACTIVE.has(it.state);

/** Reason -> scheduler class. Unknown reasons are treated per-file. */
export function classifyFailure(reason: FileFailedReason): FailureClass {
  switch (reason) {
    case 'busy': return 'busy';
    case 'connection_lost':
    case 'timeout':
    case 'relay_backpressure': return 'link';
    case 'tier':
    case 'quota': return 'account';
    default: return 'file';
  }
}

/** Reasons where a retry cannot change the outcome; the row offers none. */
const NO_RETRY: ReadonlySet<FileFailedReason> = new Set(['tier', 'quota', 'too_large']);
export function canRetry(it: QueueItem): boolean {
  if (it.direction !== 'send') return false;
  if (it.state === 'needs-file') return true;
  return it.state === 'failed' && (it.reason === null || !NO_RETRY.has(it.reason));
}

const patch = (s: QueueState, id: string, p: Partial<QueueItem>): QueueState => ({
  ...s,
  items: s.items.map((it) => (it.id === id ? { ...it, ...p } : it)),
});

/** Move an item to the tail with a patch applied. */
const toTail = (s: QueueState, id: string, p: Partial<QueueItem>): QueueState => {
  const it = s.items.find((x) => x.id === id);
  if (!it) return s;
  return { ...s, items: [...s.items.filter((x) => x.id !== id), { ...it, ...p }] };
};

const clearFailureFor = (s: QueueState, id: string): QueueState =>
  (s.lastFailure && s.lastFailure.itemId === id ? { ...s, lastFailure: null } : s);

const REQUEUE: Partial<QueueItem> = {
  state: 'queued', reason: null, transferId: null, bytes: 0, busyRetries: 0, notBefore: 0,
};

/** The send item a sender event belongs to: matched by wire id, else the one being offered. */
function activeSend(s: QueueState, transferId: string): QueueItem | undefined {
  const byId = s.items.find((it) => it.direction === 'send' && it.transferId === transferId);
  if (byId) return byId;
  return s.items.find((it) => it.direction === 'send' && it.state === 'offering' && it.transferId === null);
}

const receiveRowId = (transferId: string) => `r:${transferId}`;

export function queueReducer(s: QueueState, e: QueueEvent): QueueState {
  switch (e.type) {
    case 'enqueue': {
      if (e.items.length === 0) return s;
      const known = new Set(s.items.map((it) => it.id));
      const fresh: QueueItem[] = e.items.filter((x) => !known.has(x.id)).map((x) => ({
        id: x.id, transferId: null, name: x.name, size: x.size, lastModified: x.lastModified,
        direction: 'send', state: 'queued', reason: null, bytes: 0, busyRetries: 0,
        notBefore: 0, from: x.from,
      }));
      return fresh.length ? { ...s, items: [...s.items, ...fresh] } : s;
    }

    case 'start': {
      const it = s.items.find((x) => x.id === e.id);
      if (!it || it.state !== 'queued') return s;
      return patch(s, e.id, { state: 'offering', transferId: null, bytes: 0, reason: null });
    }

    case 'progress': {
      const p = e.progress;
      if (p.phase === 'done' || p.phase === 'failed') return s;   // terminal events carry these
      if (p.direction === 'send') {
        const it = activeSend(s, p.id);
        if (!it || !isActive(it)) return s;
        const state: QueueItemState = p.phase === 'hashing' || p.phase === 'offered' ? 'offering' : 'sending';
        if (it.transferId === p.id && it.state === state && it.bytes === p.bytes) return s;
        return patch(s, it.id, { transferId: p.id, state, bytes: p.bytes });
      }
      const rid = receiveRowId(p.id);
      const row = s.items.find((x) => x.id === rid);
      if (!row) {
        const fresh: QueueItem = {
          id: rid, transferId: p.id, name: p.name, size: p.size, lastModified: 0,
          direction: 'receive', state: 'receiving', reason: null, bytes: p.bytes,
          busyRetries: 0, notBefore: 0, from: '',
        };
        return { ...s, items: [...s.items, fresh] };
      }
      if (row.state !== 'receiving' || row.bytes === p.bytes) return s;
      return patch(s, rid, { bytes: p.bytes });
    }

    case 'done': {
      if (e.direction === 'send') {
        const it = activeSend(s, e.transferId);
        if (!it || !isActive(it)) return s;
        return patch(s, it.id, { state: 'done', transferId: e.transferId, bytes: it.size, reason: null });
      }
      const rid = receiveRowId(e.transferId);
      const row = s.items.find((x) => x.id === rid);
      if (!row || row.state !== 'receiving') return s;
      return patch(s, rid, { state: 'done', bytes: row.size });
    }

    case 'failed': {
      if (e.direction === 'receive') {
        const rid = receiveRowId(e.transferId);
        const row = s.items.find((x) => x.id === rid);
        const lastFailure: QueueFailure = {
          transferId: e.transferId, reason: e.reason, direction: 'receive', itemId: row ? rid : null,
        };
        if (!row) return { ...s, lastFailure };
        if (row.state !== 'receiving') return s;
        return { ...patch(s, rid, { state: 'failed', reason: e.reason }), lastFailure };
      }
      // A send failure for no live row is the echo of a local Remove/Cancel:
      // the row is already gone and there is nothing to announce.
      const it = activeSend(s, e.transferId);
      if (!it || !isActive(it)) return s;
      const cls = classifyFailure(e.reason);
      if (cls === 'busy' && it.busyRetries < QUEUE_BUSY_MAX) {
        return patch(s, it.id, {
          state: 'queued', transferId: null, bytes: 0, reason: null,
          busyRetries: it.busyRetries + 1, notBefore: e.at + QUEUE_BUSY_REOFFER_MS,
        });
      }
      const failed = patch(s, it.id, { state: 'failed', reason: e.reason, transferId: e.transferId });
      const lastFailure: QueueFailure = {
        transferId: e.transferId, reason: e.reason, direction: 'send', itemId: it.id,
      };
      const paused: QueuePause | null =
        cls === 'link' ? 'link' : cls === 'account' ? 'account' : cls === 'busy' ? 'busy' : s.paused;
      return { ...failed, paused, lastFailure };
    }

    case 'remove': {
      if (!s.items.some((x) => x.id === e.id)) return s;
      return clearFailureFor({ ...s, items: s.items.filter((x) => x.id !== e.id) }, e.id);
    }

    case 'retry': {
      const it = s.items.find((x) => x.id === e.id);
      if (!it || !canRetry(it)) return s;
      return clearFailureFor({ ...toTail(s, e.id, REQUEUE), paused: null }, e.id);
    }

    case 'needs-file': {
      const it = s.items.find((x) => x.id === e.id);
      if (!it || it.direction !== 'send' || isActive(it) || it.state === 'done') return s;
      if (it.state === 'needs-file') return s;
      return patch(s, e.id, { state: 'needs-file', bytes: 0 });
    }

    case 'repicked': {
      const it = s.items.find((x) => x.id === e.id);
      if (!it || it.direction !== 'send' || isActive(it) || it.state === 'done') return s;
      return clearFailureFor({
        ...toTail(s, e.id, { ...REQUEUE, name: e.name, size: e.size, lastModified: e.lastModified }),
        paused: null,
      }, e.id);
    }

    case 'changed': {
      const it = s.items.find((x) => x.id === e.id);
      if (!it || it.state !== 'failed') return s;
      const next = patch(s, e.id, { size: e.size, reason: 'size_mismatch' });
      const lf = s.lastFailure;
      return lf && lf.itemId === e.id ? { ...next, lastFailure: { ...lf, reason: 'size_mismatch' } } : next;
    }

    case 'resume':
      return s.paused ? { ...s, paused: null } : s;

    case 'reconnected':
      return s.paused === 'link' ? { ...s, paused: null } : s;

    case 'link-down': {
      if (s.paused) return s;
      return s.items.some((x) => x.state === 'queued') ? { ...s, paused: 'link' } : s;
    }

    case 'dismiss-failure':
      return s.lastFailure ? { ...s, lastFailure: null } : s;

    case 'restore': {
      const known = new Set(s.items.map((it) => it.id));
      const restored: QueueItem[] = [];
      for (const r of e.records) {
        if (known.has(r.id) || r.direction !== 'send' || r.state === 'done') continue;
        const midSend = r.state === 'offering' || r.state === 'sending' || r.state === 'receiving';
        const state: QueueItemState =
          midSend ? 'failed' : r.state === 'queued' ? 'needs-file' : r.state;
        const reason: FileFailedReason | null = midSend ? 'connection_lost' : r.reason;
        restored.push({
          id: r.id, transferId: null, name: r.name, size: r.size, lastModified: r.lastModified,
          direction: 'send', state, reason, bytes: 0, busyRetries: 0, notBefore: 0, from: e.from,
        });
      }
      return restored.length ? { ...s, items: [...restored, ...s.items] } : s;
    }

    default:
      return s;
  }
}

/**
 * The item the scheduler should offer now, or null. FIFO: a busy item waiting
 * out its back-off holds the line rather than being overtaken.
 */
export function nextToOffer(s: QueueState, localBusy: boolean, now: number = Date.now()): QueueItem | null {
  if (s.paused || localBusy) return null;
  if (s.items.some(isActive)) return null;
  const next = s.items.find((it) => it.direction === 'send' && it.state === 'queued');
  if (!next || next.notBefore > now) return null;
  return next;
}

/** The persisted projection: outgoing rows only (receives are session history). */
export function toPersisted(s: QueueState): PersistedQueueItem[] {
  return s.items
    .filter((it) => it.direction === 'send' && it.state !== 'done')
    .map((it) => ({
      id: it.id, name: it.name, size: it.size, lastModified: it.lastModified,
      direction: it.direction, state: it.state, reason: it.reason,
    }));
}

/** Counts the strip and the header badge render. */
export function queueCounts(s: QueueState): { queued: number; pending: number; active: QueueItem | null } {
  let queued = 0;
  let pending = 0;
  let active: QueueItem | null = null;
  for (const it of s.items) {
    if (it.state === 'queued') { queued++; pending++; }
    if (isActive(it)) { active = active ?? it; if (it.direction === 'send') pending++; }
  }
  return { queued, pending, active };
}
