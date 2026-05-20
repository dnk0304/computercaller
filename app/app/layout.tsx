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
import { DashboardTabProvider } from '@/hooks';
import { AppShell } from '@/components/AppShell';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardTabProvider>
      <AppShell>{children}</AppShell>
      <SyncSetupPanel />
    </DashboardTabProvider>
  );
}
