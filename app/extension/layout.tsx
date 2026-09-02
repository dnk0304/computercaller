'use client';

/**
 * /extension layout — the hosted Phone Mode surface the Chrome extension iframes
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * This route deliberately does NOT live under /app, so it inherits ONLY the root
 * layout (PhoneProvider + DialerOpenProvider + GlobalDialer) and NOT app/app's
 * AppShell chrome. That is exactly what we want: no sidebar, no header, no
 * width-based Phone-Mode toggle — just the phone surface in a popup-sized box.
 *
 * We re-mount the SAME providers app/app/layout.tsx uses around <AppShell> — minus
 * AppShell itself — so PhoneModeShell gets its full context with ZERO duplication:
 *   PhoneModeProvider  → usePhoneMode() (push/pop/tab nav inside the shell)
 *   DashboardTabProvider → useDashboardTab() (shared active-tab state)
 *   UpgradeModalProvider → upgrade CTA plumbing (FreeTierProvider depends on it)
 *   FreeTierProvider   → useFreeTier() daily-cap UX
 * PhoneProvider (usePhone/useNotifications) already wraps everything at the root.
 *
 * SyncSetupPanel is mounted so a not-yet-paired user can still pair from inside the
 * extension, mirroring app/app/layout.tsx.
 */

import { DashboardTabProvider, PhoneModeProvider } from '@/hooks';
import { UpgradeModalProvider } from '@/hooks/upgradeModalContext';
import { FreeTierProvider } from '@/hooks/freeTierContext';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';

export default function ExtensionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PhoneModeProvider>
      <DashboardTabProvider>
        <UpgradeModalProvider>
          <FreeTierProvider>
            <div
              style={{
                width: '100%',
                height: '100vh',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {children}
            </div>
            <SyncSetupPanel />
          </FreeTierProvider>
        </UpgradeModalProvider>
      </DashboardTabProvider>
    </PhoneModeProvider>
  );
}
