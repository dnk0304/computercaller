'use client';

/**
 * CallLogFilterBar — the compact (28px) search + filter strip that sits above
 * every Recent/call-log list on the EXTENSION surface (dispatch PIXEL-B2, AC-5).
 *
 * It is a *presentation* for `useCallLogFilter` — the same hook the dashboard's
 * Recent Calls card drives. There is exactly one filter vocabulary and one
 * matching predicate in the codebase (hooks/useCallLogFilter.ts); this file
 * owns none of it. That is the whole point: "like in the webapp" has to mean
 * identical behaviour, not a look-alike with its own rules.
 *
 * It is NOT rendered in /app — the dashboard keeps its own icon-button layout,
 * which is why the 0.8× extension density can live here without touching it.
 *
 * Design notes (Vinci ART-DIRECTION §4.3b):
 *  - The chip label IS the active filter ("All", "Missed") so state is readable
 *    without opening the menu. It goes teal when not "All" — the one non-brand
 *    accent we allow, because "a filter is hiding rows from you" must be
 *    obvious at a glance, and a dot alone is too quiet at this size.
 *  - Colour is never the only signal: the label text changes too, and the
 *    button carries aria-expanded + role=menuitemradio state.
 *  - No date filter. The web app has none, and a date picker cannot be made
 *    honest at 400px wide.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Search,
  X,
  Clock,
  ArrowDownLeft,
  PhoneMissed,
  PhoneOff,
  ArrowUpRight,
  Check,
  ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  CALL_FILTER_OPTIONS,
  callFilterChipLabel,
  type CallFilter,
  type UseCallLogFilterResult,
} from '@/hooks/useCallLogFilter';

/** Key → icon + tone. Mirrors the dashboard menu's icon/colour pairing exactly. */
const OPTION_ICON: Record<CallFilter, { Icon: React.ElementType; color: string }> = {
  all: { Icon: Clock, color: 'text-slate-500' },
  incoming: { Icon: ArrowDownLeft, color: 'text-emerald-600' },
  missed: { Icon: PhoneMissed, color: 'text-rose-600' },
  rejected: { Icon: PhoneOff, color: 'text-red-600' },
  outgoing: { Icon: ArrowUpRight, color: 'text-blue-600' },
};

interface CallLogFilterBarProps {
  /** The live hook instance. Pass the SAME one that produced the rows you render. */
  filter: UseCallLogFilterResult;
  /** Accessible name disambiguator when two bars are on screen (pop-out rail). */
  idPrefix?: string;
}

export function CallLogFilterBar({ filter, idPrefix = 'cc-calllog' }: CallLogFilterBarProps) {
  const {
    callFilter, setCallFilter,
    callSearch, setCallSearch,
    filterMenuOpen, setFilterMenuOpen,
  } = filter;

  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isFiltered = callFilter !== 'all';

  const closeMenu = useCallback(() => {
    setFilterMenuOpen(false);
    triggerRef.current?.focus();
  }, [setFilterMenuOpen]);

  // Escape closes and returns focus to the trigger. Without this the menu is a
  // keyboard trap on a 400px surface where there is nowhere obvious to click away.
  useEffect(() => {
    if (!filterMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterMenuOpen, closeMenu]);

  // Move focus into the menu on open so a keyboard user lands on the options
  // rather than having to tab past the backdrop.
  useEffect(() => {
    if (filterMenuOpen) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [filterMenuOpen]);

  return (
    <div className="cc-filterbar flex flex-shrink-0 items-center gap-1.5 px-2.5 py-1.5">
      {/* Search — always expanded here (unlike the dashboard's icon-to-input
          toggle). At this width a hidden search is a feature nobody finds, and
          the strip has room for it once the filter collapses to one chip. */}
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          id={`${idPrefix}-search`}
          type="search"
          inputMode="tel"
          autoComplete="off"
          value={callSearch}
          onChange={(e) => setCallSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && callSearch) { e.preventDefault(); setCallSearch(''); } }}
          placeholder="Search call log"
          aria-label="Search call log by name or number"
          className="cc-field h-7 w-full rounded-full border border-transparent bg-slate-100 pl-7 pr-6 text-[11.5px] text-slate-800 placeholder:text-slate-400 focus:border-emerald-400 focus:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
        />
        {callSearch && (
          <button
            type="button"
            onClick={() => setCallSearch('')}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition-colors hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Filter chip — label carries the state. */}
      <div className="relative flex-shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setFilterMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={filterMenuOpen}
          aria-label={`Filter call log. Current filter: ${callFilterChipLabel(callFilter)}`}
          className={clsx(
            'inline-flex h-7 max-w-[92px] items-center gap-0.5 rounded-full border px-2 text-[11.5px] font-semibold transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40',
            isFiltered
              ? 'border-teal-400 bg-teal-50 text-teal-800'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          <span className="truncate">{callFilterChipLabel(callFilter)}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-70" aria-hidden="true" />
        </button>

        {filterMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setFilterMenuOpen(false)}
              aria-hidden="true"
            />
            <div
              ref={menuRef}
              role="menu"
              aria-label="Filter call log"
              className="cc-menu absolute right-0 top-full z-50 mt-1 w-[150px] rounded-2xl border border-slate-200 bg-white p-1 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.28)]"
            >
              {CALL_FILTER_OPTIONS.map((opt) => {
                const { Icon, color } = OPTION_ICON[opt.key];
                const selected = callFilter === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => { setCallFilter(opt.key); closeMenu(); }}
                    className={clsx(
                      'flex h-7 w-full items-center gap-2 rounded-lg text-[12px] text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-100',
                      // Sub-types sit under Incoming — same guide-rail grouping
                      // the dashboard menu uses, so the parent/child relationship
                      // reads identically on both surfaces.
                      opt.indent ? 'ml-3 border-l-2 border-slate-100 pl-4 pr-2' : 'px-2',
                      selected && 'bg-slate-100',
                    )}
                  >
                    <Icon className={clsx('h-3.5 w-3.5 flex-shrink-0', color)} aria-hidden="true" />
                    <span className="flex-1 truncate text-left">{opt.label}</span>
                    {selected && <Check className="h-3.5 w-3.5 flex-shrink-0 text-teal-600" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The empty state that pairs with the bar. Deliberately one muted line with a
 * single link — no illustration; this is a 400px panel and an empty-state
 * graphic here costs more than it says.
 */
export function CallLogEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <p className="px-3 py-6 text-center text-[12px] text-slate-500">
      No calls match —{' '}
      <button
        type="button"
        onClick={onClear}
        className="font-semibold text-teal-700 underline underline-offset-2 transition-colors hover:text-teal-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
      >
        clear
      </button>{' '}
      the filter
    </p>
  );
}
