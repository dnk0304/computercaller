/**
 * FILE-QUEUE-WEB — the outgoing queue's metadata in IndexedDB (`cc-ft` v2,
 * store `queue`), beside resumeStore.ts and through the same idb.mjs helpers:
 * this file never reaches an IDBFactory itself (tests/e2e-web-idb greps for it).
 *
 * ONE record, key 'snapshot', holding the persisted projection from queue.ts
 * (id, name, size, lastModified, direction, state, reason). NEVER a File and
 * never bytes — a picked file can be up to 1 GB and is a capability over the
 * user's disk, so it dies with the page. That is exactly why a restored
 * `queued` row comes back as `needs-file`, and a restored `offering`/`sending`
 * row as `failed (connection_lost)`: see queueReducer's 'restore' case.
 *
 * Best-effort like resumeStore: storage blocked must never stop a transfer.
 */
import { CC_FT_STORE_QUEUE, ccFtRead, ccFtWrite } from '../e2e/idb.mjs';

import { isFileFailedReason } from './reasons.ts';
import type { PersistedQueueItem, QueueDirection, QueueItemState } from './queue.ts';

const STORE = CC_FT_STORE_QUEUE;
const KEY = 'snapshot';

const STATES: ReadonlySet<string> = new Set<QueueItemState>([
  'queued', 'offering', 'sending', 'receiving', 'done', 'failed', 'needs-file',
]);
const DIRECTIONS: ReadonlySet<string> = new Set<QueueDirection>(['send', 'receive']);

/** A stored row is data from a previous build: shape-checked, never trusted. */
export function coercePersisted(v: unknown): PersistedQueueItem[] {
  if (!Array.isArray(v)) return [];
  const out: PersistedQueueItem[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
    if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) continue;
    if (typeof o.state !== 'string' || !STATES.has(o.state)) continue;
    if (typeof o.direction !== 'string' || !DIRECTIONS.has(o.direction)) continue;
    out.push({
      id: o.id,
      name: o.name,
      size: o.size,
      lastModified: typeof o.lastModified === 'number' ? o.lastModified : 0,
      direction: o.direction as QueueDirection,
      state: o.state as QueueItemState,
      reason: isFileFailedReason(o.reason) ? o.reason : null,
    });
  }
  return out;
}

export async function saveQueue(items: readonly PersistedQueueItem[], factory?: IDBFactory): Promise<void> {
  try {
    await ccFtWrite(factory, STORE, (s) => {
      if (items.length === 0) s.delete(KEY);
      else s.put(items.map((it) => ({ ...it })), KEY);
    });
  } catch {
    /* persistence is a convenience; the live queue is unaffected */
  }
}

export async function loadQueue(factory?: IDBFactory): Promise<PersistedQueueItem[]> {
  try {
    return coercePersisted(await ccFtRead<unknown>(factory, STORE, (s) => s.get(KEY)));
  } catch {
    return [];
  }
}
