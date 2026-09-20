/**
 * Client-side MIRROR of the server's limits (Addendum A), for UX only.
 *
 * READ THIS BEFORE USING IT: nothing in this file enforces anything. The relay
 * refuses at FILE_OFFER and is the sole authority; a client that believed its
 * own arithmetic would be one tampered localStorage entry away from thinking it
 * had quota it does not have. These helpers exist so the UI can say "you have
 * 1.4 GB left today" and grey out an oversized pick — and for nothing else.
 */
import { DAILY_QUOTA_BYTES, MAX_FILE_BYTES } from './constants.ts';

/** The UTC calendar day the server counts against, as `YYYY-MM-DD`. */
export function utcDay(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Milliseconds until the counter resets, for "resets at midnight UTC". */
export function msUntilUtcMidnight(at: Date | number = Date.now()): number {
  const now = new Date(at);
  const next = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
  );
  return next - now.getTime();
}

export interface QuotaMirror {
  day: string;
  bytesUsed: number;
}

export function emptyMirror(at: Date | number = Date.now()): QuotaMirror {
  return { day: utcDay(at), bytesUsed: 0 };
}

/** Roll the counter over when the UTC day changes; otherwise add. */
export function addToMirror(
  mirror: QuotaMirror,
  bytes: number,
  at: Date | number = Date.now(),
): QuotaMirror {
  const day = utcDay(at);
  if (mirror.day !== day) return { day, bytesUsed: Math.max(0, bytes) };
  return { day, bytesUsed: Math.max(0, mirror.bytesUsed + bytes) };
}

export function remainingToday(mirror: QuotaMirror, at: Date | number = Date.now()): number {
  const current = mirror.day === utcDay(at) ? mirror.bytesUsed : 0;
  return Math.max(0, DAILY_QUOTA_BYTES - current);
}

export type PickVerdict =
  | { ok: true }
  | { ok: false; reason: 'too_large' | 'quota' | 'tier' };

/**
 * What the send control should show for a given pick. `subscribed` comes from
 * the app's existing entitlement state — this module never derives it.
 */
export function previewPick(
  size: number,
  mirror: QuotaMirror,
  subscribed: boolean,
  at: Date | number = Date.now(),
): PickVerdict {
  if (!subscribed) return { ok: false, reason: 'tier' };
  if (size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  if (size > remainingToday(mirror, at)) return { ok: false, reason: 'quota' };
  return { ok: true };
}

/** Human size for the offer dialog: "4.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
