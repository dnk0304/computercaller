import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { PhoneProvider, DialerOpenProvider } from '@/hooks';
// SyncSetupPanel is intentionally NOT mounted globally any more. It now mounts
// only from inside `/app/settings` on demand — the auto-open on first connect
// was disorienting because it covered the dashboard the moment the phone paired.
// See `app/app/settings/page.tsx` for the on-demand mount.
// SyncProgressBar moved out of the root layout (2026-07-10): it is now an
// IN-FLOW bar mounted by AppShell directly above the /app header, so it
// pushes the chrome down instead of overlaying the page. Marketing pages
// never had sync state to show, so nothing is lost outside /app/*.
import { GlobalDialer } from '@/components/GlobalDialer';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// SEO metadata — reworked 2026-07-05 for the Ahrefs "call from computer"
// cluster ("call phone from computer" 1.2K, "call from computer" 1.2K,
// "make a phone call from computer" 700, …). Title leads with "Call & Text
// From Your Computer" and the description carries the natural long-tail
// phrasing ("make a phone call from your computer", "call any phone number")
// plus the $5/month price — we compete with free (Phone Link), so the price
// IS the hook in the SERP snippet.
// metadataBase makes Next resolve relative OG image URLs against the prod
// origin so the Twitter / Facebook scrapers fetch absolute URLs.
// `title.template` lets nested routes (e.g. /privacy) extend the brand
// suffix without manually duplicating it.
export const metadata: Metadata = {
  metadataBase: new URL("https://computercaller.com"),
  title: {
    default: "Call & Text From Your Computer — Using Your Own Number | ComputerCaller",
    template: "%s · ComputerCaller",
  },
  description:
    "Make a phone call from your computer — call any phone number from your browser using your own number and carrier. Texts and notifications too. 7-day free trial, then $5/month.",
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
    "call a phone number from computer",
    "can i make a phone call from my computer",
    "how to call from computer",
    "call phone from computer free",
    "call from computer free",
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
    title: "Call & Text From Your Computer — Using Your Own Number",
    description:
      "Make phone calls from your computer — any number, your own caller ID, through your existing phone and carrier. 7-day free trial, then $5/month.",
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
    title: "Call & Text From Your Computer — Using Your Own Number",
    description:
      "Make phone calls from your computer — any number, your own caller ID, through your existing phone and carrier. 7-day free trial, then $5/month.",
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
            <GlobalDialer />
          </DialerOpenProvider>
        </PhoneProvider>
        {/* Microsoft Clarity — visitor/behavior analytics (2026-08-31). Public
            client-side tag, ID is not a secret. afterInteractive so it never
            blocks hydration. Site-wide: root layout covers marketing + /app. */}
        <Script id="ms-clarity" strategy="afterInteractive">
          {`(function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
          })(window, document, "clarity", "script", "yaz1n9clas");`}
        </Script>
      </body>
    </html>
  );
}
