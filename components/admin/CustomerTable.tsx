'use client';

/**
 * CustomerTable — presentational table for the admin customer-tracking
 * dashboard. Pure UI: receives the frozen `AdminCustomersResponse` and owns
 * only view state (search / flagged-only toggle / sort). No fetching.
 *
 * Design language matches the authenticated `/app` surface: white cards,
 * `slate` text ramp, blue/emerald/amber accents, `rounded-2xl` cards,
 * `focus-visible:ring` focus states, `tabular-nums` for figures. (The app is a
 * LIGHT theme end-to-end — see app/globals.css `--background: slate-50`.)
 *
 * Accessibility:
 *   - Real semantic <table> with <thead>/<tbody> and scoped <th>.
 *   - Sortable columns are <button>s inside <th>, and the <th> carries
 *     `aria-sort` so screen readers announce the active sort + direction.
 *   - Every icon-only signal has an adjacent visually-hidden text label or a
 *     `title`/`aria-label`, so meaning never rides on colour/glyph alone
 *     (WCAG 1.4.1 Use of Color).
 */

import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Check,
  Search,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Users,
  Clock,
  CreditCard,
  XCircle,
} from 'lucide-react';
import type { AdminCustomersResponse } from './adminTypes';
import {
  resolveState,
  trialStatusPill,
  authBadge,
  formatDate,
  formatAbsolute,
  formatRelative,
  sortCustomers,
  summarise,
  type SortKey,
  type SortDir,
} from './customerRows';

// ---------- Google brand glyph ---------------------------------------------
// lucide-react has no brand icons; this is the standard 4-colour "G" mark,
// small enough to sit inline in the auth badge. aria-hidden — the badge text
// ("Google" / "Both") already carries the meaning.
function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.5 5.5 0 0 1-2.4 3.6v3h3.88c2.27-2.09 3.57-5.17 3.57-8.84z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.95-2.9l-3.88-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.3a7.2 7.2 0 0 1 0-4.6V6.61H1.29a12 12 0 0 0 0 10.78z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.29 6.61l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

// ---------- Small presentational atoms --------------------------------------

/** Yes/No cell — green tick for yes, muted dash for no/unknown. */
function YesNoCell({ value, yesLabel, noLabel }: { value: boolean | null; yesLabel: string; noLabel: string }) {
  if (value === null) {
    return <span className="text-slate-300" title="Unknown" aria-label="Unknown">—</span>;
  }
  if (value) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <Check className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="text-xs">{yesLabel}</span>
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{noLabel}</span>;
}

interface HeaderButtonProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right' | 'center';
}

/** Sortable column header — a button inside the <th>; the <th> owns aria-sort. */
function SortableTh({ label, sortKey, activeKey, dir, onSort, align = 'left' }: HeaderButtonProps) {
  const active = activeKey === sortKey;
  const ariaSort: React.AriaAttributes['aria-sort'] = active
    ? dir === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={clsx(
        'sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap border-b border-slate-200',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center'
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={clsx(
          'inline-flex items-center gap-1 rounded transition-colors hover:text-slate-800',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          align === 'right' && 'flex-row-reverse',
          active && 'text-blue-700'
        )}
      >
        <span>{label}</span>
        <Icon className="w-3 h-3" aria-hidden="true" />
      </button>
    </th>
  );
}

/** Plain (non-sortable) header cell. */
function PlainTh({ label, align = 'left', srHint }: { label: string; align?: 'left' | 'right' | 'center'; srHint?: string }) {
  return (
    <th
      scope="col"
      className={clsx(
        'sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap border-b border-slate-200',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center'
      )}
    >
      {label}
      {srHint ? <span className="sr-only"> — {srHint}</span> : null}
    </th>
  );
}

interface SummaryCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'slate' | 'blue' | 'emerald' | 'amber' | 'red';
}

function SummaryCard({ label, value, icon, tone }: SummaryCardProps) {
  const toneMap: Record<SummaryCardProps['tone'], string> = {
    slate: 'text-slate-600 bg-slate-100',
    blue: 'text-blue-600 bg-blue-50',
    emerald: 'text-emerald-600 bg-emerald-50',
    amber: 'text-amber-600 bg-amber-50',
    red: 'text-red-600 bg-red-50',
  };
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <span className={clsx('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl', toneMap[tone])} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xl font-bold tabular-nums leading-none text-slate-800">{value.toLocaleString()}</p>
        <p className="mt-1 truncate text-[11px] font-medium text-slate-500">{label}</p>
      </div>
    </div>
  );
}

// ---------- Main component --------------------------------------------------

interface CustomerTableProps {
  data: AdminCustomersResponse;
  /** Fixed "now" for deterministic relative timestamps (tests/preview). */
  now?: number;
}

