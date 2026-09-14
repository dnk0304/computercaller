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

import './extension.css';
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
            {/* 100% (not 100vh): the shell is sized by the extension window
                that iframes it. 100vh made the column taller than its own
                frame in the pop-out, which is what pushed the composer and
                the Recent list below the fold. minHeight:0 lets the flex
                children actually scroll instead of growing (AC-2's root
                cause, same class of bug in three places). */}
            <div
              style={{
                width: '100%',
                height: '100%',
                minHeight: 0,
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
