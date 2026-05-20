'use client';

import React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { PhoneStatusButton } from '@/components/PhoneStatusButton';
import { SubscriptionPill } from '@/components/SubscriptionPill';
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

// Derive the header title from the current pathname OR active tab. /app/settings
// is a hard route so its title is fixed; everything else mirrors the active tab.
function deriveHeaderTitle(pathname: string | null, activeTab: DashboardTab): string {
  if (pathname?.startsWith('/app/settings')) return 'Settings';
  return activeTab;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { activeTab, setActiveTab } = useDashboardTab();

  // Phone bridge — header still shows the quick-sync button when a phone is
  // connected. quickSync may not be on the public hook type yet; loose cast
  // matches the pattern used at /app/page.tsx so this stays in lockstep.
  const phone = usePhone();
  const { isConnected } = phone;
  const quickSync = (phone as unknown as { quickSync?: () => void }).quickSync;

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

  const headerTitle = deriveHeaderTitle(pathname, activeTab);
  const wrapInScroll = shouldWrapInScrollContainer(pathname);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <Sidebar activeTab={activeTab} setActiveTab={handleTabChange} />

      <main className="flex-1 flex flex-col min-w-0">
        {/* Header — sticky, frosted. Same composition as before; lifted out
            of /app/page.tsx so /app/settings inherits it. */}
        <header className="h-20 px-8 flex items-center justify-between bg-white/50 backdrop-blur-sm border-b border-slate-200/50 z-10 sticky top-0">
          <div className="flex flex-col">
            <h2 className="text-xl font-bold text-slate-800 capitalize">{headerTitle}</h2>
            <p className="text-xs text-slate-500">Manage your communication</p>
          </div>

          <div className="flex items-center gap-3">
            <PhoneStatusButton />
            {isConnected && typeof quickSync === 'function' && (
              <button
                onClick={quickSync}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors border border-slate-200"
                title="Quick sync — last 6 hours"
                aria-label="Quick sync"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                Quick
              </button>
            )}
            <ConnectionStatus />
            <SubscriptionPill />
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
