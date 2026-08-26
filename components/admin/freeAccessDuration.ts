/**
 * freeAccessDuration — pure helpers for the free-access duration picker and the
 * per-grant expiry chip. Kept framework-free (no React) so the arithmetic is
 * trivially testable and shared between the grant form (compute `durationDays`)
 * and the list (render the window).
 *
 * The server is the clock of record: the picker only ever produces a day COUNT,
 * which the API turns into an `expiresAt`. Everything here that reads `expiresAt`
 * is presentation only — it never decides entitlement.
 */

import type { FreeAccessEntry } from './adminTypes';
import { formatDate } from './customerRows';

/** Same cap the server enforces (`MAX_DURATION_DAYS`) — reject fat-fingered day counts up front. */
export const MAX_DURATION_DAYS = 3650;
const MS_PER_DAY = 86_400_000;

/**
 * Duration presets, in display order. `days: null` = permanent (send no
 * `durationDays`); `days: 'custom'` reveals the day-count input. Default
 * selection is 30 days — a time-boxed comp is the safer default than permanent.
 */
export type DurationPreset = '7' | '30' | '90' | 'permanent' | 'custom';

export interface DurationOption {
  value: DurationPreset;
  label: string;
  /** Fixed day count, `null` for permanent, or `'custom'` for the free input. */
  days: number | null | 'custom';
}

export const DURATION_OPTIONS: readonly DurationOption[] = [
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: 'permanent', label: 'Permanent', days: null },
  { value: 'custom', label: 'Custom', days: 'custom' },
] as const;

/** The default preset — a time-boxed comp, NOT permanent. */
export const DEFAULT_PRESET: DurationPreset = '30';

/**
 * Resolve the picker selection into the `durationDays` the API wants:
 *   • `null`      → permanent grant (omit / null server-side)
 *   • `number`    → finite window
 * Returns `{ ok:false }` when Custom is selected but the day count is invalid,
 * so the form can block submit with inline feedback instead of a round-trip.
 */
export function resolveDurationDays(
  preset: DurationPreset,
  customDays: string,
): { ok: true; days: number | null } | { ok: false; reason: string } {
  if (preset === 'permanent') return { ok: true, days: null };
  if (preset === 'custom') {
    const n = Number(customDays);
    if (!customDays.trim() || !Number.isInteger(n) || n <= 0) {
      return { ok: false, reason: 'Enter a whole number of days (1 or more).' };
    }
    if (n > MAX_DURATION_DAYS) {
      return { ok: false, reason: `Max ${MAX_DURATION_DAYS} days — use Permanent for longer.` };
    }
    return { ok: true, days: n };
  }
  return { ok: true, days: Number(preset) };
}

/** Chip tones map to the existing admin ramp (slate/violet/amber/red). */
export type ChipTone = 'neutral' | 'accent' | 'warn' | 'danger';

export interface ExpiryChip {
  label: string;
  tone: ChipTone;
  /** Longer hover detail (absolute date). */
  title: string;
}

/** Whole days from `now` until `iso`, rounded up (a partial day still counts). */
function daysUntil(iso: string, now: number): number {
  return Math.ceil((new Date(iso).getTime() - now) / MS_PER_DAY);
}

/** Human "in X days" / "today" / "tomorrow" from a positive day count. */
function relativeDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * Describe a grant's window as a status chip. Text-first (never colour alone):
 *   • permanent → neutral "Permanent"
 *   • active    → "Expires Sep 25, 2026 · in 30 days" (amber when ≤7 days left)
 *   • expired   → muted danger "Expired Aug 1, 2026"
 * Falls back gracefully if `expiresAt` is missing for a non-permanent status.
 */
export function describeExpiry(entry: FreeAccessEntry, now: number): ExpiryChip {
  if (entry.status === 'permanent' || entry.expiresAt == null) {
    return { label: 'Permanent', tone: 'neutral', title: 'No expiry — access never lapses.' };
  }
  const dateLabel = formatDate(entry.expiresAt);
  if (entry.status === 'expired') {
    return { label: `Expired ${dateLabel}`, tone: 'danger', title: `Access lapsed on ${dateLabel}.` };
  }
  // active
  const left = daysUntil(entry.expiresAt, now);
  const soon = left <= 7;
  return {
    label: `Expires ${dateLabel} · ${relativeDays(left)}`,
    tone: soon ? 'warn' : 'accent',
    title: `Access lapses ${dateLabel} (${relativeDays(left)}).`,
  };
}
