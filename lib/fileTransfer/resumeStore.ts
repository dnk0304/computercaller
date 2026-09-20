/**
 * Resume state in IndexedDB (Addendum A (c)).
 *
 * A `FileSystemFileHandle` is structured-cloneable, so IndexedDB can store the
 * handle itself — that is what makes resume survive a page reload and not just
 * a socket blip. The permission grant does NOT survive, which is why every
 * reuse goes through `ensureWritePermission` first.
 *
 * Nothing here is content: id, digest, byte count, filename, handle.
 *
 * ── THE OPEN PATH ──────────────────────────────────────────────────────────
 * This file does NOT open a database. It cannot: P2.1 froze lib/e2e/idb.mjs as
 * the only module under lib/ or hooks/ that may reach an IDBFactory, and
 * tests/e2e-web-idb.test.mjs greps for a second one. This file used to BE that
 * second one — it opened `cc-file-transfer` v1 with its own `onupgradeneeded`,
 * which is the same shape as the two-owner bug idb.mjs was written to end, just
 * not yet collided with. Records now live in the `cc-ft` database that idb.mjs
 * owns, reached through `ccFtRead` / `ccFtWrite`.
 *
 * Two consequences worth knowing:
 *   - Keys are OUT-OF-LINE (the transfer id passed as the second `put`
 *     argument), because idb.mjs's one upgrade body creates every store the
 *     same way. The old store used `keyPath: 'id'`; the record shape is
 *     unchanged either way.
 *   - Writes resolve on the TRANSACTION's `complete`, not the request's
 *     `success`. A resume record that is not durable before the next chunk is
 *     acknowledged is a resume point that can be behind the disk.
 *
 * The abandoned `cc-file-transfer` database is deliberately NOT deleted here:
 * deleting a database needs the IDBFactory this file is no longer allowed to
 * touch, and its contents are already self-expiring (stale handles whose
 * permission grant died with the page that stored them).
 */
import { CC_FT_STORE_RESUME, ccFtRead, ccFtWrite } from '../e2e/idb.mjs';

import { RESUME_WINDOW_MS } from './constants.ts';
import type { SaveFileHandle } from './fsAccess.ts';

const STORE = CC_FT_STORE_RESUME;

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

/**
 * Every call is best-effort: a browser with storage blocked must still be able
 * to transfer a file, it just cannot resume one. Never let this throw upward.
 */
export async function putResume(record: ResumeRecord, factory?: IDBFactory): Promise<void> {
  try {
    await ccFtWrite(factory, STORE, (s) => {
      s.put({ ...record, updatedAt: Date.now() }, record.id);
    });
  } catch {
    /* resume is an optimisation, not a requirement */
  }
}

export async function getResume(id: string, factory?: IDBFactory): Promise<ResumeRecord | null> {
  try {
    const rec = (await ccFtRead<ResumeRecord | undefined>(factory, STORE, (s) => s.get(id))) ?? null;
    if (!rec) return null;
    if (Date.now() - rec.updatedAt > RESUME_WINDOW_MS) {
      await deleteResume(id, factory);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export async function deleteResume(id: string, factory?: IDBFactory): Promise<void> {
  try {
    await ccFtWrite(factory, STORE, (s) => { s.delete(id); });
  } catch {
    /* nothing to clean up we can reach */
  }
}

/** Drop records past the resume window so the store cannot grow without bound. */
export async function pruneResume(now = Date.now(), factory?: IDBFactory): Promise<number> {
  try {
    const all = await ccFtRead<ResumeRecord[]>(factory, STORE, (s) => s.getAll());
    const stale = all.filter((r) => now - r.updatedAt > RESUME_WINDOW_MS);
    for (const r of stale) await deleteResume(r.id, factory);
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
