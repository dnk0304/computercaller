'use client';

/**
 * CallHistoryEntries — the per-number call-history detail, extracted from
 * Dashboard.tsx so Phone Mode renders the SAME thing rather than a lookalike.
 *
 * Before this file the history accordion lived inline in Dashboard's Recent
 * Calls column: the matcher, the row markup and the SIM tag were all local
 * JSX. Phone Mode's Recent list had no history at all (a row tap dialled
 * immediately). Dennis asked for "exactly like it is in the quick dial in
 * dashboard", so the correct move was extraction, not a second implementation
 * that drifts on the next change.
 *
 * Two exports, deliberately split:
 *   useCallHistoryEntries(logs, number) — the matching + ordering logic.
 *   <CallHistoryEntries …>              — the presentation.
 *
 * The hook is the part that must never fork (number matching is subtle:
 * "+47 45720075" / "4745720075" / "45720075" are one person). The component
 * takes a `dense` prop because the extension surface runs a 0.8x type scale;
 * that is a size token swap, not a different component.
 */

import React, { useMemo } from 'react';
import { clsx } from 'clsx';
import {
  ArrowDownLeft,
  ArrowUpRight,
  PhoneMissed,
  PhoneOff,
  PhoneIncoming,
  type LucideIcon,
} from 'lucide-react';
import type { CallLogEntry } from '@/hooks/phoneTypes';

export interface CallTypeStyle {
  bg: string;
  fg: string;
  Icon: LucideIcon;
  label: string;
}

/** Icon + tonal colour + human label for a call log type. */
export function callTypeStyle(type: CallLogEntry['type']): CallTypeStyle {
  switch (type) {
    case 'incoming':
      return { bg: 'bg-emerald-100', fg: 'text-emerald-600', Icon: ArrowDownLeft, label: 'Incoming' };
    case 'outgoing':
      return { bg: 'bg-blue-100', fg: 'text-blue-600', Icon: ArrowUpRight, label: 'Outgoing' };
    case 'missed':
      return { bg: 'bg-rose-100', fg: 'text-rose-600', Icon: PhoneMissed, label: 'Missed' };
    case 'rejected':
      return { bg: 'bg-red-100', fg: 'text-red-600', Icon: PhoneOff, label: 'Rejected' };
    default:
      return { bg: 'bg-slate-100', fg: 'text-slate-500', Icon: PhoneIncoming, label: 'Unknown' };
  }
}

/**
 * Compact past-call duration: "2m 34s" / "1h 5m 10s". Empty string for
 * zero/missing/negative — missed and rejected calls have duration 0 and the
 * panel suppresses the column for those rows.
 */
export function formatCallEntryDuration(seconds: number | undefined | null): string {
  if (!seconds || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

const onlyDigits = (n: string) => (n || '').replace(/\D/g, '');

/**
 * Every call log sharing `number`, newest first.
 *
 * Matching compares the last 10 digits so the same person resolves whichever
 * format Android happened to expose. Alphanumeric senders (short codes,
 * "VIPPS") have no digits at all and fall back to an exact case-insensitive
 * compare — a suffix match on an empty digit string would collapse every
 * alphanumeric sender into one bucket.
 *
 * Returns a stable empty array when `number` is null so callers can render
 * unconditionally without a guard.
 */
export function useCallHistoryEntries(
  callLogs: CallLogEntry[],
  number: string | null,
): CallLogEntry[] {
  return useMemo<CallLogEntry[]>(() => {
    if (!number) return [];
    const targetDigits = onlyDigits(number);
    if (!targetDigits) {
      const lower = number.toLowerCase();
      return callLogs
        .filter((l) => (l.number ?? '').toLowerCase() === lower)
        .sort((a, b) => b.date - a.date);
    }
    const matchLen = Math.min(targetDigits.length, 10);
    const targetTail = targetDigits.slice(-matchLen);
    return callLogs
      .filter((l) => {
        const ld = onlyDigits(l.number);
        if (!ld) return (l.number ?? '').toLowerCase() === number.toLowerCase();
        return ld.slice(-matchLen) === targetTail;
      })
      .sort((a, b) => b.date - a.date);
  }, [callLogs, number]);
}

export interface SimEntryLike {
  id: number | string;
  name?: string;
}

export interface CallHistoryEntriesProps {
  entries: CallLogEntry[];
  /** SIM list from the bridge. The SIM tag only renders on multi-SIM phones. */
  simList?: SimEntryLike[];
  /** Millisecond clock the relative-time formatter is measured against. */
  now: number;
  /** Relative date formatter — supplied by the host so both surfaces keep
   *  their own established date vocabulary ("Yesterday", "3h", "Sep 4"). */
  formatDate: (ts: number, now: number) => string;
  /** 0.8x type scale for the extension surface. */
  dense?: boolean;
  className?: string;
}

/**
 * The history list itself: one row per call with that number, showing
 * direction, date, wall-clock time, optional SIM, and duration.
 */
export function CallHistoryEntries({
  entries,
  simList = [],
  now,
  formatDate,
  dense = false,
  className,
}: CallHistoryEntriesProps) {
  const multiSim = simList.length > 1;
  return (
    <ul
      className={clsx(
        'divide-y divide-slate-100/80',
        dense ? 'px-2 py-0.5 text-[10.5px]' : 'px-2 py-1 text-[12px]',
        className,
      )}
    >
      {entries.map((entry) => {
        const es = callTypeStyle(entry.type);
        const EIcon = es.Icon;
        const simName =
          entry.simId && multiSim
            ? simList.find((s) => String(s.id) === entry.simId)?.name ?? null
            : null;
        const duration = formatCallEntryDuration(entry.duration);
        return (
          <li
            key={entry.id}
            className={clsx('flex items-center', dense ? 'gap-1.5 py-1' : 'gap-2 py-2')}
          >
            <div
              className={clsx(
                'flex flex-shrink-0 items-center justify-center rounded-full',
                dense ? 'h-5 w-5' : 'h-6 w-6',
                es.bg,
                es.fg,
              )}
            >
              <EIcon className={dense ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden="true" />
            </div>
            <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
              {es.label}
              {simName && <span className="ml-1.5 font-normal text-slate-400">· {simName}</span>}
            </span>
            <span className="flex-shrink-0 font-medium tabular-nums text-slate-600">
              {formatDate(entry.date, now)}
              {' · '}
              <span className="font-semibold">
                {new Date(entry.date).toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </span>
            {duration && (
              <span className="ml-1 flex-shrink-0 font-medium tabular-nums text-slate-600">
                {duration}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
