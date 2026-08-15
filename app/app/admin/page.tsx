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
import { CreateAccountPanel } from '@/components/admin/CreateAccountPanel';
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
type AdminTab = 'customers' | 'accounts' | 'articles';

const TABS: ReadonlyArray<{ id: AdminTab; label: string; heading: string; blurb: string }> = [
  {
    id: 'customers',
    label: 'Customers',
    heading: 'Customers',
    blurb: 'Account, trial, billing and same-IP signal for every registered user.',
  },
  {
    id: 'accounts',
    label: 'New account',
    heading: 'New account',
    blurb: 'Create an account by hand and hand over a one-time link for setting a password.',
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

  /**
   * `silent` (2026-08-15) — refresh the feed WITHOUT dropping the page back to
   * the skeleton.
   *
   * This is a correctness fix, not a polish one. Every mutation tool calls this
   * to reconcile the table, and the old unconditional `setState({kind:'loading'})`
   * flipped `showTabs` to false, which unmounted the whole tab body. On the
   * accounts tab that destroyed the one-time invite link about a second after it
   * appeared — the admin's own successful creation was what erased it. A
   * background reconcile must never tear down the UI that triggered it.
   */
  const load = useCallback(async (opts: { signal?: AbortSignal; silent?: boolean } = {}) => {
    const { signal, silent } = opts;
    if (!silent) setState({ kind: 'loading' });
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
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [mockPreview, load]);

  /**
   * ── The one-time invite guard (2026-08-15) ────────────────────────────────
   *
   * `POST /api/admin/users` stores only a SHA-256 of the invite URL, so the
   * single render inside CreateAccountPanel is the only time it is readable.
   * `pendingInvite` is true while such a link is on screen un-acknowledged.
   *
   * Two protections, because there are two ways to lose it:
   *   • the panel is now permanently MOUNTED (see the tabpanel below), so a tab
   *     change can no longer unmount it — the link survives and is still there
   *     when the admin comes back;
   *   • refresh / close / back still destroy it, and no React state survives
   *     those, so they get a native beforeunload prompt.
   *
   * The in-app confirm below covers the remaining case: the admin walks away to
   * another tab and forgets. Nothing is destroyed by that any more, but a
   * warning at the moment of leaving is what stops the link going stale unseen.
   */
  const [pendingInvite, setPendingInvite] = useState(false);
  const [confirmLeaveTo, setConfirmLeaveTo] = useState<AdminTab | null>(null);

  useEffect(() => {
    if (!pendingInvite) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pendingInvite]);

  /** Every tab change goes through here so none of them can skip the guard. */
  const requestTab = useCallback(
    (next: AdminTab) => {
      if (next === tab) return;
      if (pendingInvite && tab === 'accounts') {
        setConfirmLeaveTo(next);
        return;
      }
      setTab(next);
    },
    [tab, pendingInvite],
  );

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
              onClick={() => requestTab(t.id)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
                tab === t.id
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-600 hover:bg-slate-50',
              )}
            >
              {t.label}
              {/* A link is waiting on that tab. Never colour alone — the dot
                  carries visually-hidden text so it is not a silent signal. */}
              {t.id === 'accounts' && pendingInvite && (
                <>
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-amber-200"
                  />
                  <span className="sr-only">(an invite link is waiting to be copied)</span>
                </>
              )}
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
          {/* Degraded read (2026-08-15). The free-access allowlist query failed,
              so the free_access short-circuit never ran for ANY row on this
              page — a comped user renders a confident "None"/"Expired". The
              failure is page-wide, so it is reported once, here, rather than
              guessed at per row. Same rule as the badge: a failed read must
              never be presented as a verdict. */}
          {state.data.meta.freeAccessDegraded && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
              <div>
                <p className="text-xs font-bold text-amber-900">
                  Free-access list unavailable — access columns on this page are not reliable
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  The allowlist could not be read, so comped users are missing their free-access
                  admit. Any row below may understate what someone can actually do. Refresh to try
                  again; do not act on Plan or Status until it loads cleanly.
                </p>
              </div>
            </div>
          )}

          {!mockPreview && <ReconcileWhopButton onReconciled={() => void load({ silent: true })} />}

          {/* Free-access allowlist manager — a live-only tool (it reads/writes
              /api/admin/free-access), so it's hidden in the ?mock=1 preview
              where those endpoints aren't being hit. A grant/revoke here
              refetches the customers feed so the table's rows reconcile. */}
          {!mockPreview && <FreeAccessManager onChanged={() => void load({ silent: true })} />}

          {state.data.customers.length === 0 ? (
            <EmptyCard />
          ) : (
            <CustomerTable
              data={state.data}
              now={mockPreview ? Date.parse(state.data.meta.generatedAt) : undefined}
              onMutated={mockPreview ? undefined : () => void load({ silent: true })}
            />
          )}
        </div>
      )}

      {/* Create account — live-only (it writes through /api/admin/users), so it
          is hidden in the ?mock=1 preview like the other write tools.

          ⛔ PERMANENTLY MOUNTED, hidden rather than conditionally rendered
          (2026-08-15). It holds a one-time invite URL that exists nowhere else —
          not on the server, which keeps only its hash. Unmounting this subtree
          for ANY reason destroys that link and burns the account, and it used to
          be unmounted by three ordinary things: switching tabs, a background
          refresh dropping `showTabs`, and its own onCreated triggering that
          refresh. `hidden` keeps the state alive and correctly removes the
          panel from the accessibility tree and the tab order while it is away.

          Do not "simplify" this back into a `tab === 'accounts' &&` guard. */}
      {!mockPreview && (
        <div
          role="tabpanel"
          id="admin-panel-accounts"
          aria-labelledby="admin-tab-accounts"
          hidden={tab !== 'accounts' || !showTabs}
        >
          <CreateAccountPanel
            // Silent: this refresh must not tear down the panel that fired it.
            onCreated={() => void load({ silent: true })}
            onViewCustomers={() => requestTab('customers')}
            onPendingInviteChange={setPendingInvite}
          />
        </div>
      )}

      {/* In-app guard. Same shape as the articles CMS dirty guard: an
          alertdialog that names the cost, with the safe choice first. */}
      {confirmLeaveTo && (
        <div
          role="alertdialog"
          aria-labelledby="invite-guard-heading"
          aria-describedby="invite-guard-body"
          className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-5"
        >
          <h3 id="invite-guard-heading" className="text-sm font-semibold text-amber-900">
            You haven’t confirmed the invite link yet
          </h3>
          <p id="invite-guard-body" className="mt-1 text-sm text-amber-800">
            The one-time link is still on the New account tab and cannot be recovered once this
            page is reloaded or closed. Copy it first — it will still be there when you go back.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setConfirmLeaveTo(null)}
              className="inline-flex items-center rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            >
              Stay and copy it
            </button>
            <button
              type="button"
              onClick={() => {
                setTab(confirmLeaveTo);
                setConfirmLeaveTo(null);
              }}
              className="inline-flex items-center rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
            >
              Switch tabs — the link stays open
            </button>
          </div>
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
