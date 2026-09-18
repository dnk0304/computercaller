/**
 * FT-3b — presentation-only formatters for the transfer UI.
 *
 * Byte formatting is NOT redefined here: `formatBytes` is re-exported from
 * lib/fileTransfer/quotaMirror.ts so the dialog, the progress row and the quota
 * line cannot drift into rendering "4.2 MB" three different ways.
 */

export { formatBytes } from '@/lib/fileTransfer/quotaMirror.ts';

/**
 * ETA as a short human phrase. Returns null while the rate is unknown, and the
 * caller renders nothing rather than a placeholder — "calculating…" that never
 * resolves is worse than an absent field.
 *
 * Deliberately coarse: a countdown that ticks every second draws the eye to a
 * number that is a guess. Seconds below a minute, whole minutes below an hour,
 * then hours. `Math.round` on the way in so 59.6 s reads "1 min", not "60 sec".
 */
export function formatEta(etaSeconds: number | null): string | null {
  if (etaSeconds === null || !Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
  const s = Math.round(etaSeconds);
  if (s < 60) return `${Math.max(s, 1)} sec left`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr left` : `${h} hr ${rem} min left`;
}

/** Transfer rate for the secondary line: "3.1 MB/s". Null when not yet known. */
export function formatRate(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytesPerSecond;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}/s`;
}

/**
 * Percentage complete, clamped. `size` of 0 is a legal transfer (an empty file)
 * and must read as 100%, not NaN%.
 */
export function percentOf(bytes: number, size: number): number {
  if (size <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((bytes / size) * 100)));
}

/**
 * The label for the phase. `hashing` and `verifying` are real, user-visible
 * waits on a 1 GB file — naming them is the difference between "it's stuck" and
 * "it's checking the file".
 */
export function phaseLabel(phase: string, direction: 'send' | 'receive'): string {
  switch (phase) {
    case 'hashing': return 'Preparing file…';
    case 'offered': return 'Waiting for the other device…';
    case 'transferring': return direction === 'send' ? 'Sending…' : 'Receiving…';
    case 'verifying': return 'Checking the file…';
    case 'done': return direction === 'send' ? 'Sent' : 'Received';
    case 'failed': return 'Failed';
    default: return 'Transferring…';
  }
}