export function CustomerTable({ data, now }: CustomerTableProps) {
  const nowMs = now ?? Date.now();
  const [search, setSearch] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('flagged');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Sensible default direction per column: text ascending, everything
      // else descending (most-recent / most-urgent / flagged-first on top).
      setSortDir(key === 'email' ? 'asc' : 'desc');
    }
  };

  // Summary reflects the FULL dataset, not the filtered view — the cards are a
  // portfolio overview, so filtering the table shouldn't move the headline
  // numbers.
  const summary = useMemo(() => summarise(data.customers), [data.customers]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.customers;
    if (flaggedOnly) list = list.filter((c) => c.flagged);
    if (q) list = list.filter((c) => c.email.toLowerCase().includes(q));
    return sortCustomers(list, sortKey, sortDir);
  }, [data.customers, search, flaggedOnly, sortKey, sortDir]);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="Total users" value={summary.total} tone="slate" icon={<Users className="h-4 w-4" />} />
        <SummaryCard label="On trial" value={summary.onTrial} tone="blue" icon={<Clock className="h-4 w-4" />} />
        <SummaryCard label="Paying" value={summary.paying} tone="emerald" icon={<CreditCard className="h-4 w-4" />} />
        <SummaryCard label="Trial expired" value={summary.trialExpired} tone="amber" icon={<XCircle className="h-4 w-4" />} />
        <SummaryCard label="Flagged" value={summary.flagged} tone="red" icon={<AlertTriangle className="h-4 w-4" />} />
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:max-w-xs sm:flex-1">
          <label htmlFor="admin-customer-search" className="sr-only">
            Search customers by email
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            id="admin-customer-search"
            type="search"
            inputMode="email"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email…"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFlaggedOnly((v) => !v)}
            aria-pressed={flaggedOnly}
            className={clsx(
              'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30',
              flaggedOnly
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            )}
          >
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Show flagged only
          </button>
        </div>
      </div>

      {/* Flag legend + result count */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <p aria-live="polite">
          Showing <span className="font-medium text-slate-600 tabular-nums">{rows.length}</span> of{' '}
          <span className="tabular-nums">{data.customers.length}</span> customers
        </p>
        <p className="inline-flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden="true" />
          Flagged = {data.meta.sameIpThreshold}+ accounts sharing one signup IP
        </p>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              Customer accounts with subscription, trial, billing, and same-IP flag details. Sortable columns are buttons in the header row.
            </caption>
            <thead>
              <tr>
                <SortableTh label="Email" sortKey="email" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <PlainTh label="Verified" align="center" srHint="email verified" />
                <PlainTh label="Auth" />
                <PlainTh label="Trial status" />
                <SortableTh label="Days left" sortKey="trialDaysLeft" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                <PlainTh label="Paying" align="center" />
                <SortableTh label="Paying since" sortKey="convertedAt" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <PlainTh label="Card on Whop" align="center" />
                <SortableTh label="Registered" sortKey="registeredAt" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableTh label="Last active" sortKey="lastActiveAt" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableTh label="Flag" sortKey="flagged" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="center" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center">
                    <p className="text-sm font-medium text-slate-500">No customers match your filters</p>
                    <p className="mt-1 text-xs text-slate-400">Try clearing the search or the flagged-only filter.</p>
                  </td>
                </tr>
              ) : (
                rows.map((c) => {
                  const state = resolveState(c.subscription);
                  const pill = trialStatusPill(state);
                  const badge = authBadge(c.authProvider);
                  const isTrialing = state === 'trialing';
                  const daysLeft = c.subscription?.trialDaysLeft ?? null;
                  const daysUrgent = isTrialing && daysLeft !== null && daysLeft <= 3;
                  const isPaying = state === 'active';
                  return (
                    <tr
                      key={c.id}
                      className={clsx(
                        'border-b border-slate-100 last:border-0 transition-colors hover:bg-slate-50/70',
                        c.flagged && 'bg-red-50/40'
                      )}
                    >
                      {/* Email — mono, truncate + tooltip */}
                      <td className="px-3 py-2.5">
                        <span className="block max-w-[220px] truncate font-mono text-[13px] text-slate-800" title={c.email}>
                          {c.email}
                        </span>
                      </td>

                      {/* Email verified */}
                      <td className="px-3 py-2.5 text-center">
                        {c.emailVerified ? (
                          <span className="inline-flex text-emerald-600" title="Email verified" aria-label="Email verified">
                            <Check className="h-4 w-4" aria-hidden="true" />
                          </span>
                        ) : (
                          <span className="text-slate-300" title="Email not verified" aria-label="Email not verified">
                            —
                          </span>
                        )}
                      </td>

                      {/* Auth method */}
                      <td className="px-3 py-2.5">
                        <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', badge.className)}>
                          {badge.google ? <GoogleGlyph className="h-3 w-3" /> : null}
                          {badge.label}
                        </span>
                      </td>

                      {/* Trial status pill */}
                      <td className="px-3 py-2.5">
                        <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', pill.className)}>
                          {pill.label}
                        </span>
                      </td>

                      {/* Trial days left */}
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {isTrialing && daysLeft !== null ? (
                          <span className={clsx('text-[13px] font-semibold', daysUrgent ? 'text-amber-600' : 'text-slate-700')}>
                            {daysLeft}
                            <span className="text-slate-400">d</span>
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Paying customer */}
                      <td className="px-3 py-2.5 text-center">
                        {isPaying ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700" title="Paying customer">
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="text-xs">Yes</span>
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">No</span>
                        )}
                      </td>

                      {/* Paying since */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-slate-600">
                        {formatDate(c.subscription?.convertedAt)}
                      </td>

                      {/* Card on Whop */}
                      <td className="px-3 py-2.5 text-center">
                        <YesNoCell value={c.subscription?.paymentMethodAttached ?? null} yesLabel="Yes" noLabel="No" />
                      </td>

                      {/* Registered */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-slate-600">
                        {formatDate(c.registeredAt)}
                      </td>

                      {/* Last active */}
                      <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-slate-600">
                        <span title={formatAbsolute(c.lastActiveAt)}>
                          {formatRelative(c.lastActiveAt, nowMs)}
                        </span>
                      </td>

                      {/* Flagged */}
                      <td className="px-3 py-2.5 text-center">
                        {c.flagged ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200"
                            title={`Same-IP cluster: ${c.sameIpAccountCount} accounts share IP ${c.signupIp ?? 'unknown'}`}
                          >
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {c.sameIpAccountCount}
                            <span className="sr-only">
                              accounts share signup IP {c.signupIp ?? 'unknown'} — flagged
                            </span>
                          </span>
                        ) : (
                          <span className="text-slate-300" aria-label="Not flagged">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
