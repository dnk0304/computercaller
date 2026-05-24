'use client';

import React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { RefreshCw, DatabaseBackup } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { PhoneStatusButton } from '@/components/PhoneStatusButton';
import { ProfileMenu } from '@/components/ProfileMenu';
import { usePhone, useDashboardTab, type DashboardTab } from '@/hooks';

/**
 * AppShell — the persistent chrome around every /app/* route.
 *
 * What it renders:
 *   ┌──────────┬──────────────────────────────────────┐
 *   │          │  header (title, status, sub pill)    │
 *   │ Sidebar  ├──────────────────────────────────────┤
 *   │          │  {children}  ← route-specific slot   │
 *   └──────────┴──────────────────────────────────────┘
 *
 * Why it lives in a layout-level component:
 *   /app/page.tsx (the tabbed dashboard) and /app/settings/page.tsx (the
 *   pairing-QR page) are separate Next.js routes. Before this refactor the
 *   chrome was inlined inside /app/page.tsx, which meant /app/settings
 *   rendered standalone with no Sidebar — users who clicked into
 *   "Pair phone & account" were stranded with no nav to return.
 *
 *   Hoisting Sidebar + header here gives every /app/* route the same
 *   chrome for free. Mount in app/app/layout.tsx; let route pages
 *   render only their content.
 *
 * Cross-route tab state:
 *   The Sidebar drives `activeTab` via `useDashboardTab()`. When the user is
 *   on /app/settings and clicks a Sidebar tab, we route back to /app AND
 *   set the new tab on the context. The dashboard remounts and reads the
 *   chosen tab from context. Clicking the Settings tab specifically does
 *   NOT route to /app/settings — that route is the "deep settings" page
 *   reached from inside the inline Settings panel via "Pair phone & account".
 *   Tapping the Settings tab from anywhere flips the inline Settings panel
 *   on the dashboard, matching the prior behaviour.
 *
 * Layout invariant:
 *   The outer wrapper is `flex h-screen overflow-hidden` — the original
 *   shell semantics from /app/page.tsx. The right-hand <main> column
 *   carries the sticky header and a single scroll-managed content slot. Any
 *   page rendered into {children} must handle its own internal scroll
 *   (the dashboard tab content panes do this; /app/settings is wrapped in a
 *   scrollable container here as a safety net).
 */

// Pages whose content needs its own scroll context. The dashboard /app
// already manages scroll internally via per-tab containers; /app/settings
// renders prose-style sections that need to scroll inside the shell.
function shouldWrapInScrollContainer(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname.startsWith('/app/settings');
}

