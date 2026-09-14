'use client';

/**
 * useCallLogFilter — the SINGLE source of truth for "filter + search the call
 * log", shared by the dashboard Recent Calls card and the extension surface.
 *
 * Lifted verbatim out of Dashboard.tsx (was lines 751-790, 2026-09-14, dispatch
 * PIXEL-B2 / AC-5). Nothing about the semantics changed — this file is a move,
 * not a rewrite. The reason it moved: Dennis asked for call-log search + filter
 * "like in the webapp" inside the extension, and copying the predicate is
 * exactly how two surfaces drift apart on what "Incoming" means.
 *
 * Semantics preserved from the original (do not "simplify" these):
 *   - A missed or rejected call IS an inbound call that wasn't answered, so
 *     `incoming` is the PARENT group and matches answered + missed + rejected.
 *     `missed` / `rejected` narrow to those inbound sub-types. `outgoing` is
 *     separate. `unknown` survives only under `all`.
 *   - Search matches contact name OR number as a plain lowercase substring;
 *     if the query contains digits it additionally matches the number with all
 *     non-digits stripped (so "47 12 34" finds "+4712 34"). Substring, not
 *     suffix — the suffix compare elsewhere in Dashboard is a different feature
 *     (the call-history panel) and is deliberately NOT merged in here.
 *   - Search is debounced 150ms; the filter is not.
 */

import { useDeferredValue, useMemo, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { CallLogEntry } from '@/hooks/phoneTypes';

export type CallFilter = 'all' | 'incoming' | 'missed' | 'rejected' | 'outgoing';

/**
 * The filter vocabulary, in the fixed order both surfaces render.
 * `indent` marks Incoming's sub-types so a menu can show the parent/child
 * grouping. Icon + colour are named, not imported, so this module stays free
 * of UI deps; each surface maps the key to its own lucide icon.
 */
export const CALL_FILTER_OPTIONS = [
  { key: 'all', label: 'All calls', indent: false },
  { key: 'incoming', label: 'Incoming', indent: false },
  { key: 'missed', label: 'Missed', indent: true },
  { key: 'rejected', label: 'Rejected', indent: true },
  { key: 'outgoing', label: 'Outgoing', indent: false },
] as const satisfies ReadonlyArray<{ key: CallFilter; label: string; indent: boolean }>;

/** Short label for a chip that shows the ACTIVE filter without opening the menu. */
export function callFilterChipLabel(filter: CallFilter): string {
  return filter === 'all' ? 'All' : CALL_FILTER_OPTIONS.find(o => o.key === filter)!.label;
}

/**
 * Pure predicate — exported so a test (or a future surface) can assert the
 * matching rules without mounting a component.
 */
export function applyCallLogFilter(
  rows: readonly CallLogEntry[],
  filter: CallFilter,
  search: string,
): CallLogEntry[] {
  let out: readonly CallLogEntry[] = rows;
  if (filter === 'incoming') {
    // Parent group: any inbound call — answered, missed, or rejected.
    out = out.filter(
      (log) => log.type === 'incoming' || log.type === 'missed' || log.type === 'rejected'
    );
  } else if (filter !== 'all') {
    out = out.filter((log) => log.type === filter);
  }
  const q = search.trim().toLowerCase();
  if (q) {
    const qDigits = q.replace(/\D/g, '');
    out = out.filter((log) => {
      const name = (log.name || '').toLowerCase();
      const number = (log.number || '').toLowerCase();
      if (name.includes(q) || number.includes(q)) return true;
      if (qDigits) return number.replace(/\D/g, '').includes(qDigits);
      return false;
    });
  }
  return out as CallLogEntry[];
}

export interface UseCallLogFilterResult {
  callFilter: CallFilter;
  setCallFilter: (f: CallFilter) => void;
  callSearch: string;
  setCallSearch: (s: string) => void;
  /** Debounced (150ms) copy of `callSearch` — what the predicate actually reads. */
  debouncedCallSearch: string;
  filterMenuOpen: boolean;
  setFilterMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filteredCallLogs: CallLogEntry[];
  /** True when the visible list is a subset — drives the "you are hiding rows" accent. */
  isCallListFiltered: boolean;
  /** Reset to the unfiltered list. Backs the "clear the filter" empty-state link. */
  clear: () => void;
}

export function useCallLogFilter(callLogs: readonly CallLogEntry[]): UseCallLogFilterResult {
  const deferredCallLogs = useDeferredValue(callLogs);
  const [callFilter, setCallFilter] = useState<CallFilter>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [callSearch, setCallSearch] = useState('');
  const debouncedCallSearch = useDebouncedValue(callSearch, 150);

  const filteredCallLogs = useMemo(
    () => applyCallLogFilter(deferredCallLogs, callFilter, debouncedCallSearch),
    [deferredCallLogs, callFilter, debouncedCallSearch],
  );

  const isCallListFiltered =
    callFilter !== 'all' || debouncedCallSearch.trim().length > 0;

  return {
    callFilter,
    setCallFilter,
    callSearch,
    setCallSearch,
    debouncedCallSearch,
    filterMenuOpen,
    setFilterMenuOpen,
    filteredCallLogs,
    isCallListFiltered,
    clear: () => { setCallFilter('all'); setCallSearch(''); },
  };
}
