/**
 * Resume state in IndexedDB (Addendum A (c)).
 *
 * A `FileSystemFileHandle` is structured-cloneable, so IndexedDB can store the
 * handle itself — that is what makes resume survive a page reload and not just
 * a socket blip. The permission grant does NOT survive, which is why every
 * reuse goes through `ensureWritePermission` first.
 *
 * Nothing here is content: id, digest, byte count, filename, handle.
 */
import { RESUME_WINDOW_MS } from './constants.ts';
import type { SaveFileHandle } from './fsAccess.ts';

const DB_NAME = 'cc-file-transfer';
const DB_VERSION = 1;
const STORE = 'resume';

export interface ResumeRecord {
  id: string;
  /** sha256 declared in the original FILE_OFFER. */
  sha256: string;
  size: number;
  name: string;
  mime: string;
  bytesWritten: number;
  /** Highest contiguous chunk index written to disk. */
  upTo: number;
  handle: SaveFileHandle;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        t.oncomplete = () => db.close();
      }),
  );
}

/**
 * Every call is best-effort: a browser with storage blocked must still be able
 * to transfer a file, it just cannot resume one. Never let this throw upward.
 */
export async function putResume(record: ResumeRecord): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put({ ...record, updatedAt: Date.now() }) as IDBRequest<IDBValidKey>);
  } catch {
    /* resume is an optimisation, not a requirement */
  }
}

export async function getResume(id: string): Promise<ResumeRecord | null> {
  try {
    const rec = (await tx('readonly', (s) => s.get(id) as IDBRequest<ResumeRecord | undefined>)) ?? null;
    if (!rec) return null;
    if (Date.now() - rec.updatedAt > RESUME_WINDOW_MS) {
      await deleteResume(id);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export async function deleteResume(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  } catch {
    /* nothing to clean up we can reach */
  }
}

/** Drop records past the resume window so the store cannot grow without bound. */
export async function pruneResume(now = Date.now()): Promise<number> {
  try {
    const all = await tx('readonly', (s) => s.getAll() as IDBRequest<ResumeRecord[]>);
    const stale = all.filter((r) => now - r.updatedAt > RESUME_WINDOW_MS);
    for (const r of stale) await deleteResume(r.id);
    return stale.length;
  } catch {
    return 0;
  }
}

/**
 * Pure policy, extracted so it is unit-testable without IndexedDB: is this
 * record still usable as the basis for a FILE_RESUME?
 */
export function isResumable(
  rec: Pick<ResumeRecord, 'id' | 'sha256' | 'size' | 'bytesWritten' | 'upTo' | 'updatedAt'>,
  offer: { id: string; sha256: string; size: number },
  now = Date.now(),
): boolean {
  if (rec.id !== offer.id) return false;
  if (rec.sha256 !== offer.sha256) return false;
  if (rec.size !== offer.size) return false;
  if (rec.bytesWritten <= 0 || rec.bytesWritten > offer.size) return false;
  if (rec.upTo < 0) return false;
  return now - rec.updatedAt <= RESUME_WINDOW_MS;
}
