// Passthrough layout — the actual providers (PhoneProvider, DialerOpenProvider,
// SyncSetupPanel, SyncProgressBar, GlobalDialer) all live in the root layout at
// app/layout.tsx, so /app routes inherit them automatically. This file exists
// only to scope future /app-specific layout concerns (auth guards, sidebars
// shared across /app/* pages, etc.) without affecting the marketing pages.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
