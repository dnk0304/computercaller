import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PhoneProvider, DialerOpenProvider } from '@/hooks';
// SyncSetupPanel is intentionally NOT mounted globally any more. It now mounts
// only from inside `/app/settings` on demand — the auto-open on first connect
// was disorienting because it covered the dashboard the moment the phone paired.
// See `app/app/settings/page.tsx` for the on-demand mount.
import { SyncProgressBar } from '@/components/SyncProgressBar';
import { GlobalDialer } from '@/components/GlobalDialer';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ComputerCaller",
  description: "Phone integration web app",
};

// Next 14+ requires viewport-related fields (themeColor, width, initialScale,
// colorScheme, etc.) to live in a separate `viewport` export — Next emits a
// console warning when they're in `metadata`. Dark title bar on Chrome/Edge
// (Windows 11+) so the browser chrome blends with the slate UI instead of
// standing out as white/grey.
export const viewport: Viewport = {
  themeColor: '#0f172a',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PhoneProvider>
          <DialerOpenProvider>
            {children}
            <SyncProgressBar />
            <GlobalDialer />
          </DialerOpenProvider>
        </PhoneProvider>
      </body>
    </html>
  );
}