// Header title in the chrome is product branding, not page state. The page-
// level heading (tab label or route name) is surfaced by the Sidebar / page
// content itself — the bar at the top of the shell is the brand.
const HEADER_TITLE = 'ComputerCaller';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { activeTab, setActiveTab } = useDashboardTab();

  // Phone bridge — header surfaces TWO sync affordances when a phone is
  // connected:
  //   1. "Quick" — six-hour incremental sync (calls + messages since the
  //      last successful pass). Cheap, runs in the background, no modal.
  //   2. "Full" — opens the Full Sync setup panel (SyncSetupPanel) so the
  //      user can re-run the whole sync from scratch with per-row progress.
  //      Added dispatch #9 (2026-05-22) — Dennis wanted the full-sync UI
  //      reachable from the header without first opening a settings drawer.
  // Both methods are exposed defensively (loose cast) — the public hook type
  // hasn't been regenerated in every consumer build yet. Same pattern as the
  // sendDtmf cast in Dashboard.tsx.
  const phone = usePhone();
  const { isConnected } = phone;
  const quickSync = (phone as unknown as { quickSync?: () => void }).quickSync;
  const openSyncPanel = (phone as unknown as { openSyncPanel?: () => void }).openSyncPanel;

  // Sidebar click handler.
  //   - If we're not on the dashboard route, route to /app first so the
  //     tabbed content actually exists to render into.
  //   - Always update the context so the dashboard renders the right tab
  //     when it mounts (or re-renders if we were already there).
  const handleTabChange = (tab: string) => {
    // Defensive narrow — Sidebar's type is `(tab: string) => void`.
    const next = (tab as DashboardTab);
    setActiveTab(next);
    if (pathname !== '/app') {
      router.push('/app');
    }
  };

  // Quick-sync visual affordance — Bug #1 dispatch #23, timeout retuned in
  // dispatch #24 from 8s → 3s per Dennis: quick sync over LAN typically
  // round-trips in under a second, so 8s of "Syncing…" felt sluggish even
  // when the sync had already completed. 3s keeps the spinner long enough
  // to feel deliberate but reverts fast on the happy path.
  //
  // Reports from prod: clicking Quick produced zero visible feedback even
  // when the underlying dispatch fired correctly, leading users to mash the
  // button or assume the app was broken. We track a short-lived
  // `isQuickSyncing` local state set on click, cleared by the safety
  // timeout so the spinner can't get stuck forever if the phone never
  // responds.
  //
  // Approach is intentionally minimal: no toast lib added, no new global
  // state. Just a local flag that swaps the button label/icon. If quickSync
  // early-returns because the WS isn't OPEN, the timeout still clears the
  // spinner cleanly within 3s — diagnostics in usePhoneBridge log the WHY
  // separately.
  const [isQuickSyncing, setIsQuickSyncing] = React.useState(false);
  const quickSyncTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQuickSyncClick = React.useCallback(() => {
    if (typeof quickSync !== 'function') return;
    setIsQuickSyncing(true);
    if (quickSyncTimerRef.current) clearTimeout(quickSyncTimerRef.current);
    quickSyncTimerRef.current = setTimeout(() => {
      setIsQuickSyncing(false);
      quickSyncTimerRef.current = null;
    }, 3000);
    quickSync();
  }, [quickSync]);

  // Cleanup any pending timer on unmount so a fast route change doesn't leak
  // a setTimeout that fires into a dead component.
  React.useEffect(() => {
    return () => {
      if (quickSyncTimerRef.current) clearTimeout(quickSyncTimerRef.current);
    };
  }, []);

  const wrapInScroll = shouldWrapInScrollContainer(pathname);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <Sidebar activeTab={activeTab} setActiveTab={handleTabChange} />

      <main className="flex-1 flex flex-col min-w-0">
        {/* Header — sticky, frosted. Same composition as before; lifted out
            of /app/page.tsx so /app/settings inherits it. */}
        <header className="h-20 px-8 flex items-center justify-between bg-white/50 backdrop-blur-sm border-b border-slate-200/50 z-10 sticky top-0">
          <div className="flex flex-col">
            <h2 className="text-xl font-bold text-slate-800">{HEADER_TITLE}</h2>
            <p className="text-xs text-slate-500">Manage your communication</p>
          </div>

          <div className="flex items-center gap-3">
            <PhoneStatusButton />
            {isConnected && typeof quickSync === 'function' && (
              <button
                onClick={handleQuickSyncClick}
                disabled={isQuickSyncing}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors border border-slate-200 disabled:opacity-70 disabled:cursor-progress"
                title={isQuickSyncing ? 'Syncing last 6 hours of messages and calls…' : 'Quick sync — last 6 hours'}
                aria-label={isQuickSyncing ? 'Quick sync in progress' : 'Quick sync'}
                aria-busy={isQuickSyncing}
              >
                <RefreshCw
                  className={`w-3 h-3 ${isQuickSyncing ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {isQuickSyncing ? 'Syncing…' : 'Quick'}
              </button>
            )}
            {/* Full Sync button — opens the SyncSetupPanel modal (the same
                centered popup that auto-opens on first pair). Distinguishable
                from Quick: DatabaseBackup icon vs RefreshCw, slate→indigo on
                hover so the affordance reads "this is the bigger / heavier
                operation". Added dispatch #9 (2026-05-22). */}
            {isConnected && typeof openSyncPanel === 'function' && (
              <button
                onClick={openSyncPanel}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-xl transition-colors border border-slate-200 hover:border-indigo-200"
                title="Full sync — re-sync everything from the phone"
                aria-label="Full sync"
              >
                <DatabaseBackup className="w-3 h-3" aria-hidden="true" />
                Full
              </button>
            )}
            <ConnectionStatus />
            {/* ProfileMenu — days-left urgency chip beside the avatar, plus a
                dropdown for Manage subscription / Sign out. Sign Out tears
                down the phone bridge WS BEFORE the SPA route change so the
                relay room doesn't survive across logout. */}
            <ProfileMenu />
          </div>
        </header>

        {/* Content slot.
            For the dashboard, children = a fragment of tab content that
            already manages its own grid/scroll inside the same
            "p-6 overflow-x-auto overflow-y-hidden" wrapper used previously.
            For /app/settings, the page content is prose-style sections —
            wrap it in an overflow-y-auto pane so it scrolls inside the
            shell without breaking the dashboard's no-scroll semantics. */}
        <div className="flex-1 p-6 overflow-x-auto overflow-y-hidden relative min-w-[640px]">
          <div className="absolute inset-0 bg-gradient-to-tr from-blue-50/50 via-indigo-50/30 to-purple-50/50 pointer-events-none" />
          <div className="relative h-full z-0">
            {wrapInScroll ? (
              <div className="h-full overflow-y-auto">{children}</div>
            ) : (
              children
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
