'use client';

/**
 * /app/admin — Dennis-only customer-tracking dashboard.
 *
 * Gating: the REAL gate is server-side. `GET /api/admin/customers` (Forge)
 * enforces `user.isAdmin` and returns 403 for everyone else. This page renders
 * a graceful "not authorized" card on 403 as defence-in-depth — it never
 * assumes it is the security boundary.
 *
 * Data: consumes the FROZEN `AdminCustomersResponse` contract verbatim. Swap
 * from mock→live is a one-line change already in place (the live fetch is the
 * default; the mock only renders behind `?mock=1` in non-production for design
 * review / screenshots before Forge's endpoint ships).
 *
 * States handled: loading (skeleton) · 403 (not authorized) · error (retry) ·
 * empty ("no customers yet") · success (CustomerTable).
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldAlert, AlertCircle, Users, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { CustomerTable } from '@/components/admin/CustomerTable';
import { FreeAccessManager } from '@/components/admin/FreeAccessManager';
import { ReconcileWhopButton } from '@/components/admin/ReconcileWhopButton';
import { ArticlesSection } from '@/components/admin/ArticlesSection';
import type { AdminCustomersResponse } from '@/components/admin/adminTypes';
import { mockCustomersResponse } from '@/components/admin/mockCustomers';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AdminCustomersResponse };

// Dev-only preview toggle: /app/admin?mock=1 renders the fixture instead of
// fetching. Gated to non-production so it can never surface fake data to a
// real admin session in prod. Read from window (not useSearchParams) to avoid
// the App Router Suspense requirement on a purely client-side flag.
function useMockPreview(): boolean {
  const [mock, setMock] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    try {
      const p = new URLSearchParams(window.location.search);
      setMock(p.get('mock') === '1');
    } catch {
      /* no-op */
    }
  }, []);
  return mock;
}

/**
 * The panel's two jobs. They share a gate and a shell but nothing else, so they
 * are tabs rather than two stacked sections — a long customer table above the
 * guides list would bury the CMS.
 */
type AdminTab = 'customers' | 'articles';

const TABS: ReadonlyArray<{ id: AdminTab; label: string; heading: string; blurb: string }> = [
  {
    id: 'customers',
    label: 'Customers',
    heading: 'Customers',
    blurb: 'Account, trial, billing and same-IP signal for every registered user.',
  },
  {
    id: 'articles',
    label: 'Guides',
    heading: 'Guides',
    blurb: 'Write, edit and publish the guides on computercaller.com.',
  },
];

export default function AdminPage() {
  const mockPreview = useMockPreview();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [tab, setTab] = useState<AdminTab>('customers');

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/admin/customers', { signal });
      if (res.status === 403 || res.status === 401) {
        setState({ kind: 'forbidden' });
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error', message: `Server responded ${res.status}. Please try again.` });
        return;
      }
      const data = (await res.json()) as AdminCustomersResponse;
      if (!data || !Array.isArray(data.customers)) {
        setState({ kind: 'error', message: 'Unexpected response shape from the server.' });
        return;
      }
      setState({ kind: 'ready', data });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setState({ kind: 'error', message: 'Could not reach the server. Check your connection and retry.' });
    }
  }, []);

  useEffect(() => {
    if (mockPreview) {
      setState({ kind: 'ready', data: mockCustomersResponse });
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [mockPreview, load]);

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const showTabs = state.kind !== 'loading' && state.kind !== 'forbidden';

  return (
    <div className="mx-auto max-w-[1400px]">
      {/* Page heading */}
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">{active.heading}</h1>
          <p className="text-xs text-slate-500">{active.blurb}</p>
        </div>
        {tab === 'customers' && state.kind === 'ready' && !mockPreview && (
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>

      {mockPreview && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          Preview mode — showing mock fixture data (not live). Remove <code className="font-mono">?mock=1</code> to load real customers.
        </p>
      )}

      {/* Section switcher. A real tablist so arrow keys and the roving
          aria-selected state work; the panels below are labelled by their tab. */}
      {showTabs && (
        <div
          role="tablist"
          aria-label="Admin sections"
          className="mb-5 inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`admin-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`admin-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={clsx(
                'rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
                tab === t.id
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {state.kind === 'loading' && <TableSkeleton />}
      {state.kind === 'forbidden' && <ForbiddenCard />}

      {tab === 'customers' && state.kind === 'error' && (
        <ErrorCard message={state.message} onRetry={() => void load()} />
      )}

      {tab === 'customers' && state.kind === 'ready' && (
        <div role="tabpanel" id="admin-panel-customers" aria-labelledby="admin-tab-customers" className="space-y-6">
          {/* Whop reconciliation — the ONLY trigger for the sync (there is no
              cron), so it sits above the table rather than in a menu. A run
              refetches the customers feed so a newly-matched payer appears
              without a manual refresh. */}
          {!mockPreview && <ReconcileWhopButton onReconciled={() => void load()} />}

          {/* Free-access allowlist manager — a live-only tool (it reads/writes
              /api/admin/free-access), so it's hidden in the ?mock=1 preview
              where those endpoints aren't being hit. A grant/revoke here
              refetches the customers feed so the table's rows reconcile. */}
          {!mockPreview && <FreeAccessManager onChanged={() => void load()} />}

          {state.data.customers.length === 0 ? (
            <EmptyCard />
          ) : (
            <CustomerTable
              data={state.data}
              now={mockPreview ? Date.parse(state.data.meta.generatedAt) : undefined}
              onMutated={mockPreview ? undefined : () => void load()}
            />
          )}
        </div>
      )}

      {tab === 'articles' && showTabs && (
        <div role="tabpanel" id="admin-panel-articles" aria-labelledby="admin-tab-articles">
          <ArticlesSection />
        </div>
      )}
    </div>
  );
}

// ---------- State cards ------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[68px] animate-pulse rounded-2xl border border-slate-200 bg-white" />
        ))}
      </div>
      <div className="h-10 animate-pulse rounded-xl bg-slate-100" />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="h-9 border-b border-slate-200 bg-slate-50" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0">
            <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
            <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
            <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
            <div className="ml-auto h-4 w-24 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

function ForbiddenCard() {
  return (
    <CenteredCard>
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600" aria-hidden="true">
        <ShieldAlert className="h-6 w-6" />
      </span>
      <h2 className="text-base font-semibold text-slate-800">Not authorized</h2>
      <p className="mt-1.5 text-sm text-slate-500">
        This area is restricted to administrators. If you reached it by mistake, head back to your dashboard.
      </p>
      <Link
        href="/app"
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        Back to dashboard
      </Link>
    </CenteredCard>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <CenteredCard>
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-600" aria-hidden="true">
        <AlertCircle className="h-6 w-6" />
      </span>
      <h2 className="text-base font-semibold text-slate-800">Couldn’t load customers</h2>
      <p className="mt-1.5 text-sm text-slate-500">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/40"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </button>
    </CenteredCard>
  );
}

function EmptyCard() {
  return (
    <CenteredCard>
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500" aria-hidden="true">
        <Users className="h-6 w-6" />
      </span>
      <h2 className="text-base font-semibold text-slate-800">No customers yet</h2>
      <p className="mt-1.5 text-sm text-slate-500">
        As people register and start trials, they’ll appear here with their subscription and activity details.
      </p>
    </CenteredCard>
  );
}
