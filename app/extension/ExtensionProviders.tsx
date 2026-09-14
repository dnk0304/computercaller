'use client';

/**
 * ExtensionProviders — the client half of the /extension layout.
 *
 * Split out of layout.tsx on 2026-09-14 (dispatch PIXEL-B2) because the layout
 * had to become a SERVER component to own `import './extension.css'`. A CSS
 * import inside a `'use client'` layout is emitted as a client chunk that the
 * server-rendered HTML never links — the stylesheet built fine and simply
 * never loaded, which showed up as the 0.8× density and the dark palette
 * silently not applying. Importing global CSS from a server component is the
 * supported path; this file keeps the providers, which genuinely do need to be
 * client components.
 *
 * We re-mount the SAME providers app/app/layout.tsx uses around <AppShell> —
 * minus AppShell itself — so PhoneModeShell gets its full context with ZERO
 * duplication:
 *   PhoneModeProvider    → usePhoneMode() (push/pop/tab nav inside the shell)
 *   DashboardTabProvider → useDashboardTab() (shared active-tab state)
 *   UpgradeModalProvider → upgrade CTA plumbing (FreeTierProvider depends on it)
 *   FreeTierProvider     → useFreeTier() daily-cap UX
 * PhoneProvider (usePhone/useNotifications) already wraps everything at the root.
 *
 * SyncSetupPanel is mounted so a not-yet-paired user can still pair from inside
 * the extension, mirroring app/app/layout.tsx.
 */

import { DashboardTabProvider, PhoneModeProvider } from '@/hooks';
import { UpgradeModalProvider } from '@/hooks/upgradeModalContext';
import { FreeTierProvider } from '@/hooks/freeTierContext';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';

export function ExtensionProviders({ children }: { children: React.ReactNode }) {
  return (
    <PhoneModeProvider>
      <DashboardTabProvider>
        <UpgradeModalProvider>
          <FreeTierProvider>
            {/* 100% (not 100vh): the surface is sized by the extension window
                that iframes it. 100vh made the column taller than its own
                frame in the pop-out, which pushed the composer and the Recent
                list below the fold. minHeight:0 lets the flex children scroll
                instead of growing — the root cause behind AC-2. */}
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
