import ClarityTag from '@/components/ClarityTag';

/**
 * Marketing route group — the ONLY place Microsoft Clarity is loaded.
 *
 * `(marketing)` is a Next.js route group: the parentheses mean the folder name
 * is NOT part of the URL. /, /guides, /guides/[slug], /privacy and /terms are
 * unchanged; they simply now share a layout that the authenticated tree does
 * not inherit.
 *
 * This exists for a security reason, not an organisational one. Clarity session-
 * replays the DOM to a third party, and it used to sit in the ROOT layout — so
 * it also loaded on /app, /messenger and /extension, which render SMS bodies,
 * contact names, phone numbers and notification text. Scoping by route group
 * makes the boundary structural: a new page is outside the group by default and
 * therefore gets no analytics, rather than being opted out one file at a time.
 *
 * This layout is a SERVER component on purpose. The landing page is
 * `'use client'`, and next/script afterInteractive rendered from a client
 * component is injected at hydration instead of being server-rendered — which
 * left the tag invisible to any curl/CSP audit of the HTML. Rendering it here
 * puts it in the SSR output for every route in the group.
 *
 * Do NOT add an authenticated route to this group. See components/ClarityTag.tsx
 * for the full allowed/forbidden list; scripts/check-clarity-scope.mjs enforces it.
 */
export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {children}
      <ClarityTag />
    </>
  );
}
