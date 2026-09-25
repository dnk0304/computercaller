/**
 * FT-RETRY-1 — the pure half of "Try again" for an OUTGOING transfer.
 *
 * Before this, "Try again" only cleared the banner: the hook kept no reference
 * to the File once a send failed, so there was nothing to resend. The hook now
 * retains `{file, from, size}` for the send it started (OutgoingRecord) and this
 * module decides what a retry may honestly do with it. React-free and imported
 * relatively, so tests/e2e-ft-web-retry.test.mjs runs it under plain node
 * against the REAL sender.
 *
 * ── THREE OUTCOMES, NEVER A SILENT NO-OP ─────────────────────────────────────
 *   'send'    — the File still reads and still has the size it was offered
 *               with: resend the same File under a NEW transfer id.
 *   'changed' — the File reads but its size moved (browsers that do not
 *               snapshot a picked file). That IS the size_mismatch case, so
 *               the banner says so again; the new size becomes the baseline,
 *               so the next Try again goes through once the file is stable.
 *   'repick'  — the handle no longer reads (NotReadableError: the file was
 *               changed/moved on disk — Chromium snapshots a picked file and
 *               refuses reads once it changes). The UI opens the picker.
 *
 * A panel reload or SW restart drops the hook's state entirely, so there is no
 * banner left to retry from — that case cannot reach this module.
 */

export interface OutgoingRecord {
  /** The very File the user picked. Blob-typed so node's openAsBlob can stand in. */
  readonly file: Blob & { readonly name?: string };
  readonly from: string;
  /** The size the LAST offer was made with — the baseline for 'changed'. */
  readonly size: number;
  /** Set once the sender fails; the error id a retry is allowed to answer. */
  readonly failedId: string | null;
}

export type RetryMode = 'none' | 'resend' | 'repick';
export type RetryPlan = 'send' | 'changed' | 'repick';

/**
 * Which retry affordance the banner shows. Only a failure of OUR send (the id
 * matches the retained record) whose copy action is `retry` qualifies — so
 * quota/tier/too_large stay action-less exactly as the copy table rules, and a
 * RECEIVE failure never pretends it can resend a file this side does not hold.
 */
export function retryModeFor(
  error: { id: string; reason: string } | null,
  outgoing: OutgoingRecord | null,
  repickId: string | null,
  actionOf: (reason: string) => string | undefined,
): RetryMode {
  if (!error || !outgoing || outgoing.failedId === null || outgoing.failedId !== error.id) return 'none';
  if (actionOf(error.reason) !== 'retry') return 'none';
  return repickId === error.id ? 'repick' : 'resend';
}

/** One-byte probe. Reading is the only portable way to learn a handle went stale. */
export async function isReadable(file: Blob): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export async function planRetry(
  outgoing: OutgoingRecord,
  readable: (file: Blob) => Promise<boolean> = isReadable,
): Promise<RetryPlan> {
  if (!(await readable(outgoing.file))) return 'repick';
  // Re-read `size` now, not the value captured at pick time.
  if (outgoing.file.size !== outgoing.size) return 'changed';
  return 'send';
}
