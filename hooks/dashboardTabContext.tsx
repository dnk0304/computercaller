'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from 'react';

/**
 * Cross-route active-tab state for the dashboard sidebar.
 *
 * Why this exists:
 *   The dashboard (/app) is a single-page tabbed UI driven by `activeTab` —
 *   dashboard / dialer / messages / templates / calls / contacts / settings.
 *   The Sidebar nav drives that state. Historically `activeTab` was a
 *   `useState` local to `/app/page.tsx`, which meant the Sidebar literally
 *   couldn't exist outside that page: nothing else could read/write the tab.
 *
 *   /app/settings is a SEPARATE Next.js route (deep settings + pairing QR
 *   page). When the user lands there, they need the Sidebar to navigate
 *   back. The Sidebar needs somewhere to write the tab selection that the
 *   dashboard page will read on next mount.
 *
 *   This context is the bridge. The provider lives in app/app/layout.tsx so
 *   it spans both /app and /app/settings. The Sidebar (rendered in
 *   AppShell, also in the layout) reads/writes through this context. The
 *   dashboard page reads from it instead of owning local state.
 *
 * Persistence note:
 *   We hydrate from sessionStorage on mount so a click on the Sidebar at
 *   /app/settings → router.push('/app') round-trip preserves the chosen
 *   tab across the page remount. sessionStorage (not localStorage) because
 *   the choice is ephemeral — a new tab shouldn't inherit it, and the user
 *   shouldn't be locked to wherever they were three days ago. The DEFAULT
 *   on cold open is always 'dashboard', the home view.
 */

export type DashboardTab =
  | 'dashboard'
  | 'dialer'
  | 'messages'
  | 'templates'
  | 'calls'
  | 'contacts'
  | 'settings';

const TAB_STORAGE_KEY = 'dnkdialer_dashboard_tab';
const DEFAULT_TAB: DashboardTab = 'dashboard';

const VALID_TABS: ReadonlySet<DashboardTab> = new Set<DashboardTab>([
  'dashboard',
  'dialer',
  'messages',
  'templates',
  'calls',
  'contacts',
  'settings',
]);

function isDashboardTab(value: unknown): value is DashboardTab {
  return typeof value === 'string' && VALID_TABS.has(value as DashboardTab);
}

interface DashboardTabContextValue {
  activeTab: DashboardTab;
  setActiveTab: (tab: DashboardTab) => void;
  /**
   * Selected message thread number — preserved here (rather than as page
   * local state) so the inline "Message X" actions from /app/contacts or
   * /app/calls can pre-select a conversation when switching to the messages
   * tab. Null clears the selection.
   */
  selectedMessageNumber: string | null;
  setSelectedMessageNumber: (number: string | null) => void;
}

const DashboardTabContext = createContext<DashboardTabContextValue | null>(null);

export function DashboardTabProvider({ children }: { children: ReactNode }) {
  // Always render with the default first, then hydrate from sessionStorage in
  // an effect. This keeps SSR output deterministic and avoids hydration
  // mismatches — the alternative (reading storage in the initialiser) only
  // works client-side and crashes during prerender.
  const [activeTab, setActiveTabState] = useState<DashboardTab>(DEFAULT_TAB);
  const [selectedMessageNumber, setSelectedMessageNumberState] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(TAB_STORAGE_KEY);
      if (isDashboardTab(stored)) setActiveTabState(stored);
    } catch {
      // sessionStorage can throw in privacy modes — ignore, keep default.
    }
  }, []);

  const setActiveTab = useCallback((tab: DashboardTab) => {
    setActiveTabState(tab);
    // Clear the message thread selection whenever the user leaves messages,
    // so re-entering messages later opens the thread list rather than the
    // stale conversation. Matches the original page.tsx behaviour exactly.
    if (tab !== 'messages') setSelectedMessageNumberState(null);
    try {
      window.sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // Best-effort persistence. Failure is fine.
    }
  }, []);

  const setSelectedMessageNumber = useCallback((number: string | null) => {
    setSelectedMessageNumberState(number);
  }, []);

  const value = useMemo<DashboardTabContextValue>(
    () => ({ activeTab, setActiveTab, selectedMessageNumber, setSelectedMessageNumber }),
    [activeTab, setActiveTab, selectedMessageNumber, setSelectedMessageNumber],
  );

  return <DashboardTabContext.Provider value={value}>{children}</DashboardTabContext.Provider>;
}

/**
 * Read/control the dashboard's active tab. Safe to call without a provider —
 * returns a no-op fallback so isolated tests / Storybook renders don't crash.
 * In production both /app and /app/settings live inside the provider via
 * app/app/layout.tsx, so the fallback path should never fire.
 */
export function useDashboardTab(): DashboardTabContextValue {
  const ctx = useContext(DashboardTabContext);
  if (!ctx) {
    return {
      activeTab: DEFAULT_TAB,
      setActiveTab: () => {},
      selectedMessageNumber: null,
      setSelectedMessageNumber: () => {},
    };
  }
  return ctx;
}
