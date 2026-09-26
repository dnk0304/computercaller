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
 *   UpgradeModalProvider → upgrade CTA plumbing (tier badge / upgrade modal)
 * PhoneProvider (usePhone/useNotifications) already wraps everything at the root.
 *
 * SyncSetupPanel is mounted so a not-yet-paired user can still pair from inside
 * the extension, mirroring app/app/layout.tsx.
 */

import { DashboardTabProvider, PhoneModeProvider } from '@/hooks';
import { UpgradeModalProvider } from '@/hooks/upgradeModalContext';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';
import { IdleTimeoutGuard } from '@/components/IdleTimeoutGuard';
import { ExtPointerFocus } from '@/components/ExtPointerFocus';
import { KickedSessionGate } from '@/components/KickedSessionGate';
import { requestSignOut } from '@/lib/extensionBridge';
import { wipeAccountPrefOnSignOut } from '@/lib/e2eAccountPref';
import { writeExtSignOutReason } from '@/lib/extensionSignOutReason';

export function ExtensionProviders({ children }: { children: React.ReactNode }) {
  return (
    <PhoneModeProvider>
      <DashboardTabProvider>
        <UpgradeModalProvider>
          <>
            {/* 100% (not 100vh): the surface is sized by the extension window
                that iframes it. 100vh made the column taller than its own
                frame in the pop-out, which pushed the composer and the Recent
                list below the fold. minHeight:0 lets the flex children scroll
                instead of growing — the root cause behind AC-2. */}
            {/* EXT/WEB DUAL SESSION (Option A, Dennis 2026-09-25): the SAME
                gate /app mounts. A sign-in on the web app (or anywhere else)
                now kicks this frame's relay socket too, and without the gate
                the surface just froze. surface="extension" swaps the button's
                /auth/login navigation — impossible from a frame the shell owns
                — for the shell's embedded sign-in. */}
            <KickedSessionGate surface="extension">
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
            </KickedSessionGate>
            {/* EXT-UI-8 item 3 — renders nothing; owns the two document
                listeners that tell the stylesheet a pointer, not the keyboard,
                put the caret in a field. Mounted here so it covers every
                editable on the surface (side panel, pop-out and popup all
                render this route) rather than the five that exist today. */}
            <ExtPointerFocus />
            <SyncSetupPanel />
            {/* THE 4-HOUR IDLE LOGOUT, on the extension surface.
                Dennis 2026-09-21 14:04Z: "i notice that the extension doesnt log
                you out automatically after 4 hours, at least its not visible."

                It was not a broken timer — there was no timer. IdleTimeoutGuard
                was mounted only in app/app/layout.tsx, so the /extension frame
                never sent a heartbeat and never ticked: the server's idle_token
                lapsed silently at 4 h while the panel kept rendering stale data,
                and because Chrome never destroys a side panel, nothing ever
                re-probed to discover it. Mounting it here is the whole fix.

                INSIDE PhoneModeProvider because the guard needs usePhone() — a
                live call is keepAlive, and the teardown disconnects the bridge.
                NOT on /extension/login: that route is the (surface) group's
                sibling and has no providers, which is correct — a signed-out
                page has no session to time out.

                onLogout replaces ONLY the last step (the fetch + hard navigate).
                This page cannot navigate: it is an iframe the shell owns. So it
                records WHY for the gate to read, then hands off to the shell,
                which clears both credentials, tells the service worker to drop
                the pair and the SK, and swaps the frame for the sign-in gate. */}
            <IdleTimeoutGuard
              onLogout={() => {
                writeExtSignOutReason('idle');
                // Security M1 — also run by signOutEverywhere's onSignOut
                // before this; idempotent, and kept here so the idle path
                // does not depend on that ordering.
                wipeAccountPrefOnSignOut();
                requestSignOut();
              }}
            />
          </>
        </UpgradeModalProvider>
      </DashboardTabProvider>
    </PhoneModeProvider>
  );
}
