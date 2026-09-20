/**
 * FT-3a.1 (c) — "Open" after a completed receive.
 *
 * The receiver streams to a FileSystemWritableFileStream and closes it at
 * verify time, so by the time the UI can offer an "Open" button the WRITABLE is
 * gone. What survives — and what "Open" actually needs — is the
 * FileSystemFileHandle. We keep that, not the writable: a writable is an open
 * write lock on the user's file and holding one open after the transfer is
 * finished would keep the file locked for as long as a toast is on screen.
 *
 * "Show in folder" is NOT here and cannot be built on the web. The File System
 * Access API exposes no reveal-in-file-manager call, and there is no shim: a
 * handle carries a name and a permission, never a path. FT-3b's copy must not
 * promise it.
 *
 * Lifetime: the handle is dropped when the UI dismisses the toast, or after
 * HANDLE_RETENTION_MS, whichever comes first — see hooks/useFileTransfer.ts.
 * A handle is a live capability over a user file; keeping one for the life of
 * the tab so a button can stay enabled is the wrong trade.
 */
import { ensureReadPermission } from './fsAccess.ts';
import type { SaveFileHandle } from './fsAccess.ts';

/** How long a completed transfer's handle is retained if the UI never dismisses. */
export const HANDLE_RETENTION_MS = 5 * 60 * 1000;

/**
 * How long the object URL stays alive after `window.open`. Revoking it in the
 * same tick is the classic bug: the new tab has not fetched the blob yet and
 * gets an empty document. A timer is the only mechanism available — there is no
 * load event to observe on a cross-document blob URL.
 */
export const OBJECT_URL_TTL_MS = 60_000;

export type OpenReceivedOutcome = 'opened' | 'denied' | 'blocked' | 'gone';

export interface OpenReceivedDeps {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  open(url: string, target: string, features?: string): { closed?: boolean } | null;
  setTimeout(fn: () => void, ms: number): unknown;
}

/** Defaults resolved lazily so importing this module is safe during SSR. */
function browserDeps(): OpenReceivedDeps | null {
  if (typeof window === 'undefined' || typeof URL === 'undefined') return null;
  return {
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    open: (u, t, f) => window.open(u, t, f),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  };
}

/**
 * Re-check permission, read the file back through the handle, and hand it to a
 * new tab. Returns what happened rather than throwing: every outcome here is a
 * normal user-facing state, not an error condition.
 *
 *  - `denied` — the handle's read permission was revoked (a reload, or the user
 *    withdrew it). Permission is re-checked on EVERY reuse and never cached:
 *    a granted permission is a snapshot, and acting on a stale one is how a
 *    "just open it" path turns into an unexplained exception.
 *  - `gone`  — the file behind the handle no longer reads (moved or deleted).
 *  - `blocked` — the popup blocker refused the tab.
 */
export async function openReceivedFile(
  handle: SaveFileHandle,
  deps: OpenReceivedDeps | null = browserDeps(),
): Promise<OpenReceivedOutcome> {
  if (!deps) return 'gone';
  if (!(await ensureReadPermission(handle))) return 'denied';

  let file: File;
  try {
    file = await handle.getFile();
  } catch {
    return 'gone';
  }

  const url = deps.createObjectURL(file);
  let win: { closed?: boolean } | null = null;
  try {
    win = deps.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    win = null;
  }
  // Revoke on a timer either way: on the blocked path the URL is dead weight,
  // and on the success path the new document needs a window to fetch it in.
  deps.setTimeout(() => deps.revokeObjectURL(url), win ? OBJECT_URL_TTL_MS : 0);
  return win ? 'opened' : 'blocked';
}
