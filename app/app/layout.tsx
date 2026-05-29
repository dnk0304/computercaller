// Layout for every /app/* route.
//
// Providers (PhoneProvider, DialerOpenProvider, SyncProgressBar, GlobalDialer)
// live in the root layout at app/layout.tsx so /app routes inherit them.
//
// What this file owns:
//   1. DashboardTabProvider — cross-route active-tab state so the Sidebar
//      works identically on /app and /app/settings. The Sidebar reads/writes
//      the tab here; the dashboard page renders the tab content.
//   2. AppShell — the persistent Sidebar + header chrome around every
//      /app/* route. Before this layout owned it, /app/settings rendered
//      standalone with no nav, stranding users who clicked into the
//      pairing-QR page.
//   3. SyncSetupPanel — scoped to /app/* only (not the marketing pages),
//      available everywhere `openSyncPanel()` can be triggered (inline
//      Settings tab on the dashboard, /app/settings route page). Earlier
//      the panel was mounted only inside /app/settings, which meant
//      clicking "Run Full Sync" from the inline Settings panel did nothing
//      — state flipped, but no panel was rendered to react to it. The
//      auto-open trigger that originally motivated the un-mount is gone
//      (removed from usePhoneBridge's STATUS handler), so re-mounting
//      globally is safe: the modal only appears on explicit user action.
import { DashboardTabProvider, PhoneModeProvider } from '@/hooks';
import { AppShell } from '@/components/AppShell';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { KickedSessionGate } from '@/components/KickedSessionGate';

// PhoneModeProvider wraps DashboardTabProvider so the Phone Mode shell can
// read dashboard tab selection if it ever needs to (currently it doesn't —
// Phone Mode has its own 3-tab navigator — but the provider order keeps the
// option open without a re-wiring later). All other dashboard providers live
// in the root layout (PhoneProvider / DialerOpenProvider) so Phone Mode
// inherits the same data sources as the dashboard.
//
// ErrorBoundary placement (2026-05-29, Pixel build P-A):
//   The boundary wraps <AppShell> + <SyncSetupPanel> + <KickedSessionGate> —
//   i.e. EVERYTHING inside the /app layout but OUTSIDE the providers. A
//   child render crash falls into the boundary's calm fallback while
//   PhoneProvider (mounted in the root layout) and the relay WebSocket
//   continue running uninterrupted. The previous behaviour was a child
//   throw → AppShell unmounts → PhoneProvider unmounts → relay WS closes.
//
// KickedSessionGate placement:
//   Mounted INSIDE the providers (so it can read PhoneContext via usePhone)
//   but as a sibling of AppShell. When kickedReason is set the gate
//   suppresses the app tree visually (renders only its calm card) while
//   leaving the providers and the phone-side socket completely intact.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PhoneModeProvider>
      <DashboardTabProvider>
        <ErrorBoundary scope="app-shell">
          <KickedSessionGate>
            <AppShell>{children}</AppShell>
            <SyncSetupPanel />
          </KickedSessionGate>
        </ErrorBoundary>
      </DashboardTabProvider>
    </PhoneModeProvider>
  );
}
