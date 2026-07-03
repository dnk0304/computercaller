'use client';

import React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { PhoneStatusButton } from '@/components/PhoneStatusButton';
import { ProfileMenu } from '@/components/ProfileMenu';
import { PhoneModeShell } from '@/components/PhoneModeShell';
import { SyncMenuButton } from '@/components/SyncMenuButton';
import { ReconnectionPill } from '@/components/ReconnectionPill';
import { CallQueueBand } from '@/components/CallQueueBand';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { usePhone, useDashboardTab, usePhoneMode, type DashboardTab } from '@/hooks';

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
  // Settings and Admin are prose/table routes that scroll inside the shell.
  // The dashboard is deliberately excluded — it owns its own no-scroll,
  // column-based layout.
  return pathname.startsWith('/app/settings') || pathname.startsWith('/app/admin');
}

// Header title in the chrome is product branding, not page state. The page-
// level heading (tab label or route name) is surfaced by the Sidebar / page
// content itself — the bar at the top of the shell is the brand.
const HEADER_TITLE = 'ComputerCaller';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { activeTab, setActiveTab } = useDashboardTab();
  // Phone Mode — when active, swap the shell content for the compact
  // mobile-shape navigator. Sidebar + header chrome are hidden; an Expand
  // button inside PhoneModeHeader returns the user to the full dashboard.
  // See hooks/usePhoneMode.tsx for the entry rules (auto-collapse at <600px
  // + manual toggle with session-scoped hysteresis suppression).
  //
  // Dispatch #34 (2026-05-26): the manual-entry button (`enterManually`) moved
  // out of the header into ProfileMenu — `enterManually` is still consumed
  // here only as part of the phoneMode read; the trigger lives in
  // components/ProfileMenu.tsx now.
  const { phoneMode } = usePhoneMode();

  // Phone bridge — header surfaces a single "Sync" affordance when a phone
  // is connected, consolidated dispatch #34 (2026-05-26). The previous two
  // header buttons ("Quick" + "Full") consolidated into <SyncMenuButton/>:
  //   - Trigger: single Sync pill with chevron
  //   - Popover: Quick (last 6 hours) + Full (re-sync everything)
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

  // Phone Mode short-circuit. We render the compact shell INSTEAD of the
  // full Sidebar + header layout — same outer `h-screen overflow-hidden`
  // box so the page still fills the window, but every dashboard chrome
  // affordance (Sidebar, sync buttons, ProfileMenu, page header) is
  // hidden. PhoneModeShell owns its own header (PhoneModeHeader) which
  // surfaces ConnectionStatus + an Expand button so the user can return.
  if (phoneMode) {
    return (
      <div className="flex h-screen overflow-hidden bg-slate-50 font-sans">
        <main className="flex-1 min-w-0 overflow-hidden">
          <PhoneModeShell />
        </main>
      </div>
    );
  }

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
            {/* Sync — consolidated dropdown (dispatch #34 item 9, 2026-05-26).
                Replaces the prior pair of separate Quick + Full buttons that
                ate ~140-180px of header width. Renders null when no phone is
                connected, so the header collapses cleanly. Quick + Full
                callbacks are passed defensively (typeof === 'function')
                because the public hook type isn't regenerated in every
                build during a deploy ramp. */}
            <SyncMenuButton
              isConnected={isConnected}
              isQuickSyncing={isQuickSyncing}
              onQuickSync={typeof quickSync === 'function' ? handleQuickSyncClick : undefined}
              onFullSync={typeof openSyncPanel === 'function' ? openSyncPanel : undefined}
            />
            {/* ReconnectionPill (P-C, 2026-05-29) — calm header surface for
                transient bridge-health states (Reconnecting / Phone
                unresponsive). Renders null on healthy states so the existing
                ConnectionStatus owns the green happy-path pill. Never blocks
                an action; never a modal. */}
            <ReconnectionPill />
            {/* Phone Mode entry was here until dispatch #34 (2026-05-26) —
                Dennis moved it into the ProfileMenu dropdown (right side of
                header, under the avatar) so the chrome stays tighter and the
                affordance lives next to the rest of the per-user surfaces.
                Dispatch #34 task 3 (2026-06-08): the menu item now AUTO-opens
                Phone Mode in a popup window; the separate "Open in popup
                window" sub-action was removed. See components/ProfileMenu.tsx. */}
            <ConnectionStatus />
            {/* ProfileMenu — days-left urgency chip beside the avatar, plus a
                dropdown for Manage subscription / Sign out. Sign Out tears
                down the phone bridge WS BEFORE the SPA route change so the
                relay room doesn't survive across logout. */}
            <ProfileMenu />
          </div>
        </header>

        {/* Incoming-call queue band (Pixel, 2026-06-11). Sits BETWEEN the
            sticky header and the dashboard content slot — the exact gap Dennis
            marked in the placement mockup. flex-shrink-0 inside the flex-col
            <main>, so it holds its height and never scrolls with the columns
            below, and can't overlap the sticky header (it's in normal flow
            beneath it). Renders null at 0 calls, so the idle dashboard is
            unchanged — no dead space. Per-call gating is Path A (no default-
            dialer): full controls on the foreground call, Answer-only on
            background calls (a background hang-up would end the foreground
            call). See components/CallQueueBand.tsx. Wrapped in its own
            ErrorBoundary so a render fault in the band can never take down the
            dashboard or the header chrome. */}
        <ErrorBoundary scope="call-queue-band" resetKey={pathname ?? ''}>
          <CallQueueBand />
        </ErrorBoundary>

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
            {/* Per-route children boundary (P-A, 2026-05-29). The Sidebar
                + header chrome live OUTSIDE this wrapper, so a render
                crash in the route page falls into a calm fallback while
                the nav stays mounted and usable. PhoneProvider (root
                layout) was already outside this scope, so the WebSocket
                survives independently. resetKey=pathname so navigating
                to a different route clears any prior boundary error
                state automatically. */}
            <ErrorBoundary scope="route-content" resetKey={pathname ?? ''}>
              {wrapInScroll ? (
                <div className="h-full overflow-y-auto">{children}</div>
              ) : (
                children
              )}
            </ErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
