import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PhoneProvider, DialerOpenProvider } from '@/hooks';
import { SyncSetupPanel } from '@/components/SyncSetupPanel';
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
  title: "DNK Dialer",
  description: "Phone integration web app",
  // Dark title bar on Chrome/Edge (Windows 11+) so the browser chrome
  // blends with the slate UI instead of standing out as white/grey.
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
            <SyncSetupPanel />
            <SyncProgressBar />
            <GlobalDialer />
          </DialerOpenProvider>
        </PhoneProvider>
      </body>
    </html>
  );
}
