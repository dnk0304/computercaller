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

// SEO metadata — dispatch 2026-05-25. Primary Ahrefs keyword
// "make phone calls from your computer" lives in title + description.
// metadataBase makes Next resolve relative OG image URLs against the prod
// origin so the Twitter / Facebook scrapers fetch absolute URLs.
// `title.template` lets nested routes (e.g. /privacy) extend the brand
// suffix without manually duplicating it.
export const metadata: Metadata = {
  metadataBase: new URL("https://computercaller.com"),
  title: {
    default: "ComputerCaller — Make phone calls from your computer",
    template: "%s · ComputerCaller",
  },
  description:
    "Call any phone number from your computer or browser. ComputerCaller connects your phone to your computer — we never store your call logs, messages, or contacts. 7-day free trial.",
  keywords: [
    "call phone from computer",
    "call from computer",
    "make a phone call from computer",
    "make phone call from computer",
    "make a call from computer",
    "phone call from computer",
    "call someone from computer",
    "how to make a phone call from computer",
    "call my phone from computer",
    "call phone from computer free",
  ],
  applicationName: "ComputerCaller",
  authors: [{ name: "ComputerCaller" }],
  creator: "ComputerCaller",
  publisher: "ComputerCaller",
  category: "communication",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://computercaller.com/",
    siteName: "ComputerCaller",
    title: "ComputerCaller — Make phone calls from your computer",
    description:
      "Call any phone number from your computer through your existing phone. We never store your calls, SMS, or contacts. 7-day free trial.",
    images: [
      {
        url: "/brand/computercaller-hero-banner-v2-cropped.png",
        width: 1436,
        height: 530,
        alt: "ComputerCaller — make phone calls from your computer",
      },
    ],
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "ComputerCaller — Make phone calls from your computer",
    description:
      "Call any phone number from your computer through your existing phone. We never store your calls, SMS, or contacts.",
    images: ["/brand/computercaller-hero-banner-v2-cropped.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: "/brand/computercaller-icon-transparent.png",
    apple: "/brand/computercaller-icon-square-padded-1024.png",
  },
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
