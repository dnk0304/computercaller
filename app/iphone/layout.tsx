import type { Metadata } from 'next';

/**
 * iPhone setup guide — per-route metadata.
 *
 * Lives in a server layout (not the page) because `app/iphone/page.tsx` is a
 * client component (interactive FAQ details, dismissible callouts). Next App
 * Router won't honor `metadata` exports from client components, so the only
 * clean split is a thin server layout that owns the head tags and forwards
 * children straight through. No wrapper markup — we don't want an extra DOM
 * node interfering with the page's section rhythm.
 *
 * SEO intent:
 * - Title leads with the iOS-leaning query ("Call from your computer with
 *   iPhone") so the meta title matches the on-page H1's spirit and won't be
 *   rewritten by Google.
 * - Description includes "iPhone", "Bluetooth", and "setup guide" — the three
 *   tokens an iOS-curious searcher will combine. Honest beta framing avoids
 *   the trap of over-promising parity.
 * - Canonical pins the URL to /iphone so the page doesn't compete with the
 *   homepage for the iOS keyword cluster.
 * - OG/Twitter cards inherit the brand banner from root layout via cascade;
 *   we override only the title + description so the share preview reads as
 *   the iPhone-specific entry point rather than the generic landing.
 */
export const metadata: Metadata = {
  title: 'Call from your computer with iPhone — ComputerCaller setup guide',
  description:
    'Use ComputerCaller on iPhone via Bluetooth pairing. Full setup guide with iOS-specific instructions. Make and receive phone calls from your computer browser.',
  keywords: [
    'call from computer iphone',
    'make phone calls from computer to iphone',
    'iphone bluetooth computer calling',
    'computercaller iphone',
    'iphone setup guide computer calls',
    'call iphone from laptop',
  ],
  alternates: {
    canonical: '/iphone',
  },
  openGraph: {
    type: 'article',
    url: 'https://computercaller.com/iphone',
    siteName: 'ComputerCaller',
    title: 'ComputerCaller for iPhone — setup guide',
    description:
      'iPhone setup for ComputerCaller via Bluetooth pairing. Beta — works today, full feature parity coming.',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ComputerCaller for iPhone — setup guide',
    description:
      'iPhone setup for ComputerCaller via Bluetooth pairing. Beta — works today, full feature parity coming.',
  },
};

export default function IphoneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
